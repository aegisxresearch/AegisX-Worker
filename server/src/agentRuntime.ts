import type {
  AgentProfile,
  ChatMessage,
  OfficeStation,
  Task,
  TaskPriority,
} from '../../shared/types.ts';
import {
  ACTION_TOKEN_BUDGET,
  FREE_MODEL,
  GIT_CHECKPOINT_ENABLED,
  MAX_ACTION_ROUNDS,
  REPEAT_ACTION_LIMIT,
  VERIFY_ATTEMPTS,
  VERIFY_ENABLED,
} from './config.ts';
import { createCheckpoint, summariseChanges, type Checkpoint } from './git.ts';
import type { EventBus } from './events.ts';
import {
  chat,
  isModelUnavailableError,
  isToolSupportError,
  listModels,
  streamChat,
  type LlmMessage,
  type LlmSettings,
  type LlmToolCall,
  type LlmUsage,
} from './llm.ts';
import { OfficeStore } from './store.ts';
import { buildToolSchemas } from './toolSchemas.ts';
import { executeAction, type ActionResult } from './tools.ts';
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

const SYSTEM_PROMPT = `You are {name}, a {role} working in a 3D virtual office with a team of AI agents.
Your words are short — you are working, not writing an essay. Stay under 70 words unless a tool result needs summarising.

Work by calling the tools you are given. Each tool call runs for real: file tools read and write
inside the workspace folder, run_command runs one shell command, web_search and web_fetch reach
the public web. The tool result comes back as JSON with status, summary, next_actions and artifacts.

Rules:
- Call complete_task only when the work is actually finished, and put the result in its summary.
- Read a file before you edit it, and never invent file contents.
- Scratch files you create to check something (verify-*.mjs, tmp-*, out.txt, *.log) must be deleted
  before complete_task. Only the deliverables and the tests you were asked for stay in the folder.
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
- File paths are relative to the workspace folder (for example notes/report.md).
- Run one command at a time: no && , no |, no ; — each command must stand alone.
- A command that finds nothing exits with code 1; that is a normal result, not an error.
- Prefer writing the deliverable with write_file over shelling out.`;

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

/** Recorded on a task that was mid-flight when the process stopped. */
const RESTART_NOTE =
  'The office restarted while this task was running, so nothing is working on it now. Start it again to continue from these notes.';

interface Observation {
  status: 'success' | 'warning' | 'error';
  summary: string;
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

    await this.#prepareTask(taskId, task.title);

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
    this.#busy.add(agent.id);
    const controller = new AbortController();

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

      const systemPrompt = SYSTEM_PROMPT.replace('{name}', agent.name).replace('{role}', agent.role);
      const workingMessages: LlmMessage[] = [
        {
          role: 'system',
          content: `${systemPrompt}\n\nOffice roster:\n${this.#rosterText()}\n\nWorkspace folder: ${this.#store.settings.workspaceRoot}`,
        },
        ...messages,
      ];

      let totalUsage: LlmUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
      /** Completed model round trips in this turn; the meter reports them. */
      let modelTurns = 0;
      let lastText = '';
      let budgetSpent = true;
      let repeatedAction: string | null = null;
      let lastSignature = '';
      let repeatCount = 0;
      let steeredForRepeat = false;

      for (let round = 0; round < MAX_ACTION_ROUNDS; round += 1) {
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
              content: JSON.stringify(this.#observation(result)),
            });

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
      this.#store.recordUsage(agent.id, taskId, { ...totalUsage, turns: modelTurns });

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
          // The agent neither completed nor handed off the task: mark it blocked.
          this.#store.updateTask(taskId, { status: 'blocked' });
          this.#store.updateAgent(agent.id, { status: 'blocked' });
          this.#store.appendLog('warn', 'task.blocked', `${agent.name} paused the task.`, agent.id);
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
        this.#store.updateTask(taskId, {
          status: 'blocked',
          notes: [...(this.#store.tasks.get(taskId)?.notes ?? []), `Blocked by an error: ${message}`],
        });
        this.#store.updateAgent(agent.id, { status: 'blocked', currentTaskId: null, taskSummary: null });
        this.#store.appendLog('warn', 'task.blocked', `${agent.name} could not finish the task — it is blocked.`, agent.id);
      }
    } finally {
      this.#busy.delete(agent.id);
      if (kind === 'task' && taskId) {
        // The turn owns these; a finished task must not leave them behind.
        this.#verificationPlans.delete(taskId);
        this.#checkpoints.delete(taskId);
        this.#verifyAttempts.delete(taskId);
      }
      this.#drainQueue(agent.id);

      // A settled subtask may be the last one: let the lead reconcile.
      const parentId = kind === 'task' && taskId ? (this.#store.tasks.get(taskId)?.parentId ?? null) : null;
      if (parentId) void this.#maybeSynthesise(parentId);
    }
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
      this.#store.updateTask(parentId, {
        status: 'blocked',
        notes: [
          ...after.notes,
          'The lead did not reconcile the team result after 3 passes — the mission needs a human.',
        ],
      });
      this.#store.updateAgent(parent.assigneeId, { status: 'blocked' });
      this.#store.appendLog(
        'warn',
        'mission.blocked',
        'The lead could not reconcile the team result — the mission is blocked.',
        parent.assigneeId,
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

  #observation(result: ActionResult): Observation {
    return {
      status: result.ok ? 'success' : 'error',
      summary: result.summary,
      next_actions: result.nextActions ?? [],
      artifacts: result.artifacts ?? [],
    };
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

  async #streamInto(
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
    const toolSchemas = this.#toolSchemasFor(settings.endpoint);
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

  #toolSchemasFor(endpoint: string): ReturnType<typeof buildToolSchemas> {
    if (this.#toolLessEndpoints.has(endpoint)) return [];
    return buildToolSchemas({
      files: this.#store.settings.toolsEnabled,
      web: this.#store.settings.webEnabled,
    });
  }

  async #execute(agent: AgentProfile, taskId: string | null, action: Record<string, unknown>): Promise<ActionResult> {
    const store = this.#store;
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
        }
        store.updateAgent(agent.id, { status: 'idle', currentTaskId: null, taskSummary: null, station: 'desk' });
        return 'Task marked done.';
      },
      addNote: (text: string): string => {
        if (!taskId) return 'No task is attached, so the note was dropped.';
        store.addTaskNote(taskId, text);
        return 'Note added to the task.';
      },
      createTask: (title: string, detail: string, priority: TaskPriority, assignee?: string): string => {
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
        });
        store.appendLog('info', 'task.created', `New task "${title}"${assigneeName ? ` → ${assigneeName}` : ''}.`);
        if (assigneeId) {
          void this.runTask(assigneeId, task.id);
          return `Created task "${title}" and handed it to ${assigneeName}.`;
        }
        return `Created task "${title}".`;
      },
    };

    return executeAction(
      { action: String(action.action ?? ''), ...action },
      {
        agentId: agent.id,
        agentName: agent.name,
        taskId,
        toolsEnabled: this.#store.settings.toolsEnabled,
        webEnabled: this.#store.settings.webEnabled,
        workspaceRoot: this.#store.settings.workspaceRoot,
      },
      handlers,
    );
  }

  /**
   * Captures the checks and the git baseline *before* the worker writes
   * anything. The gate can then only run tooling that already existed, and the
   * closing diff measures this task's work rather than pre-existing files.
   */
  async #prepareTask(taskId: string, title: string): Promise<void> {
    const root = this.#store.settings.workspaceRoot;
    if (!this.#store.settings.toolsEnabled) return;

    if (VERIFY_ENABLED) {
      this.#verificationPlans.set(taskId, await captureVerificationPlan(root));
    }
    if (!GIT_CHECKPOINT_ENABLED) return;

    const outcome = await createCheckpoint(root, title);
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

    // The check runs *before* the task is marked done. Marking it first would
    // show "done" in the UI and let the CLI exit while the gate is still
    // working — the exact lie this feature exists to prevent.
    const report = await runVerificationPlan(plan);
    if (report.ok) {
      const names = report.ran.map((check) => check.name).join(', ');
      this.#store.appendLog(
        'success',
        'task.verified',
        names.length > 0 ? `Checks passed: ${names}.` : 'Nothing to check in this folder — accepted.',
        agent.id,
      );
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

    this.#verifyAttempts.set(taskId, attempt + 1);
    const task = this.#store.tasks.get(taskId);
    this.#store.updateTask(taskId, {
      status: 'doing',
      notes: [...(task?.notes ?? []), `Reopened after a failed check: ${failure.slice(0, 600)}`],
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
      detail: failure,
      nextActions: ['read_file', 'edit_file', 'run_command'],
      followUp: true,
    };
  }

  /** Publishes what the worker actually changed, in diff form. */
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
