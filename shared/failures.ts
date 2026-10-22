import type { MessageKey } from './i18n.ts';
import type { FailureReason, FailureSummary, Task } from './types.ts';

/**
 * The failure ledger.
 *
 * `blocked` was one status for six different causes, and the only detail lived
 * in a prose note. So "half the missions fail" was true, actionable and
 * un-actionable at the same time: nothing could be ranked. Every path that
 * blocks a task now sets one of the codes below, the store groups them, and the
 * board shows the ranking — which is the number to work on next.
 */

export const FAILURE_REASONS: readonly FailureReason[] = [
  'no_progress',
  'tool_loop',
  'budget',
  'model_error',
  'restart',
  'synthesis_stalled',
];

/** What the operator reads for each code. */
export const FAILURE_LABELS: Record<FailureReason, MessageKey> = {
  no_progress: 'failure.noProgress',
  tool_loop: 'failure.toolLoop',
  budget: 'failure.budget',
  model_error: 'failure.modelError',
  restart: 'failure.restart',
  synthesis_stalled: 'failure.synthesisStalled',
};

/**
 * What to do about it, in one line. A reason code that only renames the problem
 * is a dashboard; a reason code with a next step is a decision.
 */
export const FAILURE_NEXT_STEPS: Record<FailureReason, MessageKey> = {
  no_progress: 'failure.next.noProgress',
  tool_loop: 'failure.next.toolLoop',
  budget: 'failure.next.budget',
  model_error: 'failure.next.modelError',
  restart: 'failure.next.restart',
  synthesis_stalled: 'failure.next.synthesisStalled',
};

export function isFailureReason(value: unknown): value is FailureReason {
  return typeof value === 'string' && (FAILURE_REASONS as readonly string[]).includes(value);
}

/**
 * Groups blocked tasks by cause. Ordered by count, then by the order of
 * `FAILURE_REASONS` so two causes with the same count always rank the same way —
 * a ranking that reshuffles itself is not a ranking.
 */
export function summariseFailures(tasks: Task[]): FailureSummary {
  const counts = new Map<FailureReason, number>();
  const items: FailureSummary['tasks'] = [];

  for (const task of tasks) {
    if (task.status !== 'blocked') continue;
    const reason = task.failureReason;
    if (!reason || !isFailureReason(reason)) continue;
    counts.set(reason, (counts.get(reason) ?? 0) + 1);
    items.push({ taskId: task.id, title: task.title, reason, at: task.updatedAt });
  }

  const reasons = [...counts.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort(
      (left, right) =>
        right.count - left.count ||
        FAILURE_REASONS.indexOf(left.reason) - FAILURE_REASONS.indexOf(right.reason),
    );

  items.sort((left, right) => right.at - left.at);

  return { total: items.length, reasons, tasks: items.slice(0, 20) };
}
