import { Router } from 'express';
import type { AgentRuntime } from '../agentRuntime.ts';
import type { OfficeStore } from '../store.ts';

const PRIORITIES = new Set(['low', 'medium', 'high', 'urgent']);
const STATUSES = new Set(['todo', 'doing', 'blocked', 'done']);

export function taskRoutes(store: OfficeStore, runtime: AgentRuntime): Router {
  const router = Router();

  router.get('/tasks', (_request, response) => {
    response.json([...store.tasks.values()]);
  });

  router.post('/tasks', (request, response) => {
    const body = request.body as {
      title?: string;
      detail?: string;
      priority?: string;
      assigneeId?: string | null;
    };
    const title = typeof body.title === 'string' ? body.title.trim() : '';
    if (title.length === 0) {
      response.status(400).json({ ok: false, message: 'Task title is required.' });
      return;
    }
    const priority = typeof body.priority === 'string' && PRIORITIES.has(body.priority)
      ? (body.priority as 'low' | 'medium' | 'high' | 'urgent')
      : 'medium';
    const assigneeId =
      typeof body.assigneeId === 'string' && store.agents.has(body.assigneeId) ? body.assigneeId : null;
    const task = store.createTask({
      title,
      detail: typeof body.detail === 'string' ? body.detail : '',
      priority,
      assigneeId,
    });
    store.appendLog('info', 'task.created', `Task "${task.title}" added to the board.`);
    // Creating a task with an assignee is the same act as handing it over, so
    // the worker starts immediately instead of leaving it stuck in "doing".
    if (assigneeId) void runtime.runTask(assigneeId, task.id);
    response.status(201).json(task);
  });

  /**
   * One prompt, a whole team. The brief goes to the lead, who splits it into
   * subtasks and hands them to specialists; the runtime re-runs the lead when
   * they settle so the result is reconciled before the mission is done.
   */
  router.post('/missions', async (request, response) => {
    const body = request.body as {
      title?: string;
      detail?: string;
      priority?: string;
      leadId?: string | null;
    };
    const detail = typeof body.detail === 'string' ? body.detail.trim() : '';
    if (detail.length === 0) {
      response.status(400).json({ ok: false, message: 'A mission needs a brief.' });
      return;
    }
    const priority =
      typeof body.priority === 'string' && PRIORITIES.has(body.priority)
        ? (body.priority as 'low' | 'medium' | 'high' | 'urgent')
        : 'high';
    const requestedTitle = typeof body.title === 'string' ? body.title.trim() : '';
    const title = requestedTitle.length > 0 ? requestedTitle.slice(0, 160) : detail.split('\n')[0]?.slice(0, 90) ?? '';

    try {
      const task = await runtime.startMission({
        title: title.length > 0 ? title : 'Mission',
        detail: detail.slice(0, 6000),
        priority,
        leadId: typeof body.leadId === 'string' && body.leadId.length > 0 ? body.leadId : null,
      });
      response.status(201).json(task);
    } catch (error) {
      response.status(500).json({
        ok: false,
        message: error instanceof Error ? error.message : 'Could not start the mission.',
      });
    }
  });

  router.patch('/tasks/:id', (request, response) => {
    const body = request.body as {
      title?: string;
      detail?: string;
      status?: string;
      priority?: string;
      assigneeId?: string | null;
    };
    const patch: Record<string, unknown> = {};
    if (typeof body.title === 'string' && body.title.trim()) patch.title = body.title.trim();
    if (typeof body.detail === 'string') patch.detail = body.detail;
    if (typeof body.status === 'string' && STATUSES.has(body.status)) {
      patch.status = body.status;
    }
    if (typeof body.priority === 'string' && PRIORITIES.has(body.priority)) {
      patch.priority = body.priority;
    }
    if (body.assigneeId === null) {
      patch.assigneeId = null;
    } else if (typeof body.assigneeId === 'string' && store.agents.has(body.assigneeId)) {
      patch.assigneeId = body.assigneeId;
    }
    const task = store.updateTask(request.params.id ?? '', patch);
    if (!task) {
      response.status(404).json({ ok: false, message: 'Task not found.' });
      return;
    }
    response.json(task);
  });

  router.delete('/tasks/:id', (request, response) => {
    store.removeTask(request.params.id ?? '');
    response.json({ ok: true });
  });

  router.post('/tasks/:id/assign', async (request, response) => {
    const body = request.body as { agentId?: string };
    const taskId = request.params.id ?? '';
    const agentId = typeof body.agentId === 'string' ? body.agentId : '';
    const task = store.tasks.get(taskId);
    if (!task || !store.agents.has(agentId)) {
      response.status(404).json({ ok: false, message: 'Task or agent not found.' });
      return;
    }
    store.updateTask(taskId, { assigneeId: agentId, status: 'doing' });
    response.status(202).json({ ok: true });
    void runtime.runTask(agentId, taskId);
  });

  return router;
}
