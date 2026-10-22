/**
 * The independent reviewer: a verdict that can be refused, and a parser that
 * never turns an unreadable reply into a pass.
 *
 *   node --experimental-strip-types scripts/review-check.mjs
 */
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';
import { buildReviewMessages, parseReview, reviewWork } from '../server/src/reviewer.ts';

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

console.log('\n[review] the contract');

await check('a plain verdict is read as written', async () => {
  const verdict = parseReview('{"verdict":"pass","reasons":[]}');
  assert.deepEqual(verdict, { verdict: 'pass', reasons: [] });
});

await check('a fenced or chatty reply still yields the object', async () => {
  const verdict = parseReview('Here is my review:\n```json\n{"verdict":"fail","reasons":["the test was deleted"]}\n```');
  assert.equal(verdict.verdict, 'fail');
  assert.deepEqual(verdict.reasons, ['the test was deleted']);
});

await check('an unreadable reply is never an implicit pass', async () => {
  assert.equal(parseReview('Looks good to me!'), null);
  assert.equal(parseReview('{"verdict":"maybe"}'), null);
  assert.equal(parseReview('{"verdict":"fail","reasons":[]}'), null, 'a refusal with no reason is unusable');
  assert.equal(parseReview('{"verdict":"fail","reasons":[42]}'), null);
  assert.equal(parseReview('{not json}'), null);
});

await check('reasons are trimmed and capped', async () => {
  const reasons = Array.from({ length: 9 }, (_, index) => `  reason ${index}  `);
  const verdict = parseReview(JSON.stringify({ verdict: 'fail', reasons }));
  assert.equal(verdict.reasons.length, 5);
  assert.equal(verdict.reasons[0], 'reason 0');

  const long = parseReview(JSON.stringify({ verdict: 'fail', reasons: ['x'.repeat(900)] }));
  assert.ok(long.reasons[0].length <= 300, `reason was ${long.reasons[0].length} chars`);
});

await check('the prompt carries the task and the diff, and truncates a huge diff', async () => {
  const diff = `diff --git a/app.ts b/app.ts\n${'@@ -1 +1 @@\n-a\n+b\n'.repeat(2_000)}`;
  const messages = buildReviewMessages({
    taskTitle: 'Ship the client',
    taskDetail: 'Use the API the backend wrote.',
    agentName: 'Aria',
    checks: ['typecheck', 'test'],
    diff,
  });
  const user = messages.find((message) => message.role === 'user').content;
  assert.match(user, /Ship the client/);
  assert.match(user, /typecheck, test/);
  assert.ok(user.length < 8_000, `prompt grew to ${user.length} chars`);
  const system = messages.find((message) => message.role === 'system').content;
  assert.match(system, /independent reviewer/);
});

await check('the reviewer is told the bar the worker was held to', () => {
  const messages = buildReviewMessages({
    taskTitle: 'Fix the cart total',
    taskDetail: 'The suite must pass and the test must stay unedited.',
    agentName: 'Citra',
    role: 'QA Engineer',
    checks: ['node --test'],
    diff: 'diff --git a/src/cart.mjs b/src/cart.mjs\n+total += item.price * item.quantity;\n',
  });
  const system = messages.find((message) => message.role === 'system').content;
  assert.match(system, /Judge this as a QA Engineer/);
  assert.match(system, /deleted, skipped or loosened test/, 'the QA refusal rule is missing');
  const explicit = buildReviewMessages({
    taskTitle: 'Index the orders table',
    taskDetail: 'Add the index and prove the row count matches.',
    agentName: 'Dimas',
    role: 'Tech Lead',
    pack: 'data',
    checks: [],
    diff: 'diff --git a/migrations/001.sql b/migrations/001.sql\n+CREATE INDEX orders_created_at_idx ON orders (created_at);\n',
  });
  assert.match(
    explicit.find((message) => message.role === 'system').content,
    /Judge this as a Data Engineer/,
    'the pack the task ran under was ignored by the reviewer',
  );
});

console.log('\n[review] one real call');

await check('a refusal comes back with its reasons and usage', async () => {
  const server = http.createServer((request, response) => {
    let raw = '';
    request.on('data', (chunk) => {
      raw += chunk;
    });
    request.on('end', () => {
      const body = JSON.parse(raw || '{}');
      assert.equal(body.model, 'mock-review-model');
      assert.ok(Array.isArray(body.messages));
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(
        JSON.stringify({
          choices: [
            {
              message: {
                content: '{"verdict":"fail","reasons":["the error path still throws at runtime"]}',
              },
            },
          ],
          usage: { prompt_tokens: 120, completion_tokens: 12, total_tokens: 132 },
        }),
      );
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    const verdict = await reviewWork(
      { endpoint: `http://127.0.0.1:${port}/v1`, apiKey: 'test-key', model: 'mock-review-model' },
      {
        taskTitle: 'Fix the retry',
        taskDetail: 'A failed request must retry once.',
        agentName: 'Aria',
        checks: ['test'],
        diff: '--- a/client.ts\n+++ b/client.ts\n@@ -1 +1 @@\n-return send();\n+return send();',
      },
    );
    assert.equal(verdict.verdict, 'fail');
    assert.deepEqual(verdict.reasons, ['the error path still throws at runtime']);
    assert.equal(verdict.usage.totalTokens, 132);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});


// ── the runtime gate ────────────────────────────────────────────────────────

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

async function waitFor(predicate, label, timeoutMs = 25_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate().catch(() => null);
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

/**
 * A worker that writes one file, claims done, and a reviewer that refuses the
 * first claim and accepts the second. This is the smallest mission that can
 * prove the reviewer is actually wired into the completion path.
 */
function startMockOffice(state, mode = 'recover') {
  const server = http.createServer((request, response) => {
    if (request.method === 'GET' && request.url?.startsWith('/v1/models')) {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ data: [{ id: 'mock-review-office' }] }));
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
      const system = String(messages.find((entry) => entry.role === 'system')?.content ?? '');

      if (system.startsWith('You are the independent reviewer')) {
        state.reviews += 1;
        const verdict =
          mode === 'persistent' || state.reviews === 1
            ? { verdict: 'fail', reasons: ['the page has no heading text the task asked for'] }
            : { verdict: 'pass', reasons: [] };
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(
          JSON.stringify({
            choices: [{ message: { content: JSON.stringify(verdict) } }],
            usage: { prompt_tokens: 80, completion_tokens: 10, total_tokens: 90 },
          }),
        );
        return;
      }

      const sawToolResult = messages.some((entry) => entry.role === 'tool');
      const toolCall = sawToolResult
        ? {
            id: `call_${state.workerCalls}`,
            type: 'function',
            function: { name: 'complete_task', arguments: JSON.stringify({ summary: 'Wrote the page.' }) },
          }
        : {
            id: `call_${state.workerCalls}`,
            type: 'function',
            function: {
              name: 'write_file',
              arguments: JSON.stringify({ path: 'page.html', content: '<!doctype html><title>ok</title>\n' }),
            },
          };
      state.workerCalls += 1;

      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      const send = (payload) => response.write(`data: ${JSON.stringify(payload)}\n\n`);
      send({ choices: [{ delta: { content: 'Working.' } }] });
      send({ choices: [{ delta: { tool_calls: [{ index: 0, ...toolCall }] } }] });
      send({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
      send({ usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } });
      response.write('data: [DONE]\n\n');
      response.end();
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

const runGit = promisify(execFile);

/**
 * An operator repository: committed history, nothing the office may commit to.
 * It has no checkpoint on purpose — that is the case where the reviewer used to
 * return early and approve everything.
 */
async function makeRepository(workspace) {
  await runGit('git', ['-C', workspace, 'init', '-q']);
  await fs.writeFile(path.join(workspace, 'NOTES.md'), '# Project\n');
  await runGit('git', ['-C', workspace, 'add', 'NOTES.md']);
  await runGit('git', [
    '-C',
    workspace,
    '-c',
    'user.name=Operator',
    '-c',
    'user.email=operator@localhost',
    'commit',
    '-q',
    '-m',
    'initial',
  ]);
}

async function runtimeChecks(mode = 'recover') {
  console.log(`\n[review] inside the completion gate (${mode})`);
  const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'aegisx-review-'));
  const workspace = path.join(sandbox, 'workspace');
  await fs.mkdir(workspace, { recursive: true });
  if (mode === 'repo') await makeRepository(workspace);

  const state = { reviews: 0, workerCalls: 0 };
  const model = await startMockOffice(state, mode);
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
        OFFICE_MODEL: 'mock-review-office',
        OFFICE_WORKSPACE: workspace,
        OFFICE_STATE_DIR: path.join(sandbox, 'state'),
        OFFICE_TOOLS: '1',
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
    await fetch(`${origin}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title:
          mode === 'persistent'
            ? 'Write a stubborn page'
            : mode === 'repo'
              ? 'Write a page in a repo'
              : 'Write a tiny page',
        detail: 'One page with a heading.',
        assigneeId: lead.id,
      }),
    });

    const task = await waitFor(async () => {
      const response = await fetch(`${origin}/api/session`);
      const body = await response.json();
      const title =
        mode === 'persistent'
          ? 'Write a stubborn page'
          : mode === 'repo'
            ? 'Write a page in a repo'
            : 'Write a tiny page';
      const found = body.tasks.find((entry) => entry.title === title);
      return found && found.status === 'done' ? found : null;
    }, 'the task to finish after the reviewer accepts');

    if (mode === 'persistent') {
      assert.equal(state.reviews, 4, `three refusals then one acceptance, saw ${state.reviews}`);
      const refusals = task.notes.filter((note) => note.includes('Reviewer refused'));
      assert.ok(refusals.length >= 3, `each refusal must be recorded: ${JSON.stringify(task.notes)}`);
    } else {
      assert.equal(state.reviews, 2, `the reviewer should run twice, saw ${state.reviews}`);
      assert.ok(
        task.notes.some((note) => note.includes('Reviewer refused')),
        `the refusal must be recorded on the task: ${JSON.stringify(task.notes)}`,
      );
    }
    assert.ok(
      task.notes.some((note) => note.includes('Wrote the page.')),
      'the accepted summary still lands on the task',
    );
    const page = await fs.readFile(path.join(workspace, 'page.html'), 'utf8');
    assert.match(page, /<title>ok<\/title>/);
    if (mode === 'repo') {
      assert.ok(
        task.notes.some((note) => note.includes('Reviewer refused')),
        `the reviewer must run on a repository too: ${JSON.stringify(task.notes)}`,
      );
    }

    // The refusals are also data about the pack, not only a sentence in a note.
    const payload = await (await fetch(`${origin}/api/playbook`)).json();
    assert.ok(
      payload.refusals.total >= 1,
      `the playbook must report the refusals it recorded: ${JSON.stringify(payload.refusals)}`,
    );
    assert.ok(
      payload.refusals.packs.some((entry) => entry.pack === 'lead' && entry.count >= 1),
      `a Tech Lead mission is refused under the lead pack: ${JSON.stringify(payload.refusals)}`,
    );
  } finally {
    server.kill('SIGTERM');
    // The office flushes its state on SIGTERM; deleting the folder before it
    // exits races that write and fails the check for the wrong reason.
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 3_000);
      server.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    await new Promise((resolve) => model.close(resolve));
    await fs.rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

for (const mode of ['recover', 'persistent', 'repo']) {
  try {
    await runtimeChecks(mode);
    results.push({ label: `reviewer inside the gate (${mode})`, ok: true });
    console.log(
      mode === 'recover'
        ? '  ✓ the gate refuses once, sends the worker back, and accepts the fix'
        : mode === 'persistent'
          ? '  ✓ a reviewer that never accepts is capped at three refusals, then accepted with a note'
          : '  ✓ a repository with no checkpoint is still reviewed, using the task\'s own diff',
    );
  } catch (error) {
    results.push({ label: `reviewer inside the gate (${mode})`, ok: false, error });
    console.log(`  ✗ reviewer inside the gate (${mode})\n      ${error instanceof Error ? error.message : String(error)}`);
  }
}

const failed = results.filter((entry) => !entry.ok);
console.log(`\n[review] ${results.length - failed.length}/${results.length} checks passed.`);
if (failed.length > 0) {
  console.log(`Failed: ${failed.map((entry) => entry.label).join(' · ')}`);
  process.exitCode = 1;
}
