/**
 * Per-tool result contracts.
 *
 * `outputGuard` checks that an observation is *well formed* — a summary, a list
 * of artifacts, a code the board knows. It cannot know that a successful
 * `read_file` is worthless without the file's text, or that `read_media` that
 * attaches no image leaves the model describing something it never saw. Those
 * are per-tool facts, so they live here and the guard asks this module.
 *
 * The rule is deliberately one-directional: only a **success** owes a payload.
 * A refusal is allowed to explain itself in a sentence, because there is
 * nothing to hand over.
 */

export type ResultField = 'detail' | 'artifacts' | 'media' | 'speech';

export interface ToolResultSchema {
  /** Fields a successful call must actually carry, not merely name. */
  owes: ResultField[];
  /** True when a successful call must end the agent loop for this turn. */
  finishesTurn?: boolean;
}

/**
 * One entry per tool whose value reaches the model. Tools not listed here
 * (office actions, refusals) are held to the shared shape rules only.
 */
export const TOOL_RESULT_SCHEMAS: Record<string, ToolResultSchema> = {
  // ── office actions ─────────────────────────────────────────────────────────
  // A spoken line with no text is invisible in the 3D office, so the model
  // would "say" something no operator ever sees.
  speak: { owes: ['speech'] },
  // Finishing must end the turn; otherwise the worker keeps paying rounds on a
  // task the office already considers done.
  complete_task: { owes: [], finishesTurn: true },

  // ── filesystem ─────────────────────────────────────────────────────────────
  // The listing is the answer. A summary of "Listed ." with no entries is the
  // failure this contract exists to stop.
  list_directory: { owes: ['detail'] },
  // The single most expensive silent bug: `Read x (lines 1-40 of 120)` with no
  // contents sends the model back to re-read, guess, or probe.
  read_file: { owes: ['detail'] },
  write_file: { owes: ['artifacts'] },
  append_file: { owes: ['artifacts'] },
  edit_file: { owes: ['artifacts'] },
  delete_file: { owes: ['artifacts'] },
  search_files: { owes: ['detail'] },

  // ── shell and checks ───────────────────────────────────────────────────────
  run_command: { owes: ['detail'] },
  run_check: { owes: ['detail'] },
  apply_patch: { owes: ['detail', 'artifacts'] },

  // ── code intelligence ──────────────────────────────────────────────────────
  search_symbol: { owes: ['detail'] },
  find_references: { owes: ['detail'] },

  // ── processes and network ──────────────────────────────────────────────────
  start_process: { owes: ['detail'] },
  process_logs: { owes: ['detail'] },
  port_status: { owes: ['detail'] },
  http_check: { owes: ['detail'] },
  http_request: { owes: ['detail'] },
  web_search: { owes: ['detail'] },
  web_fetch: { owes: ['detail'] },

  // ── rendering ──────────────────────────────────────────────────────────────
  preview_screenshot: { owes: ['detail', 'artifacts'] },
  // `media` is the whole point: the runtime attaches it as an image part. An
  // observation that claims to have shown an image without one makes the model
  // judge a page it never received.
  read_media: { owes: ['detail', 'artifacts', 'media'] },
};

export interface ResultLike {
  ok: boolean;
  detail?: unknown;
  artifacts?: unknown;
  media?: unknown;
  speech?: unknown;
  followUp?: unknown;
}

/** What each owed field has to look like before the model may see it. */
function describeMissing(field: ResultField, value: unknown): string | null {
  switch (field) {
    case 'detail':
      return typeof value === 'string' && value.trim().length > 0
        ? null
        : 'is empty, so the model would get the outcome without the content';
    case 'artifacts':
      if (!Array.isArray(value) || value.length === 0) return 'is empty, so nothing points at what changed';
      if (value.some((entry) => typeof entry !== 'string' || entry.trim().length === 0)) {
        return 'contains an entry that is not a file or URL';
      }
      return null;
    case 'media': {
      const media = value as { path?: unknown; mime?: unknown; dataUrl?: unknown } | undefined;
      if (!media || typeof media !== 'object') return 'is missing, so the image was never attached';
      if (typeof media.path !== 'string' || media.path.length === 0) return 'has no path';
      if (typeof media.mime !== 'string' || !media.mime.includes('/')) return 'has no usable mime type';
      if (typeof media.dataUrl !== 'string' || !media.dataUrl.startsWith('data:')) {
        return 'has no data URL, so there is nothing to attach';
      }
      return null;
    }
    case 'speech':
      return typeof value === 'string' && value.trim().length > 0
        ? null
        : 'is empty, so the worker would appear to speak without a line';
  }
}

/**
 * The contract violations in one result. Empty when the tool is not covered,
 * when the call failed (a refusal owes only an explanation), or when the
 * success carries everything it promised.
 */
export function validateToolResult(toolName: string | null, result: ResultLike): { field: string; problem: string }[] {
  if (!toolName || result.ok !== true) return [];
  const schema = TOOL_RESULT_SCHEMAS[toolName];
  if (!schema) return [];

  const issues: { field: string; problem: string }[] = [];
  for (const field of schema.owes) {
    const problem = describeMissing(field, result[field]);
    if (problem !== null) issues.push({ field, problem: `${toolName} reported success but \`${field}\` ${problem}` });
  }
  if (schema.finishesTurn && result.followUp !== false) {
    issues.push({
      field: 'followUp',
      problem: `${toolName} reported success but asked for another turn, so the loop would continue on finished work`,
    });
  }
  return issues;
}
