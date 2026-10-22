/**
 * The toolkit that makes edits and navigation cheap: unified patches, the code
 * map, the policy gate, and observation redaction.
 *
 * These are the parts a model relies on every turn, so each check here is a
 * behaviour the worker would notice: a patch that half-applies, a symbol search
 * that ranks a test above the real definition, a `.env` that reaches the model.
 *
 *   node --experimental-strip-types scripts/toolkit-check.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { buildCodeMap, findReferences, scanSymbols, searchSymbols } from '../server/src/codeMap.ts';
import { applyUnifiedDiff } from '../server/src/patch.ts';
import { evaluate } from '../server/src/policy.ts';
import { dependencyWaves, readyTasks, unresolvedDependencies } from '../server/src/taskGraph.ts';
import { executeAction } from '../server/src/tools.ts';
import { serializeMessages } from '../server/src/llm.ts';
import http from 'node:http';
import { containsSecret, redactSecrets } from '../server/src/redact.ts';

const results = [];
let sandbox = '';

async function check(label, run) {
  try {
    await run();
    results.push({ label, ok: true });
    console.log(`  ✓ ${label}`);
  } catch (error) {
    results.push({ label, ok: false, error });
    console.log(`  ✗ ${label}\n      ${error instanceof Error ? error.message : String(error)}`);
  }
}

function say(message) {
  console.log(`\n[toolkit] ${message}`);
}

async function folder(name) {
  const root = path.join(sandbox, name);
  await fs.mkdir(root, { recursive: true });
  return root;
}

const policyContext = (root, extra = {}) => ({
  workspaceRoot: root,
  toolsEnabled: true,
  webEnabled: true,
  provenance: 'user',
  ...extra,
});

// ── patches ─────────────────────────────────────────────────────────────────

async function patchChecks() {
  say('unified patches');

  await check('a single-hunk patch replaces exactly its lines', async () => {
    const root = await folder('patch-one');
    const target = path.join(root, 'greet.ts');
    await fs.writeFile(target, 'export function greet() {\n  return "hi";\n}\n', 'utf8');

    const outcome = await applyUnifiedDiff(
      root,
      ['--- a/greet.ts', '+++ b/greet.ts', '@@ -1,3 +1,3 @@', ' export function greet() {', '-  return "hi";', '+  return "hello";', ' }'].join('\n'),
    );
    assert.equal(outcome.ok, true, 'the patch should apply');
    assert.equal(await fs.readFile(target, 'utf8'), 'export function greet() {\n  return "hello";\n}\n');
    assert.deepEqual(outcome.files.map((file) => file.path), ['greet.ts']);
    assert.equal(outcome.files[0].added + outcome.files[0].removed, 2);
  });

  await check('a patch still applies after earlier lines moved', async () => {
    const root = await folder('patch-drift');
    const target = path.join(root, 'app.ts');
    await fs.writeFile(target, '// header added later\n\nconst a = 1;\nconst b = 2;\nconst c = 3;\n', 'utf8');

    const outcome = await applyUnifiedDiff(
      root,
      ['--- a/app.ts', '+++ b/app.ts', '@@ -1,2 +1,2 @@', ' const a = 1;', '-const b = 2;', '+const b = 20;'].join('\n'),
    );
    assert.equal(outcome.ok, true, 'context matching should absorb the drift');
    assert.match(await fs.readFile(target, 'utf8'), /const b = 20;/);
  });

  await check('one bad hunk refuses the whole patch', async () => {
    const root = await folder('patch-atomic');
    const first = path.join(root, 'first.ts');
    const second = path.join(root, 'second.ts');
    await fs.writeFile(first, 'const one = 1;\n', 'utf8');
    await fs.writeFile(second, 'const two = 2;\n', 'utf8');

    const outcome = await applyUnifiedDiff(
      root,
      [
        '--- a/first.ts',
        '+++ b/first.ts',
        '@@ -1,1 +1,1 @@',
        '-const one = 1;',
        '+const one = 100;',
        '--- a/second.ts',
        '+++ b/second.ts',
        '@@ -1,1 +1,1 @@',
        '-const nope = 0;',
        '+const two = 200;',
      ].join('\n'),
    );
    assert.equal(outcome.ok, false, 'the second hunk cannot match');
    assert.equal(await fs.readFile(first, 'utf8'), 'const one = 1;\n', 'the first file must be untouched');
    assert.equal(await fs.readFile(second, 'utf8'), 'const two = 2;\n');
  });

  await check('a dry run reports the fit and writes nothing', async () => {
    const root = await folder('patch-dry');
    const target = path.join(root, 'keep.ts');
    await fs.writeFile(target, 'const keep = true;\n', 'utf8');
    const outcome = await applyUnifiedDiff(
      root,
      ['--- a/keep.ts', '+++ b/keep.ts', '@@ -1,1 +1,1 @@', '-const keep = true;', '+const keep = false;'].join('\n'),
      { dryRun: true },
    );
    assert.equal(outcome.ok, true);
    assert.equal(outcome.dryRun, true);
    assert.equal(await fs.readFile(target, 'utf8'), 'const keep = true;\n');
  });

  await check('a patch cannot reach outside the workspace', async () => {
    const root = await folder('patch-escape');
    const outcome = await applyUnifiedDiff(
      root,
      ['--- a/../outside.ts', '+++ b/../outside.ts', '@@ -1,1 +1,1 @@', '-const a = 1;', '+const a = 2;'].join('\n'),
    );
    assert.equal(outcome.ok, false);
    assert.match(outcome.message, /escapes|outside/i);
  });
}

// ── the code map ────────────────────────────────────────────────────────────

async function codeMapChecks() {
  say('code map');

  await check('declarations are found in TypeScript and Python', async () => {
    const ts = scanSymbols(
      'src/usage.ts',
      [
        'export interface UsageSummary {',
        '  totalTokens: number;',
        '}',
        'export function emptyUsage(): TokenUsage {',
        '  return { totalTokens: 0 };',
        '}',
        'const usageFor = (id: string) => id;',
      ].join('\n'),
    );
    assert.deepEqual(
      ts.map((symbol) => `${symbol.kind}:${symbol.name}:${symbol.line}`),
      ['interface:UsageSummary:1', 'function:emptyUsage:4', 'constant:usageFor:7'],
    );

    const python = scanSymbols('pkg/jobs.py', ['class Runner:', '    def start(self):', '        pass', 'def main():', '    pass'].join('\n'));
    assert.deepEqual(
      python.map((symbol) => `${symbol.kind}:${symbol.name}`),
      ['class:Runner', 'method:start', 'function:main'],
    );
  });

  await check('exact names outrank prefixes, and sources outrank their tests', async () => {
    const root = await folder('map-rank');
    await fs.mkdir(path.join(root, 'src'), { recursive: true });
    await fs.writeFile(path.join(root, 'src', 'usage.ts'), 'export function usageSummary() {}\nexport function usageHistory() {}\n');
    await fs.writeFile(path.join(root, 'src', 'usage.test.ts'), 'export function usageSummaryFixture() {}\n');
    const map = await buildCodeMap(root, { refresh: true });
    const names = searchSymbols(map, 'usageSummary', { limit: 3 }).map((symbol) => symbol.name);
    assert.equal(names[0], 'usageSummary', `ranking was ${names.join(', ')}`);
  });

  await check('references include call sites and flag the definition', async () => {
    const root = await folder('map-refs');
    await fs.mkdir(path.join(root, 'src'), { recursive: true });
    await fs.writeFile(path.join(root, 'src', 'usage.ts'), 'export function emptyUsage() {\n  return {};\n}\n');
    await fs.writeFile(path.join(root, 'src', 'store.ts'), 'import { emptyUsage } from "./usage.ts";\nconst start = emptyUsage();\n');
    const map = await buildCodeMap(root, { refresh: true });
    const hits = await findReferences(map, 'emptyUsage');
    assert.ok(hits.length >= 3, `expected the definition and two mentions, saw ${hits.length}`);
    assert.ok(hits.some((hit) => hit.definition && hit.path === 'src/usage.ts'));
    assert.ok(hits.some((hit) => !hit.definition && hit.path === 'src/store.ts'));
  });

  await check('node_modules is not indexed', async () => {
    const root = await folder('map-skip');
    await fs.mkdir(path.join(root, 'node_modules', 'left-pad'), { recursive: true });
    await fs.writeFile(path.join(root, 'node_modules', 'left-pad', 'index.js'), 'module.exports = function pad() {};\n');
    await fs.writeFile(path.join(root, 'index.js'), 'export function own() {}\n');
    const map = await buildCodeMap(root, { refresh: true });
    assert.deepEqual(map.files, ['index.js']);
  });
}

// ── the task graph ──────────────────────────────────────────────────────────

function taskFixture(overrides) {
  return {
    id: 'task_x',
    title: 'fixture',
    detail: '',
    status: 'todo',
    priority: 'medium',
    assigneeId: null,
    createdAt: 0,
    updatedAt: 0,
    notes: [],
    parentId: null,
    mission: false,
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    failureReason: null,
    ...overrides,
  };
}

async function taskGraphChecks() {
  say('task graph');

  await check('done and deleted dependencies stop blocking', async () => {
    const done = taskFixture({ id: 'task_done', status: 'done' });
    const waiting = taskFixture({ id: 'task_wait', status: 'doing' });
    const tasks = new Map([
      [done.id, done],
      [waiting.id, waiting],
      ['task_self', taskFixture({ id: 'task_self', dependsOn: ['task_done', 'task_gone'] })],
    ]);
    const self = tasks.get('task_self');
    assert.deepEqual(unresolvedDependencies(self, tasks), []);
    const blocked = taskFixture({ id: 'task_blocked', dependsOn: ['task_wait', 'task_gone'] });
    tasks.set(blocked.id, blocked);
    assert.deepEqual(unresolvedDependencies(blocked, tasks), ['task_wait']);
  });

  await check('a finished dependency wakes only what is actually ready', async () => {
    const first = taskFixture({ id: 'task_1', status: 'done', createdAt: 1 });
    const ready = taskFixture({ id: 'task_2', status: 'todo', dependsOn: ['task_1'], createdAt: 3 });
    const alsoReady = taskFixture({ id: 'task_3', status: 'todo', dependsOn: ['task_1'], createdAt: 2 });
    const chain = taskFixture({ id: 'task_4', status: 'todo', dependsOn: ['task_2'], createdAt: 4 });
    const tasks = new Map([[first.id, first], [ready.id, ready], [alsoReady.id, alsoReady], [chain.id, chain]]);
    assert.deepEqual(
      readyTasks(tasks, 'task_1').map((task) => task.id),
      ['task_3', 'task_2'],
      'oldest first, and the chain waits for task_2',
    );
  });

  await check('waves order a chain and a cycle does not hang', async () => {
    const a = taskFixture({ id: 'a' });
    const b = taskFixture({ id: 'b', dependsOn: ['a'] });
    const c = taskFixture({ id: 'c', dependsOn: ['b'] });
    const waves = dependencyWaves([a, b, c]);
    assert.deepEqual(waves.map((wave) => wave.map((task) => task.id)), [['a'], ['b'], ['c']]);

    const left = taskFixture({ id: 'left', dependsOn: ['right'] });
    const right = taskFixture({ id: 'right', dependsOn: ['left'] });
    const cyclic = dependencyWaves([left, right]);
    assert.equal(cyclic.flat().length, 2, 'both cycle members are still on the board');
  });
}

// ── the tool dispatcher ─────────────────────────────────────────────────────

/** The handlers the runtime passes in; none of these checks need them. */
const noopHandlers = {
  moveTo: () => 'moved',
  setStatus: () => 'status',
  completeTask: () => 'done',
  addNote: () => 'noted',
  createTask: () => 'created',
};

async function dispatcherChecks() {
  say('tool dispatcher');

  await check('apply_patch and search_symbol work through the real entry point', async () => {
    const root = await folder('dispatch');
    await fs.writeFile(path.join(root, 'usage.ts'), 'export function emptyUsage() {\n  return 0;\n}\n', 'utf8');
    const context = {
      agentId: 'agent_1',
      agentName: 'Aria',
      taskId: null,
      toolsEnabled: true,
      webEnabled: false,
      workspaceRoot: root,
    };

    const patched = await executeAction(
      {
        action: 'apply_patch',
        patch: ['--- a/usage.ts', '+++ b/usage.ts', '@@ -1,3 +1,3 @@', ' export function emptyUsage() {', '-  return 0;', '+  return 1;', ' }'].join('\n'),
      },
      context,
      noopHandlers,
    );
    assert.equal(patched.ok, true, patched.summary);
    assert.match(await fs.readFile(path.join(root, 'usage.ts'), 'utf8'), /return 1;/);

    const found = await executeAction({ action: 'search_symbol', query: 'emptyUsage' }, context, noopHandlers);
    assert.equal(found.ok, true, found.summary);
    assert.match(found.detail, /usage\.ts:1 function emptyUsage/);
  });

  await check('a read that hits a key returns a masked observation', async () => {
    const root = await folder('dispatch-redact');
    await fs.writeFile(path.join(root, 'notes.md'), 'Deploy note\nOPENAI_API_KEY=sk-live-abcdef123456\n', 'utf8');
    const result = await executeAction(
      { action: 'read_file', path: 'notes.md' },
      {
        agentId: 'agent_1',
        agentName: 'Aria',
        taskId: null,
        toolsEnabled: true,
        webEnabled: false,
        workspaceRoot: root,
      },
      noopHandlers,
    );
    assert.equal(result.ok, true);
    assert.equal(result.detail.includes('sk-live-abcdef123456'), false, 'the key reached the model');
    assert.match(result.detail, /masked/i);
  });

  await check('read_media attaches a real image as a content part', async () => {
    const root = await folder('dispatch-media');
    // A 1x1 transparent PNG — bytes matter, not size.
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    );
    await fs.writeFile(path.join(root, 'shot.png'), png);
    await fs.writeFile(path.join(root, 'notes.txt'), 'plain text');

    const result = await executeAction(
      { action: 'read_media', path: 'shot.png' },
      {
        agentId: 'agent_1',
        agentName: 'Aria',
        taskId: null,
        toolsEnabled: true,
        webEnabled: false,
        workspaceRoot: root,
      },
      noopHandlers,
    );
    assert.equal(result.ok, true, result.summary);
    assert.equal(result.media.mime, 'image/png');
    assert.ok(result.media.dataUrl.startsWith('data:image/png;base64,'));
    assert.equal(result.detail.includes('base64'), false, 'base64 must not ride in the JSON observation');

    const wire = serializeMessages([
      { role: 'user', content: 'Look at this.', images: [result.media.dataUrl] },
    ]);
    const content = wire[0].content;
    assert.ok(Array.isArray(content), 'an image message must become a content-part array');
    assert.equal(content[0].type, 'text');
    assert.equal(content[1].type, 'image_url');
    assert.equal(content[1].image_url.url, result.media.dataUrl);

    const refused = await executeAction(
      { action: 'read_media', path: 'notes.txt' },
      {
        agentId: 'agent_1',
        agentName: 'Aria',
        taskId: null,
        toolsEnabled: true,
        webEnabled: false,
        workspaceRoot: root,
      },
      noopHandlers,
    );
    assert.equal(refused.ok, false);
    assert.equal(refused.code, 'binary_refused');
    assert.match(refused.detail, /read_file/);
  });

  await check('http_request reaches a local server and reports its JSON', async () => {
    const server = http.createServer((request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ status: 'ok', sawHeader: request.headers['x-check'] ?? null }));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const root = await folder('dispatch-http');
    try {
      const result = await executeAction(
        { action: 'http_request', url: `http://127.0.0.1:${port}/health`, headers: { 'x-check': 'yes' } },
        {
          agentId: 'agent_1',
          agentName: 'Aria',
          taskId: null,
          toolsEnabled: true,
          webEnabled: true,
          workspaceRoot: root,
        },
        noopHandlers,
      );
      assert.equal(result.ok, true, result.summary);
      assert.match(result.detail, /"sawHeader": "yes"/);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  await check('run_check names the missing script instead of guessing', async () => {
    const root = await folder('dispatch-check');
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: { build: 'echo ok' } }), 'utf8');
    const result = await executeAction(
      { action: 'run_check', name: 'test' },
      {
        agentId: 'agent_1',
        agentName: 'Aria',
        taskId: null,
        toolsEnabled: true,
        webEnabled: false,
        workspaceRoot: root,
      },
      noopHandlers,
    );
    assert.equal(result.ok, false);
    assert.equal(result.code, 'not_found');
    assert.match(result.detail, /build/);
  });
}

// ── the policy gate ─────────────────────────────────────────────────────────

async function policyChecks() {
  say('policy gate');

  await check('a secret file is refused, its template is not', async () => {
    const root = await folder('policy-secret');
    const secret = evaluate({ action: 'read_file', args: { path: '.env' } }, policyContext(root));
    assert.equal(secret.effect, 'deny');
    const template = evaluate({ action: 'read_file', args: { path: '.env.example' } }, policyContext(root));
    assert.equal(template.effect, 'allow', '.env.example holds no secret');
  });

  await check('a patch is checked by the paths in its headers', async () => {
    const root = await folder('policy-patch');
    const verdict = evaluate(
      {
        action: 'apply_patch',
        args: { patch: '--- a/../secrets.ts\n+++ b/../secrets.ts\n@@ -1 +1 @@\n-a\n+b' },
      },
      policyContext(root),
    );
    assert.equal(verdict.effect, 'deny');
    assert.equal(verdict.code, 'path_outside');
  });

  await check('a page the worker read cannot drive a write or a request', async () => {
    const root = await folder('policy-web');
    const write = evaluate(
      { action: 'write_file', args: { path: 'page.html' } },
      policyContext(root, { provenance: 'web' }),
    );
    assert.equal(write.effect, 'deny');
    const request = evaluate(
      { action: 'http_request', args: { url: 'http://localhost:3000/api' } },
      policyContext(root, { provenance: 'web' }),
    );
    assert.equal(request.effect, 'deny', 'http_request is not a read-only escape hatch');
    const read = evaluate({ action: 'read_file', args: { path: 'a.ts' } }, policyContext(root, { provenance: 'web' }));
    assert.equal(read.effect, 'allow', 'reading after a web result is the whole point');
  });

  await check('an exhausted mission budget stops the next tool call', async () => {
    const root = await folder('policy-budget');
    const verdict = evaluate(
      { action: 'read_file', args: { path: 'a.ts' } },
      policyContext(root, { spend: { missionTokens: 5_000, budget: 5_000 } }),
    );
    assert.equal(verdict.effect, 'deny');
    assert.match(verdict.hint, /budget/i);
  });

  await check('the board still moves when file tools are switched off', async () => {
    const root = await folder('policy-office');
    for (const action of ['move_to', 'set_status', 'add_note', 'create_task', 'complete_task']) {
      const verdict = evaluate({ action, args: {} }, policyContext(root, { toolsEnabled: false }));
      assert.equal(verdict.effect, 'allow', `${action} should not need file access`);
    }
    const write = evaluate({ action: 'write_file', args: { path: 'a.ts' } }, policyContext(root, { toolsEnabled: false }));
    assert.equal(write.effect, 'deny');
  });

  await check('publishing needs a human, and a sixth process is refused', async () => {
    const root = await folder('policy-actions');
    const push = evaluate({ action: 'run_command', args: { command: 'git push origin main' } }, policyContext(root));
    assert.equal(push.effect, 'review');
    const spawn = evaluate({ action: 'start_process', args: { command: 'npm run dev' } }, policyContext(root, { running: 5 }));
    assert.equal(spawn.effect, 'deny');
  });
}

// ── redaction ───────────────────────────────────────────────────────────────

async function redactionChecks() {
  say('redaction');

  await check('a key-shaped assignment never reaches the model', () => {
    const observation = 'Ran the tests. OPENAI_API_KEY=sk-live-abcdef123456 failed with 401.';
    const redacted = redactSecrets(observation);
    assert.equal(redacted.includes('sk-live-abcdef123456'), false, redacted);
    assert.match(redacted, /OPENAI_API_KEY=\[redacted/);
    assert.equal(containsSecret(observation), true);
    assert.equal(containsSecret(redacted), false);
  });

  await check('ordinary prose and code are left alone', () => {
    const text = 'The token budget is 12000 and the function readTokens() returns a count.';
    assert.equal(redactSecrets(text), text);
  });
}

// ── runner ──────────────────────────────────────────────────────────────────

sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'aegisx-toolkit-'));
try {
  await patchChecks();
  await codeMapChecks();
  await taskGraphChecks();
  await dispatcherChecks();
  await policyChecks();
  await redactionChecks();
} finally {
  await fs.rm(sandbox, { recursive: true, force: true });
}

const failed = results.filter((entry) => !entry.ok);
console.log(`\n[toolkit] ${results.length - failed.length}/${results.length} checks passed.`);
if (failed.length > 0) {
  console.log(`Failed: ${failed.map((entry) => entry.label).join(' · ')}`);
  process.exitCode = 1;
}
