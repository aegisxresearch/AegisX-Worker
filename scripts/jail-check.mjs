/**
 * The jail, proved by trying to break out of it.
 *
 * The allowlist and the path guard are ergonomics — they stop an accidental
 * escape. This check is about the boundary: a command inside the sandbox must
 * not see the operator's home, must not write outside the workspace, and must
 * not reach the network unless the operator said so. When bubblewrap is not
 * available the check says so instead of pretending the isolation happened.
 *
 *   npm run check:jail
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { jailStatus, planJail, toolchainRoots } from '../server/src/jail.ts';
import {
  checkPort,
  processLogs,
  startManagedProcess,
  stopManagedProcess,
} from '../server/src/processes.ts';
import { runShell } from '../server/src/shell.ts';

const results = [];
const skipped = [];

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

function skip(label, why) {
  skipped.push(label);
  console.log(`  · ${label} — skipped: ${why}`);
}

const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'aegisx-jail-'));
await fs.writeFile(path.join(workspace, 'note.txt'), 'hello\n', 'utf8');

/** A command that asks node about one path, so the answer is a plain true/false. */
const existsProbe = (target) =>
  `node -e "console.log(require('fs').existsSync('${target}'))"`;

const status = jailStatus();
const homeSecret = path.join(os.homedir(), '.bashrc');

console.log('\n[jail] status');

await check('the jail reports a truthful status, not an optimistic one', async () => {
  assert.equal(typeof status.available, 'boolean');
  if (status.available) {
    assert.equal(status.reason, null);
    assert.ok(status.binary && (await fs.access(status.binary).then(() => true)), 'binary missing');
  } else {
    assert.ok((status.reason ?? '').length > 10, 'an unavailable jail must say why');
  }
});

if (!status.available) {
  console.log(`\n[jail] isolation not verifiable on this host: ${status.reason}`);
  skip('a command cannot see the operator home', status.reason ?? 'no jail');
  skip('the workspace stays writable, /etc does not', status.reason ?? 'no jail');
  skip('the network is isolated for run_command', status.reason ?? 'no jail');
  skip('OFFICE_JAIL=0 turns the sandbox off', status.reason ?? 'no jail');
  skip('a managed process runs in the jail and stays reachable', status.reason ?? 'no jail');
  const passedOff = results.filter((entry) => entry.ok).length;
  console.log(`\n[jail] ${passedOff}/${results.length} checks passed, ${skipped.length} skipped.`);
  await fs.rm(workspace, { recursive: true, force: true });
} else {
  console.log('\n[jail] inside the sandbox');

  await check('the toolchain still runs', async () => {
    const version = await runShell('node --version', { cwd: workspace });
    assert.equal(version.ok, true, version.output);
    assert.match(version.output, /^v\d+\./);
  });

  await check('the operator home is not visible', async () => {
    const probe = await runShell(existsProbe(homeSecret), { cwd: workspace });
    assert.equal(probe.ok, true, probe.output);
    assert.equal(probe.output.trim(), 'false', `${homeSecret} is visible inside the jail`);
  });

  await check('the workspace is writable, /etc is read-only', async () => {
    const write = await runShell('echo jailed > inside.txt', { cwd: workspace });
    assert.equal(write.ok, true, write.output);
    assert.equal(await fs.readFile(path.join(workspace, 'inside.txt'), 'utf8'), 'jailed\n');

    const etcWrite = await runShell(
      `node -e "try{require('fs').writeFileSync('/etc/aegisx-probe','x');console.log('wrote')}catch(e){console.log('blocked')}"`,
      { cwd: workspace },
    );
    assert.equal(etcWrite.ok, true, etcWrite.output);
    assert.equal(etcWrite.output.trim(), 'blocked', '/etc must not be writable');
  });

  await check('the plan keeps the workspace as the only writable tree', () => {
    const plan = planJail({
      argv: ['node', '--version'],
      cwd: workspace,
      root: workspace,
      home: path.join(workspace, '.home'),
      net: false,
      readOnly: toolchainRoots(),
    });
    assert.equal(plan.ok, true, plan.reason ?? 'plan failed');
    const args = plan.args;
    assert.ok(args.includes('--unshare-net'), 'network should be unshared by default');
    assert.ok(!args.includes('--unshare-all'), '--unshare-all would hide the binds');
    const binds = args.filter((entry, index) => args[index - 1] === '--bind');
    assert.deepEqual(binds, [workspace, path.join(workspace, '.home')]);
  });

  await check('the network is isolated for run_command', async () => {
    const probe = await runShell(
      `node -e "fetch('https://example.com').then(()=>console.log('online')).catch(()=>console.log('offline'))"`,
      { cwd: workspace },
    );
    assert.equal(probe.ok, true, probe.output);
    assert.equal(probe.output.trim(), 'offline', 'run_command reached the network with the jail on');
  });

  await check('OFFICE_JAIL=0 turns the sandbox off on purpose', async () => {
    const script = `
      import { runShell } from ${JSON.stringify(path.join(import.meta.dirname, '..', 'server', 'src', 'shell.ts'))};
      const out = await runShell(${JSON.stringify(existsProbe(homeSecret))}, { cwd: ${JSON.stringify(workspace)} });
      console.log(out.output.trim());
    `;
    const raw = execFileSync(process.execPath, ['--experimental-strip-types', '-e', script], {
      env: { ...process.env, OFFICE_JAIL: '0' },
      encoding: 'utf8',
      timeout: 30_000,
    });
    assert.equal(raw.trim(), 'true', 'OFFICE_JAIL=0 should run the command unjailed');
  });

  await check('a managed process runs in the jail and stays reachable', async () => {
    const port = await new Promise((resolve) => {
      const probe = net.createServer();
      probe.listen(0, '127.0.0.1', () => {
        const { port: free } = probe.address();
        probe.close(() => resolve(free));
      });
    });

    const serverFile = path.join(workspace, 'server.mjs');
    await fs.writeFile(
      serverFile,
      [
        "import http from 'node:http';",
        "import fs from 'node:fs';",
        `const jailed = !fs.existsSync(${JSON.stringify(homeSecret)});`,
        `http.createServer((request, response) => response.end('ok')).listen(${port}, '127.0.0.1', () => console.log('jailed=' + jailed));`,
      ].join('\n'),
      'utf8',
    );

    const started = await startManagedProcess({
      command: 'node server.mjs',
      cwd: workspace,
      label: 'jail probe',
      logDir: path.join(workspace, '.logs'),
      port,
    });
    try {
      assert.equal(started.running, true, 'the server did not stay up');
      const body = await new Promise((resolve, reject) => {
        http
          .get({ host: '127.0.0.1', port, path: '/' }, (response) => {
            let text = '';
            response.on('data', (chunk) => {
              text += chunk;
            });
            response.on('end', () => resolve(text));
          })
          .on('error', reject);
      });
      assert.equal(body, 'ok', 'a jailed server must still be reachable from the host');
      const log = processLogs(started.id, 20).text;
      assert.match(log, /jailed=true/, `the process was not sandboxed: ${log}`);
    } finally {
      await stopManagedProcess(started.id);
    }
    assert.equal(
      await checkPort(port, 500),
      false,
      'the port is still open after stop_process — the sandbox outlived its child',
    );
  });

  const passed = results.filter((entry) => entry.ok).length;
  console.log(`\n[jail] ${passed}/${results.length} checks passed.`);
  await fs.rm(workspace, { recursive: true, force: true });
  if (passed !== results.length) {
    console.log(`Failed: ${results.filter((entry) => !entry.ok).map((entry) => entry.label).join(' · ')}`);
    process.exit(1);
  }
}

if (results.some((entry) => !entry.ok)) {
  process.exit(1);
}
