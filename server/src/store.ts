import { randomUUID } from 'node:crypto';
import type {
  AgentProfile,
  AgentStatus,
  ChatMessage,
  LogEntry,
  LogLevel,
  OfficeSettings,
  PublicSettings,
  SessionSnapshot,
  Task,
  TaskPriority,
  TaskStatus,
  TokenUsage,
  UsageHistory,
  UsageSummary,
} from '../../shared/types.ts';
import { addUsage, coerceUsage, emptyUsage, usageHistory, usageSummary } from '../../shared/usage.ts';
import { DEFAULT_ENDPOINT, DEFAULT_MODEL, FREE_MODEL, WEB_ENABLED, WORKSPACE_DIR } from './config.ts';
import type { EventBus } from './events.ts';

export function shortId(prefix: string): string {
  return `${prefix}_${randomUUID().slice(0, 8)}`;
}

/** Everything that has to survive a restart, in the shape written to disk. */
export interface OfficeDiskState {
  settings: OfficeSettings;
  agents: AgentProfile[];
  tasks: Task[];
  logs: LogEntry[];
  chats: ChatMessage[];
}

/** Finished tasks kept on disk; the board would otherwise grow without bound. */
const DONE_TASK_HISTORY = 300;
const LOG_HISTORY = 200;
const CHAT_HISTORY = 120;

interface SeedAgent {
  name: string;
  role: string;
  color: string;
  deskIndex: number;
}

/**
 * The roster. The lead sits first because it is the one a team mission is
 * handed to; the rest are specialists the lead delegates to.
 */
const SEED_AGENTS: SeedAgent[] = [
  { name: 'Nadia', role: 'Tech Lead', color: '#d4694f', deskIndex: 0 },
  { name: 'Aria', role: 'Frontend Engineer', color: '#2fb8a6', deskIndex: 1 },
  { name: 'Bimo', role: 'Backend Engineer', color: '#e9a23b', deskIndex: 2 },
  { name: 'Raka', role: 'Mobile App Engineer', color: '#3aa3d9', deskIndex: 3 },
  { name: 'Sinta', role: 'AI Engineer', color: '#d8b44a', deskIndex: 4 },
  { name: 'Yoga', role: 'ML Engineer', color: '#7a9e4b', deskIndex: 5 },
  { name: 'Citra', role: 'QA Engineer', color: '#e06c9f', deskIndex: 6 },
  { name: 'Tari', role: 'Security Engineer', color: '#c4577e', deskIndex: 7 },
  { name: 'Dimas', role: 'Data Engineer', color: '#8fb800', deskIndex: 8 },
  { name: 'Elma', role: 'Product Manager', color: '#4c9aff', deskIndex: 9 },
  { name: 'Fajar', role: 'DevOps Engineer', color: '#ff7a45', deskIndex: 10 },
];

/**
 * Holds the whole office state.
 * The API key lives here as a private field and is never included in a snapshot.
 */
export class OfficeStore {
  readonly #bus: EventBus;
  #apiKey: string | null = null;
  #availableModels: string[] = [];

  settings: OfficeSettings = {
    endpoint: DEFAULT_ENDPOINT,
    model: DEFAULT_MODEL,
    toolsEnabled: false,
    webEnabled: WEB_ENABLED,
    workspaceRoot: WORKSPACE_DIR,
    demoMode: true,
  };

  readonly agents = new Map<string, AgentProfile>();
  readonly tasks = new Map<string, Task>();
  readonly logs: LogEntry[] = [];
  readonly chats: ChatMessage[] = [];

  constructor(bus: EventBus) {
    this.#bus = bus;
  }

  // ── session settings ──────────────────────────────────────────────────────

  get apiKey(): string | null {
    return this.#apiKey;
  }

  get availableModels(): string[] {
    return this.#availableModels;
  }

  setAvailableModels(models: string[]): void {
    this.#availableModels = models;
  }

  applyCredentials(input: {
    endpoint: string;
    apiKey: string;
    model: string;
    toolsEnabled: boolean;
  }): void {
    this.settings = {
      ...this.settings,
      endpoint: input.endpoint.replace(/\/+$/, ''),
      model: input.model,
      toolsEnabled: input.toolsEnabled,
      demoMode: false,
    };
    this.#apiKey = input.apiKey;
  }

  setDemoMode(enabled: boolean): void {
    this.settings = { ...this.settings, demoMode: enabled };
  }

  setModel(model: string): void {
    this.settings = { ...this.settings, model };
  }

  setToolsEnabled(enabled: boolean): void {
    this.settings = { ...this.settings, toolsEnabled: enabled };
  }

  setWebEnabled(enabled: boolean): void {
    this.settings = { ...this.settings, webEnabled: enabled };
  }

  setWorkspaceRoot(root: string): void {
    this.settings = { ...this.settings, workspaceRoot: root };
  }

  publicSettings(): PublicSettings {
    const key = this.#apiKey;
    return {
      endpoint: this.settings.endpoint,
      model: this.settings.model,
      freeModel: FREE_MODEL,
      toolsEnabled: this.settings.toolsEnabled,
      webEnabled: this.settings.webEnabled,
      workspaceRoot: this.settings.workspaceRoot,
      demoMode: this.settings.demoMode,
      configured: Boolean(key),
      maskedKey: key ? `${key.slice(0, 6)}…${key.slice(-4)}` : null,
      availableModels: this.#availableModels,
    };
  }

  publishSettings(): void {
    this.#bus.publish('session.updated', this.publicSettings());
  }

  // ── agents ────────────────────────────────────────────────────────────────

  seedAgents(): void {
    for (const seed of SEED_AGENTS) {
      const agent: AgentProfile = {
        id: shortId('agent'),
        name: seed.name,
        role: seed.role,
        color: seed.color,
        model: this.settings.model,
        deskIndex: seed.deskIndex,
        station: 'desk',
        status: 'idle',
        currentTaskId: null,
        taskSummary: null,
        tokensUsed: 0,
        usage: emptyUsage(),
        lastEventAt: Date.now(),
      };
      this.agents.set(agent.id, agent);
    }
  }

  createAgent(input: { name: string; role: string; color: string; model?: string }): AgentProfile {
    const agent: AgentProfile = {
      id: shortId('agent'),
      name: input.name.trim() || 'Agent',
      role: input.role.trim() || 'Engineer',
      color: input.color,
      model: input.model ?? this.settings.model,
      deskIndex: this.agents.size,
      station: 'desk',
      status: 'idle',
      currentTaskId: null,
      taskSummary: null,
      tokensUsed: 0,
      usage: emptyUsage(),
      lastEventAt: Date.now(),
    };
    this.agents.set(agent.id, agent);
    this.#bus.publish('agent.updated', agent);
    return agent;
  }

  updateAgent(id: string, patch: Partial<AgentProfile>): AgentProfile | null {
    const agent = this.agents.get(id);
    if (!agent) return null;
    const next: AgentProfile = { ...agent, ...patch, lastEventAt: Date.now() };
    this.agents.set(id, next);
    this.#bus.publish('agent.updated', next);
    return next;
  }

  setAgentStatus(id: string, status: AgentStatus, taskSummary?: string | null): void {
    const agent = this.agents.get(id);
    if (!agent) return;
    this.updateAgent(id, {
      status,
      ...(taskSummary !== undefined ? { taskSummary } : {}),
    });
  }

  removeAgent(id: string): void {
    if (!this.agents.delete(id)) return;
    this.#bus.publish('agent.removed', { id });
  }

  // ── tasks ─────────────────────────────────────────────────────────────────

  createTask(input: {
    title: string;
    detail: string;
    priority: TaskPriority;
    assigneeId: string | null;
    parentId?: string | null;
    mission?: boolean;
  }): Task {
    const now = Date.now();
    const task: Task = {
      id: shortId('task'),
      title: input.title.trim() || 'Untitled task',
      detail: input.detail,
      status: input.assigneeId ? 'doing' : 'todo',
      priority: input.priority,
      assigneeId: input.assigneeId,
      createdAt: now,
      updatedAt: now,
      notes: [],
      parentId: input.parentId ?? null,
      mission: input.mission === true,
      usage: emptyUsage(),
    };
    this.tasks.set(task.id, task);
    this.#bus.publish('task.updated', task);
    return task;
  }

  updateTask(id: string, patch: Partial<Task>): Task | null {
    const task = this.tasks.get(id);
    if (!task) return null;
    const next: Task = { ...task, ...patch, updatedAt: Date.now() };
    this.tasks.set(id, next);
    this.#bus.publish('task.updated', next);
    return next;
  }

  addTaskNote(id: string, note: string): Task | null {
    const task = this.tasks.get(id);
    if (!task) return null;
    return this.updateTask(id, { notes: [...task.notes, note] });
  }

  removeTask(id: string): void {
    if (!this.tasks.delete(id)) return;
    this.#bus.publish('task.removed', { id });
  }

  // ── token meter ───────────────────────────────────────────────────────────

  /**
   * Books one turn's spend against the worker and the task it worked on.
   * Both counters move together here so the roster and the board can never
   * disagree about what a mission cost.
   */
  recordUsage(agentId: string, taskId: string | null, usage: TokenUsage): void {
    if (usage.totalTokens === 0 && usage.turns === 0) return;

    const agent = this.agents.get(agentId);
    if (agent) {
      const next = addUsage(agent.usage, usage);
      this.updateAgent(agentId, { usage: next, tokensUsed: next.totalTokens });
    }

    if (!taskId) return;
    const task = this.tasks.get(taskId);
    if (!task) return;
    this.updateTask(taskId, { usage: addUsage(task.usage, usage) });
  }

  /** Office-wide meter: total, per worker, per mission. */
  tokenSummary(): UsageSummary {
    return usageSummary(this.agents.values(), this.tasks.values());
  }

  /** Finished work grouped by the day it finished, for the history panel. */
  costHistory(): UsageHistory {
    return usageHistory(this.tasks.values());
  }

  // ── log ───────────────────────────────────────────────────────────────────

  appendLog(
    level: LogLevel,
    kind: string,
    message: string,
    agentId: string | null = null,
    tokens: TokenUsage | null = null,
  ): LogEntry {
    const entry: LogEntry = { id: shortId('log'), at: Date.now(), level, kind, message, agentId, tokens };
    this.logs.push(entry);
    if (this.logs.length > 400) this.logs.splice(0, this.logs.length - 400);
    this.#bus.publish('log.appended', entry);
    return entry;
  }

  // ── chat ──────────────────────────────────────────────────────────────────

  appendChat(message: Omit<ChatMessage, 'id' | 'at'>): ChatMessage {
    const chat: ChatMessage = { ...message, id: shortId('msg'), at: Date.now() };
    this.chats.push(chat);
    if (this.chats.length > 300) this.chats.splice(0, this.chats.length - 300);
    this.#bus.publish('chat.message', chat);
    return chat;
  }

  patchChat(id: string, patch: Partial<ChatMessage>): ChatMessage | null {
    const chat = this.chats.find((entry) => entry.id === id);
    if (!chat) return null;
    const next = { ...chat, ...patch };
    const index = this.chats.indexOf(chat);
    this.chats[index] = next;
    this.#bus.publish('chat.message', next);
    return next;
  }

  // ── persistence ───────────────────────────────────────────────────────────

  /**
   * The state worth writing to disk. Open work is always kept; finished work is
   * capped, together with its ancestors, so a subtask never outlives the mission
   * it belongs to.
   */
  diskState(): OfficeDiskState {
    return {
      settings: { ...this.settings },
      agents: [...this.agents.values()],
      tasks: this.#tasksForDisk(),
      logs: this.logs.slice(-LOG_HISTORY),
      // A chat that was mid-stream when the process died can never stream again.
      chats: this.chats.slice(-CHAT_HISTORY).map((chat) => ({ ...chat, streaming: false })),
    };
  }

  #tasksForDisk(): Task[] {
    const all = [...this.tasks.values()];
    const keep = new Set<string>();
    for (const task of all) {
      if (task.status !== 'done') keep.add(task.id);
    }
    const finished = all
      .filter((task) => task.status === 'done')
      .sort((left, right) => right.updatedAt - left.updatedAt);
    for (const task of finished.slice(0, DONE_TASK_HISTORY)) keep.add(task.id);

    const byId = new Map(all.map((task) => [task.id, task]));
    for (const id of [...keep]) {
      let ancestorId = byId.get(id)?.parentId ?? null;
      while (ancestorId !== null && !keep.has(ancestorId)) {
        keep.add(ancestorId);
        ancestorId = byId.get(ancestorId)?.parentId ?? null;
      }
    }
    return all.filter((task) => keep.has(task.id));
  }

  /**
   * Replaces the in-memory office with a state read from disk. Nothing is
   * published here: the client subscribes after boot, and a restored snapshot
   * must not look like a burst of live changes.
   *
   * `demoMode` is deliberately not restored — the launcher decides it per
   * process, and a stale `false` would put a keyless boot into live mode.
   */
  restore(state: OfficeDiskState): void {
    this.agents.clear();
    this.tasks.clear();
    this.logs.length = 0;
    this.chats.length = 0;

    this.settings = {
      ...this.settings,
      model: state.settings.model || this.settings.model,
      toolsEnabled: state.settings.toolsEnabled,
      webEnabled: state.settings.webEnabled,
      workspaceRoot: state.settings.workspaceRoot || this.settings.workspaceRoot,
    };

    for (const agent of state.agents) {
      const usage = coerceUsage(agent.usage);
      this.agents.set(agent.id, { ...agent, usage, tokensUsed: usage.totalTokens });
    }
    for (const task of state.tasks) {
      this.tasks.set(task.id, { ...task, usage: coerceUsage(task.usage) });
    }
    this.logs.push(...state.logs);
    this.chats.push(...state.chats.map((chat) => ({ ...chat, streaming: false })));
  }

  // ── snapshot ──────────────────────────────────────────────────────────────

  snapshot(): SessionSnapshot {
    return {
      settings: this.publicSettings(),
      agents: [...this.agents.values()],
      tasks: [...this.tasks.values()].sort((left, right) => right.createdAt - left.createdAt),
      logs: this.logs.slice(-120),
      chats: this.chats.slice(-120),
      usage: this.tokenSummary(),
    };
  }
}
