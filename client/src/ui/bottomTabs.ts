import type { PanelTab } from './costPanel.ts';

interface TabEntry {
  button: HTMLButtonElement;
  view: HTMLElement;
}

/**
 * The bottom panel's tab strip.
 *
 * Each tab needs the same three things: which button is active, which view is
 * visible, and a way to tell the panel that owns the view it just became. When
 * the cost tab was the only one, the cost panel owned all three. A third tab
 * would have meant a second class guessing at the same `data-tab` attribute, so
 * the switching moved here and the panels subscribe instead.
 */
export class BottomTabs {
  readonly #panel: HTMLElement;
  readonly #tabs = new Map<PanelTab, TabEntry>();
  readonly #listeners = new Set<(tab: PanelTab) => void>();
  #active: PanelTab = 'activity';

  constructor(panelId = 'activity-panel') {
    const panel = document.getElementById(panelId);
    if (!panel) throw new Error(`bottom tabs: #${panelId} is missing from the page`);
    this.#panel = panel;
  }

  register(tab: PanelTab, buttonId: string, viewId: string): void {
    const button = document.getElementById(buttonId) as HTMLButtonElement | null;
    const view = document.getElementById(viewId) as HTMLElement | null;
    if (!button || !view) {
      throw new Error(`bottom tabs: ${tab} needs #${buttonId} and #${viewId}`);
    }
    this.#tabs.set(tab, { button, view });
    button.addEventListener('click', () => this.show(tab));
  }

  get active(): PanelTab {
    return this.#active;
  }

  /** Fires on every switch, including the one that re-opens the open tab. */
  onChange(listener: (tab: PanelTab) => void): void {
    this.#listeners.add(listener);
  }

  show(tab: PanelTab): void {
    if (!this.#tabs.has(tab)) return;
    this.#active = tab;
    this.#panel.dataset.tab = tab;
    // Opening a tab is also the signal that the operator wants the panel back.
    this.#panel.classList.remove('is-collapsed');

    for (const [id, entry] of this.#tabs) {
      const active = id === tab;
      entry.view.hidden = !active;
      entry.button.classList.toggle('is-active', active);
      entry.button.setAttribute('aria-selected', String(active));
    }

    for (const listener of this.#listeners) listener(tab);
  }
}
