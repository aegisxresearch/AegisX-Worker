import type { OfficeEvent } from '../../../shared/types.ts';

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  const payload: unknown = text ? JSON.parse(text) : {};
  if (!response.ok) {
    const message =
      typeof payload === 'object' && payload !== null
        ? String((payload as { message?: unknown }).message ?? response.statusText)
        : response.statusText;
    throw new Error(message);
  }
  return payload as T;
}

export const api = {
  get: <T>(path: string): Promise<T> => request<T>('GET', path),
  post: <T>(path: string, body?: unknown): Promise<T> => request<T>('POST', path, body ?? {}),
  patch: <T>(path: string, body?: unknown): Promise<T> => request<T>('PATCH', path, body ?? {}),
  delete: <T>(path: string): Promise<T> => request<T>('DELETE', path),
};

/** Subscribes to the office event stream. Returns a disposer. */
export function subscribeEvents(handler: (event: OfficeEvent) => void): () => void {
  const source = new EventSource('/api/events');
  source.onmessage = (message) => {
    try {
      handler(JSON.parse(message.data) as OfficeEvent);
    } catch {
      /* ignore malformed frames */
    }
  };
  source.onerror = () => {
    /* the browser retries automatically */
  };
  return () => source.close();
}
