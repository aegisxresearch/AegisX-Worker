/**
 * Two rules this check exists for:
 *
 *   1. The completion gate refuses a task whose folder still holds the probe
 *      scripts the worker made to check something — and accepts it after two
 *      requests, so a stubborn model cannot burn the whole turn on housekeeping.
 *   2. The prompt tells a worker to verify a page with `preview_screenshot` and
 *      a `node -e` fetch, instead of searching the filesystem for a browser.
 *
 * Both are proven here against the real server and a scripted model: the same
 * path a live mission takes.
 *
 *   npm run check:cleanup
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { findScratchFiles, isScratchName } from '../server/src/scratch.ts';

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

function freePort() {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

// ── part A: what counts as scratch ──────────────────────────────────────────

console.log('\n[cleanup] the name rule');

await check('probe and QA leftovers are scratch', () => {
  for (const name of [
    'probe-http.js',
    'probe.cjs',
    'qa-run.txt',
    'qa-facts.mjs',
    'tmp-2.txt',
    'verify-check.mjs',
    'server.log',
    'probe-server.pid',
    'out.txt',
    'notes.md~',
  ]) {
    assert.equal(isScratchName(name), true, `${name} should be scratch`);
  }
});

await check('deliverables and real tests are not', () => {
  for (const name of [
    'index.html',
    'server.js',
    'styles.css',
    'auth.js',
    'product.md',
    'README.md',
    'package.json',
    'auth.test.mjs',
  ]) {
    assert.equal(isScratchName(name), false, `${name} should be kept`);
  }
});

const scanRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aegisx-scratch-'));
await fs.mkdir(path.join(scanRoot, 'tests'), { recursive: true });
await fs.mkdir(path.join(scanRoot, 'node_modules', 'dep'), { recursive: true });
await fs.mkdir(path.join(scanRoot, '.cache'), { recursive: true });
await fs.mkdir(path.join(scanRoot, 'scripts'), { recursive: true });
for (const [relative, content] of Object.entries({
  'index.html': '<html></html>',
  'probe-http.js': 'console.log(1)',
  'qa-run.txt': 'ok',
  'server.log': 'log',
  'tests/auth.test.mjs': 'test',
  'scripts/probe-tree.mjs': 'probe',
  'node_modules/dep/probe.js': 'dep',
  '.cache/probe.js': 'cache',
  'product.md': '# product',
})) {
  await fs.writeFile(path.join(scanRoot, relative), content, 'utf8');
}

await check('the scan lists leftovers and skips tests, deps and caches', async () => {
  const scan = await findScratchFiles(scanRoot);
  assert.deepEqual(scan.files, ['probe-http.js', 'qa-run.txt', 'scripts/probe-tree.mjs', 'server.log']);
  assert.equal(scan.truncated, false);
});
await fs.rm(scanRoot, { recursive: true, force: true });

// ── part B: the gate, on a live office ─────────────────────────────────────

/** A model that follows the script the task title asks for. */
function startMockModel(prompts) {
  const server = http.createServer((request, response) => {
    if (request.method === 'GET' && request.url?.startsWith('/v1/models')) {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ data: [{ id: 'mock-cleanup-model' }] }));
      return;
    }
    if (!request.url?.includes('/chat/completions')) {
      response.writeHead(404).end('not found');
      return;
    }
    let raw = '';
    request.on('data', (chunk) => (raw += chunk));
    request.on('end', () => {
      const body = JSON.parse(raw);
      prompts.push(body.messages);
      const brief = [...body.messages].reverse().find((message) => message.role === 'user')?.content ?? '';
      const assistantRounds = body.messages.filter((message) => message.role === 'assistant').length;
      const stubborn = brief.includes('stubborn');
      const cleanupAtRound = 1; // reject once, then delete, then finish

      let calls;
      if (!stubborn && assistantRounds === cleanupAtRound && brief.includes('cleanup')) {
        calls = ['probe-http.js', 'qa-run.txt'].map((relative) => ({
          name: 'delete_file',
          arguments: JSON.stringify({ path: relative }),
        }));
      } else if (!stubborn && assistantRounds >= 2 && brief.includes('cleanup')) {
        calls = [{ name: 'complete_task', arguments: JSON.stringify({ summary: 'Cleaned up and done.' }) }];
      } else {
        calls = [{ name: 'complete_task', arguments: JSON.stringify({ summary: 'Done.' }) }];
      }

      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      const send = (payload) => response.write(`data: ${JSON.stringify(payload)}\n\n`);
      send({ choices: [{ delta: { content: 'Working.' } }] });
      send({
        choices: [
          {
            delta: {
              tool_calls: calls.map((call, index) => ({
                index,
                id: `call_${assistantRounds}_${index}`,
                type: 'function',
                function: { name: call.name, arguments: call.arguments },
              })),
            },
          },
        ],
      });
      send({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
      send({ usage: { prompt_tokens: 100, completion_tokens: 25, total_tokens: 125 } });
      response.write('data: [DONE]\n\n');
      response.end();
    });
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve({ server, prompts })),
  );
}

async function waitFor(predicate, label, timeoutMs = 30_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for ${label}`);
}

const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'aegisx-cleanup-'));
const workspace = path.join(sandbox, 'workspace');
await fs.mkdir(workspace, { recursive: true });
await fs.writeFile(path.join(workspace, 'index.html'), '<!doctype html><title>ok</title>', 'utf8');
await fs.writeFile(path.join(workspace, 'probe-http.js'), 'console.log("probe")', 'utf8');
await fs.writeFile(path.join(workspace, 'qa-run.txt'), 'leftover', 'utf8');

const prompts = [];
const mock = await startMockModel(prompts);
const mockPort = mock.server.address().port;
const port = await freePort();
const origin = `http://127.0.0.1:${port}`;

const office = spawn(
  process.execPath,
  ['--experimental-strip-types', path.join(REPO_ROOT, 'server', 'src', 'index.ts')],
  {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      OFFICE_PORT: String(port),
      OFFICE_ENDPOINT: `http://127.0.0.1:${mockPort}/v1`,
      OFFICE_API_KEY: 'mock-key',
      OFFICE_MODEL: 'mock-cleanup-model',
      OFFICE_DEMO: '0',
      OFFICE_TOOLS: '1',
      OFFICE_WEB: '0',
      OFFICE_GIT: '0',
      OFFICE_VERIFY: '1',
      OFFICE_WORKSPACE: workspace,
      OFFICE_STATE_DIR: path.join(sandbox, 'state'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  },
);
const serverLog = [];
office.stdout.on('data', (chunk) => serverLog.push(chunk.toString()));
office.stderr.on('data', (chunk) => serverLog.push(chunk.toString()));

async function getJson(url) {
  const response = await fetch(url);
  return response.json();
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return response.json();
}

function systemPrompt() {
  return mock.prompts.at(-1)?.find((message) => message.role === 'system')?.content ?? '';
}

try {
  await waitFor(async () => {
    try {
      const response = await fetch(`${origin}/api/session`);
      return response.ok;
    } catch {
      return false;
    }
  }, 'the office to boot');

  const session = await getJson(`${origin}/api/session`);
  const agent = session.agents[0];

  await postJson(`${origin}/api/tasks`, {
    title: 'cleanup mission',
    detail: 'Ship the page.',
    assigneeId: agent.id,
  });

  const settled = await waitFor(async () => {
    const current = await getJson(`${origin}/api/session`);
    const task = current.tasks.find((entry) => entry.title === 'cleanup mission');
    return task && (task.status === 'done' || task.status === 'blocked') ? { current, task } : null;
  }, 'the first task to settle');

  console.log('\n[cleanup] the gate, against a live office');

  await check('a leftover probe script sends the completion back', async () => {
    const cleanup = settled.current.logs.filter((entry) => entry.kind === 'task.cleanup');
    assert.ok(cleanup.length >= 1, 'no task.cleanup log line was written');
    assert.match(cleanup[0].message, /scratch file\(s\) still in the folder/);
  });

  await check('the request names the files and the tool to remove them', async () => {
    const promptsWithRejection = prompts.filter((messages) =>
      JSON.stringify(messages).includes('Scratch files are still in the folder'),
    );
    assert.ok(promptsWithRejection.length >= 1, 'the model never saw the cleanup request');
    const text = JSON.stringify(promptsWithRejection[0]);
    assert.match(text, /probe-http\.js/);
    assert.match(text, /delete_file/);
  });

  await check('a task that cleans up is allowed to finish, files and all', async () => {
    assert.equal(settled.task.status, 'done', `task ended ${settled.task.status}`);
    assert.equal(await fs.access(path.join(workspace, 'probe-http.js')).then(() => true).catch(() => false), false);
    assert.equal(await fs.access(path.join(workspace, 'qa-run.txt')).then(() => true).catch(() => false), false);
    assert.equal(await fs.access(path.join(workspace, 'index.html')).then(() => true).catch(() => false), true);
  });

  await check('the cleanup request is recorded on the task', async () => {
    const notes = settled.task.notes.join('\n');
    assert.match(notes, /The gate asked for cleanup/);
    assert.match(notes, /probe-http\.js/);
  });

  console.log('\n[cleanup] a worker that ignores the request');

  await fs.writeFile(path.join(workspace, 'probe-stubborn.js'), 'console.log("still here")', 'utf8');
  await postJson(`${origin}/api/tasks`, {
    title: 'stubborn mission',
    detail: 'Finish even with the file around.',
    assigneeId: agent.id,
  });

  const stubborn = await waitFor(async () => {
    const current = await getJson(`${origin}/api/session`);
    const task = current.tasks.find((entry) => entry.title === 'stubborn mission');
    return task && (task.status === 'done' || task.status === 'blocked') ? { current, task } : null;
  }, 'the stubborn task to settle');

  await check('it is asked twice, then accepted with a warning — never looped forever', async () => {
    const cleanup = stubborn.current.logs.filter((entry) => entry.kind === 'task.cleanup');
    assert.ok(cleanup.length >= 2, `only ${cleanup.length} cleanup line(s)`);
    assert.ok(
      cleanup.some((entry) => /accepted|recorded in the task notes/.test(entry.message)),
      JSON.stringify(cleanup.map((entry) => entry.message)),
    );
    assert.equal(stubborn.task.status, 'done');
    assert.match(stubborn.task.notes.join('\n'), /accepted after 2 cleanup request/);
  });

  console.log('\n[cleanup] what the prompt says about checking a page');

  await check('the prompt points at preview_screenshot and node fetch, not a browser hunt', () => {
    const prompt = systemPrompt();
    assert.match(prompt, /preview_screenshot/);
    assert.match(prompt, /do not run which\/ls\/find looking for chrome/);
    assert.match(prompt, /curl is not in the sandbox allowlist/);
    assert.match(prompt, /Scratch files you create to check something/);
    assert.match(prompt, /probe-\*/);
  });
} catch (error) {
  console.error(`cleanup check failed: ${error instanceof Error ? error.message : error}`);
  console.error(serverLog.join('').slice(-1200));
  process.exitCode = 1;
} finally {
  office.kill('SIGTERM');
  mock.server.close();
  await new Promise((resolve) => setTimeout(resolve, 500));
  if (office.exitCode === null) office.kill('SIGKILL');
  await fs.rm(sandbox, { recursive: true, force: true });
}

const passed = results.filter((entry) => entry.ok).length;
console.log(`\n[cleanup] ${passed}/${results.length} checks passed.`);
if (passed !== results.length) {
  console.log(`Failed: ${results.filter((entry) => !entry.ok).map((entry) => entry.label).join(' · ')}`);
  process.exit(1);
}
