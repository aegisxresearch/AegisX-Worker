import type { Locale } from '../../shared/i18n.ts';
import type {
  AgentProfile,
  ChatMessage,
  OfficeStation,
  Task,
  TaskPriority,
  FailureReason,
} from '../../shared/types.ts';
import {
  ACTION_TOKEN_BUDGET,
  FREE_MODEL,
  GIT_CHECKPOINT_ENABLED,
  MAX_ACTION_ROUNDS,
  MISSION_TOKEN_BUDGET,
  REPEAT_ACTION_LIMIT,
  STATE_DIR,
  VERIFY_ATTEMPTS,
  VERIFY_ENABLED,
  WORKTREE_ISOLATION,
} from './config.ts';
import { createCheckpoint, summariseChanges, type Checkpoint } from './git.ts';
import type { EventBus } from './events.ts';
import {
  chat,
  isModelUnavailableError,
  isToolSupportError,
  isTransientModelError,
  listModels,
  streamChat,
  type LlmMessage,
  type LlmSettings,
  type LlmToolCall,
  type LlmUsage,
} from './llm.ts';
import { readProjectMemory, recordProjectMemory, renderProjectMemory } from './projectMemory.ts';
import {
  buildPackBrief,
  doctrineBrief,
  packLogLine,
  resolvePackChoice,
  resolvePackFor,
  resolveRolePack,
} from './rolePacks.ts';
import { describeScratch, findScratchFiles } from './scratch.ts';
import { diffSnapshots, revertToSnapshot, takeSnapshot, type Snapshot } from './snapshots.ts';
import { OfficeStore } from './store.ts';
import { buildToolSchemas } from './toolSchemas.ts';
import { executeAction, readStringList, type ActionResult } from './tools.ts';
import { otherWriterActive } from './fileLocks.ts';
import { forgetRead, ownerKey } from './readTracker.ts';
import { affectedPaths } from './policy.ts';
import { listProcesses } from './processes.ts';
import { phaseAfterAction, type ToolPhase } from './router.ts';
import { readyTasks, unresolvedDependencies } from './taskGraph.ts';
import { reviewWork } from './reviewer.ts';
import type { Provenance } from './policy.ts';
import fs from 'node:fs/promises';
import path from 'node:path';
import { critiqueImage } from './visionCritic.ts';
import { buildObservation } from './outputGuard.ts';
import { MergeQueue, changedPaths, hashPaths } from './mergeQueue.ts';
import {
  changedInWorktree,
  collectStaleCheckouts,
  createIsolatedWorktree,
  discardWorktree,
  landWorktree,
  refreshAfterConflict,
  worktreeDiff,
  type IsolatedWorktree,
} from './worktrees.ts';
import {
  captureVerificationPlan,
  describeVerificationFailure,
  runVerificationPlan,
  type VerificationPlan,
} from './verify.ts';

function addUsage(left: LlmUsage, right: LlmUsage): LlmUsage {
  return {
    promptTokens: left.promptTokens + right.promptTokens,
    completionTokens: left.completionTokens + right.completionTokens,
    totalTokens: left.totalTokens + right.totalTokens,
  };
}

/** Every tool name, for checking what a result tells the model to do next. */
const KNOWN_TOOLS = new Set(buildToolSchemas({ files: true, web: true }).map((tool) => tool.function.name));

/** Three refusals before accepting with a note: enough to fix real problems, short enough not to loop. */
const REVIEW_ATTEMPTS = 3;
/** One visual refusal per task, same reasoning as the code reviewer. */
const VISION_ATTEMPTS = 3;

// No name and no role in this line on purpose. The first characters of the
// prompt are the ones a provider can cache for every worker at once, and
// "You are Aria, a Frontend Engineer" made that prefix different per agent.
// The identity moves to the per-worker section further down.
const SYSTEM_PROMPT = `You are one worker in a 3D virtual office, part of a small AI team that builds and ships real work.
Your words are short — you are working, not writing an essay. Stay under 70 words unless a tool result needs summarising.

Work by calling the tools you are given. Each tool call runs for real: file tools read and write
inside the workspace folder, run_command runs one shell command, web_search and web_fetch reach
the public web. The tool result comes back as JSON with status, summary, next_actions and artifacts.

Rules:
- Call complete_task only when the work is actually finished, and put the result in its summary.
- Read a file before you edit it, and never invent file contents.
- Prefer apply_patch for multi-line edits: it applies every hunk or refuses the whole patch.
  search_symbol and find_references find a definition and its call sites; run_check runs the
  folder's own check and reports failures as file:line.
- Scratch files you create to check something (probe-*, qa-*, verify-*, tmp-*, out.txt, *.log,
  *.pid, *.bak) must be deleted before complete_task. The gate refuses the task while they are in
  the folder. Only the deliverables and the tests you were asked for stay.
- Delegate to a colleague with create_task when the work belongs to another role.
- Every tool result tells you what to do next; follow it.
- When a tool is unavailable, say so in one line instead of guessing.

If the endpoint has no tool support, act by ending your reply with exactly one JSON object on its own line:
{"action":"move_to","station":"meeting"}
{"action":"set_status","status":"blocked","reason":"waiting for API access"}
{"action":"complete_task","summary":"what you did and the result"}
{"action":"add_note","text":"a durable note for the task"}
{"action":"create_task","title":"...","detail":"...","priority":"medium","assignee":"Name of a colleague"}
{"action":"speak","text":"short line for the speech bubble"}
{"action":"read_file","path":"notes.md"}
{"action":"write_file","path":"report.md","content":"..."}
{"action":"run_command","command":"ls -la"}

Sandbox notes:
- run_command understands the usual shell punctuation: pipes (|), redirects (> >> <, 2>, 2>&1,
  &>), and && / || / ;. So "echo hi > out.txt", "npm test 2>&1 | tail -40" and
  "npm run build && node check.mjs" all run as written. Prefer write_file and edit_file for
  source edits — they show the diff — and use a redirect only for logs and scratch output.
- It is not a full shell: no $VAR expansion, no $(...), no globbing, no background &. Need a
  variable's value? Read it with printenv. Need a file list? Use ls or find and read the output.
- Only allowlisted binaries run (ls, cat, grep, sed, awk, node, npm, git, python3, sort, diff,
  mkdir, cp, mv, ...). If one is refused, the error names the tool that replaces it — curl is
  http_check, rm is delete_file. Follow it instead of retrying a variant.
- Redirect target files must be inside the workspace folder; paths with ".." or absolute paths
  outside it are refused.
- Commands run in a sandbox: the workspace is writable and the rest of the disk is not, and
  run_command has no network. A task that must install packages needs OFFICE_JAIL_NET=1 — say so
  once instead of retrying the download. start_process keeps the network, because a server listens.
- A server, watcher or anything that does not exit belongs in start_process, never run_command:
  run_command waits for exit and times out. start_process takes one plain command (no pipes or
  redirects) because it already writes the output to its own log. Check it with port_status,
  read it with process_logs, and stop it with stop_process when you only started it to run a check.
- File paths are relative to the workspace folder (for example notes/report.md).
- A command that finds nothing exits with code 1; that is a normal result, not an error.
- Prefer writing the deliverable with write_file over shelling out.

Checking a web page — use the tools, not a search for a browser:
- "Renders correctly" means: the server returns it (HTTP 200), every asset it references loads, and
  the HTML has the elements and copy the task asked for. That is evidence; a browser binary is not.
- Call http_check with the served URL. One call reports the page status, whether the text you
  expect is on it, and the status of every same-origin script, stylesheet and image. A missing
  asset shows up as a failure; do not guess from a status line alone.
- Call preview_screenshot to see the page rendered, then read_media on the PNG to actually look at
  it. Both locate the browser themselves — do not run which/ls/find looking for chrome.
- Start the server once, check it with http_check, and leave it running. curl is not in the sandbox allowlist
  (run_command refuses it and names http_check); http_check and node are. Only fall back to node -e
  with fetch when http_check cannot reach the server, and then report what it said.`;

/**
 * Appended to a mission brief. The lead plans and delegates on the first pass,
 * then reconciles what the team produced on the second.
 */
const LEAD_BRIEF = `You are leading this mission for the team.

Pass 1 — plan and delegate. Do not build the deliverable yourself. Split the work into at most 4
independent subtasks and hand each one to the specialist whose role fits best (frontend, backend,
mobile app, AI, ML, QA, security, data, devops, product) using create_task. Give each subtask the
exact files it owns so two workers never write the same file. Then say in one line how you split it.

Pass 2 — you are re-run with the team's results. Read what they actually produced, fix or reconcile
anything that conflicts or is missing, then call complete_task with a summary listing the files and
which checks passed. Never claim work the folder does not contain.`;

/** What the lead sees when the last subtask settles. */
function synthesisBrief(children: Task[]): string {
  const lines = ['The team has reported. Results:', ''];
  for (const child of children) {
    const tail = child.notes.slice(-2).join(' | ').replace(/\s+/g, ' ').slice(0, 320);
    lines.push(`- ${child.title} — ${child.status}${tail.length > 0 ? `: ${tail}` : ''}`);
  }
  lines.push(
    '',
    'This is pass 2. The pass-1 instruction to split the work is already done — do not create more',
    'subtasks unless a specialist is genuinely missing. List the workspace, read what the team wrote,',
    'fix conflicts or gaps yourself, and finish with complete_task. Never start over.',
  );
  return lines.join('\n');
}

/**
 * Said once to a worker that stopped without finishing and without handing off.
 * One nudge inside the same conversation is far cheaper than a human reviving a
 * blocked task, and it is the common failure: a model that answers in prose.
 */
const NUDGE_BRIEF =
  'You stopped without finishing the task. Either call complete_task with what you delivered, or hand the work to a teammate with create_task if that is what the task needs. Do not reply in prose.';

/**
 * Said once when a completion in a folder with no checks changed nothing at all.
 * It is not proof the work is right — it only rules out "done" with no work.
 */
const EVIDENCE_BRIEF =
  'Nothing in the folder changed during this turn and the folder has no check for the gate to run. Either make the change the task asks for, or call add_note explaining why nothing needed to change, then finish again.';

/**
 * How the team writes, when the operator does not read English.
 *
 * A task note is not UI text: a colleague reads it on the next round and the
 * board outlives the tab it was opened in, so the language belongs to the work.
 * Only what a person reads is affected — code, paths and commands are named
 * exactly, because translating an identifier breaks it.
 */
const LANGUAGE_BRIEFS: Partial<Record<Locale, string>> = {
  id: [
    'Language: the operator reads Indonesian.',
    'Write every task note (add_note), every complete_task summary and every line you say to a person in Bahasa Indonesia.',
    'Keep file names, code, identifiers, shell commands, paths and commit messages exactly as they are — never translate them.',
    'This is about the words only: the work itself is unchanged.',
  ].join('\n'),
};

function languageBrief(locale: Locale): string {
  return LANGUAGE_BRIEFS[locale] ?? '';
}

export interface PromptContext {
  name: string;
  role: string;
  roster: string;
  workspace: string;
  locale: Locale;
  memory: string;
  /** A playbook the operator or the lead picked, overriding the role. */
  pack?: string | null;
  /** The task's own words, used to pick a pack when the role is generic. */
  brief?: string;
}

/**
 * One system message, static text first.
 *
 * The order is the point: providers cache on the prefix, so the block every
 * worker shares must be byte-identical between turns and rounds. That block is
 * now two pieces — the house rules and the team doctrine — and both are the
 * same text for every worker, which is what keeps them cacheable. The role
 * pack follows: stable for a worker (a role rarely changes mid-task), so it is
 * still a cache hit on the second round. Only then come the per-turn facts —
 * roster, folder, language, project memory — where a change costs tokens but
 * cannot invalidate the shared prefix.
 *
 * `scripts/prompt-check.mjs` holds the line on the size of each piece and on
 * the order: it builds the prompt for every seeded role and fails if the shared
 * prefix differs.
 */
export function buildSystemPrompt(context: PromptContext): string {
  // Resolved once: the same pack decides the brief and the label below, so the
  // prompt can never claim one bar and describe another.
  const pack = resolvePackFor({
    role: context.role,
    pack: context.pack,
    title: context.brief ?? '',
  });
  return [
    SYSTEM_PROMPT,
    doctrineBrief(),
    buildPackBrief(pack),
    `You are ${context.name}.`,
    `Office roster:\n${context.roster}`,
    `Workspace folder: ${context.workspace}`,
    languageBrief(context.locale),
    context.memory,
  ]
    .filter((section) => section.length > 0)
    .join('\n\n');
}

/** The pack this worker is running under, for the log line and the review. */
export function rolePackId(role: string): string {
  return resolveRolePack(role).id;
}

/**
 * The task's own words. A generic role has no craft of its own, so the brief is
 * the only thing that can say whether this job is a migration or a landing page.
 */
function taskBrief(task: Task | undefined): string {
  return task ? `${task.title}\n${task.detail}` : '';
}

/**
 * Tools the runtime may run on the worker's behalf when the sandbox refuses a
 * command. Read-only on purpose: an automatic repair may look, never mutate —
 * a refused `rm` still needs the model to ask for `delete_file` itself.
 */
const AUTO_REMEDIES = new Set(['http_check', 'port_status', 'preview_screenshot']);

/** Exported so a check can pin the boundary: reads may be repaired, writes may not. */
export function isAutoRemedy(tool: string): boolean {
  return AUTO_REMEDIES.has(tool);
}

/** Repairs per turn. Two covers a refused probe without becoming a second loop. */
const REMEDY_LIMIT = 2;

/**
 * How many times the gate sends a task back for leftover scratch files before
 * accepting it with a warning. Two is enough for a model that forgot once;
 * more would spend rounds on housekeeping instead of the work.
 */
const SCRATCH_ATTEMPTS = 2;

/** What to delete, in the words the scan actually enforces. */
const SCRATCH_BRIEF = (files: string): string =>
  `Scratch files are still in the folder: ${files}. Delete every file you created only to check something (probe-*, qa-*, tmp-*, verify-*, *.log, *.pid, *.bak, out.txt) with delete_file, then call complete_task again. Keep the deliverables and the tests the task asked for.`;

/** Recorded on a task that was mid-flight when the process stopped. */
const RESTART_NOTE =
  'The office restarted while this task was running, so nothing is working on it now. Start it again to continue from these notes.';

interface Observation {
  status: 'success' | 'warning' | 'error';
  summary: string;
  /** The payload the summary points at: file contents, check output, a file list. */
  detail?: string;
  next_actions: string[];
  artifacts: string[];
}

function parseAction(text: string): Record<string, unknown> | null {
  const candidates: string[] = [];
  const fenced = /```(?:json)?\s*([\s\S]*?)```/g;
  let match = fenced.exec(text);
  while (match !== null) {
    if (match[1]) candidates.push(match[1]);
    match = fenced.exec(text);
  }
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (line.startsWith('{') && line.endsWith('}')) candidates.push(line);
  }
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const candidate = candidates[index];
    if (!candidate) continue;
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (typeof parsed === 'object' && parsed !== null && typeof (parsed as { action?: unknown }).action === 'string') {
        return parsed as Record<string, unknown>;
      }
    } catch {
      /* not a valid action payload */
    }
  }
  return null;
}

function stripAction(text: string): string {
  const action = parseAction(text);
  if (!action) return text.trim();
  const actionBlock = JSON.stringify(action);
  return text.replace(actionBlock, '').replace(/```(?:json)?/g, '').trim();
}

/** Turns a native tool call into the flat action shape the tool layer expects. */
function toolCallToAction(call: LlmToolCall): { action: string; args: Record<string, unknown> } {
  let args: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(call.arguments);
    if (typeof parsed === 'object' && parsed !== null) {
      args = parsed as Record<string, unknown>;
    }
  } catch {
    args = {};
  }
  return { action: call.name, args };
}

const DEMO_REPLIES: Record<string, string[]> = {
  'Frontend Engineer': [
    'Picked up the layout fix. I am reproducing the overflow at 1280px first, then I will patch the grid and re-run the visual check.',
    'Rendered the hero section and it holds up now. I will push the revised spacing tokens to the shared stylesheet.',
  ],
  'Backend Engineer': [
    'On it. I am tracing the slow query in the request path and will add the missing index once I confirm the plan.',
    'The endpoint is patched. I added request-level logging and the p95 dropped in the local run.',
  ],
  'QA Engineer': [
    'Writing the regression test for the reported case, then I will run the full suite and report the result.',
    'I reproduced the bug and attached the failing spec. Handing the fix back to the owning engineer.',
  ],
  'Data Engineer': [
    'Running the migration on a copy of the dataset first to check the row counts before touching production.',
    'The pipeline output looks consistent. I have scheduled the job and added an alert on row drift.',
  ],
  'Product Manager': [
    'Noted. I will write the acceptance criteria so the engineers have a clear contract to build against.',
    'I triaged the backlog and split the request into a shippable slice and a follow-up.',
  ],
  'DevOps Engineer': [
    'Checking the deploy pipeline now. I will verify the health probe before promoting the build.',
    'The pipeline is green and the release is staged. I am watching the error rate for the next few minutes.',
  ],
};

function demoReply(agent: AgentProfile, kind: 'chat' | 'task'): string {
  const options = DEMO_REPLIES[agent.role] ?? ['Working on it now. I will report back with the result.'];
  const index = Math.floor(Math.random() * options.length);
  const base = options[index] ?? options[0] ?? 'Working on it.';
  if (kind === 'chat') {
    return `${base} (demo mode — connect an API key to run this for real.)`;
  }
  return base;
}

/**
 * Drives one agent: streams the model, executes office actions and tools, and
 * keeps the activity log and the 3D scene in sync.
 */
/**
 * What the next tool call is based on.
 *
 * A page or a file the worker just read is evidence, not an instruction. The
 * policy layer refuses writes that follow a web read, so a prompt injection in
 * a README or a search result cannot turn into a commit.
 */
function provenanceAfter(action: string): Provenance {
  if (action === 'web_search' || action === 'web_fetch' || action === 'http_request') return 'web';
  if (
    action === 'read_file' ||
    action === 'read_media' ||
    action === 'list_directory' ||
    action === 'search_files' ||
    action === 'search_symbol' ||
    action === 'find_references'
  ) {
    return 'file';
  }
  return 'user';
}

export class AgentRuntime {
  readonly #store: OfficeStore;
  readonly #bus: EventBus;
  readonly #busy = new Set<string>();
  /** Tasks waiting for a busy worker, drained in arrival order. */
  readonly #queues = new Map<string, string[]>();
  /** Endpoints that rejected the `tools` payload once stay in JSON mode. */
  readonly #toolLessEndpoints = new Set<string>();
  /** Checks captured before a task starts; the gate only ever runs those. */
  readonly #verificationPlans = new Map<string, VerificationPlan>();
  /** Where each worker's current turn started, so `revert_turn` has a target. */
  readonly #turnSnapshots = new Map<string, Snapshot>();
  /** Whether this turn ran a command, per `agent:task`; evidence without checks. */
  readonly #commandEvidence = new Map<string, boolean>();
  /** Tasks already asked to show evidence; asked once, then accepted. */
  readonly #evidenceAsked = new Set<string>();
  /** Times the gate sent a task back to delete leftover scratch files. */
  readonly #scratchAsked = new Map<string, number>();
  /** The last tree whose checks all passed, and which checks those were. */
  #green: { snapshot: Snapshot; checks: Set<string> } | null = null;
  #snapshotWarned = false;
  /** Baseline commit per task, used for the closing change report. */
  readonly #checkpoints = new Map<string, Checkpoint>();
  /** How many times the gate has already reopened a task. */
  readonly #verifyAttempts = new Map<string, number>();
  /** Leads currently reconciling a finished team, so a storm cannot double-run it. */
  readonly #synthesising = new Set<string>();
  /** Reconciliation passes per mission, capped so a stuck lead cannot spin. */
  readonly #synthesisRuns = new Map<string, number>();
  /** The "this folder is already a repo" note is worth saying once, not per task. */
  #checkpointNoticeLogged = false;
  /** What the last observation was, so a web page cannot drive a write. */
  readonly #provenance = new Map<string, Provenance>();
  /** Which slice of the toolkit the worker is being shown right now. */
  readonly #phase = new Map<string, ToolPhase>();
  /** Reviewer refusals per task; capped so a disagreement cannot loop. */
  readonly #reviewAttempts = new Map<string, number>();
  /** The last image this worker actually looked at, per agent+task. */
  readonly #visuals = new Map<string, string>();
  /** Visual-critic refusals per task. */
  readonly #visionAttempts = new Map<string, number>();
  /** Completions are gated one at a time, so two merges cannot interleave. */
  readonly #mergeQueue = new MergeQueue();
  /** The checkout each running task works in, when the folder is a repository. */
  readonly #isolated = new Map<string, IsolatedWorktree>();
  /** One line per folder when isolation is unavailable, not one per task. */
  #isolationExplained = false;
  /**
   * Tasks whose landing was refused and not yet redone. A conflict cannot be
   * resolved by giving up: completing with nothing landed would report success
   * while the folder still holds someone else's version.
   */
  readonly #pendingLanding = new Set<string>();
  /** The checkout sweep runs once per process, before the first task starts. */
  #sweptCheckouts = false;
  /** Files each task wrote, so the merge gate knows what to re-check. */
  readonly #taskWrites = new Map<string, Set<string>>();
  /** Hashes of those files at verification time. */
  readonly #mergeBaseline = new Map<string, Map<string, string>>();

  constructor(store: OfficeStore, bus: EventBus) {
    this.#store = store;
    this.#bus = bus;
  }

  isBusy(agentId: string): boolean {
    return this.#busy.has(agentId);
  }

  /** Verifies the endpoint and key, then stores them for the session. */
  async connect(input: {
    endpoint: string;
    apiKey: string;
    model: string;
    toolsEnabled: boolean;
  }): Promise<{ ok: boolean; message: string; models: string[] }> {
    const settings: LlmSettings = {
      endpoint: input.endpoint.replace(/\/+$/, ''),
      apiKey: input.apiKey,
      model: input.model,
    };
    try {
      const models = await listModels(settings);
      let model = settings.model;
      let note = '';

      if (models.length > 0 && !models.includes(model)) {
        if (models.includes(FREE_MODEL)) {
          note = ` "${model}" is not exposed by this endpoint — using the free model ${FREE_MODEL}.`;
          model = FREE_MODEL;
        } else {
          note = ` "${model}" is not in the endpoint model list.`;
        }
      }

      this.#store.applyCredentials({ ...input, model, endpoint: settings.endpoint });
      this.#store.setAvailableModels(models);
      this.#store.publishSettings();
      this.#store.appendLog('success', 'session.connected', `Connected to ${settings.endpoint} (${models.length} models).`);
      if (note) this.#store.appendLog('warn', 'session.model', note.trim());
      return { ok: true, message: `Connected. The office is live.${note}`, models };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Connection failed';
      this.#store.appendLog('error', 'session.failed', `Connection failed: ${message}`);
      return { ok: false, message, models: [] };
    }
  }

  setDemoMode(enabled: boolean): void {
    this.#store.setDemoMode(enabled);
    this.#store.publishSettings();
    this.#store.appendLog('info', 'session.demo', enabled ? 'Demo mode enabled.' : 'Demo mode disabled.');
  }

  /**
   * Runs once at boot on a restored board. No model call survives a restart, so
   * a task that was `doing` is settled as blocked with a note — never left
   * looking like it is still being worked on.
   */
  recoverAfterRestart(): { interrupted: number } {
    const interrupted = [...this.#store.tasks.values()].filter((task) => task.status === 'doing');
    for (const task of interrupted) {
      this.#store.updateTask(task.id, {
        status: 'blocked',
        failureReason: 'restart',
        notes: [...task.notes, RESTART_NOTE],
      });
    }

    for (const agent of [...this.#store.agents.values()]) {
      if (agent.status !== 'working') continue;
      this.#store.updateAgent(agent.id, { status: 'idle', currentTaskId: null, taskSummary: null });
    }

    if (interrupted.length > 0) {
      this.#store.appendLog(
        'warn',
        'task.interrupted',
        `${interrupted.length} task(s) were interrupted by a restart — they are blocked and their notes are kept.`,
      );
    }
    return { interrupted: interrupted.length };
  }

  // ── public entry points ───────────────────────────────────────────────────

  async handleUserMessage(agentId: string, content: string): Promise<void> {
    const agent = this.#store.agents.get(agentId);
    if (!agent) return;
    const trimmed = content.trim();
    if (trimmed.length === 0) return;

    this.#store.appendChat({ role: 'user', agentId, taskId: null, content: trimmed, streaming: false });
    this.#store.appendLog('info', 'chat.user', `${agent.name} received a message.`, agentId);

    const history = this.#store.chats
      .filter((entry) => entry.agentId === agentId && !entry.streaming)
      .slice(-8)
      .map<LlmMessage>((entry) => ({
        role: entry.role === 'assistant' ? 'assistant' : 'user',
        content: entry.content,
      }));

    await this.#runTurn({
      agent,
      taskId: null,
      messages: [...history, { role: 'user', content: trimmed }],
      kind: 'chat',
    });
  }

  /**
   * Starts a mission: one prompt, one lead, several specialists. The lead
   * splits the work with create_task; the runtime re-runs it once every
   * subtask has settled, so the result is reconciled instead of just collected.
   */
  async startMission(input: {
    title: string;
    detail: string;
    priority: TaskPriority;
    leadId?: string | null;
  }): Promise<Task> {
    const roster = [...this.#store.agents.values()];
    const lead =
      (input.leadId ? roster.find((agent) => agent.id === input.leadId) : undefined) ??
      roster.find((agent) => agent.role.toLowerCase().includes('lead')) ??
      roster[0];
    if (!lead) throw new Error('The office has no workers.');

    const task = this.#store.createTask({
      title: input.title,
      detail: `${input.detail}\n\n${LEAD_BRIEF}`,
      priority: input.priority,
      assigneeId: lead.id,
      mission: true,
    });
    this.#store.appendLog(
      'info',
      'mission.started',
      `Mission "${task.title}" handed to ${lead.name} (${lead.role}) — the team works in parallel.`,
    );
    void this.runTask(lead.id, task.id);
    return task;
  }

  async runTask(agentId: string, taskId: string, extraBrief?: string): Promise<void> {
    const agent = this.#store.agents.get(agentId);
    const task = this.#store.tasks.get(taskId);
    if (!agent || !task) return;
    const blocking = unresolvedDependencies(task, this.#store.tasks);
    if (blocking.length > 0) {
      this.#store.updateTask(taskId, { status: 'todo', assigneeId: agentId });
      this.#store.appendLog(
        'info',
        'task.waiting',
        `"${task.title}" waits for ${blocking.join(', ')}.`,
        agentId,
      );
      return;
    }
    if (this.#busy.has(agentId)) {
      // A delegated task used to be dropped here. Queue it instead so the
      // worker picks it up the moment the current turn ends.
      const queue = this.#queues.get(agentId) ?? [];
      if (!queue.includes(taskId)) {
        queue.push(taskId);
        this.#queues.set(agentId, queue);
        this.#store.updateTask(taskId, { status: 'todo', assigneeId: agentId });
        this.#store.appendLog(
          'info',
          'task.queued',
          `${agent.name} is busy — "${task.title}" is queued (position ${queue.length}).`,
          agentId,
        );
      }
      return;
    }

    // The checkout comes first: the verification plan and every tool path are
    // read from the folder this task will actually work in.
    await this.#prepareIsolation(taskId, task.title);
    await this.#prepareTask(taskId, task.title);

    // The playbook is resolved once, when the task starts, and written to the
    // board: the prompt, the reviewer and the card then read the same field, so
    // the bar a change was judged against can never be re-derived differently.
    const choice = resolvePackChoice({
      role: agent.role,
      pack: task.pack,
      title: task.title,
      detail: task.detail,
    });
    if (task.activePack !== choice.pack.id || task.packSource !== choice.source) {
      this.#store.updateTask(taskId, { activePack: choice.pack.id, packSource: choice.source });
      this.#store.appendLog(
        'info',
        'task.pack',
        packLogLine(choice, agent.name, task.title),
        agentId,
      );
    }

    this.#store.updateTask(taskId, { status: 'doing', assigneeId: agentId });
    this.#store.updateAgent(agentId, {
      status: 'working',
      currentTaskId: taskId,
      taskSummary: task.title,
      station: 'desk',
    });
    this.#store.appendLog('info', 'task.started', `${agent.name} started "${task.title}".`, agentId);

    const brief = [
      `Task: ${task.title}`,
      `Priority: ${task.priority}`,
      task.detail ? `Details: ${task.detail}` : '',
      task.notes.length > 0 ? `Notes so far:\n${task.notes.map((note) => `- ${note}`).join('\n')}` : '',
      'Do the work, then either complete_task or hand off to a colleague.',
      extraBrief ?? '',
    ]
      .filter((line) => line.length > 0)
      .join('\n');

    await this.#runTurn({
      agent,
      taskId,
      messages: [{ role: 'user', content: brief }],
      kind: 'task',
    });
  }

  // ── internals ─────────────────────────────────────────────────────────────

  async #runTurn(params: {
    agent: AgentProfile;
    taskId: string | null;
    messages: LlmMessage[];
    kind: 'chat' | 'task';
  }): Promise<void> {
    const { agent, taskId, messages, kind } = params;
    // Every turn starts from the operator's brief, not from the last page read.
    this.#provenance.set(agent.id, 'user');
    this.#phase.set(agent.id, 'inspect');
    this.#busy.add(agent.id);
    const controller = new AbortController();
    const evidenceKey = `${agent.id}\u0000${taskId ?? ''}`;
    this.#commandEvidence.delete(evidenceKey);

    let totalUsage: LlmUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    /** Completed model round trips in this turn; the meter reports them. */
    let modelTurns = 0;

    // The tree this turn starts from: `revert_turn` and the regression guard
    // both restore exactly this state, not a best guess.
    await this.#snapshotTurnStart(agent, taskId);

    try {
      if (this.#store.settings.demoMode || !this.#store.apiKey) {
        await this.#runDemoTurn(agent, taskId, kind);
        return;
      }

      const chatMessage = this.#store.appendChat({
        role: 'assistant',
        agentId: agent.id,
        taskId,
        content: '',
        streaming: true,
      });

      // What earlier missions learned about this folder. Read fresh for every
      // turn: a teammate may have recorded a fact while this one was queued.
      const memoryBlock = renderProjectMemory(
        await readProjectMemory(this.#store.settings.workspaceRoot),
        // The brief, not the whole conversation: retrieval should answer "what
        // does this job need to know", not "what was said lately".
        messages[0]?.content ?? '',
      );
      const activeTask = taskId ? this.#store.tasks.get(taskId) : undefined;
      const workingMessages: LlmMessage[] = [
        {
          role: 'system',
          content: buildSystemPrompt({
            name: agent.name,
            role: agent.role,
            roster: this.#rosterText(),
            workspace: this.#rootFor(taskId),
            locale: this.#store.settings.locale,
            memory: memoryBlock,
            // The pack the task started under, handed over as an explicit
            // choice: re-inferring here could disagree with the board.
            pack: activeTask?.activePack ?? activeTask?.pack ?? null,
            brief: taskBrief(activeTask),
          }),
        },
        ...messages,
      ];

      let lastText = '';
      let nudged = false;
      let budgetSpent = true;
      let repeatedAction: string | null = null;
      let lastSignature = '';
      let repeatCount = 0;
      let steeredForRepeat = false;
      let remediesRun = 0;

      for (let round = 0; round < MAX_ACTION_ROUNDS; round += 1) {
        // Checked before the model is called, so a mission can never start a
        // round it is not allowed to pay for. The in-turn total is added because
        // usage is written to the store when the turn ends, not per round.
        if (kind === 'task' && taskId && MISSION_TOKEN_BUDGET > 0) {
          const spent = this.#store.missionTokensOf(taskId) + totalUsage.totalTokens;
          if (spent >= MISSION_TOKEN_BUDGET) {
            this.#blockTask(
              taskId,
              agent.id,
              'budget',
              `Mission budget reached: ${spent} of ${MISSION_TOKEN_BUDGET} tokens. Raise OFFICE_MISSION_TOKEN_BUDGET or split the work into a smaller task.`,
            );
            this.#store.appendLog(
              'warn',
              'task.budget',
              `Mission budget reached (${spent}/${MISSION_TOKEN_BUDGET} tokens) — stopping for a human.`,
              agent.id,
            );
            budgetSpent = false;
            break;
          }
        }

        const streamed = await this.#streamInto(chatMessage, workingMessages, controller.signal);
        lastText = streamed.text;
        totalUsage = addUsage(totalUsage, streamed.usage);
        modelTurns += 1;
        this.#logStep(agent, round + 1, streamed.usage, streamed.toolCalls.map((call) => call.name));

        if (streamed.toolCalls.length > 0) {
          const assistantTurn: LlmMessage = {
            role: 'assistant',
            content: lastText,
            toolCalls: streamed.toolCalls,
          };
          workingMessages.push(assistantTurn);

          let stop = false;
          for (const call of streamed.toolCalls) {
            const { action, args } = toolCallToAction(call);
            const result = await this.#executeWithGate(agent, taskId, { action, ...args });
            this.#publishAction(agent, action, result);

            workingMessages.push({
              role: 'tool',
              toolCallId: call.id,
              content: JSON.stringify(this.#observation(result, action)),
            });
            // An image the worker asked to see goes into the conversation as a
            // content part, not into the JSON observation: base64 there would
            // cost thousands of tokens and the model still could not see it.
            if (result.media) {
              workingMessages.push({
                role: 'user',
                content: `Attached: ${result.media.path}. Look at it, then act on what you actually see.`,
                images: [result.media.dataUrl],
              });
              if (taskId) this.#visuals.set(`${agent.id}\u0000${taskId}`, result.media.path);
            }
            // A screenshot the worker took but never opened is still evidence a
            // person would look at, so the critic may judge it.
            if (taskId && action === 'preview_screenshot' && result.ok) {
              const shot = result.artifacts?.[0];
              if (shot) this.#visuals.set(`${agent.id}\u0000${taskId}`, shot);
            }

            const repaired = await this.#attemptRemedy(agent, taskId, result, remediesRun);
            if (repaired) {
              remediesRun += 1;
              workingMessages.push({ role: 'user', content: repaired });
            }

            // Identical calls in a row will not change the world. Steer once,
            // then stop, so a turn cannot burn its whole budget on one loop.
            const signature = `${action}:${JSON.stringify(args)}`;
            repeatCount = signature === lastSignature ? repeatCount + 1 : 0;
            lastSignature = signature;
            if (repeatCount === REPEAT_ACTION_LIMIT && !steeredForRepeat) {
              steeredForRepeat = true;
              workingMessages.push({
                role: 'user',
                content: `You have called ${action} with the same arguments ${repeatCount + 1} times and the result will not change. Do something different, or finish with complete_task.`,
              });
              this.#store.appendLog('warn', 'agent.loop', `${agent.name} repeated ${action} — asking for a new approach.`, agent.id);
            }
            if (repeatCount > REPEAT_ACTION_LIMIT) {
              repeatedAction = action;
              stop = true;
              break;
            }
            if (!result.followUp) {
              budgetSpent = false;
              stop = true;
              break;
            }
          }
          if (stop) break;
          if (totalUsage.totalTokens >= ACTION_TOKEN_BUDGET) break;
          continue;
        }

        // Legacy path: the model answered with a JSON action block.
        const action = parseAction(lastText);
        if (!action) {
          // A worker that answers in prose has neither finished nor handed off.
          // Ask once, in the same conversation, before calling it blocked: the
          // nudge is one cheap call, a blocked task needs a human.
          if (
            !nudged &&
            kind === 'task' &&
            taskId &&
            this.#store.tasks.get(taskId)?.status === 'doing' &&
            this.#openChildren(taskId).length === 0
          ) {
            nudged = true;
            this.#store.appendLog(
              'info',
              'task.nudged',
              `${agent.name} stopped without finishing — asked it to complete the task or hand it off.`,
              agent.id,
            );
            workingMessages.push({ role: 'user', content: NUDGE_BRIEF });
            continue;
          }
          budgetSpent = false;
          break;
        }

        const result = await this.#executeWithGate(agent, taskId, action);
        this.#publishAction(agent, String(action.action ?? ''), result);

        if (!result.followUp) {
          budgetSpent = false;
          break;
        }

        workingMessages.push({ role: 'assistant', content: lastText });
        workingMessages.push({
          role: 'user',
          content: `Action result: ${result.ok ? 'OK' : 'FAILED'} — ${result.summary}${
            result.detail ? `\n${result.detail}` : ''
          }\nContinue, or finish with complete_task.`,
        });
        const repaired = await this.#attemptRemedy(agent, taskId, result, remediesRun);
        if (repaired) {
          remediesRun += 1;
          workingMessages.push({ role: 'user', content: repaired });
        }
        if (totalUsage.totalTokens >= ACTION_TOKEN_BUDGET) break;
      }

      if (repeatedAction) {
        this.#store.appendLog(
          'warn',
          'task.loop',
          `${agent.name} stopped after repeating ${repeatedAction} — the turn hit a loop.`,
          agent.id,
        );
      }

      // The budget ran out mid-task. Give the worker one closing turn so it can
      // report the outcome instead of leaving the board in limbo.
      if (
        budgetSpent &&
        repeatedAction === null &&
        kind === 'task' &&
        taskId &&
        this.#store.tasks.get(taskId)?.status === 'doing'
      ) {
        workingMessages.push({
          role: 'user',
          content:
            'Action budget spent. Stop exploring. Reply with one short line and exactly one action: complete_task with a summary of what you delivered (or add_note if something must be recorded first).',
        });
        const closing = await this.#streamInto(chatMessage, workingMessages, controller.signal);
        lastText = closing.text;
        totalUsage = addUsage(totalUsage, closing.usage);
        modelTurns += 1;
        this.#logStep(agent, modelTurns, closing.usage, closing.toolCalls.map((call) => call.name));
        const closingCall = closing.toolCalls[0];
        if (closingCall) {
          const { action, args } = toolCallToAction(closingCall);
          const result = await this.#executeWithGate(agent, taskId, { action, ...args });
          this.#publishAction(agent, action, result);
        } else {
          const closingAction = parseAction(lastText);
          if (closingAction) {
            const result = await this.#executeWithGate(agent, taskId, closingAction);
            this.#publishAction(agent, String(closingAction.action ?? ''), result);
          }
        }
      }

      const visible = stripAction(lastText);
      this.#store.patchChat(chatMessage.id, { content: visible, streaming: false });

      if (kind === 'task' && taskId && this.#store.tasks.get(taskId)?.status === 'doing') {
        const waiting = this.#openChildren(taskId);
        if (waiting.length > 0) {
          // A lead that handed the work over is not blocked — it is waiting for
          // the team, and the mission must stay alive until it reconciles.
          this.#store.updateAgent(agent.id, { status: 'idle', currentTaskId: null, taskSummary: null });
          this.#store.appendLog(
            'info',
            'mission.waiting',
            `${agent.name} is waiting on ${waiting.length} teammate(s) before reconciling.`,
            agent.id,
          );
        } else {
          // The agent neither completed nor handed off the task. A loop that had
          // to be broken is a different cause from a plain stop, and the board
          // needs to tell them apart.
          this.#blockTask(taskId, agent.id, repeatedAction ? 'tool_loop' : 'no_progress');
        }
      } else if (kind === 'task') {
        this.#store.updateAgent(agent.id, { status: 'idle', currentTaskId: null, taskSummary: null });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      this.#store.appendLog('error', 'agent.error', `${agent.name} hit an error: ${message}`, agent.id);
      this.#store.updateAgent(agent.id, { status: 'error' });
      this.#store.appendChat({
        role: 'assistant',
        agentId: agent.id,
        taskId,
        content: `I could not finish that: ${message}`,
        streaming: false,
      });

      // A failed turn must release the task. Leaving it in "doing" strands the
      // board and the operator cannot tell whether work is still running.
      if (kind === 'task' && taskId && this.#store.tasks.get(taskId)?.status === 'doing') {
        this.#blockTask(taskId, agent.id, 'model_error', `Blocked by an error: ${message}`);
      }
    } finally {
      // Billing happens here, not on the success path: a turn that throws after
      // two rounds still cost money, and a meter that hides that is lying.
      if (totalUsage.totalTokens > 0 || modelTurns > 0) {
        this.#store.recordUsage(agent.id, taskId, { ...totalUsage, turns: modelTurns });
      }
      this.#busy.delete(agent.id);
      if (kind === 'task' && taskId) {
        // Runs before the task is drained: a queued task on the same worker must
        // not start while the previous checkout is still registered.
        await this.#releaseIsolation(taskId);
        // The turn owns these; a finished task must not leave them behind.
        this.#verificationPlans.delete(taskId);
        this.#checkpoints.delete(taskId);
        this.#pendingLanding.delete(taskId);
        this.#verifyAttempts.delete(taskId);
        this.#scratchAsked.delete(taskId);
      }
      this.#drainQueue(agent.id);

      // A settled subtask may be the last one: let the lead reconcile.
      const parentId = kind === 'task' && taskId ? (this.#store.tasks.get(taskId)?.parentId ?? null) : null;
      if (parentId) void this.#maybeSynthesise(parentId);
    }
  }

  /**
   * Runs the tool a refusal pointed at, once, without waiting for the model.
   *
   * A worker that reaches for `curl` is asking a question the sandbox can
   * answer with `http_check`; making it spend a round to learn that is waste,
   * and on a cheap model it is often the round where the task stalls. Only
   * read-only tools are run here — a refused `rm` still needs the model to ask
   * for `delete_file` itself.
   */
  async #attemptRemedy(
    agent: AgentProfile,
    taskId: string | null,
    result: ActionResult,
    alreadyRun: number,
  ): Promise<string | null> {
    const remedy = result.remedy;
    if (!remedy || alreadyRun >= REMEDY_LIMIT) return null;
    if (!isAutoRemedy(remedy.tool)) return null;

    const repaired = await this.#executeWithGate(agent, taskId, {
      action: remedy.tool,
      ...remedy.args,
    });
    this.#publishAction(agent, remedy.tool, repaired);
    this.#store.appendLog(
      repaired.ok ? 'info' : 'warn',
      'agent.remedy',
      `${agent.name}'s command was refused — ran ${remedy.tool} instead.`,
      agent.id,
    );
    return [
      `The sandbox refused \`${remedy.refused}\`, so ${remedy.tool} was run for you.`,
      `Result: ${repaired.ok ? 'OK' : 'FAILED'} — ${repaired.summary}`,
      repaired.detail ? repaired.detail.slice(0, 2000) : '',
    ]
      .filter((line) => line.length > 0)
      .join('\n');
  }

  /**
   * The one way a task becomes blocked.
   *
   * Every failure path used to write `status: 'blocked'` itself, which is why the
   * board could say a task stopped but never why. Routing them through one
   * function is what makes the cause mandatory: the type requires a reason, and
   * `scripts/failure-check.mjs` refuses a second write path.
   */
  #blockTask(
    taskId: string,
    agentId: string | null,
    reason: FailureReason,
    note?: string,
  ): void {
    const task = this.#store.tasks.get(taskId);
    if (!task || task.status === 'done') return;
    this.#store.updateTask(taskId, {
      status: 'blocked',
      failureReason: reason,
      ...(note ? { notes: [...task.notes, note] } : {}),
    });
    const agent = agentId ? this.#store.agents.get(agentId) : undefined;
    if (agentId) {
      this.#store.updateAgent(agentId, {
        status: 'blocked',
        currentTaskId: null,
        taskSummary: null,
      });
    }
    this.#store.appendLog(
      'warn',
      'task.blocked',
      `${agent?.name ?? 'The office'} could not finish the task — it is blocked (${reason}).`,
      agentId,
    );
  }

  /** Subtasks a task handed to teammates. */
  #childrenOf(parentId: string): Task[] {
    return [...this.#store.tasks.values()].filter((task) => task.parentId === parentId);
  }

  #openChildren(parentId: string): Task[] {
    return this.#childrenOf(parentId).filter(
      (task) => task.status === 'todo' || task.status === 'doing',
    );
  }

  /**
   * Re-runs the lead once every subtask has settled, handing it the team's
   * results. Capped per mission and guarded against re-entry so a burst of
   * finishing subtasks cannot start several reconciliations at once.
   */
  async #maybeSynthesise(parentId: string): Promise<void> {
    const parent = this.#store.tasks.get(parentId);
    if (!parent || !parent.mission || !parent.assigneeId || parent.status === 'done') return;

    const children = this.#childrenOf(parentId);
    if (children.length === 0) return;
    if (children.some((child) => child.status === 'todo' || child.status === 'doing')) return;
    if (this.#synthesising.has(parentId)) return;

    const runs = this.#synthesisRuns.get(parentId) ?? 0;
    if (runs >= 3) return;

    this.#synthesising.add(parentId);
    this.#synthesisRuns.set(parentId, runs + 1);
    try {
      this.#store.appendLog(
        'info',
        'mission.synthesis',
        `All ${children.length} subtask(s) settled — the lead is reconciling the result.`,
      );
      await this.runTask(parent.assigneeId, parentId, synthesisBrief(children));
    } finally {
      this.#synthesising.delete(parentId);
    }

    // Out of reconciliation passes and still open: say so instead of leaving the
    // board waiting on a mission that will never finish.
    const after = this.#store.tasks.get(parentId);
    if (
      after &&
      runs + 1 >= 3 &&
      after.status !== 'done' &&
      after.status !== 'blocked' &&
      this.#openChildren(parentId).length === 0
    ) {
      this.#blockTask(
        parentId,
        parent.assigneeId,
        'synthesis_stalled',
        'The lead did not reconcile the team result after 3 passes — the mission needs a human.',
      );
    }
  }

  /** Starts the next task a worker queued while it was busy. */
  #drainQueue(agentId: string): void {
    const queue = this.#queues.get(agentId);
    if (!queue || queue.length === 0) return;
    const nextTaskId = queue.shift();
    if (queue.length === 0) this.#queues.delete(agentId);
    if (!nextTaskId) return;
    const nextTask = this.#store.tasks.get(nextTaskId);
    if (!nextTask || nextTask.status === 'done') {
      this.#drainQueue(agentId);
      return;
    }
    this.#store.appendLog('info', 'task.resumed', `Picking up the queued task "${nextTask.title}".`, agentId);
    void this.runTask(agentId, nextTaskId);
  }

  #observation(result: ActionResult, toolName: string | null): Observation {
    const built = buildObservation(result, { toolName, knownTools: KNOWN_TOOLS, detailLimit: 4_000 });
    // A malformed shape is fixed here rather than logged at the call site: the
    // model must never receive an empty summary, a next_action that does not
    // exist, or a success that lost the payload it promised.
    const namedTool = toolName ?? 'unknown tool';
    const described = built.issues.map((issue) => `${issue.field} ${issue.problem}`).join('; ');
    if (built.contractViolated) {
      // A rejected success is a defect in a tool, not a formatting slip, so it
      // is filed at error level where the activity log will actually show it.
      this.#store.appendLog('error', 'agent.contract', `Tool result contract: ${namedTool} — ${described}.`);
    } else if (built.issues.length > 0) {
      this.#store.appendLog('warn', 'agent.output', `Tool result shape: ${namedTool} — ${described}.`);
    }
    return built.observation;
  }

  /**
   * One line per model round trip, carrying that round's bill. The round is the
   * smallest unit an endpoint prices, so this is the honest per-step number —
   * several tool calls inside one round share it rather than splitting it.
   */
  #logStep(agent: AgentProfile, step: number, usage: LlmUsage, actions: string[]): void {
    if (usage.totalTokens === 0) return;
    const did = actions.length > 0 ? actions.join(', ') : 'reply';
    this.#store.appendLog('info', 'agent.step', `${agent.name} · step ${step} · ${did}`, agent.id, {
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      totalTokens: usage.totalTokens,
      turns: 1,
    });
  }

  #publishAction(agent: AgentProfile, actionName: string, result: ActionResult): void {
    if (result.speech) {
      this.#bus.publish('agent.speech', { agentId: agent.id, text: result.speech });
    }
    this.#store.appendLog(
      result.ok ? 'info' : 'warn',
      'agent.action',
      `${agent.name} → ${actionName}: ${result.summary}`,
      agent.id,
    );
  }

  /**
   * One model round, with one retry when the endpoint hiccups.
   *
   * A 5xx, a timeout or a reset socket says nothing about the prompt, so the
   * same call is repeated once before the turn is allowed to fail. Anything the
   * worker already wrote stays on disk; only the partial reply is discarded.
   */
  async #streamInto(
    chatMessage: ChatMessage,
    messages: LlmMessage[],
    signal: AbortSignal,
  ): Promise<{ text: string; usage: LlmUsage; toolCalls: LlmToolCall[] }> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.#streamWithFallback(chatMessage, messages, signal);
      } catch (error) {
        if (attempt >= 1 || signal.aborted || !isTransientModelError(error)) throw error;
        const message = error instanceof Error ? error.message : String(error);
        this.#store.patchChat(chatMessage.id, { content: '' });
        this.#store.appendLog(
          'warn',
          'model.retry',
          `The endpoint failed (${message.slice(0, 140)}) — retrying this step once.`,
          chatMessage.agentId,
        );
        await new Promise((resolve) => setTimeout(resolve, 400));
      }
    }
  }

  async #streamWithFallback(
    chatMessage: ChatMessage,
    messages: LlmMessage[],
    signal: AbortSignal,
  ): Promise<{ text: string; usage: LlmUsage; toolCalls: LlmToolCall[] }> {
    const apiKey = this.#store.apiKey;
    if (!apiKey) throw new Error('No API key configured');
    const primaryModel = this.#store.settings.model;
    const settings: LlmSettings = {
      endpoint: this.#store.settings.endpoint,
      apiKey,
      model: primaryModel,
    };

    try {
      return await this.#streamRound(settings, chatMessage, messages, signal);
    } catch (error) {
      if (primaryModel === FREE_MODEL || !isModelUnavailableError(error)) throw error;

      // The chosen model is unusable (no credit / not exposed): keep the office
      // running on the free model instead of failing the whole turn.
      const reason = error instanceof Error ? error.message : 'model unavailable';
      this.#store.appendLog(
        'warn',
        'model.fallback',
        `Model "${primaryModel}" failed (${reason}) — falling back to ${FREE_MODEL}.`,
        chatMessage.agentId,
      );
      this.#store.setModel(FREE_MODEL);
      this.#store.publishSettings();

      const fallbackSettings: LlmSettings = { ...settings, model: FREE_MODEL };
      const result = await this.#streamRound(fallbackSettings, chatMessage, messages, signal);
      this.#store.appendLog(
        'success',
        'model.active',
        `Now running on the free model ${FREE_MODEL}.`,
        chatMessage.agentId,
      );
      return result;
    }
  }

  async #streamRound(
    settings: LlmSettings,
    chatMessage: ChatMessage,
    messages: LlmMessage[],
    signal: AbortSignal,
  ): Promise<{ text: string; usage: LlmUsage; toolCalls: LlmToolCall[] }> {
    const toolSchemas = this.#toolSchemasFor(
      settings.endpoint,
      this.#phase.get(chatMessage.agentId ?? '') ?? 'inspect',
    );
    let text = '';
    let usage: LlmUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    let pending = '';
    const toolCalls: LlmToolCall[] = [];

    try {
      for await (const chunk of streamChat(settings, messages, signal, toolSchemas)) {
        if (chunk.usage) usage = chunk.usage;
        if (chunk.toolCalls) toolCalls.push(...chunk.toolCalls);
        if (chunk.delta.length === 0) continue;
        text += chunk.delta;
        pending += chunk.delta;
        this.#bus.publish('chat.delta', { id: chatMessage.id, agentId: chatMessage.agentId, delta: chunk.delta });
        if (pending.length > 40) {
          this.#store.patchChat(chatMessage.id, { content: text });
          pending = '';
        }
      }
    } catch (error) {
      if (!isToolSupportError(error) || toolSchemas.length === 0) throw error;

      // The endpoint does not understand the `tools` payload: remember that and
      // retry the same turn with the legacy JSON action protocol.
      this.#toolLessEndpoints.add(settings.endpoint);
      this.#store.appendLog(
        'warn',
        'agent.tools_unsupported',
        'This endpoint does not support native tool calls — using the JSON action protocol.',
        chatMessage.agentId,
      );
      for await (const chunk of streamChat(settings, messages, signal)) {
        if (chunk.usage) usage = chunk.usage;
        if (chunk.delta.length === 0) continue;
        text += chunk.delta;
        this.#bus.publish('chat.delta', { id: chatMessage.id, agentId: chatMessage.agentId, delta: chunk.delta });
      }
    }

    this.#store.patchChat(chatMessage.id, { content: text });
    return { text, usage, toolCalls };
  }

  #toolSchemasFor(endpoint: string, phase: ToolPhase): ReturnType<typeof buildToolSchemas> {
    if (this.#toolLessEndpoints.has(endpoint)) return [];
    return buildToolSchemas({
      files: this.#store.settings.toolsEnabled,
      web: this.#store.settings.webEnabled,
      phase,
    });
  }

  async #execute(agent: AgentProfile, taskId: string | null, action: Record<string, unknown>): Promise<ActionResult> {
    const store = this.#store;

    // Provenance describes what the *next* call is based on: the page or file
    // the worker just read. It is consumed here and immediately re-armed.
    const provenance = this.#provenance.get(agent.id) ?? 'user';
    this.#provenance.set(agent.id, provenanceAfter(String(action.action ?? '')));


    // Evidence for a folder with no checks: a command the worker ran itself.
    if (String(action.action ?? '') === 'run_command') {
      this.#commandEvidence.set(`${agent.id}\u0000${taskId ?? ''}`, true);
    }

    if (String(action.action ?? '') === 'revert_turn') {
      return this.#revertTurn(agent);
    }

    // Written before the status flips: a mission that reads the board right
    // after "done" must already see the fact, and a CLI that exits on done
    // must not lose a write that was still in flight.
    if (taskId && String(action.action ?? '') === 'complete_task') {
      await this.#rememberProject(taskId, readStringList(action, 'remember', 6, 240));
    }
    const handlers = {
      moveTo: (station: OfficeStation): string => {
        store.updateAgent(agent.id, { station });
        return `Walked to the ${station}.`;
      },
      setStatus: (status: 'idle' | 'working' | 'blocked' | 'error' | 'meeting', reason: string): string => {
        store.setAgentStatus(agent.id, status);
        return reason ? `Status is now ${status} (${reason}).` : `Status is now ${status}.`;
      },
      completeTask: (summary: string): string => {
        if (taskId) {
          const task = store.tasks.get(taskId);
          store.updateTask(taskId, {
            status: 'done',
            notes: [...(task?.notes ?? []), summary],
          });
          this.#releaseDependents(taskId);
        }
        store.updateAgent(agent.id, { status: 'idle', currentTaskId: null, taskSummary: null, station: 'desk' });
        return 'Task marked done.';
      },
      addNote: (text: string): string => {
        if (!taskId) return 'No task is attached, so the note was dropped.';
        store.addTaskNote(taskId, text);
        return 'Note added to the task.';
      },
      createTask: (
        title: string,
        detail: string,
        priority: TaskPriority,
        assignee?: string,
        dependsOn: string[] = [],
        pack?: string,
      ): string => {
        let assigneeId: string | null = null;
        let assigneeName: string | null = null;
        if (assignee) {
          const target = [...store.agents.values()].find(
            (candidate) => candidate.name.toLowerCase() === assignee.trim().toLowerCase(),
          );
          if (target) {
            assigneeId = target.id;
            assigneeName = target.name;
          }
        }
        // Subtasks of a subtask belong to the mission root, so the mission knows
        // the whole team is finished — not just its direct reports.
        const parentTask = taskId ? store.tasks.get(taskId) : undefined;
        const missionId = taskId
          ? parentTask?.mission
            ? taskId
            : (parentTask?.parentId ?? taskId)
          : null;

        if (missionId) {
          const siblings = [...store.tasks.values()].filter((entry) => entry.parentId === missionId);
          // A lead that keeps delegating instead of reconciling used to create
          // the same subtask over and over. Cap the fan-out and refuse repeats.
          if (siblings.length >= 6) {
            return 'This mission already has 6 subtasks — finish the rest yourself or reconcile what exists.';
          }
          const duplicate = siblings.find(
            (entry) =>
              entry.status !== 'done' && entry.title.trim().toLowerCase() === title.trim().toLowerCase(),
          );
          if (duplicate) {
            return `"${title}" is already open with ${duplicate.status} status — not creating a duplicate.`;
          }
        }

        const task = store.createTask({
          title,
          detail,
          priority,
          assigneeId,
          // Recording the parent is what lets the mission know the team is done.
          parentId: missionId,
          dependsOn,
          pack: pack ?? null,
        });
        store.appendLog(
          'info',
          'task.created',
          `New task "${title}"${assigneeName ? ` → ${assigneeName}` : ''}${pack ? ` under the ${pack} playbook` : ''}.`,
        );
        const waitingOn = unresolvedDependencies(task, store.tasks);
        if (assigneeId && waitingOn.length === 0) {
          void this.runTask(assigneeId, task.id);
          return `Created task "${title}" and handed it to ${assigneeName}.`;
        }
        if (waitingOn.length > 0) {
          return `Created task "${title}"${assigneeName ? ` for ${assigneeName}` : ''}, waiting on ${waitingOn.join(', ')}. It starts when they are done.`;
        }
        return `Created task "${title}".`;
      },
    };

    const outcome = await executeAction(
      { action: String(action.action ?? ''), ...action },
      {
        agentId: agent.id,
        agentName: agent.name,
        taskId,
        toolsEnabled: this.#store.settings.toolsEnabled,
        webEnabled: this.#store.settings.webEnabled,
        workspaceRoot: this.#rootFor(taskId),
        provenance,
        spend: taskId
          ? { missionTokens: this.#store.missionTokensOf(taskId), budget: MISSION_TOKEN_BUDGET }
          : undefined,
        running: listProcesses().length,
        otherAgentsBusy: [...this.#busy].filter((id) => id !== agent.id).length,
      },
      handlers,
    );
    this.#phase.set(
      agent.id,
      phaseAfterAction(String(action.action ?? ''), outcome.ok, this.#phase.get(agent.id) ?? 'inspect'),
    );
    // Remember which files this task changed: the merge gate re-hashes exactly
    // these, so an unrelated file changing elsewhere does not block it.
    if (taskId && outcome.ok) {
      const written = this.#taskWrites.get(taskId) ?? new Set<string>();
      for (const relative of affectedPaths(String(action.action ?? ''), action)) {
        written.add(path.resolve(this.#rootFor(taskId), relative));
      }
      this.#taskWrites.set(taskId, written);
    }
    return outcome;
  }

  /**
   * Starts every task whose last dependency just finished.
   *
   * This is the scheduler half of a dependency: the lead declares the order
   * once and stops managing it. Each ready task goes to its assignee's queue;
   * a worker that is busy picks it up when its turn ends, so waking three
   * dependents never runs three turns on one worker at once.
   */
  #releaseDependents(completedId: string): void {
    for (const task of readyTasks(this.#store.tasks, completedId)) {
      if (!task.assigneeId) {
        this.#store.appendLog('info', 'task.ready', `"${task.title}" is ready — unassigned.`);
        continue;
      }
      this.#store.appendLog(
        'info',
        'task.ready',
        `"${task.title}" is ready — ${this.#store.agents.get(task.assigneeId)?.name ?? 'its owner'} starts now.`,
        task.assigneeId,
      );
      void this.runTask(task.assigneeId, task.id);
    }
  }

  /**
   * Snapshots the tree before a turn touches it. Best effort: a folder that
   * cannot be snapshotted still runs, it just loses the undo for that turn.
   */
  async #snapshotTurnStart(agent: AgentProfile, taskId: string | null): Promise<void> {
    if (!this.#store.settings.toolsEnabled) return;
    const outcome = await takeSnapshot(
      this.#rootFor(taskId),
      STATE_DIR,
      `turn start: ${agent.name}`,
    );
    if (outcome.snapshot) {
      this.#turnSnapshots.set(agent.id, outcome.snapshot);
      return;
    }
    if (!this.#snapshotWarned && outcome.reason) {
      this.#snapshotWarned = true;
      this.#store.appendLog('warn', 'snapshot.failed', `No per-turn undo: ${outcome.reason}.`);
    }
  }

  /** `revert_turn`: put the folder back to how it was when this turn started. */
  async #revertTurn(agent: AgentProfile): Promise<ActionResult> {
    if (!this.#store.settings.toolsEnabled) {
      return { ok: false, summary: 'File access is disabled for this session.', followUp: true };
    }
    // A restore rewrites files. While another worker holds one of them, the
    // revert would erase work that is not part of this failure.
    if (otherWriterActive(agent.id)) {
      return {
        ok: false,
        code: 'path_locked',
        summary: 'Not now: another worker is writing in this folder.',
        detail: 'Wait for them to finish, then revert. Restoring now would erase their change too.',
        nextActions: ['read_file', 'add_note'],
        followUp: true,
      };
    }
    const snapshot = this.#turnSnapshots.get(agent.id);
    if (!snapshot) {
      return {
        ok: false,
        summary: 'There is no snapshot of the state before this turn, so nothing to revert to.',
        followUp: true,
      };
    }

    const outcome = await revertToSnapshot(snapshot);
    this.#store.appendLog(
      outcome.ok ? 'warn' : 'error',
      'task.reverted',
      outcome.ok
        ? `${agent.name} reverted this turn — the folder is back to its state at turn start.`
        : `${agent.name} could not revert this turn: ${outcome.message}`,
      agent.id,
    );
    return {
      ok: outcome.ok,
      summary: outcome.ok ? "Reverted this turn's file changes." : `Could not revert: ${outcome.message}`,
      detail:
        outcome.changed.length > 0
          ? `Restored paths:\n${outcome.changed.slice(-20).join('\n')}`
          : 'No files differed from the start of the turn.',
      nextActions: ['read_file', 'list_directory'],
      followUp: true,
    };
  }

  /**
   * Remembers the tree the checks just passed on. The next gate failure can
   * then tell a *regression* (something that used to pass) from a first-time
   * failure, and only the former is worth restoring.
   */
  async #markGreen(agent: AgentProfile, taskId: string, report: { ran: { name: string; ok: boolean }[] }): Promise<void> {
    if (!this.#store.settings.toolsEnabled) return;
    const title = this.#store.tasks.get(taskId)?.title ?? taskId;
    const outcome = await takeSnapshot(
      this.#rootFor(taskId),
      STATE_DIR,
      `verified: ${title}`,
    );
    if (!outcome.snapshot) return;
    this.#green = {
      snapshot: outcome.snapshot,
      checks: new Set(report.ran.filter((entry) => entry.ok).map((entry) => entry.name)),
    };
  }

  /**
   * Restores the last verified tree when a check that used to pass now fails.
   * Returns the note to hand the worker, or null when no revert was warranted.
   *
   * A teammate writing in the same folder right now wins: reverting would erase
   * work that has nothing to do with this failure, so the repair continues on
   * the current tree instead.
   */
  async #revertRegression(
    agent: AgentProfile,
    taskId: string,
    report: { ran: { name: string; ok: boolean }[] },
  ): Promise<string | null> {
    const green = this.#green;
    if (!green) return null;

    const regressed = report.ran.filter((entry) => !entry.ok && green.checks.has(entry.name));
    if (regressed.length === 0) return null;

    const busyElsewhere = [...this.#store.tasks.values()].some(
      (task) => task.id !== taskId && task.status === 'doing',
    );
    if (busyElsewhere) {
      this.#store.appendLog(
        'warn',
        'task.revert_skipped',
        'A teammate is writing in this folder — repairing on the current tree instead of reverting.',
        agent.id,
      );
      return null;
    }

    const outcome = await revertToSnapshot(green.snapshot);
    if (!outcome.ok) {
      this.#store.appendLog('error', 'task.reverted', `Could not restore the last verified state: ${outcome.message}`, agent.id);
      return null;
    }

    const names = regressed.map((entry) => entry.name).join(', ');
    this.#store.appendLog(
      'warn',
      'task.reverted',
      `${agent.name} broke ${names} — restored the folder to the last verified state.`,
      agent.id,
    );
    return `The folder was restored to the last state where ${names} passed, so your recent edits are gone. Re-read before editing again.`;
  }

  /**
   * Records what this mission taught the office about the folder: the facts the
   * worker chose to keep, plus the checks the folder actually has. Both are
   * deduplicated on write, so five missions that all discover `npm test` leave
   * one line, not five.
   */
  async #rememberProject(taskId: string, facts: string[]): Promise<void> {
    const checks = (this.#verificationPlans.get(taskId)?.checks ?? []).map((check) => check.name);
    const learned = [...facts];
    if (checks.length > 0) learned.push(`Checks available in this folder: ${checks.join(', ')}.`);
    if (learned.length === 0) return;

    try {
      const outcome = await recordProjectMemory(this.#store.settings.workspaceRoot, {
        facts: learned,
      });
      if (outcome.written.length > 0) {
        this.#store.appendLog(
          'info',
          'project.memory',
          `Remembered ${outcome.written.length} fact(s) about this folder for the next mission.`,
        );
      }
    } catch (error) {
      // Memory is a convenience; a read-only folder must never fail a task.
      const message = error instanceof Error ? error.message : 'unknown error';
      this.#store.appendLog('warn', 'project.memory', `Could not save project memory: ${message}`);
    }
  }

  /**
   * Captures the checks and the git baseline *before* the worker writes
   * anything. The gate can then only run tooling that already existed, and the
   * closing diff measures this task's work rather than pre-existing files.
   */
  /**
   * The folder a task works in: its own checkout when one could be made, the
   * shared folder otherwise. Every task-scoped path goes through here so a
   * worker can never read one tree and write another.
   */
  #rootFor(taskId: string | null): string {
    if (taskId) {
      const isolated = this.#isolated.get(taskId);
      if (isolated) return isolated.path;
    }
    return this.#store.settings.workspaceRoot;
  }

  /**
   * Gives a task its own checkout before anything touches the folder.
   *
   * Best effort by design: a folder that is not a git repository keeps working
   * exactly as before, with one line in the log saying so. Isolation is only
   * skipped for a reason the operator can read, never silently.
   */
  /**
   * Reclaims old checkouts once per run. Only finished or blocked tasks are
   * eligible: a running task's tree is never a candidate, however old it looks.
   */
  async #sweepCheckouts(): Promise<void> {
    if (this.#sweptCheckouts) return;
    this.#sweptCheckouts = true;
    if (!WORKTREE_ISOLATION || !this.#store.settings.toolsEnabled) return;
    const eligible = new Set(
      [...this.#store.tasks.values()]
        .filter((task) => task.status === 'blocked' || task.status === 'done')
        .map((task) => task.id),
    );
    if (eligible.size === 0) return;
    const outcome = await collectStaleCheckouts({
      mainRoot: this.#store.settings.workspaceRoot,
      baseDir: path.join(STATE_DIR, 'worktrees'),
      eligibleTaskIds: eligible,
    }).catch(() => null);
    if (!outcome || outcome.removed.length === 0) return;
    this.#store.appendLog(
      'info',
      'task.cleanup',
      `Reclaimed ${outcome.removed.length} old task checkout(s): ${outcome.removed
        .map((entry) => entry.reason)
        .join(', ')}.`,
    );
  }

  async #prepareIsolation(taskId: string, title: string): Promise<void> {
    if (!WORKTREE_ISOLATION || !this.#store.settings.toolsEnabled) return;
    await this.#sweepCheckouts();
    // The scripted demo turn writes its own fixture; a checkout would only make
    // the office look busy with work it is not allowed to land.
    if (this.#store.settings.demoMode) return;
    const outcome = await createIsolatedWorktree({
      mainRoot: this.#store.settings.workspaceRoot,
      taskId,
      baseDir: path.join(STATE_DIR, 'worktrees'),
    });
    if (outcome.ok) {
      this.#isolated.set(taskId, outcome.worktree);
      this.#store.appendLog(
        'info',
        'task.worktree',
        `\"${title}\" works in its own copy of the folder; its changes land when the checks pass.`,
      );
      return;
    }
    if (!this.#isolationExplained) {
      this.#isolationExplained = true;
      this.#store.appendLog(
        'info',
        'task.shared_folder',
        `No separate copy of the folder: ${outcome.detail}. Tasks share it as before.`,
      );
    }
  }

  /**
   * Releases a task's checkout once the turn is over.
   *
   * A finished task's changes have already landed, so the checkout is deleted.
   * A blocked task keeps its checkout: it is the only copy of that work, and
   * deleting it would be the office destroying what it just failed to merge.
   */
  async #releaseIsolation(taskId: string): Promise<void> {
    const isolated = this.#isolated.get(taskId);
    if (!isolated) return;
    const status = this.#store.tasks.get(taskId)?.status;
    if (status !== 'done') {
      const touched = await changedInWorktree(isolated);
      this.#store.addTaskNote(
        taskId,
        touched.length > 0
          ? `This task's unfinished changes (${touched.slice(0, 12).join(', ')}) are kept in ${isolated.path} — they were not landed in the folder.`
          : `This task changed nothing; its checkout is at ${isolated.path}.`,
      );
      return;
    }
    await discardWorktree(isolated);
    this.#isolated.delete(taskId);
    // The green tree lived inside that checkout; keeping it would make the next
    // regression repair restore files from a folder that no longer exists.
    this.#green = null;
  }

  async #prepareTask(taskId: string, title: string): Promise<void> {
    if (!this.#store.settings.toolsEnabled) return;

    // Checks run in the tree the worker edits; the checkpoint is a fact about
    // the operator's folder, so it is taken there and not inside a checkout.
    if (VERIFY_ENABLED) {
      this.#verificationPlans.set(taskId, await captureVerificationPlan(this.#rootFor(taskId)));
    }
    if (!GIT_CHECKPOINT_ENABLED) return;

    const outcome = await createCheckpoint(this.#store.settings.workspaceRoot, title);
    if (outcome.checkpoint) {
      this.#checkpoints.set(taskId, outcome.checkpoint);
      this.#store.appendLog(
        'info',
        'task.checkpoint',
        `Checkpoint ${outcome.checkpoint.ref.slice(0, 8)} taken before "${title}".`,
      );
    } else if (outcome.reason && !this.#checkpointNoticeLogged) {
      // Say it once per office, not once per subtask in a team mission.
      this.#checkpointNoticeLogged = true;
      this.#store.appendLog('info', 'task.checkpoint', `No checkpoint: ${outcome.reason}.`);
    }
  }

  /**
   * The scratch files the task is about to leave behind, or null when the
   * folder is clean. Asked up to `SCRATCH_ATTEMPTS` times; after that the work
   * is accepted with a warning so a model that ignores the request cannot burn
   * the whole turn on housekeeping. Nothing is ever deleted by the gate.
   */
  async #leftScratch(agent: AgentProfile, taskId: string): Promise<string | null> {
    if (!this.#store.settings.toolsEnabled) return null;
    const scan = await findScratchFiles(this.#rootFor(taskId));
    if (scan.files.length === 0) return null;

    const listed = describeScratch(scan);
    const asks = this.#scratchAsked.get(taskId) ?? 0;
    if (asks >= SCRATCH_ATTEMPTS) {
      this.#store.appendLog(
        'warn',
        'task.cleanup',
        `${agent.name} left ${scan.files.length} scratch file(s) behind — recorded in the task notes.`,
        agent.id,
      );
      this.#store.addTaskNote(taskId, `Leftover scratch files were accepted after ${asks} cleanup request(s): ${listed}`);
      return null;
    }

    this.#scratchAsked.set(taskId, asks + 1);
    this.#store.appendLog(
      'warn',
      'task.cleanup',
      `${agent.name} finished with ${scan.files.length} scratch file(s) still in the folder — sent back to delete them.`,
      agent.id,
    );
    this.#store.addTaskNote(taskId, `The gate asked for cleanup: these scratch files were still in the folder: ${listed}`);
    return SCRATCH_BRIEF(listed);
  }

  /**
   * A folder with no checks cannot prove a completion, so the gate asks for the
   * next best thing: evidence that the turn did something. Asked once per task,
   * then accepted — this is a nudge against "done" with no work at all, not a
   * quality gate, and it never fires when the folder has a real check.
   */
  async #missingEvidence(
    agent: AgentProfile,
    taskId: string,
    plan: VerificationPlan,
  ): Promise<string | null> {
    if (plan.checks.length > 0) return null;
    if (this.#evidenceAsked.has(taskId)) return null;
    if (this.#commandEvidence.get(`${agent.id}\u0000${taskId}`)) return null;

    const start = this.#turnSnapshots.get(agent.id);
    if (!start) return null;
    const now = await takeSnapshot(start.root, STATE_DIR, `evidence: ${taskId}`);
    if (!now.snapshot) return null;
    if ((await diffSnapshots(start, now.snapshot)).length > 0) return null;

    this.#evidenceAsked.add(taskId);
    return EVIDENCE_BRIEF;
  }

  /**
   * Runs one action, and when it is `complete_task` on a real task, holds the
   * result to the verification gate first. A reopened task comes back as a
   * failed observation so the worker keeps going instead of stopping.
   */
  async #executeWithGate(
    agent: AgentProfile,
    taskId: string | null,
    action: Record<string, unknown>,
  ): Promise<ActionResult> {
    const plan = taskId ? this.#verificationPlans.get(taskId) : undefined;
    if (String(action.action) !== 'complete_task' || !taskId || !VERIFY_ENABLED || !plan) {
      return this.#execute(agent, taskId, action);
    }

    // Housekeeping first: a folder full of probe scripts is not a deliverable,
    // and it is cheaper to catch it here than after the checks have run.
    const leftover = await this.#leftScratch(agent, taskId);
    if (leftover) {
      return {
        ok: false,
        summary: 'Not done yet: scratch files are still in the folder.',
        detail: leftover,
        nextActions: ['delete_file', 'list_directory'],
        followUp: true,
      };
    }

    // The check runs *before* the task is marked done. Marking it first would
    // show "done" in the UI and let the CLI exit while the gate is still
    // working — the exact lie this feature exists to prevent.
    const report = await runVerificationPlan(plan);
    if (report.ok) {
      const missing = await this.#missingEvidence(agent, taskId, plan);
      if (missing) {
        this.#store.appendLog(
          'warn',
          'task.evidence',
          `${agent.name} reported done without changing anything — asking for evidence.`,
          agent.id,
        );
        this.#store.addTaskNote(
          taskId,
          'The gate asked for evidence: no file changed and the folder has no check.',
        );
        return {
          ok: false,
          summary: 'Not done yet: nothing showed the task was done.',
          detail: missing,
          nextActions: ['write_file', 'edit_file', 'run_command', 'add_note'],
          followUp: true,
        };
      }

      // Freeze what "verified" means for this task before the reviewer and the
      // visual critic spend time reading it.
      this.#mergeBaseline.set(
        taskId,
        await hashPaths([...(this.#taskWrites.get(taskId) ?? new Set<string>())]),
      );

      const review = await this.#review(agent, taskId, report.ran.filter((entry) => entry.ok).map((entry) => entry.name));
      if (!review.ok) {
        return {
          ok: false,
          summary: 'Not done yet: the reviewer refused the change.',
          detail: review.detail,
          nextActions: ['read_file', 'apply_patch', 'run_check'],
          followUp: true,
        };
      }

      const vision = await this.#reviewVision(agent, taskId);
      if (!vision.ok) {
        return {
          ok: false,
          summary: 'Not done yet: the visual critic refused the page.',
          detail: vision.detail,
          nextActions: ['read_file', 'apply_patch', 'preview_screenshot'],
          followUp: true,
        };
      }

      // Landing and the verified-file check share one serialised slot: two
      // tasks cannot copy into the folder at the same time, and neither can be
      // judged against a tree another worker is half-way through changing.
      const merge = await this.#mergeQueue.run(async () => {
        const isolated = this.#isolated.get(taskId);
        if (isolated) {
          const landing = await landWorktree(isolated);
          return {
            conflicts: landing.conflicts.map((entry) => entry.path),
            landing,
          };
        }
        const baseline = this.#mergeBaseline.get(taskId);
        if (!baseline || baseline.size === 0) return { conflicts: [] as string[], landing: null };
        const current = await hashPaths([...baseline.keys()]);
        return {
          conflicts: changedPaths(baseline, current).map((absolutePath) =>
            path.relative(this.#store.settings.workspaceRoot, absolutePath),
          ),
          landing: null,
        };
      });
      if (merge.conflicts.length > 0) {
        const names = merge.conflicts.join(', ');
        const isolated = this.#isolated.get(taskId);
        // The worker's copy is refreshed from the folder so the repair happens
        // on the current text, and its own version is kept beside the checkout
        // instead of being thrown away.
        const rescued = isolated ? await refreshAfterConflict(isolated, merge.conflicts) : { refreshed: [], preserved: [] };
        if (isolated) {
          // The checkout was rewritten on purpose, so the stale-read guard must
          // not read that as another worker stepping on this one's copy.
          for (const relative of merge.conflicts) {
            forgetRead(ownerKey(agent.id, taskId), path.join(isolated.path, relative));
          }
          this.#pendingLanding.add(taskId);
        }
        this.#store.updateTask(taskId, {
          notes: [
            ...(this.#store.tasks.get(taskId)?.notes ?? []),
            `Merge gate: ${names} changed in the folder while this task ran.`,
          ],
        });
        this.#store.appendLog(
          'warn',
          'task.merge',
          isolated
            ? `${agent.name}'s change to ${names} would have overwritten a newer copy in the folder — sent back with the current text.`
            : `${agent.name}'s verified files changed before it could finish — checking again.`,
          agent.id,
        );
        return {
          ok: false,
          summary: 'Not done yet: the folder changed these files while you worked.',
          detail: [
            `${names} changed in the folder while this task ran, so copying your version over it would have erased that work.`,
            'Your copy has been replaced with the current text; redo your change on top of it, then run the check again.',
            rescued.preserved.length > 0 ? `Your earlier version was kept at:\n${rescued.preserved.join('\n')}` : '',
          ]
            .filter((line) => line.length > 0)
            .join('\n'),
          nextActions: ['read_file', 'run_check', 'apply_patch'],
          followUp: true,
        };
      }
      if (merge.landing?.ok && this.#pendingLanding.has(taskId)) {
        const landedCount = merge.landing.landed.length + merge.landing.deleted.length;
        if (landedCount === 0) {
          this.#store.appendLog(
            'warn',
            'task.merge',
            `${agent.name} finished without redoing the change the folder refused — sent back.`,
            agent.id,
          );
          return {
            ok: false,
            summary: 'Not done yet: your change is not in the folder.',
            detail: [
              'The landing was refused earlier and nothing new has been landed since.',
              'The folder holds the current text. Read it, redo your edit on top of it, then complete again.',
            ].join('\n'),
            nextActions: ['read_file', 'apply_patch', 'run_check'],
            followUp: true,
          };
        }
        this.#pendingLanding.delete(taskId);
      }
      if (merge.landing?.ok) {
        const landedCount = merge.landing.landed.length + merge.landing.deleted.length;
        if (landedCount > 0) {
          this.#store.appendLog(
            'info',
            'task.landed',
            `${agent.name}'s work landed in the folder: ${[merge.landing.landed.join(', '), merge.landing.deleted.map((file) => `-${file}`).join(', ')]
              .filter((part) => part.length > 0)
              .join(', ')}.`,
            agent.id,
          );
        }
      }

      const names = report.ran.map((check) => check.name).join(', ');
      this.#store.appendLog(
        'success',
        'task.verified',
        names.length > 0 ? `Checks passed: ${names}.` : 'Nothing to check in this folder — accepted.',
        agent.id,
      );
      // Snapshot the passing tree *before* the task reads as done. A watcher
      // that acts on `done` must be able to trust that the verified state is
      // already committed — the order used to be the other way round, and a
      // board read right after finishing could see no verified tree at all.
      await this.#markGreen(agent, taskId, report);
      const completed = await this.#execute(agent, taskId, action);
      await this.#reportChanges(agent, taskId);
      return completed;
    }

    const attempt = this.#verifyAttempts.get(taskId) ?? 0;
    const failure = describeVerificationFailure(report);
    if (attempt >= VERIFY_ATTEMPTS) {
      // Out of repair attempts: accept the work, but never claim it passed.
      this.#store.updateTask(taskId, {
        notes: [...(this.#store.tasks.get(taskId)?.notes ?? []), `Unfixed check failure: ${failure.slice(0, 600)}`],
      });
      this.#store.appendLog(
        'warn',
        'task.unverified',
        `${agent.name} finished, but checks still fail after ${attempt} repair attempt(s).`,
        agent.id,
      );
      const completed = await this.#execute(agent, taskId, action);
      await this.#reportChanges(agent, taskId);
      return completed;
    }

    // Repair from the last known-good tree rather than from the wreckage: if a
    // check that used to pass now fails, that is a regression, not unfinished work.
    const regressionNote = await this.#revertRegression(agent, taskId, report);
    this.#verifyAttempts.set(taskId, attempt + 1);
    const task = this.#store.tasks.get(taskId);
    this.#store.updateTask(taskId, {
      status: 'doing',
      notes: [
        ...(task?.notes ?? []),
        `Reopened after a failed check: ${failure.slice(0, 600)}`,
        ...(regressionNote ? [regressionNote] : []),
      ],
    });
    this.#store.updateAgent(agent.id, { status: 'working', currentTaskId: taskId });
    this.#store.appendLog(
      'warn',
      'task.reopened',
      `${agent.name} said the task was done, but a check failed — sending it back (attempt ${attempt + 1}/${VERIFY_ATTEMPTS}).`,
      agent.id,
    );
    return {
      ok: false,
      summary: `Not done yet: a check failed. ${failure.split('\n')[0]}`,
      detail: regressionNote ? `${regressionNote}\n\n${failure}` : failure,
      nextActions: ['read_file', 'edit_file', 'run_command'],
      followUp: true,
    };
  }

  /** Publishes what the worker actually changed, in diff form. */
  /**
   * Judges the image the worker last looked at, when there is one.
   *
   * Same discipline as the code reviewer: skipped when there is no image, no
   * key, or the endpoint cannot take an image; a refusal is capped at one so a
   * disagreement cannot loop; an unreadable reply is logged, never treated as
   * approval.
   */
  async #reviewVision(
    agent: AgentProfile,
    taskId: string,
  ): Promise<{ ok: true } | { ok: false; detail: string }> {
    if (this.#store.settings.demoMode || !this.#store.apiKey) return { ok: true };
    const source = this.#visuals.get(`${agent.id}\u0000${taskId}`);
    if (!source) return { ok: true };

    const MIME: Record<string, string> = {
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.webp': 'image/webp',
      '.gif': 'image/gif',
    };
    const mime = MIME[path.extname(source).toLowerCase()];
    if (!mime) {
      this.#store.appendLog('warn', 'task.vision', `Skipped the visual critic: ${source} is not an image.`, agent.id);
      return { ok: true };
    }

    const taskRoot = this.#rootFor(taskId);
    const absolute = path.resolve(taskRoot, source);
    const inside = absolute.startsWith(`${path.resolve(taskRoot)}${path.sep}`);
    if (!inside) return { ok: true };
    const bytes = await fs.readFile(absolute).catch(() => null);
    if (!bytes || bytes.length === 0 || bytes.length > 4 * 1024 * 1024) return { ok: true };

    const task = this.#store.tasks.get(taskId);
    try {
      const verdict = await critiqueImage(
        {
          endpoint: this.#store.settings.endpoint,
          apiKey: this.#store.apiKey,
          model: this.#store.settings.model,
        },
        {
          taskTitle: task?.title ?? taskId,
          source,
          imageDataUrl: `data:${mime};base64,${bytes.toString('base64')}`,
        },
      );
      if (!verdict) {
        this.#store.appendLog(
          'warn',
          'task.vision',
          'The visual critic replied in a shape that could not be read — the checks stand.',
          agent.id,
        );
        return { ok: true };
      }
      if (verdict.verdict === 'pass') {
        this.#store.appendLog('success', 'task.vision', `Visual critic accepted ${source}.`, agent.id);
        return { ok: true };
      }

      const attempt = this.#visionAttempts.get(taskId) ?? 0;
      const issues = verdict.issues.map((issue) => `- ${issue}`).join('\n');
      this.#store.updateTask(taskId, {
        notes: [...(task?.notes ?? []), `Visual critic refused ${source}: ${verdict.issues.join('; ').slice(0, 500)}`],
      });
      if (attempt >= VISION_ATTEMPTS) {
        this.#store.appendLog(
          'warn',
          'task.vision',
          `Visual critic still refuses ${source} after ${attempt} attempt(s) — accepting with a note.`,
          agent.id,
        );
        return { ok: true };
      }
      this.#visionAttempts.set(taskId, attempt + 1);
      this.#store.appendLog(
        'warn',
        'task.vision',
        `Visual critic refused ${source} — sending it back (attempt ${attempt + 1}/${VISION_ATTEMPTS}).`,
        agent.id,
      );
      return {
        ok: false,
        detail: [
          `An independent visual critic looked at ${source} and refused it:`,
          issues,
          '',
          'Fix the page, take a fresh screenshot, and look at it again before claiming done.',
        ].join('\n'),
      };
    } catch (error) {
      this.#store.appendLog(
        'warn',
        'task.vision',
        `The visual critic could not run (${error instanceof Error ? error.message : 'unknown error'}) — the checks stand.`,
        agent.id,
      );
      return { ok: true };
    }
  }

  /**
   * The independent read of the change, after the checks passed.
   *
   * Skipped when there is nothing to judge (no checkpoint, empty diff, demo
   * mode, no key). A reviewer that cannot answer never blocks: the work already
   * cleared the folder's own checks, and a broken reviewer must not become a
   * second gate that fails closed for the wrong reason. The log says so.
   */
  async #review(
    agent: AgentProfile,
    taskId: string,
    checks: string[],
  ): Promise<{ ok: true } | { ok: false; detail: string }> {
    if (this.#store.settings.demoMode || !this.#store.apiKey) return { ok: true };
    // Two folders, two diff sources. A plain folder has the checkpoint commit;
    // a repository has neither a checkpoint nor a branch the office may touch,
    // but it has this task's checkout — so the review covers operator repos too,
    // instead of silently approving everything there.
    const isolated = this.#isolated.get(taskId);
    let diff = '';
    if (isolated) {
      diff = await worktreeDiff(isolated).catch(() => '');
    } else {
      const checkpoint = this.#checkpoints.get(taskId);
      if (!checkpoint) return { ok: true };
      diff = await summariseChanges(checkpoint).catch(() => '');
    }
    if (diff.trim().length === 0) return { ok: true };

    const task = this.#store.tasks.get(taskId);
    try {
      const verdict = await reviewWork(
        {
          endpoint: this.#store.settings.endpoint,
          apiKey: this.#store.apiKey,
          model: this.#store.settings.model,
        },
        {
          taskTitle: task?.title ?? taskId,
          taskDetail: task?.detail ?? '',
          agentName: agent.name,
          role: agent.role,
          pack: task?.activePack ?? task?.pack ?? null,
          checks,
          diff,
        },
      );
      if (!verdict) {
        this.#store.appendLog(
          'warn',
          'task.review',
          `The reviewer's reply could not be read — the checks stand, so the task continues.`,
          agent.id,
        );
        return { ok: true };
      }
      if (verdict.verdict === 'pass') {
        this.#store.appendLog('success', 'task.reviewed', `Reviewer accepted ${agent.name}'s change.`, agent.id);
        return { ok: true };
      }

      const attempt = this.#reviewAttempts.get(taskId) ?? 0;
      const reasons = verdict.reasons.map((reason) => `- ${reason}`).join('\n');
      // Kept as data, not only as a note: a pack whose bar is misspoken is
      // found by counting which of its rules the reviewer keeps citing.
      this.#store.recordReviewRefusal(
        taskId,
        task?.activePack ?? task?.pack ?? 'general',
        verdict.reasons,
      );
      this.#store.updateTask(taskId, {
        status: 'doing',
        notes: [...(task?.notes ?? []), `Reviewer refused the change: ${verdict.reasons.join('; ').slice(0, 500)}`],
      });
      if (attempt >= REVIEW_ATTEMPTS) {
        // Out of review attempts: accept, but never pretend it passed.
        this.#store.appendLog(
          'warn',
          'task.review',
          `Reviewer still refuses ${agent.name}'s change after ${attempt} attempt(s) — accepting with a note.`,
          agent.id,
        );
        return { ok: true };
      }
      this.#reviewAttempts.set(taskId, attempt + 1);
      this.#store.updateAgent(agent.id, { status: 'working', currentTaskId: taskId });
      this.#store.appendLog(
        'warn',
        'task.review',
        `Reviewer refused ${agent.name}'s change — sending it back (attempt ${attempt + 1}/${REVIEW_ATTEMPTS}).`,
        agent.id,
      );
      return {
        ok: false,
        detail: [
          'An independent reviewer read the diff and refused it:',
          reasons,
          '',
          'Fix these, then run the check again. Do not claim the task is done until the reviewer accepts.',
        ].join('\n'),
      };
    } catch (error) {
      this.#store.appendLog(
        'warn',
        'task.review',
        `The reviewer could not run (${error instanceof Error ? error.message : 'unknown error'}) — the checks stand.`,
        agent.id,
      );
      return { ok: true };
    }
  }

  async #reportChanges(agent: AgentProfile, taskId: string): Promise<void> {
    const checkpoint = this.#checkpoints.get(taskId);
    if (!checkpoint) return;
    const summary = await summariseChanges(checkpoint);
    this.#store.addTaskNote(taskId, `Changes since checkpoint ${checkpoint.ref.slice(0, 8)}:\n${summary}`);
    this.#store.appendLog('info', 'task.diff', `${agent.name}'s changes — ${summary.split('\n')[0]}`, agent.id);
  }

  async #runDemoTurn(agent: AgentProfile, taskId: string | null, kind: 'chat' | 'task'): Promise<void> {
    const chatMessage = this.#store.appendChat({
      role: 'assistant',
      agentId: agent.id,
      taskId,
      content: '',
      streaming: true,
    });

    const reply = demoReply(agent, kind);
    const tokens = reply.split(/\s+/).filter(Boolean).length;
    let accumulated = '';
    for (const piece of reply.match(/.{1,14}/g) ?? []) {
      accumulated += piece;
      this.#bus.publish('chat.delta', { id: chatMessage.id, agentId: agent.id, delta: piece });
      this.#store.patchChat(chatMessage.id, { content: accumulated });
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    this.#store.patchChat(chatMessage.id, { content: reply, streaming: false });
    // Scripted replies are not billed, but the meter still has to move so the
    // demo shows what the UI looks like with spend on it.
    this.#store.recordUsage(agent.id, taskId, {
      promptTokens: 0,
      completionTokens: tokens,
      totalTokens: tokens,
      turns: 1,
    });

    if (kind === 'task' && taskId) {
      const task = this.#store.tasks.get(taskId);
      this.#store.updateTask(taskId, { status: 'done', notes: [...(task?.notes ?? []), 'Completed in demo mode.'] });
      this.#store.updateAgent(agent.id, { status: 'idle', currentTaskId: null, taskSummary: null, station: 'desk' });
      this.#store.appendLog('success', 'task.done', `${agent.name} finished "${task?.title ?? 'task'}".`, agent.id);
    }
  }

  #rosterText(): string {
    return [...this.#store.agents.values()]
      .map((candidate) => `- ${candidate.name} (${candidate.role})`)
      .join('\n');
  }

  /** Used by the session probe endpoint. */
  async probe(settings: LlmSettings): Promise<string> {
    const result = await chat(settings, [{ role: 'user', content: 'Reply with OK.' }]);
    return result.content.trim().slice(0, 40);
  }
}
