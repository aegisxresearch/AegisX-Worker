import fs from 'node:fs/promises';
import path from 'node:path';
import { MAX_FILE_BYTES, READ_WINDOW_LINES, STATE_DIR } from './config.ts';
import type { OfficeStation, TaskPriority } from '../../shared/types.ts';
import { describeHttpCheck, httpCheck, HttpCheckError } from './httpCheck.ts';
import { captureScreenshot } from './preview.ts';
import {
  describePort,
  listProcesses,
  processLogs,
  ProcessError,
  startManagedProcess,
  stopManagedProcess,
} from './processes.ts';
import { buildCodeMap, findReferences, searchSymbols, type SymbolKind } from './codeMap.ts';
import { applyUnifiedDiff, describePatch } from './patch.ts';
import { describeIssues, validateToolArgs } from './argGuard.ts';
import { checkBrief } from './brief.ts';
import { acquireFolder, acquirePaths, releasePaths } from './fileLocks.ts';
import {
  ownerKey,
  refreshAfterWrite,
  rememberRead,
  staleReads,
} from './readTracker.ts';
import { affectedPaths, evaluate } from './policy.ts';
import { redactSecrets } from './redact.ts';
import { isSingleCommand, runShell, type Remedy } from './shell.ts';
import { resolveWithinRoot, WorkspaceError } from './workspace.ts';
import { assertPublicUrl, webFetch, webSearch, WebError } from './web.ts';

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
  /** Where the decision to make this call came from. Defaults to the operator. */
  provenance?: 'user' | 'plan' | 'web' | 'file';
  /** Mission spend so far, when a budget applies. */
  spend?: { missionTokens: number; budget: number };
  /** Managed processes alive right now. */
  running?: number;
  /** Other workers writing in the same folder right now. */
  otherAgentsBusy?: number;
}

/** Stable reason a tool did not do the work. See `docs/SPECS.md` §1.1. */
export type ToolErrorCode =
  | 'path_outside'
  | 'binary_refused'
  | 'jail_unavailable'
  | 'timeout'
  | 'exit_nonzero'
  | 'not_found'
  | 'denied_by_policy'
  | 'path_locked'
  | 'stale_read'
  | 'needs_approval'
  | 'invalid_args'
  | 'upstream_error';

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
  /**
   * A tool call that does the same job the sandbox refused. The runtime runs it
   * once on the worker's behalf, so a refusal costs no model round.
   */
  remedy?: Remedy;
  /** Whether the agent loop should continue after this action. */
  followUp: boolean;
  /** Stable code, so the board and the checks can group failures by reason. */
  code?: ToolErrorCode;
  /**
   * An image the model should actually see. The runtime attaches it to the next
   * model turn as a content part; it is deliberately not part of the JSON
   * observation, which would spend thousands of tokens on base64.
   */
  media?: { path: string; mime: string; dataUrl: string };
}

const STATIONS: OfficeStation[] = ['desk', 'meeting', 'coffee', 'board', 'lounge'];

const PRIORITIES: TaskPriority[] = ['low', 'medium', 'high', 'urgent'];

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

/**
 * Reads an optional list of short strings. A model that sends one string
 * instead of an array is accepted (endpoints differ), and the cap keeps a
 * single call from flooding the project memory.
 */
export function readStringList(
  args: Record<string, unknown>,
  field: string,
  maxItems: number,
  maxLength: number,
): string[] {
  const raw = args[field];
  const items = typeof raw === 'string' ? [raw] : Array.isArray(raw) ? raw : [];
  const out: string[] = [];
  for (const item of items) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim();
    if (trimmed.length === 0) continue;
    out.push(trimmed.slice(0, maxLength));
    if (out.length >= maxItems) break;
  }
  return out;
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

/**
 * Runs one command line the way a shell would, minus the shell: pipelines,
 * redirects, `&&`/`||`/`;` and `2>&1` are executed by `shell.ts` with argv
 * arrays, so a worker can write what it knows (`echo x > f`, `cat f | grep x`)
 * without the sandbox handing it an injection surface.
 */
async function runSandboxedCommand(
  command: string,
  workspaceRoot: string,
  requestedMaxLines = 0,
): Promise<{
  ok: boolean;
  output: string;
  note: string;
  rejected: boolean;
  steps: string[];
  exitCode: number;
  remedy?: Remedy;
}> {
  const outcome = await runShell(command, {
    cwd: workspaceRoot,
    maxLines: requestedMaxLines,
  });
  return {
    ok: outcome.ok,
    output: outcome.output,
    note: outcome.note,
    rejected: outcome.rejected,
    steps: outcome.steps,
    exitCode: outcome.exitCode,
    ...(outcome.remedy ? { remedy: outcome.remedy } : {}),
  };
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
export interface ActionHandlers {
  moveTo: (station: OfficeStation) => string;
  setStatus: (status: 'idle' | 'working' | 'blocked' | 'error' | 'meeting', reason: string) => string;
  completeTask: (summary: string) => string;
  addNote: (text: string) => string;
  createTask: (
    title: string,
    detail: string,
    priority: TaskPriority,
    assignee?: string,
    dependsOn?: string[],
    pack?: string,
  ) => string;
}

export async function executeToolAction(
  action: AgentAction,
  context: ActionContext,
  handlers: ActionHandlers,
): Promise<ActionResult> {
  const args = action as Record<string, unknown>;

  // One gate in front of every tool. Deny and review both stop the work, but
  // they carry different codes: a refusal is final, a review needs a person.
  const decision = evaluate(
    { action: action.action, args },
    {
      workspaceRoot: context.workspaceRoot,
      toolsEnabled: context.toolsEnabled,
      webEnabled: context.webEnabled,
      provenance: context.provenance ?? 'user',
      spend: context.spend,
      running: context.running,
      otherAgentsBusy: context.otherAgentsBusy,
    },
  );
  if (decision.effect !== 'allow') {
    const blocked = action.action;
    if (decision.effect === 'review') {
      return {
        ok: false,
        code: decision.code,
        summary: `Needs your approval: ${decision.reason}.`,
        detail: `${decision.hint}\nNothing ran.`,
        nextActions: ['add_note', 'complete_task'],
        followUp: true,
      };
    }
    return {
      ok: false,
      code: decision.code,
      summary: `Refused by policy: ${decision.hint.split('.')[0]}.`,
      detail: `Did not run ${blocked}. ${decision.hint}`,
      nextActions: ['read_file', 'list_directory', 'add_note'],
      followUp: true,
    };
  }

  // Shape before side effects: a mistyped enum used to be coerced to a default
  // and reported as success. The model gets the exact field back in the same
  // turn, so the repair costs one round instead of a wrong file.
  const issues = validateToolArgs(action.action, args);
  if (issues.length > 0) {
    const described = describeIssues(action.action, issues);
    return {
      ok: false,
      code: 'invalid_args',
      summary: described.summary,
      detail: described.detail,
      nextActions: [action.action],
      followUp: true,
    };
  }

  // A file that changed since the worker read it is a lost update waiting to
  // happen: refuse before the write, and ask for a fresh read instead.
  const targetPaths = affectedPaths(action.action, args);
  const stale = await staleReads(ownerKey(context.agentId, context.taskId), targetPaths.map((entry) => path.resolve(context.workspaceRoot, entry)));
  if (stale.length > 0) {
    const names = stale.map((entry) => path.relative(context.workspaceRoot, entry.absolutePath)).join(', ');
    return {
      ok: false,
      code: 'stale_read',
      summary: `Re-read ${names} first — another worker changed it after you read it.`,
      detail: [
        `${names} changed on disk since you read it.`,
        'Writing your copy would erase that change. Read it again, redo the edit against the current text, then write.',
      ].join('\n'),
      nextActions: ['read_file', action.action],
      followUp: true,
    };
  }

  // Two workers editing one file is the failure mode this office cannot see:
  // both writes succeed and one edit vanishes. Hold the file for the call.
  const commandScope = action.action === 'run_command' || action.action === 'start_process';
  const lock = commandScope
    ? acquireFolder(context.workspaceRoot, context.agentId)
    : acquirePaths(context.workspaceRoot, affectedPaths(action.action, args), context.agentId);
  if (!lock.ok) {
    const conflict = lock.conflict;
    return {
      ok: false,
      code: 'path_locked',
      summary: commandScope
        ? 'A command is running or a file is being written — try again in a moment.'
        : `${conflict?.path ?? 'That file'} is being written by another worker.`,
      detail: [
        `${conflict?.path ?? 'The file'} is locked by ${conflict?.owner ?? 'another agent'} right now.`,
        'Wait for that worker to finish, then read the file again before changing it — its contents may have moved.',
      ].join('\n'),
      nextActions: ['read_file', action.action],
      followUp: true,
    };
  }

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
        const dependsOn = readStringList(args, 'depends_on', 8, 60);
        const pack = readOptionalString(args, 'role_pack', 24);
        // The brief is judged before the task exists. A refusal costs one round
        // and teaches the lead what a handoff needs; accepting a title with no
        // detail costs the specialist a whole task and teaches nobody.
        const brief = checkBrief({ title, detail });
        if (!brief.ok) {
          return { ok: false, summary: brief.refusal, nextActions: ['create_task'], followUp: true };
        }
        const created = handlers.createTask(title, detail, priority, assignee, dependsOn, pack);
        return {
          ok: true,
          summary: brief.warning.length > 0 ? `${created}\n${brief.warning}` : created,
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
        rememberRead(ownerKey(context.agentId, context.taskId), absolute, content);
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
        const command = readString(args, 'command', 1200);
        const maxLines = Math.min(Math.max(readNumber(args, 'max_lines', 0), 0), 400);
        const outcome = await runSandboxedCommand(command, context.workspaceRoot, maxLines);
        const firstLine = outcome.output.split('\n')[0] ?? outcome.output;
        const writesAFile = /(^|[^|&;])(>>?|&>|2>>?)\s*[^\s|&;]/.test(command);
        return {
          ok: outcome.ok,
          summary: outcome.ok
            ? `Ran \`${outcome.steps.length > 0 ? outcome.steps.join(' ; ') : command}\`${outcome.note ? ` (${outcome.note})` : ''}`
            : outcome.rejected
              ? firstLine
              : `\`${outcome.steps[outcome.steps.length - 1] ?? command}\` exited ${outcome.exitCode}: ${firstLine}`,
          detail:
            outcome.output.length > 0
              ? outcome.output
              : outcome.ok
                ? 'The command succeeded and printed nothing.'
                : 'The command printed nothing on stdout or stderr.',
          nextActions: outcome.ok
            ? writesAFile
              ? ['read_file', 'run_command', 'complete_task']
              : ['read_file', 'write_file', 'run_command']
            : outcome.rejected
              ? outcome.remedy
                ? [outcome.remedy.tool, 'run_command']
                : ['run_command', 'read_file', 'write_file']
              : ['run_command', 'read_file', 'edit_file'],
          ...(outcome.remedy ? { remedy: outcome.remedy } : {}),
          followUp: true,
        };
      }

      case 'http_check': {
        if (!context.toolsEnabled) {
          return { ok: false, summary: 'Network checks are disabled for this session.', followUp: true };
        }
        const target = readString(args, 'url', 500);
        const expectText = readOptionalString(args, 'expect_text', 300);
        const checkAssets = args.assets !== false;
        try {
          const result = await httpCheck({ url: target, expectText, checkAssets });
          return {
            ok: result.ok,
            summary: result.message,
            detail: describeHttpCheck(result),
            artifacts: result.assets.map((asset) => asset.path),
            nextActions: result.ok ? ['complete_task'] : ['edit_file', 'read_file', 'preview_screenshot'],
            followUp: true,
          };
        } catch (error) {
          const message = error instanceof HttpCheckError ? error.message : 'The check could not run.';
          return { ok: false, summary: message, nextActions: ['run_command'], followUp: true };
        }
      }

      // ── long-running processes ────────────────────────────────────────────

      case 'start_process': {
        if (!context.toolsEnabled) {
          return { ok: false, summary: 'Process control is disabled for this session.', followUp: true };
        }
        const command = readString(args, 'command', 400);
        const shape = isSingleCommand(command);
        if (!shape.ok) {
          return {
            ok: false,
            summary: shape.message,
            detail: `Did not start: ${shape.message}\nCommand was: ${command}`,
            nextActions: ['start_process', 'run_command'],
            followUp: true,
          };
        }
        const label = readOptionalString(args, 'label', 80) ?? command.slice(0, 60);
        const portValue = readNumber(args, 'port', 0);
        const port = portValue > 0 ? Math.min(Math.max(portValue, 1), 65535) : null;
        try {
          const started = await startManagedProcess({
            command,
            cwd: context.workspaceRoot,
            label,
            logDir: path.join(STATE_DIR, 'processes'),
            port,
          });
          return {
            ok: started.running,
            summary: started.running
              ? `Started ${started.label} as ${started.id} (pid ${started.pid})${started.port ? ` on port ${started.port}` : ''}.`
              : `${started.id} exited immediately with code ${started.exitCode} — read its log.`,
            detail: [
              `id: ${started.id}`,
              `pid: ${started.pid}`,
              `running: ${started.running}`,
              `command: ${started.command}`,
              `log: ${started.logFile}`,
              started.port ? `port: ${started.port}` : '',
            ]
              .filter((line) => line.length > 0)
              .join('\n'),
            nextActions: started.running
              ? ['port_status', 'http_check', 'process_logs']
              : ['process_logs'],
            followUp: true,
          };
        } catch (error) {
          const message = error instanceof ProcessError ? error.message : 'Could not start the process.';
          return { ok: false, summary: message, nextActions: ['stop_process'], followUp: true };
        }
      }

      case 'process_logs': {
        if (!context.toolsEnabled) {
          return { ok: false, summary: 'Process control is disabled for this session.', followUp: true };
        }
        const id = readString(args, 'id', 40);
        try {
          const { entry, text } = processLogs(id, readNumber(args, 'lines', 80));
          return {
            ok: true,
            summary: `${entry.label} (${entry.id}) is ${entry.running ? 'running' : `stopped with code ${entry.exitCode}`} — ${text.split('\n').length} line(s) of output.`,
            detail: text,
            nextActions: entry.running ? ['port_status', 'http_check', 'stop_process'] : ['start_process'],
            followUp: true,
          };
        } catch (error) {
          const message = error instanceof ProcessError ? error.message : 'Could not read the log.';
          return { ok: false, summary: message, nextActions: ['port_status'], followUp: true };
        }
      }

      case 'stop_process': {
        if (!context.toolsEnabled) {
          return { ok: false, summary: 'Process control is disabled for this session.', followUp: true };
        }
        const id = readString(args, 'id', 40);
        try {
          const stopped = await stopManagedProcess(id);
          return {
            ok: !stopped.running,
            summary: stopped.running
              ? `${stopped.id} is still running (pid ${stopped.pid}).`
              : `Stopped ${stopped.label} (${stopped.id}, pid ${stopped.pid}).`,
            nextActions: stopped.running ? ['port_status'] : ['http_check'],
            followUp: true,
          };
        } catch (error) {
          const message = error instanceof ProcessError ? error.message : 'Could not stop the process.';
          return { ok: false, summary: message, nextActions: ['port_status'], followUp: true };
        }
      }

      case 'port_status': {
        if (!context.toolsEnabled) {
          return { ok: false, summary: 'Process control is disabled for this session.', followUp: true };
        }
        const portValue = readNumber(args, 'port', 0);
        if (portValue > 0) {
          const port = Math.min(Math.max(portValue, 1), 65535);
          const info = await describePort(port);
          return {
            ok: info.listening,
            summary: info.listening
              ? `Port ${port} is listening${info.managed ? ` (${info.managed.label}, ${info.managed.id})` : info.ownerPid ? ` (pid ${info.ownerPid})` : ''}.`
              : `Nothing is listening on port ${port}.`,
            detail: [
              `port: ${port}`,
              `listening: ${info.listening}`,
              `owner pid: ${info.ownerPid ?? 'unknown'}`,
              `managed: ${info.managed ? `${info.managed.id} ${info.managed.command}` : 'no'}`,
            ].join('\n'),
            nextActions: info.listening ? ['http_check', 'process_logs'] : ['start_process'],
            followUp: true,
          };
        }
        const managed = listProcesses();
        return {
          ok: true,
          summary: managed.length > 0 ? `${managed.length} managed process(es).` : 'No managed process is running.',
          detail:
            managed.length > 0
              ? managed
                  .map(
                    (entry) =>
                      `${entry.id} ${entry.running ? 'running' : `exit ${entry.exitCode}`} pid=${entry.pid} ${entry.label}${entry.port ? ` port=${entry.port}` : ''}`,
                  )
                  .join('\n')
              : 'Call start_process to start a server.',
          nextActions: managed.length > 0 ? ['process_logs', 'stop_process'] : ['start_process'],
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
        // A page can arrive as zero bytes with no title. Handing the model an
        // empty `detail` there would break the result contract and, worse, read
        // as "the page had nothing on it" instead of "there was nothing to read".
        const readable =
          page.title.length > 0 && page.text.length > 0
            ? `${page.title}\n\n${page.text}`
            : page.text.length > 0
              ? page.text
              : page.title.length > 0
                ? page.title
                : `The page returned ${page.bytes} bytes with no readable text — check the URL or try http_request for the raw response.`;
        return {
          ok: true,
          summary: `Fetched ${page.url} (${page.bytes} bytes).`,
          detail: readable,
          artifacts: [page.url],
          nextActions: ['write_file', 'add_note'],
          followUp: true,
        };
      }

      // ── structured editing and code intelligence ─────────────────────────

      case 'apply_patch': {
        const diff = readString(args, 'patch', 200_000);
        const dryRun = args.dry_run === true;
        if (!diff.includes('@@')) {
          return {
            ok: false,
            code: 'invalid_args',
            summary: 'Not a unified diff: no @@ hunk header.',
            detail:
              'Write the patch with ---/+++ file headers and @@ -a,b +c,d @@ hunks. Use write_file for a brand-new file.',
            nextActions: ['read_file', 'apply_patch'],
            followUp: true,
          };
        }
        const outcome = await applyUnifiedDiff(context.workspaceRoot, diff, { dryRun });
        if (!outcome.ok) {
          return {
            ok: false,
            code: 'invalid_args',
            summary: `Patch refused: ${outcome.message.split('.')[0] ?? outcome.message}.`,
            detail: [
              outcome.path ? `File: ${outcome.path}${outcome.hunk ? ` (hunk ${outcome.hunk})` : ''}` : '',
              outcome.message,
              'Nothing was written. Re-read the file and regenerate only the hunk that no longer fits.',
            ]
              .filter((line) => line.length > 0)
              .join('\n'),
            nextActions: ['read_file', 'apply_patch', 'edit_file'],
            followUp: true,
          };
        }
        const touched = outcome.files.map((file) => file.path);
        return {
          ok: true,
          summary: dryRun
            ? `Patch fits: ${describePatch(outcome.files)}. Nothing written (dry run).`
            : `Applied patch to ${touched.length} file(s): ${describePatch(outcome.files)}.`,
          detail: `${touched.map((file) => `- ${file}`).join('\n')}\n\nRe-run the folder's check before claiming done.`,
          artifacts: touched,
          nextActions: ['run_command', 'read_file', 'complete_task'],
          followUp: true,
        };
      }

      case 'search_symbol': {
        if (!context.toolsEnabled) {
          return { ok: false, summary: 'File access is disabled for this session.', followUp: true };
        }
        const query = readString(args, 'query', 120);
        const rawKind = readOptionalString(args, 'kind', 20);
        const kinds: SymbolKind[] = ['function', 'class', 'interface', 'type', 'enum', 'method', 'constant'];
        const kind = rawKind && kinds.includes(rawKind as SymbolKind) ? (rawKind as SymbolKind) : undefined;
        const limit = Math.min(Math.max(readNumber(args, 'limit', 20), 1), 60);
        const map = await buildCodeMap(context.workspaceRoot);
        const matches = searchSymbols(map, query, { kind, limit });
        const scope = `Searched ${map.files.length} file(s)${map.truncated ? ' (capped — an empty result is not proof of absence)' : ''}.`;
        if (matches.length === 0) {
          return {
            ok: false,
            code: 'not_found',
            summary: `No symbol matches "${query}".`,
            detail: `${scope}\nTry a shorter fragment, or use search_files for raw text.`,
            nextActions: ['search_files', 'list_directory'],
            followUp: true,
          };
        }
        return {
          ok: true,
          summary: `${matches.length} symbol(s) matching "${query}".`,
          detail: `${scope}\n${matches
            .map((symbol) => `${symbol.path}:${symbol.line} ${symbol.kind} ${symbol.name}${symbol.exported ? ' (exported)' : ''}`)
            .join('\n')}`,
          nextActions: ['read_file', 'find_references'],
          followUp: true,
        };
      }

      case 'find_references': {
        if (!context.toolsEnabled) {
          return { ok: false, summary: 'File access is disabled for this session.', followUp: true };
        }
        const name = readString(args, 'name', 120);
        const limit = Math.min(Math.max(readNumber(args, 'limit', 40), 1), 100);
        const map = await buildCodeMap(context.workspaceRoot);
        const hits = await findReferences(map, name, { limit });
        if (hits.length === 0) {
          return {
            ok: false,
            code: 'not_found',
            summary: `"${name}" appears nowhere in ${map.files.length} indexed file(s).`,
            detail: map.truncated
              ? 'The index hit its file cap, so this is not proof of absence.'
              : 'Check the spelling, or search for the string with search_files.',
            nextActions: ['search_symbol', 'search_files'],
            followUp: true,
          };
        }
        const definitions = hits.filter((hit) => hit.definition).length;
        return {
          ok: true,
          summary: `${hits.length} mention(s) of "${name}" (${definitions} definition(s)).`,
          detail: hits
            .map((hit) => `${hit.path}:${hit.line}${hit.definition ? ' [definition]' : ''}: ${hit.text}`)
            .join('\n'),
          nextActions: ['read_file', 'apply_patch'],
          followUp: true,
        };
      }

      case 'run_check': {
        if (!context.toolsEnabled) {
          return { ok: false, summary: 'Command execution is disabled for this session.', followUp: true };
        }
        const manifest = JSON.parse(
          await fs.readFile(path.join(context.workspaceRoot, 'package.json'), 'utf8').catch(() => '{}'),
        ) as { scripts?: Record<string, string> };
        const scripts = manifest.scripts ?? {};
        const wanted = readOptionalString(args, 'name', 40);
        const preferred = ['check', 'typecheck', 'test', 'lint', 'build'].filter((name) => name in scripts);
        const chosen = wanted ? (wanted in scripts ? [wanted] : []) : preferred.slice(0, 1);
        if (chosen.length === 0) {
          return {
            ok: false,
            code: 'not_found',
            summary: wanted
              ? `No npm script named "${wanted}".`
              : 'This folder has no check/typecheck/test/lint/build script.',
            detail: `Scripts found: ${Object.keys(scripts).join(', ') || 'none'}. Use run_command with the project's own command instead.`,
            nextActions: ['run_command', 'list_directory'],
            followUp: true,
          };
        }
        const runs: string[] = [];
        const failures: { file: string; line: number; text: string }[] = [];
        let allOk = true;
        for (const script of chosen) {
          const outcome = await runSandboxedCommand(`npm run ${script}`, context.workspaceRoot, 200);
          allOk = allOk && outcome.ok;
          runs.push(`${script}: ${outcome.ok ? 'passed' : `failed (exit ${outcome.exitCode})`}`);
          const pattern = /(?:^|\s)([\w./-]+\.(?:ts|tsx|js|jsx|py|go|rs|java|kt|rb|php|cs))[:(](\d+)(?::\d+)?\)?[:\s-]+(.{0,160})/g;
          for (const line of outcome.output.split('\n')) {
            for (const match of line.matchAll(pattern)) {
              const file = match[1];
              const lineNumber = match[2];
              const text = match[3];
              if (!file || !lineNumber || !text) continue;
              failures.push({ file, line: Number(lineNumber), text: text.trim() });
              if (failures.length >= 20) break;
            }
          }
        }
        return {
          ok: allOk,
          summary: allOk ? `Ran ${chosen.join(', ')}: passed.` : `Ran ${chosen.join(', ')}: failing.`,
          detail: [
            ...runs,
            failures.length > 0
              ? `\nFailures:\n${failures.map((entry) => `${entry.file}:${entry.line} ${entry.text}`).join('\n')}`
              : '',
            allOk ? '' : 'Fix the first failure, then run this tool again.',
          ]
            .filter((line) => line.length > 0)
            .join('\n'),
          nextActions: allOk ? ['complete_task'] : ['read_file', 'apply_patch', 'run_check'],
          followUp: true,
        };
      }

      case 'read_media': {
        if (!context.toolsEnabled) {
          return { ok: false, summary: 'File access is disabled for this session.', followUp: true };
        }
        const relative = readString(args, 'path', 500);
        const absolute = await resolveWithinRoot(context.workspaceRoot, relative);
        const stats = await fs.stat(absolute).catch(() => null);
        if (!stats || !stats.isFile()) {
          return {
            ok: false,
            code: 'not_found',
            summary: `No file at ${relative}.`,
            nextActions: ['list_directory', 'read_file'],
            followUp: true,
          };
        }
        const MIME: Record<string, string> = {
          '.png': 'image/png',
          '.jpg': 'image/jpeg',
          '.jpeg': 'image/jpeg',
          '.webp': 'image/webp',
          '.gif': 'image/gif',
        };
        const extension = path.extname(relative).toLowerCase();
        const mime = MIME[extension];
        if (!mime) {
          return {
            ok: false,
            code: 'binary_refused',
            summary: `${relative} is not an image this office can show.`,
            detail: `Supported: ${Object.keys(MIME).join(', ')}. For text, use read_file.`,
            nextActions: ['read_file', 'list_directory'],
            followUp: true,
          };
        }
        const MEDIA_LIMIT = 4 * 1024 * 1024;
        if (stats.size > MEDIA_LIMIT) {
          return {
            ok: false,
            code: 'invalid_args',
            summary: `${relative} is ${Math.round(stats.size / 1024)} KB — too large to attach.`,
            detail: `The ceiling is 4 MB. Downscale it first, then read it again.`,
            nextActions: ['run_command', 'read_media'],
            followUp: true,
          };
        }
        const bytes = await fs.readFile(absolute);
        const dataUrl = `data:${mime};base64,${bytes.toString('base64')}`;
        return {
          ok: true,
          summary: `Attached ${relative} (${Math.round(stats.size / 1024)} KB) — look at it before judging the page.`,
          detail: `The image is attached to this turn. Describe what you actually see: layout, spacing, clipped text, missing content.`,
          artifacts: [relative],
          media: { path: relative, mime, dataUrl },
          nextActions: ['apply_patch', 'preview_screenshot', 'add_note'],
          followUp: true,
        };
      }

      case 'http_request': {
        if (!context.toolsEnabled) {
          return { ok: false, summary: 'Network access is disabled for this session.', followUp: true };
        }
        const rawUrl = readString(args, 'url', 1000);
        const method = (readOptionalString(args, 'method', 10) ?? 'GET').toUpperCase();
        if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'].includes(method)) {
          return { ok: false, code: 'invalid_args', summary: `Unsupported method ${method}.`, followUp: true };
        }
        let target: URL;
        try {
          target = new URL(rawUrl);
        } catch {
          return { ok: false, code: 'invalid_args', summary: 'That is not a valid URL.', followUp: true };
        }
        if (target.protocol !== 'http:' && target.protocol !== 'https:') {
          return { ok: false, code: 'invalid_args', summary: 'Only http(s) URLs are supported.', followUp: true };
        }
        // A dev server on this machine is the common case; anything else must
        // resolve to a public address so the tool cannot probe the LAN.
        const local = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(target.hostname);
        if (!local) await assertPublicUrl(rawUrl);

        const headers: Record<string, string> = {};
        if (args.headers && typeof args.headers === 'object' && !Array.isArray(args.headers)) {
          for (const [key, value] of Object.entries(args.headers as Record<string, unknown>)) {
            if (typeof value === 'string' && key.length < 80) headers[key] = value.slice(0, 500);
          }
        }
        const body = readOptionalString(args, 'body', 20_000);
        const timeoutMs = Math.min(Math.max(readNumber(args, 'timeout_ms', 15_000), 1_000), 60_000);
        const response = await fetch(target, {
          method,
          headers,
          body: method === 'GET' || method === 'HEAD' ? undefined : body,
          redirect: 'follow',
          signal: AbortSignal.timeout(timeoutMs),
        });
        const raw = method === 'HEAD' ? '' : await response.text();
        const contentType = response.headers.get('content-type') ?? '';
        const clipped = raw.slice(0, 8_000);
        let formatted = clipped;
        if (contentType.includes('json')) {
          try {
            formatted = JSON.stringify(JSON.parse(raw), null, 2).slice(0, 8_000);
          } catch {
            formatted = clipped;
          }
        }
        return {
          ok: response.ok,
          code: response.ok ? undefined : 'upstream_error',
          summary: `${method} ${target.href} → ${response.status} ${response.statusText}`.trim(),
          detail: `content-type: ${contentType || 'unknown'}\n${raw.length > clipped.length ? `(showing ${clipped.length} of ${raw.length} characters)\n` : ''}\n${formatted}`,
          artifacts: [target.href],
          nextActions: response.ok ? ['add_note', 'complete_task'] : ['read_file', 'http_request'],
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
  } finally {
    await refreshAfterWrite(ownerKey(context.agentId, context.taskId), lock.keys);
    releasePaths(lock.keys, context.agentId);
  }
}

/**
 * The model's only door into the tools. Everything a tool saw passes through
 * `redactSecrets` on the way out, so a `.env`, a key pasted into a shell
 * command, or a secret echoed by a failing test never becomes model context —
 * which would then be sent to the model provider on the next turn.
 */
export async function executeAction(
  action: AgentAction,
  context: ActionContext,
  handlers: ActionHandlers,
): Promise<ActionResult> {
  const result = await executeToolAction(action, context, handlers);
  const summary = redactSecrets(result.summary);
  const detail = redactSecrets(result.detail ?? '');
  if (summary === result.summary && detail === result.detail) return result;
  return {
    ...result,
    summary,
    detail: `${detail}

[Secret-looking values were masked before this observation reached the model.]`,
  };
}
