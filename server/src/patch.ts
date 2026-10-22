import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveWithinRoot } from './workspace.ts';

/**
 * A patch is the edit format that survives a real refactor.
 *
 * `edit_file` fails when the snippet drifted by one space, and a model that
 * cannot match the text starts guessing. A unified diff carries its own line
 * numbers, so the same change applies cleanly after other edits moved it — and
 * when one hunk does not fit, the whole patch is refused instead of leaving the
 * file half-rewritten.
 *
 * Applied here, atomically and inside the workspace: every file is verified in
 * memory first, and only a patch whose every hunk fits is written to disk.
 */

export interface PatchedFile {
  path: string;
  hunks: number;
  added: number;
  removed: number;
}

export type PatchOutcome =
  | { ok: true; files: PatchedFile[]; dryRun: boolean }
  | { ok: false; message: string; path?: string; hunk?: number };

interface Hunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  /** Lines with their diff prefix: ' ', '-' or '+'. */
  lines: { kind: ' ' | '-' | '+'; text: string }[];
}

interface FilePatch {
  path: string;
  hunks: Hunk[];
  created: boolean;
}

const HUNK_HEADER = /^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/;

/** Splits one unified diff into per-file patches. */
export function parseUnifiedDiff(diff: string): FilePatch[] | { error: string } {
  const lines = diff.replace(/\r\n/g, '\n').split('\n');
  const files: FilePatch[] = [];
  let current: FilePatch | null = null;
  let hunk: Hunk | null = null;

  for (const line of lines) {
    if (line.startsWith('diff --git ') || line.startsWith('index ') || line.startsWith('new file mode')) {
      continue;
    }

    if (line.startsWith('--- ')) {
      hunk = null;
      current = null;
      continue;
    }

    if (line.startsWith('+++ ')) {
      const raw = line.slice(4).trim().split('\t')[0] ?? '';
      const target = raw.replace(/^[ab]\//, '');
      if (target.length === 0) return { error: 'A +++ header has no path.' };
      current = { path: target, hunks: [], created: false };
      files.push(current);
      continue;
    }

    const header = HUNK_HEADER.exec(line);
    if (header?.[1] && header[3]) {
      if (!current) return { error: `A hunk appears before any +++ file header: ${line}` };
      hunk = {
        oldStart: Number(header[1]),
        oldLines: header[2] ? Number(header[2]) : 1,
        newStart: Number(header[3]),
        lines: [],
      };
      current.hunks.push(hunk);
      continue;
    }

    if (!hunk) continue;
    if (line.startsWith('\\')) continue; // "\ No newline at end of file"

    const kind = line[0];
    if (kind === ' ' || kind === '-' || kind === '+') {
      hunk.lines.push({ kind, text: line.slice(1) });
      continue;
    }
    if (line.length === 0) {
      // A blank context line is legal in a diff and often loses its space.
      hunk.lines.push({ kind: ' ', text: '' });
    }
  }

  if (files.length === 0) return { error: 'No file headers (---/+++) found in the patch.' };
  return files;
}

/** Applies one hunk to a line buffer, or reports where it stopped matching. */
function applyHunk(
  lines: string[],
  hunk: Hunk,
  cursor: number,
): { ok: true; lines: string[]; next: number } | { ok: false } {
  const oldBlock = hunk.lines.filter((line) => line.kind !== '+').map((line) => line.text);
  const newBlock = hunk.lines.filter((line) => line.kind !== '-').map((line) => line.text);

  const matchesAt = (index: number): boolean =>
    index >= 0 && index + oldBlock.length <= lines.length
      ? oldBlock.every((text, offset) => lines[index + offset] === text)
      : false;

  // The line numbers are a hint: look at the expected place first, then around
  // it, which is what makes a patch survive edits elsewhere in the file.
  const expected = Math.max(0, hunk.oldStart - 1);
  const candidates: number[] = [expected, cursor];
  for (let distance = 1; distance <= 200; distance += 1) {
    candidates.push(expected - distance, expected + distance);
  }

  let index = -1;
  for (const candidate of candidates) {
    if (candidate < cursor - 200) continue;
    if (matchesAt(candidate)) {
      index = candidate;
      break;
    }
  }
  if (index === -1) return { ok: false };

  const next = [...lines.slice(0, index), ...newBlock, ...lines.slice(index + oldBlock.length)];
  return { ok: true, lines: next, next: index + newBlock.length };
}

/**
 * Applies a whole unified diff. Nothing is written unless every file and every
 * hunk fits — a half-applied patch is worse than a refused one.
 */
export async function applyUnifiedDiff(
  root: string,
  diff: string,
  options: { dryRun?: boolean } = {},
): Promise<PatchOutcome> {
  const parsed = parseUnifiedDiff(diff);
  if ('error' in parsed) return { ok: false, message: parsed.error };
  if (parsed.length === 0) return { ok: false, message: 'The patch is empty.' };

  const results: PatchedFile[] = [];
  const writes: { absolute: string; content: string }[] = [];

  for (const file of parsed) {
    let absolute: string;
    try {
      absolute = await resolveWithinRoot(root, file.path);
    } catch (error) {
      return {
        ok: false,
        path: file.path,
        message: error instanceof Error ? error.message : `Cannot resolve ${file.path}`,
      };
    }

    const existing = await fs.readFile(absolute, 'utf8').catch(() => null);
    if (existing === null) {
      return {
        ok: false,
        path: file.path,
        message: `${file.path} does not exist. Create it with write_file, or make the patch a new file with --- /dev/null.`,
      };
    }

    const trailingNewline = existing.endsWith('\n');
    const lines = existing.split('\n');
    if (trailingNewline) lines.pop();

    let current = lines;
    let cursor = 0;
    for (let index = 0; index < file.hunks.length; index += 1) {
      const hunk = file.hunks[index];
      if (!hunk) continue;
      const applied = applyHunk(current, hunk, cursor);
      if (applied.ok === false) {
        return {
          ok: false,
          path: file.path,
          hunk: index + 1,
          message: `Hunk ${index + 1} of ${file.path} does not match the file. Re-read the file and regenerate that hunk.`,
        };
      }
      current = applied.lines;
      cursor = applied.next;
    }

    const added = file.hunks.reduce(
      (total, hunk) => total + hunk.lines.filter((line) => line.kind === '+').length,
      0,
    );
    const removed = file.hunks.reduce(
      (total, hunk) => total + hunk.lines.filter((line) => line.kind === '-').length,
      0,
    );

    writes.push({ absolute, content: current.join('\n') + (trailingNewline ? '\n' : '') });
    results.push({ path: file.path, hunks: file.hunks.length, added, removed });
  }

  if (!options.dryRun) {
    for (const write of writes) {
      await fs.mkdir(path.dirname(write.absolute), { recursive: true });
      await fs.writeFile(write.absolute, write.content, 'utf8');
    }
  }

  return { ok: true, files: results, dryRun: options.dryRun === true };
}

/** A one-line summary of what a patch would do, for the tool observation. */
export function describePatch(files: PatchedFile[]): string {
  return files
    .map((file) => `${file.path} (+${file.added}/-${file.removed}, ${file.hunks} hunk(s))`)
    .join(', ');
}
