/**
 * One git worktree per task, so two workers can never overwrite each other.
 *
 * The per-path lock stops two writes at the same instant, and the stale-read
 * guard stops a write based on an old copy — but neither stops the case both
 * guards are blind to: worker A reads, worker B reads, both write minutes apart
 * and the later one silently erases the other. Isolation is the only fix that
 * does not depend on timing.
 *
 * A task gets its own checkout of the folder:
 *
 *   main folder ──(HEAD + uncommitted files)──▶ worktree per task
 *                                                     │ worker edits here
 *                                                     ▼
 *                                        land: copy back, or report a conflict
 *
 * The worktree is built from `HEAD` *and* the folder's uncommitted files, so a
 * worker sees exactly what the operator sees — not an older commit. The synced
 * state is committed on a detached HEAD inside the worktree as the task's
 * baseline; that commit is what makes "what did this task change" exact, and it
 * never touches the operator's branches.
 *
 * Landing is deliberately a copy, not a merge: the office must not invent
 * commits on the operator's branch. It runs inside the merge queue, compares
 * each file against the baseline before touching it, and refuses the whole
 * landing when the main folder changed the same file meanwhile.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** How long a git call may take before the office gives up on isolation. */
const GIT_TIMEOUT_MS = 20_000;

/** Marks a file that does not exist, so "absent" compares as a value. */
const ABSENT = 'absent';

/**
 * Folders the office writes for itself: screenshots, shadow-repo state, its own
 * bookkeeping. They are not the task's work, so they never land in the operator's
 * folder and never show up in the reviewer's diff.
 */
const OFFICE_FOLDERS = ['.agent-office', '.aegisx'];

function isOfficeArtifact(relativePath: string): boolean {
  const normalised = relativePath.replace(/^\.\//, '');
  return OFFICE_FOLDERS.some((folder) => normalised === folder || normalised.startsWith(`${folder}/`));
}

export type IsolationProblem =
  | 'not_a_repo'
  | 'repo_not_root'
  | 'office_checkpoint'
  | 'git_missing'
  | 'create_failed';

export interface IsolatedWorktree {
  taskId: string;
  /** Absolute path of the checkout the worker writes in. */
  path: string;
  /** The main folder this task will land into. */
  mainRoot: string;
  /** Detached commit holding the tree as the task first saw it. */
  baseline: string;
  /** Files copied in from the main folder's uncommitted state. */
  copiedFiles: string[];
}

export type IsolationResult =
  | { ok: true; worktree: IsolatedWorktree }
  | { ok: false; reason: IsolationProblem; detail: string };

export interface LandingConflict {
  path: string;
  problem: string;
}

export interface LandingResult {
  ok: boolean;
  /** Files written into the main folder. */
  landed: string[];
  /** Files removed from the main folder. */
  deleted: string[];
  /** Office-owned files the task produced that were deliberately left behind. */
  skipped: string[];
  conflicts: LandingConflict[];
  detail: string;
}

interface GitOutcome {
  ok: boolean;
  stdout: string;
  stderr: string;
}

async function git(cwd: string, args: string[]): Promise<GitOutcome> {
  try {
    const { stdout, stderr } = await run('git', args, {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    });
    return { ok: true, stdout, stderr };
  } catch (error) {
    const failed = error as { stdout?: string; stderr?: string; code?: string; message?: string };
    return {
      ok: false,
      stdout: typeof failed.stdout === 'string' ? failed.stdout : '',
      stderr: typeof failed.stderr === 'string' && failed.stderr.length > 0 ? failed.stderr : (failed.message ?? ''),
    };
  }
}

/** A task id is used as a folder name, so only safe characters survive. */
function worktreeFolder(taskId: string): string {
  return taskId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 60);
}

async function hashFile(file: string): Promise<string> {
  const bytes = await fs.readFile(file).catch(() => null);
  if (bytes === null) return ABSENT;
  return createHash('sha256').update(bytes).digest('hex');
}

/** The bytes of one path in a commit, or ABSENT when the commit lacks it. */
async function baselineHash(worktreePath: string, baseline: string, relative: string): Promise<string> {
  const shown = await run('git', ['-C', worktreePath, 'show', `${baseline}:${relative}`], {
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
    encoding: 'buffer',
  }).catch(() => null);
  if (shown === null) return ABSENT;
  const buffer = Buffer.isBuffer(shown.stdout) ? shown.stdout : Buffer.from(String(shown.stdout));
  return createHash('sha256').update(buffer).digest('hex');
}

/** `git status --porcelain -z`, reduced to the paths a worktree has to carry. */
function parseStatusPaths(raw: string): { path: string; deleted: boolean }[] {
  const entries: { path: string; deleted: boolean }[] = [];
  const tokens = raw.split('\u0000');
  for (const token of tokens) {
    if (token.length < 4) continue;
    const status = token.slice(0, 2);
    const filePath = token.slice(3);
    // A rename lists the old and new path as separate NUL tokens; the office
    // never renames through a tool, so treat it as "this path is involved".
    if (status.includes('R')) continue;
    entries.push({ path: filePath, deleted: status.includes('D') });
  }
  return entries;
}

/**
 * Creates the checkout for one task. Fails closed with a reason the caller can
 * log: a folder that is not a git repository, or not the repository's root,
 * simply runs without isolation instead of silently behaving differently.
 */
export async function createIsolatedWorktree(input: {
  mainRoot: string;
  taskId: string;
  baseDir: string;
}): Promise<IsolationResult> {
  const mainRoot = path.resolve(input.mainRoot);
  const inside = await git(mainRoot, ['rev-parse', '--is-inside-work-tree']);
  if (!inside.ok) {
    const missing = /not a git repository|not recognized|ENOENT|spawn git/i.test(inside.stderr);
    return {
      ok: false,
      reason: missing ? 'git_missing' : 'not_a_repo',
      detail: inside.stderr.split('\n')[0] || 'git could not read this folder',
    };
  }
  if (inside.stdout.trim() !== 'true') {
    return { ok: false, reason: 'not_a_repo', detail: 'git does not treat this folder as a working tree' };
  }

  const top = await git(mainRoot, ['rev-parse', '--show-toplevel']);
  const resolvedTop = top.ok ? await fs.realpath(top.stdout.trim()).catch(() => top.stdout.trim()) : '';
  const resolvedMain = await fs.realpath(mainRoot).catch(() => mainRoot);
  if (resolvedTop !== resolvedMain) {
    return {
      ok: false,
      reason: 'repo_not_root',
      detail: resolvedTop.length > 0 ? `the repository root is ${resolvedTop}` : 'the repository root could not be read',
    };
  }

  // A repository the office created for checkpoints is undo machinery, not the
  // operator's project. Branching it per task would make every task land through
  // a gate the folder never asked for.
  const officeMarker = await fs
    .stat(path.join(resolvedMain, '.git', 'aegisx-checkpoint'))
    .then(() => true, () => false);
  if (officeMarker) {
    return {
      ok: false,
      reason: 'office_checkpoint',
      detail: 'the office created this repository for per-turn undo',
    };
  }

  const head = await git(mainRoot, ['rev-parse', 'HEAD']);
  if (!head.ok) {
    return { ok: false, reason: 'not_a_repo', detail: 'the repository has no commit yet' };
  }

  const target = path.join(input.baseDir, worktreeFolder(input.taskId));
  await fs.rm(target, { recursive: true, force: true });
  await fs.mkdir(input.baseDir, { recursive: true });
  // A task that was blocked keeps its checkout; if the same task runs again the
  // folder is gone but git still has it registered, and `worktree add` refuses.
  await git(mainRoot, ['worktree', 'prune']);

  const added = await git(mainRoot, ['worktree', 'add', '--detach', target, head.stdout.trim()]);
  if (!added.ok) {
    return { ok: false, reason: 'create_failed', detail: added.stderr.split('\n')[0] || 'git worktree add failed' };
  }

  // Carry the operator's uncommitted work into the checkout. Without this the
  // worker would read an older tree than the person looking at the folder.
  const status = await git(mainRoot, ['status', '--porcelain', '-z', '--untracked-files=all']);
  if (!status.ok) {
    await git(mainRoot, ['worktree', 'remove', '--force', target]);
    return { ok: false, reason: 'create_failed', detail: status.stderr.split('\n')[0] || 'git status failed' };
  }

  const copied: string[] = [];
  for (const entry of parseStatusPaths(status.stdout)) {
    const source = path.join(mainRoot, entry.path);
    const destination = path.join(target, entry.path);
    if (entry.deleted) {
      await fs.rm(destination, { force: true });
      continue;
    }
    await fs.mkdir(path.dirname(destination), { recursive: true });
    const copiedOk = await fs.copyFile(source, destination).then(
      () => true,
      () => false,
    );
    if (copiedOk) copied.push(entry.path);
  }

  // Everything the worker starts from becomes one detached commit, so later
  // "what changed" is a diff against a real tree instead of a guess.
  const staged = await git(target, ['add', '-A']);
  if (!staged.ok) {
    await git(mainRoot, ['worktree', 'remove', '--force', target]);
    return { ok: false, reason: 'create_failed', detail: staged.stderr.split('\n')[0] || 'git add failed' };
  }
  const committed = await git(target, [
    '-c',
    'user.name=AegisX Worker',
    '-c',
    'user.email=worker@localhost',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '--no-verify',
    '-m',
    `aegisx: baseline for ${input.taskId}`,
  ]);
  if (!committed.ok && !/nothing to commit/i.test(committed.stdout + committed.stderr)) {
    await git(mainRoot, ['worktree', 'remove', '--force', target]);
    return { ok: false, reason: 'create_failed', detail: committed.stderr.split('\n')[0] || 'git commit failed' };
  }

  const baselineRef = await git(target, ['rev-parse', 'HEAD']);
  if (!baselineRef.ok) {
    await git(mainRoot, ['worktree', 'remove', '--force', target]);
    return { ok: false, reason: 'create_failed', detail: 'the baseline commit could not be read' };
  }

  return {
    ok: true,
    worktree: {
      taskId: input.taskId,
      path: target,
      mainRoot,
      baseline: baselineRef.stdout.trim(),
      copiedFiles: copied,
    },
  };
}

/** Parses `git diff --name-status --no-renames` into status/path pairs. */
function parseChanges(raw: string): { status: string; path: string }[] {
  const changes: { status: string; path: string }[] = [];
  for (const line of raw.split('\n')) {
    const match = /^([AMDTUXB])\t(.+)$/.exec(line);
    if (match?.[1] && match[2]) changes.push({ status: match[1], path: match[2] });
  }
  return changes;
}

/**
 * Copies this task's changes into the main folder.
 *
 * `git add -A` is run first so files the worker created but never staged are
 * part of the diff. Every target is compared to the baseline before it is
 * touched: if the main folder's copy is no longer what the task started from,
 * the landing is refused whole, because a half-applied change is worse than a
 * clear conflict.
 */
export async function landWorktree(worktree: IsolatedWorktree): Promise<LandingResult> {
  const { path: worktreePath, mainRoot, baseline } = worktree;
  const staged = await git(worktreePath, ['add', '-A']);
  if (!staged.ok) {
    return {
      ok: false,
      landed: [],
      deleted: [],
      skipped: [],
      conflicts: [{ path: '.', problem: 'the task checkout could not be read' }],
      detail: staged.stderr.split('\n')[0] || 'git add failed',
    };
  }

  const diff = await git(worktreePath, ['diff', '--name-status', '--no-renames', baseline]);
  if (!diff.ok) {
    return {
      ok: false,
      landed: [],
      deleted: [],
      skipped: [],
      conflicts: [{ path: '.', problem: 'the task checkout could not be compared' }],
      detail: diff.stderr.split('\n')[0] || 'git diff failed',
    };
  }

  const changes = parseChanges(diff.stdout);
  if (changes.length === 0) {
    return { ok: true, landed: [], deleted: [], skipped: [], conflicts: [], detail: 'The task changed nothing.' };
  }

  const conflicts: LandingConflict[] = [];
  const skipped: string[] = [];
  const toWrite: { relative: string; remove: boolean }[] = [];
  for (const change of changes) {
    // Screenshots and shadow-repo state belong to the office, not to the task's
    // deliverable. Copying them into the operator's folder would be noise, and
    // two tasks previewing the same page would collide on the same PNG.
    if (isOfficeArtifact(change.path)) {
      skipped.push(change.path);
      continue;
    }
    const mainFile = path.join(mainRoot, change.path);
    const currentHash = await hashFile(mainFile);
    const startedFrom = await baselineHash(worktreePath, baseline, change.path);
    if (currentHash !== startedFrom) {
      conflicts.push({
        path: change.path,
        problem:
          startedFrom === ABSENT
            ? 'a file with this name appeared in the folder while the task ran'
            : currentHash === ABSENT
              ? 'the file was deleted in the folder while the task ran'
              : 'the folder changed this file while the task ran',
      });
      continue;
    }
    toWrite.push({ relative: change.path, remove: change.status === 'D' });
  }

  if (conflicts.length > 0) {
    return {
      ok: false,
      landed: [],
      deleted: [],
      skipped,
      conflicts,
      detail: conflicts.map((entry) => `${entry.path}: ${entry.problem}`).join('\n'),
    };
  }

  const landed: string[] = [];
  const deleted: string[] = [];
  try {
    for (const entry of toWrite) {
      const mainFile = path.join(mainRoot, entry.relative);
      if (entry.remove) {
        await fs.rm(mainFile, { force: true });
        deleted.push(entry.relative);
        continue;
      }
      await fs.mkdir(path.dirname(mainFile), { recursive: true });
      await fs.copyFile(path.join(worktreePath, entry.relative), mainFile);
      landed.push(entry.relative);
    }
  } catch (error) {
    return {
      ok: false,
      landed,
      deleted,
      skipped,
      conflicts: [{ path: '.', problem: 'landing failed part-way' }],
      detail: error instanceof Error ? error.message : 'unknown copy error',
    };
  }

  return {
    ok: true,
    landed,
    deleted,
    skipped,
    conflicts: [],
    detail: [
      landed.length > 0 ? `Copied: ${landed.join(', ')}.` : '',
      deleted.length > 0 ? `Deleted: ${deleted.join(', ')}.` : '',
    ]
      .filter((line) => line.length > 0)
      .join(' '),
  };
}

/**
 * Removes a checkout. The detached baseline commit makes the worktree safe to
 * delete at any point: the operator's branch and index were never touched.
 */
export async function discardWorktree(worktree: IsolatedWorktree): Promise<void> {
  const removed = await git(worktree.mainRoot, ['worktree', 'remove', '--force', worktree.path]);
  if (!removed.ok) {
    await fs.rm(worktree.path, { recursive: true, force: true });
    await git(worktree.mainRoot, ['worktree', 'prune']);
  }
  // The refused version was only there to be redone; a landed task no longer
  // needs it, and leaving it behind would grow without bound.
  await fs.rm(conflictCopiesDir(worktree), { recursive: true, force: true });
}

/**
 * Brings a task's copy back in line with the folder after a refused landing.
 *
 * The worker's version of each conflicting file is kept beside the checkout
 * (outside it, so it never becomes part of a later landing), the folder's
 * version is copied in, and the checkout is re-baselined. The worker can then
 * redo its change on top of the current text instead of on top of a stale one.
 */
/**
 * Where a worker's refused version is kept. Beside the checkouts, not inside
 * them: `worktrees/` must only ever contain trees git is tracking.
 */
function conflictCopiesDir(worktree: IsolatedWorktree): string {
  const checkouts = path.dirname(worktree.path);
  return path.join(path.dirname(checkouts), 'worktree-conflicts', path.basename(worktree.path));
}

export async function refreshAfterConflict(
  worktree: IsolatedWorktree,
  files: string[],
): Promise<{ refreshed: string[]; preserved: string[] }> {
  const keepDir = conflictCopiesDir(worktree);
  const refreshed: string[] = [];
  const preserved: string[] = [];

  for (const relative of files) {
    const inCheckout = path.join(worktree.path, relative);
    const inFolder = path.join(worktree.mainRoot, relative);
    const checkoutHas = await fs.stat(inCheckout).then(() => true, () => false);
    if (checkoutHas) {
      const keep = path.join(keepDir, relative);
      await fs.mkdir(path.dirname(keep), { recursive: true });
      await fs.copyFile(inCheckout, keep);
      preserved.push(keep);
    }
    const folderHas = await fs.stat(inFolder).then(() => true, () => false);
    if (folderHas) {
      await fs.mkdir(path.dirname(inCheckout), { recursive: true });
      await fs.copyFile(inFolder, inCheckout);
    } else {
      await fs.rm(inCheckout, { force: true });
    }
    refreshed.push(relative);
  }

  const staged = await git(worktree.path, ['add', '-A']);
  if (staged.ok) {
    await git(worktree.path, [
      '-c',
      'user.name=AegisX Worker',
      '-c',
      'user.email=worker@localhost',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '--no-verify',
      '-m',
      `aegisx: refresh ${worktree.taskId} after a refused landing`,
    ]);
    const head = await git(worktree.path, ['rev-parse', 'HEAD']);
    if (head.ok) worktree.baseline = head.stdout.trim();
  }

  return { refreshed, preserved };
}

/**
 * The task's changes as a unified diff, for the independent reviewer.
 *
 * A folder that was never a repo has a checkpoint commit; a real repository has
 * neither a checkpoint nor a branch the office may touch — but it does have this
 * checkout, so its baseline commit is the diff source. Office-owned files are
 * excluded: a reviewer should judge the deliverable, not a screenshot.
 */
export async function worktreeDiff(worktree: IsolatedWorktree, maxChars = 12_000): Promise<string> {
  const staged = await git(worktree.path, ['add', '-A']);
  if (!staged.ok) return '';
  const diff = await git(worktree.path, [
    'diff',
    '--no-color',
    '--no-ext-diff',
    '--no-renames',
    worktree.baseline,
    '--',
    '.',
    ':(exclude).agent-office',
    ':(exclude).agent-office/**',
    ':(exclude).aegisx',
    ':(exclude).aegisx/**',
  ]);
  if (!diff.ok) return '';
  const text = diff.stdout.trim();
  if (text.length === 0) return '';
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n… (diff truncated at ${maxChars} of ${text.length} characters; judge the change, not the whole tree)`;
}

export interface CheckoutGcRemoval {
  taskId: string;
  path: string;
  reason: string;
}

export interface CheckoutGcOutcome {
  removed: CheckoutGcRemoval[];
  kept: number;
}

/**
 * Reclaims old checkouts without ever touching a running task's tree.
 *
 * A blocked task keeps its checkout on purpose — it is the only copy of that
 * work — so something has to bound the disk. Two rules, both conservative: an
 * eligible task's checkout goes after `olderThanMs`, and if the folder still
 * holds more than `keepAtMost`, the oldest eligible ones go first. A task that
 * is still running is never a candidate, however old its folder looks.
 */
export async function collectStaleCheckouts(input: {
  mainRoot: string;
  baseDir: string;
  eligibleTaskIds: Set<string>;
  olderThanMs?: number;
  keepAtMost?: number;
  now?: number;
}): Promise<CheckoutGcOutcome> {
  const olderThanMs = input.olderThanMs ?? 7 * 24 * 60 * 60 * 1000;
  const keepAtMost = Math.max(0, input.keepAtMost ?? 20);
  const now = input.now ?? Date.now();

  const entries = await fs.readdir(input.baseDir, { withFileTypes: true }).catch(() => []);
  const checkouts: { taskId: string; path: string; mtimeMs: number }[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const checkoutPath = path.join(input.baseDir, entry.name);
    const stat = await fs.stat(checkoutPath).catch(() => null);
    if (!stat) continue;
    checkouts.push({ taskId: entry.name, path: checkoutPath, mtimeMs: stat.mtimeMs });
  }
  checkouts.sort((left, right) => left.mtimeMs - right.mtimeMs);

  const removed: CheckoutGcRemoval[] = [];
  const keep: typeof checkouts = [];
  for (const checkout of checkouts) {
    const eligible = input.eligibleTaskIds.has(checkout.taskId);
    if (eligible && now - checkout.mtimeMs >= olderThanMs) {
      removed.push({ ...checkout, reason: `older than ${Math.round(olderThanMs / 86_400_000)} day(s)` });
      continue;
    }
    keep.push(checkout);
  }

  while (keep.length > keepAtMost) {
    const index = keep.findIndex((checkout) => input.eligibleTaskIds.has(checkout.taskId));
    if (index < 0) break;
    const [checkout] = keep.splice(index, 1);
    if (checkout) removed.push({ ...checkout, reason: `over the ${keepAtMost}-checkout cap` });
  }

  for (const checkout of removed) {
    await fs.rm(checkout.path, { recursive: true, force: true });
    await fs.rm(path.join(path.dirname(input.baseDir), 'worktree-conflicts', checkout.taskId), {
      recursive: true,
      force: true,
    });
  }
  if (removed.length > 0) await git(input.mainRoot, ['worktree', 'prune']);

  return { removed, kept: keep.length };
}

/** Files the task touched, for logs and notes. Empty when the checkout is gone. */
export async function changedInWorktree(worktree: IsolatedWorktree): Promise<string[]> {
  const staged = await git(worktree.path, ['add', '-A']);
  if (!staged.ok) return [];
  const diff = await git(worktree.path, ['diff', '--name-only', '--no-renames', worktree.baseline]);
  if (!diff.ok) return [];
  return diff.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !isOfficeArtifact(line));
}
