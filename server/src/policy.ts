import fs from 'node:fs';
import path from 'node:path';
import type { ToolErrorCode } from './tools.ts';
import { isInside } from './workspace.ts';

/**
 * One gate for every mutating or reaching action.
 *
 * The guards arrived one at a time — a path check in the file tools, an
 * allowlist in the shell, a cap in the process registry, an SSRF filter in the
 * web layer. Each is right, but none of them can answer "may this call happen?"
 * in one place, and a new tool silently inherits nothing. This is that place:
 * a pure decision, with the reason and the replacement, evaluated before the
 * tool runs.
 *
 * `review` is not a refusal. It means a human has to say yes; the tool layer
 * turns it into a `needs_approval` result instead of doing the work.
 */

export type Provenance = 'user' | 'plan' | 'web' | 'file';

export interface PolicyContext {
  workspaceRoot: string;
  toolsEnabled: boolean;
  webEnabled: boolean;
  /** Where the decision to call this tool came from. */
  provenance: Provenance;
  /** Mission spend so far, when a budget applies. */
  spend?: { missionTokens: number; budget: number };
  /** Managed processes currently alive. */
  running?: number;
  /** Other workers writing in the same folder right now. */
  otherAgentsBusy?: number;
}

export type Effect =
  | { effect: 'allow' }
  | { effect: 'deny'; code: ToolErrorCode; hint: string }
  | { effect: 'review'; reason: string; code: ToolErrorCode; hint: string };

export interface PolicyCall {
  action: string;
  args: Record<string, unknown>;
}

/** Tools that only look. Everything else can change the world or reach out. */
const READ_ONLY = new Set([
  'list_directory',
  'read_file',
  'search_files',
  'search_symbol',
  'find_references',
  'port_status',
  'process_logs',
  'http_check',
  'web_search',
  'web_fetch',
  'move_to',
  'set_status',
  'speak',
  'add_note',
]);

/**
 * Office actions change the board and the scene, never the folder. They must
 * keep working when the operator switches file and shell access off — a
 * worker that cannot mark a task done leaves the office looking stuck.
 */
const OFFICE_ACTIONS = new Set(['move_to', 'set_status', 'speak', 'add_note', 'create_task', 'complete_task']);

/** Files whose contents are secrets, not source. `.env.example` is a template. */
const SECRET_FILE =
  /(^|\/)\.env(?!\.(?:example|sample|template)$)(\..+)?$|(^|\/)(id_rsa|id_ed25519|\.npmrc|\.netrc|\.pgpass)$|\.(pem|key|p12|pfx)$/i;

const PUBLISH_COMMAND = /\b(git\s+push|npm\s+publish|yarn\s+publish|pnpm\s+publish|docker\s+(run|push|rm)|kubectl\s+\w+)\b/;

/** Actions that take a workspace path, so one rule covers all of them. */
const PATH_ACTIONS = new Set([
  'read_file',
  'write_file',
  'append_file',
  'edit_file',
  'delete_file',
  'list_directory',
  'search_files',
  'preview_screenshot',
  'read_media',
  'apply_patch',
]);

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function deny(code: ToolErrorCode, hint: string): Effect {
  return { effect: 'deny', code, hint };
}

function review(code: ToolErrorCode, reason: string, hint: string): Effect {
  return { effect: 'review', code, reason, hint };
}

/** Paths a patch touches: the diff headers, which is all a patch is. */
function patchPaths(diff: string): string[] {
  const paths: string[] = [];
  for (const line of diff.split('\n')) {
    const match = /^(?:---|\+\+\+)\s+(?:[ab]\/)?(.+?)(?:\t|$)/.exec(line.trim());
    if (!match?.[1]) continue;
    if (match[1] === '/dev/null') continue;
    if (!paths.includes(match[1])) paths.push(match[1]);
  }
  return paths;
}

/** Actions that change a named file, so the runtime can lock it. */
export const MUTATING_ACTIONS = new Set(['write_file', 'append_file', 'edit_file', 'delete_file', 'apply_patch']);

/**
 * The paths a mutating call will touch. One definition, used by the containment
 * rule and by the write lock, so a new action cannot be added to one and
 * forgotten in the other without the check noticing.
 */
export function affectedPaths(action: string, args: Record<string, unknown>): string[] {
  if (action === 'apply_patch') return patchPaths(asString(args.diff) || asString(args.patch));
  if (!MUTATING_ACTIONS.has(action)) return [];
  const target = asString(args.path).trim();
  return target.length > 0 ? [target] : [];
}

function isSecretPath(relative: string): boolean {
  return SECRET_FILE.test(relative.replace(/^\.\//, ''));
}

/**
 * The decision. Pure, synchronous and cheap, so it can run on every call
 * without becoming part of the latency the worker notices.
 */
export function evaluate(call: PolicyCall, context: PolicyContext): Effect {
  const { action } = call;
  const args = call.args;

  // 1. Provenance: a page the worker fetched is data. It cannot start a write,
  //    a command or a process, however politely it asks.
  if (context.provenance === 'web' && !READ_ONLY.has(action)) {
    return deny(
      'denied_by_policy',
      `This call came from untrusted web content, so it may only read. Do the change yourself after deciding it is right.`,
    );
  }

  // 2. Spend ceiling. Checked before the work, not after the bill.
  if (context.spend && context.spend.budget > 0 && context.spend.missionTokens >= context.spend.budget) {
    return deny(
      'denied_by_policy',
      `This mission is at its token budget (${context.spend.missionTokens}/${context.spend.budget}). Report what is done with complete_task or add_note.`,
    );
  }

  // 3. Path containment, for every tool that names a path.
  if (PATH_ACTIONS.has(action)) {
    const candidates =
      action === 'apply_patch'
        ? patchPaths(asString(args.diff) || asString(args.patch))
        : [asString(args.path)].filter((value) => value.length > 0);
    for (const candidate of candidates) {
      const absolute = path.resolve(context.workspaceRoot, candidate);
      if (!isInside(context.workspaceRoot, absolute)) {
        return deny(
          'path_outside',
          `"${candidate}" is outside the workspace folder. Use a path relative to ${context.workspaceRoot}.`,
        );
      }
    }
  }

  // 4. Secrets are not source code. Reading one is how a key ends up in a log.
  if (action === 'read_file' || action === 'read_media') {
    const relative = asString(args.path);
    if (isSecretPath(relative)) {
      return deny(
        'denied_by_policy',
        `"${relative}" holds a secret, so the office will not read it. If a value is needed, the operator must place a non-secret copy in the folder.`,
      );
    }
  }

  // 5. The workspace root is not a thing to delete.
  if (action === 'delete_file') {
    const relative = asString(args.path).trim();
    const absolute = path.resolve(context.workspaceRoot, relative);
    if (relative === '' || absolute === context.workspaceRoot) {
      return deny('denied_by_policy', 'Refusing to delete the workspace root.');
    }
  }

  // 6. A patch that touches a whole tree is a refactor, and a refactor needs a
  //    human to agree before it lands.
  if (action === 'apply_patch') {
    const files = patchPaths(asString(args.diff) || asString(args.patch));
    if (files.length > 40) {
      return review(
        'needs_approval',
        `this patch rewrites ${files.length} files`,
        'Split the patch, or ask the operator to approve the wide change.',
      );
    }
  }

  // 7. Publishing and pushing leave the machine. Never on the model's word.
  const command = asString(args.command);
  if ((action === 'run_command' || action === 'start_process') && PUBLISH_COMMAND.test(command)) {
    return review(
      'needs_approval',
      `the command "${command.slice(0, 80)}" publishes or deploys`,
      'A human must approve pushing, publishing or deploying. Ask with add_note and finish the task.',
    );
  }

  // 8. Process cap, before the registry has to say no.
  if (action === 'start_process' && (context.running ?? 0) >= 5) {
    return deny(
      'denied_by_policy',
      `Five processes are already running. Read one with process_logs and stop what you no longer need with stop_process.`,
    );
  }

  // 9. Reverting while a teammate writes in the same folder would erase their
  //    work, so it needs a human (or a quiet workspace).
  if (action === 'revert_turn' && (context.otherAgentsBusy ?? 0) > 0) {
    return review(
      'needs_approval',
      'another worker is writing in this folder',
      'Wait until the teammate finishes, then revert — otherwise their work is erased too.',
    );
  }

  // 10. Reaching a private address from a tool that is not the loopback checker
  //     is the SSRF hole with extra steps.
  if (action === 'http_request') {
    const url = asString(args.url);
    if (!/^https?:\/\//i.test(url)) {
      return deny('invalid_args', 'http_request needs an absolute http(s) URL.');
    }
  }

  // 11. Tools the session was not granted never run, whatever the model says.
  if (
    !context.toolsEnabled &&
    !OFFICE_ACTIONS.has(action) &&
    action !== 'web_search' &&
    action !== 'web_fetch' &&
    !READ_ONLY.has(action)
  ) {
    return deny('denied_by_policy', 'File and shell access is switched off for this session.');
  }
  if (!context.webEnabled && (action === 'web_search' || action === 'web_fetch' || action === 'http_request')) {
    return deny('denied_by_policy', 'Web access is switched off for this session.');
  }

  return { effect: 'allow' };
}

/** True when the folder holds a file whose name looks like a secret. */
export function hasSecretFile(root: string): boolean {
  try {
    return fs.readdirSync(root).some((name) => isSecretPath(name));
  } catch {
    return false;
  }
}
