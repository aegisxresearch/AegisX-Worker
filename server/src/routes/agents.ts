import { Router } from 'express';
import type { AgentRuntime } from '../agentRuntime.ts';
import { playbook } from '../rolePacks.ts';
import type { OfficeStore } from '../store.ts';

export function agentRoutes(store: OfficeStore, runtime: AgentRuntime): Router {
  const router = Router();

  router.get('/agents', (_request, response) => {
    response.json([...store.agents.values()]);
  });

  // The playbook is not configuration the operator edits — it is the text the
  // workers are running under, exposed so it can be read and audited like code.
  router.get('/playbook', (_request, response) => {
    // Refusals come from the board, so the tab can show which pack's bar the
    // reviewer keeps rejecting without a second request.
    response.json(playbook(store.allTasks()));
  });

  router.post('/agents', (request, response) => {
    const body = request.body as { name?: string; role?: string; color?: string; model?: string };
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (name.length === 0) {
      response.status(400).json({ ok: false, message: 'Agent name is required.' });
      return;
    }
    const palette = ['#2fb8a6', '#e9a23b', '#e06c9f', '#8fb800', '#4c9aff', '#ff7a45', '#c084fc', '#facc15'];
    const color = typeof body.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(body.color)
      ? body.color
      : (palette[store.agents.size % palette.length] ?? '#2fb8a6');
    const agent = store.createAgent({
      name,
      role: typeof body.role === 'string' ? body.role : 'Engineer',
      color,
      model: typeof body.model === 'string' ? body.model : undefined,
    });
    store.appendLog('info', 'agent.created', `${agent.name} joined the office.`);
    response.status(201).json(agent);
  });

  router.patch('/agents/:id', (request, response) => {
    const body = request.body as { name?: string; role?: string; model?: string; deskIndex?: number };
    const patch: Record<string, unknown> = {};
    if (typeof body.name === 'string' && body.name.trim()) patch.name = body.name.trim();
    if (typeof body.role === 'string' && body.role.trim()) patch.role = body.role.trim();
    if (typeof body.model === 'string' && body.model.trim()) patch.model = body.model.trim();
    if (typeof body.deskIndex === 'number') patch.deskIndex = body.deskIndex;
    const agent = store.updateAgent(request.params.id ?? '', patch);
    if (!agent) {
      response.status(404).json({ ok: false, message: 'Agent not found.' });
      return;
    }
    response.json(agent);
  });

  router.delete('/agents/:id', (request, response) => {
    const id = request.params.id ?? '';
    store.removeAgent(id);
    response.json({ ok: true });
  });

  router.post('/agents/:id/assign', async (request, response) => {
    const body = request.body as { taskId?: string };
    const agentId = request.params.id ?? '';
    const taskId = typeof body.taskId === 'string' ? body.taskId : '';
    if (!store.agents.has(agentId) || !store.tasks.has(taskId)) {
      response.status(404).json({ ok: false, message: 'Agent or task not found.' });
      return;
    }
    store.updateTask(taskId, { assigneeId: agentId });
    response.status(202).json({ ok: true });
    void runtime.runTask(agentId, taskId);
  });

  return router;
}
