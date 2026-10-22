/**
 * Per-turn snapshots and undo.
 *
 * Unit checks prove the restore is exact (edited, added and deleted files all
 * go back; ignored paths are left alone; concurrent turns cannot corrupt the
 * shadow index). The last three run the real server with a scripted model and
 * prove the behaviour the feature exists for:
 *
 *   - a finished task leaves a verified tree behind,
 *   - the next turn that breaks a check is reverted to that tree instead of
 *     being repaired on top of the damage,
 *   - `revert_turn` puts the folder back to how it was when the turn started.
 *
 *   node --experimental-strip-types scripts/snapshot-check.mjs
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import {
  diffSnapshots,
  revertToSnapshot,
  snapshotRepoPath,
  takeSnapshot,
} from '../server/src/snapshots.ts';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
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
  console.log(`\n[snapshot] ${message}`);
}

let sandbox = '';

async function folder(name) {
  const root = path.join(sandbox, name);
  await fs.mkdir(root, { recursive: true });
  return root;
}

function git(gitDir, root, args) {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['--git-dir', gitDir, '--work-tree', root, ...args],
      { env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } },
      (error, stdout) => resolve({ ok: !error, stdout: stdout.trim() }),
    );
  });
}

async function readOrNull(target) {
  return fs.readFile(target, 'utf8').catch(() => null);
}

// ── exact restore ───────────────────────────────────────────────────────────

async function unitChecks() {
  say('restore');

  await check('a snapshot is a real commit in a shadow repo', async () => {
    const root = await folder('basic');
    const stateDir = path.join(sandbox, 'state-basic');
    await fs.writeFile(path.join(root, 'a.txt'), 'one\n', 'utf8');

    const outcome = await takeSnapshot(root, stateDir, 'unit');
    assert.equal(outcome.reason, null);
    assert.match(outcome.snapshot.ref, /^[0-9a-f]{40}$/);
    assert.equal(outcome.snapshot.gitDir, snapshotRepoPath(stateDir, root));

    const files = await git(outcome.snapshot.gitDir, root, ['ls-tree', '-r', '--name-only', outcome.snapshot.ref]);
    assert.equal(files.stdout, 'a.txt');
  });

  await check('revert restores edits, deletions and additions exactly', async () => {
    const root = await folder('exact');
    const stateDir = path.join(sandbox, 'state-exact');
    await fs.writeFile(path.join(root, 'keep.txt'), 'original\n', 'utf8');
    await fs.writeFile(path.join(root, 'gone.txt'), 'still here\n', 'utf8');

    const { snapshot } = await takeSnapshot(root, stateDir, 'before edits');

    await fs.writeFile(path.join(root, 'keep.txt'), 'clobbered\n', 'utf8');
    await fs.rm(path.join(root, 'gone.txt'));
    await fs.writeFile(path.join(root, 'brand-new.txt'), 'leftover\n', 'utf8');

    const outcome = await revertToSnapshot(snapshot);
    assert.equal(outcome.ok, true, outcome.message);
    assert.equal(await readOrNull(path.join(root, 'keep.txt')), 'original\n');
    assert.equal(await readOrNull(path.join(root, 'gone.txt')), 'still here\n');
    assert.equal(
      await readOrNull(path.join(root, 'brand-new.txt')),
      null,
      'a file created in the reverted turn must be removed',
    );
  });

  await check('ignored paths are not snapshotted and survive a revert', async () => {
    const root = await folder('ignored');
    const stateDir = path.join(sandbox, 'state-ignored');
    await fs.mkdir(path.join(root, 'node_modules', 'pkg'), { recursive: true });
    await fs.writeFile(path.join(root, 'node_modules', 'pkg', 'index.js'), 'v1\n', 'utf8');
    await fs.writeFile(path.join(root, 'app.ts'), 'one\n', 'utf8');

    const { snapshot } = await takeSnapshot(root, stateDir, 'with modules');
    await fs.writeFile(path.join(root, 'node_modules', 'pkg', 'index.js'), 'v2\n', 'utf8');
    await fs.writeFile(path.join(root, 'app.ts'), 'two\n', 'utf8');

    await revertToSnapshot(snapshot);
    assert.equal(await readOrNull(path.join(root, 'app.ts')), 'one\n');
    assert.equal(
      await readOrNull(path.join(root, 'node_modules', 'pkg', 'index.js')),
      'v2\n',
      'node_modules is not the agent\'s to roll back',
    );
  });

  await check('two snapshots of the same folder list what changed between them', async () => {
    const root = await folder('diff');
    const stateDir = path.join(sandbox, 'state-diff');
    await fs.writeFile(path.join(root, 'a.txt'), 'one\n', 'utf8');
    const first = (await takeSnapshot(root, stateDir, 'first')).snapshot;

    await fs.writeFile(path.join(root, 'a.txt'), 'two\n', 'utf8');
    await fs.writeFile(path.join(root, 'b.txt'), 'new\n', 'utf8');
    const second = (await takeSnapshot(root, stateDir, 'second')).snapshot;

    const changes = await diffSnapshots(first, second);
    assert.ok(changes.some((line) => line === 'M\ta.txt'), changes.join(' | '));
    assert.ok(changes.some((line) => line === 'A\tb.txt'), changes.join(' | '));
  });

  await check('parallel turns cannot corrupt the snapshot index', async () => {
    const root = await folder('parallel');
    const stateDir = path.join(sandbox, 'state-parallel');
    await fs.writeFile(path.join(root, 'a.txt'), 'one\n', 'utf8');
    const first = (await takeSnapshot(root, stateDir, 'base')).snapshot;

    const outcomes = await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        takeSnapshot(root, stateDir, `parallel ${index}`),
      ),
    );
    for (const outcome of outcomes) {
      assert.ok(outcome.snapshot, outcome.reason ?? 'no snapshot');
      const head = await git(outcome.snapshot.gitDir, root, ['cat-file', '-t', outcome.snapshot.ref]);
      assert.equal(head.stdout, 'commit');
    }

    const outcome = await revertToSnapshot(first);
    assert.equal(outcome.ok, true, outcome.message);
    assert.equal(await readOrNull(path.join(root, 'a.txt')), 'one\n');
  });
}

// ── the server behaviour ────────────────────────────────────────────────────

function toolCall(name, args, id) {
  return {
    choices: [
      {
        delta: {
          tool_calls: [
            {
              index: 0,
              id,
              type: 'function',
              function: { name, arguments: JSON.stringify(args) },
            },
          ],
        },
      },
    ],
  };
}

/**
 * Scripted model with three behaviours, selected by the task title (the one
 * field the runtime controls):
 *   - "Learn the check": writes a passing check.
 *   - "Break the check": writes a failing one.
 *   - "Revert scratch": writes a file, then undoes the turn.
 */
function startMockModel(seen) {
  const server = http.createServer((request, response) => {
    if (request.method === 'GET' && request.url?.startsWith('/v1/models')) {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ data: [{ id: 'mock-snapshot-model' }] }));
      return;
    }
    if (!request.url?.includes('/chat/completions')) {
      response.writeHead(404).end('not found');
      return;
    }

    let raw = '';
    request.on('data', (chunk) => {
      raw += chunk;
    });
    request.on('end', () => {
      const body = JSON.parse(raw || '{}');
      const messages = Array.isArray(body.messages) ? body.messages : [];
      const user = String(messages.find((entry) => entry.role === 'user')?.content ?? '');
      const title = /^Task: (.+)$/m.exec(user)?.[1]?.trim() ?? '';
      const rounds = messages.filter((entry) => entry.role === 'tool').length;
      seen.push({ title, rounds });

      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      const send = (payload) => response.write(`data: ${JSON.stringify(payload)}\n\n`);
      send({ choices: [{ delta: { content: 'Working.' } }] });

      if (title === 'Learn the check' || title === 'Break the check') {
        if (rounds === 0) {
          const body = title === 'Learn the check' ? 'process.exit(0);\n' : 'process.exit(1);\n';
          send(toolCall('write_file', { path: 'check.mjs', content: body }, `call_${seen.length}_w`));
        } else {
          send(toolCall('complete_task', { summary: 'Done.' }, `call_${seen.length}_c`));
        }
      } else if (title === 'Revert scratch') {
        if (rounds === 0) {
          send(toolCall('write_file', { path: 'scratch.txt', content: 'temporary\n' }, `call_${seen.length}_w`));
        } else if (rounds === 1) {
          send(toolCall('revert_turn', {}, `call_${seen.length}_r`));
        } else {
          send(toolCall('complete_task', { summary: 'Done.' }, `call_${seen.length}_c`));
        }
      } else {
        send(toolCall('complete_task', { summary: 'Done.' }, `call_${seen.length}_c`));
      }

      send({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
      send({ usage: { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 } });
      response.write('data: [DONE]\n\n');
      response.end();
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
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

async function getJson(url, init) {
  const response = await fetch(url, init);
  assert.equal(response.ok, true, `${init?.method ?? 'GET'} ${url} → ${response.status}`);
  return response.json();
}

async function waitFor(predicate, label, timeoutMs = 25_000) {
  const started = Date.now();
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
}

async function probeSession(origin) {
  try {
    const response = await fetch(`${origin}/api/session`);
    if (!response.ok) return null;
    const body = await response.json();
    return body.settings.configured ? body : null;
  } catch {
    return null;
  }
}

async function serverChecks() {
  say('server');

  const workspace = await folder('workspace');
  await fs.writeFile(
    path.join(workspace, 'package.json'),
    `${JSON.stringify({ name: 'snapshot-fixture', scripts: { test: 'node check.mjs' } }, null, 2)}\n`,
    'utf8',
  );
  await fs.writeFile(path.join(workspace, 'check.mjs'), 'process.exit(0);\n', 'utf8');
  await fs.mkdir(path.join(workspace, 'node_modules'), { recursive: true });

  const seen = [];
  const model = await startMockModel(seen);
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const stateDir = path.join(sandbox, 'state-server');
  const server = spawn(
    process.execPath,
    ['--experimental-strip-types', path.join(REPO_ROOT, 'server', 'src', 'index.ts')],
    {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        OFFICE_PORT: String(port),
        OFFICE_ENDPOINT: `http://127.0.0.1:${model.address().port}/v1`,
        OFFICE_API_KEY: 'test-key',
        OFFICE_MODEL: 'mock-snapshot-model',
        OFFICE_TOOLS: '1',
        OFFICE_GIT: '0',
        OFFICE_WORKSPACE: workspace,
        OFFICE_STATE_DIR: stateDir,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const serverLog = [];
  server.stdout.on('data', (chunk) => serverLog.push(chunk.toString()));
  server.stderr.on('data', (chunk) => serverLog.push(chunk.toString()));

  const runMission = async (title, until = 'done') => {
    const snapshot = await waitFor(() => probeSession(origin), 'the server to connect');
    const lead = snapshot.agents.find((agent) => agent.role === 'Tech Lead');
    const created = await getJson(`${origin}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, detail: 'One round trip is enough.', assigneeId: lead.id }),
    });
    await waitFor(async () => {
      const tasks = await getJson(`${origin}/api/tasks`);
      const task = tasks.find((entry) => entry.id === created.id);
      return task && (task.status === until || (until === 'done' && task.status === 'done'));
    }, `"${title}" to reach ${until}`);
    return created.id;
  };

  try {
    const snapshotDir = snapshotRepoPath(stateDir, workspace);

    await runMission('Learn the check');

    await check('a finished task leaves a snapshot repo for the folder', async () => {
      assert.equal(await fs.access(snapshotDir).then(() => true).catch(() => false), true);
      const refs = await git(snapshotDir, workspace, ['rev-list', '--count', 'HEAD']);
      assert.ok(Number(refs.stdout) >= 2, `expected turn start + verified, got ${refs.stdout}`);
    });

    await runMission('Break the check');

    await check('a failing check that used to pass restores the verified tree', async () => {
      assert.equal(
        await readOrNull(path.join(workspace, 'check.mjs')),
        'process.exit(0);\n',
        'the broken file must be rolled back to the one that passed',
      );
      const session = await getJson(`${origin}/api/session`);
      const reverted = session.logs.find((entry) => entry.kind === 'task.reverted');
      assert.ok(reverted, 'a task.reverted log line should exist');
      assert.match(reverted.message, /broke test/);
    });

    await check('the reopened task is told its edits are gone', async () => {
      const tasks = await getJson(`${origin}/api/tasks`);
      const broken = tasks.find((task) => task.title === 'Break the check');
      assert.ok(broken, 'the task should still exist');
      assert.ok(
        broken.notes.some((note) => /restored to the last state where test passed/.test(note)),
        JSON.stringify(broken.notes),
      );
    });

    await runMission('Revert scratch');

    await check('revert_turn removes what the turn created', async () => {
      assert.equal(await readOrNull(path.join(workspace, 'scratch.txt')), null);
      const session = await getJson(`${origin}/api/session`);
      const reverted = session.logs.filter((entry) => entry.kind === 'task.reverted');
      assert.ok(
        reverted.some((entry) => /reverted this turn/.test(entry.message)),
        JSON.stringify(reverted.map((entry) => entry.message)),
      );
    });
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
    await new Promise((resolve) => model.close(resolve));
    if (results.some((entry) => !entry.ok)) {
      console.log(`\n[server log]\n${serverLog.join('').split('\n').slice(-25).join('\n')}`);
      console.log(`[requests] ${JSON.stringify(seen)}`);
    }
  }
}

sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'aegisx-snapshot-'));

try {
  await unitChecks();
  await serverChecks();
} finally {
  await fs.rm(sandbox, { recursive: true, force: true });
}

const passed = results.filter((entry) => entry.ok).length;
console.log(`\n[snapshot] ${passed}/${results.length} checks passed.`);
if (passed !== results.length) {
  console.log(`Failed: ${results.filter((entry) => !entry.ok).map((entry) => entry.label).join(' · ')}`);
  process.exit(1);
}
