import type { Task } from '../../shared/types.ts';

/**
 * Dependencies between tasks, kept small on purpose.
 *
 * A mission's subtasks used to be a flat list the lead reconciled at the end.
 * The moment one subtask needs another's output — the API before the client
 * that calls it — a flat list forces the lead to serialise everything and wait.
 * These three functions are the whole scheduler: what still blocks a task, what
 * became runnable, and in what waves the board can be drawn.
 *
 * They are pure: the store owns the tasks, this file only reads them.
 */

/** Dependency ids that exist and are not done yet, in the order they were declared. */
export function unresolvedDependencies(task: Task, tasks: Map<string, Task>): string[] {
  const declared = task.dependsOn ?? [];
  const blocking: string[] = [];
  for (const id of declared) {
    if (id === task.id) continue;
    const dependency = tasks.get(id);
    // A dependency that was deleted cannot hold work back forever.
    if (!dependency) continue;
    if (dependency.status !== 'done') blocking.push(id);
  }
  return blocking;
}

/**
 * Tasks that just became runnable because `completedId` settled.
 *
 * Only tasks that never started are returned: a task already `doing` is not
 * restarted, and one that is `blocked` is waiting on a person, not a sibling.
 */
export function readyTasks(tasks: Map<string, Task>, completedId: string): Task[] {
  const ready: Task[] = [];
  for (const task of tasks.values()) {
    if (task.status !== 'todo') continue;
    if (!(task.dependsOn ?? []).includes(completedId)) continue;
    if (unresolvedDependencies(task, tasks).length > 0) continue;
    ready.push(task);
  }
  return ready.sort((left, right) => left.createdAt - right.createdAt);
}

/**
 * Dependency waves, for a board or a plan view: wave 0 is everything with no
 * unfinished dependency, wave 1 depends only on wave 0, and so on.
 *
 * A cycle is not an error here — it is a fact about the board. Tasks in a cycle
 * land in the last wave together, so the UI can show them and a person can
 * decide, instead of the scheduler hanging or the office crashing.
 */
export function dependencyWaves(tasks: Task[]): Task[][] {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const depth = new Map<string, number>();

  const depthOf = (task: Task, seen: Set<string>): number => {
    const known = depth.get(task.id);
    if (known !== undefined) return known;
    if (seen.has(task.id)) return 0; // a cycle: treat the edge back as no constraint
    seen.add(task.id);
    let value = 0;
    for (const id of task.dependsOn ?? []) {
      const dependency = byId.get(id);
      if (!dependency || id === task.id) continue;
      value = Math.max(value, depthOf(dependency, seen) + 1);
    }
    seen.delete(task.id);
    depth.set(task.id, value);
    return value;
  };

  const waves: Task[][] = [];
  for (const task of tasks) {
    const level = depthOf(task, new Set());
    const bucket = waves[level] ?? (waves[level] = []);
    bucket.push(task);
  }
  return waves.map((wave) => wave ?? []);
}
