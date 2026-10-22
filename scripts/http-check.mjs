/**
 * `http_check` must answer the question the board cares about: the page loads
 * *and* every same-origin asset it references loads. A status line alone passed
 * a page whose stylesheet was a 404 in this repo before, so the check here
 * serves a page that is broken on purpose and proves the tool says so.
 *
 *   npm run check:http
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import process from 'node:process';
import { describeHttpCheck, httpCheck, HttpCheckError, referencedAssets } from '../server/src/httpCheck.ts';
import { buildToolSchemas } from '../server/src/toolSchemas.ts';
import { executeAction } from '../server/src/tools.ts';

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

function freePort() {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

const page = `<!doctype html>
<html><head>
  <title>Demo shop</title>
  <link rel="stylesheet" href="/css/app.css" />
  <link rel="icon" href="data:image/svg+xml,<svg/>" />
  <script src="/js/app.js" defer></script>
  <script src="https://cdn.example.com/lib.js"></script>
</head><body>
  <img src="img/logo.png" alt="" />
  <a href="/about">About</a>
</body></html>`;

const brokenPage = `<!doctype html><html><head>
  <link rel="stylesheet" href="/css/app.css" />
  <script src="/lib/private.js"></script>
</head><body>broken</body></html>`;

const missingPage = `<!doctype html><html><head>
  <script src="/js/nope.js"></script>
</head><body>missing</body></html>`;

console.log('\n[http_check] reference parsing');

await check('same-origin references are resolved, deduped and external links skipped', () => {
  const { urls, skipped } = referencedAssets(page, new URL('http://127.0.0.1:3000/'));
  assert.deepEqual(urls, [
    'http://127.0.0.1:3000/css/app.css',
    'http://127.0.0.1:3000/js/app.js',
    'http://127.0.0.1:3000/img/logo.png',
  ]);
  assert.ok(skipped.some((entry) => entry.includes('cdn.example.com')), JSON.stringify(skipped));
  assert.ok(!skipped.some((entry) => entry.startsWith('data:')), 'data: URIs must be ignored, not listed');
});

const port = await freePort();
const origin = `http://127.0.0.1:${port}`;
const server = http.createServer((request, response) => {
  const send = (status, type, body = '') => {
    response.writeHead(status, { 'Content-Type': type, 'Content-Length': Buffer.byteLength(body) });
    response.end(body);
  };
  switch (request.url) {
    case '/':
      return send(200, 'text/html; charset=utf-8', page);
    case '/preview':
      return send(200, 'text/html; charset=utf-8', brokenPage);
    case '/missing':
      return send(200, 'text/html; charset=utf-8', missingPage);
    case '/css/app.css':
      return send(200, 'text/css; charset=utf-8', 'body{color:#123}');
    case '/js/app.js':
      return send(200, 'text/javascript; charset=utf-8', 'console.log(1)');
    case '/img/logo.png':
      return send(200, 'image/png', 'png');
    case '/lib/private.js':
      return send(403, 'text/plain; charset=utf-8', 'Forbidden');
    case '/api/health':
      return send(200, 'application/json; charset=utf-8', '{"ok":true}');
    default:
      return send(404, 'text/plain; charset=utf-8', 'Not found');
  }
});
await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));

console.log('\n[http_check] against a real server');

await check('a healthy page and all of its assets pass', async () => {
  const result = await httpCheck({ url: `${origin}/`, expectText: 'Demo shop' });
  assert.equal(result.ok, true, result.message);
  assert.equal(result.page.status, 200);
  assert.equal(result.assets.length, 3);
  assert.deepEqual(result.assets.map((asset) => asset.path).sort(), [
    '/css/app.css',
    '/img/logo.png',
    '/js/app.js',
  ]);
  assert.equal(result.textMatched, true);
  assert.match(result.message, /3\/3 asset\(s\) OK/);
  assert.match(describeHttpCheck(result), /ok\s+\/css\/app\.css/);
});

await check('a 403 asset fails the page, and the path is named', async () => {
  const result = await httpCheck({ url: `${origin}/preview` });
  assert.equal(result.ok, false, 'a page whose script is 403 must not pass');
  assert.ok(
    result.failures.some((failure) => failure.includes('/lib/private.js') && failure.includes('403')),
    JSON.stringify(result.failures),
  );
  assert.match(result.message, /1\/2 asset\(s\) OK/);
});

await check('a 404 asset fails the page', async () => {
  const result = await httpCheck({ url: `${origin}/missing` });
  assert.equal(result.ok, false);
  assert.ok(result.failures.some((failure) => failure.includes('/js/nope.js') && failure.includes('404')));
});

await check('missing expected copy is a failure, not a silent pass', async () => {
  const result = await httpCheck({ url: `${origin}/`, expectText: 'Checkout' });
  assert.equal(result.ok, false);
  assert.equal(result.textMatched, false);
  assert.ok(result.failures.some((failure) => failure.includes('expected text not found')));
});

await check('only loopback URLs are reachable', async () => {
  await assert.rejects(
    () => httpCheck({ url: 'https://example.com/' }),
    (error) => error instanceof HttpCheckError && /only reaches this machine/i.test(error.message),
  );
  await assert.rejects(
    () => httpCheck({ url: 'not a url' }),
    (error) => error instanceof HttpCheckError,
  );
});

console.log('\n[http_check] wiring');

await check('the tool is offered to the model when file tools are on', () => {
  const names = buildToolSchemas({ files: true, web: false }).map((tool) => tool.function.name);
  assert.ok(names.includes('http_check'), names.join(', '));
  const hidden = buildToolSchemas({ files: false, web: false }).map((tool) => tool.function.name);
  assert.ok(!hidden.includes('http_check'), 'http_check must follow the tools switch');
});

await check('the action dispatcher routes http_check and explains the failure', async () => {
  const handlers = {
    moveTo: () => 'moved',
    setStatus: () => 'status',
    completeTask: () => 'done',
    addNote: () => 'note',
    createTask: () => 'task',
  };
  const context = {
    agentId: 'agent_check',
    agentName: 'Checker',
    taskId: null,
    toolsEnabled: true,
    webEnabled: false,
    workspaceRoot: path.join(process.cwd(), 'workspace'),
  };
  const healthy = await executeAction({ action: 'http_check', url: `${origin}/` }, context, handlers);
  assert.equal(healthy.ok, true, healthy.summary);
  assert.match(healthy.detail ?? '', /\/js\/app\.js/);

  const broken = await executeAction({ action: 'http_check', url: `${origin}/preview` }, context, handlers);
  assert.equal(broken.ok, false);
  assert.match(broken.summary, /403/);
  assert.match(broken.detail ?? '', /FAIL \/lib\/private\.js/);

  const disabled = await executeAction(
    { action: 'http_check', url: `${origin}/` },
    { ...context, toolsEnabled: false },
    handlers,
  );
  assert.equal(disabled.ok, false);
  assert.match(disabled.summary, /disabled/i);
});

server.close();

const passed = results.filter((entry) => entry.ok).length;
console.log(`\n[http] ${passed}/${results.length} checks passed.`);
if (passed !== results.length) {
  console.log(`Failed: ${results.filter((entry) => !entry.ok).map((entry) => entry.label).join(' · ')}`);
  process.exit(1);
}
