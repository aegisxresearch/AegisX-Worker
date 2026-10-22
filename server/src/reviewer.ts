import { chat, type LlmMessage, type LlmSettings, type LlmUsage } from './llm.ts';
import { roleReviewBrief } from './rolePacks.ts';

/**
 * An independent reviewer.
 *
 * The completion gate answers "does the folder's own tooling agree?". It cannot
 * answer "did this change do what was asked without quietly breaking something
 * the diff reveals?" — the worker wrote the code, and asking it to grade itself
 * is how a deleted test passes review. This pass reads the diff and the task,
 * not the worker's summary, and returns a verdict the runtime can refuse.
 *
 * Two rules keep it honest:
 * - the diff is the evidence, so no diff means no review (nothing to judge);
 * - a review that cannot be parsed is not a pass. `parseReview` returns null and
 *   the caller logs it instead of guessing.
 */

export interface ReviewInput {
  taskTitle: string;
  taskDetail: string;
  agentName: string;
  /** The worker's role, so the bar is the one that role works to. */
  role?: string;
  /** The playbook the task actually ran under, when it was chosen explicitly. */
  pack?: string | null;
  /** Checks that already passed, by name. */
  checks: string[];
  /** What changed since the task started, as the git layer summarises it. */
  diff: string;
}

export interface ReviewVerdict {
  verdict: 'pass' | 'fail';
  reasons: string[];
  usage?: LlmUsage;
}

const MAX_DIFF_CHARS = 6_000;
const MAX_REASONS = 5;
const MAX_REASON_CHARS = 300;

/** The contract, in one place so the mock in the checks and the server agree. */
export function buildReviewMessages(input: ReviewInput): LlmMessage[] {
  const checks = input.checks.length > 0 ? input.checks.join(', ') : 'none — the folder has no automated check';
  return [
    {
      role: 'system',
      content: [
        'You are the independent reviewer for a finished task. You did not write this code.',
        'Judge the change against the task using only the evidence below. Do not invent files or tests.',
        'Refuse when: the deliverable the task asked for is missing; the diff contradicts the task; a test',
        'was deleted, skipped or weakened; hard-coded output replaces real logic; or the change breaks an',
        'interface the diff itself shows being used elsewhere.',
        // A frontend deliverable and a migration are not judged on the same
        // things; without the role the reviewer applies one generic bar and
        // refuses good work for the wrong reason.
        input.role ? roleReviewBrief(input.role, input.pack) : '',
        'Reply with exactly one JSON object and nothing else:',
        '{"verdict":"pass"|"fail","reasons":["one short sentence per problem"]}',
        'For a pass, "reasons" may be an empty array.',
      ]
        .filter((line) => line.length > 0)
        .join(' '),
    },
    {
      role: 'user',
      content: [
        `Task: ${input.taskTitle}`,
        input.taskDetail ? `Details: ${input.taskDetail.slice(0, 1_500)}` : '',
        `Worker: ${input.agentName}`,
        `Checks that passed: ${checks}`,
        '',
        'Changes since the task started:',
        input.diff.slice(0, MAX_DIFF_CHARS),
      ]
        .filter((line) => line.length > 0)
        .join('\n'),
    },
  ];
}

/**
 * Reads the verdict out of a model reply.
 *
 * Models wrap JSON in prose or fences often enough that refusing those would
 * make the feature useless; taking the first balanced object is enough. A reply
 * with no object, or with an unknown verdict, is `null` — never an implicit pass.
 */
export function parseReview(raw: string): ReviewVerdict | null {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end <= start) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const verdict = (parsed as { verdict?: unknown }).verdict;
  if (verdict !== 'pass' && verdict !== 'fail') return null;

  const rawReasons = (parsed as { reasons?: unknown }).reasons;
  const reasons = (Array.isArray(rawReasons) ? rawReasons : [])
    .filter((reason): reason is string => typeof reason === 'string')
    .map((reason) => reason.replace(/\s+/g, ' ').trim().slice(0, MAX_REASON_CHARS))
    .filter((reason) => reason.length > 0)
    .slice(0, MAX_REASONS);

  // A refusal with no reason is unusable: the worker would have nothing to fix.
  if (verdict === 'fail' && reasons.length === 0) return null;
  return { verdict, reasons };
}

/** One reviewer call. Throws on transport errors; the caller decides what that means. */
export async function reviewWork(settings: LlmSettings, input: ReviewInput): Promise<ReviewVerdict | null> {
  const result = await chat(settings, buildReviewMessages(input));
  const parsed = parseReview(result.content);
  return parsed ? { ...parsed, usage: result.usage } : null;
}
