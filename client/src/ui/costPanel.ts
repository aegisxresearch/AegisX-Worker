import type { CostDay, UsageHistory } from '../../../shared/types.ts';
import { api } from '../core/net.ts';
import { clear, el, formatTokens } from './dom.ts';

type PanelTab = 'activity' | 'cost';

/** Day header: `Tue, 21 Oct`. Falls back to the raw key if it cannot parse. */
function dayLabel(date: string): string {
  const parsed = new Date(`${date}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) return date;
  return parsed.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
}

/**
 * The Costs tab of the bottom panel: finished missions grouped by the day they
 * finished, each with its rolled-up total, plus the day's total.
 *
 * Reads the server rather than the live board, so the numbers match what
 * `GET /api/usage/history` gives a script, and reloads each time the tab is
 * opened so a mission that finished a second ago is already listed.
 */
export class CostPanel {
  readonly #panel = document.getElementById('activity-panel') as HTMLElement;
  readonly #activityTab = document.getElementById('tab-activity') as HTMLButtonElement;
  readonly #costTab = document.getElementById('tab-cost') as HTMLButtonElement;
  readonly #activityLog = document.getElementById('activity-log') as HTMLElement;
  readonly #view = document.getElementById('cost-view') as HTMLElement;
  readonly #grandTotal = document.getElementById('cost-grand-total') as HTMLElement;
  #requestId = 0;

  constructor() {
    this.#activityTab.addEventListener('click', () => this.show('activity'));
    this.#costTab.addEventListener('click', () => this.show('cost'));
  }

  /** Opens the Costs tab (what the topbar pill does). */
  open(): void {
    this.show('cost');
  }

  show(tab: PanelTab): void {
    const isCost = tab === 'cost';
    this.#panel.dataset.tab = tab;
    this.#panel.classList.remove('is-collapsed');
    this.#activityLog.hidden = isCost;
    this.#view.hidden = !isCost;
    this.#grandTotal.hidden = !isCost;

    for (const [element, active] of [
      [this.#activityTab, !isCost],
      [this.#costTab, isCost],
    ] as const) {
      element.classList.toggle('is-active', active);
      element.setAttribute('aria-selected', String(active));
    }

    if (isCost) void this.#load();
  }

  async #load(): Promise<void> {
    // A slow first request must not overwrite a newer one.
    this.#requestId += 1;
    const requestId = this.#requestId;
    this.#showNote('Reading the board…');

    try {
      const history = await api.get<UsageHistory>('/api/usage/history');
      if (requestId !== this.#requestId) return;
      this.#render(history);
    } catch (error) {
      if (requestId !== this.#requestId) return;
      this.#showNote(error instanceof Error ? `Could not read the history: ${error.message}` : 'Could not read the history.');
    }
  }

  #showNote(message: string): void {
    this.#grandTotal.textContent = '';
    clear(this.#view);
    this.#view.append(el('p', 'empty-note', message));
  }

  #render(history: UsageHistory): void {
    clear(this.#view);
    this.#grandTotal.textContent = history.total.totalTokens > 0 ? `${formatTokens(history.total.totalTokens)} tok` : '';
    this.#grandTotal.title = `${history.total.totalTokens.toLocaleString()} tokens across ${history.missions.length} finished item(s)`;

    if (history.days.length === 0) {
      this.#view.append(
        el('p', 'empty-note', 'Nothing has finished yet. A mission appears here once it is done.'),
      );
      return;
    }

    for (const day of history.days) {
      this.#view.append(this.#renderDay(day));
    }
  }

  #renderDay(day: CostDay): HTMLElement {
    const section = el('section', 'cost-day');
    const head = el('header', 'cost-day-head');
    head.append(el('strong', undefined, dayLabel(day.date)));
    head.append(
      el(
        'span',
        'cost-day-total',
        `${formatTokens(day.usage.totalTokens)} tok · ${day.missions.length} item(s) · ${day.usage.turns} turn(s)`,
      ),
    );
    section.append(head);

    const list = el('ul', 'cost-list');
    for (const mission of day.missions) {
      const row = el('li', 'cost-row');
      const title = el('span', 'cost-title', mission.title);
      title.title = mission.title;
      row.append(title);

      row.append(el('span', 'cost-meta', mission.mission ? 'team' : 'task'));

      const value = el('span', 'cost-value', `${formatTokens(mission.usage.totalTokens)} tok`);
      value.title = `${mission.usage.totalTokens.toLocaleString()} tokens · ${mission.usage.promptTokens.toLocaleString()} in / ${mission.usage.completionTokens.toLocaleString()} out`;
      row.append(value);

      list.append(row);
    }
    section.append(list);
    return section;
  }
}
