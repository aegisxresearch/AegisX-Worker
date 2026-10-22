/**
 * The language the team writes in.
 *
 * The UI being Indonesian is not enough: a task note is read by a colleague on
 * the next round and by whoever opens the board tomorrow, so the prompt has to
 * tell the model which language to write in. This check boots the real office
 * against a scripted model, switches the language the way the browser does, and
 * reads the system prompt the model actually received.
 *
 *   npm run check:language
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
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

/** A model that answers every round, and records the prompt it was given. */
function startMockModel() {
  const prompts = [];
  const server = http.createServer((request, response) => {
    if (request.method === 'GET' && request.url?.startsWith('/v1/models')) {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ data: [{ id: 'mock-language-model' }] }));
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
      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      const send = (payload) => response.write(`data: ${JSON.stringify(payload)}\n\n`);
      // A plain reply ends a chat turn, so each turn is exactly one round and
      // the prompt under test is the one that answered it.
      send({ choices: [{ delta: { content: 'Working on it.' } }] });
      send({ choices: [{ delta: {}, finish_reason: 'stop' }] });
      send({ usage: { prompt_tokens: 90, completion_tokens: 20, total_tokens: 110 } });
      response.write('data: [DONE]\n\n');
      response.end();
    });
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve({ server, prompts })),
  );
}

async function waitFor(predicate, label, timeoutMs = 20_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for ${label}`);
}

const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'aegisx-language-'));
const workspace = path.join(sandbox, 'workspace');
await fs.mkdir(workspace, { recursive: true });

const mock = await startMockModel();
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
      OFFICE_MODEL: 'mock-language-model',
      OFFICE_DEMO: '0',
      OFFICE_TOOLS: '1',
      OFFICE_WEB: '0',
      OFFICE_GIT: '0',
      OFFICE_VERIFY: '0',
      OFFICE_WORKSPACE: workspace,
      OFFICE_STATE_DIR: path.join(sandbox, 'state'),
      OFFICE_LOCALE: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  },
);
const serverLog = [];
office.stdout.on('data', (chunk) => serverLog.push(chunk.toString()));
office.stderr.on('data', (chunk) => serverLog.push(chunk.toString()));

async function getJson(url, init) {
  const response = await fetch(url, init);
  return { status: response.status, body: await response.json() };
}

async function postJson(url, body) {
  return getJson(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** The system prompt of the most recent model round. */
function lastSystemPrompt() {
  const messages = mock.prompts.at(-1) ?? [];
  return messages.find((message) => message.role === 'system')?.content ?? '';
}

async function runChatTurn(agentId) {
  const before = mock.prompts.length;
  await postJson(`${origin}/api/chat`, { agentId, content: 'Please continue.' });
  await waitFor(() => mock.prompts.length > before, `a model round for ${agentId}`);
  await waitFor(async () => {
    const session = await getJson(`${origin}/api/session`);
    const chat = session.body.chats.at(-1);
    return chat && !chat.streaming ? chat : null;
  }, 'the reply to settle');
  return lastSystemPrompt();
}

try {
  await waitFor(async () => {
    try {
      const { status } = await getJson(`${origin}/api/session`);
      return status === 200;
    } catch {
      return false;
    }
  }, 'the office to boot');

  const initial = await getJson(`${origin}/api/session`);
  const agent = initial.body.agents[0];

  console.log('\n[language] the office default');

  await check('a fresh office writes in English', async () => {
    const prompt = await runChatTurn(agent.id);
    assert.ok(prompt.includes(`You are ${agent.name}`), 'the system prompt never arrived');
    assert.ok(
      !prompt.includes('Bahasa Indonesia'),
      'the Indonesian instruction is present before anyone asked for it',
    );
    assert.equal(initial.body.settings.locale, 'en');
  });

  console.log('\n[language] the operator switches to Indonesian');

  await check('the browser can set the language the team writes in', async () => {
    const { status, body } = await postJson(`${origin}/api/session/locale`, { locale: 'id' });
    assert.equal(status, 200);
    assert.equal(body.settings.locale, 'id');
  });

  await check('the next prompt tells the model to write Indonesian notes', async () => {
    const prompt = await runChatTurn(agent.id);
    assert.match(prompt, /Language: the operator reads Indonesian\./);
    assert.match(prompt, /add_note/);
    assert.match(prompt, /complete_task summary/);
    // The instruction is about prose only; identifiers must stay untranslated.
    assert.match(prompt, /never translate them/);
  });

  await check('the setting survives a reload of the page', async () => {
    const { body } = await getJson(`${origin}/api/session`);
    assert.equal(body.settings.locale, 'id');
  });

  await check('switching back to English drops the instruction', async () => {
    const { body } = await postJson(`${origin}/api/session/locale`, { locale: 'en' });
    assert.equal(body.settings.locale, 'en');
    const prompt = await runChatTurn(agent.id);
    assert.ok(!prompt.includes('Bahasa Indonesia'));
  });

  await check('a language the office does not have is refused', async () => {
    const { status, body } = await postJson(`${origin}/api/session/locale`, { locale: 'fr' });
    assert.equal(status, 400);
    assert.match(String(body.message), /en.*id|"id"/);
    const { body: session } = await getJson(`${origin}/api/session`);
    assert.equal(session.settings.locale, 'en', 'a rejected request must not change the office');
  });

  await check('the language is written to disk with the rest of the settings', async () => {
    await postJson(`${origin}/api/session/locale`, { locale: 'id' });
    const stateFile = path.join(sandbox, 'state', 'office-state.json');
    const state = await waitFor(async () => {
      const raw = await fs.readFile(stateFile, 'utf8').catch(() => null);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      return parsed.state.settings.locale === 'id' ? parsed : null;
    }, 'the office state to include the language');
    assert.equal(state.state.settings.locale, 'id');
  });
} catch (error) {
  console.error(`language check failed: ${error instanceof Error ? error.message : error}`);
  console.error(serverLog.join('').slice(-800));
  process.exitCode = 1;
} finally {
  office.kill('SIGTERM');
  mock.server.close();
  await new Promise((resolve) => setTimeout(resolve, 500));
  if (office.exitCode === null) office.kill('SIGKILL');
  await fs.rm(sandbox, { recursive: true, force: true });
}

const passed = results.filter((entry) => entry.ok).length;
console.log(`\n[language] ${passed}/${results.length} checks passed.`);
if (passed !== results.length) {
  console.log(`Failed: ${results.filter((entry) => !entry.ok).map((entry) => entry.label).join(' · ')}`);
  process.exit(1);
}
