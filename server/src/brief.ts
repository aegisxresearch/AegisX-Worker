/**
 * The gate in front of `create_task`.
 *
 * The team doctrine asks every worker to brief a teammate with six things. A
 * doctrine that only exists in the prompt is advice; a lead in a hurry writes
 * "improve the UI", the specialist guesses, and the mission burns rounds
 * discovering what was meant. This module answers one question before the task
 * exists: can the person receiving this brief do anything with it?
 *
 * Two rules, both chosen because they are decidable from the text:
 * - a brief has to name a concrete anchor — a file path, a check, an endpoint —
 *   or say in so many words that no file changes;
 * - it has to be long enough to carry an instruction at all.
 *
 * Everything else (out-of-scope, the acceptance test) is reported as a note on
 * a task that was still created. A hard wall on the whole six-part doctrine
 * would stop a lead from delegating a small, obvious job, and a lead that
 * cannot delegate is worse than one that delegates thinly.
 */

/** What the receiving worker can act on. Order is the order they are checked. */
const ANCHOR_PATTERNS: { id: string; pattern: RegExp }[] = [
  // A path with an extension: the single strongest signal that the brief knows
  // which file it is talking about.
  { id: 'path', pattern: /\b[\w@.-]+(?:\/[\w@.-]+)*\.(?:tsx?|jsx?|mjs|cjs|json|css|scss|html|md|py|go|rs|rb|php|java|kt|dart|swift|sql|yml|yaml|toml|sh)\b/i },
  // A command the folder can run, which is also the acceptance test. Tool
  // names are words too — "make the product better", "go ahead" — so a bare
  // runner only counts inside backticks or followed by a known subcommand.
  {
    id: 'command',
    pattern:
      /`[^`]*(?:npm|pnpm|yarn|bun|node|npx|pytest|python3?|go|cargo|make|flutter|dart|git)\s+[^`]+`|\b(?:npm|pnpm|yarn|bun|npx|pytest|python3?|cargo|flutter|dart)\s+(?:run|test|install|build|exec|add|ci)\b/i,
  },
  // An endpoint or route.
  { id: 'endpoint', pattern: /\b(?:GET|POST|PUT|PATCH|DELETE)\s+\/|\/api\/[\w-]+/i },
  // An explicit "nothing to change" is a legitimate brief for a review job.
  { id: 'no-change', pattern: /\bno (?:file|code|source) changes?\b|\bread[- ]only\b|\breview only\b/i },
  // A backticked identifier: `orders.created_at`, `cartTotal`, `--dry-run`.
  // Not a path, but a token the receiver can search for, which is the minimum
  // a brief owes — and it keeps a schema change from reading as "no anchor".
  { id: 'literal', pattern: /`[^`]{2,80}`/ },
  // A statement the database can run, or the object it changes, for work whose
  // deliverable is SQL rather than a file in the folder.
  {
    id: 'sql',
    pattern:
      /\b(?:create|alter|drop|truncate|add)\s+(?:an?\s+)?(?:table|index|column|view|schema|migration|materialized)\b|\bselect\b[^;]{0,120}\bfrom\b/i,
  },
];

/** Words that state what will be true when the work is done. */
const ACCEPTANCE_PATTERN =
  /\b(test|tests|check|checks|verify|verified|assert|expects?|returns?|passes|fails?|must|should|acceptance|green|reproduce|proves?|proof|matches|reconciles)\b/i;

/** Phrases that bound the work, so scope cannot grow silently. */
const NON_GOAL_PATTERN = /\b(do not|don't|out of scope|not part of|leave .* alone|without changing|only)\b/i;

export interface BriefVerdict {
  ok: boolean;
  /** Which doctrine parts are present, as stable ids for the check and the log. */
  found: string[];
  /** The one thing to say when the brief is refused. Empty when it is not. */
  refusal: string;
  /** A short advisory attached to a brief that was accepted anyway. */
  warning: string;
}

/** Shortest detail that can contain an instruction; below this it is a title. */
const MIN_DETAIL_CHARS = 40;

/**
 * Judges a delegation brief. Deterministic and dependency-free: the same text
 * always gives the same answer, so a check can pin it and a worker cannot
 * bargain with it.
 */
export function checkBrief(input: { title: string; detail: string }): BriefVerdict {
  const title = input.title.trim();
  const detail = input.detail.trim();
  const text = `${title}\n${detail}`;
  const anchors = ANCHOR_PATTERNS.filter((entry) => entry.pattern.test(text)).map((entry) => entry.id);
  const found = [...anchors];
  if (ACCEPTANCE_PATTERN.test(text)) found.push('acceptance');
  if (NON_GOAL_PATTERN.test(text)) found.push('boundary');

  if (detail.length < MIN_DETAIL_CHARS) {
    return {
      ok: false,
      found,
      refusal:
        `The brief for "${title || 'this task'}" has no usable detail (${detail.length} characters). ` +
        'A teammate sees only what you write. Call create_task again with a detail that names the exact ' +
        'file it owns, what the result must do, and how it will be checked — for example ' +
        '"edit client/src/ui/chat.ts so Send is disabled while the input is empty; add the case to ' +
        'scripts/chat-check.mjs; do not touch the stylesheet".',
      warning: '',
    };
  }

  // Anchors only. "It must be better" is an adjective, not something a worker
  // can open, run or search for, and accepting it is how a title becomes a task.
  if (anchors.length === 0) {
    return {
      ok: false,
      found,
      refusal:
        `The brief for "${title}" names no file, command, endpoint or explicit "no file changes", so the ` +
        'worker has to guess what to touch. Name the path it owns (for example "server/src/routes/tasks.ts") ' +
        'or the check that will prove it, then call create_task again.',
      warning: '',
    };
  }

  const advisory: string[] = [];
  if (!found.includes('acceptance')) {
    advisory.push('it names no acceptance test');
  }
  if (!found.includes('boundary')) {
    advisory.push('it sets no boundary');
  }
  return {
    ok: true,
    found,
    refusal: '',
    warning:
      advisory.length === 0
        ? ''
        : `Advisory for this brief: ${advisory.join(' and ')} — the worker may over-deliver or stop early. ` +
          'The next brief should say what proves it done and what is out of scope.',
  };
}

/** The parts a brief can carry, for docs and for the check's own report. */
export function briefParts(): string[] {
  return [...ANCHOR_PATTERNS.map((entry) => entry.id), 'acceptance', 'boundary'];
}
