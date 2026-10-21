import type {
  AgentProfile,
  AgentUsage,
  CostDay,
  MissionUsage,
  Task,
  TokenUsage,
  UsageHistory,
  UsageSummary,
} from './types.ts';

/** A zeroed counter, so a task or agent never has to carry `undefined` usage. */
export function emptyUsage(): TokenUsage {
  return { promptTokens: 0, completionTokens: 0, totalTokens: 0, turns: 0 };
}

export function addUsage(left: TokenUsage, right: TokenUsage): TokenUsage {
  return {
    promptTokens: left.promptTokens + right.promptTokens,
    completionTokens: left.completionTokens + right.completionTokens,
    totalTokens: left.totalTokens + right.totalTokens,
    turns: left.turns + right.turns,
  };
}

/**
 * Normalises usage read from disk or from a model response. A missing or
 * non-numeric field becomes 0 rather than `NaN`, which would poison every
 * total it is added to.
 */
export function coerceUsage(value: unknown): TokenUsage {
  const candidate = (value ?? {}) as Partial<Record<keyof TokenUsage, unknown>>;
  const read = (input: unknown): number =>
    typeof input === 'number' && Number.isFinite(input) && input > 0 ? Math.round(input) : 0;

  const promptTokens = read(candidate.promptTokens);
  const completionTokens = read(candidate.completionTokens);
  const totalTokens = read(candidate.totalTokens) || promptTokens + completionTokens;
  return { promptTokens, completionTokens, totalTokens, turns: read(candidate.turns) };
}

/** True when a turn or task spent nothing — kept out of the history and the UI. */
export function isUnused(usage: TokenUsage): boolean {
  return usage.totalTokens === 0 && usage.turns === 0;
}

/**
 * A task's own spend plus every subtask delegated below it.
 * The walk is breadth-first with a visited set, so a hand-edited board with a
 * cycle cannot hang the render.
 */
export function missionUsage(taskId: string, tasks: Iterable<Task>): TokenUsage {
  const byParent = new Map<string, Task[]>();
  let root: Task | null = null;
  for (const task of tasks) {
    if (task.id === taskId) root = task;
    if (task.parentId === null) continue;
    const siblings = byParent.get(task.parentId) ?? [];
    siblings.push(task);
    byParent.set(task.parentId, siblings);
  }
  if (!root) return emptyUsage();

  let total = emptyUsage();
  const visited = new Set<string>([taskId]);
  const queue: Task[] = [root];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) continue;
    total = addUsage(total, current.usage);
    for (const child of byParent.get(current.id) ?? []) {
      if (visited.has(child.id)) continue;
      visited.add(child.id);
      queue.push(child);
    }
  }
  return total;
}

/** Subtasks below a task, so the UI can show who spent what inside a mission. */
export function childrenOf(taskId: string, tasks: Iterable<Task>): Task[] {
  return [...tasks].filter((task) => task.parentId === taskId);
}

/** Builds the office-wide meter: per worker, per mission, and the total. */
export function usageSummary(
  agents: Iterable<AgentProfile>,
  tasks: Iterable<Task>,
): UsageSummary {
  const taskList = [...tasks];
  const agentRows: AgentUsage[] = [...agents]
    .map((agent) => ({
      agentId: agent.id,
      name: agent.name,
      role: agent.role,
      usage: agent.usage,
    }))
    .sort((left, right) => right.usage.totalTokens - left.usage.totalTokens);

  const missionRows: MissionUsage[] = [];
  const taskRows: MissionUsage[] = [];
  let total = emptyUsage();

  for (const task of taskList) {
    const rolled = missionUsage(task.id, taskList);
    total = addUsage(total, task.usage);
    if (task.mission || rolled.totalTokens > task.usage.totalTokens) {
      missionRows.push({
        taskId: task.id,
        title: task.title,
        status: task.status,
        mission: task.mission,
        usage: rolled,
      });
    } else if (!task.parentId) {
      // Subtasks already count inside their mission, so only the roots that are
      // not part of a team show up as standalone rows.
      taskRows.push({
        taskId: task.id,
        title: task.title,
        status: task.status,
        mission: task.mission,
        usage: task.usage,
      });
    }
  }

  missionRows.sort((left, right) => right.usage.totalTokens - left.usage.totalTokens);
  taskRows.sort((left, right) => right.usage.totalTokens - left.usage.totalTokens);

  return { total, agents: agentRows, missions: missionRows, tasks: taskRows };
}

/** Local calendar day, so "today" matches the operator's clock, not UTC. */
function dayKey(at: number): string {
  const date = new Date(at);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

/**
 * Finished work grouped by the day it finished: every done mission rolled up
 * with its subtasks, plus standalone tasks that delegated to nobody. Each token
 * appears once — a subtask is never counted next to the mission that owns it.
 */
export function usageHistory(tasks: Iterable<Task>): UsageHistory {
  const taskList = [...tasks];
  const days = new Map<string, CostDay>();
  const missions: MissionUsage[] = [];
  let total = emptyUsage();

  const record = (date: string, usage: TokenUsage, row: MissionUsage): void => {
    const day = days.get(date) ?? { date, usage: emptyUsage(), missions: [] };
    day.usage = addUsage(day.usage, usage);
    day.missions.push(row);
    days.set(date, day);
  };

  for (const task of taskList) {
    if (task.status !== 'done') continue;
    // A subtask's spend is already inside its mission.
    if (task.parentId !== null) continue;

    const usage = missionUsage(task.id, taskList);
    if (isUnused(usage)) continue;

    const row: MissionUsage = {
      taskId: task.id,
      title: task.title,
      status: task.status,
      mission: task.mission,
      usage,
    };
    missions.push(row);
    total = addUsage(total, usage);
    record(dayKey(task.updatedAt), usage, row);
  }

  const orderedDays = [...days.values()].sort((left, right) => right.date.localeCompare(left.date));
  for (const day of orderedDays) {
    day.missions.sort((left, right) => right.usage.totalTokens - left.usage.totalTokens);
  }
  missions.sort((left, right) => right.usage.totalTokens - left.usage.totalTokens);

  return { total, days: orderedDays, missions };
}
