import { Router } from 'express';
import type { AgentRuntime } from '../agentRuntime.ts';
import type { OfficeStore } from '../store.ts';
import { listDirectories, normaliseRoot, saveRoot, WorkspaceError } from '../workspace.ts';

export function sessionRoutes(store: OfficeStore, runtime: AgentRuntime): Router {
  const router = Router();

  router.get('/session', (_request, response) => {
    response.json(store.snapshot());
  });

  /**
   * The token meter on its own, for the UI and for anything scripting the
   * office (a CI job can read this after a mission instead of scraping logs).
   */
  router.get('/usage', (_request, response) => {
    response.json(store.tokenSummary());
  });

  /** Finished work per day — what the cost history panel reads. */
  router.get('/usage/history', (_request, response) => {
    response.json(store.costHistory());
  });

  router.post('/session/connect', async (request, response) => {
    const body = request.body as {
      endpoint?: string;
      apiKey?: string;
      model?: string;
      toolsEnabled?: boolean;
    };
    const endpoint = typeof body.endpoint === 'string' ? body.endpoint.trim() : '';
    const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
    const model = typeof body.model === 'string' && body.model.trim() ? body.model.trim() : store.settings.model;

    if (!endpoint || !apiKey) {
      response.status(400).json({ ok: false, message: 'Endpoint and API key are both required.' });
      return;
    }

    const outcome = await runtime.connect({
      endpoint,
      apiKey,
      model,
      toolsEnabled: body.toolsEnabled ?? store.settings.toolsEnabled,
    });
    response.status(outcome.ok ? 200 : 502).json(outcome);
  });

  router.post('/session/demo', (request, response) => {
    const body = request.body as { enabled?: boolean };
    runtime.setDemoMode(body.enabled ?? true);
    response.json({ ok: true, settings: store.publicSettings() });
  });

  router.post('/session/model', (request, response) => {
    const body = request.body as { model?: string };
    if (typeof body.model !== 'string' || body.model.trim().length === 0) {
      response.status(400).json({ ok: false, message: 'Model id is required.' });
      return;
    }
    store.setModel(body.model.trim());
    store.publishSettings();
    response.json({ ok: true, settings: store.publicSettings() });
  });

  router.post('/session/tools', (request, response) => {
    const body = request.body as { enabled?: boolean };
    store.setToolsEnabled(body.enabled ?? false);
    store.publishSettings();
    response.json({ ok: true, settings: store.publicSettings() });
  });

  router.post('/session/web', (request, response) => {
    const body = request.body as { enabled?: boolean };
    store.setWebEnabled(body.enabled ?? false);
    store.publishSettings();
    response.json({ ok: true, settings: store.publicSettings() });
  });

  router.post('/session/workspace', async (request, response) => {
    const body = request.body as { root?: string };
    const candidate = typeof body.root === 'string' ? body.root : '';
    try {
      const root = normaliseRoot(candidate);
      store.setWorkspaceRoot(root);
      store.publishSettings();
      store.appendLog('info', 'workspace.changed', `Workspace folder set to ${root}.`);
      await saveRoot(root);
      response.json({ ok: true, settings: store.publicSettings() });
    } catch (error) {
      const message = error instanceof WorkspaceError ? error.message : 'Invalid workspace folder.';
      response.status(400).json({ ok: false, message });
    }
  });

  router.get('/session/workspace/list', async (request, response) => {
    const target = typeof request.query.path === 'string' ? request.query.path : store.settings.workspaceRoot;
    try {
      const listing = await listDirectories(target);
      response.json({ ok: true, listing });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Cannot read that folder.';
      response.status(400).json({ ok: false, message });
    }
  });

  return router;
}
