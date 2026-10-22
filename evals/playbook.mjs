/**
 * The playbook suite: one mission per role pack, scored only by that pack's
 * definition of done.
 *
 * The point is not that a model can write a file. It is that the bar the pack
 * states is the bar the mission is judged against — a QA task passes when the
 * test is still honest and green, a data task passes when the load is
 * idempotent, a security task passes when the finding names a line. Without
 * this, a pack is prose that costs tokens and changes nothing measurable.
 *
 * Each fixture carries three things the check can use without a model:
 *
 *   files    the starting folder,
 *   mock     what a worker who follows the pack actually does,
 *   accept   the yardstick — the same function a real run is scored by,
 *   breakIt  one realistic way to look done without being done.
 *
 * `scripts/playbook-check.mjs` replays each fixture offline: it applies `mock`,
 * requires `accept` to pass, then applies `breakIt` and requires `accept` to
 * fail. A yardstick that cannot tell those two trees apart is not a yardstick.
 * `scripts/eval-playbook.mjs` runs the same fixtures against a model.
 */
import assert from 'node:assert/strict';

/** A `write_file` step for the scripted model. */
const write = (relative, content) => ({
  tool: 'write_file',
  args: { path: relative, content },
});

/** Ends the turn with a summary that names the deliverable. */
const done = (summary) => ({ tool: 'complete_task', args: { summary } });

const htmlPage = (body) => `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Kopi Nusantara</title></head>
<body>
${body}
</body>
</html>
`;

const GOOD_PAGE = htmlPage(`  <main>
    <h1>Single origin, roasted weekly</h1>
    <p id="stock">In stock</p>
    <button id="order" type="button">Order</button>
    <button id="empty" type="button" disabled>Order</button>
  </main>`);

const BAD_PAGE = htmlPage(`  <div class="hero" style="background:#7c3aed">
    <h1>Single origin, roasted weekly</h1>
    <button id="order">Order</button>
  </div>`);

const CART_SOURCE = `export function cartTotal(items) {
  let total = 0;
  for (const item of items) {
    total += item.price;
  }
  return total;
}
`;

const CART_FIXED = `export function cartTotal(items) {
  let total = 0;
  for (const item of items) {
    total += item.price * (item.quantity ?? 1);
  }
  return total;
}
`;

const CART_TEST = `import assert from 'node:assert/strict';
import test from 'node:test';
import { cartTotal } from '../src/cart.mjs';

test('multiplies each price by its quantity', () => {
  const items = [
    { name: 'Beans', price: 1000, quantity: 2 },
    { name: 'Milk', price: 500, quantity: 3 },
  ];
  assert.equal(cartTotal(items), 3500);
});

test('an empty cart costs nothing', () => {
  assert.equal(cartTotal([]), 0);
});
`;

const ORDERS_ROUTE = `export function getOrder(id) {
  if (typeof id !== 'string' || id.trim().length === 0) {
    return { status: 400, body: { ok: false, message: 'id is required' } };
  }
  return { status: 200, body: { ok: true, id } };
}
`;

const ORDERS_TEST = `import assert from 'node:assert/strict';
import test from 'node:test';
import { getOrder } from '../server/routes/orders.mjs';

test('a missing id is a 400 with a message, not a stack trace', () => {
  const response = getOrder('');
  assert.equal(response.status, 400);
  assert.equal(response.body.ok, false);
});

test('a real id comes back', () => {
  assert.deepEqual(getOrder('o-1').body, { ok: true, id: 'o-1' });
});
`;

const LOADER = `import fs from 'node:fs/promises';

const rows = JSON.parse(await fs.readFile(new URL('./seed.json', import.meta.url), 'utf8'));
const target = new URL('./orders.json', import.meta.url);
const existing = await fs.readFile(target, 'utf8').then(JSON.parse, () => []);
const byId = new Map(existing.map((row) => [row.id, row]));
for (const row of rows) byId.set(row.id, row);
await fs.writeFile(target, JSON.stringify([...byId.values()], null, 2));
console.log(byId.size);
`;

const LOADER_BROKEN = LOADER.replace(
  "for (const row of rows) byId.set(row.id, row);",
  'for (const row of rows) byId.set(`${row.id}-${byId.size}`, row);',
);

const SUMMARIZER = `const PROMPT = [
  'Role: you classify a support message.',
  'Output: exactly one JSON object {"label":"billing"|"technical"|"other"}',
].join(' ');

export function parseVerdict(raw) {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1));
    if (!['billing', 'technical', 'other'].includes(parsed.label)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export { PROMPT };
`;

const SUMMARIZER_TEST = `import assert from 'node:assert/strict';
import test from 'node:test';
import { parseVerdict } from '../server/src/summarizer.mjs';

test('an unreadable reply is null, never a default label', () => {
  assert.equal(parseVerdict('the model refused'), null);
  assert.equal(parseVerdict('{"label":"refund"}'), null);
});

test('a valid reply is read', () => {
  assert.equal(parseVerdict('ok {"label":"billing"}').label, 'billing');
});
`;

const SUMMARIZER_BROKEN = SUMMARIZER.replace(
  "if (start === -1 || end <= start) return null;",
  "if (start === -1 || end <= start) return { label: 'other' };",
);

const TRAINER = `const SEED = 7;
export function split(rows, ratio = 0.8) {
  const cut = Math.floor(rows.length * ratio);
  return { train: rows.slice(0, cut), test: rows.slice(cut) };
}

export function score(model, rows) {
  const correct = rows.filter((row) => model(row) === row.label).length;
  return correct / rows.length;
}
`;

const EVALUATOR = `import { split, score } from './train.mjs';

const rows = [
  { text: 'refund please', label: 'billing' },
  { text: 'it crashed', label: 'technical' },
  { text: 'where is my order', label: 'billing' },
  { text: '500 error on save', label: 'technical' },
];

const { train, test } = split(rows);
const baseline = () => 'billing';
const trained = (row) => (/error|crash|500/i.test(row.text) ? 'technical' : 'billing');
console.log(JSON.stringify({ rows: rows.length, train: train.length, test: test.length, baseline: score(baseline, test), trained: score(trained, test) }));
`;

const DEV_SECURITY = `# Security review

## Finding 1 — unvalidated id reaches the database
- Where: \`server/routes/orders.mjs:3\`
- Attack path: an attacker sends \`GET /api/orders/../../etc\` and the id is concatenated into the query, so the row lookup becomes a traversal.
- Fix: reject an id that does not match \`^[a-z0-9-]{1,40}$\` at the edge.
- Verified: the 400 branch in \`test/orders.test.mjs\` returns before the query.
`;

const BAD_SECURITY = `# Security review

## Finding 1 — the orders route feels risky
- Where: the orders area
- Attack path: someone could try bad input.
- Fix: add validation.
`;

const DATA_MIGRATION = `-- 001_orders_index.sql
CREATE INDEX IF NOT EXISTS orders_created_at_idx ON orders (created_at);
`;

const DATA_REPORT = `# Load report

- Seed rows: 3, distinct ids: 3
- First run: 3 rows
- Second run: 3 rows
- CHECKSUM: 3 rows after re-running, unchanged.
`;

const DEVOPS_COMPOSE = `services:
  api:
    image: ghcr.io/kopi/api:1.4.2
    ports: ['8080:8080']
    healthcheck:
      test: ['CMD', 'node', '-e', "fetch('http://127.0.0.1:8080/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]
      interval: 10s
`;

const DEVOPS_HEALTH = `# Runbook

- Start: \`docker compose up -d\`
- Health: \`curl -fsS http://127.0.0.1:8080/health\` returns 200
- Logs: \`docker compose logs -f api\`
- Stop: \`docker compose down\`
- Rollback: \`docker compose down\` then set \`ghcr.io/kopi/api:1.4.1\` and \`up -d\` again.
`;

const DEVOPS_BAD = `# Runbook

- Start: \`docker compose up\`
- It should work.
`;

const SPEC = `# Checkout speed

## Acceptance criteria

- [ ] A visitor with one item reaches the payment step in under three clicks, verified by a scripted browser run.
- [ ] The order summary shows the total including shipping, checked against the cart fixture.

## Non-goals

- Saved cards, guest checkout and multi-currency are out of scope for this slice.
`;

const PRODUCT_BAD = `# Checkout speed

Make checkout faster and nicer for users. It should feel modern.
`;

const PLAN = `# Mission plan

| Owner | Files | Deliverable | Evidence |
|---|---|---|---|
| Aria | \`site/index.html\` | landing page | http_check 200 + title match |
| Bimo | \`server/routes/orders.mjs\` | orders endpoint | node --test test/orders.test.mjs |
`;

const PLAN_BAD = `# Mission plan

- Aria: page
- Bimo: api
`;

const PROMPT_FILE = `# Summarise a support thread

## Role
You are a support triage assistant.

## Goal
Label one thread as billing, technical or other.

## Inputs
- \`threads/example.json\`

## Constraints
- Never invent a label outside the three.
- If the thread is unreadable, return \`{"label":"other"}\` and say why.

## Output
Exactly one JSON object: \`{"label":"billing"|"technical"|"other","reason":"one line"}\`
`;

const PROMPT_CASES = `${JSON.stringify(
  [
    { input: 'I was charged twice', expect: { label: 'billing' } },
    { input: 'The app crashes on save', expect: { label: 'technical' } },
    { input: '', expect: { label: 'other' }, refusal: true },
  ],
  null,
  2,
)}
`;

const MOBILE_SCREEN = `import 'package:flutter/material.dart';

class OrdersScreen extends StatelessWidget {
  const OrdersScreen({super.key, required this.state, required this.onRetry});

  final OrdersState state;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    if (state.loading) return const Center(child: CircularProgressIndicator());
    if (state.error != null) {
      return Column(children: [Text('Could not load orders'), TextButton(onPressed: onRetry, child: const Text('Retry'))]);
    }
    if (state.orders.isEmpty) return const Center(child: Text('No orders yet'));
    return ListView.builder(itemCount: state.orders.length, itemBuilder: (context, index) => Text(state.orders[index].id));
  }
}
`;

export const PLAYBOOK_TASKS = [
  {
    id: 'pack-lead',
    pack: 'lead',
    role: 'Tech Lead',
    proves: 'Every subtask has an owner, an owned file set and a result you have actually read',
    title: 'Plan the checkout mission',
    detail:
      'Write `PLAN.md` for the checkout mission: one row per subtask with the owner, the file set it owns, the deliverable and the evidence that will prove it. Do not write the code; the plan is the deliverable.',
    files: {},
    mock: [write('PLAN.md', PLAN), done('Wrote PLAN.md with two owned subtasks and their evidence.')],
    async accept({ read }) {
      const plan = await read('PLAN.md');
      const rows = plan.split('\n').filter((line) => line.startsWith('|') && !/^\|[\s|:-]+\|$/.test(line));
      assert.ok(rows.length >= 3, 'the plan has no data rows');
      for (const row of rows.slice(1)) {
        assert.match(row, /`[^`]+\.(?:ts|mjs|html|md)`/, `a row owns no file: ${row}`);
        assert.match(row, /check|test|200|title/i, `a row names no evidence: ${row}`);
      }
    },
    async breakIt({ write: put }) {
      await put('PLAN.md', PLAN_BAD);
    },
  },

  {
    id: 'pack-prompt',
    pack: 'prompt',
    role: 'Prompt Engineer',
    proves: 'The prompt file states its input contract, and an evaluation (a script or a named case list) passes against it',
    title: 'Write the triage prompt',
    detail:
      'Write `prompts/summarize.md` with role, goal, inputs, constraints and output shape, plus `prompts/cases.json` holding at least three cases including one refusal. The prompt names its input file and the exact output object.',
    files: {},
    mock: [
      write('prompts/summarize.md', PROMPT_FILE),
      write('prompts/cases.json', PROMPT_CASES),
      done('Wrote the prompt and three cases, one of them a refusal.'),
    ],
    async accept({ read }) {
      const prompt = await read('prompts/summarize.md');
      for (const section of ['## Role', '## Goal', '## Inputs', '## Constraints', '## Output']) {
        assert.match(prompt, new RegExp(section), `the prompt has no ${section}`);
      }
      assert.match(prompt, /`threads\/example\.json`/, 'the input contract names no file');
      assert.doesNotMatch(prompt, /TODO|TBD|lorem/i, 'the prompt still has a placeholder');
      const cases = JSON.parse(await read('prompts/cases.json'));
      assert.ok(Array.isArray(cases) && cases.length >= 3, 'fewer than three cases');
      assert.ok(cases.some((entry) => entry.refusal === true), 'no refusal case');
    },
    async breakIt({ write: put }) {
      await put('prompts/cases.json', JSON.stringify([{ input: 'I was charged twice', expect: { label: 'billing' } }]));
    },
  },

  {
    id: 'pack-frontend',
    pack: 'frontend',
    role: 'Frontend Engineer',
    proves: 'The page returns 200, its assets resolve and the text the task asked for is on it',
    title: 'Build the roastery page',
    detail:
      'Create `site/index.html`: a `<main>` with the heading "Single origin, roasted weekly" and a real `<button>` for ordering. Every state has markup, no inline styles, and the page loads with no external asset.',
    files: {},
    mock: [write('site/index.html', GOOD_PAGE), done('Wrote site/index.html with a main, a heading and real buttons.')],
    async accept({ read }) {
      const page = await read('site/index.html');
      assert.match(page, /<main\b/i);
      assert.match(page, /Single origin, roasted weekly/);
      assert.match(page, /<button[^>]*type="button"/i, 'the action is not a real button');
      assert.doesNotMatch(page, /\sstyle="/i, 'inline styles bypass the tokens');
      assert.doesNotMatch(page, /<div[^>]*onclick=/i, 'a click handler on a div is not a button');
    },
    async breakIt({ write: put }) {
      await put('site/index.html', BAD_PAGE);
    },
  },

  {
    id: 'pack-backend',
    pack: 'backend',
    role: 'Backend Engineer',
    proves: 'The endpoint answered a real request, and the failure path returns a status and a message rather than a stack trace',
    title: 'Add the orders endpoint',
    detail:
      'Create `server/routes/orders.mjs` exporting `getOrder(id)` that returns 400 with a message for a missing id, and add the failure case to `test/orders.test.mjs`. Run `node --test test/orders.test.mjs`.',
    files: {},
    mock: [
      write('server/routes/orders.mjs', ORDERS_ROUTE),
      write('test/orders.test.mjs', ORDERS_TEST),
      done('Added the route and its 400 case; node --test passes.'),
    ],
    async accept({ read, run }) {
      const result = await run('node', ['--test', 'test/orders.test.mjs']);
      assert.equal(result.code, 0, `the route test fails: ${result.output}`);
      const route = await read('server/routes/orders.mjs');
      assert.match(route, /status:\s*400/, 'no 400 branch');
      assert.match(route, /message:/, 'the failure carries no message');
    },
    async breakIt({ write: put }) {
      await put('server/routes/orders.mjs', 'export function getOrder(id) {\n  return { status: 200, body: { ok: true, id } };\n}\n');
    },
  },

  {
    id: 'pack-mobile',
    pack: 'mobile',
    role: 'Mobile App Engineer',
    proves: 'The project analyzes clean and the screen was exercised in each of its states',
    title: 'Add the orders screen states',
    detail:
      'Write `lib/screens/orders_screen.dart` so the screen renders loading, error with retry, empty and list states. No network call inside the widget: `lib/data/orders_repository.dart` owns it.',
    files: {},
    mock: [
      write('lib/screens/orders_screen.dart', MOBILE_SCREEN),
      write(
        'lib/data/orders_repository.dart',
        "class OrdersRepository {\n  Future<List<dynamic>> fetch() async => [];\n}\n",
      ),
      done('Screen renders loading, error, empty and list; the repository owns the call.'),
    ],
    async accept({ read, exists }) {
      const screen = await read('lib/screens/orders_screen.dart');
      for (const state of ['CircularProgressIndicator', "Text('Could not load orders')", "Text('No orders yet')", 'ListView.builder']) {
        assert.ok(screen.includes(state), `the screen has no state for ${state}`);
      }
      // Rendered copy is not enough: the branch has to be reached from state, or
      // an error screen nobody can trigger still passes a text search.
      assert.match(screen, /state\.error/, 'the error state is never read');
      assert.match(screen, /state\.loading/, 'the loading state is never read');
      assert.match(screen, /state\.orders\.isEmpty/, 'the empty state is never read');
      assert.doesNotMatch(screen, /http\.|Dio\(|dio\./, 'the widget calls the network itself');
      assert.equal(await exists('lib/data/orders_repository.dart'), true, 'no repository');
    },
    async breakIt({ write: put }) {
      await put('lib/screens/orders_screen.dart', MOBILE_SCREEN.replace('if (state.error != null)', 'if (false)'));
    },
  },

  {
    id: 'pack-ai',
    pack: 'ai',
    role: 'AI Engineer',
    proves: 'The model call was run for real, and both the accepted and the unreadable-reply paths were observed',
    title: 'Harden the triage call',
    detail:
      'Write `server/src/summarizer.mjs` with the system prompt and `parseVerdict(raw)` returning null for an unreadable reply, plus `test/summarizer.test.mjs` covering the garbage path. Run `node --test test/summarizer.test.mjs`.',
    files: {},
    mock: [
      write('server/src/summarizer.mjs', SUMMARIZER),
      write('test/summarizer.test.mjs', SUMMARIZER_TEST),
      done('Parser returns null on an unreadable reply; both paths covered by node --test.'),
    ],
    async accept({ read, run }) {
      const result = await run('node', ['--test', 'test/summarizer.test.mjs']);
      assert.equal(result.code, 0, `the parser test fails: ${result.output}`);
      const source = await read('server/src/summarizer.mjs');
      assert.match(source, /Role:/, 'the prompt states no role');
      assert.match(source, /Output:/, 'the prompt states no output shape');
      assert.match(source, /return null/, 'an unreadable reply has no null path');
    },
    async breakIt({ write: put }) {
      await put('server/src/summarizer.mjs', SUMMARIZER_BROKEN);
    },
  },

  {
    id: 'pack-ml',
    pack: 'ml',
    role: 'ML Engineer',
    proves: 'A baseline and the trained model are compared on the same split, with the numbers recorded',
    title: 'Evaluate the triage model',
    detail:
      'Create `ml/train.mjs` with an 80/20 split and `ml/evaluate.mjs` that scores a majority baseline and the trained rule on the test split. Record both numbers and the split sizes in `ml/RESULTS.md`; run `node ml/evaluate.mjs`.',
    files: {},
    mock: [
      write('ml/train.mjs', TRAINER),
      write('ml/evaluate.mjs', EVALUATOR),
      write(
        'ml/RESULTS.md',
        '# Results\n\n- Split: 4 rows, 3 train / 1 test (80/20, seed 7)\n- Baseline (majority class): 0.0\n- Trained rule: 1.0\n- Test slice was never used to choose the rule.\n',
      ),
      done('Ran the evaluation: 3/1 split, baseline 0.0, trained 1.0 on the test slice.'),
    ],
    async accept({ read, run }) {
      const result = await run('node', ['ml/evaluate.mjs']);
      assert.equal(result.code, 0, `the evaluation does not run: ${result.output}`);
      const numbers = JSON.parse(result.output);
      assert.equal(numbers.train + numbers.test, numbers.rows, 'the split does not reconcile');
      const report = await read('ml/RESULTS.md');
      assert.match(report, /baseline/i, 'no baseline recorded');
      assert.match(report, /0\.0[\s\S]*1\.0|1\.0[\s\S]*0\.0/, 'the two scores are missing');
    },
    async breakIt({ write: put }) {
      await put('ml/RESULTS.md', '# Results\n\n- It worked well.\n');
    },
  },

  {
    id: 'pack-qa',
    pack: 'qa',
    role: 'QA Engineer',
    proves: 'The failing case exists, fails before the fix, and passes after it',
    title: 'Fix the cart total',
    detail:
      '`src/cart.mjs` ignores quantity: `test/cart.test.mjs` already fails. Fix the source so `node --test test/cart.test.mjs` passes, and do not change the test.',
    files: {
      'src/cart.mjs': CART_SOURCE,
      'test/cart.test.mjs': CART_TEST,
    },
    mock: [write('src/cart.mjs', CART_FIXED), done('Cart multiplies by quantity; the existing test passes unchanged.')],
    async accept({ read, run, files }) {
      const result = await run('node', ['--test', 'test/cart.test.mjs']);
      assert.equal(result.code, 0, `the suite is not green: ${result.output}`);
      const test = await read('test/cart.test.mjs');
      assert.equal(test, files['test/cart.test.mjs'], 'the test was edited instead of the source');
      assert.doesNotMatch(test, /\.skip|\.todo|test\.only/, 'a case was skipped');
    },
    async breakIt({ write: put, read }) {
      const test = await read('test/cart.test.mjs');
      await put('test/cart.test.mjs', test.replace("assert.equal(cartTotal(items), 3500);", '// checked by hand'));
    },
  },

  {
    id: 'pack-security',
    pack: 'security',
    role: 'Security Engineer',
    proves: 'Each finding names the file and line, the attack path, and the smallest fix that closes it',
    title: 'Review the orders route',
    detail:
      'Review `server/routes/orders.mjs` and write `SECURITY.md`: each finding names the file and line, the attack path, the fix and what you verified. Read-only on the source.',
    files: { 'server/routes/orders.mjs': ORDERS_ROUTE },
    mock: [write('SECURITY.md', DEV_SECURITY), done('One finding with file:line, attack path and a verified fix in SECURITY.md.')],
    async accept({ read }) {
      const report = await read('SECURITY.md');
      assert.match(report, /server\/routes\/orders\.mjs:\d+/, 'a finding names no file and line');
      assert.match(report, /attack path/i, 'a finding states no attack path');
      assert.match(report, /fix:/i, 'a finding states no fix');
      assert.match(report, /verified/i, 'nothing says what was verified');
    },
    async breakIt({ write: put }) {
      await put('SECURITY.md', BAD_SECURITY);
    },
  },

  {
    id: 'pack-data',
    pack: 'data',
    role: 'Data Engineer',
    proves: 'Row counts before and after the load are stated, and they reconcile',
    title: 'Make the orders load re-runnable',
    detail:
      'Write `load.mjs` so loading `seed.json` twice leaves the same rows, add `migrations/001_orders_index.sql`, and record the counts from two runs in `LOAD.md`. Run `node load.mjs` twice.',
    files: {
      'seed.json': JSON.stringify([
        { id: 'o-1', total: 10 },
        { id: 'o-2', total: 20 },
        { id: 'o-3', total: 30 },
      ]),
    },
    mock: [
      write('load.mjs', LOADER),
      write('migrations/001_orders_index.sql', DATA_MIGRATION),
      write('LOAD.md', DATA_REPORT),
      done('Ran the load twice: 3 rows both times, counts recorded in LOAD.md.'),
    ],
    async accept({ read, run }) {
      const first = await run('node', ['load.mjs']);
      assert.equal(first.code, 0, `the load fails: ${first.output}`);
      const second = await run('node', ['load.mjs']);
      assert.equal(second.code, 0, `the second load fails: ${second.output}`);
      assert.equal(first.output.trim(), second.output.trim(), 'a second run changed the row count');
      const rows = JSON.parse(await read('orders.json'));
      assert.equal(new Set(rows.map((row) => row.id)).size, rows.length, 'duplicate rows landed');
      assert.match(await read('migrations/001_orders_index.sql'), /CREATE INDEX/i);
      const report = await read('LOAD.md');
      assert.match(report, /first run: 3/i, 'the first count is not recorded');
      assert.match(report, /second run: 3/i, 'the second count is not recorded');
    },
    async breakIt({ write: put }) {
      await put('load.mjs', LOADER_BROKEN);
    },
  },

  {
    id: 'pack-devops',
    pack: 'devops',
    role: 'DevOps Engineer',
    proves: 'The service started, answered its health check, and stopped cleanly',
    title: 'Pin the api image and write the runbook',
    detail:
      'Write `compose.yml` for the api with a pinned image tag and a healthcheck, and `RUNBOOK.md` with start, health, stop and rollback commands. No `:latest`; compose must parse with `docker compose config` if docker exists.',
    files: {},
    mock: [
      write('compose.yml', DEVOPS_COMPOSE),
      write('RUNBOOK.md', DEVOPS_HEALTH),
      done('compose.yml pins api 1.4.2 with a healthcheck; RUNBOOK.md covers start, health, stop and rollback.'),
    ],
    async accept({ read }) {
      const compose = await read('compose.yml');
      assert.match(compose, /ghcr\.io\/kopi\/api:1\.4\.2/, 'the image is not pinned');
      assert.doesNotMatch(compose, /:latest/, 'a floating tag is an outage waiting');
      assert.match(compose, /healthcheck:/, 'no healthcheck');
      const runbook = await read('RUNBOOK.md');
      for (const part of ['Start:', 'Health:', 'Stop:', 'Rollback:']) {
        assert.ok(runbook.includes(part), `the runbook has no ${part}`);
      }
    },
    async breakIt({ write: put }) {
      await put('RUNBOOK.md', DEVOPS_BAD);
    },
  },

  {
    id: 'pack-product',
    pack: 'product',
    role: 'Product Manager',
    proves: 'Each requirement is testable and each one is either met with evidence or reported as not met',
    title: 'Spec the checkout slice',
    detail:
      'Write `SPEC.md` with acceptance criteria that a script can check and an explicit non-goals section. Do not implement anything; the spec is the deliverable.',
    files: {},
    mock: [write('SPEC.md', SPEC), done('SPEC.md has two testable criteria, a non-goals section and no implementation.')],
    async accept({ read, walk }) {
      const files = await walk();
      assert.deepEqual(files, ['SPEC.md'], `the spec mission changed other files: ${files.join(', ')}`);
      const spec = await read('SPEC.md');
      const criteria = spec.split('\n').filter((line) => /^- \[ \]/.test(line));
      assert.ok(criteria.length >= 2, `only ${criteria.length} acceptance criteria`);
      for (const line of criteria) {
        assert.match(line, /verified|checked|scripted/i, `a criterion is not testable: ${line}`);
      }
      assert.match(spec, /## Non-goals/, 'the spec sets no boundary');
    },
    async breakIt({ write: put }) {
      await put('SPEC.md', PRODUCT_BAD);
    },
  },

  {
    id: 'pack-general',
    pack: 'general',
    role: 'Engineer',
    proves: 'The change is in the folder and the nearest check was run against it',
    title: 'Rename the retry limit',
    detail:
      'Rename `MAX_RETRIES` to `MAX_ATTEMPTS` in `src/config.mjs` and every use in `src/client.mjs`, then run `node check.mjs` and report the result.',
    files: {
      'src/config.mjs': 'export const MAX_RETRIES = 3;\n',
      'src/client.mjs': "import { MAX_RETRIES } from './config.mjs';\n\nexport const attempts = () => MAX_RETRIES;\n",
      'check.mjs': "import { attempts } from './src/client.mjs';\nif (attempts() !== 3) process.exit(1);\n",
    },
    mock: [
      write('src/config.mjs', 'export const MAX_ATTEMPTS = 3;\n'),
      write('src/client.mjs', "import { MAX_ATTEMPTS } from './config.mjs';\n\nexport const attempts = () => MAX_ATTEMPTS;\n"),
      done('Renamed in both files; node check.mjs exits 0.'),
    ],
    async accept({ read, run, walk }) {
      const files = await walk();
      for (const file of files.filter((name) => name.endsWith('.mjs'))) {
        assert.doesNotMatch(await read(file), /MAX_RETRIES/, `${file} still uses the old name`);
      }
      const result = await run('node', ['check.mjs']);
      assert.equal(result.code, 0, `the check fails: ${result.output}`);
    },
    async breakIt({ write: put }) {
      await put('src/client.mjs', "import { MAX_RETRIES } from './config.mjs';\n\nexport const attempts = () => MAX_RETRIES;\n");
    },
  },
];
