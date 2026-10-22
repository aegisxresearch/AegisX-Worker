/**
 * Module-level checks for the parts of the office that guard the worker:
 * the completion gate, the git checkpoint, the tool jail, the web SSRF guard
 * and the headless-Chrome preview.
 *
 * No model is involved, so this runs in a couple of seconds. It is deliberately
 * aimed at the *failure* paths — the happy path is already covered end to end
 * by `npm run check:usage` (a mocked task has to pass the gate to become done).
 *
 *   node --experimental-strip-types scripts/gate-check.mjs
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { READ_WINDOW_LINES } from '../server/src/config.ts';
import { createCheckpoint, summariseChanges } from '../server/src/git.ts';
import { captureScreenshot, findBrowser } from '../server/src/preview.ts';
import { executeAction } from '../server/src/tools.ts';
import {
  captureVerificationPlan,
  describeVerificationFailure,
  findMissingAssets,
  runVerificationPlan,
} from '../server/src/verify.ts';
import { assertPublicUrl, webFetch } from '../server/src/web.ts';

const results = [];

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

function say(message) {
  console.log(`\n[gate] ${message}`);
}

let sandbox = '';

/** A throwaway folder; every scenario gets its own so nothing leaks between them. */
async function folder(name) {
  const root = path.join(sandbox, name);
  await fs.mkdir(root, { recursive: true });
  return root;
}

async function writeJson(target, value) {
  await fs.writeFile(target, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

/** npm-based checks only apply when node_modules exists, so every fixture has one. */
async function withDeviceModules(root) {
  await fs.mkdir(path.join(root, 'node_modules'), { recursive: true });
}

function runBinary(bin, args, cwd) {
  return new Promise((resolve) => {
    execFile(
      bin,
      args,
      { cwd, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' } },
      (error, stdout, stderr) => resolve({ ok: !error, stdout: stdout.trim(), stderr: stderr.trim() }),
    );
  });
}

/** The real action handlers are irrelevant here: no office action is exercised. */
const noopHandlers = {
  moveTo: () => 'Moved.',
  setStatus: () => 'Status set.',
  completeTask: () => 'Completed.',
  addNote: () => 'Noted.',
  createTask: () => 'Created.',
};

function actionContext(workspaceRoot) {
  return {
    agentId: 'agent-1',
    agentName: 'Nadia',
    taskId: null,
    toolsEnabled: true,
    webEnabled: true,
    workspaceRoot,
  };
}

// ── the completion gate ─────────────────────────────────────────────────────

async function gateChecks() {
  say('completion gate');

  const placeholder = await folder('gate-placeholder');
  await withDeviceModules(placeholder);
  await writeJson(path.join(placeholder, 'package.json'), {
    name: 'placeholder',
    scripts: { test: 'echo "Error: no test specified" && exit 1' },
  });

  await check('npm\'s placeholder test script is not treated as a suite', async () => {
    const plan = await captureVerificationPlan(placeholder);
    assert.deepEqual(plan.checks, [], 'no check should be captured');
    const report = await runVerificationPlan(plan);
    assert.equal(report.ok, true, 'an empty plan passes rather than failing on nothing');
  });

  const snapshot = await folder('gate-snapshot');
  await withDeviceModules(snapshot);
  await writeJson(path.join(snapshot, 'package.json'), { name: 'snapshot', scripts: {} });

  await check('a test script written mid-task cannot enter the captured plan', async () => {
    const plan = await captureVerificationPlan(snapshot);
    assert.deepEqual(plan.checks, [], 'nothing to run at capture time');

    // The worker "discovers" a test and writes a failing one.
    await fs.writeFile(path.join(snapshot, 'fail.mjs'), "console.error('late-marker');\nprocess.exit(1);\n");
    await writeJson(path.join(snapshot, 'package.json'), {
      name: 'snapshot',
      scripts: { test: 'node fail.mjs' },
    });

    const report = await runVerificationPlan(plan);
    assert.equal(report.ok, true, 'the gate still runs the plan it captured, not the new script');
    assert.deepEqual(
      report.ran.map((entry) => entry.name),
      [],
      'no check ran, so the injected script never became part of the gate',
    );
  });

  const failing = await folder('gate-failing');
  await withDeviceModules(failing);
  await fs.writeFile(path.join(failing, 'fail.mjs'), "console.error('boom-marker');\nprocess.exit(1);\n");
  await fs.writeFile(path.join(failing, 'pass.mjs'), 'process.exit(0);\n');
  await writeJson(path.join(failing, 'package.json'), {
    name: 'failing',
    scripts: { test: 'node fail.mjs', build: 'node pass.mjs' },
  });

  const failingPlan = await captureVerificationPlan(failing);

  await check('a failing check reopens the work with the error tail', async () => {
    const report = await runVerificationPlan(failingPlan);
    assert.equal(report.ok, false, 'the gate must not pass a failing project');
    assert.equal(report.ran[0].name, 'test');
    assert.equal(report.ran[0].ok, false);

    const failure = describeVerificationFailure(report);
    assert.match(failure, /`test` failed/);
    assert.match(failure, /boom-marker/, 'the worker needs the actual error, not just "failed"');
  });

  await check('checks after a failure are reported as not run, not silently skipped', async () => {
    const report = await runVerificationPlan(failingPlan);
    assert.ok(
      report.notes.some((note) => /Not run because test failed: build/.test(note)),
      `notes were: ${JSON.stringify(report.notes)}`,
    );
  });

  const brokenPage = await folder('gate-missing-asset');
  await fs.writeFile(
    path.join(brokenPage, 'index.html'),
    '<!doctype html><html><head><link rel="stylesheet" href="styles.css"></head><body>Hi</body></html>\n',
  );

  await check('a page that links a stylesheet it never wrote is caught', async () => {
    assert.deepEqual(await findMissingAssets(brokenPage), ['styles.css']);
    const report = await runVerificationPlan(await captureVerificationPlan(brokenPage));
    assert.equal(report.ok, false);
    const last = report.ran.at(-1);
    assert.equal(last.name, 'rendered page references');
    assert.match(last.output, /styles\.css/);
  });

  const goodPage = await folder('gate-good-page');
  await fs.writeFile(
    path.join(goodPage, 'index.html'),
    '<!doctype html><html><head><link rel="stylesheet" href="styles.css"></head><body><script src="app.js"></script></body></html>\n',
  );
  await fs.writeFile(path.join(goodPage, 'styles.css'), 'body { margin: 0 }\n');
  await fs.writeFile(path.join(goodPage, 'app.js'), 'console.log("ok");\n');

  await check('a complete page passes the gate', async () => {
    assert.deepEqual(await findMissingAssets(goodPage), []);
    const report = await runVerificationPlan(await captureVerificationPlan(goodPage));
    assert.equal(report.ok, true, JSON.stringify(report.ran));
  });
}

// ── the git checkpoint ──────────────────────────────────────────────────────

async function checkpointChecks() {
  say('git checkpoint');

  const fresh = await folder('checkpoint-fresh');
  await fs.writeFile(path.join(fresh, 'index.html'), '<!doctype html><title>one</title>\n');
  await fs.mkdir(path.join(fresh, 'node_modules', 'junk'), { recursive: true });

  let freshCheckpoint = null;

  await check('a folder that is not a repo yet gets a baseline commit', async () => {
    const outcome = await createCheckpoint(fresh, 'a check');
    assert.equal(outcome.reason, null);
    assert.ok(outcome.checkpoint, 'a checkpoint should have been taken');
    assert.match(outcome.checkpoint.ref, /^[0-9a-f]{40}$/, 'ref must be a commit hash');
    freshCheckpoint = outcome.checkpoint;

    const log = await runBinary('git', ['-C', fresh, 'log', '--oneline'], fresh);
    assert.match(log.stdout, /baseline before a check/);
  });

  await check('checkpoint commits exclude node_modules and office state', async () => {
    const excludes = await fs.readFile(path.join(fresh, '.git', 'info', 'exclude'), 'utf8');
    assert.match(excludes, /^node_modules\/$/m);
    assert.match(excludes, /^\.agent-office\/$/m);
    const tracked = await runBinary('git', ['-C', fresh, 'ls-files'], fresh);
    assert.equal(tracked.stdout.includes('node_modules'), false, tracked.stdout);
  });

  await check('the closing summary names what the worker changed', async () => {
    await fs.writeFile(path.join(fresh, 'added.md'), '# Added by the worker\n');
    const summary = await summariseChanges(freshCheckpoint);
    assert.match(summary, /added\.md/);
    assert.match(summary, /1 file/i);
  });

  const owned = await folder('checkpoint-owned');
  await fs.writeFile(path.join(owned, 'README.md'), '# Mine\n');
  const init = await runBinary('git', ['init', '-q'], owned);
  assert.equal(init.ok, true, init.stderr);

  await check('a folder that is already a repo is left untouched', async () => {
    const outcome = await createCheckpoint(owned, 'a check');
    assert.equal(outcome.checkpoint, null);
    assert.match(outcome.reason, /already a git repo/);
    const log = await runBinary('git', ['-C', owned, 'log', '--oneline'], owned);
    assert.equal(log.ok, false, 'no commit may be created in the operator\'s repo');
  });
}

// ── the tool jail ───────────────────────────────────────────────────────────

async function toolChecks() {
  say('tool jail');

  const workspace = await folder('tools');
  await fs.writeFile(path.join(workspace, 'notes.md'), 'hello notes\n');
  // Long enough to exceed the default window, so `limit: 0` is exercised.
  const longFile = Array.from({ length: 500 }, (_, index) => `line ${index + 1}`).join('\n');
  await fs.writeFile(path.join(workspace, 'long.txt'), `${longFile}\n`);
  await fs.writeFile(
    path.join(workspace, 'drift.ts'),
    'export function total() {\n    return 1;\n}\n',
  );
  const context = actionContext(workspace);

  await check('read_file returns one window and points at the next offset', async () => {
    const read = await executeAction({ action: 'read_file', path: 'long.txt', offset: 10, limit: 5 }, context);
    assert.equal(read.ok, true, read.summary);
    assert.match(read.summary, /lines 10-14 of \d+/);
    assert.match(read.detail, /offset=15/);
    assert.equal(read.detail.includes('line 15'), false, 'the window must stop at line 14');
  });

  await check('a limit of 0 means the default window, not one line', async () => {
    const read = await executeAction({ action: 'read_file', path: 'long.txt', limit: 0 }, context);
    assert.equal(read.ok, true, read.summary);
    assert.match(read.summary, new RegExp(`lines 1-${READ_WINDOW_LINES} of \\d+`));
    assert.match(read.detail, /offset=401/, 'the default window must page on past 400 lines');
  });

  await check('edit_file still applies when only indentation drifted', async () => {
    const edit = await executeAction(
      {
        action: 'edit_file',
        path: 'drift.ts',
        search: 'export function total() {\n  return 1;\n}',
        replace: 'export function total() {\n    return 2;\n}',
      },
      context,
    );
    assert.equal(edit.ok, true, edit.summary);
    assert.match(edit.summary, /ignoring indentation/);
    const written = await fs.readFile(path.join(workspace, 'drift.ts'), 'utf8');
    assert.match(written, /return 2;/);
    assert.match(written, /^    return 2;$/m, 'the file keeps its own indentation');
  });

  await check('run_command refuses to leave the workspace', async () => {
    const hop = await executeAction({ action: 'run_command', command: 'cat ../outside.txt' }, context);
    assert.equal(hop.ok, false, 'a .. hop must be rejected');
    assert.match(hop.summary, /leave the workspace/);

    const absolute = await executeAction({ action: 'run_command', command: 'cat /etc/passwd' }, context);
    assert.equal(absolute.ok, false, 'an absolute path outside the root must be rejected');
    assert.match(absolute.summary, /outside the workspace folder/);

    const offList = await executeAction({ action: 'run_command', command: 'curl https://example.com' }, context);
    assert.equal(offList.ok, false);
    assert.match(offList.summary, /http_check/, 'a refusal names the tool that replaces the binary');
  });

  await check('run_command still runs an allowlisted command inside the folder', async () => {
    const read = await executeAction({ action: 'run_command', command: 'cat notes.md' }, context);
    assert.equal(read.ok, true, read.summary);
    assert.match(read.detail, /hello notes/);
  });
}

// ── the web guard ───────────────────────────────────────────────────────────

async function webChecks() {
  say('web guard');

  await check('fetching the office itself is blocked before any request is made', async () => {
    await assert.rejects(() => webFetch('http://127.0.0.1:8787/api/session'), /private address/);
    await assert.rejects(() => webFetch('http://169.254.169.254/latest/meta-data'), /private address/);
    await assert.rejects(() => webFetch('http://localhost:22/'), /private address/);
  });

  await check('only http(s) URLs without credentials are accepted', async () => {
    await assert.rejects(() => assertPublicUrl('file:///etc/passwd'), /Only http and https/);
    await assert.rejects(() => assertPublicUrl('https://user:secret@example.com/'), /embedded credentials/);
    await assert.rejects(() => assertPublicUrl('not a url'), /Not a valid URL/);
  });

  await check('a public address still passes the guard', async () => {
    const url = await assertPublicUrl('https://1.1.1.1/');
    assert.equal(url.protocol, 'https:');
  });
}

// ── the preview ─────────────────────────────────────────────────────────────

async function previewChecks() {
  say('preview');

  await check('a page is rendered to a real PNG', async () => {
    const browser = findBrowser();
    assert.ok(browser, 'no Chrome/Chromium binary found — install one to run this check');

    const page = await folder('preview');
    await fs.writeFile(
      path.join(page, 'index.html'),
      '<!doctype html><html><head><style>body{margin:0;background:#0f172a;color:#fff;font:16px system-ui}</style></head><body><h1>Preview</h1></body></html>\n',
    );
    const shot = await captureScreenshot({ root: page, htmlRelative: 'index.html', width: 800, height: 600 });
    assert.equal(shot.ok, true, shot.message);
    assert.ok(shot.bytes > 1000, `expected a real image, got ${shot.bytes} bytes`);
    assert.match(shot.artifact, /\.png$/);

    const stat = await fs.stat(path.join(page, shot.artifact));
    assert.ok(stat.size > 1000);
  });
}

sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'aegisx-gate-'));

try {
  await gateChecks();
  await checkpointChecks();
  await toolChecks();
  await webChecks();
  await previewChecks();
} finally {
  await fs.rm(sandbox, { recursive: true, force: true });
}

const passed = results.filter((entry) => entry.ok).length;
console.log(`\n${passed}/${results.length} checks passed.`);
if (passed !== results.length) {
  const failed = results.filter((entry) => !entry.ok).map((entry) => entry.label);
  console.log(`Failed: ${failed.join(' · ')}`);
  process.exit(1);
}
