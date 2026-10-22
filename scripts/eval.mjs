/**
 * Eval harness: eleven missions, measured the same way every time.
 *
 * For each task the harness builds a throwaway folder from the fixture, runs a
 * real office server against it, and lets one named worker do the job. It then
 * stops trusting the office: the task's `accept` check decides pass or fail by
 * reading and running the artefacts itself.
 *
 * What it records per task — pass/fail with the reason, wall time from handing
 * the task over to the board showing it finished, tokens the server attributed
 * to it, and the cost those tokens imply. The report is a file, so two runs can
 * be compared with `--baseline`.
 *
 *   npm run eval                     # real model, from OFFICE_ENDPOINT/API_KEY
 *   npm run eval -- --baseline <f>   # compare against an earlier report
 *   npm run check:eval               # scripted model, tests the harness itself
 */
import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { DEFAULT_ENDPOINT, DEFAULT_MODEL } from '../server/src/config.ts';
import { EVAL_TASKS } from '../evals/tasks.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const DOT_ENV_PATH = path.join(REPO_ROOT, '.env');

/**
 * USD per million tokens. An eval cannot know what an endpoint charges, so the
 * rate is an explicit input rather than a hidden guess, and every report stores
 * the rate it used. Tokens are the measured number; dollars are derived.
 */
const DEFAULT_PRICE = { inputPerMillion: 0.15, outputPerMillion: 0.6 };
const TERMINAL_STATUSES = new Set(['done', 'blocked']);
const SKIP_WALK = new Set(['node_modules', '.git', '.agent-office', 'dist']);

/**
 * The launcher hands the server its `.env` (`--env-file`); the harness reads
 * the same file, so `npm run eval` finds the key the app already uses instead
 * of demanding it be exported again. Values already in the environment win,
 * which is what makes `OFFICE_MODEL=... npm run eval` behave as expected.
 */
export function loadEnvFile(envFilePath = DOT_ENV_PATH) {
  if (!existsSync(envFilePath)) return false;
  try {
    process.loadEnvFile(envFilePath);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[eval] could not read ${envFilePath}: ${message} — using the current environment.`);
    return false;
  }
}

// ── small filesystem / process helpers ──────────────────────────────────────

/** Runs a command and reports its exit code plus combined output, never throws. */
function runCommand(command, args, cwd) {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      { cwd, timeout: 120_000, maxBuffer: 8 * 1024 * 1024, env: process.env },
      (error, stdout, stderr) => {
        const code = error ? (typeof error.code === 'number' ? error.code : -1) : 0;
        resolve({ code, output: `${stdout}${stderr}` });
      },
    );
  });
}

async function listFiles(root, relative = '') {
  const directory = path.join(root, relative);
  const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
  const found = [];
  for (const entry of entries) {
    if (SKIP_WALK.has(entry.name)) continue;
    const next = relative.length > 0 ? path.join(relative, entry.name) : entry.name;
    if (entry.isDirectory()) {
      found.push(...(await listFiles(root, next)));
    } else if (entry.isFile()) {
      found.push(next);
    }
  }
  return found;
}

/**
 * The helpers an acceptance check gets. Everything is relative to one folder,
 * so a check can copy the work and break it without touching the original.
 */
function bind(root) {
  const context = {
    root,
    read: (relative) => fs.readFile(path.join(root, relative), 'utf8'),
    write: async (relative, content) => {
      const target = path.join(root, relative);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, content, 'utf8');
    },
    exists: (relative) =>
      fs
        .access(path.join(root, relative))
        .then(() => true)
        .catch(() => false),
    walk: () => listFiles(root),
    run: (command, args = []) => runCommand(command, args, root),
    // Cache-busted: a check may import a module the mission rewrote, and the
    // same specifier must not resolve to a version Node already parsed.
    probe: (relative) =>
      import(`${pathToFileURL(path.join(root, relative)).href}?eval=${Date.now()}`),
  };
  context.copy = async () => {
    const target = await fs.mkdtemp(path.join(path.dirname(root), 'copy-'));
    await fs.cp(root, target, {
      recursive: true,
      filter: (source) => !SKIP_WALK.has(path.basename(source)),
    });
    return bind(target);
  };
  return context;
}

// ── the scripted model (mock mode only) ─────────────────────────────────────

/**
 * Replays each task's `mock` plan. The plan is indexed by round, and a round is
 * counted from the tool messages the server sends back, so the model can be
 * stateless while the conversation carries the progress.
 *
 * Two things make delegation work here. Plans are keyed by task *title*, which
 * also covers the titles a mission hands out, and the lead's second pass is
 * detected from the reconciliation brief rather than from a round counter — the
 * pass restarts the conversation, so only the brief tells them apart.
 */
function startMockModel(suite) {
  const plans = new Map();
  for (const task of suite) {
    plans.set(task.title, { main: task.mock ?? [], synthesis: task.synthesisMock ?? null });
    for (const [title, plan] of Object.entries(task.subtaskMock ?? {})) {
      plans.set(title, { main: plan, synthesis: null });
    }
  }
  let callId = 0;
  /** How many times a step has failed on purpose, so `times` can be honoured. */
  const failures = new Map();
  const server = http.createServer((request, response) => {
    if (request.method === 'GET' && request.url?.startsWith('/v1/models')) {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ data: [{ id: 'mock-eval-model' }] }));
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
      const userMessages = messages.filter((entry) => entry.role === 'user');
      // The brief is the first user message; the nudge is a later one, added
      // mid-turn, so the two markers have to be read from different places.
      const user = String(userMessages[0]?.content ?? '');
      const latestUser = String(userMessages[userMessages.length - 1]?.content ?? '');
      const title = /^Task: (.+)$/m.exec(user)?.[1]?.trim() ?? '';
      // A nudge adds a user message without a tool result, so the round has to
      // count it too — otherwise the nudged model replays the same silent step.
      const nudged = /You stopped without finishing/.test(latestUser);
      const round = messages.filter((entry) => entry.role === 'tool').length + (nudged ? 1 : 0);
      const plan = plans.get(title);
      const steps = (/This is pass 2/.test(user) ? (plan?.synthesis ?? plan?.main) : plan?.main) ?? [];
      let step = steps[round];

      if (step?.http) {
        const key = `${title}:${round}`;
        const failed = failures.get(key) ?? 0;
        if (failed < (step.times ?? Number.POSITIVE_INFINITY)) {
          failures.set(key, failed + 1);
          response.writeHead(step.http, { 'Content-Type': 'application/json' });
          response.end(JSON.stringify({ error: { message: `upstream error ${step.http}` } }));
          return;
        }
        step = step.then;
      }

      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      const send = (payload) => response.write(`data: ${JSON.stringify(payload)}\n\n`);

      if (step && step.tool === null) {
        // An explicit stop: the lead handing off and waiting, not finishing.
        send({ choices: [{ delta: { content: step.content ?? 'Waiting on the team.' } }] });
        send({ choices: [{ delta: {}, finish_reason: 'stop' }] });
      } else {
        const call = step ?? {
          tool: 'complete_task',
          args: { summary: 'Done.' },
        };
        callId += 1;
        send({ choices: [{ delta: { content: 'Working.' } }] });
        send({
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: `call_${callId}`,
                    type: 'function',
                    function: { name: call.tool, arguments: JSON.stringify(call.args) },
                  },
                ],
              },
            },
          ],
        });
        send({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
      }
      // Fixed per-round spend, so cost grows with the number of rounds and the
      // harness's token accounting is checkable against the script.
      send({ usage: { prompt_tokens: 900, completion_tokens: 120, total_tokens: 1020 } });
      response.write('data: [DONE]\n\n');
      response.end();
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

// ── talking to the office ───────────────────────────────────────────────────

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
  if (!response.ok) throw new Error(`${init?.method ?? 'GET'} ${url} → ${response.status}`);
  return response.json();
}

async function waitFor(predicate, label, timeoutMs) {
  const started = Date.now();
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}

/** Usage of one task plus everything it delegated to. */
function rolledUsage(task, tasks) {
  const total = { promptTokens: 0, completionTokens: 0, totalTokens: 0, turns: 0 };
  const queue = [task];
  const seen = new Set();
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || seen.has(current.id)) continue;
    seen.add(current.id);
    total.promptTokens += current.usage?.promptTokens ?? 0;
    total.completionTokens += current.usage?.completionTokens ?? 0;
    total.totalTokens += current.usage?.totalTokens ?? 0;
    total.turns += current.usage?.turns ?? 0;
    for (const child of tasks) {
      if (child.parentId === current.id) queue.push(child);
    }
  }
  return total;
}

/**
 * Refuses to run a mission when the office is pointed somewhere else. An eval
 * that writes into the caller's own project would be worse than no eval, so
 * this is checked before the first task exists.
 */
export function assertEvalWorkspace(session, expected) {
  const actual = session?.settings?.workspaceRoot;
  if (actual !== expected) {
    throw new Error(`the office is working in ${actual ?? 'an unknown folder'}, not the eval folder ${expected}`);
  }
}

function costOf(usage, price) {
  return (
    (usage.promptTokens / 1_000_000) * price.inputPerMillion +
    (usage.completionTokens / 1_000_000) * price.outputPerMillion
  );
}

// ── one task ────────────────────────────────────────────────────────────────

async function runOneTask(task, options) {
  const { sandbox, model, endpoint, apiKey, price } = options;
  const workspace = path.join(sandbox, task.id, 'workspace');
  const stateDir = path.join(sandbox, task.id, 'state');
  await fs.mkdir(workspace, { recursive: true });
  for (const [relative, content] of Object.entries(task.files ?? {})) {
    const target = path.join(workspace, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content, 'utf8');
  }

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
        OFFICE_ENDPOINT: endpoint,
        OFFICE_API_KEY: apiKey,
        OFFICE_MODEL: model,
        OFFICE_DEMO: '0',
        OFFICE_TOOLS: '1',
        OFFICE_WEB: '0',
        OFFICE_GIT: '0',
        OFFICE_VERIFY: '1',
        OFFICE_WORKSPACE: workspace,
        OFFICE_STATE_DIR: stateDir,
        ...task.env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const serverLog = [];
  server.stdout.on('data', (chunk) => serverLog.push(chunk.toString()));
  server.stderr.on('data', (chunk) => serverLog.push(chunk.toString()));

  const stopServer = async () => {
    if (server.exitCode !== null) return;
    server.kill('SIGTERM');
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 3000);
      server.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    if (server.exitCode === null) server.kill('SIGKILL');
  };

  const result = {
    id: task.id,
    title: task.title,
    role: task.role,
    passed: false,
    status: 'not-started',
    reason: '',
    durationMs: 0,
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, turns: 0 },
    costUsd: 0,
    reopens: 0,
    reverts: 0,
    retries: 0,
    nudges: 0,
    evidenceNudges: 0,
  };

  try {
    const session = await waitFor(
      async () => {
        try {
          const response = await fetch(`${origin}/api/session`);
          if (!response.ok) return null;
          const body = await response.json();
          return body.settings.configured ? body : null;
        } catch {
          return null;
        }
      },
      `${task.id}: the office to boot`,
      options.bootTimeoutMs,
    );

    assertEvalWorkspace(session, workspace);

    const agent =
      session.agents.find((entry) => entry.role === task.role) ??
      session.agents.find((entry) => entry.role !== 'Tech Lead') ??
      session.agents[0];
    if (!agent) throw new Error('the office has no workers to assign the task to');

    const startedAt = Date.now();
    // A mission goes through its own endpoint: that is what marks it for a
    // reconciliation pass once the last subtask settles.
    const created = await getJson(`${origin}${task.mission ? '/api/missions' : '/api/tasks'}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(
        task.mission
          ? { title: task.title, detail: task.detail, priority: 'medium', leadId: agent.id }
          : { title: task.title, detail: task.detail, assigneeId: agent.id },
      ),
    });

    const deadline = startedAt + (options.taskTimeoutMs ?? task.timeoutMs ?? 240_000);
    let board = null;
    for (;;) {
      const tasks = await getJson(`${origin}/api/tasks`);
      board = tasks.find((entry) => entry.id === created.id) ?? null;
      if (board && TERMINAL_STATUSES.has(board.status)) break;
      if (Date.now() > deadline) {
        result.status = board?.status ?? 'missing';
        result.reason = `timed out after ${Math.round((Date.now() - startedAt) / 1000)}s`;
        result.durationMs = Date.now() - startedAt;
        return result;
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    result.durationMs = Date.now() - startedAt;
    result.status = board.status;

    // Let the post-completion writes (memory, snapshot, change report) land
    // before the folder is read, without counting them as mission time.
    await new Promise((resolve) => setTimeout(resolve, 800));

    const tasks = await getJson(`${origin}/api/tasks`);
    const finalTask = tasks.find((entry) => entry.id === created.id) ?? board;
    result.usage = rolledUsage(finalTask, tasks);
    result.costUsd = costOf(result.usage, price);

    const after = await getJson(`${origin}/api/session`);
    result.reopens = after.logs.filter((entry) => entry.kind === 'task.reopened').length;
    result.reverts = after.logs.filter((entry) => entry.kind === 'task.reverted').length;
    result.retries = after.logs.filter((entry) => entry.kind === 'model.retry').length;
    result.nudges = after.logs.filter((entry) => entry.kind === 'task.nudged').length;
    result.evidenceNudges = after.logs.filter((entry) => entry.kind === 'task.evidence').length;

    // A task may legitimately end blocked and still be the property under test
    // (spend recorded for a failed turn, a budget stopping the run).
    const accepted = task.acceptStatuses ?? ['done'];
    if (!accepted.includes(finalTask.status)) {
      result.reason = `the task ended ${finalTask.status}, expected ${accepted.join(' or ')}`;
      return result;
    }

    try {
      await task.accept({
        ...bind(workspace),
        files: task.files ?? {},
        board: { task: finalTask, tasks, agents: session.agents },
        usage: { own: finalTask.usage, rolled: result.usage },
      });
      result.passed = true;
      result.reason = 'acceptance passed';
    } catch (error) {
      result.reason = error instanceof Error ? error.message : String(error);
    }
    return result;
  } catch (error) {
    result.reason = error instanceof Error ? error.message : String(error);
    if (serverLog.length > 0 && result.reason.includes('timed out')) {
      result.reason += ` — server said: ${serverLog.join('').split('\n').slice(-3).join(' ').trim()}`;
    }
    return result;
  } finally {
    await stopServer();
  }
}

// ── the run ─────────────────────────────────────────────────────────────────

function priceFromEnvironment(overrides = {}) {
  const read = (value, fallback) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
  };
  const fromEnvIn = process.env.EVAL_PRICE_IN;
  const fromEnvOut = process.env.EVAL_PRICE_OUT;
  const source =
    overrides.inputPerMillion !== undefined || overrides.outputPerMillion !== undefined
      ? 'flag'
      : fromEnvIn !== undefined || fromEnvOut !== undefined
        ? 'env'
        : 'default';
  return {
    inputPerMillion: read(overrides.inputPerMillion ?? fromEnvIn, DEFAULT_PRICE.inputPerMillion),
    outputPerMillion: read(overrides.outputPerMillion ?? fromEnvOut, DEFAULT_PRICE.outputPerMillion),
    source,
  };
}

/**
 * Runs the suite and returns the report. Exported so the harness's own check
 * can assert on the numbers instead of re-parsing its stdout.
 */
export async function runEval(options = {}) {
  const mode = options.mode ?? 'live';
  const suite = options.tasks ?? EVAL_TASKS;
  const price = options.price ?? priceFromEnvironment(options.priceOverrides);
  if (mode === 'live') loadEnvFile();

  let model = options.model ?? process.env.OFFICE_MODEL ?? DEFAULT_MODEL;
  let endpoint = options.endpoint ?? process.env.OFFICE_ENDPOINT ?? DEFAULT_ENDPOINT;
  let apiKey = options.apiKey ?? process.env.OFFICE_API_KEY ?? '';
  let mock = null;

  if (mode === 'mock') {
    mock = await startMockModel(suite);
    endpoint = `http://127.0.0.1:${mock.address().port}/v1`;
    apiKey = 'mock-key';
    model = 'mock-eval-model';
  } else if (apiKey.trim().length === 0) {
    throw new Error(
      'No API key. Set OFFICE_API_KEY, or put it in .env (see .env.example), or run this with --mock to test the harness itself.',
    );
  }

  const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'aegisx-eval-'));
  const startedAt = new Date();
  const results = [];
  try {
    for (const task of suite) {
      const result = await runOneTask(task, {
        sandbox,
        model,
        endpoint,
        apiKey,
        price,
        bootTimeoutMs: options.bootTimeoutMs ?? 30_000,
        taskTimeoutMs: options.taskTimeoutMs,
      });
      results.push(result);
      if (options.onTask) options.onTask(result);
    }
  } finally {
    await fs.rm(sandbox, { recursive: true, force: true });
    if (mock) await new Promise((resolve) => mock.close(resolve));
  }

  const finishedAt = new Date();
  const totals = results.reduce(
    (sum, entry) => ({
      tasks: sum.tasks + 1,
      passed: sum.passed + (entry.passed ? 1 : 0),
      promptTokens: sum.promptTokens + entry.usage.promptTokens,
      completionTokens: sum.completionTokens + entry.usage.completionTokens,
      totalTokens: sum.totalTokens + entry.usage.totalTokens,
      costUsd: sum.costUsd + entry.costUsd,
      durationMs: sum.durationMs + entry.durationMs,
    }),
    {
      tasks: 0,
      passed: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      costUsd: 0,
      durationMs: 0,
    },
  );

  return {
    version: 1,
    mode,
    model,
    endpoint,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    wallMs: finishedAt.getTime() - startedAt.getTime(),
    price,
    totals: {
      ...totals,
      failed: totals.tasks - totals.passed,
      passRate: totals.tasks > 0 ? totals.passed / totals.tasks : 0,
    },
    tasks: results,
  };
}

// ── reporting ───────────────────────────────────────────────────────────────

function pad(value, width) {
  return String(value).padEnd(width);
}

function seconds(ms) {
  return `${(ms / 1000).toFixed(1)}s`;
}

function money(usd) {
  return `$${usd.toFixed(4)}`;
}

/** A delta that is not a real change prints without a sign or a fake digit. */
function deltaTime(ms) {
  return Math.abs(ms) < 50 ? '0.0s' : `${ms > 0 ? '+' : ''}${seconds(ms)}`;
}

function deltaMoney(usd) {
  return Math.abs(usd) < 0.00005 ? '$0.0000' : `${usd > 0 ? '+' : ''}${money(usd)}`;
}

function printTable(report) {
  const width = Math.max(...report.tasks.map((entry) => entry.id.length), 4);
  console.log(`\n${pad('task', width)}  result  time    tokens   cost      notes`);
  console.log('-'.repeat(width + 60));
  for (const entry of report.tasks) {
    // An accepted task that legitimately ended blocked keeps its real status in
    // the column, so "pass" can never hide a stopped mission.
    const verdict = entry.passed ? (entry.status === 'done' ? 'pass' : entry.status) : 'FAIL';
    const note = entry.reason.length > 60 ? `${entry.reason.slice(0, 57)}...` : entry.reason;
    console.log(
      `${pad(entry.id, width)}  ${pad(verdict, 6)}  ${pad(seconds(entry.durationMs), 6)}  ${pad(
        entry.usage.totalTokens,
        7,
      )}  ${pad(money(entry.costUsd), 9)} ${note}`,
    );
  }
  const { totals, price } = report;
  console.log(
    `\n${totals.passed}/${totals.tasks} passed (${Math.round(totals.passRate * 100)}%) · ` +
      `${seconds(totals.durationMs)} of model time · ${totals.totalTokens} tokens · ${money(totals.costUsd)}`,
  );
  console.log(
    `Cost rate: $${price.inputPerMillion}/M in, $${price.outputPerMillion}/M out (${price.source}).`,
  );
}

function printComparison(report, baseline) {
  console.log(`\nAgainst ${baseline.startedAt} (${baseline.mode}, ${baseline.model}):`);
  const previous = new Map(baseline.tasks.map((entry) => [entry.id, entry]));
  for (const entry of report.tasks) {
    const before = previous.get(entry.id);
    if (!before) {
      console.log(`  ${pad(entry.id, 18)} new`);
      continue;
    }
    const verdict =
      before.passed === entry.passed ? 'same' : entry.passed ? 'FIXED' : 'BROKEN';
    console.log(
      `  ${pad(entry.id, 18)} ${pad(verdict, 7)} ${pad(
        deltaTime(entry.durationMs - before.durationMs),
        9,
      )} ${deltaMoney(entry.costUsd - before.costUsd)}`,
    );
  }
  const { totals } = report;
  const before = baseline.totals;
  const deltaPass = totals.passed - before.passed;
  const deltaRate = (totals.passRate - before.passRate) * 100;
  const totalCostDelta = totals.costUsd - before.costUsd;
  const totalTimeDelta = totals.durationMs - before.durationMs;
  console.log(
    `\n  pass rate ${before.passed}/${before.tasks} → ${totals.passed}/${totals.tasks} ` +
      `(${deltaPass >= 0 ? '+' : ''}${deltaPass}, ${deltaRate >= 0 ? '+' : ''}${deltaRate.toFixed(0)} pts)`,
  );
  console.log(
    `  cost ${money(before.costUsd)} → ${money(totals.costUsd)} (${totalCostDelta >= 0 ? '+' : ''}${money(totalCostDelta)})` +
      ` · time ${seconds(before.durationMs)} → ${seconds(totals.durationMs)} (${totalTimeDelta >= 0 ? '+' : ''}${seconds(totalTimeDelta)})`,
  );
}

async function writeReport(report, target) {
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}

// ── CLI ─────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const options = { mode: 'live' };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const next = () => argv[index + 1] ?? '';
    switch (flag) {
      case '--mock':
        options.mode = 'mock';
        break;
      case '--out':
        options.out = next();
        index += 1;
        break;
      case '--baseline':
        options.baseline = next();
        index += 1;
        break;
      case '--only':
        options.only = next()
          .split(',')
          .map((entry) => entry.trim())
          .filter(Boolean);
        index += 1;
        break;
      case '--price-in':
        options.priceIn = Number(next());
        index += 1;
        break;
      case '--price-out':
        options.priceOut = Number(next());
        index += 1;
        break;
      case '--min-pass-rate':
        options.minPassRate = Number(next());
        index += 1;
        break;
      case '--task-timeout':
        options.taskTimeoutMs = Number(next());
        index += 1;
        break;
      default:
        if (flag.startsWith('--')) throw new Error(`Unknown flag: ${flag}`);
    }
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  let suite = EVAL_TASKS;
  if (options.only && options.only.length > 0) {
    const wanted = new Set(options.only);
    suite = EVAL_TASKS.filter((task) => wanted.has(task.id));
    if (suite.length === 0) throw new Error(`No task matched ${options.only.join(', ')}`);
  }

  const report = await runEval({
    mode: options.mode,
    tasks: suite,
    taskTimeoutMs: Number.isFinite(options.taskTimeoutMs) ? options.taskTimeoutMs : undefined,
    priceOverrides: {
      inputPerMillion: Number.isFinite(options.priceIn) ? options.priceIn : undefined,
      outputPerMillion: Number.isFinite(options.priceOut) ? options.priceOut : undefined,
    },
    onTask: (result) => {
      console.log(`  ${result.passed ? '✓' : '✗'} ${result.id} ${seconds(result.durationMs)}`);
    },
  });

  printTable(report);
  if (options.baseline) {
    const raw = await fs.readFile(options.baseline, 'utf8');
    printComparison(report, JSON.parse(raw));
  }

  const stamp = report.startedAt.replace(/[:.]/g, '-');
  const target =
    options.out ??
    path.join(REPO_ROOT, '.agent-office', 'evals', `${report.mode}-${stamp}.json`);
  await writeReport(report, target);
  console.log(`\nReport: ${target}`);

  if (options.minPassRate !== undefined && report.totals.passRate < options.minPassRate) {
    console.log(
      `\nBelow the required pass rate: ${Math.round(report.totals.passRate * 100)}% < ${Math.round(
        options.minPassRate * 100,
      )}%.`,
    );
    process.exitCode = 1;
  }
  // In mock mode a failure means the harness is broken, not that a model was
  // weak, so it is an error. Live runs report their numbers and exit clean.
  if (report.mode === 'mock' && report.totals.failed > 0) process.exitCode = 1;
}

const entryPoint = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (import.meta.url === entryPoint) {
  main().catch((error) => {
    console.error(`eval failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
