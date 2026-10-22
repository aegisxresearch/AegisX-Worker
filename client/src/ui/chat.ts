import { t } from '../../../shared/i18n.ts';
import type { ChatMessage } from '../../../shared/types.ts';
import type { OfficeState } from '../core/store.ts';
import { button, clear, el, icon } from './dom.ts';

export interface ChatCallbacks {
  onSend: (agentId: string, content: string) => void;
  onToggleFollow: (agentId: string | null) => void;
}

export class ChatPanel {
  readonly #callbacks: ChatCallbacks;
  readonly #log = document.getElementById('chat-log') as HTMLElement;
  readonly #title = document.getElementById('chat-title') as HTMLElement;
  readonly #form = document.getElementById('chat-form') as HTMLFormElement;
  readonly #input = document.getElementById('chat-input') as HTMLTextAreaElement;
  readonly #followButton = document.getElementById('chat-follow') as HTMLButtonElement;
  #nodes = new Map<string, HTMLElement>();
  #currentAgentId: string | null = null;

  constructor(callbacks: ChatCallbacks) {
    this.#callbacks = callbacks;

    this.#followButton.append(icon('target', 15));
    this.#followButton.addEventListener('click', () => {
      if (!this.#currentAgentId) return;
      const isFollowing = this.#followButton.classList.contains('is-active');
      this.#callbacks.onToggleFollow(isFollowing ? null : this.#currentAgentId);
    });

    this.#form.addEventListener('submit', (event) => {
      event.preventDefault();
      if (!this.#currentAgentId) return;
      const content = this.#input.value.trim();
      if (content.length === 0) return;
      this.#input.value = '';
      this.#callbacks.onSend(this.#currentAgentId, content);
    });

    this.#input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        this.#form.requestSubmit();
      }
    });
  }

  /**
   * Forgets the rendered bubbles so the next render rebuilds them in the new
   * language. Author labels are written once, when a bubble is created.
   */
  relocalize(): void {
    this.#nodes.clear();
    this.#currentAgentId = null;
    clear(this.#log);
  }

  render(state: OfficeState): void {
    const agentId = state.selectedAgentId;
    const agent = agentId ? state.agents.get(agentId) : undefined;

    if (agentId !== this.#currentAgentId) {
      this.#currentAgentId = agentId;
      this.#nodes.clear();
      clear(this.#log);
    }

    this.#title.textContent = agent ? `${agent.name} · ${agent.role}` : t('chat.select');
    this.#input.disabled = !agent;
    const sendButton = this.#form.querySelector('button') as HTMLButtonElement | null;
    if (sendButton) sendButton.disabled = !agent;

    const isFollowing = state.followAgentId === agentId && agentId !== null;
    this.#followButton.disabled = !agent;
    this.#followButton.classList.toggle('is-active', isFollowing);

    if (!agent) {
      if (this.#log.childElementCount === 0) {
        const note = el('p', 'empty-note', t('chat.empty'));
        this.#log.append(note);
      }
      return;
    }
    if (this.#log.querySelector('.empty-note')) clear(this.#log);

    const messages = state.chats.filter((entry) => entry.agentId === agent.id);
    for (const message of messages) this.#renderMessage(message);
  }

  #renderMessage(message: ChatMessage): void {
    const existing = this.#nodes.get(message.id);
    if (existing) {
      const body = existing.querySelector('.bubble-body');
      if (body && body.textContent !== message.content) body.textContent = message.content;
      existing.classList.toggle('streaming', message.streaming);
      return;
    }

    const bubble = el('div', `bubble ${message.role === 'user' ? 'user' : 'agent'}`);
    if (message.role === 'assistant') {
      const author = el('span', 'bubble-author');
      author.textContent = t('chat.author');
      bubble.append(author);
    }
    const body = el('span', 'bubble-body', message.content);
    bubble.append(body);
    bubble.classList.toggle('streaming', message.streaming);
    this.#log.append(bubble);
    this.#nodes.set(message.id, bubble);
    this.#log.scrollTop = this.#log.scrollHeight;
  }
}
