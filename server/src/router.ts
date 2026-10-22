/**
 * The capability router: which slice of the toolkit a worker is shown.
 *
 * Sending the whole toolkit on every round costs a few thousand tokens before a
 * single file is read — `schemaTokens()` measures today's figure, which is why
 * this file quotes no number that can rot. A worker does not need
 * `start_process` while it is still reading the folder, and it does not need
 * `write_file` while it is running the tests. This module names the four
 * phases, says which tool belongs to which, and moves the worker between them
 * after every result.
 *
 * It is pure and lives outside the runtime so the phase table can be checked
 * without spawning a model.
 */

export type ToolPhase = 'inspect' | 'edit' | 'verify' | 'wrap';

export const TOOL_PHASES: readonly ToolPhase[] = ['inspect', 'edit', 'verify', 'wrap'];

/** Actions every phase keeps: the worker must always be able to finish or ask. */
export const ALWAYS_AVAILABLE: readonly string[] = ['complete_task', 'add_note', 'create_task', 'speak'];

/** Phase-specific tools. Anything not listed here is only sent in `all` mode. */
const PHASE_TOOLS: Record<ToolPhase, readonly string[]> = {
  // Looking must come before touching.
  inspect: [
    'list_directory',
    'read_file',
    'read_media',
    'search_files',
    'search_symbol',
    'find_references',
    'web_search',
    'web_fetch',
  ],
  // The write surface. No shell yet: an edit is not a place to start a server.
  edit: ['apply_patch', 'write_file', 'append_file', 'edit_file', 'delete_file', 'move_to', 'set_status'],
  // Running things: the folder's own check first, then commands and probes.
  verify: [
    'run_check',
    'run_command',
    'http_check',
    'http_request',
    'preview_screenshot',
    'start_process',
    'stop_process',
    'process_logs',
    'port_status',
  ],
  // Winding down: status, speech, and the escape hatch.
  wrap: ['move_to', 'set_status', 'revert_turn'],
};

/** Names a phase offers, office core included. */
export function toolsForPhase(phase: ToolPhase): string[] {
  return [...new Set([...ALWAYS_AVAILABLE, ...PHASE_TOOLS[phase]])];
}

/**
 * The phase a result moves the worker into.
 *
 * The rule is about evidence, not politeness: after reading you may edit; after
 * editing you must check; after a failure you go back to reading, because the
 * next useful thing is to look at what actually happened.
 */
export function phaseAfterAction(action: string, ok: boolean, current: ToolPhase): ToolPhase {
  const inPhase = (phase: ToolPhase): boolean => PHASE_TOOLS[phase].includes(action);

  if (!ok) {
    // A refused or failed call means the model's picture is wrong; let it read.
    return action === 'complete_task' ? current : 'inspect';
  }
  if (action === 'complete_task') return 'wrap';
  if (inPhase('edit')) return 'verify';
  if (inPhase('verify')) return 'verify';
  if (inPhase('inspect')) return current === 'edit' || current === 'verify' ? current : 'inspect';
  return current;
}

/**
 * Rough token cost of a schema list, measured the way the request is built.
 *
 * Four characters per token is the same estimate `scripts/prompt-check.mjs`
 * uses; the point is a stable comparison between two lists, not a bill.
 */
export function schemaTokens(schemas: { function: { name: string } }[]): number {
  return Math.round(JSON.stringify(schemas).length / 4);
}
