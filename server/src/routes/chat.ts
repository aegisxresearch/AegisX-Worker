import { Router } from 'express';
import type { AgentRuntime } from '../agentRuntime.ts';
import type { OfficeStore } from '../store.ts';

export function chatRoutes(store: OfficeStore, runtime: AgentRuntime): Router {
  const router = Router();

  router.get('/chat', (request, response) => {
    const agentId = typeof request.query.agentId === 'string' ? request.query.agentId : null;
    const messages = agentId
      ? store.chats.filter((entry) => entry.agentId === agentId)
      : store.chats;
    response.json(messages.slice(-100));
  });

  router.post('/chat', (request, response) => {
    const body = request.body as { agentId?: string; content?: string };
    const agentId = typeof body.agentId === 'string' ? body.agentId : '';
    const content = typeof body.content === 'string' ? body.content : '';
    if (!store.agents.has(agentId)) {
      response.status(404).json({ ok: false, message: 'Agent not found.' });
      return;
    }
    if (content.trim().length === 0) {
      response.status(400).json({ ok: false, message: 'Message is empty.' });
      return;
    }
    response.status(202).json({ ok: true });
    void runtime.handleUserMessage(agentId, content);
  });

  return router;
}
