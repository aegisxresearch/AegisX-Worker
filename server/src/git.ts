import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

export interface Checkpoint {
  root: string;
  /** Commit the worker's diff is measured against. */
  ref: string;
  label: string;
}

export interface CheckpointOutcome {
  checkpoint: Checkpoint | null;
  /** Why no checkpoint was taken, when that is the case. */
  reason: string | null;
}

interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

/** Junk that must never land in a checkpoint commit. */
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

function runGit(root: string, args: string[]): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['-C', root, ...args],
      {
        timeout: 30_000,
        maxBuffer: 4 * 1024 * 1024,
        env: {
          PATH: process.env.PATH ?? '/usr/bin:/bin',
          HOME: root,
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_TERMINAL_PROMPT: '0',
        },
      },
      (error, stdout, stderr) => {
        resolve({ ok: !error, stdout: stdout.trim(), stderr: stderr.trim() });
      },
    );
  });
}

async function repoTopLevel(root: string): Promise<string | null> {
  const result = await runGit(root, ['rev-parse', '--show-toplevel']);
  if (!result.ok || result.stdout.length === 0) return null;
  return path.resolve(result.stdout);
}

/** Keeps checkpoints out of the user's `git status` noise without editing their files. */
async function writeLocalExcludes(root: string): Promise<void> {
  const excludeFile = path.join(root, '.git', 'info', 'exclude');
  try {
    const current = await fs.readFile(excludeFile, 'utf8');
    const present = new Set(current.split('\n').map((line) => line.trim()));
    const additions = EXCLUDED_PATHS.filter((entry) => !present.has(entry));
    if (additions.length === 0) return;
    await fs.writeFile(excludeFile, `${current.trimEnd()}\n${additions.join('\n')}\n`, 'utf8');
  } catch {
    /* excludes are a convenience, never a requirement */
  }
}

/**
 * Takes a checkpoint commit before the worker starts.
 *
 * Only a folder that is *not* a repo yet gets one: writing commits into a
 * repository the operator already owns is intrusive, so that case is reported
 * and skipped rather than done silently.
 */
export async function createCheckpoint(root: string, label: string): Promise<CheckpointOutcome> {
  const existingTopLevel = await repoTopLevel(root);
  if (existingTopLevel !== null) {
    const reason =
      path.resolve(existingTopLevel) === path.resolve(root)
        ? 'the folder is already a git repo — no automatic commit was made'
        : 'the folder sits inside a larger git repo — no automatic commit was made';
    return { checkpoint: null, reason };
  }

  const init = await runGit(root, ['init', '-q']);
  if (!init.ok) return { checkpoint: null, reason: `git init failed: ${init.stderr.slice(0, 200)}` };
  await writeLocalExcludes(root);

  await runGit(root, ['add', '-A']);
  const commit = await runGit(root, [
    '-c',
    'user.name=AegisX Worker',
    '-c',
    'user.email=worker@aegisx.local',
    'commit',
    '-q',
    '--allow-empty',
    '-m',
    `aegisx: baseline before ${label}`.slice(0, 200),
  ]);
  if (!commit.ok) {
    return { checkpoint: null, reason: `checkpoint commit failed: ${commit.stderr.slice(0, 200)}` };
  }

  const head = await runGit(root, ['rev-parse', 'HEAD']);
  if (!head.ok || head.stdout.length === 0) return { checkpoint: null, reason: 'no HEAD after checkpoint' };
  return { checkpoint: { root, ref: head.stdout, label }, reason: null };
}

/**
 * What the worker actually changed since its checkpoint, in diff form.
 * New files count: they are staged before the diff so `--cached` reports them.
 */
export async function summariseChanges(checkpoint: Checkpoint): Promise<string> {
  await runGit(checkpoint.root, ['add', '-A']);
  const shortstat = await runGit(checkpoint.root, ['diff', '--cached', '--shortstat', checkpoint.ref]);
  const stat = await runGit(checkpoint.root, ['diff', '--cached', '--stat', checkpoint.ref]);

  const lines = stat.stdout.split('\n').filter((line) => line.trim().length > 0);
  const head = shortstat.stdout.length > 0 ? shortstat.stdout : 'No changes.';
  if (lines.length <= 1) return head;
  const shown = lines.slice(0, 24);
  const omitted = lines.length - shown.length;
  return [head, ...shown, omitted > 0 ? `… ${omitted} more file(s)` : ''].filter(Boolean).join('\n');
}
