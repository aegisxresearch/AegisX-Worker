import type { OfficeEvent, OfficeEventType } from '../../shared/types.ts';

export type EventListener = (event: OfficeEvent) => void;

/** In-process broadcast bus. Every mutation in the office is published here. */
export class EventBus {
  readonly #listeners = new Set<EventListener>();

  subscribe(listener: EventListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  publish(type: OfficeEventType, payload: unknown): void {
    const event: OfficeEvent = { type, payload, at: Date.now() };
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch (error) {
        console.error('[bus] listener failed', error);
      }
    }
  }
}
