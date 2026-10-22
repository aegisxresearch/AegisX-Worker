import fs from 'node:fs/promises';
import path from 'node:path';
import { STATE_DIR } from './config.ts';

/** Raised when a path or root folder breaks the workspace boundary. */
export class WorkspaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkspaceError';
  }
}

export interface DirectoryEntry {
  name: string;
  path: string;
}

export interface DirectoryListing {
  path: string;
  parent: string | null;
  entries: DirectoryEntry[];
}

/** Normalises a user supplied root folder and rejects unusable roots. */
export function normaliseRoot(candidate: string): string {
  const trimmed = candidate.trim();
  if (trimmed.length === 0) throw new WorkspaceError('Workspace folder is required.');
  const resolved = path.resolve(trimmed.replace(/^~(?=$|\/)/, process.env.HOME ?? '~'));
  const filesystemRoot = path.parse(resolved).root;
  if (resolved === filesystemRoot) {
    throw new WorkspaceError('Refusing to use the filesystem root as the workspace folder.');
  }
  if (resolved.length < 3) {
    throw new WorkspaceError('That folder is too close to the filesystem root.');
  }
  return resolved;
}

/** Creates the folder when it is missing so the office always has a home. */
export async function ensureRoot(root: string): Promise<void> {
  const stat = await fs.stat(root).catch(() => null);
  if (stat) {
    if (!stat.isDirectory()) throw new WorkspaceError(`${root} is not a folder.`);
    return;
  }
  await fs.mkdir(root, { recursive: true });
}

/**
 * Resolves a path inside the workspace.
 * Absolute paths are only allowed when they already live inside the root, and
 * symlinks that point outside the root are rejected.
 */
export async function resolveWithinRoot(root: string, target: string): Promise<string> {
  const trimmed = target.trim();
  if (trimmed.length === 0) throw new WorkspaceError('Path must not be empty.');

  const resolved = path.isAbsolute(trimmed) ? path.resolve(trimmed) : path.resolve(root, trimmed);
  if (!isInside(root, resolved)) {
    throw new WorkspaceError('Path escapes the workspace folder.');
  }

  const realRoot = await fs.realpath(root).catch(() => root);
  const realTarget = await fs.realpath(resolved).catch(() => resolved);
  if (!isInside(realRoot, realTarget)) {
    throw new WorkspaceError('Path escapes the workspace folder (symlink).');
  }
  return resolved;
}

/** True when `candidate` is `root` itself or lives below it. */
export function isInside(root: string, candidate: string): boolean {
  const boundary = root.endsWith(path.sep) ? root : root + path.sep;
  return candidate === root || candidate.startsWith(boundary);
}

/** Lists the folders inside `directory` for the folder picker. */
export async function listDirectories(directory: string): Promise<DirectoryListing> {
  const absolute = path.resolve(directory);
  const entries = await fs.readdir(absolute, { withFileTypes: true });
  const folders: DirectoryEntry[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.')) continue;
    folders.push({ name: entry.name, path: path.join(absolute, entry.name) });
  }
  folders.sort((left, right) => left.name.localeCompare(right.name));

  const parent = path.dirname(absolute);
  return {
    path: absolute,
    parent: parent === absolute ? null : parent,
    entries: folders,
  };
}

/**
 * The folder the operator picked last time. It lives beside the rest of the
 * office state, so a check that brings its own state folder also gets its own
 * pick — and can never inherit the operator's real project by accident.
 */
export const WORKSPACE_STATE_FILE = path.join(STATE_DIR, 'workspace.json');

/** Reads the workspace folder the operator picked in a previous session. */
export async function loadSavedRoot(): Promise<string | null> {
  const raw = await fs.readFile(WORKSPACE_STATE_FILE, 'utf8').catch(() => null);
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    const root = (parsed as { root?: unknown }).root;
    return typeof root === 'string' && root.length > 0 ? root : null;
  } catch {
    return null;
  }
}

/** Persists the workspace folder so it survives a restart. */
export async function saveRoot(root: string): Promise<void> {
  await fs.mkdir(path.dirname(WORKSPACE_STATE_FILE), { recursive: true });
  await fs.writeFile(WORKSPACE_STATE_FILE, `${JSON.stringify({ root }, null, 2)}\n`, 'utf8');
}
