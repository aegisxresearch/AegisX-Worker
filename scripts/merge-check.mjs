/**
 * The merge gate: a task cannot report success on a tree that changed after its
 * checks passed.
 *
 *   node --experimental-strip-types scripts/merge-check.mjs
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { MergeQueue, changedPaths, hashPaths } from '../server/src/mergeQueue.ts';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const results = [];
const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'aegisx-merge-'));

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

console.log('\n[merge] the queue and the hashes');

await check('jobs run one at a time, in order', async () => {
  const queue = new MergeQueue();
  let active = 0;
  let peak = 0;
  const order = [];
  const job = (id) => async () => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 20));
    order.push(id);
    active -= 1;
  };
  await Promise.all([queue.run(job(1)), queue.run(job(2)), queue.run(job(3))]);
  assert.equal(peak, 1, `two merges overlapped (peak ${peak})`);
  assert.deepEqual(order, [1, 2, 3]);
});

await check('a failed job does not stall the next completion', async () => {
  const queue = new MergeQueue();
  await assert.rejects(queue.run(async () => {
    throw new Error('boom');
  }));
  const value = await queue.run(async () => 'after');
  assert.equal(value, 'after');
});

await check('hashes notice edited and deleted files, not untouched ones', async () => {
  const file = path.join(sandbox, 'app.ts');
  await fs.writeFile(file, 'one\n');
  const baseline = await hashPaths([file]);
  assert.deepEqual(changedPaths(baseline, await hashPaths([file])), []);

  await fs.writeFile(file, 'two\n');
  assert.deepEqual(changedPaths(baseline, await hashPaths([file])), [file]);

  await fs.rm(file);
  assert.deepEqual(changedPaths(baseline, await hashPaths([file])), [file], 'a deleted file is a change');
});

// ── the gate inside a real mission ──────────────────────────────────────────

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
 * The reviewer call is where another worker is simulated: on its first
 * invocation the mock rewrites the task's file, so the tree the checks approved
 * no longer exists when the merge gate looks at it.
 */
function startMockOffice(state, workspace) {
  const server = http.createServer((request, response) => {
    if (request.method === 'GET' && request.url?.startsWith('/v1/models')) {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ data: [{ id: 'mock-merge-office' }] }));
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
    request.on('end', async () => {
      const body = JSON.parse(raw || '{}');
      const messages = Array.isArray(body.messages) ? body.messages : [];
      const system = String(messages.find((entry) => entry.role === 'system')?.content ?? '');

      if (system.startsWith('You are the independent reviewer')) {
        state.reviews += 1;
        if (state.reviews === 1) {
          // Someone else writes the file while the reviewer is reading.
          await fs.writeFile(path.join(workspace, 'app.ts'), 'export const who = "other";\n');
        }
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(
          JSON.stringify({
            choices: [{ message: { content: '{"verdict":"pass","reasons":[]}' } }],
            usage: { prompt_tokens: 40, completion_tokens: 4, total_tokens: 44 },
          }),
        );
        return;
      }

      const toolResults = messages.filter((entry) => entry.role === 'tool').length;
      const toolCall =
        toolResults === 0
          ? { name: 'write_file', arguments: JSON.stringify({ path: 'app.ts', content: 'export const who = "worker";\n' }) }
          : { name: 'complete_task', arguments: JSON.stringify({ summary: 'Wrote app.ts.' }) };

      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      const send = (payload) => response.write(`data: ${JSON.stringify(payload)}\n\n`);
      send({ choices: [{ delta: { content: 'Working.' } }] });
      send({ choices: [{ delta: { tool_calls: [{ index: 0, id: `call_${state.worker}`, type: 'function', function: toolCall }] } }] });
      send({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
      send({ usage: { prompt_tokens: 80, completion_tokens: 10, total_tokens: 90 } });
      response.write('data: [DONE]\n\n');
      response.end();
      state.worker += 1;
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

async function runtimeCheck() {
  console.log('\n[merge] inside a real mission');
  const workspace = path.join(sandbox, 'workspace');
  await fs.mkdir(workspace, { recursive: true });

  const state = { reviews: 0, worker: 0 };
  const model = await startMockOffice(state, workspace);
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
        OFFICE_MODEL: 'mock-merge-office',
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
      body: JSON.stringify({ title: 'Write app', detail: 'One file.', assigneeId: lead.id }),
    });

    const task = await waitFor(async () => {
      const response = await fetch(`${origin}/api/session`);
      const body = await response.json();
      const found = body.tasks.find((entry) => entry.title === 'Write app');
      return found && found.status === 'done' ? found : null;
    }, 'the task to finish after the second merge check');

    assert.ok(
      task.notes.some((note) => note.includes('Merge gate')),
      `the conflict must be recorded: ${JSON.stringify(task.notes)}`,
    );
    assert.ok(state.reviews >= 2, `the completion should have been re-reviewed, saw ${state.reviews}`);
    const content = await fs.readFile(path.join(workspace, 'app.ts'), 'utf8');
    assert.match(content, /other/, 'the other worker\'s change must survive');
  } finally {
    server.kill('SIGTERM');
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 3_000);
      server.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    await new Promise((resolve) => model.close(resolve));
  }
}

try {
  await runtimeCheck();
  results.push({ label: 'merge gate inside a mission', ok: true });
  console.log('  ✓ the gate refuses a tree that changed after verification, then accepts the re-check');
} catch (error) {
  results.push({ label: 'merge gate inside a mission', ok: false, error });
  console.log(`  ✗ merge gate inside a mission\n      ${error instanceof Error ? error.message : String(error)}`);
}

const failed = results.filter((entry) => !entry.ok);
console.log(`\n[merge] ${results.length - failed.length}/${results.length} checks passed.`);
if (failed.length > 0) {
  console.log(`Failed: ${failed.map((entry) => entry.label).join(' · ')}`);
  process.exitCode = 1;
}

await fs.rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
