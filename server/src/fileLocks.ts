import path from 'node:path';

/**
 * Per-file write locks.
 *
 * The office runs several workers at once and they share one folder. Nothing
 * stopped two of them from writing the same file in the same second: each call
 * awaited the filesystem, so the writes interleaved and the last one won, which
 * is how a correct edit disappears without any error.
 *
 * A lock is held for the duration of one tool call, not one turn. That is the
 * honest scope: it serialises writes to the same path and turns a silent
 * overwrite into a retryable refusal. It does not make read-modify-write
 * atomic; a worker that read a file before another wrote it still holds stale
 * text. The refusal names the holder so the runtime can say who to wait for.
 */

interface Holder {
  owner: string;
  at: number;
}

const held = new Map<string, Holder>();

/**
 * A command can write anywhere in the folder, so it cannot name its paths.
 * It takes one coarse lock instead: while it runs, no worker writes a file, and
 * while any worker writes, no command starts. Coarse on purpose — a false
 * "wait" is cheaper than a build and an edit colliding.
 */
const FOLDER_SUFFIX = '\u0000folder';

function folderKey(root: string): string {
  return `${path.resolve(root)}${FOLDER_SUFFIX}`;
}

/** How long a lock may exist before it is treated as abandoned by a crashed call. */
const STALE_MS = 60_000;

function keyFor(root: string, relative: string): string {
  return path.resolve(root, relative);
}

export interface LockResult {
  ok: boolean;
  /** Keys acquired, so the caller can release exactly what it took. */
  keys: string[];
  conflict?: { path: string; owner: string };
}

/**
 * Acquires every path or none of them. All-or-nothing matters for a patch:
 * taking half the files and then refusing would leave the caller holding locks
 * it will not use.
 */
export function acquirePaths(root: string, paths: string[], owner: string): LockResult {
  const keys = [...new Set(paths.filter((entry) => entry.trim().length > 0).map((entry) => keyFor(root, entry)))].sort();
  if (keys.length === 0) return { ok: true, keys: [] };

  const now = Date.now();
  const scope = held.get(folderKey(root));
  if (scope && scope.owner !== owner && now - scope.at <= STALE_MS) {
    return { ok: false, keys: [], conflict: { path: 'the whole folder (a command is running)', owner: scope.owner } };
  }
  for (const key of keys) {
    const current = held.get(key);
    if (!current) continue;
    if (current.owner === owner) continue;
    if (now - current.at > STALE_MS) {
      // The holder never released: it threw somewhere without a finally, or the
      // process is gone. Reclaim rather than block the team forever.
      held.delete(key);
      continue;
    }
    return { ok: false, keys: [], conflict: { path: path.relative(root, key) || key, owner: current.owner } };
  }

  for (const key of keys) held.set(key, { owner, at: now });
  return { ok: true, keys };
}

/**
 * The folder-wide lock a shell command takes. Refused while any other worker
 * holds a file, so a command never runs against a file being rewritten.
 */
export function acquireFolder(root: string, owner: string): LockResult {
  const now = Date.now();
  for (const [key, holder] of held) {
    if (holder.owner === owner) continue;
    if (now - holder.at > STALE_MS) {
      held.delete(key);
      continue;
    }
    const relative = key.endsWith(FOLDER_SUFFIX) ? 'the whole folder' : path.relative(root, key) || key;
    return { ok: false, keys: [], conflict: { path: relative, owner: holder.owner } };
  }
  const key = folderKey(root);
  held.set(key, { owner, at: now });
  return { ok: true, keys: [key] };
}

/** Releases locks this owner actually holds; another owner's lock is left alone. */
export function releasePaths(keys: string[], owner: string): void {
  for (const key of keys) {
    if (held.get(key)?.owner === owner) held.delete(key);
  }
}

/** True when a worker other than `owner` is writing somewhere in the folder. */
export function otherWriterActive(owner: string): boolean {
  const now = Date.now();
  for (const holder of held.values()) {
    if (holder.owner !== owner && now - holder.at <= STALE_MS) return true;
  }
  return false;
}

/** Test and diagnostics hook: who holds this path, if anyone. */
export function holderOf(root: string, relative: string): string | null {
  return held.get(keyFor(root, relative))?.owner ?? null;
}

/** Only for checks: drops every lock without pretending a release happened. */
export function resetLocks(): void {
  held.clear();
}
