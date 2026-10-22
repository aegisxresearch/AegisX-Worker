/**
 * The failure ledger.
 *
 * `blocked` used to be one status for six different causes and the only detail
 * was prose, so "missions keep failing" could not be ranked. This check pins the
 * three things that make the ranking real:
 *
 *   1. every blocked task carries a reason code, and every blocked write in the
 *      runtime sets one,
 *   2. the grouping is ordered and stable (the top row is the thing to fix),
 *   3. each code has a translated label and a translated next step.
 *
 *   npm run check:failure
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { messages, messageKeys } from '../shared/i18n.ts';
import {
  FAILURE_LABELS,
  FAILURE_NEXT_STEPS,
  FAILURE_REASONS,
  isFailureReason,
  summariseFailures,
} from '../shared/failures.ts';
import { EventBus } from '../server/src/events.ts';
import { OfficeStore } from '../server/src/store.ts';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const results = [];

async function check(label, run) {
  try {
    await run();
    results.push({ label, ok: true });
    console.log(`  ✓ ${label}`);
  } catch (error) {
    results.push({ label, ok: false });
    console.log(`  ✗ ${label}\n      ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** A blocked task in the shape the store writes, with only the fields the ledger reads. */
function blockedTask(id, title, reason, at = 1_700_000_000_000) {
  return {
    id,
    title,
    detail: '',
    status: 'blocked',
    priority: 'medium',
    assigneeId: null,
    createdAt: at,
    updatedAt: at,
    notes: [],
    parentId: null,
    mission: false,
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, turns: 0 },
    failureReason: reason,
  };
}

console.log('\n[failure] grouping');

await check('counts per cause and orders by count', () => {
  const summary = summariseFailures([
    blockedTask('t1', 'One', 'no_progress'),
    blockedTask('t2', 'Two', 'model_error'),
    blockedTask('t3', 'Three', 'model_error'),
    blockedTask('t4', 'Four', 'budget'),
    blockedTask('t5', 'Five', 'model_error'),
  ]);
  assert.equal(summary.total, 5);
  assert.deepEqual(summary.reasons, [
    { reason: 'model_error', count: 3 },
    { reason: 'no_progress', count: 1 },
    { reason: 'budget', count: 1 },
  ]);
});

await check('a tie keeps the canonical order, so the ranking does not reshuffle', () => {
  const make = (order) =>
    summariseFailures(order.map((reason, index) => blockedTask(`t${index}`, reason, reason)));
  const forward = make(['no_progress', 'budget']);
  const backward = make(['budget', 'no_progress']);
  assert.deepEqual(
    forward.reasons.map((entry) => entry.reason),
    backward.reasons.map((entry) => entry.reason),
  );
  assert.deepEqual(
    forward.reasons.map((entry) => entry.reason),
    ['no_progress', 'budget'],
  );
});

await check('finished work and unlabelled tasks are not counted', () => {
  const done = { ...blockedTask('t1', 'Done', 'no_progress'), status: 'done' };
  const legacy = { ...blockedTask('t2', 'Legacy', 'no_progress'), failureReason: null };
  const summary = summariseFailures([done, legacy]);
  assert.equal(summary.total, 0);
  assert.deepEqual(summary.reasons, []);
});

await check('a restored task with an unknown code is not trusted', () => {
  assert.equal(isFailureReason('no_progress'), true);
  assert.equal(isFailureReason('made_up'), false);
  assert.equal(isFailureReason(null), false);
  const summary = summariseFailures([blockedTask('t1', 'Odd', 'made_up')]);
  assert.equal(summary.total, 0);
});

console.log('\n[failure] the store');

await check('the store groups what the runtime wrote', () => {
  const store = new OfficeStore(new EventBus());
  const first = store.createTask({
    title: 'Ship the page',
    detail: '',
    priority: 'high',
    assigneeId: null,
  });
  const second = store.createTask({
    title: 'Fix the build',
    detail: '',
    priority: 'medium',
    assigneeId: null,
  });
  store.updateTask(first.id, { status: 'blocked', failureReason: 'tool_loop' });
  store.updateTask(second.id, { status: 'blocked', failureReason: 'model_error' });
  const summary = store.failureBreakdown();
  assert.equal(summary.total, 2);
  assert.deepEqual(summary.reasons.map((entry) => entry.reason).sort(), ['model_error', 'tool_loop']);
  assert.ok(summary.tasks.every((entry) => entry.taskId !== ''));
});

await check('a new task starts with no failure reason', () => {
  const store = new OfficeStore(new EventBus());
  const task = store.createTask({
    title: 'Fresh',
    detail: '',
    priority: 'low',
    assigneeId: null,
  });
  assert.equal(task.failureReason, null);
});

console.log('\n[failure] one write path');

await check('every blocked task write in the runtime carries a reason', async () => {
  const source = await fs.readFile(path.join(REPO_ROOT, 'server/src/agentRuntime.ts'), 'utf8');
  // Only real writes: the doc comment that mentions the status has no comma.
  const writes = [...source.matchAll(/status: 'blocked',/g)];
  assert.ok(writes.length >= 2, 'the scan found no blocked writes — has the shape changed?');
  const missing = [];
  for (const match of writes) {
    const window = source.slice(match.index, match.index + 240);
    if (window.includes('failureReason')) continue;
    // An agent status is not a task write: it is the worker standing down, and
    // it is written together with `currentTaskId: null` in the same call.
    if (window.slice(0, 120).includes('currentTaskId')) continue;
    missing.push(window.split('\n')[0]);
  }
  assert.deepEqual(missing, [], `blocked writes without a reason: ${missing.join(' | ')}`);
});

await check('the ledger has one entry point, not one per failure path', async () => {
  const source = await fs.readFile(path.join(REPO_ROOT, 'server/src/agentRuntime.ts'), 'utf8');
  assert.match(source, /#blockTask\(/, 'the single block path is missing');
  const calls = [...source.matchAll(/#blockTask\(\s*\n?\s*([A-Za-z0-9_.]+)/g)].map((match) => match[1]);
  assert.ok(calls.length >= 4, `only ${calls.length} call site(s) — some path still blocks by hand`);
});

console.log('\n[failure] the repair boundary');

await check('only read-only remedies are run without the model', async () => {
  const { isAutoRemedy } = await import('../server/src/agentRuntime.ts');
  for (const tool of ['http_check', 'port_status', 'preview_screenshot']) {
    assert.equal(isAutoRemedy(tool), true, `${tool} should be safe to auto-run`);
  }
  for (const tool of ['delete_file', 'write_file', 'edit_file', 'run_command', 'start_process']) {
    assert.equal(isAutoRemedy(tool), false, `${tool} must never be auto-run`);
  }
});

await check('both model protocols run the remedy, not just the native one', async () => {
  const source = await fs.readFile(path.join(REPO_ROOT, 'server/src/agentRuntime.ts'), 'utf8');
  const calls = [...source.matchAll(/#attemptRemedy\(/g)];
  // One definition plus one call site per protocol (tool calls and JSON actions).
  assert.ok(calls.length >= 3, `only ${calls.length} reference(s) — a protocol skips the repair`);
  assert.match(source, /const repaired = await this\.#attemptRemedy\(agent, taskId, result, remediesRun\)/);
});

console.log('\n[failure] the operator can read it');

await check('every reason has a label and a next step, in both languages', () => {
  const table = messages();
  const keys = new Set(messageKeys());
  for (const reason of FAILURE_REASONS) {
    const label = FAILURE_LABELS[reason];
    const next = FAILURE_NEXT_STEPS[reason];
    assert.ok(keys.has(label), `${reason} has no label key`);
    assert.ok(keys.has(next), `${reason} has no next-step key`);
    for (const key of [label, next]) {
      assert.ok(table[key].en.trim().length > 0, `${key} has no English`);
      assert.ok(table[key].id.trim().length > 0, `${key} has no Indonesian`);
      assert.notEqual(table[key].en, table[key].id, `${key} was not translated`);
    }
  }
});

await check('the API exposes the ranking', async () => {
  const routes = await fs.readFile(path.join(REPO_ROOT, 'server/src/routes/session.ts'), 'utf8');
  assert.match(routes, /router\.get\('\/failures'/, 'GET /api/failures is missing');
  assert.match(routes, /failureBreakdown\(\)/, 'the route does not read the ledger');
});

console.log('\n[failure] the export');

await check('a blocked mission exports as a reproducible case', async () => {
  const { exportFailure, buildFailureRecord, failureSlug } = await import('./export-failure.mjs');
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'aegisx-failure-'));
  const statePath = path.join(tmp, 'office-state.json');
  const outDir = path.join(tmp, 'failures');
  const at = Date.UTC(2026, 9, 21, 9, 0, 0);
  const state = {
    settings: { endpoint: 'https://example.com/v1', model: 'm', toolsEnabled: true, webEnabled: false, workspaceRoot: tmp, demoMode: false, locale: 'en' },
    agents: [{ id: 'agent_1', name: 'Aria', role: 'Frontend Engineer', model: 'm' }],
    tasks: [
      {
        ...blockedTask('task_1', 'Ship the landing page', 'tool_loop', at),
        detail: 'Build index.html with a hero section.',
        assigneeId: 'agent_1',
        updatedAt: at,
      },
    ],
    logs: [
      { id: 'l1', at, level: 'warn', agentId: 'agent_1', kind: 'task.blocked', message: "Aria could not finish the task — it is blocked (tool_loop)." },
    ],
    chats: [],
  };
  await fs.writeFile(statePath, JSON.stringify({ version: 1, savedAt: at, state }, null, 2), 'utf8');

  const record = buildFailureRecord(state, state.tasks[0]);
  assert.equal(record.schema, 'aegisx.failure/1');
  assert.equal(record.task.failureReason, 'tool_loop');
  assert.match(record.nextStep ?? '', /same call kept repeating/);
  assert.equal(record.trace.length, 1);
  assert.equal(failureSlug('Ship the landing page', at), '2026-10-21-ship-the-landing-page');

  const written = await exportFailure({ statePath, outDir });
  assert.equal(path.basename(written.jsonPath), '2026-10-21-ship-the-landing-page.json');
  const parsed = JSON.parse(await fs.readFile(written.jsonPath, 'utf8'));
  assert.equal(parsed.task.title, 'Ship the landing page');
  const markdown = await fs.readFile(written.mdPath, 'utf8');
  assert.match(markdown, /Make it a regression/);
  assert.match(markdown, /nextStep|Next step/i);

  // A second export of the same failure must not overwrite the first.
  const again = await exportFailure({ statePath, outDir });
  assert.notEqual(again.jsonPath, written.jsonPath);
  await fs.rm(tmp, { recursive: true, force: true });
});

await check('exporting refuses to invent a cause', async () => {
  const { exportFailure } = await import('./export-failure.mjs');
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'aegisx-failure-'));
  const statePath = path.join(tmp, 'office-state.json');
  await fs.writeFile(
    statePath,
    JSON.stringify({
      state: {
        settings: {},
        agents: [],
        tasks: [{ ...blockedTask('task_1', 'Legacy', 'no_progress'), failureReason: null }],
        logs: [],
        chats: [],
      },
    }),
    'utf8',
  );
  await assert.rejects(() => exportFailure({ statePath, outDir: path.join(tmp, 'out') }), /nothing to export/i);
  await fs.rm(tmp, { recursive: true, force: true });
});

const passed = results.filter((entry) => entry.ok).length;
console.log(`\n[failure] ${passed}/${results.length} checks passed.`);
if (passed !== results.length) {
  console.log(`Failed: ${results.filter((entry) => !entry.ok).map((entry) => entry.label).join(' · ')}`);
  process.exit(1);
}
