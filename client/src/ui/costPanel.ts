import { t } from '../../../shared/i18n.ts';
import type { CostDay, UsageHistory } from '../../../shared/types.ts';
import { api } from '../core/net.ts';
import type { BottomTabs } from './bottomTabs.ts';
import { clear, el, formatTokens } from './dom.ts';

export type PanelTab = 'activity' | 'cost' | 'playbook';

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
  readonly #tabs: BottomTabs;
  readonly #view = document.getElementById('cost-view') as HTMLElement;
  readonly #grandTotal = document.getElementById('cost-grand-total') as HTMLElement;
  #requestId = 0;

  constructor(tabs: BottomTabs) {
    this.#tabs = tabs;
    tabs.onChange((tab) => {
      // The counter belongs to the Costs tab only; leaving it up while the
      // activity log is open reads as the log's total.
      this.#grandTotal.hidden = tab !== 'cost';
      if (tab === 'cost') void this.#load();
    });
  }

  /** Opens the Costs tab (what the topbar pill does). */
  open(): void {
    this.#tabs.show('cost');
  }

  /** Reloads the open tab after a language switch, if it is showing. */
  relocalize(): void {
    if (this.#tabs.active === 'cost') void this.#load();
  }

  async #load(): Promise<void> {
    // A slow first request must not overwrite a newer one.
    this.#requestId += 1;
    const requestId = this.#requestId;
    this.#showNote(t('cost.reading'));

    try {
      const history = await api.get<UsageHistory>('/api/usage/history');
      if (requestId !== this.#requestId) return;
      this.#render(history);
    } catch (error) {
      if (requestId !== this.#requestId) return;
      this.#showNote(
        error instanceof Error
          ? t('cost.error', { message: error.message })
          : t('cost.errorShort'),
      );
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
    this.#grandTotal.title = t('cost.across', {
      tokens: history.total.totalTokens.toLocaleString(),
      items: history.missions.length,
    });

    if (history.days.length === 0) {
      this.#view.append(el('p', 'empty-note', t('cost.empty')));
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
        t('cost.day', {
          tokens: formatTokens(day.usage.totalTokens),
          items: day.missions.length,
          turns: day.usage.turns,
        }),
      ),
    );
    section.append(head);

    const list = el('ul', 'cost-list');
    for (const mission of day.missions) {
      const row = el('li', 'cost-row');
      const title = el('span', 'cost-title', mission.title);
      title.title = mission.title;
      row.append(title);

      row.append(el('span', 'cost-meta', mission.mission ? t('cost.kindTeam') : t('cost.kindTask')));

      const value = el('span', 'cost-value', `${formatTokens(mission.usage.totalTokens)} tok`);
      value.title = t('cost.split', {
        tokens: mission.usage.totalTokens.toLocaleString(),
        input: mission.usage.promptTokens.toLocaleString(),
        output: mission.usage.completionTokens.toLocaleString(),
      });
      row.append(value);

      list.append(row);
    }
    section.append(list);
    return section;
  }
}
