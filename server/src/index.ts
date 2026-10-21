import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { AgentRuntime } from './agentRuntime.ts';
import { CLIENT_DIST_DIR, DEFAULT_ENDPOINT, DEFAULT_MODEL, OFFICE_STATE_FILE, SERVER_PORT, WORKSPACE_DIR } from './config.ts';
import { EventBus } from './events.ts';
import { loadOfficeState, OfficePersistence } from './persistence.ts';
import { agentRoutes } from './routes/agents.ts';
import { chatRoutes } from './routes/chat.ts';
import { eventRoutes } from './routes/events.ts';
import { sessionRoutes } from './routes/session.ts';
import { taskRoutes } from './routes/tasks.ts';
import { OfficeStore } from './store.ts';
import { ensureRoot, loadSavedRoot, normaliseRoot } from './workspace.ts';

async function main(): Promise<void> {
  fs.mkdirSync(WORKSPACE_DIR, { recursive: true });

  const bus = new EventBus();
  const store = new OfficeStore(bus);
  const runtime = new AgentRuntime(store, bus);

  // The launcher decides these before any connect happens, so honour them even
  // when the office starts without a key (demo mode must show the real switches).
  if (process.env.OFFICE_TOOLS === '1') store.setToolsEnabled(true);

  // The mission board from the last run, if there was one. Restoring before
  // seeding is what stops a restart from wiping the team's work.
  const restored = await loadOfficeState();
  if (restored) {
    store.restore(restored.state);
    const missions = [...store.tasks.values()].filter((task) => task.mission).length;
    console.log(
      `[office] restored ${store.tasks.size} task(s) and ${store.agents.size} worker(s) from ${OFFICE_STATE_FILE}` +
        `${missions > 0 ? ` (${missions} mission(s))` : ''}${restored.savedAt > 0 ? `, last saved ${new Date(restored.savedAt).toLocaleString()}` : ''}.`,
    );
  }

  // Restore the folder the operator picked in a previous session.
  const savedRoot = await loadSavedRoot();
  if (savedRoot) {
    try {
      const root = normaliseRoot(savedRoot);
      await ensureRoot(root);
      store.setWorkspaceRoot(root);
    } catch {
      console.log(`[office] saved workspace "${savedRoot}" is unusable — keeping the default.`);
    }
  }

  if (restored) {
    // Work that was in flight has no process behind it any more.
    const recovery = runtime.recoverAfterRestart();
    if (recovery.interrupted > 0) {
      console.log(`[office] ${recovery.interrupted} interrupted task(s) marked blocked — start one to continue.`);
    }
  } else {
    store.seedAgents();

    store.createTask({
      title: 'Audit the office lighting rig',
      detail: 'Walk the room, check the shadow fall on the north desks and file notes in workspace/lighting.md.',
      priority: 'low',
      assigneeId: null,
    });
    store.createTask({
      title: 'Ship the agent status endpoint',
      detail: 'Expose per-agent status and current task over GET /api/agents with stable ids.',
      priority: 'high',
      assigneeId: null,
    });
  }

  // Everything the office mutates is written shortly after, and the pending
  // write is flushed on the way out so a clean stop never loses the last turn.
  const persistence = new OfficePersistence(() => store.diskState());
  bus.subscribe((event) => {
    // Streaming frames would rewrite the whole board several times a second;
    // the finished message arrives as `chat.message`, which is enough.
    if (event.type === 'chat.delta') return;
    persistence.schedule();
  });
  persistence.schedule();

  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[office] ${signal} — saving the mission board.`);
    void persistence.stop().then(() => process.exit(0));
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  const app = express();
  app.use(express.json({ limit: '1mb' }));

  app.use('/api', sessionRoutes(store, runtime));
  app.use('/api', agentRoutes(store, runtime));
  app.use('/api', taskRoutes(store, runtime));
  app.use('/api', chatRoutes(store, runtime));
  app.use('/api', eventRoutes(store, bus));

  app.use('/api', (_request, response) => {
    response.status(404).json({ ok: false, message: 'Unknown endpoint.' });
  });

  if (fs.existsSync(CLIENT_DIST_DIR)) {
    app.use(express.static(CLIENT_DIST_DIR));
    app.use((request, response, next) => {
      if (request.method !== 'GET') {
        next();
        return;
      }
      response.sendFile(path.join(CLIENT_DIST_DIR, 'index.html'));
    });
  }

  app.listen(SERVER_PORT, '127.0.0.1', () => {
    console.log(`[office] server listening on http://127.0.0.1:${SERVER_PORT}`);
    console.log(`[office] workspace sandbox: ${store.settings.workspaceRoot}`);
    console.log(`[office] client dist: ${CLIENT_DIST_DIR}${fs.existsSync(CLIENT_DIST_DIR) ? '' : ' (not built yet)'}`);
  });

  const bootKey = process.env.OFFICE_API_KEY;
  if (bootKey) {
    const bootEndpoint = process.env.OFFICE_ENDPOINT ?? DEFAULT_ENDPOINT;
    const outcome = await runtime.connect({
      endpoint: bootEndpoint,
      apiKey: bootKey,
      model: process.env.OFFICE_MODEL ?? DEFAULT_MODEL,
      toolsEnabled: process.env.OFFICE_TOOLS === '1',
    });
    console.log(`[office] boot connect: ${outcome.ok ? 'ok' : `failed — ${outcome.message}`}`);
    if (!outcome.ok) {
      store.appendLog('error', 'session.connect_failed', `Could not connect to ${bootEndpoint}: ${outcome.message}`);
    }
  } else {
    console.log('[office] no OFFICE_API_KEY set — running in demo mode.');
  }

  // The launcher can pin demo mode. Applying it after the connect matters: the
  // connect switches demo off, and a later HTTP toggle can lose the race with a
  // mission that starts immediately.
  if (process.env.OFFICE_DEMO === '1') {
    store.setDemoMode(true);
    store.appendLog('info', 'session.demo', 'Demo mode is on — workers reply with scripted lines, no model calls.');
    console.log('[office] demo mode pinned by the launcher.');
  }
}

await main();
