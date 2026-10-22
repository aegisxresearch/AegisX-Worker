/**
 * Renders the built office in a real browser and reads the labels back.
 *
 * The static check (`check:i18n`) proves the dictionary is complete; this one
 * proves the page actually uses it — `bootLocale()` runs, `data-i18n` is
 * rewritten, and `<html lang>` follows. It needs `npm run build` and Chrome,
 * which is why it is not part of `npm run check`.
 *
 *   npm run build
 *   npm run check:i18n:browser
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');

async function freePort() {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function chromeJson(port, route, init) {
  const response = await fetch(`http://127.0.0.1:${port}${route}`, init);
  return response.json();
}

/**
 * Chrome's `--dump-dom` never returns while the page holds an SSE connection.
 *
 * `switchTo` changes the language through the settings select after the page is
 * up, which is the only way to catch a label that was written once and never
 * redrawn — the activity log is appended to, not rebuilt.
 */
async function readLabels(debugPort, origin, locale, switchTo) {
  const target = await chromeJson(debugPort, '/json/new?about:blank', { method: 'PUT' });
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = reject;
  });

  let nextId = 1;
  const pending = new Map();
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    const resolve = pending.get(message.id);
    if (resolve) {
      pending.delete(message.id);
      resolve(message);
    }
  };
  const send = (method, params = {}) => {
    const id = nextId;
    nextId += 1;
    return new Promise((resolve) => {
      pending.set(id, resolve);
      socket.send(JSON.stringify({ id, method, params }));
    });
  };

  const expression = `JSON.stringify({
    lang: document.documentElement.lang,
    settings: document.querySelector('[data-i18n="common.settings"]')?.textContent,
    board: document.querySelector('[data-i18n="tasks.title"]')?.textContent,
    team: document.querySelector('[data-i18n="team.title"]')?.textContent,
    send: document.querySelector('[data-i18n="common.send"]')?.textContent,
    activity: document.querySelector('#activity-log .msg')?.textContent,
    title: document.title
  })`;

  try {
    await send('Page.navigate', { url: `${origin}/?lang=${locale}` });
    for (let attempt = 0; attempt < 50; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      const result = await send('Runtime.evaluate', { expression, returnByValue: true });
      const raw = result.result?.result?.value;
      if (!raw) continue;
      const parsed = JSON.parse(raw);
      // The activity log arrives with the first snapshot, a beat after the
      // static labels, so its first line is part of "the page is ready".
      if (parsed.lang === locale && parsed.settings && parsed.activity) {
        if (!switchTo) return parsed;
        await send('Runtime.evaluate', {
          expression: `(() => {
            const select = document.getElementById('settings-language');
            select.value = '${switchTo}';
            select.dispatchEvent(new Event('change'));
            return true;
          })()`,
        });
        for (let switched = 0; switched < 50; switched += 1) {
          await new Promise((resolve) => setTimeout(resolve, 200));
          const next = await send('Runtime.evaluate', { expression, returnByValue: true });
          const value = next.result?.result?.value;
          if (!value) continue;
          const after = JSON.parse(value);
          if (after.lang === switchTo && after.settings) return after;
        }
        throw new Error(`the page never switched to ${switchTo}`);
      }
    }
    throw new Error(`the page never rendered in ${locale}`);
  } finally {
    socket.close();
  }
}

const dist = path.join(REPO_ROOT, 'client', 'dist', 'index.html');
if (!(await fs.access(dist).then(() => true).catch(() => false))) {
  console.error('client/dist is missing — run `npm run build` first.');
  process.exit(1);
}

const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'aegisx-i18n-'));
const workspace = path.join(sandbox, 'workspace');
await fs.mkdir(workspace, { recursive: true });
const port = await freePort();
const debugPort = await freePort();
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
      OFFICE_STATE_DIR: path.join(sandbox, 'state'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  },
);
const serverLog = [];
server.stdout.on('data', (chunk) => serverLog.push(chunk.toString()));
server.stderr.on('data', (chunk) => serverLog.push(chunk.toString()));

const profile = path.join(sandbox, 'chrome');
const chrome = spawn(
  'google-chrome',
  [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${debugPort}`,
    'about:blank',
  ],
  { stdio: ['ignore', 'ignore', 'ignore'] },
);

const results = [];
try {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const response = await fetch(`${origin}/api/session`);
      if (response.ok) break;
    } catch {
      // not yet
    }
    if (attempt > 100) throw new Error(`the office did not boot: ${serverLog.join('').slice(-800)}`);
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  for (let attempt = 0; ; attempt += 1) {
    try {
      await chromeJson(debugPort, '/json/version');
      break;
    } catch {
      if (attempt > 100) throw new Error('Chrome did not start');
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  const indonesian = await readLabels(debugPort, origin, 'id');
  const english = await readLabels(debugPort, origin, 'en');
  // English first, then the operator switches to Indonesian: the log line was
  // already on screen, so it only reads Indonesian if the log is redrawn.
  const switched = await readLabels(debugPort, origin, 'en', 'id');
  const checks = [
    ['Indonesian marks the document as id', indonesian.lang === 'id'],
    ['Indonesian settings label', indonesian.settings === 'Pengaturan'],
    ['Indonesian board heading', indonesian.board === 'Papan task'],
    ['Indonesian team heading', indonesian.team === 'Tim'],
    ['Indonesian send button', indonesian.send === 'Kirim'],
    ['Indonesian page title', indonesian.title.includes('kantor virtual 3D')],
    ['English marks the document as en', english.lang === 'en'],
    ['English settings label', english.settings === 'Settings'],
    ['English board heading', english.board === 'Task board'],
    ['English page title', english.title.includes('3D virtual office')],
    ['Indonesian activity log line', (indonesian.activity ?? '').startsWith('Mode demo')],
    ['English activity log line', (english.activity ?? '').startsWith('Demo mode')],
    ['a live language switch redraws the log', (switched.activity ?? '').startsWith('Mode demo')],
  ];
  for (const [label, ok] of checks) {
    console.log(`${ok ? '✓' : '✗'} ${label}`);
    if (!ok) results.push(label);
  }
  console.log(`\n[i18n] ${checks.length - results.length}/${checks.length} browser checks passed.`);
  if (results.length > 0) {
    console.log(JSON.stringify({ indonesian, english }, null, 2));
    process.exitCode = 1;
  }
} catch (error) {
  console.error(`browser i18n check failed: ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
} finally {
  chrome.kill('SIGTERM');
  server.kill('SIGTERM');
  await new Promise((resolve) => setTimeout(resolve, 700));
  if (chrome.exitCode === null) chrome.kill('SIGKILL');
  if (server.exitCode === null) server.kill('SIGKILL');
  await fs.rm(sandbox, { recursive: true, force: true });
}
