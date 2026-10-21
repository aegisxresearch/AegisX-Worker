import type { AgentProfile, LogEntry, Task, TokenUsage } from '../../../shared/types.ts';
import { childrenOf, missionUsage } from '../../../shared/usage.ts';
import { api } from '../core/net.ts';
import type { OfficeState } from '../core/store.ts';
import { button, clear, el, formatTime, formatTokens, icon } from './dom.ts';

export interface PanelCallbacks {
  onSelectAgent: (agentId: string) => void;
  onAssignTask: (taskId: string, agentId: string) => void;
  onStartTask: (taskId: string) => void;
  onDeleteTask: (taskId: string) => void;
  onOpenCost: () => void;
}

const COLUMNS: { status: Task['status']; label: string }[] = [
  { status: 'todo', label: 'To do' },
  { status: 'doing', label: 'Doing' },
  { status: 'blocked', label: 'Blocked' },
  { status: 'done', label: 'Done' },
];

/**
 * Starter briefs for the four things people ask for first. Each one fills the
 * composer with a mission the workers can actually finish, so nobody has to
 * guess how to phrase a task.
 */
const MISSION_PRESETS: Record<
  string,
  { title: string; detail: string; role?: string; team?: boolean }
> = {
  app: {
    role: 'lead',
    team: true,
    title: 'Build an app I can run today',
    detail:
      'Ship a working app in this folder from one brief. Lead splits the work across the team.\n' +
      'Scope: one primary flow, done end to end, not a shell with placeholders.\n' +
      'Decide the stack from what is already installed here; do not invent a build chain that is not present.\n' +
      'Backend/API and the UI must agree on the data shape, and the flow must run locally before you stop.\n' +
      'Finish with the command that starts it and the files each teammate owns.',
  },
  website: {
    role: 'frontend',
    title: 'Build a responsive landing page',
    detail:
      'Create a landing page for a small business in this folder.\n' +
      'Deliver index.html, styles.css and script.js only if the page needs behaviour. No build step.\n' +
      'Sections: header with nav, hero with a real headline, three feature blocks, one proof section, footer.\n' +
      'Use semantic HTML, a deliberate colour palette, fluid type and a layout that works at 375px and 1440px.\n' +
      'Write real copy — no lorem ipsum, no placeholder text. Read the files back before finishing.',
  },
  bug: {
    role: 'backend',
    title: 'Find and fix a bug in this folder',
    detail:
      'Read the code in this folder, find one real bug, and fix it at the cause — no suppression, no TODO.\n' +
      'First reproduce it (run the project or the failing test), then patch, then re-run the same check.\n' +
      'Finish with a note that states the symptom, the root cause and the rule that prevents it.',
  },
  docs: {
    role: 'product',
    title: 'Document how this project works',
    detail:
      'Read the code in this folder and write README.md for someone who has never seen it.\n' +
      'Cover what it does, how to run it, the folder layout, the main entry points and one worked example.\n' +
      'Only document what the code actually does. No invented commands or files.',
  },
  audit: {
    role: 'qa',
    title: 'Audit this folder and report the risks',
    detail:
      'List the files, read the important ones, and write AUDIT.md with: structure, obvious bugs,\n' +
      'missing tests, hardcoded secrets or unsafe defaults, and the three changes with the highest payoff.\n' +
      'Every finding needs a file path and a reason. Do not change any file in this mission.',
  },
};

const STATUS_LABEL: Record<AgentProfile['status'], string> = {
  idle: 'Idle',
  working: 'Working',
  blocked: 'Blocked',
  error: 'Error',
  meeting: 'In meeting',
};

/** Roster, task board, activity log and the connection pill. */
export class OfficePanels {
  readonly #callbacks: PanelCallbacks;
  readonly #roster = document.getElementById('roster') as HTMLElement;
  readonly #rosterCount = document.getElementById('roster-count') as HTMLElement;
  readonly #board = document.getElementById('task-board') as HTMLElement;
  readonly #activity = document.getElementById('activity-log') as HTMLElement;
  readonly #pill = document.getElementById('connection-pill') as HTMLElement;
  readonly #assigneeSelect = document.getElementById('task-assignee') as HTMLSelectElement;
  readonly #teamToggle = document.getElementById('task-team') as HTMLInputElement | null;
  readonly #spendPill = document.getElementById('spend-pill') as HTMLElement | null;
  readonly #spendTotal = document.getElementById('spend-total') as HTMLElement | null;
  #expandedTaskId: string | null = null;
  #renderedLogIds = new Set<string>();
  /** The most expensive step currently on screen, so the log can flag it. */
  #costliestLogId: string | null = null;
  #costliestTokens = 0;

  constructor(callbacks: PanelCallbacks) {
    this.#callbacks = callbacks;

    const composer = document.getElementById('task-composer') as HTMLFormElement;
    composer.addEventListener('submit', (event) => {
      event.preventDefault();
      void this.#submitTask();
    });

    const presets = document.getElementById('mission-presets') as HTMLElement;
    presets.addEventListener('click', (event) => {
      const chip = (event.target as HTMLElement).closest('[data-mission]') as HTMLElement | null;
      const preset = chip?.dataset.mission ? MISSION_PRESETS[chip.dataset.mission] : undefined;
      if (!preset) return;
      const title = document.getElementById('task-title') as HTMLInputElement;
      const detail = document.getElementById('task-detail') as HTMLTextAreaElement;
      title.value = preset.title;
      detail.value = preset.detail;
      if (this.#teamToggle) this.#teamToggle.checked = preset.team === true;
      this.#syncTeamMode();
      this.#assignPresetAgent(preset.team ? 'lead' : preset.role);
      title.focus();
      title.select();
    });

    // A team mission is routed by the lead, so the assignee picker stops applying.
    this.#teamToggle?.addEventListener('change', () => this.#syncTeamMode());
    this.#syncTeamMode();

    const toggle = document.getElementById('task-panel-toggle') as HTMLButtonElement;
    toggle.append(icon('chevron', 15));
    toggle.addEventListener('click', () => {
      const panel = document.getElementById('task-panel');
      panel?.classList.toggle('is-collapsed');
    });

    const activityToggle = document.getElementById('activity-toggle') as HTMLButtonElement;
    activityToggle.append(icon('chevron', 15));
    activityToggle.addEventListener('click', () => {
      document.getElementById('activity-panel')?.classList.toggle('is-collapsed');
    });

    this.#spendPill?.addEventListener('click', () => this.#callbacks.onOpenCost());
  }

  /** Keeps the assignee picker in step with the team checkbox. */
  #syncTeamMode(): void {
    this.#assigneeSelect.disabled = this.#teamToggle?.checked === true;
  }

  /** Picks the teammate whose role matches the preset, when one is available. */
  #assignPresetAgent(role: string | undefined): void {
    if (!role) return;
    const option = [...this.#assigneeSelect.options].find((entry) =>
      entry.textContent?.toLowerCase().includes(role),
    );
    if (option) this.#assigneeSelect.value = option.value;
  }

  async #submitTask(): Promise<void> {
    const titleInput = document.getElementById('task-title') as HTMLInputElement;
    const detailInput = document.getElementById('task-detail') as HTMLTextAreaElement;
    const prioritySelect = document.getElementById('task-priority') as HTMLSelectElement;
    const title = titleInput.value.trim();
    if (title.length === 0) return;
    const detail = detailInput.value.trim();
    titleInput.value = '';
    detailInput.value = '';

    const teamToggle = this.#teamToggle;
    if (teamToggle?.checked === true) {
      // One prompt for the whole team: the lead splits it and reconciles.
      await api.post('/api/missions', { title, detail, priority: prioritySelect.value });
      return;
    }

    const assigneeId = this.#assigneeSelect.value;
    await api.post('/api/tasks', {
      title,
      detail,
      priority: prioritySelect.value,
      assigneeId: assigneeId.length > 0 ? assigneeId : null,
    });
  }

  render(state: OfficeState): void {
    this.#renderRoster(state);
    this.#renderBoard(state);
    this.#renderActivity(state.logs);
    this.#renderPill(state);
    this.#renderSpend(state);
    this.#renderAssigneeOptions(state);
  }

  /**
   * Office-wide token meter. Every turn is booked against the worker that ran
   * it, so the sum of the roster is the true total — no separate ledger to
   * drift out of sync with the board.
   */
  #renderSpend(state: OfficeState): void {
    const pill = this.#spendPill;
    const total = this.#spendTotal;
    if (!pill || !total) return;

    const agents = [...state.agents.values()].filter((agent) => agent.usage.totalTokens > 0);
    const sum = agents.reduce(
      (running, agent) => ({
        promptTokens: running.promptTokens + agent.usage.promptTokens,
        completionTokens: running.completionTokens + agent.usage.completionTokens,
        totalTokens: running.totalTokens + agent.usage.totalTokens,
        turns: running.turns + agent.usage.turns,
      }),
      { promptTokens: 0, completionTokens: 0, totalTokens: 0, turns: 0 },
    );

    if (sum.totalTokens === 0) {
      pill.hidden = true;
      return;
    }

    pill.hidden = false;
    total.textContent = `${formatTokens(sum.totalTokens)} tok`;
    const leaders = [...agents]
      .sort((left, right) => right.usage.totalTokens - left.usage.totalTokens)
      .slice(0, 6)
      .map((agent) => `${agent.name}: ${agent.usage.totalTokens.toLocaleString()}`);
    pill.title = [
      `${sum.totalTokens.toLocaleString()} tokens total · ${sum.turns} model turn(s)`,
      `${sum.promptTokens.toLocaleString()} in / ${sum.completionTokens.toLocaleString()} out`,
      ...leaders,
    ].join('\n');
  }

  #renderRoster(state: OfficeState): void {
    const agents = [...state.agents.values()];
    this.#rosterCount.textContent = String(agents.length);
    clear(this.#roster);

    for (const agent of agents) {
      const row = el('div', 'roster-row');
      if (agent.id === state.selectedAgentId) row.classList.add('is-selected');

      const avatar = el('div', 'avatar', agent.name.slice(0, 1).toUpperCase());
      avatar.style.background = agent.color;
      row.append(avatar);

      const who = el('div', 'who');
      const name = el('strong', undefined, agent.name);
      const detail = el('span', undefined, agent.taskSummary ?? agent.role);
      who.append(name, detail);
      row.append(who);

      const tail = el('div', 'roster-tail');
      if (agent.usage.totalTokens > 0) {
        const meter = el('span', 'token-meter');
        meter.title = `${agent.name}: ${agent.usage.totalTokens.toLocaleString()} tokens · ${agent.usage.turns} turn(s)`;
        meter.append(icon('coin', 11), document.createTextNode(formatTokens(agent.usage.totalTokens)));
        tail.append(meter);
      }

      const chip = el('span', 'status-chip', STATUS_LABEL[agent.status]);
      chip.dataset.status = agent.status;
      tail.append(chip);
      row.append(tail);

      row.addEventListener('click', () => this.#callbacks.onSelectAgent(agent.id));
      this.#roster.append(row);
    }
  }

  #renderAssigneeOptions(state: OfficeState): void {
    const select = this.#assigneeSelect;
    const current = select.value;
    clear(select);
    const unassigned = el('option', undefined, 'Unassigned');
    unassigned.value = '';
    select.append(unassigned);
    for (const agent of state.agents.values()) {
      const option = el('option', undefined, `${agent.name} · ${agent.role}`);
      option.value = agent.id;
      select.append(option);
    }
    if ([...select.options].some((option) => option.value === current)) select.value = current;
  }

  #renderBoard(state: OfficeState): void {
    clear(this.#board);
    const tasks = [...state.tasks.values()];

    for (const column of COLUMNS) {
      const columnNode = el('div', 'board-column');
      const heading = el('h3');
      heading.append(document.createTextNode(column.label));
      const counter = el('span', 'counter');
      heading.append(counter);
      columnNode.append(heading);

      const columnTasks = tasks.filter((task) => task.status === column.status);
      counter.textContent = String(columnTasks.length);

      for (const task of columnTasks) {
        columnNode.append(this.#renderTaskCard(task, state));
      }
      this.#board.append(columnNode);
    }
  }

  #renderTaskCard(task: Task, state: OfficeState): HTMLElement {
    const card = el('article', 'task-card');
    card.dataset.priority = task.priority;
    card.dataset.taskId = task.id;

    const title = el('div', 'task-title');
    if (task.mission) title.append(el('span', 'task-tag', 'team'));
    else if (task.parentId) title.append(el('span', 'task-tag is-sub', 'sub'));
    title.append(document.createTextNode(task.title));
    card.append(title);

    const meta = el('div', 'task-meta');
    const assignee = task.assigneeId ? state.agents.get(task.assigneeId) : undefined;
    if (assignee) {
      const holder = el('span', 'task-assignee');
      const dot = el('span', 'avatar-dot');
      dot.style.background = assignee.color;
      holder.append(dot, document.createTextNode(assignee.name));
      meta.append(holder);
    } else {
      meta.append(document.createTextNode('Unassigned'));
    }
    meta.append(document.createTextNode('· '));
    meta.append(document.createTextNode(task.priority));

    const spend = missionUsage(task.id, state.tasks.values());
    if (spend.totalTokens > 0) {
      meta.append(document.createTextNode('· '));
      const cost = el('span', 'task-cost', `${formatTokens(spend.totalTokens)} tok`);
      cost.title = `${spend.totalTokens.toLocaleString()} tokens · ${spend.promptTokens.toLocaleString()} in / ${spend.completionTokens.toLocaleString()} out · ${spend.turns} turn(s)${task.mission ? ' (mission total)' : ''}`;
      meta.append(cost);
    }
    card.append(meta);

    if (this.#expandedTaskId === task.id) {
      card.append(this.#renderTaskDetails(task, state));
    }

    card.addEventListener('click', (event) => {
      if ((event.target as HTMLElement).closest('button, select')) return;
      this.#expandedTaskId = this.#expandedTaskId === task.id ? null : task.id;
      this.#renderBoard(state);
    });

    return card;
  }

  #renderTaskDetails(task: Task, state: OfficeState): HTMLElement {
    const details = el('div');

    if (task.detail) {
      details.append(el('p', 'task-detail', task.detail));
    }
    if (task.notes.length > 0) {
      const notes = el('ul', 'task-notes');
      for (const note of task.notes) notes.append(el('li', undefined, note));
      details.append(notes);
    }

    const meter = this.#renderUsageBlock(task, state);
    if (meter) details.append(meter);

    const controls = el('div', 'composer-row');
    controls.style.marginTop = '8px';

    const select = el('select');
    const unassigned = el('option', undefined, 'Unassigned');
    unassigned.value = '';
    select.append(unassigned);
    for (const agent of state.agents.values()) {
      const option = el('option', undefined, agent.name);
      option.value = agent.id;
      if (agent.id === task.assigneeId) option.selected = true;
      select.append(option);
    }
    select.addEventListener('change', () => {
      if (select.value) this.#callbacks.onAssignTask(task.id, select.value);
    });
    controls.append(select);

    if (task.status !== 'done') {
      const start = el('button', 'btn btn-primary', 'Start');
      start.type = 'button';
      start.addEventListener('click', () => this.#callbacks.onStartTask(task.id));
      controls.append(start);
    }

    const remove = button('trash', 'Delete task');
    remove.addEventListener('click', () => this.#callbacks.onDeleteTask(task.id));
    controls.append(remove);

    details.append(controls);
    return details;
  }

  /**
   * Token spend for one card: the task itself plus the subtasks it delegated,
   * each attributed to the worker that did the work. Nothing is shown for a
   * task that has not run yet.
   */
  #renderUsageBlock(task: Task, state: OfficeState): HTMLElement | null {
    const rows: { label: string; usage: TokenUsage }[] = [];
    if (task.usage.totalTokens > 0) {
      rows.push({ label: 'This task', usage: task.usage });
    }
    for (const child of childrenOf(task.id, state.tasks.values())) {
      if (child.usage.totalTokens === 0) continue;
      const owner = child.assigneeId ? state.agents.get(child.assigneeId) : undefined;
      rows.push({ label: `${owner?.name ?? 'Unassigned'} — ${child.title}`, usage: child.usage });
    }
    if (rows.length === 0) return null;

    const block = el('div', 'usage-block');
    block.append(el('div', 'usage-head', 'Token meter'));

    const list = el('ul', 'usage-rows');
    for (const row of rows) {
      const line = el('li');
      line.append(el('span', 'usage-label', row.label));
      const numbers = el('span', 'usage-numbers');
      numbers.append(document.createTextNode(`${row.usage.totalTokens.toLocaleString()} tok`));
      const split = el('span', 'usage-split', ` · ${row.usage.promptTokens.toLocaleString()} in / ${row.usage.completionTokens.toLocaleString()} out`);
      numbers.append(split);
      line.append(numbers);
      list.append(line);
    }
    block.append(list);

    if (rows.length > 1) {
      const total = missionUsage(task.id, state.tasks.values());
      const footer = el('div', 'usage-total');
      footer.append(el('span', undefined, 'Mission total'));
      footer.append(el('strong', undefined, `${total.totalTokens.toLocaleString()} tok · ${total.turns} turn(s)`));
      block.append(footer);
    }

    return block;
  }

  #renderActivity(logs: LogEntry[]): void {
    const fresh = logs.filter((entry) => !this.#renderedLogIds.has(entry.id));
    if (fresh.length === 0) return;

    for (const entry of fresh) {
      this.#renderedLogIds.add(entry.id);
      const item = el('li');
      item.dataset.level = entry.level;
      item.dataset.entryId = entry.id;
      item.append(el('span', 'at', formatTime(entry.at)));
      item.append(el('span', 'msg', entry.message));

      const tokens = entry.tokens;
      if (tokens && tokens.totalTokens > 0) {
        const badge = el('span', 'entry-tokens', `${formatTokens(tokens.totalTokens)} tok`);
        badge.title = `${tokens.totalTokens.toLocaleString()} tokens this step · ${tokens.promptTokens.toLocaleString()} in / ${tokens.completionTokens.toLocaleString()} out`;
        item.append(badge);
        if (tokens.totalTokens > this.#costliestTokens) this.#markCostliest(item, entry.id, tokens.totalTokens);
      }

      this.#activity.append(item);
    }

    while (this.#activity.childElementCount > 80) {
      this.#activity.removeChild(this.#activity.firstChild as Node);
    }
    this.#activity.scrollTop = this.#activity.scrollHeight;
  }

  /**
   * Flags the most expensive step on the board. There is only ever one: the
   * flag moves when a costlier step arrives, so "which step cost most" is
   * answered without the operator scanning the whole list.
   */
  #markCostliest(item: HTMLElement, entryId: string, tokens: number): void {
    const previous = this.#costliestLogId
      ? this.#activity.querySelector(`[data-entry-id="${this.#costliestLogId}"]`)
      : null;
    previous?.classList.remove('is-costliest');
    previous?.querySelector('.cost-flag')?.remove();

    item.classList.add('is-costliest');
    item.append(el('span', 'cost-flag', 'top cost'));
    this.#costliestLogId = entryId;
    this.#costliestTokens = tokens;
  }

  #renderPill(state: OfficeState): void {
    const dot = this.#pill.querySelector('.dot') as HTMLElement;
    const text = this.#pill.querySelector('.pill-text') as HTMLElement;
    const settings = state.settings;

    if (!state.connected) {
      dot.dataset.state = 'offline';
      text.textContent = 'Disconnected';
      return;
    }
    if (!settings) {
      dot.dataset.state = 'offline';
      text.textContent = 'Disconnected';
      return;
    }
    if (settings.demoMode || !settings.configured) {
      dot.dataset.state = 'demo';
      text.textContent = 'Demo mode · no API key';
      return;
    }
    dot.dataset.state = 'live';
    text.textContent = `Live · ${settings.model}`;
  }
}
