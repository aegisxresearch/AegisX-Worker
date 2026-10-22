/**
 * Shell ergonomics: a worker writes `echo x > f`, `npm test 2>&1 | tail -40`,
 * `a && b` because that is how a shell works. The sandbox now parses that
 * grammar itself and runs it with argv arrays — no `sh -c` — so this check pins
 * both halves of that deal:
 *
 *   1. the shell idioms a worker actually writes do run,
 *   2. nothing escapes the workspace, and a refusal names the tool to use.
 *
 *   npm run check:shell
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { parseShell, runShell, validateShell } from '../server/src/shell.ts';
import { buildToolSchemas } from '../server/src/toolSchemas.ts';
import { executeAction } from '../server/src/tools.ts';

const results = [];

async function check(label, run) {
  try {
    await run();
    results.push({ label, ok: true });
    console.log(`  ✓ ${label}`);
  } catch (error) {
    results.push({ label, ok: false });
    console.log(`  ✗ ${label}\n      ${error instanceof Error ? error.message : String(error)}`);
  }
}

const handlers = {
  moveTo: () => 'moved',
  setStatus: () => 'status',
  completeTask: () => 'done',
  addNote: () => 'note',
  createTask: () => 'task',
};

const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'aegisx-shell-'));
await fs.writeFile(path.join(workspace, 'alpha.txt'), 'a\nb\nc\n', 'utf8');
await fs.writeFile(path.join(workspace, 'beta.txt'), 'd\n', 'utf8');
await fs.writeFile(path.join(workspace, 'gamma.txt'), 'e\n', 'utf8');

const context = {
  agentId: 'agent_shell',
  agentName: 'Shell',
  taskId: null,
  toolsEnabled: true,
  webEnabled: false,
  workspaceRoot: workspace,
};

const exists = (target) =>
  fs
    .access(target)
    .then(() => true)
    .catch(() => false);

const run = async (command, extra = {}) =>
  executeAction({ action: 'run_command', command, ...extra }, context, handlers);

console.log('\n[shell] the grammar parses without a shell');

await check('a redirect, a pipe and a chain parse into statements', () => {
  const parsed = parseShell('echo hi > out.txt && cat out.txt | grep h');
  assert.equal(parsed.ok, true, parsed.message);
  assert.equal(parsed.parsed.statements.length, 2);
  assert.equal(parsed.parsed.statements[0].connector, 'start');
  assert.equal(parsed.parsed.statements[1].connector, '&&');
  assert.equal(parsed.parsed.statements[1].commands.length, 2);
  assert.deepEqual(parsed.parsed.statements[1].commands[1].argv, ['grep', 'h']);
});

await check('quotes keep their spaces and operators as words', () => {
  const parsed = parseShell(`sed 's/a b/c d/' alpha.txt`);
  assert.equal(parsed.ok, true, parsed.message);
  assert.deepEqual(parsed.parsed.statements[0].commands[0].argv, ['sed', 's/a b/c d/', 'alpha.txt']);
});

console.log('\n[shell] idioms a worker writes');

await check('echo ... > file writes the file', async () => {
  const result = await run('echo hello > out.txt');
  assert.equal(result.ok, true, result.detail);
  assert.equal(await fs.readFile(path.join(workspace, 'out.txt'), 'utf8'), 'hello\n');
});

await check('>> appends instead of truncating', async () => {
  const result = await run('echo again >> out.txt');
  assert.equal(result.ok, true, result.detail);
  assert.equal(await fs.readFile(path.join(workspace, 'out.txt'), 'utf8'), 'hello\nagain\n');
});

await check('> /dev/null stays silent and creates no file', async () => {
  const result = await run('echo quiet > /dev/null');
  assert.equal(result.ok, true, result.detail);
  assert.equal(await exists(path.join(workspace, 'null')), false);
});

await check('a real pipeline runs each stage', async () => {
  const result = await run('cat out.txt | grep again');
  assert.equal(result.ok, true, result.detail);
  assert.equal((result.detail ?? '').trim(), 'again');
});

await check('three stages chain', async () => {
  const result = await run('cat alpha.txt | grep b | wc -l');
  assert.equal(result.ok, true, result.detail);
  assert.equal((result.detail ?? '').trim(), '1');
});

await check('2>&1 folds stderr into the output', async () => {
  const result = await run('cat missing.txt 2>&1');
  assert.equal(result.ok, false);
  assert.match(result.detail ?? '', /missing\.txt/);
});

await check('2> writes stderr to a file', async () => {
  const result = await run('cat missing.txt 2> err.log');
  assert.equal(result.ok, false);
  assert.match(await fs.readFile(path.join(workspace, 'err.log'), 'utf8'), /missing\.txt/);
});

await check('input can come from a file', async () => {
  const result = await run('wc -l < alpha.txt');
  assert.equal(result.ok, true, result.detail);
  assert.equal((result.detail ?? '').trim(), '3');
});

await check('&& skips the second command after a failure', async () => {
  const result = await run('false && echo nope');
  assert.equal(result.ok, false);
  assert.equal((result.detail ?? '').includes('nope'), false);
});

await check('|| runs the fallback after a failure', async () => {
  const result = await run('cat missing.txt || echo fallback');
  assert.equal(result.ok, true, result.detail);
  assert.match(result.detail ?? '', /fallback/);
});

await check('; runs both commands', async () => {
  const result = await run('false ; echo done');
  assert.equal(result.ok, true, result.detail);
  assert.match(result.detail ?? '', /done/);
});

await check('a no-match grep is a result, not an error', async () => {
  const result = await run('grep zzz alpha.txt');
  assert.equal(result.ok, true, result.detail);
});

await check('max_lines keeps the first lines and says how many it hid', async () => {
  const result = await run('cat alpha.txt', { max_lines: 2 });
  assert.equal(result.ok, true, result.detail);
  const lines = (result.detail ?? '').trimEnd().split('\n');
  assert.deepEqual(lines.slice(0, 2), ['a', 'b']);
  assert.match(lines[2] ?? '', /1 more line/);
});

console.log('\n[shell] what still does not run, and what it says');

await check('a redirect outside the workspace is refused', async () => {
  const outside = path.join(path.dirname(workspace), `escaped-${Date.now()}.txt`);
  const result = await run(`echo bad > ${outside}`);
  assert.equal(result.ok, false);
  assert.match(result.summary, /outside the workspace/i);
  assert.equal(await exists(outside), false);
});

await check('a ".." hop is refused', async () => {
  const result = await run('cat ../../etc/passwd');
  assert.equal(result.ok, false);
  assert.match(result.summary, /\.\./);
});

await check('curl names http_check and hands back the call to run', async () => {
  const result = await run('curl -s http://127.0.0.1:3000/');
  assert.equal(result.ok, false);
  assert.match(result.summary, /http_check/);
  assert.equal(result.remedy?.tool, 'http_check');
  assert.equal(result.remedy?.args.url, 'http://127.0.0.1:3000/');
  assert.ok(result.nextActions.includes('http_check'), JSON.stringify(result.nextActions));
});

await check('a mutating remedy is offered but never run automatically', async () => {
  const result = await run('rm alpha.txt');
  assert.equal(result.ok, false);
  assert.equal(result.remedy?.tool, 'delete_file');
  assert.equal(result.remedy?.args.path, 'alpha.txt');
  assert.equal(await exists(path.join(workspace, 'alpha.txt')), true, 'nothing may be deleted for the worker');
});

await check('rm names delete_file', async () => {
  const result = await run('rm alpha.txt');
  assert.equal(result.ok, false);
  assert.match(result.summary, /delete_file/);
  assert.equal(await exists(path.join(workspace, 'alpha.txt')), true);
});

await check('command substitution says to run it separately', async () => {
  const result = await run('echo $(date)');
  assert.equal(result.ok, false);
  assert.match(result.summary, /command/i);
});

await check('an allowlisted command passes validation', async () => {
  const parsed = parseShell('cat alpha.txt');
  assert.equal(parsed.ok, true);
  const problem = validateShell(parsed.parsed, workspace);
  assert.equal(problem, null);
});

console.log('\n[shell] through the dispatcher and the schema');

await check('a failing command reports the exit code and the last step', async () => {
  const result = await run('cat missing.txt');
  assert.equal(result.ok, false);
  assert.match(result.summary, /exited 1/);
  assert.match(result.summary, /cat missing\.txt/);
  assert.deepEqual(result.nextActions, ['run_command', 'read_file', 'edit_file']);
});

await check('a redirect that succeeds suggests reading the file back', async () => {
  const result = await run('echo done > done.txt');
  assert.equal(result.ok, true, result.detail);
  assert.ok(result.nextActions.includes('read_file'), JSON.stringify(result.nextActions));
});

await check('the schema advertises the shell grammar', () => {
  const schema = buildToolSchemas({ files: true, web: false }).find(
    (tool) => tool.function.name === 'run_command',
  );
  assert.ok(schema, 'run_command schema missing');
  assert.ok(
    Object.hasOwn(schema.function.parameters.properties, 'max_lines'),
    JSON.stringify(schema.function.parameters.properties),
  );
  assert.match(schema.function.description, /Pipes/);
  assert.match(schema.function.description, /sh -c/);
});

await check('shell quoting cannot smuggle a second command', async () => {
  const outcome = await runShell('echo "hi; cat /etc/passwd"', { cwd: workspace });
  assert.equal(outcome.ok, true, outcome.output);
  assert.equal(outcome.output, 'hi; cat /etc/passwd');
});

await fs.rm(workspace, { recursive: true, force: true });

const passed = results.filter((entry) => entry.ok).length;
console.log(`\n[shell] ${passed}/${results.length} checks passed.`);
if (passed !== results.length) {
  console.log(`Failed: ${results.filter((entry) => !entry.ok).map((entry) => entry.label).join(' · ')}`);
  process.exit(1);
}
