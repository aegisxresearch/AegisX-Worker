import type {
  AgentProfile,
  ChatMessage,
  LogEntry,
  PublicSettings,
  Task,
} from '../../../shared/types.ts';

export interface OfficeState {
  connected: boolean;
  settings: PublicSettings | null;
  agents: Map<string, AgentProfile>;
  tasks: Map<string, Task>;
  logs: LogEntry[];
  chats: ChatMessage[];
  selectedAgentId: string | null;
  followAgentId: string | null;
}

type Listener = (state: OfficeState) => void;

/** Tiny observable store — the scene and the panels both subscribe to it. */
export class OfficeStore {
  readonly state: OfficeState = {
    connected: false,
    settings: null,
    agents: new Map(),
    tasks: new Map(),
    logs: [],
    chats: [],
    selectedAgentId: null,
    followAgentId: null,
  };

  readonly #listeners = new Set<Listener>();

  subscribe(listener: Listener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  emit(): void {
    for (const listener of this.#listeners) listener(this.state);
  }

  replaceAgents(agents: AgentProfile[]): void {
    this.state.agents = new Map(agents.map((agent) => [agent.id, agent]));
    this.emit();
  }

  upsertAgent(agent: AgentProfile): void {
    this.state.agents.set(agent.id, agent);
    this.emit();
  }

  removeAgent(id: string): void {
    this.state.agents.delete(id);
    if (this.state.selectedAgentId === id) this.state.selectedAgentId = null;
    if (this.state.followAgentId === id) this.state.followAgentId = null;
    this.emit();
  }

  replaceTasks(tasks: Task[]): void {
    this.state.tasks = new Map(tasks.map((task) => [task.id, task]));
    this.emit();
  }

  upsertTask(task: Task): void {
    this.state.tasks.set(task.id, task);
    this.emit();
  }

  removeTask(id: string): void {
    this.state.tasks.delete(id);
    this.emit();
  }

  replaceLogs(logs: LogEntry[]): void {
    this.state.logs = [...logs];
    this.emit();
  }

  appendLog(entry: LogEntry): void {
    this.state.logs = [...this.state.logs, entry].slice(-200);
    this.emit();
  }

  replaceChats(chats: ChatMessage[]): void {
    this.state.chats = [...chats];
    this.emit();
  }

  upsertChat(chat: ChatMessage): void {
    const index = this.state.chats.findIndex((entry) => entry.id === chat.id);
    if (index === -1) {
      this.state.chats = [...this.state.chats, chat].slice(-200);
    } else {
      const next = [...this.state.chats];
      next[index] = chat;
      this.state.chats = next;
    }
    this.emit();
  }

  applyDelta(id: string, delta: string): void {
    const chat = this.state.chats.find((entry) => entry.id === id);
    if (!chat) return;
    chat.content += delta;
    this.emit();
  }

  setSettings(settings: PublicSettings): void {
    this.state.settings = settings;
    this.emit();
  }

  selectAgent(id: string | null): void {
    this.state.selectedAgentId = id;
    this.emit();
  }

  setFollowAgent(id: string | null): void {
    this.state.followAgentId = id;
    this.emit();
  }
}
