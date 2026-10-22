/**
 * Restart check — the mission board must survive the process dying.
 *
 *   npm run check:restore
 *
 * Boots a real server on a throwaway port and state folder, creates work, kills
 * the process with SIGKILL (no shutdown hook, nothing flushed on the way out),
 * boots again and asserts the board came back honest: same workers, same tasks,
 * same notes, interrupted work marked blocked instead of pretending to run.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const results = [];

async function check(label, run) {
  try {
    await run();
    results.push({ label, ok: true });
    console.log(`  ✓ ${label}`);
  } catch (error) {
    results.push({ label, ok: false });
    console.log(`  ✗ ${label}`);
    console.log(`    ${error instanceof Error ? error.message : String(error)}`);
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function waitFor(predicate, label, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate().catch(() => null);
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

function startServer({ stateDir, workspace, port }) {
  const server = spawn(
    process.execPath,
    ['--experimental-strip-types', path.join(REPO_ROOT, 'server', 'src', 'index.ts')],
    {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        OFFICE_PORT: String(port),
        OFFICE_DEMO: '1',
        OFFICE_WORKSPACE: workspace,
        OFFICE_STATE_DIR: stateDir,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  server.logLines = [];
  server.stdout.on('data', (chunk) => server.logLines.push(chunk.toString()));
  server.stderr.on('data', (chunk) => server.logLines.push(chunk.toString()));
  return server;
}

async function waitForBoot(origin) {
  return waitFor(async () => {
    const response = await fetch(`${origin}/api/session`);
    return response.ok ? await response.json() : null;
  }, 'the server to boot');
}

/** Returns the exit code; a timer force-kills a server that refuses to stop. */
async function stopServer(server, signal) {
  if (server.exitCode !== null) return server.exitCode;
  const exited = new Promise((resolve) => server.once('exit', (code) => resolve(code)));
  server.kill(signal);
  const timer = setTimeout(() => server.kill('SIGKILL'), 5000);
  const code = await exited;
  clearTimeout(timer);
  return code;
}

async function readStateFile(file) {
  const raw = await fs.readFile(file, 'utf8').catch(() => null);
  if (raw === null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'aegisx-restore-'));
const workspace = path.join(sandbox, 'workspace');
const stateDir = path.join(sandbox, 'state');
const stateFile = path.join(stateDir, 'office-state.json');
await fs.mkdir(workspace, { recursive: true });

let activeServer = null;
let lastLog = '';

try {
  // ── Run 1: create work, then die without a shutdown hook ────────────────
  console.log('\n[restore] first boot');
  const firstOrigin = `http://127.0.0.1:${await freePort()}`;
  activeServer = startServer({ stateDir, workspace, port: Number(new URL(firstOrigin).port) });
  const firstSnapshot = await waitForBoot(firstOrigin);

  const lead = firstSnapshot.agents.find((agent) => agent.role === 'Tech Lead');
  assert.ok(lead, 'roster has a lead');
  const originalAgents = firstSnapshot.agents.map((agent) => `${agent.id}:${agent.name}:${agent.deskIndex}`);

  const mission = await (
    await fetch(`${firstOrigin}/api/missions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Survive the restart', detail: 'Write NOTES.md.', priority: 'high' }),
    })
  ).json();
  await waitFor(async () => {
    const tasks = await (await fetch(`${firstOrigin}/api/tasks`)).json();
    return tasks.find((task) => task.id === mission.id && task.status === 'done');
  }, 'the demo mission to finish');

  const openTask = await (
    await fetch(`${firstOrigin}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Interrupted work', detail: 'Half finished when the process died.', priority: 'medium' }),
    })
  ).json();
  await fetch(`${firstOrigin}/api/tasks/${openTask.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'doing', assigneeId: lead.id }),
  });
  const boardBeforeKill = await (await fetch(`${firstOrigin}/api/tasks`)).json();

  // The file must show the task *doing and assigned*, not merely present: the
  // create lands one flush before the PATCH, and killing between the two made
  // this check flaky under load (the "interrupted" work was never on disk).
  const savedFile = await waitFor(async () => {
    const envelope = await readStateFile(stateFile);
    if (!envelope?.state?.tasks) return null;
    const ids = envelope.state.tasks.map((task) => task.id);
    if (!(ids.includes(mission.id) && ids.includes(openTask.id))) return null;
    const savedOpen = envelope.state.tasks.find((task) => task.id === openTask.id);
    return savedOpen?.status === 'doing' && savedOpen?.assigneeId === lead.id ? envelope : null;
  }, 'the running task to reach disk');

  await check('the board reaches disk while the mission runs', () => {
    assert.equal(savedFile.version, 1);
    assert.ok(savedFile.state.agents.length > 0, 'agents are persisted');
    const savedMission = savedFile.state.tasks.find((task) => task.id === mission.id);
    assert.equal(savedMission.status, 'done');
    assert.ok(savedMission.notes.length > 0, 'the mission kept its notes');
    assert.ok(!Object.hasOwn(savedFile.state.settings ?? {}, 'apiKey'), 'the api key is never written');
  });

  await stopServer(activeServer, 'SIGKILL');
  lastLog += activeServer.logLines.join('');
  activeServer = null;

  // ── Run 2: the board must come back ─────────────────────────────────────
  console.log('\n[restore] boot after SIGKILL');
  const secondOrigin = `http://127.0.0.1:${await freePort()}`;
  activeServer = startServer({ stateDir, workspace, port: Number(new URL(secondOrigin).port) });
  const secondSnapshot = await waitForBoot(secondOrigin);

  await check('the roster is restored, not re-seeded', () => {
    const restoredAgents = secondSnapshot.agents.map((agent) => `${agent.id}:${agent.name}:${agent.deskIndex}`);
    assert.deepEqual(restoredAgents, originalAgents);
  });

  await check('a finished mission survives with its notes', () => {
    const restoredMission = secondSnapshot.tasks.find((task) => task.id === mission.id);
    assert.ok(restoredMission, 'the mission is on the board');
    assert.equal(restoredMission.status, 'done');
    assert.equal(restoredMission.mission, true);
    assert.ok(restoredMission.notes.length > 0, 'notes are intact');
  });

  await check('work that was running is blocked, not silently dropped', () => {
    const restoredOpen = secondSnapshot.tasks.find((task) => task.id === openTask.id);
    assert.ok(restoredOpen, 'the interrupted task is still on the board');
    assert.equal(restoredOpen.status, 'blocked');
    assert.ok(restoredOpen.notes.some((note) => note.includes('restarted')), 'the note explains why');
    assert.equal(restoredOpen.assigneeId, lead.id);
  });

  await check('no worker is left looking busy', () => {
    assert.ok(secondSnapshot.agents.every((agent) => agent.status !== 'working'));
    assert.ok(secondSnapshot.agents.every((agent) => agent.currentTaskId === null));
  });

  await check('the restart is reported in the activity log', () => {
    assert.ok(
      secondSnapshot.logs.some((entry) => entry.kind === 'task.interrupted'),
      'a task.interrupted entry is present',
    );
  });

  await check('a restart does not duplicate the board', () => {
    // The two starter tasks are seeded once; a restore must bring back exactly
    // what was there instead of seeding another pair on top of it.
    const titles = secondSnapshot.tasks.map((task) => task.title);
    assert.equal(titles.filter((title) => title === 'Audit the office lighting rig').length, 1);
    assert.equal(titles.filter((title) => title === 'Ship the agent status endpoint').length, 1);
    assert.equal(secondSnapshot.tasks.length, boardBeforeKill.length, 'task count changed across the restart');
    const ids = new Set(secondSnapshot.tasks.map((task) => task.id));
    assert.equal(ids.size, secondSnapshot.tasks.length, 'task ids are unique');
    assert.deepEqual(
      [...ids].sort(),
      [...boardBeforeKill.map((task) => task.id)].sort(),
      'the same tasks came back',
    );
  });

  await check('the token meter comes back with the board', () => {
    assert.ok(secondSnapshot.usage.total.totalTokens > 0);
    assert.ok(secondSnapshot.usage.missions.some((entry) => entry.taskId === mission.id));
  });

  // ── Run 3: a clean stop still writes the latest change ──────────────────
  const lateTask = await (
    await fetch(`${secondOrigin}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Added just before shutdown', detail: 'Must be on disk.', priority: 'low' }),
    })
  ).json();

  const cleanExit = await stopServer(activeServer, 'SIGTERM');
  lastLog += activeServer.logLines.join('');
  activeServer = null;

  await check('SIGTERM flushes and exits cleanly', () => {
    assert.equal(cleanExit, 0);
  });
  await check('a task created just before shutdown is on disk', async () => {
    const envelope = await readStateFile(stateFile);
    assert.ok(envelope, 'state file exists');
    assert.ok(envelope.state.tasks.some((task) => task.id === lateTask.id), 'the late task was flushed');
  });

  // ── Run 4: a corrupt file must not take the office down ─────────────────
  console.log('\n[restore] boot with a corrupt state file');
  await fs.writeFile(stateFile, '{ this is not json', 'utf8');
  const thirdOrigin = `http://127.0.0.1:${await freePort()}`;
  activeServer = startServer({ stateDir, workspace, port: Number(new URL(thirdOrigin).port) });
  const thirdSnapshot = await waitForBoot(thirdOrigin);

  await check('a corrupt file is quarantined and the office still boots', async () => {
    assert.equal(thirdSnapshot.agents.length, 11);
    assert.ok(thirdSnapshot.tasks.some((task) => task.title === 'Audit the office lighting rig'));
    const names = await fs.readdir(stateDir);
    assert.ok(names.some((name) => name.includes('.corrupt-')), `no quarantine file in ${names.join(', ')}`);
  });

  lastLog += activeServer.logLines.join('');
  await stopServer(activeServer, 'SIGTERM');
  activeServer = null;
} catch (error) {
  console.log(`  ✗ the restart scenario could not run: ${error instanceof Error ? error.message : error}`);
  results.push({ label: 'restart scenario', ok: false });
} finally {
  if (activeServer) {
    lastLog += activeServer.logLines.join('');
    await stopServer(activeServer, 'SIGKILL');
  }
  await fs.rm(sandbox, { recursive: true, force: true }).catch(() => undefined);
  if (results.some((entry) => !entry.ok)) {
    console.log(`\n[server log]\n${lastLog.split('\n').slice(-30).join('\n')}`);
  }
}

const passed = results.filter((entry) => entry.ok).length;
console.log(`\n[restore] ${passed}/${results.length} checks passed`);
process.exit(passed === results.length ? 0 : 1);
