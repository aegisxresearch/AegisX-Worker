/**
 * Argument validation: a mistyped call is refused with the field named, before
 * anything runs.
 *
 * The bug this pins down: `create_task` with `priority: "urgentt"` used to
 * return `ok: true` and create the task as `medium`. Silent coercion looks like
 * success to the model, so it never learns the value was wrong.
 *
 *   node --experimental-strip-types scripts/arg-check.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { validateToolArgs } from '../server/src/argGuard.ts';
import { briefParts, checkBrief } from '../server/src/brief.ts';
import { executeAction } from '../server/src/tools.ts';

const results = [];
const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'aegisx-args-'));

async function check(label, run) {
  try {
    await run();
    results.push({ label, ok: true });
    console.log(`  ✓ ${label}`);
  } catch (error) {
    results.push({ label, ok: false, error });
    console.log(`  ✗ ${label}\n      ${error instanceof Error ? error.message : String(error)}`);
  }
}

const calls = { count: 0 };
const handlers = {
  moveTo: () => 'moved',
  setStatus: () => 'status',
  completeTask: () => 'done',
  addNote: () => 'noted',
  createTask: () => {
    calls.count += 1;
    return 'created';
  },
};

function context(root = sandbox) {
  return {
    agentId: 'agent_a',
    agentName: 'Aria',
    taskId: null,
    toolsEnabled: true,
    webEnabled: false,
    workspaceRoot: root,
  };
}

console.log('\n[args] the validator');

await check('a missing required field is named', async () => {
  const issues = validateToolArgs('write_file', { content: 'x' });
  assert.equal(issues.length, 1);
  assert.equal(issues[0].field, 'path');
  assert.match(issues[0].problem, /required/);
});

await check('a wrong type is refused, a numeric string is not', async () => {
  assert.equal(validateToolArgs('read_file', { path: 42 })[0].field, 'path');
  assert.deepEqual(validateToolArgs('search_files', { pattern: 'x', max_results: '40' }), [], 'numeric strings are a habit, not a mistake');
  assert.equal(validateToolArgs('search_files', { pattern: 'x', max_results: 'many' })[0].field, 'max_results');
});

await check('an enum typo reports every accepted value', async () => {
  const issues = validateToolArgs('set_status', { status: 'sleeping' });
  assert.equal(issues[0].field, 'status');
  assert.match(issues[0].expected, /idle \| working \| blocked/);
});

await check('a list field must actually be a list', async () => {
  assert.equal(validateToolArgs('create_task', { title: 'x', depends_on: 'task_1' })[0].field, 'depends_on');
  assert.deepEqual(validateToolArgs('create_task', { title: 'x', depends_on: ['task_1'] }), []);
  assert.equal(
    validateToolArgs('create_task', { title: 'x', depends_on: Array.from({ length: 9 }, (_, i) => `t${i}`) })[0].field,
    'depends_on',
  );
});

await check('an unknown action is left to the dispatcher', async () => {
  assert.deepEqual(validateToolArgs('teleport', { anywhere: true }), []);
});

console.log('\n[args] through the tool entry point');

await check('nothing runs when the call is malformed', async () => {
  const before = calls.count;
  const result = await executeAction({ action: 'create_task', title: 'x', priority: 'urgentt' }, context(), handlers);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'invalid_args');
  assert.match(result.summary, /priority/);
  assert.match(result.detail, /urgent \| low \| medium \| high|low \| medium \| high \| urgent/);
  assert.equal(calls.count, before, 'the handler must not be called for an invalid enum');
});

await check('a missing path never touches the disk', async () => {
  const result = await executeAction({ action: 'write_file', content: 'hello' }, context(), handlers);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'invalid_args');
  const entries = await fs.readdir(sandbox);
  assert.equal(entries.some((entry) => entry.endsWith('.ts')), false, `a file was written: ${entries.join(', ')}`);
});

await check('a valid call still works, extra keys and all', async () => {
  const result = await executeAction(
    { action: 'write_file', path: 'ok.txt', content: 'hello\n', note_from_model: 'ignore me' },
    context(),
    handlers,
  );
  assert.equal(result.ok, true, result.summary);
  assert.equal(await fs.readFile(path.join(sandbox, 'ok.txt'), 'utf8'), 'hello\n');
});

await check('the old silent enum coercion cannot come back', async () => {
  let seen = null;
  const result = await executeAction({ action: 'move_to', station: 'moon' }, context(), {
    ...handlers,
    moveTo: (station) => {
      seen = station;
      return 'moved';
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'invalid_args');
  assert.equal(seen, null, 'the handler received a station the schema does not allow');
});

console.log('\n[args] the brief gate in front of create_task');

await check('a title with no detail is refused before a task exists', async () => {
  const before = calls.count;
  const result = await executeAction({ action: 'create_task', title: 'Improve the UI' }, context(), handlers);
  assert.equal(result.ok, false);
  assert.match(result.summary, /no usable detail/);
  assert.match(result.summary, /create_task again/, 'the refusal has to say what to do next');
  assert.match(result.summary, /client\/src\/ui\/chat\.ts/, 'the example names a real file');
  assert.equal(calls.count, before, 'the handler must not run for an unactionable brief');
});

await check('a long brief with no anchor is refused and names what is missing', async () => {
  const result = await executeAction(
    {
      action: 'create_task',
      title: 'Polish things',
      detail: 'Please make the product feel more professional and generally better for everyone who uses it.',
    },
    context(),
    handlers,
  );
  assert.equal(result.ok, false);
  assert.match(result.summary, /names no file, command, endpoint/);
});

await check('acceptance words are not an anchor', async () => {
  // The gate counts anchors, not adjectives: "it must be better" is a wish,
  // and a brief built only from wishes is what a wandering task is made of.
  const verdict = checkBrief({
    title: 'Fix the retry',
    detail: 'The retry must stop after three attempts, should return a clear error and has to be verified.',
  });
  assert.equal(verdict.ok, false, 'acceptance language alone let the brief through');
  assert.match(verdict.refusal, /names no file/);
});

await check('a brief that names its file and its proof is accepted', async () => {
  const result = await executeAction(
    {
      action: 'create_task',
      title: 'Disable Send while empty',
      detail:
        'Edit client/src/ui/chat.ts so the Send button is disabled while the input is blank; add the case to scripts/chat-check.mjs. Do not touch the stylesheet.',
    },
    context(),
    handlers,
  );
  assert.equal(result.ok, true, result.summary);
  assert.doesNotMatch(result.summary, /Advisory/, 'a complete brief must not be nagged at');
});

await check('a thin but usable brief is accepted with one advisory', async () => {
  const result = await executeAction(
    {
      action: 'create_task',
      title: 'Fix the retry',
      detail: 'The retry loop in server/src/llm.ts spins forever when the upstream answers 503 with an empty body.',
    },
    context(),
    handlers,
  );
  assert.equal(result.ok, true, result.summary);
  assert.match(result.summary, /Advisory/);
  assert.match(result.summary, /acceptance test/);
});

await check('a schema change counts as a concrete anchor', async () => {
  const verdict = checkBrief({
    title: 'Index the orders table',
    detail: 'Add index on orders.created_at and backfill nothing; run it twice and prove the row count matches.',
  });
  assert.equal(verdict.ok, true, verdict.refusal);
  assert.ok(verdict.found.includes('sql'));
});

await check('read-only work does not need a file path', async () => {
  const verdict = checkBrief({
    title: 'Audit the auth flow',
    detail: 'Review only: read the login path and report the trust boundary you would change, with line numbers.',
  });
  assert.equal(verdict.ok, true, verdict.refusal);
  assert.ok(verdict.found.includes('no-change'));
});

await check('the gate is deterministic and its parts are declared', async () => {
  assert.deepEqual(checkBrief({ title: 'a', detail: 'b' }), checkBrief({ title: 'a', detail: 'b' }));
  assert.ok(briefParts().includes('path') && briefParts().includes('acceptance'));
});

const failed = results.filter((entry) => !entry.ok);
console.log(`\n[args] ${results.length - failed.length}/${results.length} checks passed.`);
if (failed.length > 0) {
  console.log(`Failed: ${failed.map((entry) => entry.label).join(' · ')}`);
  process.exitCode = 1;
}

await fs.rm(sandbox, { recursive: true, force: true });
