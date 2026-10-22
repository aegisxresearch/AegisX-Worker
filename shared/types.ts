/**
 * Domain types shared by the office server and the browser client.
 * Kept dependency-free so both bundles can import it without extra runtime cost.
 */
import type { Locale } from './i18n.ts';

export type AgentStatus = 'idle' | 'working' | 'blocked' | 'error' | 'meeting';

/** Physical places an agent can stand in the office. */
export type OfficeStation = 'desk' | 'meeting' | 'coffee' | 'board' | 'lounge';

export type TaskStatus = 'todo' | 'doing' | 'blocked' | 'done';

export type TaskPriority = 'low' | 'medium' | 'high' | 'urgent';

/**
 * Why a task stopped. One status (`blocked`) used to cover every one of these,
 * so "the work fails a lot" could not be turned into a decision. A stable code
 * per cause makes the failure rate a ranked list instead of an impression.
 */
export type FailureReason =
  | 'no_progress'
  | 'tool_loop'
  | 'budget'
  | 'model_error'
  | 'restart'
  | 'synthesis_stalled';

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

/**
 * Who decided the playbook a task ran under. A choice the operator made and a
 * guess from the brief are not the same fact, so the board can say which one.
 */
export type PackSource = 'operator' | 'role' | 'brief' | 'default';

/** One refusal the independent reviewer made, kept with the pack it judged. */
export interface ReviewRefusal {
  at: number;
  /** The pack the refused change ran under. */
  pack: string;
  reasons: string[];
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
  /** Set when the task is blocked: the cause, as a stable code. */
  failureReason: FailureReason | null;
  /**
   * Tasks that must be done before this one starts. A lead uses it to say
   * "the API, then the client" instead of waiting between turns.
   */
  dependsOn?: string[];
  /**
   * The playbook the worker runs under, when it differs from the job title.
   * Set by the lead on a delegated task; null means "work it out from the
   * role, then the brief".
   */
  pack?: string | null;
  /**
   * The pack the last turn actually ran under, resolved once when the task
   * started. The prompt, the reviewer and the board all read this one field, so
   * they cannot disagree about the bar the work was judged against.
   */
  activePack?: string | null;
  /** Who chose `activePack` — the operator, the role, the brief, or nobody. */
  packSource?: PackSource | null;
  /**
   * Reviewer refusals kept with their reasons, so a pack whose bar is misspoken
   * can be found from the board instead of from an argument about taste.
   */
  reviewRefusals?: ReviewRefusal[];
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
  /**
   * The language the team writes in: task notes, summaries, replies. Set from
   * the browser, because it is the operator's language, and injected into the
   * agent prompt so a note stays readable to whoever opens the board next.
   */
  locale: Locale;
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

/** How many blocked tasks share one cause. */
export interface FailureCount {
  reason: FailureReason;
  count: number;
}

/** One blocked task, for the drill-down under the counts. */
export interface FailureItem {
  taskId: string;
  title: string;
  reason: FailureReason;
  at: number;
}

/**
 * The failure rate, grouped by cause. Ordered by count, so the top row is the
 * thing worth fixing next — this is the number the office was missing.
 */
export interface FailureSummary {
  total: number;
  reasons: FailureCount[];
  tasks: FailureItem[];
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

/** One rule of team practice, as the workers receive it. */
export interface PlaybookRule {
  id: string;
  title: string;
  text: string;
}

/** A role's playbook: the bar, the evidence of done, and the review focus. */
export interface PlaybookPack {
  id: string;
  label: string;
  craft: string[];
  done: string[];
  review: string[];
}

/** One review rule of a pack, and how often the reviewer cited it. */
export interface PackRefusalRule {
  /** Zero-based index into that pack's `review` list. */
  rule: number;
  count: number;
}

/** How often one pack's work was refused, and which of its rules was cited. */
export interface PackRefusal {
  pack: string;
  count: number;
  rules: PackRefusalRule[];
  /** Refusals whose reasons matched no rule in the pack. */
  unmatched: number;
}

/**
 * Review refusals ranked by pack. A pack that keeps being refused usually has a
 * rule that is vague or wrong, and this is the evidence for rewriting that line
 * instead of arguing about taste.
 */
export interface RefusalSummary {
  total: number;
  packs: PackRefusal[];
}

/**
 * What `GET /api/playbook` returns: the same text the model is given, so the
 * operator can read the instruction instead of guessing at it.
 */
export interface TeamPlaybook {
  doctrine: PlaybookRule[];
  packs: PlaybookPack[];
  /** Refusals the packs have earned so far, ranked. */
  refusals: RefusalSummary;
}
