/**
 * Two workers, one folder.
 *
 * The failure this prevents is silent: both writes succeed, one edit vanishes.
 * The checks here hold the lock directly and then drive the real tool entry
 * point with two concurrent calls.
 *
 *   node --experimental-strip-types scripts/concurrency-check.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { acquireFolder, acquirePaths, holderOf, otherWriterActive, releasePaths, resetLocks } from '../server/src/fileLocks.ts';
import { resetReadTracker } from '../server/src/readTracker.ts';
import { executeAction } from '../server/src/tools.ts';

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

const handlers = {
  moveTo: () => 'moved',
  setStatus: () => 'status',
  completeTask: () => 'done',
  addNote: () => 'noted',
  createTask: () => 'created',
};

function context(root, agentId) {
  return {
    agentId,
    agentName: agentId,
    taskId: null,
    toolsEnabled: true,
    webEnabled: false,
    workspaceRoot: root,
  };
}

sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'aegisx-locks-'));

console.log('\n[concurrency] the lock itself');

await check('a second worker is refused and told who holds the file', async () => {
  const root = path.join(sandbox, 'unit');
  await fs.mkdir(root, { recursive: true });
  const first = acquirePaths(root, ['app.ts'], 'agent_a');
  assert.equal(first.ok, true);
  assert.equal(holderOf(root, 'app.ts'), 'agent_a');

  const second = acquirePaths(root, ['app.ts'], 'agent_b');
  assert.equal(second.ok, false);
  assert.equal(second.conflict.owner, 'agent_a');
  assert.equal(second.conflict.path, 'app.ts');

  releasePaths(first.keys, 'agent_b');
  assert.equal(holderOf(root, 'app.ts'), 'agent_a', 'a worker cannot release a lock it does not own');

  releasePaths(first.keys, 'agent_a');
  assert.equal(holderOf(root, 'app.ts'), null);
  assert.equal(acquirePaths(root, ['app.ts'], 'agent_b').ok, true);
  resetLocks();
});

await check('acquiring two files is all-or-nothing', async () => {
  const root = path.join(sandbox, 'all-or-nothing');
  await fs.mkdir(root, { recursive: true });
  acquirePaths(root, ['second.ts'], 'agent_a');
  const attempt = acquirePaths(root, ['first.ts', 'second.ts'], 'agent_b');
  assert.equal(attempt.ok, false);
  assert.equal(holderOf(root, 'first.ts'), null, 'the free file must not stay locked after a partial failure');
  assert.equal(otherWriterActive('agent_b'), true);
  assert.equal(otherWriterActive('agent_a'), false, 'the holder does not block itself');
  resetLocks();
});


console.log('\n[concurrency] lost updates and commands');

await check('a write based on a stale read is refused until the file is re-read', async () => {
  const root = path.join(sandbox, 'stale');
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(path.join(root, 'app.ts'), 'export const who = "original";\n', 'utf8');

  const read = await executeAction({ action: 'read_file', path: 'app.ts' }, context(root, 'agent_a'), handlers);
  assert.equal(read.ok, true, read.summary);

  // Another worker changes the file after A read it.
  const other = await executeAction(
    { action: 'write_file', path: 'app.ts', content: 'export const who = "agent_b";\n' },
    context(root, 'agent_b'),
    handlers,
  );
  assert.equal(other.ok, true, other.summary);

  const stale = await executeAction(
    { action: 'write_file', path: 'app.ts', content: 'export const who = "agent_a";\n' },
    context(root, 'agent_a'),
    handlers,
  );
  assert.equal(stale.ok, false, 'the stale write must not land');
  assert.equal(stale.code, 'stale_read');
  assert.match(stale.summary, /app\.ts/);
  assert.match(await fs.readFile(path.join(root, 'app.ts'), 'utf8'), /agent_b/);

  // Re-reading makes the same write legitimate.
  await executeAction({ action: 'read_file', path: 'app.ts' }, context(root, 'agent_a'), handlers);
  const fresh = await executeAction(
    { action: 'write_file', path: 'app.ts', content: 'export const who = "agent_a";\n' },
    context(root, 'agent_a'),
    handlers,
  );
  assert.equal(fresh.ok, true, fresh.summary);
});

await check('a patch refuses a file that changed after it was read', async () => {
  const root = path.join(sandbox, 'stale-patch');
  await fs.mkdir(root, { recursive: true });
  const target = path.join(root, 'usage.ts');
  await fs.writeFile(target, 'const a = 1;\n', 'utf8');
  await executeAction({ action: 'read_file', path: 'usage.ts' }, context(root, 'agent_a'), handlers);
  await fs.writeFile(target, 'const a = 2;\n', 'utf8');

  const result = await executeAction(
    { action: 'apply_patch', patch: ['--- a/usage.ts', '+++ b/usage.ts', '@@ -1 +1 @@', '-const a = 1;', '+const a = 3;'].join('\n') },
    context(root, 'agent_a'),
    handlers,
  );
  assert.equal(result.ok, false);
  assert.equal(result.code, 'stale_read');
  assert.equal(await fs.readFile(target, 'utf8'), 'const a = 2;\n');
});

await check('a running command and a file write cannot overlap', async () => {
  const root = path.join(sandbox, 'scope');
  await fs.mkdir(root, { recursive: true });
  const folder = acquireFolder(root, 'agent_b');
  assert.equal(folder.ok, true);
  const blockedWrite = await executeAction(
    { action: 'write_file', path: 'x.ts', content: 'x\n' },
    context(root, 'agent_a'),
    handlers,
  );
  assert.equal(blockedWrite.ok, false);
  assert.equal(blockedWrite.code, 'path_locked');
  releasePaths(folder.keys, 'agent_b');

  const held = acquirePaths(root, ['x.ts'], 'agent_b');
  const blockedCommand = await executeAction({ action: 'run_command', command: 'node -e "process.exit(0)"' }, context(root, 'agent_a'), handlers);
  assert.equal(blockedCommand.ok, false);
  assert.equal(blockedCommand.code, 'path_locked');
  releasePaths(held.keys, 'agent_b');

  const allowed = await executeAction({ action: 'run_command', command: 'node -e "process.exit(0)"' }, context(root, 'agent_a'), handlers);
  assert.equal(allowed.ok, true, allowed.summary);
});

console.log('\n[concurrency] through the real tool entry point');

await check('two concurrent writes cannot both land', async () => {
  const root = path.join(sandbox, 'race');
  await fs.mkdir(root, { recursive: true });
  const [first, second] = await Promise.all([
    executeAction({ action: 'write_file', path: 'shared.ts', content: 'export const who = "first";\n' }, context(root, 'agent_a'), handlers),
    executeAction({ action: 'write_file', path: 'shared.ts', content: 'export const who = "second";\n' }, context(root, 'agent_b'), handlers),
  ]);

  const outcomes = [first, second];
  assert.equal(outcomes.filter((entry) => entry.ok).length, 1, `both writes reported success: ${JSON.stringify(outcomes)}`);
  const refused = outcomes.find((entry) => !entry.ok);
  assert.equal(refused.code, 'path_locked');
  assert.match(refused.summary, /another worker/i);

  const content = await fs.readFile(path.join(root, 'shared.ts'), 'utf8');
  assert.match(content, /who = "(first|second)"/);
});

await check('the lock is released when the call ends, success or failure', async () => {
  const root = path.join(sandbox, 'release');
  await fs.mkdir(root, { recursive: true });
  const failed = await executeAction({ action: 'edit_file', path: 'missing.ts', search: 'a', replacement: 'b' }, context(root, 'agent_a'), handlers);
  assert.equal(failed.ok, false);
  assert.equal(holderOf(root, 'missing.ts'), null);

  const written = await executeAction({ action: 'write_file', path: 'later.ts', content: 'ok\n' }, context(root, 'agent_b'), handlers);
  assert.equal(written.ok, true);
  assert.equal(holderOf(root, 'later.ts'), null);
});

await check('a patch refuses while any file it touches is held', async () => {
  const root = path.join(sandbox, 'patch-lock');
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(path.join(root, 'locked.ts'), 'const a = 1;\n', 'utf8');
  const held = acquirePaths(root, ['locked.ts'], 'agent_b');
  assert.equal(held.ok, true);

  const result = await executeAction(
    {
      action: 'apply_patch',
      patch: ['--- a/locked.ts', '+++ b/locked.ts', '@@ -1 +1 @@', '-const a = 1;', '+const a = 2;'].join('\n'),
    },
    context(root, 'agent_a'),
    handlers,
  );
  assert.equal(result.ok, false);
  assert.equal(result.code, 'path_locked');
  assert.equal(await fs.readFile(path.join(root, 'locked.ts'), 'utf8'), 'const a = 1;\n');
  releasePaths(held.keys, 'agent_b');
});

await check('different files do not block each other', async () => {
  const root = path.join(sandbox, 'parallel');
  await fs.mkdir(root, { recursive: true });
  const [left, right] = await Promise.all([
    executeAction({ action: 'write_file', path: 'left.ts', content: 'left\n' }, context(root, 'agent_a'), handlers),
    executeAction({ action: 'write_file', path: 'right.ts', content: 'right\n' }, context(root, 'agent_b'), handlers),
  ]);
  assert.equal(left.ok && right.ok, true, `${left.summary} / ${right.summary}`);
});

const failed = results.filter((entry) => !entry.ok);
console.log(`\n[concurrency] ${results.length - failed.length}/${results.length} checks passed.`);
if (failed.length > 0) {
  console.log(`Failed: ${failed.map((entry) => entry.label).join(' · ')}`);
  process.exitCode = 1;
}

resetLocks();
resetReadTracker();
await fs.rm(sandbox, { recursive: true, force: true });
