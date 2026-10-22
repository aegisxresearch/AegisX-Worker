/**
 * Tool results are model context, so their shape is guarded.
 *
 * The check has three parts: fabricated bad results prove the shape guard
 * fires, fabricated successes without their payload prove the per-tool contract
 * rejects them, and real tool calls prove the office's own results satisfy both
 * — including every `next_actions` name, which is where a typo would otherwise
 * become "Unknown action" on the next model round.
 *
 *   node --experimental-strip-types scripts/output-check.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { buildObservation, sanitizeObservation, validateObservation } from '../server/src/outputGuard.ts';
import { TOOL_RESULT_SCHEMAS, validateToolResult } from '../server/src/resultSchemas.ts';
import { buildToolSchemas } from '../server/src/toolSchemas.ts';
import { executeAction } from '../server/src/tools.ts';

const results = [];
const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'aegisx-output-'));
const knownTools = new Set(buildToolSchemas({ files: true, web: true }).map((tool) => tool.function.name));

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

const handlers = {
  moveTo: () => 'moved',
  setStatus: () => 'status',
  completeTask: () => 'done',
  addNote: () => 'noted',
  createTask: () => 'created',
};

function context() {
  return {
    agentId: 'agent_a',
    agentName: 'Aria',
    taskId: null,
    toolsEnabled: true,
    webEnabled: false,
    workspaceRoot: sandbox,
  };
}

console.log('\n[outputs] the guard');

await check('an empty summary is an issue, and is replaced', async () => {
  const broken = { ok: true, summary: '   ', followUp: true };
  const issues = validateObservation(broken, knownTools);
  assert.equal(issues.some((issue) => issue.field === 'summary'), true);
  const clean = sanitizeObservation(broken, knownTools);
  assert.ok(clean.summary.length > 0);
  assert.equal(broken.summary, '   ', 'sanitize must not mutate the original');
});

await check('a next_action naming a tool that does not exist is dropped', async () => {
  const broken = { ok: true, summary: 'Done.', nextActions: ['read_file', 'teleport'], followUp: true };
  const issues = validateObservation(broken, knownTools);
  assert.match(issues.map((issue) => issue.problem).join(' '), /unknown tool/);
  const clean = sanitizeObservation(broken, knownTools);
  assert.deepEqual(clean.nextActions, ['read_file']);
});

await check('an unknown error code is reported and removed', async () => {
  const broken = { ok: false, summary: 'Failed.', code: 'because_i_said_so', followUp: true };
  assert.equal(validateObservation(broken, knownTools).some((issue) => issue.field === 'code'), true);
  assert.equal(sanitizeObservation(broken, knownTools).code, undefined);
});

await check('a non-list artifacts field is reported', async () => {
  const broken = { ok: true, summary: 'Done.', artifacts: 'a.png', followUp: true };
  assert.equal(validateObservation(broken, knownTools).some((issue) => issue.field === 'artifacts'), true);
});

console.log('\n[outputs] the per-tool contract');

await check('every contract names a tool that exists', async () => {
  const orphans = Object.keys(TOOL_RESULT_SCHEMAS).filter((name) => !knownTools.has(name));
  assert.deepEqual(orphans, [], `contract(s) for unknown tool(s): ${orphans.join(', ')}`);
});

await check('a read that carries no file contents is rejected, not forwarded', async () => {
  const hollow = { ok: true, summary: 'Read app.ts (lines 1-40 of 40).', followUp: true };
  const contract = validateToolResult('read_file', hollow);
  assert.equal(contract.length, 1);
  assert.equal(contract[0].field, 'detail');

  const built = buildObservation(hollow, { toolName: 'read_file', knownTools });
  assert.equal(built.contractViolated, true);
  assert.equal(built.observation.status, 'error', 'a success without its payload must not read as success');
  assert.match(built.observation.summary, /Result rejected/);
  assert.match(built.observation.summary, /different route/, 'the model is told not to repeat the same call');
});

await check('a screenshot read that attaches no image is rejected', async () => {
  const hollow = { ok: true, summary: 'Attached shot.png.', detail: 'Look at it.', artifacts: ['shot.png'], followUp: true };
  assert.equal(validateToolResult('read_media', hollow).some((issue) => issue.field === 'media'), true);
  const withMedia = { ...hollow, media: { path: 'shot.png', mime: 'image/png', dataUrl: 'data:image/png;base64,AA' } };
  assert.deepEqual(validateToolResult('read_media', withMedia), []);
});

await check('a write that names no artifact is rejected', async () => {
  const hollow = { ok: true, summary: 'Wrote app.ts (12 bytes).', followUp: true };
  assert.equal(validateToolResult('write_file', hollow).some((issue) => issue.field === 'artifacts'), true);
  const named = { ...hollow, artifacts: ['app.ts'] };
  assert.deepEqual(validateToolResult('write_file', named), []);
});

await check('finishing the task must end the turn', async () => {
  const chatty = { ok: true, summary: 'Task done.', followUp: true };
  assert.equal(validateToolResult('complete_task', chatty).some((issue) => issue.field === 'followUp'), true);
  assert.deepEqual(validateToolResult('complete_task', { ...chatty, followUp: false }), []);
});

await check('a refusal owes an explanation, not a payload', async () => {
  const refused = { ok: false, summary: 'File access is disabled for this session.', followUp: true };
  assert.deepEqual(validateToolResult('read_file', refused), [], 'a failed call must not be held to the success payload');
  const built = buildObservation(refused, { toolName: 'read_file', knownTools });
  assert.equal(built.contractViolated, false);
  assert.equal(built.observation.status, 'error');
});

console.log('\n[outputs] the office\'s own results');

await check('every next_action a real tool returns names a real tool', async () => {
  await fs.writeFile(path.join(sandbox, 'app.ts'), 'export const a = 1;\n', 'utf8');
  const calls = [
    { action: 'read_file', path: 'app.ts' },
    { action: 'search_symbol', query: 'a' },
    { action: 'write_file', path: 'new.ts', content: 'export const b = 2;\n' },
    { action: 'apply_patch', patch: ['--- a/app.ts', '+++ b/app.ts', '@@ -1 +1 @@', '-export const a = 1;', '+export const a = 3;'].join('\n') },
    { action: 'list_directory' },
    { action: 'run_command', command: 'node -e "process.exit(0)"' },
    { action: 'read_media', path: 'missing.png' },
    { action: 'http_request', url: 'http://127.0.0.1:9/none' },
  ];

  for (const call of calls) {
    const result = await executeAction(call, context(), handlers);
    const issues = validateObservation(result, knownTools);
    assert.deepEqual(
      issues,
      [],
      `${call.action} returned a malformed observation: ${JSON.stringify(issues)} (summary: ${result.summary})`,
    );
    const contract = validateToolResult(call.action, result);
    assert.deepEqual(
      contract,
      [],
      `${call.action} broke its own result contract: ${JSON.stringify(contract)} (summary: ${result.summary})`,
    );
    const built = buildObservation(result, { toolName: call.action, knownTools });
    assert.equal(
      built.contractViolated,
      false,
      `${call.action} was rejected by the guard: ${built.observation.summary}`,
    );
    if (result.ok) {
      assert.equal(built.observation.status, 'success', `${call.action} succeeded but was reported as an error`);
    }
  }
});

await check('the payload reaches the model, not just the sentence about it', async () => {
  await fs.writeFile(path.join(sandbox, 'payload.txt'), 'the payload the model needs\n', 'utf8');

  const read = await executeAction({ action: 'read_file', path: 'payload.txt' }, context(), handlers);
  const built = buildObservation(read, { toolName: 'read_file', knownTools });
  assert.equal(built.observation.status, 'success');
  assert.ok(
    (built.observation.detail ?? '').includes('the payload the model needs'),
    'the file text is in the observation',
  );

  const listed = await executeAction({ action: 'list_directory' }, context(), handlers);
  const listedView = buildObservation(listed, { toolName: 'list_directory', knownTools }).observation;
  assert.ok((listedView.detail ?? '').includes('payload.txt'), 'the listing is in the observation');
});

await check('a successful write is accepted and its shape survives sanitizing', async () => {
  const result = await executeAction({ action: 'write_file', path: 'kept.ts', content: 'kept\n' }, context(), handlers);
  assert.equal(result.ok, true, result.summary);
  const clean = sanitizeObservation(result, knownTools);
  assert.equal(clean.summary, result.summary);
  assert.deepEqual(clean.nextActions ?? [], result.nextActions ?? []);
});

const failed = results.filter((entry) => !entry.ok);
console.log(`\n[outputs] ${results.length - failed.length}/${results.length} checks passed.`);
if (failed.length > 0) {
  console.log(`Failed: ${failed.map((entry) => entry.label).join(' · ')}`);
  process.exitCode = 1;
}

await fs.rm(sandbox, { recursive: true, force: true });
