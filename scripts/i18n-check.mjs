/**
 * Guards the two-language UI without a browser.
 *
 * A translated interface fails in three quiet ways: a key in the HTML that the
 * dictionary never had, a row where the Indonesian column was left as a copy of
 * the English one, and a key nothing references any more. Each one shows up as
 * a user staring at the wrong language, so each gets an assertion here.
 *
 *   node --experimental-strip-types scripts/i18n-check.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { getLocale, messageKeys, messages, setLocale, t } from '../shared/i18n.ts';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
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

async function listSourceFiles(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await listSourceFiles(full)));
    else if (/\.(ts|mjs)$/.test(entry.name)) files.push(full);
  }
  return files;
}

const html = await fs.readFile(path.join(REPO_ROOT, 'client', 'index.html'), 'utf8');
const attributes = [...html.matchAll(/data-i18n(?:-placeholder|-title|-aria)?="([^"]+)"/g)].map(
  (match) => match[1],
);
const clientFiles = await listSourceFiles(path.join(REPO_ROOT, 'client', 'src'));
// The activity log and the task notes name their keys from a shared table rather
// than a `t()` call in the client, so that table counts as a reference too.
const wordingFile = path.join(REPO_ROOT, 'shared', 'wording.ts');
// Tables that name their keys instead of calling t() document them for a
// living: the log/note table is one, the failure ledger (code → label → next
// step) is another, and the pack names (pack id → label row) are the third. All
// count as references, because a key that only appears in a lookup table still
// reaches the screen.
const tableFiles = ['wording.ts', 'failures.ts', 'packs.ts'].map((name) =>
  path.join(REPO_ROOT, 'shared', name),
);
const source = (
  await Promise.all([...clientFiles, ...tableFiles].map((file) => fs.readFile(file, 'utf8')))
).join('\n');
const keys = new Set(messageKeys());
const table = messages();

console.log('\n[i18n] dictionary');

await check('every key in the page exists in the dictionary', async () => {
  const missing = attributes.filter((key) => !keys.has(key));
  assert.deepEqual(missing, [], `unknown keys: ${missing.join(', ')}`);
  assert.ok(attributes.length > 30, `only ${attributes.length} tagged elements — the sweep missed some`);
});

await check('both languages are filled in and actually differ', async () => {
  const empty = [];
  const identical = [];
  for (const key of keys) {
    if (table[key].en.trim().length === 0 || table[key].id.trim().length === 0) empty.push(key);
    // Short labels may legitimately match ("Model", "Error"); sentences may not.
    const looksLikeSentence = table[key].en.length > 12;
    if (table[key].en === table[key].id && looksLikeSentence) identical.push(key);
  }
  assert.deepEqual(empty, [], `empty translations: ${empty.join(', ')}`);
  assert.deepEqual(identical, [], `Indonesian still English: ${identical.join(', ')}`);
});

await check('nothing in the dictionary is dead weight', async () => {
  const haystack = `${html}\n${source}`;
  const unused = [...keys].filter((key) => !haystack.includes(key));
  assert.deepEqual(unused, [], `unreferenced keys: ${unused.join(', ')}`);
});

await check('the active language changes what t() returns', async () => {
  const before = getLocale();
  try {
    setLocale('en');
    const english = t('common.settings');
    setLocale('id');
    const indonesian = t('common.settings');
    assert.equal(english, 'Settings');
    assert.equal(indonesian, 'Pengaturan');
    assert.notEqual(english, indonesian);
  } finally {
    setLocale(before);
  }
});

await check('placeholders are filled, and a missing one stays visible', async () => {
  setLocale('en');
  assert.equal(t('conn.live', { model: 'x-1' }), 'Live · x-1');
  assert.equal(t('conn.live'), 'Live · {model}');
  setLocale('id');
  assert.equal(t('conn.live', { model: 'x-1' }), 'Aktif · x-1');
  setLocale('en');
});

const passed = results.filter((entry) => entry.ok).length;
console.log(`\n[i18n] ${passed}/${results.length} checks passed.`);
if (passed !== results.length) {
  console.log(`Failed: ${results.filter((entry) => !entry.ok).map((entry) => entry.label).join(' · ')}`);
  process.exit(1);
}
