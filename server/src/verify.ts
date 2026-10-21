import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { VERIFY_TIMEOUT_MS } from './config.ts';

/** One command the gate will run, resolved once when the task starts. */
export interface VerificationCheck {
  name: string;
  bin: string;
  args: string[];
}

/**
 * What the gate is allowed to run for a task. It is captured *before* the
 * worker touches the folder, so a script the model writes mid-task can never
 * become part of the automatic gate.
 */
export interface VerificationPlan {
  root: string;
  checks: VerificationCheck[];
  notes: string[];
}

export interface VerificationOutcome {
  name: string;
  ok: boolean;
  output: string;
}

export interface VerificationReport {
  ok: boolean;
  ran: VerificationOutcome[];
  notes: string[];
}

const OUTPUT_LIMIT = 2_500;
const ANSI = /\u001b\[[0-9;]*m/g;

async function exists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function readJsonObject(target: string): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(target, 'utf8'));
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Reads `scripts` from a package.json without trusting its shape. */
function readScripts(manifest: Record<string, unknown>): Record<string, string> {
  const raw = manifest.scripts;
  if (typeof raw !== 'object' || raw === null) return {};
  const scripts: Record<string, string> = {};
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === 'string' && value.trim().length > 0) scripts[name] = value.trim();
  }
  return scripts;
}

/** npm's placeholder test script means "no tests here", not a test suite. */
function isPlaceholderTest(script: string | undefined): boolean {
  if (!script) return true;
  return /no test specified/i.test(script);
}

/**
 * Works out which checks apply to this folder, once, at task start.
 * Only tools that are already installed are used — the gate never runs
 * `npm install`, so a slow dependency download can never look like a failure.
 */
export async function captureVerificationPlan(root: string): Promise<VerificationPlan> {
  const checks: VerificationCheck[] = [];
  const notes: string[] = [];

  const manifest = await readJsonObject(path.join(root, 'package.json'));
  if (manifest) {
    const scripts = readScripts(manifest);
    const hasModules = await exists(path.join(root, 'node_modules'));
    const localTsc = path.join(root, 'node_modules', '.bin', 'tsc');

    if (await exists(path.join(root, 'tsconfig.json'))) {
      if (await exists(localTsc)) {
        checks.push({ name: 'typecheck', bin: localTsc, args: ['--noEmit', '-p', '.'] });
      } else {
        notes.push('tsconfig.json found but typescript is not installed — typecheck skipped.');
      }
    }
    if (scripts.typecheck && !checks.some((check) => check.name === 'typecheck')) {
      if (hasModules) checks.push({ name: 'typecheck (script)', bin: 'npm', args: ['run', 'typecheck', '--silent'] });
      else notes.push('typecheck script found but node_modules is missing — skipped.');
    }
    if (!isPlaceholderTest(scripts.test)) {
      if (hasModules) checks.push({ name: 'test', bin: 'npm', args: ['test', '--silent'] });
      else notes.push('test script found but node_modules is missing — skipped.');
    }
    if (scripts.build && hasModules && scripts.build !== scripts.start) {
      checks.push({ name: 'build', bin: 'npm', args: ['run', 'build', '--silent'] });
    }
  }

  if (await exists(path.join(root, 'go.mod'))) {
    checks.push({ name: 'go vet', bin: 'go', args: ['vet', './...'] });
  }

  const hasPython =
    (await exists(path.join(root, 'pyproject.toml'))) ||
    (await exists(path.join(root, 'pytest.ini'))) ||
    (await exists(path.join(root, 'tests'))) ||
    (await exists(path.join(root, 'test')));
  if (hasPython) {
    checks.push({ name: 'pytest', bin: 'python3', args: ['-m', 'pytest', '-q'] });
  }

  if (checks.length === 0 && !manifest) {
    notes.push('No test or typecheck tooling detected — only the rendered-page check will run.');
  }
  return { root, checks, notes };
}

function runCheck(root: string, check: VerificationCheck): Promise<VerificationOutcome> {
  return new Promise((resolve) => {
    execFile(
      check.bin,
      check.args,
      {
        cwd: root,
        timeout: VERIFY_TIMEOUT_MS,
        maxBuffer: 4 * 1024 * 1024,
        env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: root, CI: '1', NO_COLOR: '1' },
      },
      (error, stdout, stderr) => {
        const combined = `${stdout}${stderr}`.replace(ANSI, '').trim();
        if (!error) {
          resolve({ name: check.name, ok: true, output: combined.slice(-OUTPUT_LIMIT) });
          return;
        }
        const tail = combined.length > 0 ? combined : error.message;
        resolve({ name: check.name, ok: false, output: tail.slice(-OUTPUT_LIMIT) });
      },
    );
  });
}

const LOCAL_REF = /\b(?:src|href)=["']([^"']+)["']/g;

/**
 * Every local file an HTML page points at must exist. This is the check that
 * catches the most common web failure: a stylesheet or script the model
 * referenced but never wrote.
 */
export async function findMissingAssets(root: string, htmlRelative = 'index.html'): Promise<string[]> {
  const htmlPath = path.resolve(root, htmlRelative);
  if (!htmlPath.startsWith(path.resolve(root))) return [];
  let html: string;
  try {
    html = await fs.readFile(htmlPath, 'utf8');
  } catch {
    return [];
  }

  const missing: string[] = [];
  for (const match of html.matchAll(LOCAL_REF)) {
    const reference = match[1]?.trim();
    if (!reference) continue;
    if (/^(?:https?:|mailto:|tel:|data:|javascript:|#|\/\/)/i.test(reference)) continue;
    const clean = reference.split(/[?#]/)[0] ?? '';
    if (clean.length === 0) continue;
    const target = path.resolve(path.dirname(htmlPath), clean.replace(/^\//, ''));
    if (!target.startsWith(path.resolve(root))) {
      missing.push(`${reference} (points outside the folder)`);
      continue;
    }
    if (!(await exists(target))) missing.push(reference);
  }
  return [...new Set(missing)];
}

/**
 * Runs the captured plan, stopping at the first failure so the worker gets one
 * clear thing to fix instead of a wall of cascading errors.
 */
export async function runVerificationPlan(plan: VerificationPlan): Promise<VerificationReport> {
  const ran: VerificationOutcome[] = [];
  const notes = [...plan.notes];

  for (let index = 0; index < plan.checks.length; index += 1) {
    const check = plan.checks[index];
    if (!check) continue;
    const outcome = await runCheck(plan.root, check);
    ran.push(outcome);
    if (!outcome.ok) {
      const skipped = plan.checks.slice(index + 1).map((entry) => entry.name);
      if (skipped.length > 0) notes.push(`Not run because ${check.name} failed: ${skipped.join(', ')}.`);
      return { ok: false, ran, notes };
    }
  }

  if (await exists(path.join(plan.root, 'index.html'))) {
    const missing = await findMissingAssets(plan.root);
    ran.push({
      name: 'rendered page references',
      ok: missing.length === 0,
      output: missing.length === 0 ? 'Every local asset the page links to exists.' : `Missing: ${missing.join(', ')}`,
    });
    if (missing.length > 0) return { ok: false, ran, notes };
  }

  return { ok: true, ran, notes };
}

/** Human-readable failure text handed to the model and the activity log. */
export function describeVerificationFailure(report: VerificationReport): string {
  const failed = report.ran.find((outcome) => !outcome.ok);
  if (!failed) return 'Verification failed.';
  const tail = failed.output.split('\n').slice(-25).join('\n');
  return `\`${failed.name}\` failed:\n${tail}`;
}
