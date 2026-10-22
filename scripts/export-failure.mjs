/**
 * A failed mission, turned into something the eval suite can hold onto.
 *
 * A post-mortem in a chat does not stop a regression. This writes the failing
 * task — its brief, its notes, the trace around it, and the ledger's verdict —
 * into `evals/failures/` as one JSON file plus a readable markdown summary. The
 * next step is a human one on purpose: writing the `accept` check that would
 * have caught it, because only that check can fail again when the bug returns.
 *
 *   npm run failure:export                 # newest blocked task
 *   npm run failure:export -- --task <id>   # a specific one
 *   npm run failure:export -- --list        # what is on the board
 *   npm run failure:export -- --state <f>   # another office state file
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { FAILURE_NEXT_STEPS, isFailureReason, summariseFailures } from '../shared/failures.ts';
import { messages } from '../shared/i18n.ts';
import { OFFICE_STATE_FILE } from '../server/src/config.ts';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const OUT_DIR = path.join(REPO_ROOT, 'evals', 'failures');

/** A readable, sortable file name: the date first, then the task title. */
export function failureSlug(title, at = Date.now()) {
  const date = new Date(at).toISOString().slice(0, 10);
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return `${date}-${slug.length > 0 ? slug : 'mission'}`;
}

/** Reads the persisted office, tolerating both the envelope and a bare state. */
export async function readOfficeState(statePath = OFFICE_STATE_FILE) {
  const raw = await fs.readFile(statePath, 'utf8');
  const parsed = JSON.parse(raw);
  const state = parsed && typeof parsed === 'object' && 'state' in parsed ? parsed.state : parsed;
  if (!state || !Array.isArray(state.tasks) || !Array.isArray(state.logs)) {
    throw new Error(`${statePath} is not an office state file`);
  }
  return state;
}

/** The log lines that explain one task: its own, plus the worker's around it. */
function traceFor(state, task) {
  const windowStart = task.createdAt - 5_000;
  return state.logs
    .filter((entry) => entry.at >= windowStart)
    .filter(
      (entry) =>
        entry.agentId === task.assigneeId ||
        entry.kind.startsWith('task.') ||
        entry.kind.startsWith('mission.') ||
        entry.kind === 'model.fallback' ||
        entry.kind === 'model.retry' ||
        entry.kind === 'agent.remedy',
    )
    .slice(-120)
    .map((entry) => ({
      at: new Date(entry.at).toISOString(),
      level: entry.level,
      kind: entry.kind,
      message: entry.message,
    }));
}

/**
 * Picks the task to export: an explicit id, else the newest blocked task that
 * carries a reason. A blocked task without a reason predates the ledger, and
 * exporting it would teach the eval suite nothing about the cause.
 */
export function pickTask(state, taskId) {
  if (taskId) {
    const task = state.tasks.find((entry) => entry.id === taskId);
    if (!task) throw new Error(`No task with id "${taskId}" in the state file.`);
    return task;
  }
  const blocked = state.tasks
    .filter((task) => task.status === 'blocked' && isFailureReason(task.failureReason))
    .sort((left, right) => right.updatedAt - left.updatedAt);
  if (blocked.length === 0) {
    throw new Error('No blocked task with a failure reason — nothing to export yet.');
  }
  return blocked[0];
}

/** Builds the exported document. Pure, so the check can pin its shape. */
export function buildFailureRecord(state, task) {
  const agent = state.agents.find((entry) => entry.id === task.assigneeId) ?? null;
  const reason = isFailureReason(task.failureReason) ? task.failureReason : null;
  const nextStepKey = reason ? FAILURE_NEXT_STEPS[reason] : null;
  return {
    schema: 'aegisx.failure/1',
    exportedAt: new Date().toISOString(),
    task: {
      id: task.id,
      title: task.title,
      detail: task.detail,
      status: task.status,
      priority: task.priority,
      failureReason: reason,
      notes: task.notes,
      createdAt: new Date(task.createdAt).toISOString(),
      updatedAt: new Date(task.updatedAt).toISOString(),
      usage: task.usage ?? null,
    },
    agent: agent ? { name: agent.name, role: agent.role, model: agent.model } : null,
    /** What to do next, in English — this file is read by whoever writes the check. */
    nextStep: nextStepKey ? messages()[nextStepKey].en : null,
    /** The board at the moment of export, so one case can be read in context. */
    board: summariseFailures(state.tasks),
    trace: traceFor(state, task),
  };
}

/** A short markdown version, so the failure can be read without a JSON viewer. */
export function renderFailureMarkdown(record) {
  const lines = [
    `# ${record.task.title}`,
    '',
    `- **Exported:** ${record.exportedAt}`,
    `- **Task:** \`${record.task.id}\` (${record.task.status}, ${record.task.priority})`,
    `- **Cause:** \`${record.task.failureReason ?? 'unknown'}\``,
    record.agent ? `- **Worker:** ${record.agent.name} (${record.agent.role}, ${record.agent.model})` : '',
    record.nextStep ? `- **Next step:** ${record.nextStep}` : '',
    '',
    '## Brief',
    '',
    '```text',
    record.task.detail.trim() || '(no detail)',
    '```',
    '',
    '## Notes the worker left',
    '',
    ...(record.task.notes.length > 0 ? record.task.notes.map((note) => `- ${note}`) : ['- (none)']),
    '',
    `## Trace (${record.trace.length} line${record.trace.length === 1 ? '' : 's'})`,
    '',
    ...record.trace.map((entry) => `- \`${entry.at}\` **${entry.kind}**: ${entry.message}`),
    '',
    '## Make it a regression',
    '',
    '1. Copy the brief into a fixture folder under `evals/tasks.mjs`, with the files the worker started from.',
    '2. Write the `accept` check that fails on this outcome — read the artefact, do not trust the summary.',
    '3. Run `npm run check:eval` (scripted model) before `npm run eval` (real model).',
    '',
  ];
  return `${lines.filter((line) => line !== '').join('\n')}\n`;
}

/** Writes both artefacts and returns their paths. */
export async function exportFailure({ statePath = OFFICE_STATE_FILE, outDir = OUT_DIR, taskId } = {}) {
  const state = await readOfficeState(statePath);
  const task = pickTask(state, taskId);
  const record = buildFailureRecord(state, task);
  await fs.mkdir(outDir, { recursive: true });

  const base = failureSlug(task.title, task.updatedAt || Date.now());
  let candidate = base;
  for (let suffix = 2; suffix < 100; suffix += 1) {
    const exists = await fs
      .access(path.join(outDir, `${candidate}.json`))
      .then(() => true)
      .catch(() => false);
    if (!exists) break;
    candidate = `${base}-${suffix}`;
  }

  const jsonPath = path.join(outDir, `${candidate}.json`);
  const mdPath = path.join(outDir, `${candidate}.md`);
  await fs.writeFile(jsonPath, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  await fs.writeFile(mdPath, renderFailureMarkdown(record), 'utf8');
  return { jsonPath, mdPath, record };
}

/** Every exported case, newest first. */
export async function listFailures(outDir = OUT_DIR) {
  const entries = await fs.readdir(outDir).catch(() => []);
  const files = entries.filter((name) => name.endsWith('.json')).sort().reverse();
  const cases = [];
  for (const file of files) {
    const record = JSON.parse(await fs.readFile(path.join(outDir, file), 'utf8'));
    cases.push({
      file,
      title: record.task?.title ?? '(untitled)',
      cause: record.task?.failureReason ?? 'unknown',
      exportedAt: record.exportedAt ?? '',
    });
  }
  return cases;
}

async function main() {
  const args = process.argv.slice(2);
  const stateIndex = args.indexOf('--state');
  const taskIndex = args.indexOf('--task');
  const statePath = stateIndex >= 0 ? args[stateIndex + 1] : OFFICE_STATE_FILE;

  if (args.includes('--list')) {
    const cases = await listFailures();
    if (cases.length === 0) {
      console.log('[failure] no exported cases yet — run `npm run failure:export` after a mission blocks.');
      return;
    }
    for (const entry of cases) {
      console.log(`${entry.exportedAt.slice(0, 10)}  ${entry.cause.padEnd(18)} ${entry.title}  (${entry.file})`);
    }
    return;
  }

  try {
    const { jsonPath, mdPath, record } = await exportFailure({
      statePath,
      taskId: taskIndex >= 0 ? args[taskIndex + 1] : undefined,
    });
    console.log(`[failure] ${record.task.title}`);
    console.log(`  cause: ${record.task.failureReason ?? 'unknown'}`);
    console.log(`  wrote: ${path.relative(REPO_ROOT, jsonPath)}`);
    console.log(`  wrote: ${path.relative(REPO_ROOT, mdPath)}`);
  } catch (error) {
    console.error(`[failure] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
