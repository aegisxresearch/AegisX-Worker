import './styles.css';
import type {
  AgentProfile,
  ChatMessage,
  LogEntry,
  OfficeEvent,
  PublicSettings,
  SessionSnapshot,
  Task,
} from '../../shared/types.ts';
import { api, subscribeEvents } from './core/net.ts';
import { OfficeStore } from './core/store.ts';
import { OfficeScene } from './scene/officeScene.ts';
import { ChatPanel } from './ui/chat.ts';
import { CostPanel } from './ui/costPanel.ts';
import { SettingsPanel } from './ui/settings.ts';
import { OfficePanels } from './ui/panels.ts';

const store = new OfficeStore();

declare global {
  interface Window {
    /** Debug handles: let the browser verification harness read live state. */
    officeScene?: OfficeScene;
    officeStore?: OfficeStore;
  }
}

const canvas = document.getElementById('office-canvas') as HTMLCanvasElement;
const labelHost = document.getElementById('labels') as HTMLElement;

const scene = new OfficeScene({
  canvas,
  labelHost,
  onSelectAgent: (agentId) => {
    store.selectAgent(agentId);
  },
});

const settingsPanel = new SettingsPanel();
const costPanel = new CostPanel();

const panels = new OfficePanels({
  onSelectAgent: (agentId) => store.selectAgent(agentId),
  onAssignTask: (taskId, agentId) => {
    void api.post(`/api/tasks/${taskId}/assign`, { agentId });
  },
  onStartTask: (taskId) => {
    const agentId = store.state.selectedAgentId ?? [...store.state.agents.keys()][0];
    if (!agentId) return;
    void api.post(`/api/tasks/${taskId}/assign`, { agentId });
  },
  onDeleteTask: (taskId) => {
    void api.delete(`/api/tasks/${taskId}`);
  },
  onOpenCost: () => costPanel.open(),
});

const chat = new ChatPanel({
  onSend: (agentId, content) => {
    void api.post('/api/chat', { agentId, content });
  },
  onToggleFollow: (agentId) => {
    store.setFollowAgent(agentId);
  },
});

store.subscribe((state) => {
  panels.render(state);
  chat.render(state);
  settingsPanel.render(state.settings);
  scene.setSelected(state.selectedAgentId);
  scene.setFollow(state.followAgentId);
});

function hydrate(snapshot: SessionSnapshot): void {
  store.state.connected = true;
  store.setSettings(snapshot.settings);
  store.replaceAgents(snapshot.agents);
  store.replaceTasks(snapshot.tasks);
  store.replaceLogs(snapshot.logs);
  store.replaceChats(snapshot.chats);
  scene.syncAgents(snapshot.agents);
}

function handleEvent(event: OfficeEvent): void {
  switch (event.type) {
    case 'hello': {
      hydrate(event.payload as SessionSnapshot);
      return;
    }
    case 'session.updated': {
      store.setSettings(event.payload as PublicSettings);
      return;
    }
    case 'agent.updated': {
      const agent = event.payload as AgentProfile;
      store.upsertAgent(agent);
      scene.syncAgents([...store.state.agents.values()]);
      return;
    }
    case 'agent.removed': {
      const { id } = event.payload as { id: string };
      store.removeAgent(id);
      scene.syncAgents([...store.state.agents.values()]);
      return;
    }
    case 'task.updated': {
      store.upsertTask(event.payload as Task);
      return;
    }
    case 'task.removed': {
      const { id } = event.payload as { id: string };
      store.removeTask(id);
      return;
    }
    case 'log.appended': {
      store.appendLog(event.payload as LogEntry);
      return;
    }
    case 'chat.message': {
      store.upsertChat(event.payload as ChatMessage);
      return;
    }
    case 'chat.delta': {
      const { id, delta } = event.payload as { id: string; delta: string };
      store.applyDelta(id, delta);
      return;
    }
    case 'agent.speech': {
      const { agentId, text } = event.payload as { agentId: string; text: string };
      scene.say(agentId, text);
      return;
    }
    default:
      return;
  }
}

/**
 * Loads the first snapshot, retrying briefly. A single failed request used to
 * leave the office on "Connecting…" forever, even after the server recovered.
 */
async function fetchSnapshot(attempt = 0): Promise<boolean> {
  try {
    hydrate(await api.get<SessionSnapshot>('/api/session'));
    return true;
  } catch {
    if (attempt >= 5) return false;
    await new Promise((resolve) => setTimeout(resolve, 300 * (attempt + 1)));
    return fetchSnapshot(attempt + 1);
  }
}

async function bootstrap(): Promise<void> {
  // Subscribe first: the `hello` frame carries a full snapshot, so the office
  // recovers on its own even if the first fetch fails outright.
  subscribeEvents(handleEvent);
  if (!(await fetchSnapshot())) {
    store.state.connected = false;
    store.emit();
  }
}

window.addEventListener('keydown', (event) => {
  if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
  if (event.key === 'Escape') {
    store.selectAgent(null);
    store.setFollowAgent(null);
    return;
  }
  if (event.key.toLowerCase() === 'f' && store.state.selectedAgentId) {
    const isFollowing = store.state.followAgentId === store.state.selectedAgentId;
    store.setFollowAgent(isFollowing ? null : store.state.selectedAgentId);
  }
  if (event.key.toLowerCase() === 'c') scene.resetCamera();
});

void bootstrap();
scene.start();
window.officeScene = scene;
window.officeStore = store;
