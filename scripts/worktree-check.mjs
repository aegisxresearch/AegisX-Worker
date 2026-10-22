/**
 * Worktree isolation: two tasks can never overwrite each other.
 *
 * The check builds a real repository with uncommitted work, gives two tasks
 * their own checkout, and proves the four things that make isolation worth the
 * disk: each task sees the folder as the operator sees it, edits stay out of the
 * main folder until landing, landing is serialised through the merge queue, and
 * a landing onto a file someone else changed is refused with the file named.
 *
 * It also proves the boring half: a folder that is not a repository degrades to
 * "no isolation, same behaviour", and landing never writes a commit or a branch
 * onto the operator's history.
 *
 *   node --experimental-strip-types scripts/worktree-check.mjs
 */
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';
import { MergeQueue } from '../server/src/mergeQueue.ts';
import { executeAction } from '../server/src/tools.ts';
import { createCheckpoint } from '../server/src/git.ts';
import {
  changedInWorktree,
  collectStaleCheckouts,
  createIsolatedWorktree,
  discardWorktree,
  landWorktree,
  refreshAfterConflict,
  worktreeDiff,
} from '../server/src/worktrees.ts';

const run = promisify(execFile);
const results = [];

async function check(label, body) {
  try {
    await body();
    results.push({ label, ok: true });
    console.log(`  ✓ ${label}`);
  } catch (error) {
    results.push({ label, ok: false, error });
    console.log(`  ✗ ${label}\n      ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function git(cwd, args) {
  const { stdout } = await run('git', ['-c', 'user.name=Check', '-c', 'user.email=check@localhost', ...args], {
    cwd,
    timeout: 20_000,
  });
  return stdout;
}

const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'aegisx-worktree-'));
const repo = path.join(sandbox, 'repo');
const checkoutDir = path.join(sandbox, 'worktrees');
const plainFolder = path.join(sandbox, 'plain');
await fs.mkdir(repo, { recursive: true });
await fs.mkdir(plainFolder, { recursive: true });

await git(repo, ['init', '-q']);
await fs.writeFile(path.join(repo, 'app.ts'), 'export const value = "committed";\n');
await git(repo, ['add', 'app.ts']);
await git(repo, ['commit', '-q', '-m', 'initial']);

// The operator's uncommitted work: a modified tracked file, an untracked file,
// and a tracked file that a task will delete.
await fs.writeFile(path.join(repo, 'app.ts'), 'export const value = "local edit";\n');
await fs.writeFile(path.join(repo, 'notes.txt'), 'scratch notes\n');
await fs.writeFile(path.join(repo, 'doomed.txt'), 'delete me\n');
await git(repo, ['add', 'doomed.txt']);

const historyBefore = (await git(repo, ['rev-list', '--count', 'HEAD'])).trim();
const branchesBefore = (await git(repo, ['branch', '--list'])).trim();

const handlers = {
  moveTo: () => 'moved',
  setStatus: () => 'status',
  completeTask: () => 'done',
  addNote: () => 'noted',
  createTask: () => 'created',
};
const context = (workspaceRoot) => ({
  agentId: 'agent_w',
  agentName: 'Aria',
  taskId: null,
  toolsEnabled: true,
  webEnabled: false,
  workspaceRoot,
});

const created = [];
async function isolate(taskId) {
  const outcome = await createIsolatedWorktree({ mainRoot: repo, taskId, baseDir: checkoutDir });
  assert.equal(outcome.ok, true, `isolation failed for ${taskId}: ${outcome.ok ? '' : outcome.detail}`);
  created.push(outcome.worktree);
  return outcome.worktree;
}

console.log('\n[worktree] building the checkout');

await check('a folder that is not a repository degrades with a reason', async () => {
  const outcome = await createIsolatedWorktree({ mainRoot: plainFolder, taskId: 'task_plain', baseDir: checkoutDir });
  assert.equal(outcome.ok, false);
  assert.ok(['not_a_repo', 'git_missing'].includes(outcome.reason), `unexpected reason: ${outcome.reason}`);
  assert.ok(outcome.detail.length > 0, 'the caller needs a sentence to log');
});

await check('a repository the office created for checkpoints is left alone', async () => {
  const checkpointFolder = path.join(sandbox, 'checkpointed');
  await fs.mkdir(checkpointFolder, { recursive: true });
  await fs.writeFile(path.join(checkpointFolder, 'index.html'), '<h1>hi</h1>\n');
  const checkpoint = await createCheckpoint(checkpointFolder, 'check');
  assert.ok(checkpoint.checkpoint, `the office could not make its own repo: ${checkpoint.reason}`);
  const outcome = await createIsolatedWorktree({
    mainRoot: checkpointFolder,
    taskId: 'task_checkpointed',
    baseDir: checkoutDir,
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.reason, 'office_checkpoint', `unexpected reason: ${outcome.ok ? 'ok' : outcome.reason}`);
});

await check('the task sees the operator\'s uncommitted work, not just HEAD', async () => {
  const worktree = await isolate('task_a');
  const app = await fs.readFile(path.join(worktree.path, 'app.ts'), 'utf8');
  assert.match(app, /local edit/, 'the uncommitted edit is missing from the checkout');
  const notes = await fs.readFile(path.join(worktree.path, 'notes.txt'), 'utf8').catch(() => '');
  assert.match(notes, /scratch notes/, 'the untracked file is missing from the checkout');
  assert.equal(worktree.copiedFiles.includes('notes.txt'), true);
});

console.log('\n[worktree] isolation holds');

const taskA = created[0];
const taskB = await isolate('task_b');

await check('a write in one task never reaches the folder', async () => {
  const wrote = await executeAction(
    { action: 'write_file', path: 'app.ts', content: 'export const value = "task A";\n' },
    context(taskA.path),
    handlers,
  );
  assert.equal(wrote.ok, true, wrote.summary);
  const inCheckout = await fs.readFile(path.join(taskA.path, 'app.ts'), 'utf8');
  assert.match(inCheckout, /task A/);
  const main = await fs.readFile(path.join(repo, 'app.ts'), 'utf8');
  assert.match(main, /local edit/, 'the main folder was written before landing');
});

await check('the same file changed in two tasks stays two separate states', async () => {
  const wrote = await executeAction(
    { action: 'edit_file', path: 'app.ts', search: 'local edit', replace: 'task B' },
    context(taskB.path),
    handlers,
  );
  assert.equal(wrote.ok, true, wrote.summary);
  assert.match(await fs.readFile(path.join(taskB.path, 'app.ts'), 'utf8'), /task B/);
  assert.match(await fs.readFile(path.join(taskA.path, 'app.ts'), 'utf8'), /task A/);
  assert.match(await fs.readFile(path.join(repo, 'app.ts'), 'utf8'), /local edit/);
});

await check('the checkout reports exactly the files the task changed', async () => {
  const changed = await changedInWorktree(taskA);
  assert.deepEqual(changed, ['app.ts'], `unexpected change set: ${changed.join(', ')}`);
});

console.log('\n[worktree] landing');

const queue = new MergeQueue();
let landedA = null;

await check('landing copies the task\'s work into the folder', async () => {
  landedA = await queue.run(() => landWorktree(taskA));
  assert.equal(landedA.ok, true, landedA.detail);
  assert.deepEqual(landedA.landed, ['app.ts']);
  assert.match(await fs.readFile(path.join(repo, 'app.ts'), 'utf8'), /task A/);
});

await check('landing onto a file someone else changed is refused, with the file named', async () => {
  const landedB = await queue.run(() => landWorktree(taskB));
  assert.equal(landedB.ok, false, 'two tasks were allowed to overwrite one file');
  assert.equal(landedB.conflicts.length, 1);
  assert.equal(landedB.conflicts[0].path, 'app.ts');
  assert.match(landedB.conflicts[0].problem, /changed this file/);
  assert.match(await fs.readFile(path.join(repo, 'app.ts'), 'utf8'), /task A/, 'the refused landing still wrote');
});

await check('a task that only adds files lands without touching the rest', async () => {
  const taskC = await isolate('task_c');
  await fs.writeFile(path.join(taskC.path, 'feature.test.ts'), 'export const tested = true;\n');
  const landedC = await queue.run(() => landWorktree(taskC));
  assert.equal(landedC.ok, true, landedC.detail);
  assert.deepEqual(landedC.landed, ['feature.test.ts']);
  assert.equal(await fs.readFile(path.join(repo, 'feature.test.ts'), 'utf8'), 'export const tested = true;\n');
  assert.match(await fs.readFile(path.join(repo, 'app.ts'), 'utf8'), /task A/, 'an unrelated file was rewritten');
  await discardWorktree(taskC);
});

await check('a refused landing refreshes the copy and keeps the worker\'s version', async () => {
  const first = await isolate('task_g');
  const second = await isolate('task_h');
  await fs.writeFile(path.join(first.path, 'shared.txt'), 'first writer\n');
  await fs.writeFile(path.join(second.path, 'shared.txt'), 'second writer\n');
  assert.equal((await queue.run(() => landWorktree(first))).ok, true);
  const refused = await queue.run(() => landWorktree(second));
  assert.equal(refused.ok, false, 'the second landing overwrote the first');

  const rescued = await refreshAfterConflict(second, ['shared.txt']);
  assert.deepEqual(rescued.refreshed, ['shared.txt']);
  assert.equal(rescued.preserved.length, 1, 'the worker\'s version was not kept anywhere');
  assert.equal(await fs.readFile(rescued.preserved[0], 'utf8'), 'second writer\n');
  assert.equal(await fs.readFile(path.join(second.path, 'shared.txt'), 'utf8'), 'first writer\n');

  // Redo the change on top of the refreshed text, then land again.
  const redo = await executeAction(
    { action: 'edit_file', path: 'shared.txt', search: 'first writer', replace: 'second writer merged' },
    context(second.path),
    handlers,
  );
  assert.equal(redo.ok, true, redo.summary);
  const landed = await queue.run(() => landWorktree(second));
  assert.equal(landed.ok, true, landed.detail);
  assert.equal(await fs.readFile(path.join(repo, 'shared.txt'), 'utf8'), 'second writer merged\n');
  await discardWorktree(first);
  await discardWorktree(second);
});

await check('the same task can run again after its checkout was thrown away', async () => {
  const once = await isolate('task_rerun');
  await fs.rm(once.path, { recursive: true, force: true });
  const twice = await createIsolatedWorktree({ mainRoot: repo, taskId: 'task_rerun', baseDir: checkoutDir });
  assert.equal(twice.ok, true, twice.ok ? 'no reason' : twice.detail);
  created.push(twice.worktree);
  await discardWorktree(twice.worktree);
});

await check('a deletion lands as a deletion, not as a leftover', async () => {
  const taskD = await isolate('task_d');
  await fs.rm(path.join(taskD.path, 'doomed.txt'));
  const landedD = await queue.run(() => landWorktree(taskD));
  assert.equal(landedD.ok, true, landedD.detail);
  assert.deepEqual(landedD.deleted, ['doomed.txt']);
  assert.equal(await fs.readFile(path.join(repo, 'doomed.txt'), 'utf8').catch(() => 'gone'), 'gone');
  await discardWorktree(taskD);
});

await check('office artifacts never land in the folder', async () => {
  const task = await isolate('task_artifacts');
  await fs.mkdir(path.join(task.path, '.agent-office', 'previews'), { recursive: true });
  await fs.writeFile(path.join(task.path, '.agent-office', 'previews', 'page-1440x900.png'), 'png');
  await fs.writeFile(path.join(task.path, 'deliverable.html'), '<h1>done</h1>\n');

  const diff = await worktreeDiff(task);
  assert.match(diff, /deliverable\.html/, 'the task\'s own change is missing from the review diff');
  assert.ok(!diff.includes('.agent-office'), 'the reviewer was handed office artifacts');
  assert.deepEqual(await changedInWorktree(task), ['deliverable.html']);

  const landed = await queue.run(() => landWorktree(task));
  assert.equal(landed.ok, true, landed.detail);
  assert.deepEqual(landed.landed, ['deliverable.html']);
  assert.deepEqual(landed.skipped, ['.agent-office/previews/page-1440x900.png']);
  assert.equal(
    await fs.stat(path.join(repo, '.agent-office')).then(() => 'exists', () => 'gone'),
    'gone',
    'the office wrote its own files into the operator\'s folder',
  );
  assert.equal(await fs.readFile(path.join(repo, 'deliverable.html'), 'utf8'), '<h1>done</h1>\n');
  await discardWorktree(task);
});

await check('an old checkout is reclaimed, a running one is never touched', async () => {
  const gcBase = path.join(sandbox, 'gc-worktrees');
  const make = async (name, ageDays) => {
    const checkoutPath = path.join(gcBase, name);
    await fs.mkdir(checkoutPath, { recursive: true });
    await fs.writeFile(path.join(checkoutPath, 'work.txt'), 'unfinished\n');
    const stamp = new Date(Date.now() - ageDays * 86_400_000);
    await fs.utimes(checkoutPath, stamp, stamp);
    return checkoutPath;
  };
  const oldBlocked = await make('task_old_blocked', 30);
  const freshBlocked = await make('task_fresh_blocked', 1);
  const oldRunning = await make('task_old_running', 30);
  await fs.mkdir(path.join(sandbox, 'worktree-conflicts', 'task_old_blocked'), { recursive: true });

  const outcome = await collectStaleCheckouts({
    mainRoot: repo,
    baseDir: gcBase,
    eligibleTaskIds: new Set(['task_old_blocked', 'task_fresh_blocked']),
    olderThanMs: 7 * 86_400_000,
  });
  assert.deepEqual(outcome.removed.map((entry) => entry.taskId), ['task_old_blocked']);
  assert.equal(outcome.kept, 2);
  assert.equal(await fs.stat(oldBlocked).then(() => 'exists', () => 'gone'), 'gone');
  assert.equal(await fs.stat(freshBlocked).then(() => 'exists', () => 'gone'), 'exists');
  assert.equal(
    await fs.stat(oldRunning).then(() => 'exists', () => 'gone'),
    'exists',
    'a running task\'s checkout was thrown away',
  );
  assert.equal(
    await fs.stat(path.join(sandbox, 'worktree-conflicts', 'task_old_blocked')).then(() => 'exists', () => 'gone'),
    'gone',
    'the refused copy outlived its checkout',
  );
});

await check('the checkout cap removes the oldest eligible trees first', async () => {
  const capBase = path.join(sandbox, 'cap-worktrees');
  const make = async (name, ageDays) => {
    const checkoutPath = path.join(capBase, name);
    await fs.mkdir(checkoutPath, { recursive: true });
    const stamp = new Date(Date.now() - ageDays * 86_400_000);
    await fs.utimes(checkoutPath, stamp, stamp);
    return checkoutPath;
  };
  const names = ['task_c1', 'task_c2', 'task_c3', 'task_c4'];
  const paths = [];
  for (const [index, name] of names.entries()) paths.push(await make(name, 10 - index));

  const outcome = await collectStaleCheckouts({
    mainRoot: repo,
    baseDir: capBase,
    eligibleTaskIds: new Set(names),
    olderThanMs: 365 * 86_400_000,
    keepAtMost: 2,
  });
  assert.equal(outcome.kept, 2);
  assert.deepEqual(outcome.removed.map((entry) => entry.taskId), ['task_c1', 'task_c2']);
  assert.equal(await fs.stat(paths[0]).then(() => 'exists', () => 'gone'), 'gone');
  assert.equal(await fs.stat(paths[3]).then(() => 'exists', () => 'gone'), 'exists');
});

await check('landing is serialised: concurrent landings cannot interleave', async () => {
  const taskE = await isolate('task_e');
  const taskF = await isolate('task_f');
  await fs.writeFile(path.join(taskE.path, 'e.txt'), 'e\n');
  await fs.writeFile(path.join(taskF.path, 'f.txt'), 'f\n');
  const [landedE, landedF] = await Promise.all([
    queue.run(() => landWorktree(taskE)),
    queue.run(() => landWorktree(taskF)),
  ]);
  assert.equal(landedE.ok, true, landedE.detail);
  assert.equal(landedF.ok, true, landedF.detail);
  assert.equal(await fs.readFile(path.join(repo, 'e.txt'), 'utf8'), 'e\n');
  assert.equal(await fs.readFile(path.join(repo, 'f.txt'), 'utf8'), 'f\n');
  await discardWorktree(taskE);
  await discardWorktree(taskF);
});

console.log('\n[worktree] the folder is left as the operator had it');

await check('landing writes no commit and no branch of its own', async () => {
  assert.equal((await git(repo, ['rev-list', '--count', 'HEAD'])).trim(), historyBefore);
  assert.equal((await git(repo, ['branch', '--list'])).trim(), branchesBefore);
});

await check('a discarded checkout is gone from disk and from git', async () => {
  await discardWorktree(taskB);
  await discardWorktree(taskA);
  assert.equal(await fs.stat(taskB.path).then(() => 'exists', () => 'gone'), 'gone');
  const listed = await git(repo, ['worktree', 'list', '--porcelain']);
  assert.ok(!listed.includes(taskB.path), 'git still tracks the discarded checkout');
});

await check('the folder keeps the work that landed', async () => {
  assert.match(await fs.readFile(path.join(repo, 'app.ts'), 'utf8'), /task A/);
  assert.match(await fs.readFile(path.join(repo, 'feature.test.ts'), 'utf8'), /tested/);
  assert.equal(await fs.readFile(path.join(repo, 'notes.txt'), 'utf8'), 'scratch notes\n');
});

// ── the wiring: a task that really runs in its own checkout ─────────────────

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function waitFor(predicate, label, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate().catch(() => null);
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

/** A model that writes one file in whatever folder the task is given, then finishes. */
function startMockOffice(state, workspace) {
  const server = http.createServer((request, response) => {
    if (request.method === 'GET' && request.url?.startsWith('/v1/models')) {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ data: [{ id: 'mock-worktree-office' }] }));
      return;
    }
    if (!request.url?.includes('/chat/completions')) {
      response.writeHead(404).end('not found');
      return;
    }
    let raw = '';
    request.on('data', (chunk) => {
      raw += chunk;
    });
    request.on('end', async () => {
      const body = JSON.parse(raw || '{}');
      const messages = Array.isArray(body.messages) ? body.messages : [];
      const system = String(messages.find((entry) => entry.role === 'system')?.content ?? '');

      if (system.startsWith('You are the independent reviewer')) {
        state.reviews += 1;
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(
          JSON.stringify({
            choices: [{ message: { content: '{"verdict":"pass","reasons":[]}' } }],
            usage: { prompt_tokens: 40, completion_tokens: 4, total_tokens: 44 },
          }),
        );
        return;
      }

      const toolResults = messages.filter((entry) => entry.role === 'tool');
      const lastTool = String(toolResults.at(-1)?.content ?? '');
      // With `conflict`, another worker edits the same file just before this one
      // declares done, which is exactly the case isolation has to survive.
      if (state.conflict && !state.meddled && toolResults.length > 0) {
        state.meddled = true;
        await fs.writeFile(path.join(workspace, 'app.ts'), 'export const who = "other worker";\n');
      }
      const writeCall = {
        name: 'write_file',
        arguments: JSON.stringify({ path: 'app.ts', content: 'export const who = "isolated worker";\n' }),
      };
      const shouldWrite = toolResults.length === 0 || (!state.giveUp && lastTool.includes('folder changed these files'));
      const toolCall = shouldWrite
        ? writeCall
        : { name: 'complete_task', arguments: JSON.stringify({ summary: 'Wrote app.ts.' }) };

      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      const send = (payload) => response.write(`data: ${JSON.stringify(payload)}\n\n`);
      send({ choices: [{ delta: { content: 'Working.' } }] });
      send({
        choices: [
          { delta: { tool_calls: [{ index: 0, id: `call_${state.worker}`, type: 'function', function: toolCall }] } },
        ],
      });
      send({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
      send({ usage: { prompt_tokens: 80, completion_tokens: 10, total_tokens: 90 } });
      response.write('data: [DONE]\n\n');
      response.end();
      state.worker += 1;
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

async function missionCheck({ conflict, giveUp = false }) {
  console.log(
    `\n[worktree] inside a real mission${giveUp ? ' (worker gives up instead of redoing)' : conflict ? ' (another worker edits the same file)' : ''}`,
  );
  const slug = giveUp ? 'giveup' : conflict ? 'conflict' : 'plain';
  const project = path.join(sandbox, `project-${slug}`);
  const stateDir = path.join(sandbox, `mission-state-${slug}`);
  await fs.mkdir(project, { recursive: true });
  await fs.writeFile(path.join(project, 'app.ts'), 'export const who = "base";\n');
  await fs.writeFile(
    path.join(project, 'package.json'),
    JSON.stringify({ name: 'probe', scripts: { check: 'node -e "process.exit(0)"' } }, null, 2),
  );
  await git(project, ['init', '-q']);
  await git(project, ['add', 'app.ts', 'package.json']);
  await git(project, ['commit', '-q', '-m', 'initial']);

  const state = { reviews: 0, worker: 0, conflict, meddled: false, giveUp };
  const model = await startMockOffice(state, project);
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const server = spawn(
    process.execPath,
    ['--experimental-strip-types', path.join(path.resolve(import.meta.dirname, '..'), 'server', 'src', 'index.ts')],
    {
      cwd: path.resolve(import.meta.dirname, '..'),
      env: {
        ...process.env,
        OFFICE_PORT: String(port),
        OFFICE_ENDPOINT: `http://127.0.0.1:${model.address().port}/v1`,
        OFFICE_API_KEY: 'test-key',
        OFFICE_MODEL: 'mock-worktree-office',
        OFFICE_WORKSPACE: project,
        OFFICE_STATE_DIR: stateDir,
        OFFICE_TOOLS: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  try {
    const snapshot = await waitFor(async () => {
      const response = await fetch(`${origin}/api/session`);
      if (!response.ok) return null;
      const body = await response.json();
      return body.settings.configured ? body : null;
    }, 'the server to connect');

    const lead = snapshot.agents.find((agent) => agent.role === 'Tech Lead');
    await fetch(`${origin}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Write app', detail: 'One file.', assigneeId: lead.id }),
    });

    await waitFor(async () => {
      const body = await (await fetch(`${origin}/api/session`)).json();
      const found = body.tasks.find((entry) => entry.title === 'Write app');
      if (giveUp) return found && found.status !== 'doing' && found.status !== 'todo' ? found : null;
      return found && found.status === 'done' ? found : null;
    }, giveUp ? 'the task to stop' : 'the task to finish');

    const finalState = await (await fetch(`${origin}/api/session`)).json();
    const kinds = finalState.logs.map((entry) => entry.kind);
    assert.ok(kinds.includes('task.worktree'), `no isolated copy was announced: ${JSON.stringify(kinds.slice(-12))}`);
    if (giveUp) {
      assert.equal(
        await fs.readFile(path.join(project, 'app.ts'), 'utf8'),
        'export const who = "other worker";\n',
        'giving up must not overwrite the folder',
      );
      assert.ok(kinds.includes('task.merge'), 'the refusal was never reported');
      return;
    }

    assert.ok(
      kinds.includes('task.landed'),
      `the landing was never reported (kinds: ${kinds.slice(-14).join(' · ')}; task: ${JSON.stringify(
        finalState.tasks.find((entry) => entry.title === 'Write app'),
      ).slice(0, 400)})`,
    );

    const content = await fs.readFile(path.join(project, 'app.ts'), 'utf8');
    assert.match(content, /isolated worker/, 'the task\'s work never reached the folder');

    if (conflict) {
      assert.ok(kinds.includes('task.merge'), `the refused landing was not reported: ${JSON.stringify(kinds.slice(-12))}`);
      const finished = finalState.tasks.find((entry) => entry.title === 'Write app');
      assert.ok(
        finished.notes.some((note) => note.includes('Merge gate')),
        `the conflict must be recorded on the task: ${JSON.stringify(finished.notes)}`,
      );
    }

    const leftovers = await fs.readdir(path.join(stateDir, 'worktrees')).catch(() => []);
    assert.deepEqual(leftovers, [], `a finished task left its checkout behind: ${leftovers.join(', ')}`);
  } finally {
    server.kill('SIGTERM');
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 3_000);
      server.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    await new Promise((resolve) => model.close(resolve));
  }
}

/** Boots the office against a given project + state, so a test can restart it. */
async function spawnOffice({ project, stateDir, modelPort, port }) {
  const server = spawn(
    process.execPath,
    ['--experimental-strip-types', path.join(path.resolve(import.meta.dirname, '..'), 'server', 'src', 'index.ts')],
    {
      cwd: path.resolve(import.meta.dirname, '..'),
      env: {
        ...process.env,
        OFFICE_PORT: String(port),
        OFFICE_ENDPOINT: `http://127.0.0.1:${modelPort}/v1`,
        OFFICE_API_KEY: 'test-key',
        OFFICE_MODEL: 'mock-worktree-office',
        OFFICE_WORKSPACE: project,
        OFFICE_STATE_DIR: stateDir,
        OFFICE_TOOLS: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const origin = `http://127.0.0.1:${port}`;
  const session = await waitFor(async () => {
    const response = await fetch(`${origin}/api/session`).catch(() => null);
    if (!response?.ok) return null;
    const body = await response.json();
    return body.settings.configured ? body : null;
  }, 'the server to connect');
  return { server, origin, session };
}

async function stopOffice(server, model) {
  server.kill('SIGTERM');
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 3_000);
    server.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
  await new Promise((resolve) => model.close(resolve));
}

async function createTask(origin, title) {
  const session = await (await fetch(`${origin}/api/session`)).json();
  const lead = session.agents.find((agent) => agent.role === 'Tech Lead');
  await fetch(`${origin}/api/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, detail: 'One file.', assigneeId: lead.id }),
  });
  return waitFor(async () => {
    const body = await (await fetch(`${origin}/api/session`)).json();
    const found = body.tasks.find((entry) => entry.title === title);
    return found && found.status !== 'doing' && found.status !== 'todo' ? found : null;
  }, `"${title}" to settle`);
}

/**
 * The sweep is wired into the runtime, not only the module: a blocked task left
 * a checkout behind, the next run must reclaim it and still finish its own work.
 */
async function gcReclaimCheck() {
  console.log('\n[worktree] reclaiming a checkout across a restart');
  const project = path.join(sandbox, 'project-gc');
  const stateDir = path.join(sandbox, 'mission-state-gc');
  await fs.mkdir(project, { recursive: true });
  await fs.writeFile(path.join(project, 'app.ts'), 'export const who = "base";\n');
  await fs.writeFile(
    path.join(project, 'package.json'),
    JSON.stringify({ name: 'probe', scripts: { check: 'node -e "process.exit(0)"' } }, null, 2),
  );
  await git(project, ['init', '-q']);
  await git(project, ['add', 'app.ts', 'package.json']);
  await git(project, ['commit', '-q', '-m', 'initial']);

  // Run 1: a task that gives up on a conflict, leaving a blocked task + checkout.
  const firstModel = await startMockOffice({ reviews: 0, worker: 0, conflict: true, giveUp: true }, project);
  const firstPort = await freePort();
  const first = await spawnOffice({ project, stateDir, modelPort: firstModel.address().port, port: firstPort });
  let blocked;
  try {
    blocked = await createTask(first.origin, 'Write app');
    assert.equal(blocked.status, 'blocked', 'the giving-up task must stop, not finish');
  } finally {
    await stopOffice(first.server, firstModel);
  }

  const checkouts = await fs.readdir(path.join(stateDir, 'worktrees'));
  assert.equal(checkouts.length, 1, `expected one kept checkout, saw ${checkouts.join(', ')}`);
  const stale = path.join(stateDir, 'worktrees', checkouts[0]);
  const longAgo = new Date(Date.now() - 30 * 86_400_000);
  await fs.utimes(stale, longAgo, longAgo);

  // Run 2: the sweep runs before the first checkout of this process is made.
  const secondModel = await startMockOffice({ reviews: 0, worker: 0, conflict: false }, project);
  const secondPort = await freePort();
  const second = await spawnOffice({ project, stateDir, modelPort: secondModel.address().port, port: secondPort });
  try {
    const finished = await createTask(second.origin, 'Write second app');
    assert.equal(finished.status, 'done', `the new task did not finish: ${finished.status}`);

    const body = await (await fetch(`${second.origin}/api/session`)).json();
    const reclaimed = body.logs.filter((entry) => entry.kind === 'task.cleanup' && entry.message.includes('Reclaimed'));
    assert.equal(reclaimed.length, 1, `the sweep did not report itself: ${JSON.stringify(body.logs.slice(-6))}`);
    assert.equal(await fs.stat(stale).then(() => 'exists', () => 'gone'), 'gone', 'the old checkout survived the sweep');

    const stillBlocked = body.tasks.find((entry) => entry.id === blocked.id);
    assert.ok(stillBlocked, 'reclaiming the tree must not remove the task');
    assert.equal(stillBlocked.status, 'blocked');
  } finally {
    await stopOffice(second.server, secondModel);
  }
}

await check('a real task works in its own checkout and lands on completion', () => missionCheck({ conflict: false }));

await check('a real task survives another worker changing the same file', () => missionCheck({ conflict: true }));

await check('a task cannot call itself done while its change is missing', () =>
  missionCheck({ conflict: true, giveUp: true }),
);

await check('an old blocked checkout is reclaimed on the next run', gcReclaimCheck);

const failed = results.filter((entry) => !entry.ok);
console.log(`\n[worktree] ${results.length - failed.length}/${results.length} checks passed.`);
if (failed.length > 0) {
  console.log(`Failed: ${failed.map((entry) => entry.label).join(' · ')}`);
  process.exitCode = 1;
}

for (const worktree of created) {
  await git(repo, ['worktree', 'remove', '--force', worktree.path]).catch(() => undefined);
}
await fs.rm(sandbox, { recursive: true, force: true });
