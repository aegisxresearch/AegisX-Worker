/**
 * Proves the eval harness measures what it claims.
 *
 * It runs the whole suite against a scripted model, then asserts on the report:
 * every task ran, the office itself said "done" the whole time, and the three
 * missions whose scripted work only *looked* finished were still failed by
 * their acceptance checks. Delegation is covered too — six model rounds across
 * two workers, credited to the mission. The last checks pin the workspace
 * safety rule that makes an eval run harmless on a machine where the operator
 * has already picked their own project folder.
 *
 *   node --experimental-strip-types scripts/eval-check.mjs
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { EVAL_TASKS } from '../evals/tasks.mjs';
import { assertEvalWorkspace, loadEnvFile, runEval } from './eval.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const TOKENS_PER_ROUND = 1020;
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

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = http.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

/**
 * A stale saved folder must never redirect the office away from the folder it
 * was told to use. Without this, an eval (or a CI job) on the operator's
 * machine would write its fixtures into the operator's real project.
 */
async function explicitWorkspaceWins() {
  const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'aegisx-eval-workspace-'));
  const real = path.join(sandbox, 'real-workspace');
  const decoy = path.join(sandbox, 'decoy-workspace');
  const stateDir = path.join(sandbox, 'state');
  await fs.mkdir(real, { recursive: true });
  await fs.mkdir(decoy, { recursive: true });
  await fs.mkdir(stateDir, { recursive: true });
  await fs.writeFile(
    path.join(stateDir, 'workspace.json'),
    `${JSON.stringify({ root: decoy }, null, 2)}\n`,
    'utf8',
  );

  const port = await freePort();
  const server = spawn(
    process.execPath,
    ['--experimental-strip-types', path.join(REPO_ROOT, 'server', 'src', 'index.ts')],
    {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        OFFICE_PORT: String(port),
        OFFICE_DEMO: '1',
        OFFICE_TOOLS: '1',
        OFFICE_WORKSPACE: real,
        OFFICE_STATE_DIR: stateDir,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  try {
    const started = Date.now();
    for (;;) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/session`);
        if (response.ok) {
          const session = await response.json();
          assert.equal(
            session.settings.workspaceRoot,
            real,
            'the saved folder overrode OFFICE_WORKSPACE',
          );
          return;
        }
      } catch {
        // not listening yet
      }
      if (Date.now() - started > 30_000) throw new Error('the office did not boot');
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  } finally {
    server.kill('SIGTERM');
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 3000);
      server.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    if (server.exitCode === null) server.kill('SIGKILL');
    await fs.rm(sandbox, { recursive: true, force: true });
  }
}

console.log('\n[eval] harness');
const report = await runEval({ mode: 'mock' });
console.log('');

const byId = new Map(report.tasks.map((entry) => [entry.id, entry]));
/** Work that looked finished but was not; the acceptance check must reject it. */
const EXPECTED_FAILURES = ['css-tokens', 'parse-tests', 'already-green'];
/** Tasks whose property lives in a run that legitimately ends blocked. */
const EXPECTED_BLOCKED = ['usage-after-failure', 'mission-budget'];

await check('every task in the suite ran, once, with a report row', async () => {
  assert.equal(report.tasks.length, EVAL_TASKS.length);
  assert.deepEqual(
    report.tasks.map((entry) => entry.id),
    EVAL_TASKS.map((entry) => entry.id),
  );
  for (const entry of report.tasks) {
    assert.ok(entry.usage.totalTokens > 0, `${entry.id} recorded no spend`);
    assert.ok(entry.durationMs > 0, `${entry.id} recorded no elapsed time`);
  }
});

await check('the board status is not the verdict', async () => {
  for (const entry of report.tasks) {
    const expected = EXPECTED_BLOCKED.includes(entry.id) ? 'blocked' : 'done';
    assert.equal(entry.status, expected, `${entry.id} ended ${entry.status}`);
  }
  assert.equal(report.totals.failed, EXPECTED_FAILURES.length);
  assert.equal(report.totals.passed, EVAL_TASKS.length - EXPECTED_FAILURES.length);
});

await check('a hard-coded colour outside :root is caught', async () => {
  const entry = byId.get('css-tokens');
  assert.equal(entry.passed, false);
  assert.match(entry.reason, /var\(--surface\)|literal colour/);
});

await check('a test suite that would not catch the bug is caught', async () => {
  const entry = byId.get('parse-tests');
  assert.equal(entry.passed, false);
  assert.match(entry.reason, /still passes when parseList ignores its input/);
});

await check('churn on code that was already correct is caught', async () => {
  const entry = byId.get('already-green');
  assert.equal(entry.passed, false);
  assert.match(entry.reason, /working total was rewritten/);
});

await check('every other mission passes', async () => {
  const passing = report.tasks.filter((entry) => entry.passed).map((entry) => entry.id);
  const expected = EVAL_TASKS.map((entry) => entry.id).filter(
    (id) => !EXPECTED_FAILURES.includes(id),
  );
  assert.deepEqual(passing, expected);
});

await check('a turn that ends in prose is nudged, not blocked', async () => {
  const entry = byId.get('nudge-completion');
  assert.equal(entry.status, 'done');
  assert.equal(entry.passed, true, entry.reason);
  assert.equal(entry.nudges, 1, 'exactly one nudge should be sent');
});

await check('a transient endpoint failure is retried once', async () => {
  const entry = byId.get('retry-endpoint');
  assert.equal(entry.status, 'done');
  assert.equal(entry.passed, true, entry.reason);
  assert.equal(entry.retries, 1, 'the 500 should have produced one retry');
});

await check('a failed turn still reports what it spent', async () => {
  const entry = byId.get('usage-after-failure');
  assert.equal(entry.status, 'blocked');
  assert.ok(entry.usage.totalTokens > 0, 'the turn died without recording its spend');
});

await check('a mission budget stops the run and is recorded', async () => {
  const entry = byId.get('mission-budget');
  assert.equal(entry.status, 'blocked');
  assert.equal(entry.usage.totalTokens, 1020, 'the one round that ran must be billed');
});

await check('an empty completion is asked for evidence once', async () => {
  const entry = byId.get('empty-completion');
  assert.equal(entry.status, 'done');
  assert.equal(entry.evidenceNudges, 1);
  assert.equal(entry.passed, true, entry.reason);
});

await check('a delegated mission is credited to both workers', async () => {
  const entry = byId.get('team-handoff');
  assert.equal(entry.passed, true, entry.reason);
  // Pass 1 (delegate, stop), the subtask's write and report, and pass 2
  // (status file, complete) — one worker alone could not produce this many.
  assert.ok(
    entry.usage.turns >= 5,
    `expected the lead and the specialist's turns in the total, got ${entry.usage.turns}`,
  );
});

await check('the delegation check rejects a handoff to the wrong worker', async () => {
  const task = EVAL_TASKS.find((entry) => entry.id === 'team-handoff');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aegisx-eval-handoff-'));
  try {
    await fs.mkdir(path.join(root, 'site'), { recursive: true });
    await fs.writeFile(
      path.join(root, 'site', 'index.html'),
      '<title>Kopi Nusantara</title><main>Single origin, roasted weekly</main>',
      'utf8',
    );
    await fs.writeFile(path.join(root, 'STATUS.md'), 'Aria delivered `site/index.html`.', 'utf8');
    const context = {
      read: (relative) => fs.readFile(path.join(root, relative), 'utf8'),
      board: {
        task: { id: 'parent' },
        tasks: [
          { id: 'parent' },
          // The page is right, but someone else was handed the work. `pack` is
          // part of a real delegated task, so the synthetic board carries it:
          // otherwise this fixture would fail on a field the mission never
          // forgot instead of on the handoff it is testing.
          { id: 'child', parentId: 'parent', assigneeId: 'bimo', status: 'done', pack: 'frontend' },
        ],
        agents: [{ id: 'aria', name: 'Aria' }],
      },
      usage: { own: { totalTokens: 4000 }, rolled: { totalTokens: 6000 } },
    };
    await assert.rejects(() => task.accept(context), /not handed to the frontend engineer/);

    // A correct handoff still has to have its spend in the mission total.
    context.board.tasks[1].assigneeId = 'aria';
    context.usage.rolled = { totalTokens: 4000 };
    await assert.rejects(() => task.accept(context), /subtask spend is missing/);

    // And with both fixed, the same folder passes — the rejections above were
    // the assertion's doing, not the fixture's.
    context.usage.rolled = { totalTokens: 6000 };
    await task.accept(context);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

await check('cost is the measured tokens at the recorded rate', async () => {
  const { price } = report;
  assert.equal(price.source, 'default');
  let total = 0;
  for (const entry of report.tasks) {
    const expected =
      (entry.usage.promptTokens / 1_000_000) * price.inputPerMillion +
      (entry.usage.completionTokens / 1_000_000) * price.outputPerMillion;
    assert.ok(
      Math.abs(expected - entry.costUsd) < 1e-9,
      `${entry.id}: cost ${entry.costUsd} != ${expected}`,
    );
    total += entry.costUsd;
  }
  assert.ok(Math.abs(total - report.totals.costUsd) < 1e-9, 'per-task costs do not add up');
  assert.ok(report.totals.costUsd > 0, 'the run cost nothing, so cost was not measured');
});

await check('each model round is billed exactly once', async () => {
  for (const entry of report.tasks) {
    assert.equal(
      entry.usage.totalTokens,
      entry.usage.turns * TOKENS_PER_ROUND,
      `${entry.id}: ${entry.usage.totalTokens} tokens over ${entry.usage.turns} turns`,
    );
  }
});

await check('wall time is per task and adds up', async () => {
  const sum = report.tasks.reduce((total, entry) => total + entry.durationMs, 0);
  assert.ok(Math.abs(sum - report.totals.durationMs) < 1, 'per-task times do not add up');
  assert.ok(report.totals.durationMs > 0);
});

await check('an explicit workspace beats a saved one', explicitWorkspaceWins);

await check('the harness reads .env, but an exported value wins', async () => {
  const file = path.join(os.tmpdir(), `aegisx-eval-env-${process.pid}`);
  await fs.writeFile(
    file,
    'OFFICE_EVAL_PROBE_FROM_FILE=yes\nOFFICE_EVAL_PROBE_EXPORTED=file\n',
    'utf8',
  );
  process.env.OFFICE_EVAL_PROBE_EXPORTED = 'environment';
  try {
    assert.equal(loadEnvFile(file), true);
    assert.equal(process.env.OFFICE_EVAL_PROBE_FROM_FILE, 'yes');
    assert.equal(process.env.OFFICE_EVAL_PROBE_EXPORTED, 'environment');
    assert.equal(loadEnvFile(`${file}.missing`), false);
  } finally {
    delete process.env.OFFICE_EVAL_PROBE_FROM_FILE;
    delete process.env.OFFICE_EVAL_PROBE_EXPORTED;
    await fs.rm(file, { force: true });
  }
});

await check('a mission is refused when the office is in another folder', async () => {
  const session = { settings: { workspaceRoot: '/home/someone/their-own-project' } };
  assert.doesNotThrow(() =>
    assertEvalWorkspace({ settings: { workspaceRoot: '/tmp/eval' } }, '/tmp/eval'),
  );
  assert.throws(() => assertEvalWorkspace(session, '/tmp/eval'), /not the eval folder/);
  assert.throws(() => assertEvalWorkspace(undefined, '/tmp/eval'), /not the eval folder/);
});

const passed = results.filter((entry) => entry.ok).length;
console.log(`\n[eval] ${passed}/${results.length} checks passed.`);
if (passed !== results.length) {
  console.log(`Failed: ${results.filter((entry) => !entry.ok).map((entry) => entry.label).join(' · ')}`);
  process.exit(1);
}
