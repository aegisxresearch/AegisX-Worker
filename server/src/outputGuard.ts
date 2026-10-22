import { validateToolResult, type ResultLike } from './resultSchemas.ts';

/**
 * A tool result is model context, so its shape is part of the contract.
 *
 * Three failures this catches cheaply: a result with no summary (the model sees
 * an empty line and repeats the call), a `next_actions` entry naming a tool that
 * does not exist (the model asks for it and the dispatcher answers "Unknown
 * action"), and a non-array `artifacts` (the log panel renders nothing and the
 * turn looks broken). None of those should reach the model.
 */

export interface ObservationLike {
  ok: boolean;
  summary: string;
  detail?: string;
  nextActions?: string[];
  artifacts?: string[];
  code?: string;
}

export interface ObservationIssue {
  field: string;
  problem: string;
}

/** What the model receives for one tool call. */
export interface ObservationView {
  status: 'success' | 'error';
  summary: string;
  detail?: string;
  next_actions: string[];
  artifacts: string[];
}

export interface ObservationBuild {
  observation: ObservationView;
  issues: ObservationIssue[];
  /**
   * True when the tool claimed success without the payload it owes. The call is
   * reported to the model as a failure rather than as evidence it can trust.
   */
  contractViolated: boolean;
}

/** The detail a model sees is capped; the payload is context, not storage. */
const DEFAULT_DETAIL_LIMIT = 4_000;

/** Kept in sync with `ToolErrorCode`; a code outside this list is a typo. */
const KNOWN_CODES = new Set([
  'path_outside',
  'binary_refused',
  'jail_unavailable',
  'timeout',
  'exit_nonzero',
  'not_found',
  'denied_by_policy',
  'path_locked',
  'stale_read',
  'needs_approval',
  'invalid_args',
  'upstream_error',
]);

const MAX_SUMMARY = 2_000;

export function validateObservation(result: ObservationLike, knownTools: Set<string>): ObservationIssue[] {
  return validateShape(result, knownTools);
}

function validateShape(result: ObservationLike, knownTools: Set<string>): ObservationIssue[] {
  const issues: ObservationIssue[] = [];
  if (typeof result.ok !== 'boolean') issues.push({ field: 'ok', problem: 'must be a boolean' });
  if (typeof result.summary !== 'string' || result.summary.trim().length === 0) {
    issues.push({ field: 'summary', problem: 'must be a non-empty string' });
  } else if (result.summary.length > MAX_SUMMARY) {
    issues.push({ field: 'summary', problem: `is ${result.summary.length} chars (max ${MAX_SUMMARY})` });
  }
  if (result.detail !== undefined && typeof result.detail !== 'string') {
    issues.push({ field: 'detail', problem: 'must be a string when present' });
  }
  if (result.nextActions !== undefined) {
    if (!Array.isArray(result.nextActions)) {
      issues.push({ field: 'nextActions', problem: 'must be a list' });
    } else {
      const unknown = result.nextActions.filter((action) => typeof action !== 'string' || !knownTools.has(action));
      if (unknown.length > 0) {
        issues.push({ field: 'nextActions', problem: `names unknown tool(s): ${unknown.join(', ')}` });
      }
    }
  }
  if (result.artifacts !== undefined) {
    if (!Array.isArray(result.artifacts) || result.artifacts.some((entry) => typeof entry !== 'string')) {
      issues.push({ field: 'artifacts', problem: 'must be a list of strings' });
    }
  }
  if (result.code !== undefined && !KNOWN_CODES.has(result.code)) {
    issues.push({ field: 'code', problem: `"${String(result.code).slice(0, 40)}" is not a known tool error code` });
  }
  return issues;
}

/**
 * The result the model is allowed to see: summary trimmed, unknown
 * `next_actions` dropped, artifact/code noise removed. Never mutates the input.
 */
export function sanitizeObservation<T extends ObservationLike>(result: T, knownTools: Set<string>): T {
  const summary = typeof result.summary === 'string' ? result.summary.trim().slice(0, MAX_SUMMARY) : '';
  const nextActions = Array.isArray(result.nextActions)
    ? [...new Set(result.nextActions.filter((action) => typeof action === 'string' && knownTools.has(action)))]
    : undefined;
  const artifacts = Array.isArray(result.artifacts)
    ? result.artifacts.filter((entry) => typeof entry === 'string')
    : undefined;

  return {
    ...result,
    summary: summary.length > 0 ? summary : 'The tool finished without a summary.',
    ...(nextActions ? { nextActions } : {}),
    ...(artifacts ? { artifacts } : {}),
    ...(result.code !== undefined && KNOWN_CODES.has(result.code) ? {} : { code: undefined }),
  };
}

/**
 * One tool call, as the model will read it.
 *
 * Both halves of the contract are applied here — the shared shape rules and the
 * per-tool payload the call owes (see `resultSchemas.ts`) — so the runtime and
 * `check:outputs` exercise the same code instead of the check trusting a
 * parallel copy of it. A success that violates its own contract is turned into
 * an error observation: the model must not build the next step on a result the
 * tool could not actually deliver.
 */
export function buildObservation(
  result: ObservationLike & ResultLike & { followUp?: boolean },
  options: { toolName: string | null; knownTools: Set<string>; detailLimit?: number },
): ObservationBuild {
  const shapeIssues = validateShape(result, options.knownTools);
  const contractIssues = validateToolResult(options.toolName, result);
  const clean = sanitizeObservation(result, options.knownTools);
  const detailLimit = options.detailLimit ?? DEFAULT_DETAIL_LIMIT;

  const rejected = contractIssues.length > 0;
  const rejectedFields = [...new Set(contractIssues.map((issue) => issue.field))];
  const summary = rejected
    ? [
        `Result rejected: this ${options.toolName ?? 'tool'} call reported success but did not hand over ${rejectedFields.join(', ')}.`,
        clean.summary,
        'Treat it as a failed call — take a different route instead of repeating it unchanged.',
      ].join(' ')
    : clean.summary;

  return {
    observation: {
      status: rejected ? 'error' : clean.ok ? 'success' : 'error',
      summary,
      ...(clean.detail && clean.detail.length > 0 ? { detail: clean.detail.slice(0, detailLimit) } : {}),
      next_actions: clean.nextActions ?? [],
      artifacts: clean.artifacts ?? [],
    },
    issues: [...shapeIssues, ...contractIssues],
    contractViolated: rejected,
  };
}
