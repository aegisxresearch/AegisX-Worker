import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';

/**
 * Optimistic concurrency for read → write.
 *
 * A per-call lock stops two writes from interleaving; it does not stop the
 * lost update: A reads, B writes, A writes its stale copy, and B's edit is
 * gone with no error. This tracker remembers the hash of what each worker read.
 * Before a mutation the file is hashed again, and a mismatch is a refusal that
 * tells the worker to re-read — the difference between "your edit vanished" and
 * "someone changed this while you were working".
 */

const seen = new Map<string, Map<string, string>>();

export function ownerKey(agentId: string, taskId: string | null): string {
  return `${agentId}\u0000${taskId ?? ''}`;
}

export function contentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 16);
}

function bucket(owner: string): Map<string, string> {
  const existing = seen.get(owner);
  if (existing) return existing;
  const fresh = new Map<string, string>();
  seen.set(owner, fresh);
  return fresh;
}

/** Called after a successful read: this is the version the worker now knows. */
export function rememberRead(owner: string, absolutePath: string, content: string): void {
  bucket(owner).set(absolutePath, contentHash(content));
}

/** Drops what a worker believes about one path (used after a write we cannot hash). */
export function forgetRead(owner: string, absolutePath: string): void {
  bucket(owner).delete(absolutePath);
}

export interface StaleFile {
  absolutePath: string;
  /** True when the file existed when read and is gone now. */
  missing: boolean;
}

/**
 * Paths this worker read that have changed on disk since.
 *
 * A file the worker never read is not stale: `write_file` on a new path is
 * legitimate. Only a remembered hash can go stale.
 */
export async function staleReads(owner: string, absolutePaths: string[]): Promise<StaleFile[]> {
  const known = seen.get(owner);
  if (!known || known.size === 0) return [];

  const stale: StaleFile[] = [];
  for (const absolutePath of [...new Set(absolutePaths)]) {
    const remembered = known.get(absolutePath);
    if (remembered === undefined) continue;
    const current = await fs.readFile(absolutePath, 'utf8').catch(() => null);
    if (current === null) {
      stale.push({ absolutePath, missing: true });
      continue;
    }
    if (contentHash(current) !== remembered) stale.push({ absolutePath, missing: false });
  }
  return stale;
}

/** Re-reads the files a mutation just touched, so the next edit starts from truth. */
export async function refreshAfterWrite(owner: string, absolutePaths: string[]): Promise<void> {
  for (const absolutePath of absolutePaths) {
    const current = await fs.readFile(absolutePath, 'utf8').catch(() => null);
    if (current === null) forgetRead(owner, absolutePath);
    else rememberRead(owner, absolutePath, current);
  }
}

/** Only for checks. */
export function resetReadTracker(): void {
  seen.clear();
}
