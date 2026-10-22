/**
 * The prompt is the most-repeated text in the whole product: every round of
 * every turn pays for it again. Three things therefore have to hold.
 *
 *   1. The shared block comes first and stays small. Providers cache on the
 *      prefix, so the part every worker shares — house rules plus team
 *      doctrine — must be byte-identical between workers and turns. A block
 *      that quietly doubles costs money on every round.
 *   2. The role pack comes next. It is stable for a worker (a role rarely
 *      changes mid-task), so it is still a cache hit on the second round, but
 *      it must never leak into the shared prefix.
 *   3. The per-turn facts (roster, folder, language, memory) come last, so
 *      changing them cannot invalidate anything cached.
 *
 * It also pins the instructions that failures were expensive to learn: brief
 * before you build (the prompt-engineering rule), check a page with
 * `http_check`, do not hunt for a browser, delete scratch files, and say what
 * the jail allows.
 *
 *   npm run check:prompt
 */
import assert from 'node:assert/strict';
import process from 'node:process';
import { buildSystemPrompt, rolePackId } from '../server/src/agentRuntime.ts';
import {
  buildRoleBrief,
  doctrineBrief,
  playbook,
  ROLE_PACK_IDS,
  ROLE_PACKS,
  resolveRolePack,
} from '../server/src/rolePacks.ts';

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

/** Characters per token, the usual order-of-magnitude estimate for English. */
const CHARS_PER_TOKEN = 4;

/**
 * Ceilings for the static part, split by lifetime. The house rules were 1,232
 * tokens and the doctrine 500 the day these were set (the old single budget of
 * 1,250 was written before the terse-mode rules were added). A few lines of
 * headroom keeps a real edit from failing the suite; a doubling still does.
 */
const SHARED_BUDGET_TOKENS = 1_800;
const ROLE_BUDGET_TOKENS = 320;

/** The roster the seeded office runs. A role that lands on `general` here is a
 * matching bug, not a fallback. */
const SEEDED_ROLES = [
  'Tech Lead',
  'Frontend Engineer',
  'Backend Engineer',
  'Mobile App Engineer',
  'AI Engineer',
  'ML Engineer',
  'QA Engineer',
  'Security Engineer',
  'Data Engineer',
  'Product Manager',
  'DevOps Engineer',
];

function promptFor(role, name = 'Aria') {
  return buildSystemPrompt({
    name,
    role,
    roster: '- Nadia (Tech Lead)\n- Aria (Frontend Engineer)',
    workspace: '/home/operator/project',
    locale: 'en',
    memory: 'What earlier missions learned about this folder:\n- npm test runs the suite.',
  });
}

const prompt = promptFor('Frontend Engineer');
const rosterAt = prompt.indexOf('Office roster:');
const roleAt = prompt.indexOf('Your job as ');
const sharedBlock = prompt.slice(0, roleAt).trimEnd();
const roleBlock = prompt.slice(roleAt, rosterAt).trimEnd();
const sharedTokens = Math.round(sharedBlock.length / CHARS_PER_TOKEN);
const roleTokens = Math.round(roleBlock.length / CHARS_PER_TOKEN);

console.log('\n[prompt] size and order');

await check('the shared block stays inside its token budget', () => {
  assert.ok(sharedBlock.length > 2_000, 'the split found no shared block — has the shape changed?');
  assert.ok(
    sharedTokens <= SHARED_BUDGET_TOKENS,
    `the shared prompt is ~${sharedTokens} tokens, budget is ${SHARED_BUDGET_TOKENS}`,
  );
});

await check('the role pack stays a quarter the size of the shared block', () => {
  assert.ok(roleBlock.length > 200, 'the split found no role pack — has the shape changed?');
  assert.ok(
    roleTokens <= ROLE_BUDGET_TOKENS,
    `the role pack is ~${roleTokens} tokens, budget is ${ROLE_BUDGET_TOKENS}`,
  );
});

await check('static text comes first, per-turn facts after it', () => {
  const identityAt = prompt.indexOf('You are Aria.');
  const workspaceAt = prompt.indexOf('Workspace folder:');
  const memoryAt = prompt.indexOf('What earlier missions learned');
  assert.ok(roleAt > 0 && roleAt < rosterAt, 'the role pack must sit between the shared block and the roster');
  assert.ok(
    identityAt > roleAt && identityAt < rosterAt,
    'the worker name belongs after the role pack, never in the shared prefix',
  );
  assert.ok(workspaceAt > rosterAt, 'the workspace line belongs with the per-turn facts');
  assert.ok(memoryAt > workspaceAt, 'project memory is the last thing appended');
});

await check('the per-turn tail stays small enough to be worth caching against', () => {
  const tail = prompt.slice(rosterAt);
  const tailTokens = Math.round(tail.length / CHARS_PER_TOKEN);
  assert.ok(tailTokens < 400, `the per-turn tail is ~${tailTokens} tokens`);
});

console.log('\n[prompt] the shared prefix every worker pays for');

await check('the shared prefix is byte-identical across roles and names', () => {
  // This is the whole caching argument. If a role or a name leaks in here, the
  // first round of every worker costs a fresh prompt instead of a cache hit.
  const other = promptFor('Data Engineer', 'Bimo');
  const otherRoleAt = other.indexOf('Your job as ');
  assert.equal(
    other.slice(0, otherRoleAt).trimEnd(),
    sharedBlock,
    'the shared prefix changed with the role or the name',
  );
});

await check('the shared block carries the team doctrine', () => {
  assert.match(sharedBlock, /How this team works:/);
  for (const rule of ['Briefing is prompt engineering', 'Evidence beats assertion', 'State the contract at the boundary']) {
    assert.match(sharedBlock, new RegExp(rule), `the doctrine lost "${rule}"`);
  }
});

await check('prompt engineering is stated as a checklist, not an adjective', () => {
  // The rule only works if it names what a brief must contain; "be specific"
  // is what every failed handoff already said.
  assert.match(sharedBlock, /six things/);
  assert.match(sharedBlock, /the exact files it owns/);
  assert.match(sharedBlock, /the acceptance test that proves it/);
  assert.match(sharedBlock, /out of scope/);
  assert.match(sharedBlock, /Stable context first, the ask last/);
});

console.log('\n[prompt] the role pack');

await check('the pack names the role and its bar', () => {
  assert.match(roleBlock, /^Your job as Frontend Engineer\./);
  assert.match(roleBlock, /Craft:/);
  assert.match(roleBlock, /Done means:/);
  assert.match(roleBlock, /The reviewer refuses:/);
});

await check('every seeded role lands on its own pack, never the fallback', () => {
  const fallback = [];
  for (const role of SEEDED_ROLES) {
    const pack = resolveRolePack(role);
    if (pack.id === 'general') fallback.push(role);
  }
  assert.deepEqual(fallback, [], `roles with no playbook: ${fallback.join(', ')}`);
});

await check('each pack is reachable by its own label', () => {
  // Guards the exact bug this matching already had: a Product Manager matched
  // the lead pack through the word "manager", so its own pack was dead code.
  const mismatched = ROLE_PACKS.filter((pack) => resolveRolePack(pack.label).id !== pack.id).map(
    (pack) => `${pack.label} → ${resolveRolePack(pack.label).id}`,
  );
  assert.deepEqual(mismatched, [], `unreachable packs: ${mismatched.join(', ')}`);
});

await check('an unknown role still gets a usable playbook', () => {
  const pack = resolveRolePack('Chief Vibes Officer');
  assert.equal(pack.id, 'general');
  assert.ok(pack.craft.length > 0 && pack.done.length > 0, 'the fallback pack is empty');
  assert.match(promptFor('Chief Vibes Officer'), /Your job as Engineer\./);
});

console.log('\n[prompt] which pack a turn runs under');

const packPrompt = (role, extra = {}) =>
  buildSystemPrompt({
    name: 'Aria',
    role,
    roster: '- Nadia (Tech Lead)',
    workspace: '/home/operator/project',
    locale: 'en',
    memory: '',
    ...extra,
  });

await check('a generic role picks the pack from the brief', () => {
  const frontend = packPrompt('Engineer', {
    brief: 'Build the landing page in site/index.html with a responsive layout',
  });
  assert.match(frontend, /Your job as Frontend Engineer\./);

  const data = packPrompt('Engineer', {
    brief: 'Migration: add index on orders.created_at, then prove the row count matches',
  });
  assert.match(data, /Your job as Data Engineer\./);
});

await check('a brief with no signal leaves a generic role generic', () => {
  const plain = packPrompt('Engineer', { brief: 'Rename the constant to match the other one' });
  assert.match(plain, /Your job as Engineer\./);
});

await check('a specialist is not overruled by their brief', () => {
  // The role is the stronger statement about how the work is judged; a QA
  // engineer handed a CSS file is still answerable to the QA bar.
  const qa = packPrompt('QA Engineer', { brief: 'Restyle the button in client/src/styles.css' });
  assert.match(qa, /Your job as QA Engineer\./);
});

await check('an explicit pack wins, and an invented one falls back to the role', () => {
  const explicit = packPrompt('Tech Lead', { pack: 'qa' });
  assert.match(explicit, /Your job as QA Engineer\./);
  const invented = packPrompt('Tech Lead', { pack: 'astrology' });
  assert.match(invented, /Your job as Tech Lead\./);
});

await check('every pack id in the schema resolves to its own brief', () => {
  const wrong = ROLE_PACKS.filter((pack) => !packPrompt('Engineer', { pack: pack.id }).includes(`Your job as ${pack.label}.`));
  assert.deepEqual(wrong.map((pack) => pack.id), []);
  assert.ok(ROLE_PACK_IDS.includes('general'), 'the fallback pack must be selectable by id too');
});

await check('a role pack is a real difference, not a rename', () => {
  const frontend = buildRoleBrief('Frontend Engineer');
  const data = buildRoleBrief('Data Engineer');
  assert.notEqual(frontend, data);
  assert.match(frontend, /accessible name/);
  assert.match(data, /Idempotent and re-runnable/);
  assert.equal(rolePackId('QA Engineer'), 'qa');
});

console.log('\n[prompt] the instructions that cost a turn to learn');

await check('checking a page names the tool, not a browser hunt', () => {
  assert.match(prompt, /http_check/);
  assert.match(prompt, /preview_screenshot/);
  assert.match(prompt, /do not run which\/ls\/find looking for chrome/);
  assert.match(prompt, /curl is not in the sandbox allowlist/);
});

await check('housekeeping is stated as a gate, not a preference', () => {
  assert.match(prompt, /Scratch files you create to check something/);
  assert.match(prompt, /must be deleted before complete_task/);
  assert.match(prompt, /probe-\*/);
});

await check('the jail is described in the words the worker will hit', () => {
  assert.match(prompt, /sandbox|jail/i);
  assert.match(prompt, /network/i, 'a worker must know commands run without network by default');
  assert.match(prompt, /workspace/i);
});

await check('the shell grammar the sandbox really runs is advertised', () => {
  assert.match(prompt, /pipes/i);
  assert.match(prompt, /redirects/i);
  assert.match(prompt, /start_process/, 'long-running work has its own tool and must be named');
});

await check('the completion contract is unambiguous', () => {
  assert.match(prompt, /complete_task only when the work is actually finished/);
  assert.match(prompt, /Every tool result tells you what to do next/);
});

// The doctrine is one block, and it is the block the reviewer's own copy is
// checked against; building it twice must not differ by a byte.
await check('the doctrine is deterministic', () => {
  assert.equal(doctrineBrief(), doctrineBrief());
});

// `GET /api/playbook` is a one-line route over this function, so the payload
// is checked here rather than by booting a server: an empty group would render
// as a card with a heading and nothing under it.
await check('the playbook payload is complete and ordered', () => {
  const payload = playbook();
  assert.equal(payload.doctrine.length, 7);
  assert.equal(payload.packs.length, ROLE_PACKS.length + 1);
  assert.equal(payload.packs[0]?.id, 'lead', 'the lead pack reads first');
  assert.equal(payload.packs.at(-1)?.id, 'general', 'the fallback pack reads last');
  const empty = payload.packs.filter(
    (pack) => pack.craft.length === 0 || pack.done.length === 0 || pack.review.length === 0,
  );
  assert.deepEqual(empty.map((pack) => pack.id), [], 'packs with an empty group');
});

const passed = results.filter((entry) => entry.ok).length;
console.log(
  `\n[prompt] ${passed}/${results.length} checks passed (~${sharedTokens} shared tokens, ~${roleTokens} role tokens, budgets ${SHARED_BUDGET_TOKENS}/${ROLE_BUDGET_TOKENS}).`,
);
if (passed !== results.length) {
  console.log(`Failed: ${results.filter((entry) => !entry.ok).map((entry) => entry.label).join(' · ')}`);
  process.exit(1);
}
