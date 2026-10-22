/**
 * Keeps the activity log and the task notes translated.
 *
 * The server writes English log lines because scripts match on them, and this
 * project translates them in the browser by recognising the line and redrawing
 * it from the dictionary. That trick fails quietly in one direction only: a
 * line the table no longer recognises is shown in English and nobody notices.
 * So the table is checked against the code that writes it:
 *
 *   1. every `kind` the server files a log entry under has a template,
 *   2. every template's English column is the line the server writes, verbatim,
 *   3. every template still matches the line it claims, and translates fully,
 *   4. text this table does not own (an agent's own note) is left alone.
 *
 *   node --experimental-strip-types scripts/wording-check.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { getLocale, messages, setLocale, t } from '../shared/i18n.ts';
import {
  RAW_LOG_KINDS,
  logTemplates,
  logText,
  noteTemplates,
  noteText,
  sampleLine,
} from '../shared/wording.ts';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const SERVER_SRC = path.join(REPO_ROOT, 'server', 'src');
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
    else if (entry.name.endsWith('.ts')) files.push(full);
  }
  return files;
}

/** A log `kind` is a dotted lower-case identifier: `task.created`, `agent.step`. */
const KIND_SHAPE = /^[a-z][a-z_]*\.[a-z_]+$/;

/** Every kind the server files a log entry under, read from its call sites. */
async function emittedKinds() {
  const kinds = new Map();
  for (const file of await listSourceFiles(SERVER_SRC)) {
    const source = await fs.readFile(file, 'utf8');
    const call = /appendLog\(/g;
    let match;
    while ((match = call.exec(source)) !== null) {
      // The kind is the second argument and can sit on any of the next lines, so
      // look at the call's opening window and take the first literal that has
      // the shape of a kind. The level (`'info'`, or a ternary) never does.
      const window = source.slice(match.index, match.index + 320);
      for (const literal of window.matchAll(/'([^'\n]*)'/g)) {
        if (KIND_SHAPE.test(literal[1])) {
          if (!kinds.has(literal[1])) kinds.set(literal[1], path.basename(file));
          break;
        }
      }
    }
  }
  return kinds;
}

const kinds = await emittedKinds();
const table = messages();
const templatesByKind = new Map(logTemplates().map((entry) => [entry.kind, entry.templates]));

console.log('\n[wording] activity log');

await check('the scan found the log surface, not an empty file list', () => {
  assert.ok(
    kinds.size >= 35,
    `only ${kinds.size} log kinds found — the call-site scan has rotted`,
  );
});

await check('every log kind the server writes has a template', () => {
  const missing = [...kinds.keys()].filter(
    (kind) => !templatesByKind.has(kind) && !RAW_LOG_KINDS.includes(kind),
  );
  assert.deepEqual(missing, [], `untranslated log kinds: ${missing.join(', ')}`);
});

await check('no template describes a line the office never writes', () => {
  const dead = [...templatesByKind.keys()].filter((kind) => !kinds.has(kind));
  assert.deepEqual(dead, [], `templates for unknown kinds: ${dead.join(', ')}`);
});

await check('each template carries the exact English line the server writes', () => {
  const drift = [];
  for (const [kind, templates] of templatesByKind) {
    for (const template of templates) {
      if (table[template.key].en !== template.text) {
        drift.push(`${kind} → ${template.key}: table says "${table[template.key].en}"`);
      }
    }
  }
  assert.deepEqual(drift, [], drift.join('\n      '));
});

await check('every template matches its own line, in both languages', () => {
  const before = getLocale();
  try {
    for (const [kind, templates] of templatesByKind) {
      for (const template of templates) {
        const line = sampleLine(template);
        setLocale('en');
        assert.equal(logText({ kind, message: line }), line, `${kind} does not render in English`);
        setLocale('id');
        const indonesian = logText({ kind, message: line });
        assert.ok(
          !/\{\w+\}/.test(indonesian),
          `${kind} left a placeholder unfilled: ${indonesian}`,
        );
        if (table[template.key].en !== table[template.key].id) {
          assert.notEqual(indonesian, line, `${kind} was not translated: ${indonesian}`);
        }
      }
    }
  } finally {
    setLocale(before);
  }
});

console.log('\n[wording] task notes');

await check('every note template matches its own note and translates', () => {
  const before = getLocale();
  try {
    for (const template of noteTemplates()) {
      const note = sampleLine(template);
      setLocale('en');
      assert.equal(noteText(note), note, `${template.key} does not render in English`);
      setLocale('id');
      const indonesian = noteText(note);
      assert.ok(!/\{\w+\}/.test(indonesian), `${template.key} left a placeholder: ${indonesian}`);
      assert.notEqual(indonesian, note, `${template.key} was not translated`);
    }
  } finally {
    setLocale(before);
  }
});

await check('the notes the server writes are notes this table knows', async () => {
  const runtime = await fs.readFile(path.join(SERVER_SRC, 'agentRuntime.ts'), 'utf8');
  const restart = /const RESTART_NOTE =\s*\n?\s*'([^']+)'/.exec(runtime);
  assert.ok(restart, 'RESTART_NOTE not found in agentRuntime.ts');
  assert.equal(restart[1], table['note.restart'].en, 'the restart note drifted from the dictionary');

  const gate = /addTaskNote\(\s*taskId,\s*'([^']+)'/.exec(runtime);
  assert.ok(gate, 'the evidence-gate note not found in agentRuntime.ts');
  assert.equal(gate[1], table['note.evidenceGate'].en, 'the evidence note drifted from the dictionary');

  const checkpoint = runtime.includes(
    '`Changes since checkpoint ${checkpoint.ref.slice(0, 8)}:\\n${summary}`',
  );
  assert.ok(checkpoint, 'the checkpoint note changed shape — update note.checkpointDiff');
  assert.ok(
    sampleLine(noteTemplates().find((template) => template.key === 'note.checkpointDiff')).startsWith(
      'Changes since checkpoint ',
    ),
    'note.checkpointDiff no longer starts with the server prefix',
  );
});

console.log('\n[wording] what is left alone');

await check("an agent's own note is shown as the agent wrote it", () => {
  const note = 'I used CSS grid because the layout has two axes.';
  assert.equal(noteText(note), note);
});

await check('a log line this table does not know is shown as written', () => {
  const line = 'Provider note: routing through the cheap tier.';
  assert.equal(logText({ kind: 'session.model', message: line }), line);
  assert.equal(logText({ kind: 'kind.that.does.not.exist', message: line }), line);
});

await check('a line filed under the right kind but the wrong shape is not mangled', () => {
  const line = 'Aria started something this table never wrote.';
  setLocale('id');
  const rendered = logText({ kind: 'task.started', message: line });
  setLocale('en');
  assert.equal(rendered, line);
});

await check('the Indonesian column of a template is reachable through t()', () => {
  setLocale('id');
  assert.equal(
    t('log.task.started', { name: 'Aria', title: 'Ship it' }),
    'Aria mulai mengerjakan "Ship it".',
  );
  setLocale('en');
});

const passed = results.filter((entry) => entry.ok).length;
console.log(`\n[wording] ${passed}/${results.length} checks passed.`);
if (passed !== results.length) {
  console.log(`Failed: ${results.filter((entry) => !entry.ok).map((entry) => entry.label).join(' · ')}`);
  process.exit(1);
}
