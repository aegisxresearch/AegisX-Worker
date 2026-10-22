/**
 * The documentation is a promise about the code, so it is checked like code.
 *
 * Two kinds of rot this catches without a human reading prose:
 *
 *   1. The README file map. A module that exists but is not on the map is
 *      invisible to whoever reads the architecture section; a module on the map
 *      that no longer exists sends them to a file that is gone.
 *   2. The ROADMAP evidence rows. "Proven by `check:gate`" is only true while
 *      that script exists *and* is part of `npm run check` — a check that is
 *      written but not wired proves nothing, which is exactly how a green
 *      table stops matching reality.
 *
 * Only *claims* are policed: the README and the "0.1" evidence table describe
 * what exists today. The planning sections of the ROADMAP are allowed to name a
 * `check:orchestration` or a `scheduler.ts` that does not exist yet — that is
 * what a plan is for. The exemption for a check that needs a browser is listed
 * below by name instead of being silent, and the list itself is verified.
 *
 * What it deliberately does not do: verify the counts and prose in each row.
 * "13 kasus" can only be confirmed by running that script, which the suite
 * already does; guessing from source would be a check that lies.
 *
 *   node --experimental-strip-types scripts/docs-check.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.resolve(import.meta.dirname, '..');
const README = path.join(ROOT, 'README.md');
const ROADMAP = path.join(ROOT, 'docs', 'ROADMAP.md');
const MANIFEST = path.join(ROOT, 'package.json');

const results = [];
async function check(label, run) {
  try {
    await run();
    results.push({ label, ok: true });
    console.log(`  ✓ ${label}`);
  } catch (error) {
    results.push({ label, ok: false, error });
    console.log(`  ✗ ${label}\n      ${error instanceof Error ? error.message : String(error)}`);
  }
}

const readme = await fs.readFile(README, 'utf8');
const roadmap = await fs.readFile(ROADMAP, 'utf8');
const manifest = JSON.parse(await fs.readFile(MANIFEST, 'utf8'));
const scripts = manifest.scripts ?? {};
const chain = String(scripts.check ?? '');

// ── the README file map ─────────────────────────────────────────────────────

/** The first fenced block under a heading, where the folder tree lives. */
function fencedBlockAfter(text, heading) {
  const start = text.indexOf(heading);
  if (start < 0) return '';
  const fence = text.indexOf('```', start);
  if (fence < 0) return '';
  const end = text.indexOf('```', fence + 3);
  if (end < 0) return '';
  return text.slice(fence + 3, end);
}

/** The fenced block under "## Architecture". */
function architectureBlock(text) {
  return fencedBlockAfter(text, '## Architecture');
}

/** One entry per line of the tree: which folder it belongs to, and its path. */
function parseMap(text) {
  const entries = [];
  let section = null;
  for (const line of text.split('\n')) {
    const top = /^(client|server|shared|bin|scripts|docs)\//.exec(line.trim());
    if (top?.[1]) {
      section = top[1];
      continue;
    }
    // The map is column-aligned for most lines and single-spaced for a few, so
    // one space is enough to separate the path from its description.
    const entry = /^\s{2,}(src\/\S+|[\w.-]+\.\w+)\s+\S/.exec(line);
    if (entry?.[1] && section) entries.push({ section, entry: entry[1].replace(/\/$/, '') });
  }
  return entries;
}

const block = architectureBlock(readme);
const mapEntries = parseMap(block);

/** Every file the docs are supposed to describe, per section. */
async function listFiles(relativeDir) {
  const absolute = path.join(ROOT, relativeDir);
  const found = await fs.readdir(absolute, { withFileTypes: true }).catch(() => []);
  return found.map((item) => (item.isDirectory() ? `${item.name}/` : item.name)).sort();
}

const serverFiles = await listFiles('server/src');
const clientFiles = await listFiles('client/src');
const sharedFiles = await listFiles('shared');

/** A map entry `src/llm.ts` describes a file; `src/routes` covers its folder. */
function covered(section, name, entries) {
  return entries.some((item) => {
    if (item.section !== section) return false;
    const listed = item.entry.startsWith('src/') ? item.entry.slice(4) : item.entry;
    return listed === name || (listed.endsWith('/') && name.startsWith(listed)) || `${listed}/` === name;
  });
}

console.log('\n[docs] the README file map');

await check('the scan found the map, not an empty block', () => {
  assert.ok(block.length > 200, 'the Architecture block could not be read');
  assert.ok(mapEntries.length >= 20, `only ${mapEntries.length} entries parsed — the parser has rotted`);
});

await check('every server module is on the map', () => {
  const missing = serverFiles.filter((name) => !covered('server', name, mapEntries));
  assert.deepEqual(missing, [], `not in the README map: ${missing.join(', ')}`);
});

await check('every client entry is on the map', () => {
  const missing = clientFiles.filter((name) => !covered('client', name, mapEntries));
  assert.deepEqual(missing, [], `not in the README map: ${missing.join(', ')}`);
});

await check('every shared module is on the map', () => {
  const missing = sharedFiles.filter((name) => !mapEntries.some((item) => item.section === 'shared' && item.entry === name));
  assert.deepEqual(missing, [], `not in the README map: ${missing.join(', ')}`);
});

/** Map entries whose file is not on disk. Parameterised so the teeth can test it. */
async function mapPathsThatAreGone(entries, root) {
  const gone = [];
  for (const item of entries) {
    // Sections are the top-level folders, so `src/x` under `server/` resolves to
    // `server/src/x` and a bare `types.ts` under `shared/` to `shared/types.ts`.
    const target = path.join(root, item.section, item.entry);
    const exists = await fs.stat(target).then(() => true, () => false);
    if (!exists) gone.push(`${item.section}/${item.entry}`);
  }
  return gone;
}

await check('every path on the map exists', async () => {
  const gone = await mapPathsThatAreGone(mapEntries, ROOT);
  assert.deepEqual(gone, [], `the map points at files that are gone: ${gone.join(', ')}`);
});

await check('no module is listed twice', () => {
  const seen = new Set();
  const duplicates = [];
  for (const item of mapEntries) {
    const key = `${item.section}/${item.entry}`;
    if (seen.has(key)) duplicates.push(key);
    seen.add(key);
  }
  assert.deepEqual(duplicates, [], `listed more than once: ${duplicates.join(', ')}`);
});

// ── the evidence rows ───────────────────────────────────────────────────────

const docs = [
  { name: 'README.md', text: readme },
  { name: 'docs/ROADMAP.md', text: roadmap },
];

/** Every `check:foo` token in a piece of text. */
function citedChecks(text) {
  return [...text.matchAll(/check:[a-z0-9]+(?:[:-][a-z0-9]+)?/g)].map((match) => match[0]);
}

/**
 * Checks a reader can run by hand but the default suite cannot: they need a
 * real browser. Listed explicitly so the exemption is a decision, not a gap.
 */
const MANUAL_CHECKS = new Map([
  ['check:i18n:browser', 'needs a real browser, so it is run by hand and not in the chain'],
]);

function roadmapEvidenceRows(text) {
  const start = text.indexOf('### 0.1');
  if (start < 0) return [];
  const rest = text.slice(start + 1);
  const end = rest.search(/\n#{2,3} /);
  const sectionText = end < 0 ? rest : rest.slice(0, end);
  return sectionText
    .split('\n')
    .filter((line) => line.startsWith('|') && !/^\|[\s|:-]+\|$/.test(line))
    .filter((line) => !/^\|\s*Yang sudah ada/.test(line));
}

const evidenceRows = roadmapEvidenceRows(roadmap);

/** Citations the docs make about what exists today, as opposed to the plan. */
const claimed = new Set([...citedChecks(readme), ...evidenceRows.flatMap((row) => citedChecks(row))]);

console.log('\n[docs] the ROADMAP evidence rows');

await check('the scan found the evidence table', () => {
  assert.ok(evidenceRows.length >= 5, `only ${evidenceRows.length} rows parsed — the parser has rotted`);
});

await check('every check the docs claim exists as a script', () => {
  const unknown = [...claimed].filter((name) => !Object.hasOwn(scripts, name));
  assert.deepEqual(unknown, [], `documented but missing from package.json: ${unknown.join(', ')}`);
});

await check('every claimed check is actually run by `npm run check`', () => {
  const unwired = [...claimed].filter((name) => !chain.includes(name) && !MANUAL_CHECKS.has(name));
  assert.deepEqual(unwired, [], `cited as evidence but not in the chain: ${unwired.join(', ')}`);
});

await check('the manual-check exemptions still point at real scripts', () => {
  const stale = [...MANUAL_CHECKS.keys()].filter((name) => !Object.hasOwn(scripts, name));
  assert.deepEqual(stale, [], `exempted but gone: ${stale.join(', ')}`);
});

await check('every evidence row carries a check', () => {
  const empty = evidenceRows.filter((row) => citedChecks(row).length === 0);
  assert.deepEqual(empty, [], `rows with no runnable evidence:\n${empty.join('\n')}`);
});

await check('every module path the docs cite as current exists', async () => {
  const gone = [];
  const claims = [['README.md', readme], ['docs/ROADMAP.md §0.1', evidenceRows.join('\n')]];
  for (const [name, text] of claims) {
    for (const match of text.matchAll(/`((?:server|client|shared|scripts)\/[\w./-]+\.(?:ts|mjs|css|html))`/g)) {
      const target = path.join(ROOT, match[1]);
      const exists = await fs.stat(target).then(() => true, () => false);
      if (!exists) gone.push(`${name}: ${match[1]}`);
    }
  }
  assert.deepEqual(gone, [], `docs point at files that are gone: ${gone.join(', ')}`);
});

console.log('\n[docs] the checks themselves');

const scriptFiles = (await fs.readdir(path.join(ROOT, 'scripts'))).filter(
  (name) => /(?:^check-.*\.mjs$|-check\.mjs$)/.test(name),
);

await check('every check script is registered and wired', async () => {
  const unwired = [];
  for (const file of scriptFiles.sort()) {
    const entry = Object.entries(scripts).find(([, command]) => String(command).includes(`scripts/${file}`));
    if (!entry) {
      unwired.push(`${file} has no npm script`);
      continue;
    }
    if (!chain.includes(entry[0]) && !MANUAL_CHECKS.has(entry[0])) {
      unwired.push(`${file} → ${entry[0]} is not in the chain`);
    }
  }
  assert.deepEqual(unwired, [], unwired.join('; '));
});

await check('every registered check script points at a file that exists', async () => {
  const missing = [];
  for (const [name, command] of Object.entries(scripts)) {
    if (!name.startsWith('check:') && name !== 'eval') continue;
    for (const match of String(command).matchAll(/scripts\/([\w.-]+\.mjs)/g)) {
      const exists = await fs.stat(path.join(ROOT, 'scripts', match[1])).then(() => true, () => false);
      if (!exists) missing.push(`${name} → scripts/${match[1]}`);
    }
  }
  assert.deepEqual(missing, [], missing.join(', '));
});

// ── the Indonesian README ──────────────────────────────────────────────────

const README_ID = path.join(ROOT, 'README.id.md');
const ID_ARCHITECTURE = '## Arsitektur';

/**
 * Heading levels in file order. The words are translated, so only the shape is
 * comparable — but the shape is what drifts when a section is added to one
 * README and forgotten in the other, and a reader who switches language then
 * loses the section without being told.
 */
function headingLevels(text) {
  return text
    .split('\n')
    .map((line) => /^(#{1,3})\s+\S/.exec(line))
    .filter(Boolean)
    .map((match) => match[1].length);
}

/**
 * GitHub's heading anchor: lowercase, punctuation dropped, spaces to hyphens.
 * Only letters, digits, spaces and hyphens survive, which is enough for these
 * documents and keeps the rule readable.
 */
function anchor(text) {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .trim()
    .replace(/\s+/g, '-');
}

/** Every heading a `](#…)` link is allowed to point at in this file. */
function headingAnchors(text) {
  return new Set(
    text
      .split('\n')
      .filter((line) => /^#{1,4}\s/.test(line))
      .map((line) => anchor(line.replace(/^#{1,4}\s+/, ''))),
  );
}

/** In-page link targets, without the leading `#`. */
function inPageTargets(text) {
  return [...new Set([...text.matchAll(/\]\(#([^)]+)\)/g)].map((match) => match[1]))];
}

/** A table of contents that points at a heading nobody wrote is a dead link. */
function brokenAnchors(text) {
  const headings = headingAnchors(text);
  return inPageTargets(text).filter((target) => !headings.has(target));
}

/** Relative link targets: the files a reader is sent to, not anchors or URLs. */
function relativeLinks(text) {
  return [...text.matchAll(/\]\((?!https?:|#)([^)]+)\)/g)]
    .map((match) => match[1])
    .filter((target) => target !== 'README.md' && target !== 'README.id.md');
}

const idReadme = await fs.readFile(README_ID, 'utf8').catch(() => null);

console.log('\n[docs] the Indonesian README');

await check('the translated README exists and the two link to each other', () => {
  assert.ok(idReadme, 'README.id.md is missing');
  assert.match(readme, /\]\(README\.id\.md\)/, 'the English README has no switch to README.id.md');
  assert.match(idReadme, /\]\(README\.md\)/, 'the Indonesian README has no switch back to README.md');
  assert.ok(idReadme.length > readme.length * 0.8, 'README.id.md is far shorter than README.md — suspiciously so');
});

await check('both READMEs carry the same section outline', () => {
  const english = headingLevels(readme);
  const indonesian = headingLevels(idReadme);
  assert.equal(
    indonesian.length,
    english.length,
    `README.id.md has ${indonesian.length} headings, README.md has ${english.length}`,
  );
  const drifted = english.findIndex((level, index) => level !== indonesian[index]);
  assert.equal(
    drifted,
    -1,
    `heading ${drifted + 1} is h${english[drifted]} in English and h${indonesian[drifted]} in Indonesian`,
  );
});

await check('every file the English README links to is linked in Indonesian', () => {
  const inIndonesian = new Set(relativeLinks(idReadme));
  const missing = [...new Set(relativeLinks(readme))].filter((target) => !inIndonesian.has(target));
  assert.deepEqual(missing, [], `not linked in README.id.md: ${missing.join(', ')}`);
});

await check('every in-page link in the English README resolves', () => {
  assert.deepEqual(brokenAnchors(readme), [], `dead anchors: ${brokenAnchors(readme).join(', ')}`);
});

await check('every in-page link in the Indonesian README resolves', () => {
  assert.deepEqual(brokenAnchors(idReadme), [], `dead anchors: ${brokenAnchors(idReadme).join(', ')}`);
});

await check('the Indonesian file map lists every path the English one does', () => {
  const indonesianMap = parseMap(fencedBlockAfter(idReadme, ID_ARCHITECTURE));
  assert.ok(indonesianMap.length >= 20, `only ${indonesianMap.length} entries parsed from README.id.md`);
  const listed = new Set(indonesianMap.map((item) => `${item.section}:${item.entry}`));
  const missing = mapEntries.filter((item) => !listed.has(`${item.section}:${item.entry}`));
  assert.deepEqual(
    missing.map((item) => `${item.section}/${item.entry}`),
    [],
    `the Indonesian map has fallen behind: ${missing.map((item) => `${item.section}/${item.entry}`).join(', ')}`,
  );
});

// ── the check has teeth ─────────────────────────────────────────────────────

// A check that only ever passes is a check that proves nothing. These fixtures
// are the two failures the suite has already seen: a module the map forgot, and
// a parser that silently stopped seeing single-spaced lines.

console.log('\n[docs] the check itself');

await check('the map parser sees single-spaced lines', () => {
  const parsed = parseMap(
    ['client/   the browser', '  src/main.ts bootstrap', 'server/   the API', '  src/preview.ts one-space description'].join('\n'),
  );
  assert.deepEqual(
    parsed.map((item) => `${item.section}:${item.entry}`),
    ['client:src/main.ts', 'server:src/preview.ts'],
    'a line with one space between path and description was dropped',
  );
});

await check('a module missing from the map would be reported', () => {
  const parsed = parseMap(['server/   the API', '  src/llm.ts chat'].join('\n'));
  const listed = parsed.map((item) => item.entry);
  const forgotten = ['llm.ts', 'worktrees.ts'].filter((name) => !listed.includes(`src/${name}`));
  assert.deepEqual(forgotten, ['worktrees.ts'], 'the missing-module rule stopped detecting a gap');
});

await check('a translation that dropped a section would be reported', () => {
  const trimmed = readme.replace(/## Security notes[\s\S]*$/, '');
  assert.notDeepEqual(
    headingLevels(trimmed),
    headingLevels(readme),
    'the outline comparison cannot see a section that went missing',
  );
  assert.deepEqual(
    [...new Set(relativeLinks(readme))].filter((target) => !relativeLinks(trimmed).includes(target)),
    ['LICENSE'],
    'the link comparison cannot see the links of a dropped section',
  );
});

await check('a table of contents pointing at a missing heading would be reported', () => {
  const broken = brokenAnchors('## Ada\n\n- [A](#ada)\n- [B](#tidak-ada)');
  assert.deepEqual(broken, ['tidak-ada'], 'the anchor comparison stopped seeing a dead link');
});

await check('a path on the map that is gone would be reported', async () => {
  const gone = await mapPathsThatAreGone(
    [{ section: 'server', entry: 'src/this-module-was-removed.ts' }],
    ROOT,
  );
  assert.deepEqual(gone, ['server/src/this-module-was-removed.ts']);
});

await check('a check the docs invent would be reported', () => {
  const invented = citedChecks('proven by `check:imaginary`');
  assert.deepEqual(invented, ['check:imaginary']);
  const unknown = invented.filter((name) => !Object.hasOwn(scripts, name));
  assert.deepEqual(unknown, ['check:imaginary'], 'an unknown check name slipped through');
});

const failed = results.filter((entry) => !entry.ok);
console.log(`\n[docs] ${results.length - failed.length}/${results.length} checks passed.`);
if (failed.length > 0) {
  console.log(`Failed: ${failed.map((entry) => entry.label).join(' · ')}`);
  process.exitCode = 1;
}
