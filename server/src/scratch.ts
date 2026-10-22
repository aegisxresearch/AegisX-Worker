import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * What counts as a scratch file.
 *
 * The prompt tells workers to delete the files they created to check something
 * (`probe-*`, `qa-*`, `tmp-*`, `verify-*`, logs, pid files, `out.txt`). Those
 * names are the contract: if a worker wants to keep a file, it has to give it a
 * name that belongs to the project. A real test suite lives in `tests/`, which
 * is never scanned, so `tests/auth.test.mjs` is safe while `probe-auth.mjs` in
 * the project root is not.
 *
 * The gate never deletes anything itself. It reports the list and sends the
 * turn back, because only the worker knows whether a file is its own scrap or
 * something the task asked for.
 */

/** Directory names that never hold an agent's scratch work. */
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.cache',
  '.npm',
  '.venv',
  'venv',
  'env',
  '__pycache__',
  'dist',
  'build',
  'coverage',
  '.next',
  '.agent-office',
  'tests',
  'test',
  'spec',
  '__tests__',
]);

const SCRATCH_PREFIXES = [
  'probe',
  'tmp-',
  'tmp_',
  'temp-',
  'temp_',
  'scratch',
  'verify-',
  'verify_',
  'qa-probe',
  'qa-tmp',
];

const SCRATCH_SUFFIXES = ['.log', '.tmp', '.bak', '.pid', '.out', '.orig', '.rej', '.swp', '.swo'];

/** Exact names that are scratch by construction, whatever the extension. */
const SCRATCH_NAMES = new Set(['out.txt', 'output.txt', 'nohup.out', 'probe', 'probe.js', 'probe.mjs', 'probe.cjs', 'probe.py']);

/** A stray `probe.cjs` / `probe-http.js` / `qa-run.txt`, but not `product.md`. */
export function isScratchName(basename: string): boolean {
  const name = basename.toLowerCase();
  if (SCRATCH_NAMES.has(name)) return true;
  if (name.endsWith('~')) return true;
  if (SCRATCH_SUFFIXES.some((suffix) => name.endsWith(suffix))) return true;
  // `qa-` is only scratch when it is a throwaway script or text dump; a
  // `qa/` folder of checked-in tests is a deliverable and is skipped anyway.
  if (/^qa-.*\.(mjs|cjs|js|ts|py|sh|txt)$/.test(name)) return true;
  return SCRATCH_PREFIXES.some((prefix) => name.startsWith(prefix));
}

export interface ScratchScan {
  /** Workspace-relative paths, POSIX separators, sorted. */
  files: string[];
  /** True when the walk hit its cap and the list may be incomplete. */
  truncated: boolean;
}

const MAX_DEPTH = 4;
const MAX_ENTRIES = 4000;

/**
 * Walks the workspace and lists scratch files. Bounded in depth and entries so
 * a huge folder cannot stall a completion, and symlinks are never followed.
 */
export async function findScratchFiles(root: string): Promise<ScratchScan> {
  const files: string[] = [];
  let seen = 0;
  let truncated = false;

  async function walk(directory: string, depth: number): Promise<void> {
    if (depth > MAX_DEPTH || truncated) return;
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (truncated) return;
      seen += 1;
      if (seen > MAX_ENTRIES) {
        truncated = true;
        return;
      }
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        const name = entry.name;
        if (SKIP_DIRS.has(name) || name.startsWith('.')) continue;
        await walk(path.join(directory, name), depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!isScratchName(entry.name)) continue;
      const relative = path.relative(root, path.join(directory, entry.name));
      files.push(relative.split(path.sep).join('/'));
    }
  }

  await walk(root, 0);
  files.sort();
  return { files, truncated };
}

/** One line for the model and the operator: what is left, and where. */
export function describeScratch(scan: ScratchScan, limit = 12): string {
  if (scan.files.length === 0) return '';
  const shown = scan.files.slice(0, limit).join(', ');
  const rest = scan.files.length - Math.min(scan.files.length, limit);
  return rest > 0 ? `${shown} (+${rest} more)` : shown;
}
