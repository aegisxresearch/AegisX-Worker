import { t } from '../../../shared/i18n.ts';
import type { PlaybookPack, RefusalSummary, TeamPlaybook } from '../../../shared/types.ts';
import { api } from '../core/net.ts';
import type { BottomTabs } from './bottomTabs.ts';
import { clear, el } from './dom.ts';

/**
 * The Playbook tab: the exact instruction each worker runs under.
 *
 * Most of what a multi-agent office does wrong is invisible from the board — a
 * worker refused work because it never knew the bar, or a lead whose brief
 * named no file. Showing the doctrine and the role packs turns the prompt into
 * something the operator can read and argue with, instead of a string buried in
 * the server. It is the same text the model receives, not a summary of it.
 *
 * The doctrine and the packs change only when the server restarts, but the
 * refusal counts change while work runs — a pack that keeps being refused is
 * the evidence for rewriting one of its lines. So the tab re-reads on open and
 * keeps the last good copy on screen while it does.
 */
export class BriefingPanel {
  readonly #tabs: BottomTabs;
  readonly #view = document.getElementById('playbook-view') as HTMLElement;
  #playbook: TeamPlaybook | null = null;
  #requestId = 0;

  constructor(tabs: BottomTabs) {
    this.#tabs = tabs;
    tabs.onChange((tab) => {
      if (tab === 'playbook') void this.#load();
    });
  }

  /** Re-renders in the new language, from the copy already held. */
  relocalize(): void {
    if (this.#tabs.active !== 'playbook') return;
    if (this.#playbook) this.#render(this.#playbook);
    else void this.#load();
  }

  async #load(): Promise<void> {
    // A slow first answer must not overwrite the tab after a language switch
    // already asked for a fresh one.
    this.#requestId += 1;
    const requestId = this.#requestId;
    if (!this.#playbook) this.#showNote(t('briefing.reading'));

    try {
      const playbook = await api.get<TeamPlaybook>('/api/playbook');
      if (requestId !== this.#requestId) return;
      this.#playbook = playbook;
      this.#render(playbook);
    } catch (error) {
      if (requestId !== this.#requestId) return;
      this.#showNote(t('briefing.error', { message: error instanceof Error ? error.message : String(error) }));
    }
  }

  #showNote(message: string): void {
    clear(this.#view);
    this.#view.append(el('p', 'empty-note', message));
  }

  #render(playbook: TeamPlaybook): void {
    clear(this.#view);
    this.#view.append(el('p', 'briefing-note', t('briefing.note')));

    const doctrine = el('section', 'briefing-block');
    doctrine.append(el('h3', 'briefing-heading', t('briefing.doctrine')));
    const rules = el('ol', 'briefing-rules');
    for (const rule of playbook.doctrine) {
      const item = el('li', 'briefing-rule');
      item.append(el('strong', 'briefing-rule-title', rule.title));
      item.append(el('p', 'briefing-rule-text', rule.text));
      rules.append(item);
    }
    doctrine.append(rules);
    this.#view.append(doctrine);

    // A page left open across a server upgrade talks to a payload that may
    // predate the refusal summary; an empty one is the honest fallback.
    const refusals = playbook.refusals ?? { total: 0, packs: [] };
    const grid = el('div', 'briefing-grid');
    for (const pack of playbook.packs) grid.append(this.#renderPack(pack, refusals));
    this.#view.append(grid);
  }

  #renderPack(pack: PlaybookPack, refusals: RefusalSummary): HTMLElement {
    const card = el('article', 'briefing-card');
    card.append(el('h4', 'briefing-pack-title', pack.label));

    const groups: [string, string[]][] = [
      [t('briefing.craft'), pack.craft],
      [t('briefing.done'), pack.done],
      [t('briefing.review'), pack.review],
    ];
    for (const [label, lines] of groups) {
      if (lines.length === 0) continue;
      card.append(el('span', 'briefing-label', label));
      const list = el('ul', 'briefing-list');
      for (const line of lines) list.append(el('li', undefined, line));
      card.append(list);
    }

    // What the reviewer actually refused under this pack. Rule text is shown as
    // the model reads it, like the rest of this tab; the labels around it are
    // the operator's language.
    const refused = refusals.packs.find((entry) => entry.pack === pack.id);
    if (refused) {
      card.append(el('span', 'briefing-label', t('briefing.refused')));
      card.append(el('p', 'briefing-refusal', t('briefing.refusedLine', { count: String(refused.count) })));
      const top = refused.rules[0];
      const rule = top ? pack.review[top.rule] : undefined;
      if (top && rule) {
        const line = el(
          'p',
          'briefing-refusal is-rule',
          t('briefing.refusedRule', { rule: String(top.rule + 1), count: String(top.count) }),
        );
        line.append(document.createTextNode(` ${rule}`));
        card.append(line);
      }
      if (refused.unmatched > 0) {
        card.append(
          el(
            'p',
            'briefing-refusal',
            t('briefing.refusedUnmatched', { count: String(refused.unmatched) }),
          ),
        );
      }
    }
    return card;
  }
}
