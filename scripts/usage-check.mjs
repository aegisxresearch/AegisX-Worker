/**
 * Token meter check — the roll-up math and the live server contract.
 *
 *   npm run check:usage
 *
 * Part A exercises `shared/usage.ts` directly (mission roll-up, cycle safety).
 * Part B boots the real server in demo mode and proves a mission's spend is
 * booked once, on the worker and on the task, and is what /api/usage reports.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import http from 'node:http';
import { addUsage, emptyUsage, missionUsage, usageHistory, usageSummary } from '../shared/usage.ts';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const results = [];

function check(label, run) {
  try {
    run();
    results.push({ label, ok: true });
    console.log(`  ✓ ${label}`);
  } catch (error) {
    results.push({ label, ok: false, error });
    console.log(`  ✗ ${label}`);
    console.log(`    ${error instanceof Error ? error.message : String(error)}`);
  }
}

function usage(promptTokens, completionTokens, turns = 1) {
  return {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    turns,
  };
}

function task(overrides) {
  return {
    id: overrides.id,
    title: overrides.title ?? overrides.id,
    detail: '',
    status: overrides.status ?? 'done',
    priority: 'medium',
    assigneeId: overrides.assigneeId ?? null,
    createdAt: overrides.createdAt ?? 0,
    updatedAt: overrides.updatedAt ?? 0,
    notes: [],
    parentId: overrides.parentId ?? null,
    mission: overrides.mission ?? false,
    usage: overrides.usage ?? emptyUsage(),
  };
}

// ── Part A: the math ───────────────────────────────────────────────────────

console.log('\n[meter] roll-up math');
{
  const lead = task({ id: 'mission', mission: true, usage: usage(100, 20) });
  const ui = task({ id: 'ui', parentId: 'mission', assigneeId: 'aria', usage: usage(300, 50, 2) });
  const api = task({ id: 'api', parentId: 'mission', assigneeId: 'bimo', usage: usage(200, 40, 3) });
  const nested = task({ id: 'nested', parentId: 'ui', assigneeId: 'citra', usage: usage(50, 10) });
  const standalone = task({ id: 'solo', usage: usage(7, 3) });
  const board = [lead, ui, api, nested, standalone];

  check('a mission sums the lead and every subtask below it', () => {
    const rolled = missionUsage('mission', board);
    assert.equal(rolled.totalTokens, 120 + 350 + 240 + 60);
    assert.equal(rolled.turns, 1 + 2 + 3 + 1);
    assert.equal(rolled.promptTokens, 100 + 300 + 200 + 50);
  });

  check('a subtask rolls up only what sits below it', () => {
    assert.equal(missionUsage('ui', board).totalTokens, 350 + 60);
  });

  check('a leaf task reports only its own spend', () => {
    assert.equal(missionUsage('solo', board).totalTokens, 10);
  });

  check('an unknown task id is zero, not a crash', () => {
    assert.equal(missionUsage('missing', board).totalTokens, 0);
  });

  check('a parentId cycle terminates instead of hanging', () => {
    const first = task({ id: 'a', parentId: 'b', usage: usage(10, 0) });
    const second = task({ id: 'b', parentId: 'a', usage: usage(10, 0) });
    assert.equal(missionUsage('a', [first, second]).totalTokens, 20);
  });

  check('usageSummary totals, ranks and separates missions from plain tasks', () => {
    const summary = usageSummary(
      [
        { id: 'aria', name: 'Aria', role: 'Frontend Engineer', usage: usage(300, 50, 2) },
        { id: 'bimo', name: 'Bimo', role: 'Backend Engineer', usage: usage(200, 40, 3) },
      ],
      board,
    );
    // 120 + 350 + 240 + 60 inside the mission, plus the standalone 10.
    assert.equal(summary.total.totalTokens, 780);
    assert.equal(summary.agents[0].name, 'Aria');
    assert.ok(summary.missions.some((entry) => entry.taskId === 'mission' && entry.usage.totalTokens === 770));
    assert.ok(summary.tasks.some((entry) => entry.taskId === 'solo'));
    assert.ok(!summary.tasks.some((entry) => entry.taskId === 'ui'));
  });

  check('the history groups finished work by local day, newest first', () => {
    const morning = new Date(2026, 9, 20, 9, 0, 0).getTime();
    const evening = new Date(2026, 9, 21, 18, 30, 0).getTime();
    const yesterday = task({ id: 'm1', mission: true, updatedAt: morning, usage: usage(10, 5) });
    const yesterdayChild = task({ id: 'm1a', parentId: 'm1', updatedAt: morning, usage: usage(20, 5) });
    const today = task({ id: 'm2', mission: true, updatedAt: evening, usage: usage(100, 50) });
    const open = task({ id: 'm3', mission: true, status: 'doing', updatedAt: evening, usage: usage(999, 999) });

    const history = usageHistory([yesterday, yesterdayChild, today, open]);
    assert.equal(history.days.length, 2);
    assert.equal(history.days[0].date, '2026-10-21');
    assert.equal(history.days[1].date, '2026-10-20');
    assert.equal(history.days[1].usage.totalTokens, 40, 'a mission is counted once, with its subtask');
    assert.equal(history.days[0].usage.totalTokens, 150);
    assert.equal(history.total.totalTokens, 190, 'unfinished work is not history');
    assert.equal(history.missions.length, 2, 'the subtask is not a row of its own');
  });

  check('addUsage is pure and keeps both operands intact', () => {
    const left = usage(1, 2, 3);
    const right = usage(4, 5, 6);
    const sum = addUsage(left, right);
    assert.deepEqual(sum, { promptTokens: 5, completionTokens: 7, totalTokens: 12, turns: 9 });
    assert.equal(left.totalTokens, 3);
  });
}

// ── Part B: the live server ────────────────────────────────────────────────

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

async function getJson(url, init) {
  const response = await fetch(url, init);
  const body = await response.text();
  const payload = body.length > 0 ? JSON.parse(body) : {};
  if (!response.ok) throw new Error(`${init?.method ?? 'GET'} ${url} → ${response.status}: ${body}`);
  return payload;
}

async function waitFor(predicate, label, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate().catch(() => null);
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

async function liveServerChecks() {
  console.log('\n[meter] live server');
  const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'aegisx-usage-'));
  const workspace = path.join(sandbox, 'workspace');
  const stateDir = path.join(sandbox, 'state');
  await fs.mkdir(workspace, { recursive: true });

  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
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
  const serverLog = [];
  server.stdout.on('data', (chunk) => serverLog.push(chunk.toString()));
  server.stderr.on('data', (chunk) => serverLog.push(chunk.toString()));

  try {
    const snapshot = await waitFor(async () => {
      const response = await fetch(`${origin}/api/session`);
      return response.ok ? await response.json() : null;
    }, 'the server to boot');

    const lead = snapshot.agents.find((agent) => agent.role === 'Tech Lead');
    assert.ok(lead, 'the roster has a lead');

    const mission = await getJson(`${origin}/api/missions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Meter the mission',
        detail: 'Write NOTES.md with one line describing the folder.',
        priority: 'high',
      }),
    });

    await waitFor(async () => {
      const tasks = await getJson(`${origin}/api/tasks`);
      return tasks.find((entry) => entry.id === mission.id && entry.status === 'done');
    }, 'the demo mission to finish');

    const finished = await getJson(`${origin}/api/tasks`);
    const missionTask = finished.find((entry) => entry.id === mission.id);

    check('a finished mission carries its own token usage', () => {
      assert.ok(missionTask.usage, 'task.usage is present');
      assert.ok(missionTask.usage.totalTokens > 0, 'task.usage.totalTokens > 0');
      assert.equal(missionTask.usage.totalTokens, missionTask.usage.promptTokens + missionTask.usage.completionTokens);
      assert.ok(missionTask.usage.turns >= 1);
    });

    const usageReport = await getJson(`${origin}/api/usage`);
    check('GET /api/usage reports the mission and the worker who ran it', () => {
      assert.ok(usageReport.total.totalTokens > 0);
      const leadRow = usageReport.agents.find((entry) => entry.agentId === lead.id);
      assert.ok(leadRow, 'the lead has a row');
      assert.equal(leadRow.usage.totalTokens, missionTask.usage.totalTokens);
      assert.ok(usageReport.missions.some((entry) => entry.taskId === mission.id));
    });

    check('every token is booked exactly once across the board', () => {
      const perTask = finished.reduce((sum, entry) => sum + entry.usage.totalTokens, 0);
      assert.equal(perTask, usageReport.total.totalTokens);
    });

    const session = await getJson(`${origin}/api/session`);
    check('the session snapshot carries the same meter the endpoint reports', () => {
      assert.deepEqual(session.usage, usageReport);
      const agentOnSnapshot = session.agents.find((agent) => agent.id === lead.id);
      assert.equal(agentOnSnapshot.tokensUsed, agentOnSnapshot.usage.totalTokens);
    });

    const billedBeforeChat = usageReport.agents.find((entry) => entry.agentId === lead.id).usage.totalTokens;
    await getJson(`${origin}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId: lead.id, content: 'Status update?' }),
    });
    // POST /api/chat answers 202 and runs the turn in the background.
    const afterChat = await waitFor(async () => {
      const report = await getJson(`${origin}/api/usage`);
      const row = report.agents.find((entry) => entry.agentId === lead.id);
      return row.usage.totalTokens > billedBeforeChat ? report : null;
    }, 'the chat turn to be billed');

    check('a chat turn bills the worker but not the mission', () => {
      const leadRow = afterChat.agents.find((entry) => entry.agentId === lead.id);
      assert.ok(leadRow.usage.totalTokens > billedBeforeChat);
      const missionRow = afterChat.missions.find((entry) => entry.taskId === mission.id);
      assert.equal(missionRow.usage.totalTokens, missionTask.usage.totalTokens);
    });

    const history = await getJson(`${origin}/api/usage/history`);
    check('the history endpoint lists the finished mission under its day', () => {
      assert.ok(history.days.length >= 1, 'at least one day');
      const row = history.missions.find((entry) => entry.taskId === mission.id);
      assert.ok(row, 'the finished mission is in the history');
      assert.equal(row.usage.totalTokens, missionTask.usage.totalTokens);
      assert.ok(
        history.days.some((day) => day.missions.some((entry) => entry.taskId === mission.id)),
        'the mission sits in a day bucket',
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
    await fs.rm(sandbox, { recursive: true, force: true });
    if (results.some((entry) => !entry.ok)) {
      console.log(`\n[server log]\n${serverLog.join('').split('\n').slice(-25).join('\n')}`);
    }
  }
}

try {
  await liveServerChecks();
} catch (error) {
  console.log(`  ✗ the live server could not be driven: ${error instanceof Error ? error.message : error}`);
  results.push({ label: 'live server', ok: false, error });
}


/**
 * A model that answers one round trip and finishes the task. Used to prove the
 * activity log carries the round's own bill and that those steps add up to the
 * total the meter reports.
 */
function startMockModel() {
  const server = http.createServer((request, response) => {
    if (request.method === 'GET' && request.url?.startsWith('/v1/models')) {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ data: [{ id: 'mock-step-model' }] }));
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
      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      const send = (payload) => response.write(`data: ${JSON.stringify(payload)}\n\n`);
      send({ choices: [{ delta: { content: 'Finishing now.' } }] });
      send({
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_1',
                  type: 'function',
                  function: { name: 'complete_task', arguments: JSON.stringify({ summary: 'Done by the mock model.' }) },
                },
              ],
            },
          },
        ],
      });
      send({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
      send({ usage: { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140 } });
      response.write('data: [DONE]\n\n');
      response.end();
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

async function stepLoggingChecks() {
  console.log('\n[meter] per-step log');
  const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'aegisx-steps-'));
  const workspace = path.join(sandbox, 'workspace');
  await fs.mkdir(workspace, { recursive: true });

  const model = await startMockModel();
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
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
        OFFICE_MODEL: 'mock-step-model',
        OFFICE_WORKSPACE: workspace,
        OFFICE_STATE_DIR: path.join(sandbox, 'state'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  try {
    const snapshot = await waitFor(async () => {
      const response = await fetch(`${origin}/api/session`);
      if (!response.ok) return null;
      const body = await response.json();
      return body.settings.configured ? body : null;
    }, 'the server to connect');

    const lead = snapshot.agents.find((agent) => agent.role === 'Tech Lead');
    const created = await getJson(`${origin}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Cost one step', detail: 'Finish in one round.', assigneeId: lead.id }),
    });

    const finished = await waitFor(async () => {
      const tasks = await getJson(`${origin}/api/tasks`);
      return tasks.find((entry) => entry.id === created.id && entry.status === 'done');
    }, 'the mocked task to finish');

    const session = await getJson(`${origin}/api/session`);
    const steps = session.logs.filter((entry) => entry.kind === 'agent.step');

    check('the activity log carries the token bill of each model step', () => {
      assert.equal(steps.length, 1, 'one model round trip, one step line');
      assert.equal(steps[0].tokens.totalTokens, 140);
      assert.equal(steps[0].tokens.promptTokens, 100);
      assert.equal(steps[0].tokens.completionTokens, 40);
      assert.equal(steps[0].tokens.turns, 1);
      assert.equal(steps[0].agentId, lead.id);
      assert.match(steps[0].message, /step 1/);
    });

    check('the step line is logged before the action it caused', () => {
      const stepIndex = session.logs.findIndex((entry) => entry.kind === 'agent.step');
      const actionIndex = session.logs.findIndex((entry) => entry.kind === 'agent.action');
      assert.ok(stepIndex >= 0 && actionIndex > stepIndex, 'step precedes the action line');
    });

    check('the step bills add up to what the meter reports for the task', () => {
      const stepTotal = steps.reduce((sum, entry) => sum + entry.tokens.totalTokens, 0);
      assert.equal(stepTotal, finished.usage.totalTokens);
      assert.equal(finished.usage.totalTokens, 140);
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
    await fs.rm(sandbox, { recursive: true, force: true });
  }
}

try {
  await stepLoggingChecks();
} catch (error) {
  console.log(`  ✗ the step-log scenario could not run: ${error instanceof Error ? error.message : error}`);
  results.push({ label: 'per-step log', ok: false });
}

const passed = results.filter((entry) => entry.ok).length;
console.log(`\n[meter] ${passed}/${results.length} checks passed`);
process.exit(passed === results.length ? 0 : 1);
