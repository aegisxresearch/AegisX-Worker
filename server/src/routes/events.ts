import { Router } from 'express';
import type { EventBus } from '../events.ts';
import type { OfficeStore } from '../store.ts';

export function eventRoutes(store: OfficeStore, bus: EventBus): Router {
  const router = Router();

  router.get('/events', (request, response) => {
    response.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    response.write(': connected\n\n');

    const send = (event: { type: string; payload: unknown; at: number }): void => {
      response.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    send({ type: 'hello', payload: store.snapshot(), at: Date.now() });

    const unsubscribe = bus.subscribe(send);
    const heartbeat = setInterval(() => {
      response.write(': ping\n\n');
    }, 20_000);

    request.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });

  return router;
}
