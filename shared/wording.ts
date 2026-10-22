/**
 * The English the server writes, in the operator's language.
 *
 * The activity log is a diagnostic: `scripts/*-check.mjs` match on its exact
 * wording, and a line stays useful in a bug report. So the server keeps writing
 * English and this module does not touch it. Instead every line is recognised
 * here, by the `kind` it was filed under plus the shape of its arguments, and
 * redrawn through the dictionary when the browser is in Indonesian.
 *
 * Each template therefore has two jobs: it must describe a line the server
 * really emits, and its English column must be that line verbatim. A template
 * that drifts simply stops matching, and the operator sees the untranslated
 * English — never a mangled sentence — while `scripts/wording-check.mjs` fails.
 */
import { t, type MessageKey } from './i18n.ts';
import type { LogEntry } from './types.ts';

interface Template {
  /** Dictionary row holding both languages. */
  key: MessageKey;
  /** The English line, with `{name}` where the server interpolates. */
  text: string;
  /** A value per placeholder, so a check can rebuild a matching line. */
  sample: Record<string, string>;
}

const PLACEHOLDER = /\{(\w+)\}/g;

/**
 * Log lines the office passes through untranslated.
 * `session.model` carries a provider's own note about the model it picked.
 */
export const RAW_LOG_KINDS: readonly string[] = ['session.model'];

/**
 * Templates per log `kind`. Order matters where one line is a special case of
 * another: `… · reply` is more specific than `… · {actions}`.
 */
const LOG_TEMPLATES: Record<string, readonly Template[]> = {
  'session.connect_failed': [
    {
      key: 'log.session.connectFailed',
      text: 'Could not connect to {endpoint}: {detail}',
      sample: { endpoint: 'https://ai.example.com/v1', detail: 'HTTP 401' },
    },
  ],
  'session.demo': [
    {
      key: 'log.session.demoBoot',
      text: 'Demo mode is on — workers reply with scripted lines, no model calls.',
      sample: {},
    },
    { key: 'log.session.demoOn', text: 'Demo mode enabled.', sample: {} },
    { key: 'log.session.demoOff', text: 'Demo mode disabled.', sample: {} },
  ],
  'session.connected': [
    {
      key: 'log.session.connected',
      text: 'Connected to {endpoint} ({count} models).',
      sample: { endpoint: 'https://ai.example.com/v1', count: '7' },
    },
  ],
  'session.failed': [
    {
      key: 'log.session.failed',
      text: 'Connection failed: {detail}',
      sample: { detail: 'HTTP 401' },
    },
  ],
  'workspace.changed': [
    {
      key: 'log.workspace.changed',
      text: 'Workspace folder set to {path}.',
      sample: { path: '/home/operator/project' },
    },
  ],
  'agent.created': [
    { key: 'log.agent.joined', text: '{name} joined the office.', sample: { name: 'Nadia' } },
  ],
  'agent.step': [
    {
      key: 'log.agent.stepReply',
      text: '{name} · step {step} · reply',
      sample: { name: 'Aria', step: '2' },
    },
    {
      key: 'log.agent.step',
      text: '{name} · step {step} · {actions}',
      sample: { name: 'Aria', step: '2', actions: 'read_file, write_file' },
    },
  ],
  'agent.action': [
    {
      key: 'log.agent.action',
      text: '{name} → {action}: {summary}',
      sample: { name: 'Aria', action: 'write_file', summary: 'Wrote index.html' },
    },
  ],
  'agent.remedy': [
    {
      key: 'log.agent.remedy',
      text: "{name}'s command was refused — ran {tool} instead.",
      sample: { name: 'Aria', tool: 'http_check' },
    },
  ],
  'agent.loop': [
    {
      key: 'log.agent.loop',
      text: '{name} repeated {action} — asking for a new approach.',
      sample: { name: 'Aria', action: 'read_file' },
    },
  ],
  'agent.error': [
    {
      key: 'log.agent.error',
      text: '{name} hit an error: {detail}',
      sample: { name: 'Aria', detail: 'socket hang up' },
    },
  ],
  'agent.tools_unsupported': [
    {
      key: 'log.agent.toolsUnsupported',
      text: 'This endpoint does not support native tool calls — using the JSON action protocol.',
      sample: {},
    },
  ],
  'chat.user': [
    { key: 'log.chat.received', text: '{name} received a message.', sample: { name: 'Aria' } },
  ],
  'task.created': [
    {
      key: 'log.task.added',
      text: 'Task "{title}" added to the board.',
      sample: { title: 'Ship the landing page' },
    },
    {
      key: 'log.task.createdAssigned',
      text: 'New task "{title}" → {assignee}.',
      sample: { title: 'Ship the landing page', assignee: 'Aria' },
    },
    {
      key: 'log.task.created',
      text: 'New task "{title}".',
      sample: { title: 'Ship the landing page' },
    },
  ],
  'task.queued': [
    {
      key: 'log.task.queued',
      text: '{name} is busy — "{title}" is queued (position {position}).',
      sample: { name: 'Aria', title: 'Ship the landing page', position: '2' },
    },
  ],
  'task.started': [
    {
      key: 'log.task.started',
      text: '{name} started "{title}".',
      sample: { name: 'Aria', title: 'Ship the landing page' },
    },
  ],
  'task.pack': [
    {
      key: 'log.task.packOperator',
      text: '{name} runs "{title}" under the {pack} playbook: the operator chose it.',
      sample: { name: 'Aria', title: 'Ship the landing page', pack: 'frontend' },
    },
    {
      key: 'log.task.packRole',
      text: '{name} runs "{title}" under the {pack} playbook: the job title chose it.',
      sample: { name: 'Aria', title: 'Ship the landing page', pack: 'frontend' },
    },
    {
      key: 'log.task.packBrief',
      text: '{name} runs "{title}" under the {pack} playbook: the brief points there ({evidence}).',
      sample: { name: 'Aria', title: 'Ship the landing page', pack: 'frontend', evidence: 'site/index.html' },
    },
    {
      key: 'log.task.packBriefTie',
      text: '{name} runs "{title}" under the {pack} playbook: the brief points there ({evidence}); {also} also fits.',
      sample: { name: 'Aria', title: 'Ship the landing page', pack: 'frontend', evidence: 'button', also: 'qa' },
    },
    {
      key: 'log.task.packDefault',
      text: '{name} runs "{title}" under the {pack} playbook: no signal matched, so it falls back to the general pack.',
      sample: { name: 'Aria', title: 'Rename the constant', pack: 'general' },
    },
  ],
  'task.reviewed': [
    {
      key: 'log.task.reviewed',
      text: "Reviewer accepted {name}'s change.",
      sample: { name: 'Aria' },
    },
  ],
  'task.review': [
    {
      key: 'log.task.reviewUnreadable',
      text: "The reviewer's reply could not be read — the checks stand, so the task continues.",
      sample: {},
    },
    {
      key: 'log.task.reviewCapped',
      text: "Reviewer still refuses {name}'s change after {attempt} attempt(s) — accepting with a note.",
      sample: { name: 'Aria', attempt: '1' },
    },
    {
      key: 'log.task.reviewRefused',
      text: "Reviewer refused {name}'s change — sending it back (attempt {attempt}/{total}).",
      sample: { name: 'Aria', attempt: '1', total: '1' },
    },
    {
      key: 'log.task.reviewFailed',
      text: 'The reviewer could not run ({reason}) — the checks stand.',
      sample: { reason: 'timed out' },
    },
  ],
  'task.vision': [
    {
      key: 'log.task.visionSkipped',
      text: 'Skipped the visual critic: {source} is not an image.',
      sample: { source: 'notes.md' },
    },
    {
      key: 'log.task.visionAccepted',
      text: 'Visual critic accepted {source}.',
      sample: { source: '.agent-office/preview.png' },
    },
    {
      key: 'log.task.visionUnreadable',
      text: 'The visual critic replied in a shape that could not be read — the checks stand.',
      sample: {},
    },
    {
      key: 'log.task.visionCapped',
      text: 'Visual critic still refuses {source} after {attempt} attempt(s) — accepting with a note.',
      sample: { source: '.agent-office/preview.png', attempt: '1' },
    },
    {
      key: 'log.task.visionRefused',
      text: 'Visual critic refused {source} — sending it back (attempt {attempt}/{total}).',
      sample: { source: '.agent-office/preview.png', attempt: '1', total: '1' },
    },
    {
      key: 'log.task.visionFailed',
      text: 'The visual critic could not run ({reason}) — the checks stand.',
      sample: { reason: 'timed out' },
    },
  ],
  'agent.output': [
    {
      key: 'log.agent.outputShape',
      text: 'Tool result shape: {details}.',
      sample: { details: 'summary must be a non-empty string' },
    },
  ],
  'agent.contract': [
    {
      key: 'log.agent.contract',
      text: 'Tool result contract: {details}.',
      sample: { details: 'read_file reported success but `detail` is empty' },
    },
  ],
  'task.merge': [
    {
      key: 'log.task.mergeChanged',
      text: "{name}'s verified files changed before it could finish — checking again.",
      sample: { name: 'Aria' },
    },
  ],
  'task.worktree': [
    {
      key: 'log.task.worktreeStarted',
      text: '"{title}" works in its own copy of the folder; its changes land when the checks pass.',
      sample: { title: 'Ship the landing page' },
    },
  ],
  'task.shared_folder': [
    {
      key: 'log.task.sharedFolder',
      text: 'No separate copy of the folder: {reason}. Tasks share it as before.',
      sample: { reason: 'the repository root is /home/me/mono' },
    },
  ],
  'task.landed': [
    {
      key: 'log.task.landed',
      text: 'Work landed in the folder: {files}.',
      sample: { files: 'app.ts, -old.txt' },
    },
  ],
  'task.waiting': [
    {
      key: 'log.task.waiting',
      text: '"{title}" waits for {blockers}.',
      sample: { title: 'Ship the client', blockers: 'task_ab12cd34' },
    },
  ],
  'task.ready': [
    {
      key: 'log.task.ready',
      text: '"{title}" is ready — {name} starts now.',
      sample: { title: 'Ship the client', name: 'Aria' },
    },
    {
      key: 'log.task.readyUnassigned',
      text: '"{title}" is ready — unassigned.',
      sample: { title: 'Ship the client' },
    },
  ],
  'task.resumed': [
    {
      key: 'log.task.resumed',
      text: 'Picking up the queued task "{title}".',
      sample: { title: 'Ship the landing page' },
    },
  ],
  'task.interrupted': [
    {
      key: 'log.task.interrupted',
      text: '{count} task(s) were interrupted by a restart — they are blocked and their notes are kept.',
      sample: { count: '2' },
    },
  ],
  'task.budget': [
    {
      key: 'log.task.budget',
      text: 'Mission budget reached ({spent}/{budget} tokens) — stopping for a human.',
      sample: { spent: '1020', budget: '1020' },
    },
  ],
  'task.nudged': [
    {
      key: 'log.task.nudged',
      text: '{name} stopped without finishing — asked it to complete the task or hand it off.',
      sample: { name: 'Aria' },
    },
  ],
  'task.loop': [
    {
      key: 'log.task.loop',
      text: '{name} stopped after repeating {action} — the turn hit a loop.',
      sample: { name: 'Aria', action: 'read_file' },
    },
  ],
  'task.blocked': [
    {
      key: 'log.task.blocked',
      text: '{name} could not finish the task — it is blocked ({reason}).',
      sample: { name: 'Aria', reason: 'no_progress' },
    },
  ],
  'task.done': [
    {
      key: 'log.task.done',
      text: '{name} finished "{title}".',
      sample: { name: 'Aria', title: 'Ship the landing page' },
    },
  ],
  'task.checkpoint': [
    {
      key: 'log.task.checkpoint',
      text: 'Checkpoint {ref} taken before "{title}".',
      sample: { ref: '4f2a9c1e', title: 'Ship the landing page' },
    },
    {
      key: 'log.task.checkpointSkipped',
      text: 'No checkpoint: {detail}.',
      sample: { detail: 'git is not installed' },
    },
  ],
  'task.evidence': [
    {
      key: 'log.task.evidence',
      text: '{name} reported done without changing anything — asking for evidence.',
      sample: { name: 'Aria' },
    },
  ],
  'task.verified': [
    { key: 'log.task.verified', text: 'Checks passed: {names}.', sample: { names: 'test, build' } },
    {
      key: 'log.task.accepted',
      text: 'Nothing to check in this folder — accepted.',
      sample: {},
    },
  ],
  'task.unverified': [
    {
      key: 'log.task.unverified',
      text: '{name} finished, but checks still fail after {count} repair attempt(s).',
      sample: { name: 'Aria', count: '2' },
    },
  ],
  'task.reopened': [
    {
      key: 'log.task.reopened',
      text: '{name} said the task was done, but a check failed — sending it back (attempt {attempt}/{total}).',
      sample: { name: 'Aria', attempt: '1', total: '2' },
    },
  ],
  'task.diff': [
    {
      key: 'log.task.diff',
      text: "{name}'s changes — {detail}",
      sample: { name: 'Aria', detail: '2 files changed, 40 insertions(+)' },
    },
  ],
  'task.cleanup': [
    {
      key: 'log.task.cleanup',
      text: '{name} finished with {count} scratch file(s) still in the folder — sent back to delete them.',
      sample: { name: 'Aria', count: '2' },
    },
    {
      key: 'log.task.cleanupAccepted',
      text: '{name} left {count} scratch file(s) behind — recorded in the task notes.',
      sample: { name: 'Aria', count: '2' },
    },
  ],
  'task.reverted': [
    {
      key: 'log.task.reverted',
      text: '{name} reverted this turn — the folder is back to its state at turn start.',
      sample: { name: 'Aria' },
    },
    {
      key: 'log.task.revertFailed',
      text: '{name} could not revert this turn: {detail}',
      sample: { name: 'Aria', detail: 'no checkpoint' },
    },
    {
      key: 'log.task.restoreFailed',
      text: 'Could not restore the last verified state: {detail}',
      sample: { detail: 'no checkpoint' },
    },
    {
      key: 'log.task.regressed',
      text: '{name} broke {files} — restored the folder to the last verified state.',
      sample: { name: 'Aria', files: 'test' },
    },
  ],
  'task.revert_skipped': [
    {
      key: 'log.task.revertSkipped',
      text: 'A teammate is writing in this folder — repairing on the current tree instead of reverting.',
      sample: {},
    },
  ],
  'snapshot.failed': [
    {
      key: 'log.snapshot.failed',
      text: 'No per-turn undo: {detail}.',
      sample: { detail: 'git is not installed' },
    },
  ],
  'project.memory': [
    {
      key: 'log.memory.saved',
      text: 'Remembered {count} fact(s) about this folder for the next mission.',
      sample: { count: '2' },
    },
    {
      key: 'log.memory.failed',
      text: 'Could not save project memory: {detail}',
      sample: { detail: 'disk is full' },
    },
  ],
  'mission.started': [
    {
      key: 'log.mission.started',
      text: 'Mission "{title}" handed to {lead} ({role}) — the team works in parallel.',
      sample: { title: 'Ship an app', lead: 'Nadia', role: 'Tech Lead' },
    },
  ],
  'mission.waiting': [
    {
      key: 'log.mission.waiting',
      text: '{name} is waiting on {count} teammate(s) before reconciling.',
      sample: { name: 'Nadia', count: '2' },
    },
  ],
  'mission.synthesis': [
    {
      key: 'log.mission.synthesis',
      text: 'All {count} subtask(s) settled — the lead is reconciling the result.',
      sample: { count: '3' },
    },
  ],
  'model.retry': [
    {
      key: 'log.model.retry',
      text: 'The endpoint failed ({detail}) — retrying this step once.',
      sample: { detail: 'HTTP 503' },
    },
  ],
  'model.fallback': [
    {
      key: 'log.model.fallback',
      text: 'Model "{model}" failed ({detail}) — falling back to {fallback}.',
      sample: { model: 'pro-model', detail: 'out of credit', fallback: 'free-model' },
    },
  ],
  'model.active': [
    {
      key: 'log.model.active',
      text: 'Now running on the free model {model}.',
      sample: { model: 'free-model' },
    },
  ],
};

/** Notes the office writes itself, in the order they are tried. */
const NOTE_TEMPLATES: readonly Template[] = [
  { key: 'note.restart', text: 'The office restarted while this task was running, so nothing is working on it now. Start it again to continue from these notes.', sample: {} },
  { key: 'note.evidenceGate', text: 'The gate asked for evidence: no file changed and the folder has no check.', sample: {} },
  {
    key: 'note.checkpointDiff',
    text: 'Changes since checkpoint {ref}:\n{summary}',
    sample: { ref: '4f2a9c1e', summary: '1 file changed, 3 insertions(+)' },
  },
  {
    key: 'note.cleanup',
    text: 'The gate asked for cleanup: these scratch files were still in the folder: {files}',
    sample: { files: 'probe-http.js, qa-run.txt' },
  },
  {
    key: 'note.cleanupAccepted',
    text: 'Leftover scratch files were accepted after {attempts} cleanup request(s): {files}',
    sample: { attempts: '2', files: 'probe-http.js' },
  },
];

const matchers = new Map<string, RegExp>();

function matcherFor(text: string): RegExp {
  const cached = matchers.get(text);
  if (cached) return cached;
  const source = text
    .split(/(\{\w+\})/)
    .map((part) =>
      /^\{\w+\}$/.test(part) ? '([\\s\\S]+?)' : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
    )
    .join('');
  const matcher = new RegExp(`^${source}$`);
  matchers.set(text, matcher);
  return matcher;
}

/** Names of the placeholders in a template, in the order they are captured. */
function namesIn(text: string): string[] {
  return [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1] as string);
}

/** The values behind a line, or `null` when the line is a different shape. */
function paramsOf(template: Template, line: string): Record<string, string> | null {
  const groups = matcherFor(template.text).exec(line);
  if (!groups) return null;
  const params: Record<string, string> = {};
  const names = namesIn(template.text);
  for (const [index, name] of names.entries()) {
    const value = groups[index + 1];
    if (value === undefined) return null;
    params[name] = value;
  }
  return params;
}

/**
 * A log line in the active language. An unrecognised line is returned exactly
 * as the server wrote it: the log is still the record, translation is a view.
 */
export function logText(entry: Pick<LogEntry, 'kind' | 'message'>): string {
  const templates = LOG_TEMPLATES[entry.kind] ?? [];
  for (const template of templates) {
    const params = paramsOf(template, entry.message);
    if (params) return t(template.key, params);
  }
  return entry.message;
}

/**
 * A task note in the active language. A note an agent wrote is its own words,
 * so it is passed through untouched.
 */
export function noteText(note: string): string {
  for (const template of NOTE_TEMPLATES) {
    const params = paramsOf(template, note);
    if (params) return t(template.key, params);
  }
  return note;
}

/** The tables themselves, for the check that keeps them honest. */
export function logTemplates(): { kind: string; templates: readonly Template[] }[] {
  return Object.entries(LOG_TEMPLATES).map(([kind, templates]) => ({ kind, templates }));
}

export function noteTemplates(): readonly Template[] {
  return NOTE_TEMPLATES;
}

/** One line a template is supposed to match, built from its own sample values. */
export function sampleLine(template: Template): string {
  return template.text.replace(PLACEHOLDER, (match, name: string) => template.sample[name] ?? match);
}

export type { Template as WordingTemplate };
