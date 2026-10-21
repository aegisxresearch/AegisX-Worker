/**
 * Domain types shared by the office server and the browser client.
 * Kept dependency-free so both bundles can import it without extra runtime cost.
 */

export type AgentStatus = 'idle' | 'working' | 'blocked' | 'error' | 'meeting';

/** Physical places an agent can stand in the office. */
export type OfficeStation = 'desk' | 'meeting' | 'coffee' | 'board' | 'lounge';

export type TaskStatus = 'todo' | 'doing' | 'blocked' | 'done';

export type TaskPriority = 'low' | 'medium' | 'high' | 'urgent';

export type LogLevel = 'info' | 'success' | 'warn' | 'error';

/**
 * Model spend, kept split by direction so the meter can show what a mission
 * actually cost instead of one opaque number.
 */
export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** Completed model round trips. One turn can take several. */
  turns: number;
}

export interface AgentProfile {
  id: string;
  name: string;
  role: string;
  model: string;
  color: string;
  deskIndex: number;
  station: OfficeStation;
  status: AgentStatus;
  currentTaskId: string | null;
  taskSummary: string | null;
  tokensUsed: number;
  /** Same total as `tokensUsed`, with the prompt/completion split. */
  usage: TokenUsage;
  lastEventAt: number;
}

export interface Task {
  id: string;
  title: string;
  detail: string;
  status: TaskStatus;
  priority: TaskPriority;
  assigneeId: string | null;
  createdAt: number;
  updatedAt: number;
  notes: string[];
  /** Set on a delegated subtask: the task that handed it over. */
  parentId: string | null;
  /** True on a mission the lead is coordinating across several workers. */
  mission: boolean;
  /** What this task alone spent, excluding the subtasks it delegated. */
  usage: TokenUsage;
}

export interface LogEntry {
  id: string;
  at: number;
  level: LogLevel;
  agentId: string | null;
  kind: string;
  message: string;
  /**
   * Spend attributed to this line. Set on a step entry to the model round that
   * produced it — the round is the smallest unit an endpoint bills.
   */
  tokens?: TokenUsage | null;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  agentId: string | null;
  taskId: string | null;
  content: string;
  at: number;
  streaming: boolean;
}

export interface OfficeSettings {
  /** OpenAI-compatible base URL, e.g. https://ai.sinarcloud.com/v1 */
  endpoint: string;
  /** Model id used for new agent runs. */
  model: string;
  /** Whether agents may run shell / filesystem tools inside the sandbox. */
  toolsEnabled: boolean;
  /** Whether agents may search and fetch public web pages. */
  webEnabled: boolean;
  /** Folder the agents may read and write inside. Chosen by the operator. */
  workspaceRoot: string;
  /** Demo mode runs scripted workers without calling any model API. */
  demoMode: boolean;
}

/** Settings safe to send to the browser: the secret never leaves the server. */
export interface PublicSettings extends OfficeSettings {
  configured: boolean;
  maskedKey: string | null;
  availableModels: string[];
  /** Free-tier model id the office falls back to when the chosen model fails. */
  freeModel: string;
}

/** A folder the operator can pick as the agent workspace. */
export interface WorkspaceEntry {
  name: string;
  path: string;
}

/** One level of the folder tree, used by the workspace picker. */
export interface WorkspaceListing {
  path: string;
  parent: string | null;
  entries: WorkspaceEntry[];
}

export type OfficeEventType =
  | 'session.updated'
  | 'agent.updated'
  | 'agent.removed'
  | 'task.updated'
  | 'task.removed'
  | 'log.appended'
  | 'chat.message'
  | 'chat.delta'
  | 'agent.speech'
  | 'hello';

export interface OfficeEvent {
  type: OfficeEventType;
  payload: unknown;
  at: number;
}

export interface SessionSnapshot {
  settings: PublicSettings;
  agents: AgentProfile[];
  tasks: Task[];
  logs: LogEntry[];
  chats: ChatMessage[];
  /** Office-wide token meter, so the UI has it before the first event arrives. */
  usage: UsageSummary;
}

/** One worker's lifetime spend. */
export interface AgentUsage {
  agentId: string;
  name: string;
  role: string;
  usage: TokenUsage;
}

/** A mission's spend, rolled up across the lead and every subtask. */
export interface MissionUsage {
  taskId: string;
  title: string;
  status: TaskStatus;
  mission: boolean;
  usage: TokenUsage;
}

export interface UsageSummary {
  total: TokenUsage;
  agents: AgentUsage[];
  missions: MissionUsage[];
  /** Tasks that delegated to nobody; shown as plain tasks in the meter. */
  tasks: MissionUsage[];
}

/** One calendar day of finished work. */
export interface CostDay {
  /** Local date, `YYYY-MM-DD`. */
  date: string;
  usage: TokenUsage;
  missions: MissionUsage[];
}

/** Finished missions grouped by the day they finished. */
export interface UsageHistory {
  total: TokenUsage;
  days: CostDay[];
  missions: MissionUsage[];
}
