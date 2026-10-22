/**
 * Project memory: what a mission learns about a folder must survive into the
 * next mission.
 *
 * Unit checks cover the file format, dedup, the cap and concurrent writers.
 * The last two checks run the real server against a mocked model and prove the
 * round trip: mission A finishes with a fact, mission B is *prompted* with it —
 * and mission A's own prompt did not already contain it.
 *
 *   node --experimental-strip-types scripts/memory-check.mjs
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { createCheckpoint, summariseChanges } from '../server/src/git.ts';
import {
  MEMORY_RELATIVE_PATH,
  readProjectMemory,
  recordProjectMemory,
  renderProjectMemory,
  selectFacts,
} from '../server/src/projectMemory.ts';

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
  console.log(`\n[memory] ${message}`);
}

let sandbox = '';

async function folder(name) {
  const root = path.join(sandbox, name);
  await fs.mkdir(root, { recursive: true });
  return root;
}

function countOccurrences(haystack, needle) {
  return haystack.split(needle).length - 1;
}

// ── the file and its rules ───────────────────────────────────────────────────

async function formatChecks() {
  say('file format');

  await check('an untouched folder renders nothing at all', async () => {
    const empty = await folder('empty');
    const memory = await readProjectMemory(empty);
    assert.deepEqual(memory.facts, []);
    assert.equal(renderProjectMemory(memory), '', 'no heading, no "no memories" filler');
  });

  await check('a recorded fact comes back, newest first', async () => {
    const root = await folder('record');
    const outcome = await recordProjectMemory(root, {
      facts: ['Styles live in client/src/styles.css.', 'Build with npm run build.'],
    });
    assert.equal(outcome.written.length, 2);
    assert.equal(outcome.path, path.join(root, MEMORY_RELATIVE_PATH));

    const memory = await readProjectMemory(root);
    assert.deepEqual(memory.facts, [
      'Build with npm run build.',
      'Styles live in client/src/styles.css.',
    ]);
    const raw = await fs.readFile(outcome.path, 'utf8');
    assert.match(raw, /^# Project memory$/m);
    assert.match(raw, /^- Build with npm run build\.$/m);
  });

  await check('the same fact recorded again is not duplicated', async () => {
    const root = await folder('dedup');
    await recordProjectMemory(root, { facts: ['Tests run with npm test.'] });
    const second = await recordProjectMemory(root, {
      // Same meaning, different casing and spacing.
      facts: ['  tests   run with npm test.  '],
    });
    assert.deepEqual(second.written, [], 'nothing new to write');
    const raw = await fs.readFile(second.path, 'utf8');
    assert.equal(countOccurrences(raw.toLowerCase(), 'npm test'), 1, raw);
  });

  await check('a fact is forced to one short line', async () => {
    const root = await folder('single-line');
    const outcome = await recordProjectMemory(root, {
      facts: [`Line one\n\nLine two\t with   tabs ${'x'.repeat(400)}`],
    });
    assert.equal(outcome.written.length, 1);
    const [fact] = (await readProjectMemory(root)).facts;
    assert.equal(fact.includes('\n'), false, 'a newline would break the prompt block');
    assert.ok(fact.length <= 240, `fact was ${fact.length} chars`);
    assert.match(fact, /^Line one Line two with tabs/);
  });

  await check('memory stops at 60 facts, keeping the newest', async () => {
    const root = await folder('cap');
    const facts = Array.from({ length: 70 }, (_, index) => `fact number ${index}`);
    await recordProjectMemory(root, { facts });
    const memory = await readProjectMemory(root);
    assert.equal(memory.facts.length, 60);
    assert.equal(memory.facts[0], 'fact number 69', 'newest first');
    assert.equal(memory.facts.includes('fact number 0'), false, 'the oldest fell off');
  });

  await check('a hand-edited or mangled file still yields its facts', async () => {
    const root = await folder('mangled');
    const target = path.join(root, MEMORY_RELATIVE_PATH);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(
      target,
      'Some prose the operator typed.\n\n- Real fact one.\nnot a fact\n- Real fact two.\n- \n',
      'utf8',
    );
    const memory = await readProjectMemory(root);
    assert.deepEqual(memory.facts, ['Real fact one.', 'Real fact two.']);
  });

  await check('parallel writers keep every fact (team missions finish together)', async () => {
    const root = await folder('concurrent');
    const facts = Array.from({ length: 15 }, (_, index) => `parallel fact ${index}`);
    await Promise.all(facts.map((fact) => recordProjectMemory(root, { facts: [fact] })));
    const memory = await readProjectMemory(root);
    assert.equal(memory.facts.length, 15);
    for (const fact of facts) assert.ok(memory.facts.includes(fact), `lost "${fact}"`);
  });

  await check('remembering something is not reported as work the worker did', async () => {
    const root = await folder('not-a-change');
    await fs.writeFile(path.join(root, 'index.html'), '<!doctype html><title>one</title>\n', 'utf8');
    const outcome = await createCheckpoint(root, 'a memory check');
    assert.ok(outcome.checkpoint, outcome.reason ?? 'no checkpoint');

    await recordProjectMemory(root, { facts: ['Tests run with npm test.'] });
    await fs.writeFile(path.join(root, 'page.html'), '<!doctype html><title>two</title>\n', 'utf8');

    const summary = await summariseChanges(outcome.checkpoint);
    assert.match(summary, /page\.html/, 'real work must still show up');
    assert.equal(
      summary.includes('knowledge.md'),
      false,
      `the memory file leaked into the worker's diff:\n${summary}`,
    );
  });

  await check('a relevant older fact outranks newer noise', async () => {
    const facts = [
      'The header logo is 32px tall.',
      'Footer copy was approved in June.',
      'The websocket reconnects with exponential backoff in client/src/core/net.ts.',
      'Coffee machine lives on floor two.',
    ];
    const chosen = selectFacts(facts, 'Fix the websocket reconnect loop', { maxFacts: 2 });
    assert.deepEqual(
      chosen,
      ['The websocket reconnects with exponential backoff in client/src/core/net.ts.'],
      `retrieval picked ${JSON.stringify(chosen)}`,
    );
  });

  await check('with no query the newest facts still win', async () => {
    const facts = ['newest', 'middle', 'oldest'];
    assert.deepEqual(selectFacts(facts, '', { maxFacts: 2 }), ['newest', 'middle']);
  });

  await check('the injected block stays inside its prompt budget', async () => {
    const root = await folder('budget');
    const facts = Array.from({ length: 40 }, (_, index) => `${index}: ${'y'.repeat(200)}`);
    await recordProjectMemory(root, { facts });
    const block = renderProjectMemory(await readProjectMemory(root));
    assert.ok(block.length <= 2_100, `block was ${block.length} chars`);
    assert.match(block, /^Project memory/);
    assert.ok(block.split('\n').length > 2, 'at least a few facts fit');
  });
}

// ── the round trip through a real server ────────────────────────────────────

const FACT = 'Styles live in client/src/styles.css.';

function startMockModel(prompts) {
  const server = http.createServer((request, response) => {
    if (request.method === 'GET' && request.url?.startsWith('/v1/models')) {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ data: [{ id: 'mock-memory-model' }] }));
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
      const user = String(messages.find((entry) => entry.role === 'user')?.content ?? '');
      // Branch on the exact brief field the runtime controls, never on prose.
      const title = /^Task: (.+)$/m.exec(user)?.[1]?.trim() ?? '';
      prompts.push({ title, system });

      const args =
        title === 'Learn the folder'
          ? { summary: 'Noted where the styles live.', remember: [FACT] }
          : title === 'Repeat mission'
            ? { summary: 'Checked again.', remember: [FACT] }
            : { summary: 'Second mission done.' };

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
                  id: `call_${prompts.length}`,
                  type: 'function',
                  function: { name: 'complete_task', arguments: JSON.stringify(args) },
                },
              ],
            },
          },
        ],
      });
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

/** A boot-time probe: connection refused means "not up yet", not "failed". */
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

async function waitFor(predicate, label, timeoutMs = 20_000) {
  const started = Date.now();
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
}

async function roundTripCheck() {
  say('mission A → mission B');

  const workspace = await folder('workspace');
  await fs.writeFile(
    path.join(workspace, 'package.json'),
    `${JSON.stringify({ name: 'memory-fixture', scripts: { test: 'node ok.mjs' } }, null, 2)}\n`,
    'utf8',
  );
  await fs.writeFile(path.join(workspace, 'ok.mjs'), 'process.exit(0);\n', 'utf8');
  await fs.mkdir(path.join(workspace, 'node_modules'), { recursive: true });

  const prompts = [];
  const model = await startMockModel(prompts);
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
        OFFICE_MODEL: 'mock-memory-model',
        OFFICE_TOOLS: '1',
        OFFICE_GIT: '0',
        OFFICE_WORKSPACE: workspace,
        OFFICE_STATE_DIR: path.join(sandbox, 'state'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const serverLog = [];
  server.stdout.on('data', (chunk) => serverLog.push(chunk.toString()));
  server.stderr.on('data', (chunk) => serverLog.push(chunk.toString()));

  const runMission = async (title) => {
    const snapshot = await waitFor(() => probeSession(origin), 'the server to connect');
    const lead = snapshot.agents.find((agent) => agent.role === 'Tech Lead');
    const created = await getJson(`${origin}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, detail: 'Finish in one round.', assigneeId: lead.id }),
    });
    await waitFor(async () => {
      const tasks = await getJson(`${origin}/api/tasks`);
      return tasks.find((entry) => entry.id === created.id && entry.status === 'done');
    }, `"${title}" to finish`);
    return created.id;
  };

  try {
    const memoryPath = path.join(workspace, MEMORY_RELATIVE_PATH);

    await runMission('Learn the folder');

    await check('the fact is on disk the moment the task reads as done', async () => {
      // No retry loop on purpose: the write happens before the status flips, so
      // a single read right after "done" must already see it.
      const raw = await fs.readFile(memoryPath, 'utf8').catch(() => '');
      assert.match(raw, new RegExp(FACT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      assert.match(
        raw,
        /Checks available in this folder: test\./,
        'the gate already knew the tooling — it should not stay in the turn',
      );
    });

    await check('the office reports what it remembered', async () => {
      const session = await getJson(`${origin}/api/session`);
      const entry = session.logs.find((log) => log.kind === 'project.memory');
      assert.ok(entry, 'a project.memory log line should exist');
      assert.match(entry.message, /Remembered 2 fact\(s\)/);
    });

    await runMission('Second mission');

    await check('the next mission is prompted with it', async () => {
      const first = prompts.find((entry) => entry.title === 'Learn the folder');
      const second = prompts.find((entry) => entry.title === 'Second mission');
      assert.ok(first && second, `prompts seen: ${prompts.map((entry) => entry.title).join(' | ')}`);

      assert.equal(
        first.system.includes(FACT),
        false,
        'mission A must not be told a fact it is about to discover',
      );
      assert.match(second.system, /Project memory/);
      assert.ok(second.system.includes(FACT), 'mission B should start with the fact');
      assert.match(second.system, /Checks available in this folder: test\./);
    });

    await runMission('Repeat mission');

    await check('recording the same fact twice leaves one line', async () => {
      const raw = await fs.readFile(memoryPath, 'utf8');
      assert.equal(countOccurrences(raw, FACT), 1, raw);
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
      console.log(`\n[server log]\n${serverLog.join('').split('\n').slice(-20).join('\n')}`);
    }
  }
}

sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'aegisx-memory-'));

try {
  await formatChecks();
  await roundTripCheck();
} finally {
  await fs.rm(sandbox, { recursive: true, force: true });
}

const passed = results.filter((entry) => entry.ok).length;
console.log(`\n[memory] ${passed}/${results.length} checks passed.`);
if (passed !== results.length) {
  console.log(`Failed: ${results.filter((entry) => !entry.ok).map((entry) => entry.label).join(' · ')}`);
  process.exit(1);
}
