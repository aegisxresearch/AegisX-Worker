/**
 * The capability router: fewer schemas per round, without hiding a tool the
 * worker needs.
 *
 * The last check is the one that matters commercially: a realistic mission is
 * replayed against the router and against "send everything", and the schema
 * tokens are compared. A router that saves nothing is a bug, not a preference.
 *
 *   node --experimental-strip-types scripts/router-check.mjs
 */
import assert from 'node:assert/strict';
import process from 'node:process';
import {
  ALWAYS_AVAILABLE,
  TOOL_PHASES,
  phaseAfterAction,
  schemaTokens,
  toolsForPhase,
} from '../server/src/router.ts';
import { buildToolSchemas } from '../server/src/toolSchemas.ts';

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

const names = (phase) => buildToolSchemas({ files: true, web: true, phase }).map((tool) => tool.function.name);
const all = names('all');

console.log('\n[router] the phase table');

await check('every phase is a strict, duplicate-free subset of the full toolkit', async () => {
  assert.equal(all.length, 29, `the full toolkit changed size: ${all.length}`);
  for (const phase of TOOL_PHASES) {
    const phaseNames = names(phase);
    assert.equal(new Set(phaseNames).size, phaseNames.length, `${phase} repeats a tool`);
    const unknown = phaseNames.filter((name) => !all.includes(name));
    assert.deepEqual(unknown, [], `${phase} offers tools that do not exist: ${unknown.join(', ')}`);
    assert.ok(phaseNames.length < all.length, `${phase} is not actually a slice`);
    assert.ok(phaseNames.length <= 13, `${phase} sends ${phaseNames.length} schemas, above the 13 cap`);
  }
});

await check('office core is always available, wherever the worker is', async () => {
  for (const phase of TOOL_PHASES) {
    const phaseNames = names(phase);
    for (const action of ALWAYS_AVAILABLE) {
      assert.ok(phaseNames.includes(action), `${phase} hides ${action}, so the worker cannot finish`);
    }
  }
});

await check('inspect cannot write, and edit cannot shell out', async () => {
  const inspect = names('inspect');
  for (const action of ['write_file', 'edit_file', 'apply_patch', 'delete_file', 'run_command', 'start_process']) {
    assert.equal(inspect.includes(action), false, `inspect must not offer ${action}`);
  }
  const edit = names('edit');
  assert.ok(edit.includes('apply_patch'));
  for (const action of ['run_command', 'http_check', 'start_process', 'preview_screenshot']) {
    assert.equal(edit.includes(action), false, `edit must not offer ${action} before the work is verified`);
  }
  const verify = names('verify');
  assert.ok(verify.includes('run_check') && verify.includes('http_check'), 'verify needs the check tools');
  assert.equal(verify.includes('write_file'), false, 'a failing check should send the worker back to inspect, not to blind writes');
});

await check('the operator switches still decide what a phase can offer', async () => {
  const noFiles = buildToolSchemas({ files: false, web: true, phase: 'inspect' }).map((tool) => tool.function.name);
  assert.deepEqual(
    noFiles.filter((name) => ['read_file', 'list_directory', 'search_symbol'].includes(name)),
    [],
    'file tools leaked with files off',
  );
  const noWeb = buildToolSchemas({ files: true, web: false, phase: 'inspect' }).map((tool) => tool.function.name);
  assert.equal(noWeb.includes('web_search'), false);
});

console.log('\n[router] the transition machine');

await check('reading moves to edit, editing to verify, failure back to inspect', async () => {
  assert.equal(phaseAfterAction('read_file', true, 'inspect'), 'inspect');
  assert.equal(phaseAfterAction('search_symbol', true, 'inspect'), 'inspect');
  assert.equal(phaseAfterAction('apply_patch', true, 'inspect'), 'verify');
  assert.equal(phaseAfterAction('write_file', true, 'inspect'), 'verify');
  assert.equal(phaseAfterAction('run_check', true, 'verify'), 'verify');
  assert.equal(phaseAfterAction('run_check', false, 'verify'), 'inspect');
  assert.equal(phaseAfterAction('read_file', true, 'verify'), 'verify', 'a read during verification must not reopen editing');
  assert.equal(phaseAfterAction('complete_task', true, 'verify'), 'wrap');
  assert.equal(phaseAfterAction('add_note', true, 'edit'), 'edit');
});

console.log('\n[router] the measurement');

await check('a realistic mission spends at least 40% fewer schema tokens', async () => {
  // A mission shape the eval suite already produces: explore, then patch twice,
  // run the check, read the failure, fix it, check again, wrap up.
  const mission = [
    ['list_directory', true],
    ['read_file', true],
    ['read_file', true],
    ['search_symbol', true],
    ['apply_patch', true],
    ['apply_patch', true],
    ['run_check', false],
    ['read_file', true],
    ['apply_patch', true],
    ['run_check', true],
    ['add_note', true],
    ['complete_task', true],
  ];

  let phase = 'inspect';
  let routed = 0;
  let always = 0;
  const perRound = [];
  for (const [action, ok] of mission) {
    const schemas = buildToolSchemas({ files: true, web: true, phase });
    const cost = schemaTokens(schemas);
    routed += cost;
    always += schemaTokens(buildToolSchemas({ files: true, web: true }));
    perRound.push(`${phase}:${schemas.length}/${cost}`);
    phase = phaseAfterAction(action, ok, phase);
  }

  const saving = 1 - routed / always;
  console.log(`      rounds: ${mission.length}, routed ${routed} tokens vs always ${always} (saved ${(saving * 100).toFixed(1)}%)`);
  console.log(`      ${perRound.join(' · ')}`);
  assert.ok(saving >= 0.4, `the router only saved ${(saving * 100).toFixed(1)}%`);
  assert.ok(toolsForPhase(phase).length <= 13, 'the final phase is over the cap');
});

const failed = results.filter((entry) => !entry.ok);
console.log(`\n[router] ${results.length - failed.length}/${results.length} checks passed.`);
if (failed.length > 0) {
  console.log(`Failed: ${failed.map((entry) => entry.label).join(' · ')}`);
  process.exitCode = 1;
}
