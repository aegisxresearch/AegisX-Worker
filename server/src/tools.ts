import { exec } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { COMMAND_TIMEOUT_MS, MAX_FILE_BYTES, READ_WINDOW_LINES } from './config.ts';
import type { OfficeStation, TaskPriority } from '../../shared/types.ts';
import { captureScreenshot } from './preview.ts';
import { isInside, resolveWithinRoot, WorkspaceError } from './workspace.ts';
import { webFetch, webSearch, WebError } from './web.ts';

/** Above this a read has to be windowed: the whole file would flood the model. */
const HARD_READ_LIMIT = 4 * 1024 * 1024;

export interface AgentAction {
  action: string;
  [key: string]: unknown;
}

export interface ActionContext {
  agentId: string;
  agentName: string;
  taskId: string | null;
  /** True when the operator granted filesystem and shell access. */
  toolsEnabled: boolean;
  /** True when the operator granted outbound web access. */
  webEnabled: boolean;
  /** The folder the agent may read and write inside. */
  workspaceRoot: string;
}

export interface ActionResult {
  ok: boolean;
  /** One-line, human readable outcome used in the activity log. */
  summary: string;
  /** Optional speech-bubble text shown above the agent in 3D. */
  speech?: string;
  /** Raw payload handed back to the model on the follow-up turn. */
  detail?: string;
  /** Suggested follow-up steps, shown to the model and the activity log. */
  nextActions?: string[];
  /** Files or URLs the action produced. */
  artifacts?: string[];
  /** Whether the agent loop should continue after this action. */
  followUp: boolean;
}

const STATIONS: OfficeStation[] = ['desk', 'meeting', 'coffee', 'board', 'lounge'];

const PRIORITIES: TaskPriority[] = ['low', 'medium', 'high', 'urgent'];

const ALLOWED_COMMANDS = [
  'ls',
  'cat',
  'pwd',
  'echo',
  'head',
  'tail',
  'wc',
  'find',
  'grep',
  'node',
  'npm',
  'npx',
  'git',
  'python3',
  'sed',
  'awk',
  'date',
  'du',
  'tree',
  'which',
  'rg',
  'lsb_release',
  'uname',
  'whoami',
  'env',
  'printenv',
];

/** Shell metacharacters that could escape the allowlist and chain commands. */
const FORBIDDEN_TOKENS = ['&&', '||', ';', '|', '`', '$(', '>', '<', '\n', '\r', '&'];

function assertText(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string') throw new Error(`"${field}" must be a string`);
  const trimmed = value.trim();
  if (trimmed.length === 0) throw new Error(`"${field}" must not be empty`);
  return trimmed.slice(0, maxLength);
}

function readString(args: Record<string, unknown>, field: string, maxLength: number): string {
  return assertText(args[field], field, maxLength);
}

function readOptionalString(
  args: Record<string, unknown>,
  field: string,
  maxLength: number,
): string | undefined {
  const value = args[field];
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed.slice(0, maxLength);
}

interface EditOutcome {
  ok: boolean;
  updated: string;
  strategy: string;
}

function replaceFirst(haystack: string, needle: string, replacement: string): string {
  const index = haystack.indexOf(needle);
  if (index < 0) return haystack;
  return haystack.slice(0, index) + replacement + haystack.slice(index + needle.length);
}

/**
 * Finds `search` as a run of lines that match after trimming. This keeps an
 * edit working when the model's copy drifted on indentation or trailing
 * spaces — the two reasons a byte-exact match fails on a file it just read.
 */
function locateBlock(contentLines: string[], searchLines: string[]): number {
  if (searchLines.length === 0 || searchLines.length > contentLines.length) return -1;
  const wanted = searchLines.map((line) => line.trim());
  const lastStart = contentLines.length - searchLines.length;
  for (let start = 0; start <= lastStart; start += 1) {
    let matches = true;
    for (let offset = 0; offset < wanted.length; offset += 1) {
      if ((contentLines[start + offset] ?? '').trim() !== wanted[offset]) {
        matches = false;
        break;
      }
    }
    if (matches) return start;
  }
  return -1;
}

function applyEdit(
  content: string,
  search: string,
  replacement: string,
  replaceAll: boolean,
): EditOutcome {
  // Exact substring first: unambiguous, and it keeps CRLF/indentation intact.
  if (replaceAll && content.includes(search)) {
    const occurrences = content.split(search).length - 1;
    return {
      ok: true,
      updated: content.split(search).join(replacement),
      strategy: ` (exact, ${occurrences} occurrence(s))`,
    };
  }
  if (!replaceAll && content.includes(search)) {
    return { ok: true, updated: replaceFirst(content, search, replacement), strategy: ' (exact)' };
  }

  const contentLines = content.split('\n');
  const searchLines = search.replace(/\r\n/g, '\n').split('\n');
  const start = locateBlock(contentLines, searchLines);
  if (start < 0) return { ok: false, updated: content, strategy: '' };

  const replacementLines = replacement.replace(/\r\n/g, '\n').split('\n');
  // An empty replacement deletes the block rather than leaving a blank line.
  if (replacement.length === 0) replacementLines.length = 0;
  contentLines.splice(start, searchLines.length, ...replacementLines);
  return { ok: true, updated: contentLines.join('\n'), strategy: ' (matched ignoring indentation)' };
}

/** Points the model at the lines that most resemble a failed search string. */
function nearestLines(content: string, search: string): string {
  const firstSearchLine = search.split('\n')[0]?.trim() ?? '';
  const tokens = firstSearchLine.split(/\s+/).filter((token) => token.length > 2);
  if (tokens.length === 0) return '';

  const lines = content.split('\n');
  const scored: { index: number; score: number }[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const text = lines[index] ?? '';
    let score = 0;
    for (const token of tokens) {
      if (text.includes(token)) score += 1;
    }
    if (score > 0) scored.push({ index, score });
  }

  return scored
    .sort((left, right) => right.score - left.score)
    .slice(0, 3)
    .sort((left, right) => left.index - right.index)
    .map((entry) => `  ${entry.index + 1}: ${(lines[entry.index] ?? '').trim().slice(0, 140)}`)
    .join('\n');
}

function readNumber(args: Record<string, unknown>, field: string, fallback: number): number {
  const value = args[field];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

async function runSandboxedCommand(
  command: string,
  workspaceRoot: string,
): Promise<{ ok: boolean; output: string }> {
  for (const token of FORBIDDEN_TOKENS) {
    if (command.includes(token)) {
      return { ok: false, output: `Command rejected: "${token}" is not allowed in the sandbox.` };
    }
  }
  const binary = command.trim().split(/\s+/)[0] ?? '';
  if (!ALLOWED_COMMANDS.includes(binary)) {
    return {
      ok: false,
      output: `Command rejected: "${binary}" is not on the allowlist (${ALLOWED_COMMANDS.join(', ')}).`,
    };
  }

  // Allowlisted binaries can still be pointed at files outside the folder.
  // Absolute paths and `..` hops are rejected so the chosen folder stays the
  // real boundary, not just the working directory.
  for (const rawToken of command.split(/\s+/)) {
    const token = rawToken.replace(/^['"]|['"]$/g, '');
    if (token.length === 0) continue;
    if (token.split('/').includes('..')) {
      return { ok: false, output: 'Command rejected: ".." hops outside the workspace are not allowed.' };
    }
    if (token.startsWith('/') && !isInside(workspaceRoot, path.resolve(token))) {
      return {
        ok: false,
        output: `Command rejected: ${token} is outside the workspace folder.`,
      };
    }
  }
  return new Promise((resolve) => {
    exec(
      command,
      {
        cwd: workspaceRoot,
        timeout: COMMAND_TIMEOUT_MS,
        maxBuffer: MAX_FILE_BYTES,
        env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: workspaceRoot },
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolve({ ok: true, output: stdout.slice(0, 4000) });
          return;
        }
        // Exit code 1 with an empty stderr is the usual "no matches" result
        // (grep, diff, …) — not a failure, so the agent does not retry it.
        const exitCode = typeof error.code === 'number' ? error.code : null;
        if (exitCode === 1 && stderr.trim() === '') {
          resolve({ ok: true, output: stdout.slice(0, 4000) || 'No matches.' });
          return;
        }
        resolve({ ok: false, output: (stderr || error.message).slice(0, 4000) });
      },
    );
  });
}

async function listDirectory(root: string, relative: string): Promise<string> {
  const absolute = await resolveWithinRoot(root, relative);
  const entries = await fs.readdir(absolute, { withFileTypes: true });
  const lines: string[] = [];
  for (const entry of entries.slice(0, 300)) {
    if (entry.name.startsWith('.')) continue;
    const suffix = entry.isDirectory() ? '/' : '';
    const size = entry.isFile() ? ` (${(await fs.stat(path.join(absolute, entry.name))).size} B)` : '';
    lines.push(`${entry.name}${suffix}${size}`);
  }
  if (lines.length === 0) return 'The folder is empty.';
  return lines.join('\n');
}

async function searchFiles(
  root: string,
  pattern: string,
  searchPath: string,
  maxHits: number,
): Promise<string> {
  const absolute = await resolveWithinRoot(root, searchPath);
  const needle = pattern.toLowerCase();
  const hits: string[] = [];

  const walk = async (directory: string, depth: number): Promise<void> => {
    if (hits.length >= maxHits || depth > 6) return;
    const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (hits.length >= maxHits) return;
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(full, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      const stat = await fs.stat(full).catch(() => null);
      if (!stat || stat.size > MAX_FILE_BYTES) continue;
      const content = await fs.readFile(full, 'utf8').catch(() => null);
      if (content === null) continue;
      const lines = content.split('\n');
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index] ?? '';
        if (line.toLowerCase().includes(needle)) {
          hits.push(`${path.relative(root, full)}:${index + 1}: ${line.trim().slice(0, 200)}`);
          if (hits.length >= maxHits) return;
        }
      }
    }
  };

  await walk(absolute, 0);
  if (hits.length === 0) return `No matches for "${pattern}".`;
  return hits.join('\n');
}

function relativeLabel(root: string, absolute: string): string {
  const relative = path.relative(root, absolute);
  return relative.length > 0 ? relative : '.';
}

/**
 * Executes a single office action.
 * `handlers` lets the runtime own state mutations while tools.ts owns the sandbox.
 */
export async function executeAction(
  action: AgentAction,
  context: ActionContext,
  handlers: {
    moveTo: (station: OfficeStation) => string;
    setStatus: (status: 'idle' | 'working' | 'blocked' | 'error' | 'meeting', reason: string) => string;
    completeTask: (summary: string) => string;
    addNote: (text: string) => string;
    createTask: (title: string, detail: string, priority: TaskPriority, assignee?: string) => string;
  },
): Promise<ActionResult> {
  const args = action as Record<string, unknown>;

  try {
    switch (action.action) {
      case 'move_to': {
        const station = readString(args, 'station', 32) as OfficeStation;
        if (!STATIONS.includes(station)) {
          return { ok: false, summary: `Unknown station "${station}".`, followUp: true };
        }
        return { ok: true, summary: handlers.moveTo(station), followUp: true };
      }

      case 'set_status': {
        const status = readString(args, 'status', 24) as
          | 'idle'
          | 'working'
          | 'blocked'
          | 'error'
          | 'meeting';
        if (!['idle', 'working', 'blocked', 'error', 'meeting'].includes(status)) {
          return { ok: false, summary: `Unknown status "${status}".`, followUp: true };
        }
        const reason = readOptionalString(args, 'reason', 240) ?? '';
        return { ok: true, summary: handlers.setStatus(status, reason), followUp: true };
      }

      case 'complete_task': {
        const summary = readString(args, 'summary', 1200);
        return { ok: true, summary: handlers.completeTask(summary), followUp: false };
      }

      case 'add_note': {
        const text = readString(args, 'text', 1200);
        return { ok: true, summary: handlers.addNote(text), followUp: true };
      }

      case 'create_task': {
        const title = readString(args, 'title', 160);
        const detail = readOptionalString(args, 'detail', 2000) ?? '';
        const priorityRaw = readOptionalString(args, 'priority', 12) ?? 'medium';
        const priority = (PRIORITIES as string[]).includes(priorityRaw)
          ? (priorityRaw as TaskPriority)
          : 'medium';
        const assignee = readOptionalString(args, 'assignee', 60);
        return {
          ok: true,
          summary: handlers.createTask(title, detail, priority, assignee),
          followUp: true,
        };
      }

      case 'speak': {
        const text = readString(args, 'text', 140);
        // A spoken line is decoration, not a decision. During a task the worker
        // must keep going — ending the turn here used to strand finished work
        // as "blocked" because the model said its piece before complete_task.
        return { ok: true, summary: `Said: ${text}`, speech: text, followUp: context.taskId === null };
      }

      // ── filesystem tools ──────────────────────────────────────────────────

      case 'list_directory': {
        if (!context.toolsEnabled) {
          return { ok: false, summary: 'File access is disabled for this session.', followUp: true };
        }
        const relative = readOptionalString(args, 'path', 240) ?? '.';
        const listing = await listDirectory(context.workspaceRoot, relative);
        return {
          ok: true,
          summary: `Listed ${relative} in the workspace.`,
          detail: listing,
          artifacts: [relative],
          nextActions: ['read_file', 'search_files'],
          followUp: true,
        };
      }

      case 'read_file': {
        if (!context.toolsEnabled) {
          return { ok: false, summary: 'File access is disabled for this session.', followUp: true };
        }
        const relativePath = readString(args, 'path', 240);
        const absolute = await resolveWithinRoot(context.workspaceRoot, relativePath);
        const stat = await fs.stat(absolute);
        if (stat.isDirectory()) {
          const listing = await listDirectory(context.workspaceRoot, relativePath);
          return {
            ok: true,
            summary: `${relativePath} is a folder.`,
            detail: listing,
            artifacts: [relativePath],
            followUp: true,
          };
        }
        if (stat.size > HARD_READ_LIMIT) {
          return {
            ok: false,
            summary: `File is too large to read (${stat.size} bytes). Search it instead.`,
            followUp: true,
          };
        }

        const content = await fs.readFile(absolute, 'utf8');
        const lines = content.split('\n');
        const totalLines = lines.length;
        const firstLine = Math.min(Math.max(Math.round(readNumber(args, 'offset', 1)), 1), totalLines);
        const requestedLimit = Math.round(readNumber(args, 'limit', READ_WINDOW_LINES));
        // A zero/negative limit means "everything you can give me", not "one line".
        const wantedLines = Math.min(
          requestedLimit > 0 ? requestedLimit : READ_WINDOW_LINES,
          READ_WINDOW_LINES,
        );
        const lastLine = Math.min(firstLine + wantedLines - 1, totalLines);
        const window = lines.slice(firstLine - 1, lastLine).join('\n');
        const more =
          lastLine < totalLines
            ? ` — call read_file again with offset=${lastLine + 1} to continue`
            : '';

        return {
          ok: true,
          summary: `Read ${relativePath} (lines ${firstLine}-${lastLine} of ${totalLines}).`,
          detail: `${relativePath} — lines ${firstLine}-${lastLine} of ${totalLines}${more}\n\n${window}`,
          artifacts: [relativePath],
          nextActions: ['edit_file', 'write_file'],
          followUp: true,
        };
      }

      case 'write_file': {
        if (!context.toolsEnabled) {
          return { ok: false, summary: 'File access is disabled for this session.', followUp: true };
        }
        const relativePath = readString(args, 'path', 240);
        const content = typeof args.content === 'string' ? args.content.slice(0, MAX_FILE_BYTES) : '';
        const absolute = await resolveWithinRoot(context.workspaceRoot, relativePath);
        await fs.mkdir(path.dirname(absolute), { recursive: true });
        await fs.writeFile(absolute, content, 'utf8');
        return {
          ok: true,
          summary: `Wrote ${relativePath} (${content.length} bytes).`,
          artifacts: [relativeLabel(context.workspaceRoot, absolute)],
          nextActions: ['read_file', 'run_command'],
          followUp: true,
        };
      }

      case 'append_file': {
        if (!context.toolsEnabled) {
          return { ok: false, summary: 'File access is disabled for this session.', followUp: true };
        }
        const relativePath = readString(args, 'path', 240);
        const content = typeof args.content === 'string' ? args.content.slice(0, MAX_FILE_BYTES) : '';
        const absolute = await resolveWithinRoot(context.workspaceRoot, relativePath);
        await fs.mkdir(path.dirname(absolute), { recursive: true });
        await fs.appendFile(absolute, content, 'utf8');
        return {
          ok: true,
          summary: `Appended ${content.length} bytes to ${relativePath}.`,
          artifacts: [relativeLabel(context.workspaceRoot, absolute)],
          followUp: true,
        };
      }

      case 'edit_file': {
        if (!context.toolsEnabled) {
          return { ok: false, summary: 'File access is disabled for this session.', followUp: true };
        }
        const relativePath = readString(args, 'path', 240);
        const search = typeof args.search === 'string' ? args.search : '';
        const replacement = typeof args.replace === 'string' ? args.replace : '';
        if (search.length === 0) {
          return {
            ok: false,
            summary: '"search" must contain the exact text to replace.',
            followUp: true,
          };
        }
        const absolute = await resolveWithinRoot(context.workspaceRoot, relativePath);
        const content = await fs.readFile(absolute, 'utf8');
        const replaceAll = args.replace_all === true;
        const edit = applyEdit(content, search, replacement, replaceAll);

        if (!edit.ok) {
          const hint = nearestLines(content, search);
          return {
            ok: false,
            summary: `The search text was not found in ${relativePath}.`,
            detail: hint.length > 0 ? `Closest lines in the file:\n${hint}` : 'The file does not contain anything similar.',
            nextActions: ['read_file'],
            followUp: true,
          };
        }

        await fs.writeFile(absolute, edit.updated, 'utf8');
        return {
          ok: true,
          summary: `Edited ${relativePath} (${content.length} → ${edit.updated.length} bytes)${edit.strategy}.`,
          artifacts: [relativeLabel(context.workspaceRoot, absolute)],
          nextActions: ['read_file'],
          followUp: true,
        };
      }

      case 'delete_file': {
        if (!context.toolsEnabled) {
          return { ok: false, summary: 'File access is disabled for this session.', followUp: true };
        }
        const relativePath = readString(args, 'path', 240);
        const absolute = await resolveWithinRoot(context.workspaceRoot, relativePath);
        if (absolute === context.workspaceRoot) {
          return { ok: false, summary: 'Refusing to delete the workspace root.', followUp: true };
        }
        const stat = await fs.stat(absolute).catch(() => null);
        if (!stat) {
          return { ok: false, summary: `${relativePath} does not exist.`, followUp: true };
        }
        if (stat.isDirectory()) {
          await fs.rm(absolute, { recursive: true });
          return {
            ok: true,
            summary: `Deleted the folder ${relativePath}.`,
            artifacts: [relativeLabel(context.workspaceRoot, absolute)],
            followUp: true,
          };
        }
        await fs.unlink(absolute);
        return {
          ok: true,
          summary: `Deleted ${relativePath}.`,
          artifacts: [relativeLabel(context.workspaceRoot, absolute)],
          followUp: true,
        };
      }

      case 'search_files': {
        if (!context.toolsEnabled) {
          return { ok: false, summary: 'File access is disabled for this session.', followUp: true };
        }
        const pattern = readString(args, 'pattern', 120);
        const searchPath = readOptionalString(args, 'path', 240) ?? '.';
        const maxHits = Math.min(Math.max(readNumber(args, 'max_results', 40), 1), 200);
        const matches = await searchFiles(context.workspaceRoot, pattern, searchPath, maxHits);
        return {
          ok: true,
          summary: `Searched for "${pattern}" under ${searchPath}.`,
          detail: matches,
          nextActions: ['read_file'],
          followUp: true,
        };
      }

      case 'run_command': {
        if (!context.toolsEnabled) {
          return { ok: false, summary: 'Command execution is disabled for this session.', followUp: true };
        }
        const command = readString(args, 'command', 400);
        const outcome = await runSandboxedCommand(command, context.workspaceRoot);
        return {
          ok: outcome.ok,
          summary: outcome.ok
            ? `Ran \`${command}\``
            : `Command failed: ${outcome.output.slice(0, 200)}`,
          detail: outcome.output,
          nextActions: outcome.ok ? ['read_file', 'write_file'] : ['run_command'],
          followUp: true,
        };
      }

      // ── web tools ─────────────────────────────────────────────────────────

      // ── rendering ──────────────────────────────────────────────────────────

      case 'preview_screenshot': {
        if (!context.toolsEnabled) {
          return { ok: false, summary: 'File access is disabled for this session.', followUp: true };
        }
        const relativePath = readOptionalString(args, 'path', 240) ?? 'index.html';
        const shot = await captureScreenshot({
          root: context.workspaceRoot,
          htmlRelative: relativePath,
          width: readNumber(args, 'width', 1440),
          height: readNumber(args, 'height', 900),
        });
        if (!shot.ok) {
          return { ok: false, summary: shot.message, nextActions: ['list_directory'], followUp: true };
        }
        return {
          ok: true,
          summary: `${shot.message} Saved ${shot.artifact}.`,
          detail: `Preview image: ${shot.artifact} (${shot.bytes} bytes). Render another width to compare breakpoints.`,
          artifacts: shot.artifact ? [shot.artifact] : [],
          nextActions: ['edit_file', 'preview_screenshot'],
          followUp: true,
        };
      }

      case 'web_search': {
        if (!context.webEnabled) {
          return { ok: false, summary: 'Web access is disabled for this session.', followUp: true };
        }
        const query = readString(args, 'query', 300);
        const limit = Math.min(Math.max(readNumber(args, 'results', 5), 1), 10);
        const results = await webSearch(query, limit);
        const detail = results
          .map((entry, index) => `${index + 1}. ${entry.title}\n   ${entry.url}\n   ${entry.snippet}`)
          .join('\n');
        return {
          ok: true,
          summary: `Searched the web for "${query}" — ${results.length} result(s).`,
          detail: detail.length > 0 ? detail : 'No results.',
          artifacts: results.map((entry) => entry.url),
          nextActions: ['web_fetch', 'write_file'],
          followUp: true,
        };
      }

      case 'web_fetch': {
        if (!context.webEnabled) {
          return { ok: false, summary: 'Web access is disabled for this session.', followUp: true };
        }
        const target = readString(args, 'url', 500);
        const page = await webFetch(target);
        return {
          ok: true,
          summary: `Fetched ${page.url} (${page.bytes} bytes).`,
          detail: page.title.length > 0 ? `${page.title}\n\n${page.text}` : page.text,
          artifacts: [page.url],
          nextActions: ['write_file', 'add_note'],
          followUp: true,
        };
      }

      default:
        return {
          ok: false,
          summary: `Unknown action "${action.action}".`,
          followUp: true,
        };
    }
  } catch (error) {
    const message =
      error instanceof WorkspaceError || error instanceof WebError
        ? error.message
        : error instanceof Error
          ? error.message
          : 'Unknown error';
    return { ok: false, summary: `${action.action} failed: ${message}`, followUp: true };
  }
}
