import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';

/**
 * The merge gate between "my checks passed" and "this task is done".
 *
 * A worker verifies its work, then the reviewer and the visual critic read it —
 * seconds during which another worker can rewrite one of the files that was
 * just verified. Marking the task done at that point claims a green tree that
 * no longer exists. This gate hashes the files the task wrote at verification
 * time and compares them again at the merge point, under a queue so two
 * completions cannot interleave their check-and-mark.
 *
 * It is not filesystem isolation: the tree is still shared. It is the part that
 * makes the shared tree safe to finish in — a task cannot report success on a
 * state that changed underneath it.
 */

type Job<T> = () => Promise<T>;

/** Runs jobs one at a time, in submission order. */
export class MergeQueue {
  #tail: Promise<unknown> = Promise.resolve();

  run<T>(job: Job<T>): Promise<T> {
    const next = this.#tail.then(job, job);
    // A failed job must not stall the queue for the next completion.
    this.#tail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
}

/** Content hash per absolute path; a missing file hashes to an empty marker. */
export async function hashPaths(absolutePaths: string[]): Promise<Map<string, string>> {
  const hashes = new Map<string, string>();
  for (const absolutePath of [...new Set(absolutePaths)]) {
    const content = await fs.readFile(absolutePath).catch(() => null);
    hashes.set(absolutePath, content === null ? '' : createHash('sha256').update(content).digest('hex').slice(0, 16));
  }
  return hashes;
}

/**
 * Paths whose content differs between the baseline and now.
 *
 * A file that was deleted counts as changed: a task verified against a file
 * cannot be merged after someone removed it.
 */
export function changedPaths(baseline: Map<string, string>, current: Map<string, string>): string[] {
  const changed: string[] = [];
  for (const [absolutePath, hash] of baseline) {
    const now = current.get(absolutePath);
    if (now === undefined || now !== hash) changed.push(absolutePath);
  }
  return changed.sort();
}
