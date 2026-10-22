/**
 * The playbook suite against a model.
 *
 * `check:playbook` proves the yardsticks work; this proves what a real worker
 * does under each pack. It is opt-in because it spends credit — the default
 * `npm run check` never calls a model.
 *
 *   npm run eval:playbook            # live, needs OFFICE_API_KEY (or .env)
 *   npm run eval:playbook -- --mock  # replays the scripted plans, no credit
 *   npm run eval:playbook -- --only pack-qa --min-pass-rate 0.8
 *   npm run eval:playbook -- --save evals/baseline.json
 *   npm run eval:playbook -- --baseline evals/baseline.json
 *
 * Mock mode is a harness test: a failure there means the runner or a fixture is
 * broken, so it exits non-zero. A live run reports its numbers and exits clean
 * unless `--min-pass-rate` asks for a gate, or a mission that passed on the
 * baseline fails now — a pack that regressed is not a number to admire.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import process from 'node:process';
import { PLAYBOOK_TASKS } from '../evals/playbook.mjs';
import { runEval } from './eval.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');

function parseArgs(argv) {
  const options = {
    mode: 'live',
    only: [],
    minPassRate: undefined,
    baseline: undefined,
    save: undefined,
    taskTimeoutMs: undefined,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const next = () => {
      index += 1;
      if (index >= argv.length) throw new Error(`${flag} needs a value`);
      return argv[index];
    };
    switch (flag) {
      case '--mock':
        options.mode = 'mock';
        break;
      case '--live':
        options.mode = 'live';
        break;
      case '--only':
        options.only.push(...next().split(',').map((entry) => entry.trim()).filter(Boolean));
        break;
      case '--min-pass-rate':
        options.minPassRate = Number(next());
        break;
      case '--baseline':
        options.baseline = next();
        break;
      case '--save':
        options.save = next();
        break;
      case '--task-timeout':
        options.taskTimeoutMs = Number(next());
        break;
      default:
        throw new Error(`Unknown flag: ${flag}`);
    }
  }
  return options;
}

function pad(value, width) {
  return String(value).padEnd(width);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  let suite = PLAYBOOK_TASKS;
  if (options.only.length > 0) {
    const wanted = new Set(options.only);
    suite = PLAYBOOK_TASKS.filter((fixture) => wanted.has(fixture.id));
    if (suite.length === 0) throw new Error(`No mission matched ${options.only.join(', ')}`);
  }

  const report = await runEval({
    mode: options.mode,
    tasks: suite,
    taskTimeoutMs: Number.isFinite(options.taskTimeoutMs) ? options.taskTimeoutMs : undefined,
    onTask: (result) => {
      console.log(`  ${result.passed ? '✓' : '✗'} ${pad(result.id, 18)} ${result.reason}`);
    },
  });

  console.log('\npack            mission            result  reason');
  console.log('-'.repeat(86));
  for (const entry of report.tasks) {
    const fixture = PLAYBOOK_TASKS.find((candidate) => candidate.id === entry.id);
    console.log(
      `${pad(fixture?.pack ?? '?', 15)} ${pad(entry.id, 18)} ${pad(entry.passed ? 'pass' : 'FAIL', 6)}  ${entry.reason.slice(0, 40)}`,
    );
  }

  const { totals } = report;
  console.log(
    `\n[playbook] ${totals.passed}/${totals.tasks} passed (${Math.round(totals.passRate * 100)}%) · ` +
      `${totals.totalTokens} tokens · $${totals.costUsd.toFixed(4)} · ${report.mode}`,
  );

  // Per-pack numbers are the point of the suite: a pack that never passes is a
  // pack whose bar is wrong (or whose mission is), and the total hides that.
  const byPack = new Map();
  for (const entry of report.tasks) {
    const fixture = PLAYBOOK_TASKS.find((candidate) => candidate.id === entry.id);
    if (!fixture) continue;
    const bucket = byPack.get(fixture.pack) ?? { passed: 0, total: 0 };
    bucket.total += 1;
    bucket.passed += entry.passed ? 1 : 0;
    byPack.set(fixture.pack, bucket);
  }
  const failing = [...byPack.entries()].filter(([, bucket]) => bucket.passed < bucket.total);
  console.log(`packs: ${byPack.size - failing.length}/${byPack.size} clean`);
  if (failing.length > 0) console.log(`failing packs: ${failing.map(([pack]) => pack).join(', ')}`);

  const target = path.join(
    REPO_ROOT,
    '.agent-office',
    'evals',
    `playbook-${report.mode}-${report.startedAt.replace(/[:.]/g, '-')}.json`,
  );
  await writeReport(report, target);
  console.log(`Report: ${target}`);
  if (options.save) {
    await writeReport(report, path.resolve(REPO_ROOT, options.save));
    console.log(`Saved: ${path.resolve(REPO_ROOT, options.save)}`);
  }

  if (options.minPassRate !== undefined && totals.passRate < options.minPassRate) {
    console.log(`\nBelow the required pass rate: ${Math.round(totals.passRate * 100)}% < ${Math.round(options.minPassRate * 100)}%.`);
    process.exitCode = 1;
  }
  if (options.baseline) {
    const regressions = await compareWithBaseline(path.resolve(REPO_ROOT, options.baseline), report);
    if (regressions.length > 0) {
      console.log(`\nRegressed against the baseline: ${regressions.join(', ')}.`);
      process.exitCode = 1;
    }
  }
  if (report.mode === 'mock' && totals.failed > 0) process.exitCode = 1;
}

async function writeReport(report, target) {
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, `${JSON.stringify(report, null, 2)}\n`);
}

/**
 * A mission that passed on the baseline and fails now is a regression, and a
 * regression is the only result this suite should ever fail on. A mission that
 * fails both times is a known cost of the pack's bar, not news.
 */
export async function compareWithBaseline(baselinePath, report) {
  const baseline = JSON.parse(await fs.readFile(baselinePath, 'utf8'));
  if (baseline.mode !== report.mode) {
    console.log(
      `\nNo comparison: the baseline is a ${baseline.mode} run and this is a ${report.mode} run.`,
    );
    return [];
  }

  const before = new Map((baseline.tasks ?? []).map((entry) => [entry.id, entry]));
  const regressions = [];
  console.log(`\nAgainst ${baseline.startedAt} (${baseline.model}):`);
  for (const entry of report.tasks) {
    const previous = before.get(entry.id);
    if (!previous) {
      console.log(`  ${pad(entry.id, 18)} new`);
      continue;
    }
    const verdict = previous.passed === entry.passed ? 'same' : entry.passed ? 'FIXED' : 'BROKEN';
    if (verdict === 'BROKEN') regressions.push(entry.id);
    console.log(`  ${pad(entry.id, 18)} ${verdict}`);
  }
  return regressions;
}

const entryPoint = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (import.meta.url === entryPoint) {
  main().catch((error) => {
    console.error(`playbook eval failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
