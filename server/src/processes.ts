import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { JAIL_ENABLED, JAIL_HOME_DIR } from './config.ts';
import { planJail, toolchainRoots } from './jail.ts';
import { toArgv } from './shell.ts';

/**
 * Long-running work a worker starts on purpose: a dev server, a watcher, a
 * build in another folder. `run_command` waits for exit, so it can only ever
 * time out on these — the worker then restarted the server again and again and
 * left orphans behind. This registry gives them a lifecycle: start once, read
 * the output, check the port, stop it.
 *
 * The registry is per office process on purpose. A restarted office does not
 * inherit children (they are started detached), so `port_status` reports what
 * actually listens rather than what a stale file claims.
 */

export interface ManagedProcessView {
  id: string;
  pid: number;
  label: string;
  command: string;
  /** Folder the process was started in. */
  cwd: string;
  startedAt: number;
  running: boolean;
  exitCode: number | null;
  logFile: string;
  port: number | null;
}

/** The stored record. `running` is derived, never kept in sync by hand. */
interface ManagedProcess extends Omit<ManagedProcessView, 'running'> {
  child: ChildProcess;
  tail: string[];
}

const MAX_PROCESSES = 5;
const TAIL_LINES = 200;
const START_WAIT_MS = 700;
const STOP_GRACE_MS = 2000;

const registry = new Map<string, ManagedProcess>();

export class ProcessError extends Error {}

function view(entry: ManagedProcess): ManagedProcessView {
  const { child, tail, ...rest } = entry;
  void child;
  void tail;
  return { ...rest, running: entry.exitCode === null };
}

function findRunningSame(command: string, cwd: string): ManagedProcess | undefined {
  for (const entry of registry.values()) {
    if (entry.exitCode === null && entry.command === command && entry.cwd === cwd) return entry;
  }
  return undefined;
}

/**
 * Starts one detached child. `command` must already have passed the sandbox
 * planner (no redirects, pipes or chaining), and it is spawned as argv — no
 * `sh -c` — so a long-running process cannot expand or execute anything the
 * parser did not see.
 */
export async function startManagedProcess(input: {
  command: string;
  cwd: string;
  label: string;
  logDir: string;
  port?: number | null;
}): Promise<ManagedProcessView> {
  const existing = findRunningSame(input.command, input.cwd);
  if (existing) return view(existing);

  const running = [...registry.values()].filter((entry) => entry.exitCode === null);
  if (running.length >= MAX_PROCESSES) {
    throw new ProcessError(
      `Already managing ${running.length} processes (${running.map((entry) => `${entry.id} ${entry.label}`).join(', ')}). Stop one with stop_process first.`,
    );
  }

  await fs.mkdir(input.logDir, { recursive: true });
  const id = `proc_${randomBytes(4).toString('hex')}`;
  const logFile = path.join(input.logDir, `${id}.log`);
  const stream = (await fs.open(logFile, 'a')).createWriteStream();

  const argv = toArgv(input.command);
  if (!argv.ok) throw new ProcessError(`Could not start the process: ${argv.message}`);
  const [binary, ...args] = argv.argv;
  if (!binary) throw new ProcessError('Could not start the process: the command is empty.');

  // A server is long-lived, so it keeps the network (it has to listen) but not
  // the rest of the filesystem: the workspace is the only writable tree.
  const plan = JAIL_ENABLED
    ? planJail({
        argv: argv.argv,
        cwd: input.cwd,
        root: input.cwd,
        home: JAIL_HOME_DIR,
        net: true,
        readOnly: toolchainRoots(),
        env: input.port ? { PORT: String(input.port) } : {},
      })
    : { ok: false as const, reason: 'the jail is disabled' };

  const child = spawn(plan.ok ? plan.command : (binary as string), plan.ok ? plan.args : args, {
    cwd: plan.ok ? undefined : input.cwd,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: input.port ? String(input.port) : process.env.PORT },
  });
  const jailNote = !plan.ok && JAIL_ENABLED ? `[jail] not sandboxed: ${plan.reason}` : null;

  const entry: ManagedProcess = {
    id,
    pid: child.pid ?? 0,
    label: input.label,
    command: input.command,
    cwd: input.cwd,
    startedAt: Date.now(),
    exitCode: null,
    logFile,
    port: input.port ?? null,
    child,
    tail: [],
  };
  if (jailNote) entry.tail.push(jailNote);
  registry.set(id, entry);

  const capture = (chunk: Buffer): void => {
    const text = chunk.toString();
    stream.write(text);
    for (const line of text.split('\n')) {
      if (line.trim().length === 0) continue;
      entry.tail.push(line.slice(0, 400));
      if (entry.tail.length > TAIL_LINES) entry.tail.shift();
    }
  };
  child.stdout?.on('data', capture);
  child.stderr?.on('data', capture);
  child.on('exit', (code) => {
    entry.exitCode = code ?? -1;
    stream.end();
  });
  child.on('error', (error) => {
    entry.exitCode = -1;
    entry.tail.push(`spawn error: ${error.message}`);
    stream.end();
  });
  child.unref();

  // Give a server a beat to bind (or to crash), so the first observation is
  // usually enough and the worker does not spend a round on "did it start?".
  await new Promise((resolve) => setTimeout(resolve, START_WAIT_MS));
  return view(entry);
}

export function listProcesses(): ManagedProcessView[] {
  return [...registry.values()]
    .sort((left, right) => right.startedAt - left.startedAt)
    .map((entry) => view(entry));
}

export function processLogs(id: string, lines = 80): { entry: ManagedProcessView; text: string } {
  const entry = registry.get(id);
  if (!entry) throw new ProcessError(`No process with id "${id}". port_status lists the ones I manage.`);
  const wanted = Math.min(Math.max(lines, 1), 300);
  const text = entry.tail.slice(-wanted).join('\n');
  return {
    entry: view(entry),
    text: text.length > 0 ? text : 'No output yet.',
  };
}

/** SIGTERM to the whole group, then SIGKILL if it ignores it. */
export async function stopManagedProcess(id: string): Promise<ManagedProcessView> {
  const entry = registry.get(id);
  if (!entry) throw new ProcessError(`No process with id "${id}".`);
  if (entry.exitCode !== null) return view(entry);

  const signal = (name: NodeJS.Signals): void => {
    try {
      process.kill(-entry.pid, name);
    } catch {
      try {
        process.kill(entry.pid, name);
      } catch {
        /* already gone */
      }
    }
  };

  signal('SIGTERM');
  const deadline = Date.now() + STOP_GRACE_MS;
  while (entry.exitCode === null && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (entry.exitCode === null) {
    signal('SIGKILL');
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  entry.exitCode = entry.exitCode ?? -1;
  return view(entry);
}

export async function stopAllProcesses(): Promise<void> {
  await Promise.all(
    [...registry.values()]
      .filter((entry) => entry.exitCode === null)
      .map((entry) => stopManagedProcess(entry.id).catch(() => undefined)),
  );
}

/** True when something accepts TCP connections on the port. */
export function checkPort(port: number, timeoutMs = 600): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: '127.0.0.1' });
    const done = (open: boolean): void => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

/** The pid listening on a port, when `ss` can tell us (same user, no sudo). */
export function portOwner(port: number): Promise<number | null> {
  return new Promise((resolve) => {
    execFile('ss', ['-ltnp', `sport = :${port}`], { timeout: 1500 }, (error, stdout) => {
      if (error) {
        resolve(null);
        return;
      }
      const match = /pid=(\d+)/.exec(stdout);
      resolve(match ? Number(match[1]) : null);
    });
  });
}

export async function describePort(port: number): Promise<{
  port: number;
  listening: boolean;
  ownerPid: number | null;
  managed: ManagedProcessView | null;
}> {
  const [listening, ownerPid] = await Promise.all([checkPort(port), portOwner(port)]);
  const managed = [...registry.values()].find(
    (entry) => entry.exitCode === null && (entry.port === port || entry.pid === ownerPid),
  );
  return { port, listening, ownerPid, managed: managed ? view(managed) : null };
}
