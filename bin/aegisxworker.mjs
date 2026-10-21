#!/usr/bin/env node
/**
 * aegisxworker — launch the office from any folder.
 *
 *   aegisxworker                         open the office in the current folder
 *   aegisxworker "build a landing page"  run one mission autonomously
 *
 * The folder you are standing in becomes the agents' workspace: every file
 * tool, shell command and preview runs there. The CLI builds the client when it
 * is stale, picks a free port, starts the server, opens the browser and — for a
 * mission — streams the work until the task is done or blocked.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import process from 'node:process';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const VERSION = readVersion();

const COLORS = {
  reset: '\u001b[0m',
  dim: '\u001b[2m',
  bold: '\u001b[1m',
  amber: '\u001b[38;5;179m',
  teal: '\u001b[38;5;73m',
  red: '\u001b[38;5;203m',
  green: '\u001b[38;5;114m',
};

const paint = (color, text) => `${COLORS[color] ?? ''}${text}${COLORS.reset}`;

const HELP = `
${paint('bold', 'aegisxworker')} ${paint('dim', `v${VERSION}`)} — autonomous AI workers in the folder you call from

${paint('bold', 'USAGE')}
  aegisxworker [mission...] [options]

${paint('bold', 'EXAMPLES')}
  aegisxworker
      Open the office in the current folder.

  aegisxworker "build a landing page for a specialty coffee shop"
      Create the site in the current folder, run it end to end, report back.

  aegisxworker -C ~/projects/site "fix the broken mobile nav"
      Point the workers at another folder without cd-ing into it.

  aegisxworker --agent Bimo "add a /health endpoint and a test"
      Choose the worker who picks the mission up.

  aegisxworker --team "build a booking app with an AI assistant"
      One prompt, the whole team: the lead splits the work, specialists build
      in parallel, the lead reconciles and reports.

${paint('bold', 'OPTIONS')}
      --team            Route the mission through the lead and the whole team
      --solo            Force a single worker (no team)
  -p, --port <port>     Port for the office UI (default: 8787, auto-bumps if busy)
      --agent <name>    Assign the mission to this worker (default: picked by role)
  -k, --key <key>       API key for this run (default: OFFICE_API_KEY or .env)
      --endpoint <url>  OpenAI-compatible base URL
  -m, --model <id>      Model id for the workers
      --demo            Run scripted workers, no model calls
      --no-tools        Disable file + shell tools for this run
      --no-web          Disable web search + fetch for this run
      --no-open         Do not open the browser
      --keep            Keep the office running after the mission finishes
  -t, --timeout <min>   Mission timeout in minutes (default: 20, or 30 for a team)
  -v, --verbose         Show server logs
  -h, --help            Show this help
      --version         Print the version
`;

function readVersion() {
  try {
    const manifest = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
    return typeof manifest.version === 'string' ? manifest.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function parseArgs(argv) {
  const options = {
    dir: process.cwd(),
    port: Number(process.env.OFFICE_PORT ?? 8787),
    agent: null,
    key: process.env.OFFICE_API_KEY ?? null,
    endpoint: process.env.OFFICE_ENDPOINT ?? null,
    model: process.env.OFFICE_MODEL ?? null,
    demo: false,
    team: null,
    tools: true,
    web: true,
    open: true,
    keep: false,
    timeoutMinutes: 20,
    timeoutSet: false,
    verbose: false,
    help: false,
    version: false,
    mission: '',
  };
  const words = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? '';
    const next = () => argv[++index] ?? '';
    switch (arg) {
      case '-h':
      case '--help':
        options.help = true;
        break;
      case '--version':
        options.version = true;
        break;
      case '-C':
      case '--dir':
        options.dir = next();
        break;
      case '-p':
      case '--port':
        options.port = Number(next());
        break;
      case '--agent':
        options.agent = next();
        break;
      case '-k':
      case '--key':
        options.key = next();
        break;
      case '--endpoint':
        options.endpoint = next();
        break;
      case '-m':
      case '--model':
        options.model = next();
        break;
      case '--team':
        options.team = true;
        break;
      case '--solo':
        options.team = false;
        break;
      case '--demo':
        options.demo = true;
        break;
      case '--no-tools':
        options.tools = false;
        break;
      case '--no-web':
        options.web = false;
        break;
      case '--no-open':
        options.open = false;
        break;
      case '--keep':
        options.keep = true;
        break;
      case '-t':
      case '--timeout':
        options.timeoutMinutes = Number(next());
        options.timeoutSet = true;
        break;
      case '-v':
      case '--verbose':
        options.verbose = true;
        break;
      default:
        if (arg.startsWith('-')) {
          console.error(paint('red', `Unknown option: ${arg}`));
          console.error(HELP);
          process.exit(2);
        }
        words.push(arg);
    }
  }

  options.mission = words.join(' ').trim();
  options.dir = path.resolve(options.dir.replace(/^~(?=$|\/)/, os.homedir()));
  if (!Number.isFinite(options.port) || options.port < 1) options.port = 8787;
  return options;
}

const options = parseArgs(process.argv.slice(2));

if (options.help) {
  console.log(HELP);
  process.exit(0);
}
if (options.version) {
  console.log(VERSION);
  process.exit(0);
}

const [major, minor] = process.versions.node.split('.').map(Number);
if ((major ?? 0) < 22 || ((major ?? 0) === 22 && (minor ?? 0) < 6)) {
  console.error(paint('red', `Node ${process.versions.node} is too old. aegisxworker needs Node >= 22.6.`));
  process.exit(1);
}

if (!existsSync(options.dir)) {
  console.error(paint('red', `Workspace folder does not exist: ${options.dir}`));
  process.exit(1);
}
if (!statSync(options.dir).isDirectory()) {
  console.error(paint('red', `Not a folder: ${options.dir}`));
  process.exit(1);
}
if (path.parse(options.dir).root === options.dir) {
  console.error(paint('red', 'Refusing to work on the filesystem root. Pick a project folder.'));
  process.exit(1);
}

// ── client build ───────────────────────────────────────────────────────────

function newestMtime(directory, depth = 0) {
  if (depth > 6) return 0;
  let newest = 0;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) newest = Math.max(newest, newestMtime(full, depth + 1));
    else {
      const info = statSync(full, { throwIfNoEntry: false });
      if (info) newest = Math.max(newest, info.mtimeMs);
    }
  }
  return newest;
}

function needsBuild() {
  const index = path.join(REPO_ROOT, 'client', 'dist', 'index.html');
  if (!existsSync(index)) return true;
  const built = statSync(index).mtimeMs;
  const sources = [
    newestMtime(path.join(REPO_ROOT, 'client', 'src')),
    statSync(path.join(REPO_ROOT, 'client', 'index.html')).mtimeMs,
    newestMtime(path.join(REPO_ROOT, 'shared')),
  ];
  return Math.max(...sources) > built;
}

async function ensureBuild() {
  if (!needsBuild()) return;
  console.log(paint('dim', 'Building the office UI (first run or changed sources)…'));
  const code = await new Promise((resolve) => {
    const build = spawn('npm', ['run', 'build'], { cwd: REPO_ROOT, stdio: 'inherit', shell: process.platform === 'win32' });
    build.on('exit', (value) => resolve(value ?? 1));
  });
  if (code !== 0) {
    console.error(paint('red', 'Client build failed. Fix the error above and run again.'));
    process.exit(1);
  }
}

// ── port ───────────────────────────────────────────────────────────────────

function portIsFree(port) {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once('error', () => resolve(false));
    probe.once('listening', () => probe.close(() => resolve(true)));
    probe.listen(port, '127.0.0.1');
  });
}

async function pickPort(preferred) {
  for (let port = preferred; port < preferred + 25; port += 1) {
    if (await portIsFree(port)) return port;
  }
  throw new Error(`No free port between ${preferred} and ${preferred + 25}.`);
}

// ── browser ────────────────────────────────────────────────────────────────

function openBrowser(url) {
  if (!options.open) return;
  const command =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  try {
    const child = spawn(command, [url], { stdio: 'ignore', detached: true, shell: process.platform === 'win32' });
    child.on('error', () => {});
    child.unref();
  } catch {
    /* opening the browser is a convenience, never a requirement */
  }
}

// ── server ─────────────────────────────────────────────────────────────────

let serverProcess = null;
let shuttingDown = false;

function startServer(port) {
  const env = {
    ...process.env,
    OFFICE_PORT: String(port),
    OFFICE_WORKSPACE: options.dir,
    OFFICE_TOOLS: options.tools ? '1' : '0',
    OFFICE_WEB: options.web ? '1' : '0',
  };
  if (options.key) env.OFFICE_API_KEY = options.key;
  if (options.endpoint) env.OFFICE_ENDPOINT = options.endpoint;
  if (options.model) env.OFFICE_MODEL = options.model;
  // --demo must hold from the very first turn. The session flag is set over
  // HTTP later, which used to race with the boot connect and quietly run live.
  if (options.demo) env.OFFICE_DEMO = '1';

  const serverEntry = path.join(REPO_ROOT, 'server', 'src', 'index.ts');
  const envFile = path.join(REPO_ROOT, '.env');
  const args = [];
  if (existsSync(envFile)) args.push(`--env-file=${envFile}`);
  args.push('--experimental-strip-types', serverEntry);

  const child = spawn(process.execPath, args, {
    cwd: REPO_ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const pipe = (stream, isError) => {
    let buffer = '';
    stream.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (line.trim().length === 0) continue;
        if (options.verbose) console.log(paint('dim', `[server] ${line}`));
        else if (isError) console.error(paint('red', `[server] ${line}`));
      }
    });
  };
  pipe(child.stdout, false);
  pipe(child.stderr, true);

  child.on('exit', (code) => {
    if (shuttingDown) return;
    console.error(paint('red', `The office server stopped (code ${code ?? 0}).`));
    process.exit(code === 0 ? 0 : 1);
  });

  return child;
}

/**
 * The server answers /api/session before its boot-time connect finishes.
 * Missions must not start against that half-initialised snapshot, otherwise
 * they run in demo mode even though a key was supplied.
 */
async function waitForConfigured(port, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let snapshot = null;
  while (Date.now() < deadline) {
    try {
      snapshot = await (await fetch(`http://127.0.0.1:${port}/api/session`)).json();
      if (snapshot?.settings?.configured) return snapshot;
      if (snapshot?.settings?.demoMode === false) return snapshot;
    } catch {
      /* keep polling */
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return snapshot;
}

async function waitForServer(port, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/session`);
      if (response.ok) return await response.json();
    } catch {
      /* not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('The office server did not answer in time.');
}

async function api(port, method, route, body) {
  const response = await fetch(`http://127.0.0.1:${port}${route}`, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(payload?.message ?? `HTTP ${response.status}`);
  }
  return payload;
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (serverProcess && serverProcess.exitCode === null) serverProcess.kill('SIGTERM');
  setTimeout(() => process.exit(code), 120);
}

process.on('SIGINT', () => {
  console.log(paint('dim', '\nStopped.'));
  shutdown(0);
});
process.on('SIGTERM', () => shutdown(0));

// ── mission ────────────────────────────────────────────────────────────────

const WEB_MISSION = /\b(web|website|landing|page|html|css|frontend|ui|site)\b/i;

/**
 * A brief that spans several disciplines is worth a team: one worker would have
 * to do all of it alone, and the parts would disagree with each other.
 */
const DOMAIN_HINTS = [
  /\b(web|website|landing|html|css|frontend|ui|dashboard)\b/i,
  /\b(api|backend|server|endpoint|database|auth|schema)\b/i,
  /\b(mobile|android|ios|app|desktop|expo|flutter)\b/i,
  /\b(ai|llm|agent|rag|chatbot|assistant|prompt|embedding|vision)\b/i,
  /\b(ml|model|train|training|dataset|classifier|regression|inference|pipeline)\b/i,
];

function looksLikeTeamMission(mission) {
  const domains = DOMAIN_HINTS.filter((hint) => hint.test(mission)).length;
  return domains >= 2 || // spans disciplines
    (domains >= 1 && /\b(build|create|ship|make)\b.{0,40}\b(app|application|product|platform)\b/i.test(mission));
}

function pickAgent(agents, requested) {
  if (requested) {
    const wanted = agents.find((agent) => agent.name.toLowerCase() === requested.toLowerCase());
    if (!wanted) {
      console.error(
        paint('red', `No worker named "${requested}". Team: ${agents.map((agent) => agent.name).join(', ')}`),
      );
      process.exit(2);
    }
    return wanted;
  }
  const mission = options.mission;
  const byRole = (needle) => agents.find((agent) => agent.role.toLowerCase().includes(needle));
  if (WEB_MISSION.test(mission)) return byRole('frontend') ?? agents[0];
  if (/\b(api|server|backend|database|endpoint|query)\b/i.test(mission)) return byRole('backend') ?? agents[0];
  if (/\b(test|qa|bug|regression)\b/i.test(mission)) return byRole('qa') ?? agents[0];
  if (/\b(data|pipeline|etl|report)\b/i.test(mission)) return byRole('data') ?? agents[0];
  if (/\b(deploy|docker|ci|devops|server)\b/i.test(mission)) return byRole('devops') ?? agents[0];
  return agents[0];
}

function missionDetail() {
  const lines = [
    options.mission,
    '',
    `Workspace folder: ${options.dir}`,
    'Everything you build must live inside that folder. Read the folder before you start so you match',
    'what is already there, then write the real deliverable — no placeholders, no TODO stubs.',
    'Verify your own work before finishing: read the files back and check they are complete and coherent.',
  ];

  if (WEB_MISSION.test(options.mission)) {
    lines.push(
      '',
      'For this web mission deliver a runnable static site inside the folder:',
      '- index.html with semantic sections and real copy (never lorem ipsum)',
      '- styles.css with a deliberate palette, fluid type and responsive layout',
      '- script.js only if the page needs behaviour',
      '- an inline SVG favicon in <head> so the page loads without a 404',
      '- no build step and no npm install; it must open directly in a browser',
      'Finish by reading the files back and confirming every section is finished.',
    );
  }
  return lines.join('\n');
}

function missionTitle() {
  const single = options.mission.replace(/\s+/g, ' ').trim();
  return single.length <= 90 ? single : `${single.slice(0, 87)}…`;
}

async function runMission(port) {
  // Read the session again: the boot-time snapshot predates the model connect,
  // so trusting it made "Engine" and demo detection stale.
  const snapshot = await api(port, 'GET', '/api/session');
  const agents = Array.isArray(snapshot.agents) ? snapshot.agents : [];
  if (agents.length === 0) throw new Error('The office has no workers.');
  const demo = Boolean(snapshot.settings?.demoMode || !snapshot.settings?.configured);

  // --team / --solo win; otherwise a multi-discipline brief gets the team.
  const team = options.team ?? (options.agent ? false : looksLikeTeamMission(options.mission));
  const agent = team ? null : pickAgent(agents, options.agent);

  const task = team
    ? await api(port, 'POST', '/api/missions', {
        title: missionTitle(),
        detail: missionDetail(),
        priority: 'high',
      })
    : await api(port, 'POST', '/api/tasks', {
        title: missionTitle(),
        detail: missionDetail(),
        priority: 'high',
        assigneeId: null,
      });
  const lead = team ? agents.find((entry) => entry.id === task.assigneeId) : null;

  console.log('');
  console.log(`${paint('teal', 'Mission')}  ${paint('bold', task.title)}`);
  if (team) {
    console.log(
      `${paint('teal', 'Team')}     ${lead ? `${lead.name} · ${lead.role}` : 'lead'} + ${Math.max(agents.length - 1, 0)} specialists, working in parallel`,
    );
  } else if (agent) {
    console.log(`${paint('teal', 'Worker')}   ${agent.name} · ${agent.role}`);
  }
  console.log(`${paint('teal', 'Folder')}   ${options.dir}`);
  const engineLabel = !demo
    ? snapshot.settings.model
    : snapshot.settings?.configured
      ? 'demo mode (forced with --demo, no model calls)'
      : 'demo mode (no API key)';
  console.log(`${paint('teal', 'Engine')}   ${engineLabel}`);
  console.log('');

  if (demo) {
    console.log(paint('amber', 'No API key configured — this mission will be simulated, not built.'));
    console.log(paint('dim', 'Paste a key in Settings, or pass --key / set OFFICE_API_KEY.'));
    console.log('');
  }

  // A mission already runs: startMission dispatched it to the lead.
  if (!team && agent) await api(port, 'POST', `/api/tasks/${task.id}/assign`, { agentId: agent.id });

  const startedAt = Date.now();
  // A team mission fans out, so a solo-sized deadline cuts the lead off mid
  // reconciliation. Explicit -t always wins.
  const timeoutMinutes = options.timeoutSet
    ? Math.max(1, options.timeoutMinutes)
    : team
      ? 30
      : Math.max(1, options.timeoutMinutes);
  const deadline = startedAt + timeoutMinutes * 60_000;
  const seen = new Set();
  let finalTask = task;

  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const session = await api(port, 'GET', '/api/session');
    finalTask = session.tasks.find((entry) => entry.id === task.id) ?? finalTask;

    for (const entry of session.logs) {
      if (seen.has(entry.id)) continue;
      seen.add(entry.id);
      if (entry.at < startedAt - 2000) continue;
      const relevant =
        entry.agentId === (agent?.id ?? '') ||
        entry.kind.startsWith('task') ||
        entry.kind.startsWith('mission');
      if (!relevant) continue;
      const clock = new Date(entry.at).toLocaleTimeString([], { hour12: false });
      const colour = entry.level === 'error' ? 'red' : entry.level === 'warn' ? 'amber' : entry.level === 'success' ? 'green' : 'dim';
      console.log(`${paint('dim', clock)} ${paint(colour, entry.message)}`);
    }

    if (finalTask.status === 'done' || finalTask.status === 'blocked') break;
  }

  const seconds = Math.round((Date.now() - startedAt) / 1000);
  console.log('');
  if (finalTask.status === 'done') {
    console.log(paint('green', `Done in ${seconds}s.`));
  } else if (finalTask.status === 'blocked') {
    console.log(paint('amber', `Stopped after ${seconds}s — the worker marked the task blocked.`));
  } else {
    console.log(
      paint(
        'red',
        `Timed out after ${seconds}s — the task is still ${finalTask.status}. Re-run with --keep to watch it on the board.`,
      ),
    );
  }

  if (finalTask.notes.length > 0) {
    console.log('');
    for (const note of finalTask.notes.slice(-3)) console.log(`  ${note}`);
  }
  console.log('');
  console.log(`${paint('dim', 'Office UI:')} http://127.0.0.1:${port}`);

  if (!options.keep) {
    shutdown(finalTask.status === 'done' ? 0 : 1);
  } else {
    console.log(paint('dim', 'Keeping the office running. Ctrl-C to stop.'));
  }
}

// ── boot ───────────────────────────────────────────────────────────────────

await ensureBuild();
const port = await pickPort(options.port);
serverProcess = startServer(port);

let snapshot;
try {
  snapshot = await waitForServer(port);
  const keyExpected = Boolean(options.key || existsSync(path.join(REPO_ROOT, '.env')));
  if (keyExpected && !options.demo && !snapshot.settings?.configured) {
    console.log(paint('dim', 'Connecting to the model endpoint…'));
    snapshot = await waitForConfigured(port);
    if (!snapshot?.settings?.configured) {
      const reason = snapshot?.logs?.find((entry) => entry.kind === 'session.connect_failed')?.message;
      console.error(paint('amber', `Could not connect${reason ? `: ${reason}` : ''}.`));
      console.error(paint('dim', 'Check the key/endpoint, or pass --demo to run scripted workers.'));
    }
  }
} catch (error) {
  console.error(paint('red', error instanceof Error ? error.message : 'Could not start the office.'));
  shutdown(1);
  throw error;
}

if (options.demo && snapshot.settings?.configured) {
  await api(port, 'POST', '/api/session/demo', { enabled: true }).catch(() => {});
}

console.log('');
console.log(`${paint('amber', '┌')} ${paint('bold', 'AegisX Worker')} ${paint('dim', `v${VERSION}`)}`);
console.log(`${paint('amber', '│')} folder  ${options.dir}`);
console.log(`${paint('amber', '│')} office  ${paint('teal', `http://127.0.0.1:${port}`)}`);
console.log(`${paint('amber', '│')} tools   files ${options.tools ? 'on' : 'off'} · web ${options.web ? 'on' : 'off'}`);
console.log(`${paint('amber', '└')} ${paint('dim', 'Ctrl-C to stop')}`);

openBrowser(`http://127.0.0.1:${port}`);

if (options.mission.length > 0) {
  await runMission(port);
} else {
  console.log('');
  console.log(paint('dim', 'Add a mission from the task board, or run: aegisxworker "build a landing page"'));
}
