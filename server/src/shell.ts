import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { COMMAND_TIMEOUT_MS, JAIL_ENABLED, JAIL_HOME_DIR, JAIL_NET, MAX_FILE_BYTES } from './config.ts';
import { planJail, toolchainRoots } from './jail.ts';
import { isInside } from './workspace.ts';

/**
 * The worker's shell.
 *
 * A model writes `echo x > f`, `cat f | grep x`, `npm test && echo ok` because
 * that is how a shell works everywhere else. Refusing those with "not allowed"
 * taught it nothing: it retried another variant, burned the round, and the task
 * failed. Running the string through `sh -c` would fix the ergonomics and hand
 * the model an escape hatch at the same time.
 *
 * So this module parses that grammar itself and executes it with argv arrays:
 * no shell, no word expansion, no globbing, no `$(...)`. Redirects are opened
 * inside the workspace through the same guard as the file tools.
 */

export type ShellOp = '|' | '||' | '&&' | ';' | '>' | '>>' | '<' | '2>' | '2>>' | '2>&1' | '&>';

type Token = { kind: 'word'; value: string } | { kind: 'op'; value: ShellOp };

export interface Redirect {
  kind: 'stdout' | 'stderr' | 'stdin';
  target: string;
  append: boolean;
}

export interface SimpleCommand {
  argv: string[];
  redirects: Redirect[];
  /** `2>&1` — stderr joins stdout instead of going to the error channel. */
  mergeStderr: boolean;
}

export interface Statement {
  connector: 'start' | '&&' | '||' | ';';
  commands: SimpleCommand[];
}

export interface ParsedShell {
  statements: Statement[];
}

export type ParseResult = { ok: true; parsed: ParsedShell } | { ok: false; message: string };

/**
 * Binaries a worker may call. Everything here is either read-only or writes
 * only inside the workspace, which the path guard enforces separately.
 */
export const ALLOWED_COMMANDS = [
  'ls',
  'cat',
  'pwd',
  'echo',
  'printf',
  'head',
  'tail',
  'wc',
  'find',
  'grep',
  'rg',
  'node',
  'npm',
  'npx',
  'git',
  'python3',
  'python',
  'sed',
  'awk',
  'date',
  'du',
  'df',
  'tree',
  'which',
  'uname',
  'whoami',
  'env',
  'printenv',
  'sort',
  'uniq',
  'cut',
  'tr',
  'diff',
  'basename',
  'dirname',
  'realpath',
  'mkdir',
  'touch',
  'cp',
  'mv',
  'true',
  'false',
  'test',
  'lsb_release',
];

/**
 * A refusal is only useful when it names what to call instead. Anything not in
 * this table gets the plain allowlist sentence.
 */
const REPLACEMENTS: Record<string, string> = {
  curl: 'Call http_check with the URL instead — it reports status, expected text and every asset.',
  wget: 'Call http_check for a loopback URL or web_fetch for a public page.',
  rm: 'Call delete_file with the path; it removes files and folders inside the workspace.',
  rmdir: 'Call delete_file with the folder path.',
  bash: 'Run the command directly; pipes, redirects, && and ; are supported.',
  sh: 'Run the command directly; pipes, redirects, && and ; are supported.',
  zsh: 'Run the command directly; pipes, redirects, && and ; are supported.',
  chmod: 'File permissions are not part of this sandbox.',
  chown: 'File ownership is not part of this sandbox.',
  sudo: 'The sandbox has no elevated access.',
  sleep: 'A wait is not needed: start_process returns while the server is still starting, and port_status tells you when it listens.',
  which_chrome: 'Call preview_screenshot; it finds the browser itself.',
  google_chrome: 'Call preview_screenshot; it finds the browser itself.',
  chromium: 'Call preview_screenshot; it finds the browser itself.',
  playwright: 'Call preview_screenshot, or start a dev server with start_process and check it with http_check.',
  docker: 'Containers are not available in the sandbox.',
  systemctl: 'Services are not available in the sandbox.',
  open: 'There is no GUI to open.',
  xdg_open: 'There is no GUI to open.',
};

const MAX_CAPTURE_BYTES = 512 * 1024;

/**
 * What to run *instead*, when the sandbox refuses a binary.
 *
 * A refusal that only explains itself costs a model round: the worker reads the
 * sentence, agrees, and calls something else — or calls the same thing again.
 * Naming the tool is better; naming it in a shape the runtime can execute is
 * what makes the repair free.
 */
export interface Remedy {
  tool: string;
  args: Record<string, unknown>;
  /** The binary that was refused, for the log line. */
  refused: string;
}

/** First URL-shaped argument, so `curl -s localhost:3000` still yields a URL. */
function firstUrl(argv: string[]): string | null {
  for (const token of argv) {
    if (/^https?:\/\//.test(token)) return token;
    if (/^(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?(\/|$)/.test(token)) {
      return `http://${token.replace(/^0\.0\.0\.0/, '127.0.0.1')}`;
    }
  }
  return null;
}

function firstPath(argv: string[]): string | null {
  const candidates = argv.filter((token) => !token.startsWith('-') && token !== argv[0]);
  return candidates.length > 0 ? (candidates[candidates.length - 1] ?? null) : null;
}

/** Maps a refused binary onto the tool call that does the job. */
export function remedyFor(argv: string[]): Remedy | null {
  const binary = argv[0];
  if (!binary) return null;
  const name = binary.split('/').pop() ?? binary;

  if (name === 'curl' || name === 'wget') {
    const url = firstUrl(argv);
    return { tool: 'http_check', args: url ? { url } : {}, refused: name };
  }
  if (name === 'rm' || name === 'rmdir' || name === 'unlink') {
    const target = firstPath(argv);
    return { tool: 'delete_file', args: target ? { path: target } : {}, refused: name };
  }
  if (['chrome', 'google-chrome', 'chromium', 'chromium-browser', 'playwright', 'which'].includes(name)) {
    return { tool: 'preview_screenshot', args: {}, refused: name };
  }
  if (name === 'sleep') return { tool: 'port_status', args: {}, refused: name };
  if (name === 'tee') return { tool: 'write_file', args: {}, refused: name };
  return null;
}

export interface ShellOutcome {
  ok: boolean;
  /** What the model reads as `detail`. */
  output: string;
  /** Set when the command was refused and another tool does the job. */
  remedy?: Remedy;
  /** Commands that actually ran, for the one-line summary. */
  steps: string[];
  exitCode: number;
  /** Refused before anything ran. */
  rejected: boolean;
  /** Set when a statement was skipped by && or ||. */
  note: string;
}

function describeOp(rest: string): { op: ShellOp; length: number } | null {
  const candidates: ShellOp[] = ['2>&1', '2>>', '2>', '&>', '>>', '&&', '||', '|', '>', '<', ';'];
  for (const op of candidates) {
    if (rest.startsWith(op)) return { op, length: op.length };
  }
  return null;
}

function tokenize(input: string): Token[] | { error: string } {
  const tokens: Token[] = [];
  let word = '';
  let started = false;
  let index = 0;

  const flush = (): void => {
    if (!started) return;
    tokens.push({ kind: 'word', value: word });
    word = '';
    started = false;
  };

  while (index < input.length) {
    const char = input[index] ?? '';

    if (char === ' ' || char === '\t') {
      flush();
      index += 1;
      continue;
    }

    if (char === '\n' || char === '\r') {
      return {
        error:
          'Line breaks are not available: pass the whole command on one line, and run a second command as its own call.',
      };
    }

    if (char === "'") {
      const end = input.indexOf("'", index + 1);
      if (end === -1) return { error: 'The command has an unclosed single quote.' };
      word += input.slice(index + 1, end);
      started = true;
      index = end + 1;
      continue;
    }

    if (char === '"') {
      let cursor = index + 1;
      let closed = false;
      while (cursor < input.length) {
        const inner = input[cursor] ?? '';
        if (inner === '\\' && cursor + 1 < input.length) {
          word += input[cursor + 1] ?? '';
          cursor += 2;
          continue;
        }
        if (inner === '"') {
          closed = true;
          cursor += 1;
          break;
        }
        word += inner;
        cursor += 1;
      }
      if (!closed) return { error: 'The command has an unclosed double quote.' };
      started = true;
      index = cursor;
      continue;
    }

    if (char === '\\' && index + 1 < input.length) {
      word += input[index + 1] ?? '';
      started = true;
      index += 2;
      continue;
    }

    // `2>` only means stderr when it starts a token; `sed s/2>/x/` keeps its word.
    if (char === '2' && !started && /^2>{1,2}/.test(input.slice(index))) {
      flush();
      const op = input.startsWith('2>&1', index) ? '2>&1' : input.startsWith('2>>', index) ? '2>>' : '2>';
      tokens.push({ kind: 'op', value: op });
      index += op.length;
      continue;
    }

    const op = describeOp(input.slice(index));
    if (op) {
      flush();
      tokens.push({ kind: 'op', value: op.op });
      index += op.length;
      continue;
    }

    word += char;
    started = true;
    index += 1;
  }

  flush();
  return tokens;
}

/** Parses the shell grammar into statements without executing anything. */
export function parseShell(raw: string): ParseResult {
  const command = raw.trim();
  if (command.length === 0) return { ok: false, message: 'The command is empty.' };

  if (command.includes('$(') || command.includes('`')) {
    return {
      ok: false,
      message:
        'Command substitution is not available. Run the inner command as its own run_command, read its output, then run the next one.',
    };
  }

  const tokens = tokenize(command);
  if ('error' in tokens) return { ok: false, message: tokens.error };
  if (tokens.length === 0) return { ok: false, message: 'The command is empty.' };

  const statements: Statement[] = [];
  let connector: Statement['connector'] = 'start';
  let commands: SimpleCommand[] = [];
  let current: SimpleCommand = { argv: [], redirects: [], mergeStderr: false };

  const startCommand = (): void => {
    current = { argv: [], redirects: [], mergeStderr: false };
  };

  const finishCommand = (): ParseResult | null => {
    if (current.argv.length === 0) {
      if (current.redirects.length > 0 || current.mergeStderr) {
        return {
          ok: false,
          message: 'A redirect needs a command in front of it, for example: echo hello > out.txt',
        };
      }
      return null;
    }
    commands.push(current);
    return null;
  };

  const finishStatement = (next: Statement['connector']): ParseResult | null => {
    const problem = finishCommand();
    if (problem) return problem;
    if (commands.length === 0) {
      return { ok: false, message: 'The command has an empty segment — remove the extra operator.' };
    }
    statements.push({ connector, commands });
    commands = [];
    connector = next;
    startCommand();
    return null;
  };

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token) continue;

    if (token.kind === 'word') {
      current.argv.push(token.value);
      continue;
    }

    const operator = token.value;
    switch (operator) {
      case '|': {
        const problem = finishCommand();
        if (problem) return problem;
        if (current.argv.length === 0 && commands.length === 0) {
          return { ok: false, message: 'A pipe needs a command on both sides.' };
        }
        startCommand();
        break;
      }
      case '&&':
      case '||':
      case ';': {
        const problem = finishStatement(operator);
        if (problem) return problem;
        break;
      }
      case '2>&1': {
        current.mergeStderr = true;
        break;
      }
      case '&>': {
        const target = tokens[index + 1];
        if (!target || target.kind !== 'word') {
          return { ok: false, message: 'A redirect needs a file name, for example: npm test &> out.log' };
        }
        current.redirects.push({ kind: 'stdout', target: target.value, append: false });
        current.redirects.push({ kind: 'stderr', target: target.value, append: false });
        index += 1;
        break;
      }
      case '>':
      case '>>':
      case '2>':
      case '2>>':
      case '<': {
        const target = tokens[index + 1];
        if (!target || target.kind !== 'word') {
          return {
            ok: false,
            message: `A redirect needs a file name, for example: echo hello ${operator} out.txt`,
          };
        }
        if (operator === '<') {
          current.redirects.push({ kind: 'stdin', target: target.value, append: false });
        } else if (operator === '>') {
          current.redirects.push({ kind: 'stdout', target: target.value, append: false });
        } else if (operator === '>>') {
          current.redirects.push({ kind: 'stdout', target: target.value, append: true });
        } else if (operator === '2>') {
          current.redirects.push({ kind: 'stderr', target: target.value, append: false });
        } else {
          current.redirects.push({ kind: 'stderr', target: target.value, append: true });
        }
        index += 1;
        break;
      }
      default:
        return { ok: false, message: `Unsupported shell operator "${operator}".` };
    }
  }

  const problem = finishStatement(';');
  if (problem) return problem;

  return { ok: true, parsed: { statements } };
}

function binaryHint(binary: string): string {
  return (
    REPLACEMENTS[binary] ??
    `"${binary}" is not available in the sandbox. Available: ${ALLOWED_COMMANDS.join(', ')}.`
  );
}

/**
 * Every path in the command must stay inside the workspace. Without this a
 * redirect or a `cat` would make the allowlist the only boundary, and the
 * operator's chosen folder would stop meaning anything.
 */
/** Devices a command may reach on purpose: a worker silencing output, not a file. */
const ALLOWED_DEVICES = new Set(['/dev/null', '/dev/stdout', '/dev/stderr']);

function checkPaths(parsed: ParsedShell, root: string): string | null {
  for (const statement of parsed.statements) {
    for (const command of statement.commands) {
      for (const token of command.argv) {
        if (token.split('/').includes('..')) {
          return `"${token}" uses "..", which would leave the workspace. Use a path inside the folder.`;
        }
        if (ALLOWED_DEVICES.has(token)) continue;
        if (token.startsWith('/') && !isInside(root, path.resolve(token))) {
          return `"${token}" is outside the workspace folder (${root}). Use a path relative to it.`;
        }
      }
      for (const redirect of command.redirects) {
        if (ALLOWED_DEVICES.has(redirect.target)) continue;
        const absolute = path.resolve(root, redirect.target);
        if (!isInside(root, absolute)) {
          return `The redirect target "${redirect.target}" is outside the workspace folder.`;
        }
      }
    }
  }
  return null;
}

/** The argv of the first command whose binary is not allowlisted, if any. */
export function refusedArgv(parsed: ParsedShell): string[] | null {
  for (const statement of parsed.statements) {
    for (const command of statement.commands) {
      const binary = command.argv[0];
      if (binary && !ALLOWED_COMMANDS.includes(binary)) return command.argv;
    }
  }
  return null;
}

/** Validates a parsed command against the allowlist and the workspace. */
export function validateShell(parsed: ParsedShell, root: string): string | null {
  const pathProblem = checkPaths(parsed, root);
  if (pathProblem) return pathProblem;

  for (const statement of parsed.statements) {
    for (const command of statement.commands) {
      const binary = command.argv[0];
      if (!binary) return 'A command in the pipeline is empty.';
      if (!ALLOWED_COMMANDS.includes(binary)) return binaryHint(binary);
    }
  }
  return null;
}

/** Renders one command the way the worker wrote it, for the summary line. */
function renderCommand(command: SimpleCommand): string {
  const parts = [...command.argv];
  if (command.mergeStderr) parts.push('2>&1');
  for (const redirect of command.redirects) {
    const operator =
      redirect.kind === 'stdin' ? '<' : redirect.kind === 'stderr' ? (redirect.append ? '2>>' : '2>') : redirect.append ? '>>' : '>';
    parts.push(operator, redirect.target);
  }
  return parts.join(' ');
}

interface StageResult {
  code: number;
  stdoutText: string;
  stderrText: string;
  error?: string;
  timedOut: boolean;
}

function cap(text: string, limit = MAX_CAPTURE_BYTES): string {
  if (Buffer.byteLength(text) <= limit) return text;
  return `${Buffer.from(text).subarray(0, limit).toString('utf8')}\n… output truncated at ${limit} bytes.`;
}

let jailNoticeShown = false;

/** The sandbox argv for one stage, or null when the jail is off or unusable. */
function jailed(
  command: SimpleCommand,
  cwd: string,
  root: string,
): { command: string; args: string[] } | null {
  if (!JAIL_ENABLED) return null;
  const plan = planJail({
    argv: command.argv,
    cwd,
    root,
    home: JAIL_HOME_DIR,
    net: JAIL_NET,
    readOnly: toolchainRoots(),
  });
  if (plan.ok) return { command: plan.command, args: plan.args };
  if (!jailNoticeShown) {
    jailNoticeShown = true;
    console.warn(`[jail] commands are not sandboxed: ${plan.reason}`);
  }
  return null;
}

async function runStage(
  command: SimpleCommand,
  cwd: string,
  input: string | null,
  timeoutMs: number,
): Promise<StageResult> {
  const [binary, ...args] = command.argv;
  if (!binary) {
    return { code: 127, stdoutText: '', stderrText: 'Empty command.', timedOut: false };
  }

  return new Promise((resolve) => {
    let stdoutText = '';
    let stderrText = '';
    let settled = false;
    let timedOut = false;

    const sandbox = jailed(command, cwd, cwd);
    const child = spawn(sandbox?.command ?? binary, sandbox?.args ?? args, {
      cwd,
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        HOME: cwd,
        LANG: process.env.LANG ?? 'C.UTF-8',
        TERM: 'dumb',
        // A script that asks for a port should find the one the worker chose.
        ...(process.env.PORT ? { PORT: process.env.PORT } : {}),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (stdoutText.length < MAX_CAPTURE_BYTES) stdoutText += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      if (stderrText.length < MAX_CAPTURE_BYTES) stderrText += chunk;
    });

    child.on('error', (error: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        code: 127,
        stdoutText: '',
        stderrText:
          error.code === 'ENOENT'
            ? `"${binary}" is not installed in the sandbox.`
            : `Could not start "${binary}": ${error.message}`,
        timedOut: false,
      });
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdoutText, stderrText, timedOut });
    });

    if (child.stdin) {
      child.stdin.on('error', () => {
        /* a stage that exits early closes its stdin — that is normal */
      });
      child.stdin.end(input ?? '');
    }
  });
}

interface StatementResult {
  ok: boolean;
  output: string;
  code: number;
  steps: string[];
  /** A statement the connector skipped, or an empty-output note. */
  note: string;
  timedOut: boolean;
}

async function runStatement(
  statement: Statement,
  cwd: string,
  timeoutMs: number,
): Promise<StatementResult> {
  let input: string | null = null;
  let stdoutText = '';
  let stderrText = '';
  let code = 0;
  const steps: string[] = [];

  for (const command of statement.commands) {
    const stdinRedirect = command.redirects.find((redirect) => redirect.kind === 'stdin');
    let stageInput = input;
    if (stdinRedirect) {
      try {
        stageInput = await fs.readFile(path.resolve(cwd, stdinRedirect.target), 'utf8');
      } catch (error) {
        return {
          ok: false,
          output: `Could not read ${stdinRedirect.target}: ${error instanceof Error ? error.message : 'unknown error'}`,
          code: 1,
          steps,
          note: '',
          timedOut: false,
        };
      }
    }

    const stage = await runStage(command, cwd, stageInput, timeoutMs);
    steps.push(renderCommand(command));
    code = stage.code;
    let stageOut = stage.stdoutText;
    let stageErr = stage.stderrText;

    const stdoutTarget = command.redirects.filter((redirect) => redirect.kind === 'stdout').pop();
    if (stdoutTarget) {
      // `> /dev/null` is the worker silencing output, not a file to create.
      if (stdoutTarget.target !== '/dev/null') {
        const absolute = path.resolve(cwd, stdoutTarget.target);
        try {
          await fs.mkdir(path.dirname(absolute), { recursive: true });
          await fs.writeFile(absolute, cap(stageOut), {
            flag: stdoutTarget.append ? 'a' : 'w',
            encoding: 'utf8',
          });
        } catch (error) {
          return {
            ok: false,
            output: `Could not write ${stdoutTarget.target}: ${error instanceof Error ? error.message : 'unknown error'}`,
            code: 1,
            steps,
            note: '',
            timedOut: false,
          };
        }
      }
      stageOut = '';
    }

    const stderrTarget = command.redirects.filter((redirect) => redirect.kind === 'stderr').pop();
    if (stderrTarget) {
      if (stderrTarget.target !== '/dev/null') {
        const absolute = path.resolve(cwd, stderrTarget.target);
        try {
          await fs.mkdir(path.dirname(absolute), { recursive: true });
          await fs.writeFile(absolute, cap(stageErr), {
            flag: stderrTarget.append ? 'a' : 'w',
            encoding: 'utf8',
          });
        } catch {
          /* stderr logging must never fail the command */
        }
      }
      stageErr = '';
    }

    if (command.mergeStderr && stageErr.length > 0) {
      stageOut = stageOut.length > 0 ? `${stageOut}${stageOut.endsWith('\n') ? '' : '\n'}${stageErr}` : stageErr;
      stageErr = '';
    }

    if (stage.error) stderrText += `${stage.error}\n`;
    if (stage.timedOut) {
      return {
        ok: false,
        output: [
          stderrText,
          `\`${command.argv[0]}\` did not finish within ${Math.round(timeoutMs / 1000)}s and was killed.`,
          'If it is a server, watcher or build that keeps running, start it with start_process and read it with process_logs.',
        ]
          .filter((line) => line.length > 0)
          .join('\n'),
        code: 124,
        steps,
        note: '',
        timedOut: true,
      };
    }

    stdoutText = stageOut;
    stderrText += stageErr;
    input = stageOut;
  }

  // Exit 1 with a clean stderr is the ordinary "no match" of a search tool.
  const searchTool = statement.commands[statement.commands.length - 1]?.argv[0] ?? '';
  const noMatch = code === 1 && stderrText.trim().length === 0 && ['grep', 'rg', 'diff'].includes(searchTool);

  const combined = [stdoutText.trimEnd(), stderrText.trimEnd()].filter((part) => part.length > 0).join('\n');
  return {
    ok: code === 0 || noMatch,
    output: combined.length > 0 ? combined : code === 0 ? '' : `Exited with code ${code} and printed nothing.`,
    code,
    steps,
    note: noMatch && combined.length === 0 ? 'no matches' : '',
    timedOut: false,
  };
}

function keepLines(text: string, maxLines: number): string {
  if (maxLines <= 0) return text;
  const lines = text.split('\n');
  if (lines.length <= maxLines) return text;
  return `${lines.slice(0, maxLines).join('\n')}\n… ${lines.length - maxLines} more line(s); raise max_lines or pipe through tail.`;
}

/**
 * Runs one command line the way a shell would, minus the shell: pipelines,
 * `>`/`>>`/`<`, `2>&1`, `&&`, `||` and `;` all work, and nothing is
 * interpreted by a second parser that could be injected.
 */
export async function runShell(
  raw: string,
  options: { cwd: string; maxLines?: number; timeoutMs?: number },
): Promise<ShellOutcome> {
  const parsed = parseShell(raw);
  if (!parsed.ok) {
    return {
      ok: false,
      output: `Did not run: ${parsed.message}`,
      steps: [],
      exitCode: 2,
      rejected: true,
      note: '',
    };
  }

  const problem = validateShell(parsed.parsed, options.cwd);
  if (problem) {
    // A refusal is only a repair if the runtime can act on it, so hand back the
    // tool call that replaces the binary instead of a sentence about it.
    const refused = refusedArgv(parsed.parsed);
    const remedy = refused ? remedyFor(refused) : null;
    return {
      ok: false,
      output: `Did not run: ${problem}`,
      steps: [],
      exitCode: 2,
      rejected: true,
      note: '',
      ...(remedy ? { remedy } : {}),
    };
  }

  const timeoutMs = options.timeoutMs ?? COMMAND_TIMEOUT_MS;
  const segments: string[] = [];
  const steps: string[] = [];
  const notes: string[] = [];
  let code = 0;
  let ok = true;
  let skipped = 0;

  for (const statement of parsed.parsed.statements) {
    if (statement.connector === '&&' && code !== 0) {
      skipped += 1;
      continue;
    }
    if (statement.connector === '||' && code === 0) {
      skipped += 1;
      continue;
    }
    const result = await runStatement(statement, options.cwd, timeoutMs);
    steps.push(...result.steps);
    if (result.note) notes.push(result.note);
    if (result.output.trim().length > 0) segments.push(result.output.trimEnd());
    code = result.code;
    // A search tool that found nothing exits 1 but is still a result.
    ok = result.ok;
    if (result.timedOut) break;
  }

  if (skipped > 0) notes.push(`${skipped} statement(s) skipped by && / ||`);
  const joined = segments.join('\n');
  return {
    ok,
    output: keepLines(joined.slice(0, 8000) || '', options.maxLines ?? 0),
    steps,
    exitCode: code,
    rejected: false,
    note: notes.join(', '),
  };
}

/**
 * The argv of a single plain command, so a long-running process is started
 * without a shell either — `sh -c` here would re-open the expansion surface the
 * parser just closed.
 */
export function toArgv(raw: string): { ok: true; argv: string[] } | { ok: false; message: string } {
  const parsed = parseShell(raw);
  if (!parsed.ok) return { ok: false, message: parsed.message };
  const command = parsed.parsed.statements[0]?.commands[0];
  if (!command || command.argv.length === 0) return { ok: false, message: 'The command is empty.' };
  return { ok: true, argv: [...command.argv] };
}

/** True when the line is a single plain command (no pipes, redirects, chains). */
export function isSingleCommand(raw: string): { ok: true } | { ok: false; message: string } {
  const parsed = parseShell(raw);
  if (!parsed.ok) return { ok: false, message: parsed.message };
  if (parsed.parsed.statements.length > 1) {
    return { ok: false, message: 'start_process takes one command, not a chain — start one process per server.' };
  }
  const statement = parsed.parsed.statements[0];
  if (!statement || statement.commands.length > 1) {
    return { ok: false, message: 'start_process takes one command, not a pipeline.' };
  }
  const command = statement.commands[0];
  if (command && (command.redirects.length > 0 || command.mergeStderr)) {
    return {
      ok: false,
      message: 'start_process writes the output to its own log; drop the redirect and read process_logs instead.',
    };
  }
  return { ok: true };
}

export { MAX_FILE_BYTES };
