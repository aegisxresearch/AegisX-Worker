/**
 * The visual critic: an image in, a verdict out, and one refusal that actually
 * reaches the worker.
 *
 *   node --experimental-strip-types scripts/vision-check.mjs
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { serializeMessages } from '../server/src/llm.ts';
import { buildVisionMessages, critiqueImage, parseVision } from '../server/src/visionCritic.ts';

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

/** A 1x1 transparent PNG. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

console.log('\n[vision] the contract');

await check('a refusal carries concrete problems', async () => {
  const verdict = parseVision('{"verdict":"fail","issues":["the hero heading is clipped at the top"]}');
  assert.deepEqual(verdict, { verdict: 'fail', issues: ['the hero heading is clipped at the top'] });
});

await check('an unreadable reply is never a pass', async () => {
  assert.equal(parseVision('The page looks fine to me.'), null);
  assert.equal(parseVision('{"verdict":"pass","issues":[]}').verdict, 'pass');
  assert.equal(parseVision('{"verdict":"fail","issues":[]}'), null, 'a refusal with no issue is unusable');
  assert.equal(parseVision('{"verdict":"ok","issues":["x"]}'), null);
});

await check('the image is sent as a content part, not as text', async () => {
  const messages = buildVisionMessages({
    taskTitle: 'Fix the landing page',
    source: '.agent-office/preview.png',
    imageDataUrl: `data:image/png;base64,${PNG.toString('base64')}`,
  });
  const wire = serializeMessages(messages);
  const user = wire.find((message) => message.role === 'user');
  assert.ok(Array.isArray(user.content), 'the user turn must be a content-part array');
  const imagePart = user.content.find((part) => part.type === 'image_url');
  assert.ok(imagePart, 'no image part reached the wire');
  assert.equal(imagePart.image_url.url.startsWith('data:image/png;base64,'), true);
});

await check('one real call returns the verdict and its usage', async () => {
  const server = http.createServer((request, response) => {
    let raw = '';
    request.on('data', (chunk) => {
      raw += chunk;
    });
    request.on('end', () => {
      const body = JSON.parse(raw || '{}');
      const image = JSON.stringify(body.messages);
      assert.match(image, /image_url/, 'the request carried no image');
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(
        JSON.stringify({
          choices: [{ message: { content: '{"verdict":"fail","issues":["the footer overlaps the last card"]}' } }],
          usage: { prompt_tokens: 200, completion_tokens: 20, total_tokens: 220 },
        }),
      );
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    const verdict = await critiqueImage(
      { endpoint: `http://127.0.0.1:${port}/v1`, apiKey: 'k', model: 'mock-vision' },
      { taskTitle: 'Fix the page', source: 'preview.png', imageDataUrl: `data:image/png;base64,${PNG.toString('base64')}` },
    );
    assert.equal(verdict.verdict, 'fail');
    assert.equal(verdict.usage.totalTokens, 220);
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

function startMockOffice(state) {
  const server = http.createServer((request, response) => {
    if (request.method === 'GET' && request.url?.startsWith('/v1/models')) {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ data: [{ id: 'mock-vision-office' }] }));
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

      if (system.includes('visual critic')) {
        state.vision += 1;
        const verdict =
          state.vision === 1
            ? { verdict: 'fail', issues: ['the heading is clipped at the top of the image'] }
            : { verdict: 'pass', issues: [] };
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(
          JSON.stringify({
            choices: [{ message: { content: JSON.stringify(verdict) } }],
            usage: { prompt_tokens: 60, completion_tokens: 8, total_tokens: 68 },
          }),
        );
        return;
      }

      if (system.startsWith('You are the independent reviewer')) {
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
          ? { name: 'read_media', arguments: JSON.stringify({ path: 'shot.png' }) }
          : toolResults === 1
            ? { name: 'write_file', arguments: JSON.stringify({ path: 'page.html', content: '<!doctype html><h1>ok</h1>\n' }) }
            : { name: 'complete_task', arguments: JSON.stringify({ summary: 'Built the page.' }) };

      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      const send = (payload) => response.write(`data: ${JSON.stringify(payload)}\n\n`);
      send({ choices: [{ delta: { content: 'Working.' } }] });
      send({
        choices: [
          {
            delta: {
              tool_calls: [{ index: 0, id: `call_${state.worker}`, type: 'function', function: toolCall }],
            },
          },
        ],
      });
      send({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
      send({ usage: { prompt_tokens: 90, completion_tokens: 15, total_tokens: 105 } });
      response.write('data: [DONE]\n\n');
      response.end();
      state.worker += 1;
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

async function runtimeChecks() {
  console.log('\n[vision] inside the completion gate');
  const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'aegisx-vision-'));
  const workspace = path.join(sandbox, 'workspace');
  await fs.mkdir(workspace, { recursive: true });
  await fs.writeFile(path.join(workspace, 'shot.png'), PNG);

  const state = { vision: 0, worker: 0 };
  const model = await startMockOffice(state);
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
        OFFICE_MODEL: 'mock-vision-office',
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
      body: JSON.stringify({ title: 'Build the page', detail: 'One page, no clipping.', assigneeId: lead.id }),
    });

    const task = await waitFor(async () => {
      const response = await fetch(`${origin}/api/session`);
      const body = await response.json();
      const found = body.tasks.find((entry) => entry.title === 'Build the page');
      return found && found.status === 'done' ? found : null;
    }, 'the task to finish after the critic accepts');

    assert.equal(state.vision, 2, `the critic should run twice, saw ${state.vision}`);
    assert.ok(
      task.notes.some((note) => note.includes('Visual critic refused')),
      `the visual refusal must be recorded: ${JSON.stringify(task.notes)}`,
    );
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
    await fs.rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

try {
  await runtimeChecks();
  results.push({ label: 'visual critic inside the gate', ok: true });
  console.log('  ✓ the critic refuses once, the worker fixes it, the second look passes');
} catch (error) {
  results.push({ label: 'visual critic inside the gate', ok: false, error });
  console.log(`  ✗ visual critic inside the gate\n      ${error instanceof Error ? error.message : String(error)}`);
}

const failed = results.filter((entry) => !entry.ok);
console.log(`\n[vision] ${results.length - failed.length}/${results.length} checks passed.`);
if (failed.length > 0) {
  console.log(`Failed: ${failed.map((entry) => entry.label).join(' · ')}`);
  process.exitCode = 1;
}
