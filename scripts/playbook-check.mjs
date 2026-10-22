/**
 * Every role pack has a mission, and every mission's yardstick can tell a good
 * tree from a plausible one.
 *
 * This is the offline half of the playbook evaluation. It never calls a model:
 * it applies the fixture's `mock` (what a worker who follows the pack writes),
 * requires `accept` to pass, then applies `breakIt` — the realistic way to look
 * done without being done — and requires `accept` to fail. A yardstick that
 * accepts both trees is a check that proves nothing, which is exactly the
 * failure mode a "quality eval" usually has.
 *
 * It also pins the joins that are easy to leave dangling:
 *   - every pack in `rolePacks.ts` has exactly one mission (and every mission
 *     claims a pack that exists);
 *   - the fixture's `proves` line is really a bullet in that pack's `done`
 *     list, so the mission measures the bar the prompt states;
 *   - the fixture's brief passes the delegation gate, so the suite cannot drift
 *     into missions a lead would be refused for writing.
 *
 * The model run lives in `scripts/eval-playbook.mjs` (`npm run eval:playbook`),
 * which reuses these same fixtures and this same `accept`.
 *
 *   npm run check:playbook
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';
import { checkBrief } from '../server/src/brief.ts';
import {
  attributeRefusal,
  packLogLine,
  playbook,
  rankTaskSignals,
  resolvePackChoice,
  resolveRolePack,
  summariseRefusals,
} from '../server/src/rolePacks.ts';
import { messages } from '../shared/i18n.ts';
import { PACK_LABEL_KEYS } from '../shared/packs.ts';
import { logTemplates } from '../shared/wording.ts';
import { PLAYBOOK_TASKS } from '../evals/playbook.mjs';

const execFileAsync = promisify(execFile);
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

const packs = playbook().packs;
const doctrine = playbook().doctrine;

/** The eval harness gives acceptance these helpers; the offline replay needs the same shape. */
function bind(root) {
  return {
    root,
    read: (relative) => fs.readFile(path.join(root, relative), 'utf8'),
    write: async (relative, content) => {
      const target = path.join(root, relative);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, content, 'utf8');
    },
    exists: (relative) =>
      fs
        .access(path.join(root, relative))
        .then(() => true)
        .catch(() => false),
    walk: async () => {
      const found = [];
      const visit = async (relative) => {
        const entries = await fs.readdir(path.join(root, relative), { withFileTypes: true }).catch(() => []);
        for (const entry of entries) {
          if (['node_modules', '.git', '.agent-office', 'dist'].includes(entry.name)) continue;
          const next = relative ? `${relative}/${entry.name}` : entry.name;
          if (entry.isDirectory()) await visit(next);
          else found.push(next);
        }
      };
      await visit('');
      return found.sort();
    },
    run: (command, args = []) =>
      execFileAsync(command, args, { cwd: root, timeout: 60_000 }).then(
        (value) => ({ code: 0, output: `${value.stdout}${value.stderr}` }),
        (error) => ({
          code: typeof error.code === 'number' ? error.code : 1,
          output: `${error.stdout ?? ''}${error.stderr ?? ''}`,
        }),
      ),
  };
}

/** Builds a tree from the fixture, then applies the writes its mock plan makes. */
async function materialise(fixture, mutate) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `aegisx-pack-${fixture.id}-`));
  const context = bind(root);
  for (const [relative, content] of Object.entries(fixture.files ?? {})) {
    await context.write(relative, content);
  }
  for (const step of fixture.mock ?? []) {
    if (step.tool === 'write_file') await context.write(step.args.path, step.args.content);
  }
  if (mutate) await fixture.breakIt(context);
  return { root, context };
}

/** The harness passes these extra fields; the offline replay fakes only the board. */
function acceptanceArgs(context, fixture) {
  return {
    ...context,
    files: fixture.files ?? {},
    board: { task: { status: 'done' }, tasks: [], agents: [] },
    usage: { own: {}, rolled: {} },
  };
}

console.log('\n[playbook] coverage');

await check('every pack has exactly one mission', () => {
  const covered = PLAYBOOK_TASKS.map((fixture) => fixture.pack).sort();
  const expected = packs.map((pack) => pack.id).sort();
  const missing = expected.filter((id) => !covered.includes(id));
  const duplicated = covered.filter((id, index) => covered.indexOf(id) !== index);
  assert.deepEqual(missing, [], `packs with no mission: ${missing.join(', ')}`);
  assert.deepEqual(duplicated, [], `packs with two missions: ${duplicated.join(', ')}`);
  assert.deepEqual(covered, expected, 'a mission claims a pack that does not exist');
});

await check('each mission measures a bullet the pack actually states', () => {
  const dangling = [];
  for (const fixture of PLAYBOOK_TASKS) {
    const pack = packs.find((entry) => entry.id === fixture.pack);
    if (!pack || !pack.done.some((line) => line.includes(fixture.proves))) {
      dangling.push(`${fixture.id}: "${fixture.proves}"`);
    }
  }
  assert.deepEqual(dangling, [], `missions measuring a bar nobody wrote: ${dangling.join('; ')}`);
});

await check('each mission is a brief the lead would be allowed to write', () => {
  const refused = PLAYBOOK_TASKS.filter((fixture) => !checkBrief({ title: fixture.title, detail: fixture.detail }).ok);
  assert.deepEqual(refused.map((fixture) => fixture.id), [], 'a mission would be refused by the brief gate');
});

await check('each mission runs under the pack it claims', () => {
  const mismatched = PLAYBOOK_TASKS.filter((fixture) => resolveRolePack(fixture.role).id !== fixture.pack);
  assert.deepEqual(
    mismatched.map((fixture) => `${fixture.id}: ${fixture.role} → ${resolveRolePack(fixture.role).id}`),
    [],
  );
});

await check('the doctrine that frames the suite is the shipped one', () => {
  assert.equal(doctrine.length, 7);
  assert.match(doctrine[0]?.title ?? '', /prompt engineering/i);
});

console.log('\n[playbook] which pack a turn runs under');

await check('an artefact in the brief outweighs a keyword from another pack', () => {
  const brief = 'Touch site/checkout.html, then run the ETL backfill and check the row count.';
  const choice = resolvePackChoice({ role: 'Engineer', title: 'Restyle the checkout', detail: brief });
  assert.equal(choice.pack.id, 'frontend');
  assert.equal(choice.source, 'brief');
  assert.equal(choice.evidence, 'site/checkout.html');

  const ranked = rankTaskSignals(brief);
  assert.equal(ranked[0]?.id, 'frontend');
  assert.equal(ranked[0]?.score, 3, 'a named file is worth three points');
  assert.ok(
    (ranked.find((entry) => entry.id === 'data')?.score ?? 0) < 3,
    'plain words must not tie a real file',
  );
});

await check('a second word in one signal beats a single word', () => {
  const [pair] = rankTaskSignals('Add a responsive button');
  const [single] = rankTaskSignals('Add a button');
  assert.equal(pair?.score, 2, `two distinct words scored ${pair?.score}`);
  assert.equal(single?.score, 1, `one word scored ${single?.score}`);
  assert.equal(pair?.evidence, 'responsive, button');
});

await check('the choice records who made it and what decided it', () => {
  const operator = resolvePackChoice({ role: 'Frontend Engineer', pack: 'qa', title: 'x', detail: 'y' });
  assert.deepEqual([operator.pack.id, operator.source], ['qa', 'operator']);

  const role = resolvePackChoice({ role: 'Data Engineer', title: 'write a prompt', detail: '' });
  assert.deepEqual([role.pack.id, role.source], ['data', 'role']);

  const brief = resolvePackChoice({ role: 'Engineer', title: 'Fix index.html', detail: '' });
  assert.deepEqual([brief.pack.id, brief.source, brief.evidence], ['frontend', 'brief', 'index.html']);

  const none = resolvePackChoice({ role: 'Engineer', title: 'Rename the constant', detail: '' });
  assert.deepEqual([none.pack.id, none.source, none.evidence], ['general', 'default', null]);
});

await check('a tie between packs is reported instead of hidden', () => {
  // One word each: the choice still has to be made, but the operator is told
  // there was another reading of the same brief.
  const choice = resolvePackChoice({ role: 'Engineer', title: 'Add a regression test to the button', detail: '' });
  assert.equal(choice.source, 'brief');
  assert.equal(choice.pack.id, 'frontend');
  assert.deepEqual(choice.alsoMatched, ['qa']);
});

await check('the log line names the pack, the reason, and matches its dictionary row', () => {
  const templates = logTemplates().find((entry) => entry.kind === 'task.pack')?.templates ?? [];
  assert.equal(templates.length, 5, `task.pack has ${templates.length} templates, expected 5`);
  const englishOf = (key) => {
    const template = templates.find((entry) => entry.key === key);
    assert.ok(template, `${key} is not in the task.pack table`);
    return template;
  };

  const lines = {
    operator: packLogLine(resolvePackChoice({ role: 'Engineer', pack: 'data', title: 'Ship', detail: '' }), 'Aria', 'Ship'),
    role: packLogLine(resolvePackChoice({ role: 'Data Engineer', title: 'Ship', detail: '' }), 'Aria', 'Ship'),
    brief: packLogLine(resolvePackChoice({ role: 'Engineer', title: 'Touch site/index.html', detail: '' }), 'Aria', 'Ship'),
    default: packLogLine(resolvePackChoice({ role: 'Engineer', title: 'Rename it', detail: '' }), 'Aria', 'Ship'),
  };
  const fill = (key, params) =>
    englishOf(key).text.replace(/\{(\w+)\}/g, (match, name) => params[name] ?? match);
  const expected = {
    operator: fill('log.task.packOperator', { name: 'Aria', title: 'Ship', pack: 'data' }),
    role: fill('log.task.packRole', { name: 'Aria', title: 'Ship', pack: 'data' }),
    brief: fill('log.task.packBrief', { name: 'Aria', title: 'Ship', pack: 'frontend', evidence: 'site/index.html' }),
    default: fill('log.task.packDefault', { name: 'Aria', title: 'Ship', pack: 'general' }),
  };

  // The template and the real line must be the same sentence: a template that
  // drifts stops translating the log, and nobody notices from the board.
  for (const [source, line] of Object.entries(lines)) {
    assert.equal(line, expected[source], `the ${source} line drifted from its template`);
  }
  assert.match(lines.operator, /under the data playbook: the operator chose it\./);
  assert.match(lines.brief, /\(site\/index\.html\)/);
  assert.match(lines.default, /falls back to the general pack/);

  // A tie is the one case where the log has to admit the guess was a guess.
  const tied = packLogLine(
    resolvePackChoice({ role: 'Engineer', title: 'Add a regression test to the button', detail: '' }),
    'Aria',
    'Ship',
  );
  assert.equal(
    tied,
    fill('log.task.packBriefTie', {
      name: 'Aria',
      title: 'Ship',
      pack: 'frontend',
      evidence: 'button',
      also: 'qa',
    }),
    'the tie line drifted from its template',
  );
});

await check('every pack has a name on the board, and the English one is its label', () => {
  const table = messages();
  const ids = packs.map((pack) => pack.id).sort();
  assert.deepEqual(Object.keys(PACK_LABEL_KEYS).sort(), ids, 'the label table and the packs disagree');
  for (const pack of packs) {
    const key = PACK_LABEL_KEYS[pack.id];
    assert.equal(table[key]?.en, pack.label, `${pack.id} is labelled ${table[key]?.en}, pack says ${pack.label}`);
  }
});

console.log('\n[playbook] review refusals as evidence about the packs');

await check('a refusal is matched to the rule it cites', () => {
  const frontend = packs.find((pack) => pack.id === 'frontend');
  const qa = packs.find((pack) => pack.id === 'qa');
  assert.equal(
    attributeRefusal(['The component was never checked in a browser, so its states are unproven.'], frontend),
    1,
    'the browser rule is the second one in the frontend pack',
  );
  assert.equal(
    attributeRefusal(['The fix skipped the regression test and loosened the assertion.'], qa),
    0,
    'the skipped-test rule is the first one in the qa pack',
  );
  assert.equal(
    attributeRefusal(['Looks fine to me.'], frontend),
    null,
    'a refusal that cites no rule must not be forced onto one',
  );
});

await check('refusals are ranked by pack, and unmatched ones are counted', () => {
  const summary = summariseRefusals([
    {
      id: 'task_a',
      reviewRefusals: [
        { at: 1, pack: 'frontend', reasons: ['The component was never checked in a browser.'] },
        { at: 2, pack: 'frontend', reasons: ['A component that only works at one width and was not checked in a browser.'] },
      ],
    },
    {
      id: 'task_b',
      reviewRefusals: [{ at: 3, pack: 'qa', reasons: ['The fix skipped the regression test and loosened the assertion.'] }],
    },
    { id: 'task_c', reviewRefusals: [{ at: 4, pack: 'invented', reasons: ['Ship it.'] }] },
  ]);

  assert.equal(summary.total, 4);
  assert.deepEqual(summary.packs.map((entry) => entry.pack), ['frontend', 'qa', 'general']);
  assert.deepEqual(summary.packs[0], { pack: 'frontend', count: 2, rules: [{ rule: 1, count: 2 }], unmatched: 0 });
  assert.deepEqual(summary.packs[1], { pack: 'qa', count: 1, rules: [{ rule: 0, count: 1 }], unmatched: 0 });
  assert.deepEqual(summary.packs[2], { pack: 'general', count: 1, rules: [], unmatched: 1 });
  assert.equal(playbook([{ id: 'task_a', reviewRefusals: [{ at: 1, pack: 'qa', reasons: [] }] }]).refusals.total, 1);
});

console.log('\n[playbook] each yardstick passes the good tree and refuses the broken one');

for (const fixture of PLAYBOOK_TASKS) {
  await check(`${fixture.id}: a worker who follows the pack passes`, async () => {
    const { root, context } = await materialise(fixture, false);
    try {
      await fixture.accept(acceptanceArgs(context, fixture));
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  await check(`${fixture.id}: looking done without being done is refused`, async () => {
    const { root, context } = await materialise(fixture, true);
    try {
      let refused = false;
      try {
        await fixture.accept(acceptanceArgs(context, fixture));
      } catch {
        refused = true;
      }
      assert.ok(refused, 'the yardstick accepted a tree that only looks finished');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
}

const failed = results.filter((entry) => !entry.ok);
console.log(`\n[playbook] ${results.length - failed.length}/${results.length} checks passed (${PLAYBOOK_TASKS.length} missions, no model).`);
if (failed.length > 0) {
  console.log(`Failed: ${failed.map((entry) => entry.label).join(' · ')}`);
  process.exitCode = 1;
}
