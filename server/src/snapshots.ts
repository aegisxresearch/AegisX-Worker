import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Per-turn snapshots of the workspace.
 *
 * They live in a *shadow* bare repo under the office state directory, never in
 * the operator's repository: an agent that commits into someone's history is
 * intrusive, and a folder that is not a repo at all still deserves an undo.
 *
 * A snapshot is a full tree, so restoring one is exact — files edited, added or
 * deleted during a turn all go back, while ignored paths (`node_modules`, the
 * office's own state) are left alone.
 */
export interface Snapshot {
  root: string;
  /** Bare repo holding every snapshot of this workspace. */
  gitDir: string;
  /** Commit id of the snapshot. */
  ref: string;
  label: string;
}

export interface SnapshotOutcome {
  snapshot: Snapshot | null;
  reason: string | null;
}

export interface RevertOutcome {
  ok: boolean;
  message: string;
  /** Paths that differ between the restored state and the one it replaced. */
  changed: string[];
}

/** Junk that must never be snapshotted: it is large, generated, or ours. */
const EXCLUDED_PATHS = [
  'node_modules/',
  'dist/',
  'build/',
  '.next/',
  '.venv/',
  '__pycache__/',
  '.agent-office/',
  '*.log',
];

interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

/**
 * One writer at a time per workspace. Two agents finishing together would
 * otherwise interleave `add`/`commit` on the same index and corrupt it.
 */
const queues = new Map<string, Promise<unknown>>();

function serialise<T>(gitDir: string, task: () => Promise<T>): Promise<T> {
  const previous = queues.get(gitDir) ?? Promise.resolve();
  const next = previous.then(task, task);
  queues.set(
    gitDir,
    next.catch(() => undefined),
  );
  return next;
}

/**
 * Git is pointed at the shadow repo through its environment.
 * `--git-dir <path>` on the command line is not accepted by every subcommand
 * (`git init` in particular rejects a work tree without a dir it parsed), and
 * the env form cannot be mis-parsed.
 */
function gitEnv(root: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: root,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
  };
}

function exec(bin: string, args: string[], env: NodeJS.ProcessEnv): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile(
      bin,
      args,
      { timeout: 30_000, maxBuffer: 8 * 1024 * 1024, env },
      (error, stdout, stderr) => resolve({ ok: !error, stdout: stdout.trim(), stderr: stderr.trim() }),
    );
  });
}

function runGit(gitDir: string, root: string, args: string[]): Promise<GitResult> {
  return exec('git', args, { ...gitEnv(root), GIT_DIR: gitDir, GIT_WORK_TREE: root });
}

/** Stable, filesystem-safe name for one workspace's snapshot repo. */
export function snapshotRepoPath(stateDir: string, root: string): string {
  const id = crypto.createHash('sha1').update(path.resolve(root)).digest('hex').slice(0, 16);
  return path.join(stateDir, 'snapshots', id);
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function ensureRepo(gitDir: string, root: string, stateDir: string): Promise<string | null> {
  if (!(await exists(path.join(gitDir, 'HEAD')))) {
    await fs.mkdir(path.dirname(gitDir), { recursive: true });
    // `init` must run without GIT_WORK_TREE: a bare repo has no work tree.
    const init = await exec('git', ['init', '-q', '--bare', gitDir], gitEnv(root));
    if (!init.ok) return `git init failed: ${init.stderr.slice(0, 200)}`;
  }

  const infoDir = path.join(gitDir, 'info');
  await fs.mkdir(infoDir, { recursive: true });
  const excludes = [...EXCLUDED_PATHS];
  // The snapshot repo itself may sit inside the workspace (default state dir).
  const relativeState = path.relative(root, stateDir);
  if (relativeState.length > 0 && !relativeState.startsWith('..') && !path.isAbsolute(relativeState)) {
    excludes.push(`${relativeState.split(path.sep).join('/')}/`);
  }
  await fs.writeFile(path.join(infoDir, 'exclude'), `${excludes.join('\n')}\n`, 'utf8');
  return null;
}

async function commitAll(gitDir: string, root: string, message: string): Promise<GitResult> {
  const added = await runGit(gitDir, root, ['add', '-A']);
  if (!added.ok) return added;
  return runGit(gitDir, root, [
    '-c',
    'user.name=AegisX Snapshot',
    '-c',
    'user.email=snapshot@aegisx.local',
    'commit',
    '-q',
    '--allow-empty',
    '-m',
    message.slice(0, 200),
  ]);
}

/**
 * Captures the folder as it is right now. Cheap enough to run once per turn:
 * ignored paths are skipped and only changed blobs are written.
 */
export async function takeSnapshot(
  root: string,
  stateDir: string,
  label: string,
): Promise<SnapshotOutcome> {
  const gitDir = snapshotRepoPath(stateDir, root);
  return serialise(gitDir, async () => {
    const failure = await ensureRepo(gitDir, root, stateDir);
    if (failure) return { snapshot: null, reason: failure };

    const commit = await commitAll(gitDir, root, `snapshot: ${label}`);
    if (!commit.ok) return { snapshot: null, reason: `snapshot commit failed: ${commit.stderr.slice(0, 200)}` };

    const head = await runGit(gitDir, root, ['rev-parse', 'HEAD']);
    if (!head.ok || head.stdout.length === 0) return { snapshot: null, reason: 'no HEAD after snapshot' };
    return { snapshot: { root, gitDir, ref: head.stdout, label }, reason: null };
  });
}

/** Paths that differ between two snapshots, as `status path` lines. */
export async function diffSnapshots(from: Snapshot, to: Snapshot): Promise<string[]> {
  const diff = await runGit(from.gitDir, from.root, [
    'diff',
    '--name-status',
    from.ref,
    to.ref,
  ]);
  if (!diff.ok || diff.stdout.length === 0) return [];
  return diff.stdout.split('\n').filter((line) => line.trim().length > 0);
}

/**
 * Puts the folder back exactly as it was at `snapshot`.
 *
 * The current mess is committed first (into the shadow repo only) so that files
 * the turn *created* are tracked and therefore removed by the reset — a plain
 * `reset --hard` leaves untracked files behind and an undo that keeps the new
 * files is not an undo.
 */
export async function revertToSnapshot(snapshot: Snapshot): Promise<RevertOutcome> {
  return serialise(snapshot.gitDir, async () => {
    const failure = await ensureRepo(snapshot.gitDir, snapshot.root, path.dirname(snapshot.gitDir));
    if (failure) return { ok: false, message: failure, changed: [] };

    const current = await commitAll(snapshot.gitDir, snapshot.root, 'snapshot: state before revert');
    if (!current.ok) {
      return { ok: false, message: `could not snapshot the current state: ${current.stderr.slice(0, 200)}`, changed: [] };
    }
    const currentRef = await runGit(snapshot.gitDir, snapshot.root, ['rev-parse', 'HEAD']);
    const changed: string[] = [];
    if (currentRef.ok && currentRef.stdout.length > 0) {
      const diff = await runGit(snapshot.gitDir, snapshot.root, [
        'diff',
        '--name-status',
        snapshot.ref,
        currentRef.stdout,
      ]);
      if (diff.ok && diff.stdout.length > 0) changed.push(...diff.stdout.split('\n').filter(Boolean));
    }

    const reset = await runGit(snapshot.gitDir, snapshot.root, ['reset', '--hard', snapshot.ref]);
    if (!reset.ok) {
      return { ok: false, message: `reset failed: ${reset.stderr.slice(0, 200)}`, changed };
    }
    return { ok: true, message: `Restored the folder to ${snapshot.ref.slice(0, 8)}.`, changed };
  });
}
