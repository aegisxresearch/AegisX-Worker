/**
 * The eval suite: sixteen small missions, each in its own throwaway folder.
 *
 * A task's `accept` runs *after* the office says the work is done and is the
 * only thing that decides pass or fail. It reads the files the mission left
 * behind and, where the requirement is executable, runs them itself — the
 * worker's own summary and its completion gate are never trusted as evidence.
 *
 * `mock` is the scripted plan used by `--mock`: it exists so the harness itself
 * can be tested without spending model credit. Three of those plans are wrong
 * on purpose, so a run proves the acceptance checks can tell a good result from
 * a plausible-looking one. A mission adds `synthesisMock` (the lead's second
 * pass) and `subtaskMock` (what the delegated worker does).
 */
import assert from 'node:assert/strict';

/** Joins fixture lines, so quoted JS below reads like the file it becomes. */
function lines(...rows) {
  return `${rows.join('\n')}\n`;
}

/** A folder whose own check passes, so the gate has something real to run. */
const PASSING_CHECK = {
  'package.json': `${JSON.stringify(
    { name: 'check-fixture', private: true, type: 'module', scripts: { test: 'node check.mjs' } },
    null,
    2,
  )}\n`,
  'check.mjs': 'process.exit(0);\n',
};

/** A Node fixture with `npm test` wired to the built-in runner. */
function nodePackage(name) {
  return `${JSON.stringify(
    { name, private: true, type: 'module', scripts: { test: 'node --test' } },
    null,
    2,
  )}\n`;
}

const CART_BUGGY = lines(
  'export function cartTotal(items) {',
  '  let total = 0;',
  '  for (const item of items) {',
  '    total += item.price;',
  '  }',
  '  return total;',
  '}',
);

const CART_TESTS = lines(
  "import assert from 'node:assert/strict';",
  "import test from 'node:test';",
  "import { cartTotal } from '../src/cart.mjs';",
  '',
  "test('multiplies each price by its quantity', () => {",
  '  const items = [',
  "    { name: 'Beans', price: 1000, quantity: 2 },",
  "    { name: 'Milk', price: 500, quantity: 3 },",
  '  ];',
  '  assert.equal(cartTotal(items), 3500);',
  '});',
  '',
  "test('an empty cart costs nothing', () => {",
  '  assert.equal(cartTotal([]), 0);',
  '});',
  '',
  "test('a missing quantity counts as one', () => {",
  "  assert.equal(cartTotal([{ name: 'Cup', price: 900 }]), 900);",
  '});',
);

const CART_FIXED = lines(
  'export function cartTotal(items) {',
  '  return items.reduce((sum, item) => sum + item.price * (item.quantity ?? 1), 0);',
  '}',
);

const GREETING_TESTS = lines(
  "import assert from 'node:assert/strict';",
  "import test from 'node:test';",
  "import { greet } from '../src/index.mjs';",
  '',
  "test('greets by last name first', () => {",
  "  assert.equal(greet('Ada', 'Lovelace'), 'Hello, Lovelace, Ada');",
  '});',
);

const RECEIPT_TESTS = lines(
  "import assert from 'node:assert/strict';",
  "import test from 'node:test';",
  "import { renderReceipt } from '../src/receipt.mjs';",
  '',
  "test('renders the total of an empty receipt', () => {",
  "  assert.equal(renderReceipt([]), 'Total: 0');",
  '});',
  '',
  "test('renders the total of one line', () => {",
  "  assert.equal(renderReceipt([{ cents: 1250 }]), 'Total: 1250');",
  '});',
);

/** Colour literals a stylesheet may only use inside `:root`. */
const COLOUR = /#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(/gi;

export const EVAL_TASKS = [
  {
    id: 'cart-total',
    role: 'Backend Engineer',
    title: 'Fix the cart total bug',
    detail: lines(
      '`src/cart.mjs` computes an order total, but it charges for one unit no matter how many the customer buys. A missing quantity counts as 1.',
      '',
      'Fix the bug in `src/cart.mjs`. Do not edit `test/cart.test.mjs`: the tests describe the behaviour and must pass unchanged. Run `npm test` to check.',
    ),
    files: {
      'package.json': nodePackage('cart-fixture'),
      'src/cart.mjs': CART_BUGGY,
      'test/cart.test.mjs': CART_TESTS,
    },
    timeoutMs: 240_000,
    async accept({ read, run, probe, files }) {
      assert.equal(
        await read('test/cart.test.mjs'),
        files['test/cart.test.mjs'],
        'the tests were edited; the bug has to be fixed in src/',
      );
      const tested = await run('node', ['--test']);
      assert.equal(tested.code, 0, `npm test still fails:\n${tested.output.slice(-600)}`);
      const { cartTotal } = await probe('src/cart.mjs');
      assert.equal(typeof cartTotal, 'function', 'src/cart.mjs must export cartTotal');
      assert.equal(cartTotal([{ price: 700, quantity: 3 }]), 2100);
      assert.equal(cartTotal([{ price: 250 }]), 250);
    },
    mock: [
      { tool: 'write_file', args: { path: 'src/cart.mjs', content: CART_FIXED } },
      { tool: 'complete_task', args: { summary: 'cartTotal now multiplies price by quantity.' } },
    ],
  },

  {
    id: 'slugify',
    role: 'Backend Engineer',
    title: 'Add a slugify helper',
    detail: lines(
      'Create `src/slugify.mjs` with one named export, `slugify(text)`, that turns a title into a URL slug:',
      '',
      '- lower case',
      '- accents removed ("Café" becomes "cafe")',
      '- every run of characters that is not a-z or 0-9 becomes a single hyphen',
      '- no leading or trailing hyphen',
      '',
      "`slugify('')` returns an empty string.",
    ),
    files: { 'package.json': nodePackage('slug-fixture') },
    timeoutMs: 240_000,
    async accept({ probe }) {
      const { slugify } = await probe('src/slugify.mjs');
      assert.equal(typeof slugify, 'function', 'src/slugify.mjs must export slugify');
      assert.equal(slugify('Hello, World!'), 'hello-world');
      assert.equal(slugify('  Multi   space  '), 'multi-space');
      assert.equal(slugify('Café au lait'), 'cafe-au-lait');
      assert.equal(slugify('--Already--Hyphen--'), 'already-hyphen');
      assert.equal(slugify(''), '');
    },
    mock: [
      {
        tool: 'write_file',
        args: {
          path: 'src/slugify.mjs',
          content: lines(
            'export function slugify(text) {',
            "  return text.normalize('NFD').replace(/[\\u0300-\\u036f]/g, '').toLowerCase()",
            "    .replace(/[^a-z0-9]+/g, '-')",
            "    .replace(/^-+|-+$/g, '');",
            '}',
          ),
        },
      },
      { tool: 'complete_task', args: { summary: 'Added src/slugify.mjs.' } },
    ],
  },

  {
    id: 'rename',
    role: 'Backend Engineer',
    title: 'Rename calcTotal across the module',
    detail: lines(
      '`calcTotal` in `src/totals.mjs` is now called `sumLineItems`. Rename it everywhere: the definition, the import in `src/receipt.mjs` and the call site.',
      '',
      'Keep both files where they are, keep the behaviour identical, and leave no reference to `calcTotal` in the project. `npm test` must pass.',
    ),
    files: {
      'package.json': nodePackage('rename-fixture'),
      'src/totals.mjs': lines(
        'export function calcTotal(lines) {',
        '  return lines.reduce((sum, line) => sum + line.cents, 0);',
        '}',
      ),
      'src/receipt.mjs': lines(
        "import { calcTotal } from './totals.mjs';",
        '',
        'export function renderReceipt(lines) {',
        '  return `Total: ${calcTotal(lines)}`;',
        '}',
      ),
      'test/receipt.test.mjs': RECEIPT_TESTS,
    },
    timeoutMs: 240_000,
    async accept({ read, run, probe, walk }) {
      const stale = [];
      for (const relative of await walk()) {
        if (!/\.(mjs|cjs|js|json|md)$/.test(relative)) continue;
        if (/calcTotal/.test(await read(relative))) stale.push(relative);
      }
      assert.deepEqual(stale, [], 'calcTotal is still referenced');
      const tested = await run('node', ['--test']);
      assert.equal(tested.code, 0, `npm test fails after the rename:\n${tested.output.slice(-600)}`);
      const totals = await probe('src/totals.mjs');
      assert.equal(typeof totals.sumLineItems, 'function', 'src/totals.mjs must export sumLineItems');
      assert.equal(totals.sumLineItems([{ cents: 400 }, { cents: 100 }]), 500);
      assert.equal(totals.calcTotal, undefined, 'the old name must be gone');
    },
    mock: [
      {
        tool: 'write_file',
        args: {
          path: 'src/totals.mjs',
          content: lines(
            'export function sumLineItems(lines) {',
            '  return lines.reduce((sum, line) => sum + line.cents, 0);',
            '}',
          ),
        },
      },
      {
        tool: 'write_file',
        args: {
          path: 'src/receipt.mjs',
          content: lines(
            "import { sumLineItems } from './totals.mjs';",
            '',
            'export function renderReceipt(lines) {',
            '  return `Total: ${sumLineItems(lines)}`;',
            '}',
          ),
        },
      },
      { tool: 'complete_task', args: { summary: 'Renamed calcTotal to sumLineItems.' } },
    ],
  },

  {
    id: 'css-tokens',
    role: 'Frontend Engineer',
    title: 'Tokenise the card colours',
    detail: lines(
      '`styles/app.css` has the card colours hard-coded. Move them into custom properties:',
      '',
      '- define `--surface` and `--ink` on `:root`',
      '- `.card` uses `background: var(--surface)` and `color: var(--ink)`',
      '- no other literal colour (hex, rgb, hsl) anywhere outside `:root`, and no `!important`',
    ),
    files: {
      'styles/app.css': lines(
        '.card {',
        '  padding: 24px;',
        '  background: #fdfdfc;',
        '  color: #1b1a17;',
        '}',
      ),
    },
    timeoutMs: 240_000,
    async accept({ read }) {
      const css = await read('styles/app.css');
      const root = /:root\s*\{([^}]*)\}/.exec(css);
      assert.ok(root, ':root block with the custom properties is missing');
      assert.match(root[1], /--surface\s*:/, '--surface is not defined on :root');
      assert.match(root[1], /--ink\s*:/, '--ink is not defined on :root');

      const card = /\.card\s*\{([^}]*)\}/.exec(css);
      assert.ok(card, '.card rule is missing');
      assert.match(card[1], /background\s*:\s*var\(--surface\)/, '.card does not use var(--surface)');
      assert.match(card[1], /color\s*:\s*var\(--ink\)/, '.card does not use var(--ink)');

      assert.doesNotMatch(css, /!important/);
      const all = css.match(COLOUR) ?? [];
      const inRoot = root[1].match(COLOUR) ?? [];
      assert.equal(all.length, inRoot.length, 'a literal colour is used outside :root');
    },
    mock: [
      // Wrong on purpose: the colours were copied into :root but the rule still
      // hard-codes them, which is exactly the plausible-looking non-fix.
      {
        tool: 'write_file',
        args: {
          path: 'styles/app.css',
          content: lines(
            ':root {',
            '  --surface: #fdfdfc;',
            '  --ink: #1b1a17;',
            '}',
            '',
            '.card {',
            '  padding: 24px;',
            '  background: #fdfdfc;',
            '  color: #1b1a17;',
            '}',
          ),
        },
      },
      { tool: 'complete_task', args: { summary: 'Moved the colours into :root.' } },
    ],
  },

  {
    id: 'contact-form',
    role: 'Frontend Engineer',
    title: 'Build an accessible contact form',
    detail: lines(
      'Create `contact.html`: a contact page for a coffee roastery with exactly one `<h1>` and a `<form>` containing',
      '',
      '- an email field with `id="email"` and `type="email"`, marked `required`',
      '- a `<label for="email">` that names the field',
      '- a `<button type="submit">`',
    ),
    files: {},
    timeoutMs: 240_000,
    async accept({ read }) {
      // Single quotes are valid HTML; the checks care about attributes, not style.
      const html = (await read('contact.html')).replace(/'/g, '"');
      const headings = html.match(/<h1\b/gi) ?? [];
      assert.equal(headings.length, 1, `expected exactly one <h1>, found ${headings.length}`);
      assert.match(html, /<form\b/i, 'no <form> element');
      assert.match(html, /<label[^>]*for="email"[^>]*>/i, 'no <label for="email">');
      const inputs = html.match(/<input\b[^>]*>/gi) ?? [];
      const email = inputs.find((tag) => /id="email"/i.test(tag));
      assert.ok(email, 'no <input id="email">');
      assert.match(email, /type="email"/i, 'the email input is not type="email"');
      assert.match(email, /\brequired\b/i, 'the email input is not required');
      assert.match(html, /<button[^>]*type="submit"/i, 'no <button type="submit">');
    },
    mock: [
      {
        tool: 'write_file',
        args: {
          path: 'contact.html',
          content: lines(
            '<!doctype html>',
            '<html lang="en">',
            '  <head>',
            '    <meta charset="utf-8" />',
            '    <title>Contact the roastery</title>',
            '  </head>',
            '  <body>',
            '    <h1>Contact the roastery</h1>',
            '    <form action="/contact" method="post">',
            '      <label for="email">Email</label>',
            '      <input id="email" name="email" type="email" required />',
            '      <button type="submit">Send</button>',
            '    </form>',
            '  </body>',
            '</html>',
          ),
        },
      },
      { tool: 'complete_task', args: { summary: 'Added contact.html with a labelled email field.' } },
    ],
  },

  {
    id: 'remove-legacy',
    role: 'Backend Engineer',
    title: 'Drop the legacy formatter',
    detail: lines(
      '`src/legacy.mjs` only holds `formatName`, and `src/index.mjs` imports it from there.',
      '',
      'Delete `src/legacy.mjs`, move `formatName` into `src/index.mjs`, and import nothing from legacy anywhere. `formatName` and `greet` must keep their current behaviour and `npm test` must pass.',
    ),
    files: {
      'package.json': nodePackage('greeting-fixture'),
      'src/legacy.mjs': lines(
        'export function formatName(first, last) {',
        '  return `${last}, ${first}`;',
        '}',
      ),
      'src/index.mjs': lines(
        "import { formatName } from './legacy.mjs';",
        '',
        'export function greet(first, last) {',
        '  return `Hello, ${formatName(first, last)}`;',
        '}',
      ),
      'test/index.test.mjs': GREETING_TESTS,
    },
    timeoutMs: 240_000,
    async accept({ exists, read, run, probe, walk }) {
      assert.equal(await exists('src/legacy.mjs'), false, 'src/legacy.mjs still exists');
      const stale = [];
      for (const relative of await walk()) {
        if (!/\.(mjs|cjs|js|json|md)$/.test(relative)) continue;
        if (/legacy/i.test(await read(relative))) stale.push(relative);
      }
      assert.deepEqual(stale, [], 'something still mentions legacy');
      const tested = await run('node', ['--test']);
      assert.equal(tested.code, 0, `npm test fails:\n${tested.output.slice(-600)}`);
      const index = await probe('src/index.mjs');
      assert.equal(index.formatName('Ada', 'Lovelace'), 'Lovelace, Ada');
      assert.equal(index.greet('Ada', 'Lovelace'), 'Hello, Lovelace, Ada');
    },
    mock: [
      { tool: 'delete_file', args: { path: 'src/legacy.mjs' } },
      {
        tool: 'write_file',
        args: {
          path: 'src/index.mjs',
          content: lines(
            'export function formatName(first, last) {',
            '  return `${last}, ${first}`;',
            '}',
            '',
            'export function greet(first, last) {',
            '  return `Hello, ${formatName(first, last)}`;',
            '}',
          ),
        },
      },
      { tool: 'complete_task', args: { summary: 'Moved formatName into src/index.mjs.' } },
    ],
  },

  {
    id: 'parse-tests',
    role: 'QA Engineer',
    title: 'Test the CSV parser properly',
    detail: lines(
      'Write `test/parse.test.mjs` for `parseList` in `src/parse.mjs`. Cover empty or whitespace-only input, a comma-separated list, and entries padded with spaces. Use `node:test` and `node:assert/strict`, and run the suite with `npm test`.',
      '',
      'The suite must fail if `parseList` stops looking at its input — a test that also passes against a stub returning `[]` is not enough.',
    ),
    files: {
      'package.json': nodePackage('parse-fixture'),
      'src/parse.mjs': lines(
        'export function parseList(input) {',
        "  if (input.trim().length === 0) return [];",
        "  return input.split(',').map((entry) => entry.trim());",
        '}',
      ),
    },
    timeoutMs: 300_000,
    async accept({ run, copy }) {
      const tested = await run('node', ['--test']);
      assert.equal(tested.code, 0, `the new tests do not pass:\n${tested.output.slice(-600)}`);

      // A test suite is only worth the bugs it would catch.
      const mutated = await copy();
      await mutated.write(
        'src/parse.mjs',
        lines('export function parseList() {', '  return [];', '}'),
      );
      const blind = await mutated.run('node', ['--test']);
      assert.notEqual(
        blind.code,
        0,
        'the suite still passes when parseList ignores its input — it does not test the behaviour',
      );
    },
    mock: [
      // Wrong on purpose: only the empty case is asserted, so the stub survives.
      {
        tool: 'write_file',
        args: {
          path: 'test/parse.test.mjs',
          content: lines(
            "import assert from 'node:assert/strict';",
            "import test from 'node:test';",
            "import { parseList } from '../src/parse.mjs';",
            '',
            "test('empty input gives an empty list', () => {",
            '  assert.deepEqual(parseList("   "), []);',
            '});',
          ),
        },
      },
      { tool: 'complete_task', args: { summary: 'Added a test for empty input.' } },
    ],
  },

  {
    id: 'start-script',
    role: 'DevOps Engineer',
    title: 'Repair the start script',
    detail: lines(
      '`npm start` fails: the `start` script points at a file that does not exist.',
      '',
      'Repair `package.json` so `npm start` prints `service ready` and exits 0. Do not rename or move `src/main.mjs`.',
    ),
    files: {
      'package.json': `${JSON.stringify(
        {
          name: 'service-fixture',
          private: true,
          type: 'module',
          scripts: { start: 'node src/main.js' },
        },
        null,
        2,
      )}\n`,
      'src/main.mjs': lines("console.log('service ready');"),
    },
    timeoutMs: 240_000,
    async accept({ exists, run }) {
      assert.equal(await exists('src/main.mjs'), true, 'src/main.mjs was renamed or moved');
      const started = await run('npm', ['start']);
      assert.equal(started.code, 0, `npm start exited ${started.code}:\n${started.output.slice(-600)}`);
      assert.match(started.output, /service ready/, 'npm start did not print "service ready"');
    },
    mock: [
      {
        tool: 'write_file',
        args: {
          path: 'package.json',
          content: `${JSON.stringify(
            {
              name: 'service-fixture',
              private: true,
              type: 'module',
              scripts: { start: 'node src/main.mjs' },
            },
            null,
            2,
          )}\n`,
        },
      },
      { tool: 'complete_task', args: { summary: 'start now runs src/main.mjs.' } },
    ],
  },

  {
    id: 'receipt',
    role: 'Backend Engineer',
    title: 'Render a receipt with money formatting',
    detail: lines(
      'Add `formatMoney(cents)` to `src/format.mjs`: it returns the amount in dollars with two decimals and a leading `$`, so `1234` becomes `$12.34` and `5` becomes `$0.05`.',
      '',
      'Then make `src/receipt.mjs` use it: each line becomes `${quantity} x ${name}: ${formatMoney(price * quantity)}`, in the same order. `receipt([{ name: \'Beans\', price: 1000, quantity: 2 }])` must return `[\'2 x Beans: $20.00\']`.',
    ),
    files: {
      'package.json': nodePackage('receipt-fixture'),
      'src/receipt.mjs': lines(
        'export function receipt(items) {',
        '  return items.map((item) => `${item.quantity} x ${item.name}: ${item.price * item.quantity}`);',
        '}',
      ),
    },
    timeoutMs: 240_000,
    async accept({ probe }) {
      const format = await probe('src/format.mjs');
      assert.equal(typeof format.formatMoney, 'function', 'src/format.mjs must export formatMoney');
      assert.equal(format.formatMoney(1234), '$12.34');
      assert.equal(format.formatMoney(5), '$0.05');
      assert.equal(format.formatMoney(0), '$0.00');

      const receipt = await probe('src/receipt.mjs');
      assert.deepEqual(
        receipt.receipt([
          { name: 'Beans', price: 1000, quantity: 2 },
          { name: 'Cup', price: 450, quantity: 1 },
        ]),
        ['2 x Beans: $20.00', '1 x Cup: $4.50'],
      );
    },
    mock: [
      {
        tool: 'write_file',
        args: {
          path: 'src/format.mjs',
          content: lines(
            'export function formatMoney(cents) {',
            '  return `$${(cents / 100).toFixed(2)}`;',
            '}',
          ),
        },
      },
      {
        tool: 'write_file',
        args: {
          path: 'src/receipt.mjs',
          content: lines(
            "import { formatMoney } from './format.mjs';",
            '',
            'export function receipt(items) {',
            '  return items.map((item) => `${item.quantity} x ${item.name}: ${formatMoney(item.price * item.quantity)}`);',
            '}',
          ),
        },
      },
      { tool: 'complete_task', args: { summary: 'Receipt lines now use formatMoney.' } },
    ],
  },

  {
    id: 'already-green',
    role: 'Backend Engineer',
    title: 'Fix the quantity discount total',
    detail: lines(
      'Support says multi-quantity orders are charged the wrong total. `src/cart.mjs` is the only place that adds up an order, and `npm test` covers it.',
      '',
      'Check the code against the tests. If the total is already correct, change nothing and say so in your summary — do not edit files just to look busy. Only edit a file if you find a real defect.',
    ),
    files: {
      'package.json': nodePackage('green-fixture'),
      'src/cart.mjs': CART_FIXED,
      'test/cart.test.mjs': CART_TESTS,
    },
    timeoutMs: 240_000,
    async accept({ read, run, files }) {
      const tested = await run('node', ['--test']);
      assert.equal(tested.code, 0, `npm test fails:\n${tested.output.slice(-600)}`);
      assert.equal(
        await read('src/cart.mjs'),
        files['src/cart.mjs'],
        'the working total was rewritten; nothing needed changing',
      );
    },
    mock: [
      // Wrong on purpose: a harmless-looking rewrite of code that was already right.
      {
        tool: 'write_file',
        args: {
          path: 'src/cart.mjs',
          content: lines(
            'export function cartTotal(items) {',
            '  return items.reduce((sum, item) => sum + Math.round(item.price * (item.quantity ?? 1)), 0);',
            '}',
          ),
        },
      },
      { tool: 'complete_task', args: { summary: 'Clarified the total calculation.' } },
    ],
  },

  {
    id: 'team-handoff',
    role: 'Tech Lead',
    // Created through the mission endpoint, so the lead is re-run after the
    // subtask settles and has to reconcile instead of just stopping.
    mission: true,
    title: 'Ship the team page',
    detail: lines(
      'Two deliverables, two owners. Delegate the page to Aria (Frontend Engineer) with `create_task`, then finish this mission yourself once she reports.',
      '',
      '- Aria owns `site/index.html`: a page whose `<title>` is "Kopi Nusantara" and which contains a `<main>` element with the text "Single origin, roasted weekly".',
      '- You own `STATUS.md`: after the team reports, write one line naming Aria and the page she delivered, then complete the mission.',
      '',
      'Do not write `site/index.html` yourself.',
    ),
    files: {},
    timeoutMs: 300_000,
    async accept({ read, board, usage }) {
      const page = await read('site/index.html');
      assert.match(page, /<title>\s*Kopi Nusantara\s*<\/title>/i);
      assert.match(page, /<main\b/i);
      assert.match(page, /Single origin, roasted weekly/);

      const status = await read('STATUS.md');
      assert.match(status, /Aria/, 'the status file does not name the worker who delivered the page');
      assert.match(status, /site\/index\.html/);

      const child = board.tasks.find((entry) => entry.parentId === board.task.id);
      assert.ok(child, 'the mission handed out no subtask');
      const aria = board.agents.find((agent) => agent.name === 'Aria');
      assert.ok(aria, 'Aria is not in the roster');
      assert.equal(child.assigneeId, aria.id, 'the subtask was not handed to the frontend engineer');
      assert.equal(child.pack, 'frontend', 'the role_pack the lead named did not reach the task');
      assert.equal(child.status, 'done', `the subtask ended ${child.status}`);

      // The mission's cost has to include the work it delegated, otherwise the
      // meter under-reports exactly the missions that use the most people.
      assert.ok(
        usage.rolled.totalTokens > usage.own.totalTokens,
        'the subtask spend is missing from the mission total',
      );
    },
    mock: [
      {
        tool: 'create_task',
        args: {
          title: 'Build the team page',
          detail:
            'Create `site/index.html` for the roastery: title "Kopi Nusantara", a <main> element, and the line "Single origin, roasted weekly".',
          priority: 'medium',
          assignee: 'Aria',
          // The lead names the craft explicitly: this is the only path that
          // proves `role_pack` survives the tool call, the store and the board.
          role_pack: 'frontend',
        },
      },
      // Pass 1 ends without a tool call: the lead is waiting on its teammate,
      // not claiming the mission is finished.
      { tool: null, content: 'Delegated the page to Aria; I will reconcile when she reports.' },
    ],
    synthesisMock: [
      {
        tool: 'write_file',
        args: {
          path: 'STATUS.md',
          content: lines('# Status', '', 'Aria delivered `site/index.html`.'),
        },
      },
      { tool: 'complete_task', args: { summary: 'Aria shipped the page and STATUS.md records it.' } },
    ],
    subtaskMock: {
      'Build the team page': [
        {
          tool: 'write_file',
          args: {
            path: 'site/index.html',
            content: lines(
              '<!doctype html>',
              '<html lang="en">',
              '  <head>',
              '    <meta charset="utf-8" />',
              '    <title>Kopi Nusantara</title>',
              '  </head>',
              '  <body>',
              '    <main>',
              '      <h1>Kopi Nusantara</h1>',
              '      <p>Single origin, roasted weekly.</p>',
              '    </main>',
              '  </body>',
              '</html>',
            ),
          },
        },
        { tool: 'complete_task', args: { summary: 'Wrote site/index.html.' } },
      ],
    },
  },

  {
    id: 'nudge-completion',
    role: 'Backend Engineer',
    title: 'Write the release note',
    detail: lines(
      'Create `notes.md` with the heading `# Release 1.4` and one line saying what shipped.',
      '',
      'Then finish the task.',
    ),
    files: { ...PASSING_CHECK },
    timeoutMs: 240_000,
    async accept({ read }) {
      assert.match(await read('notes.md'), /^# Release 1\.4$/m);
    },
    mock: [
      // Answers in prose: nothing written, nothing handed off. One nudge should
      // turn this into finished work instead of a blocked task.
      { tool: null, content: 'The release note is ready.' },
      {
        tool: 'write_file',
        args: {
          path: 'notes.md',
          content: lines('# Release 1.4', '', 'Faster snapshots and a mission budget.'),
        },
      },
      { tool: 'complete_task', args: { summary: 'Added notes.md.' } },
    ],
  },

  {
    id: 'retry-endpoint',
    role: 'Backend Engineer',
    title: 'Survive the flaky endpoint',
    detail: lines(
      'Create `service.md` with the heading `# Service` and one line naming the health endpoint.',
      '',
      'The endpoint is unreliable right now; get the file written anyway.',
    ),
    files: { ...PASSING_CHECK },
    timeoutMs: 240_000,
    async accept({ read }) {
      assert.match(await read('service.md'), /^# Service$/m);
    },
    mock: [
      // One 500, then the same call succeeds: the retry is what makes this pass.
      {
        http: 500,
        times: 1,
        then: {
          tool: 'write_file',
          args: { path: 'service.md', content: lines('# Service', '', 'Health: GET /healthz') },
        },
      },
      { tool: 'complete_task', args: { summary: 'Wrote service.md.' } },
    ],
  },

  {
    id: 'usage-after-failure',
    role: 'Backend Engineer',
    title: 'Draft the migration plan',
    detail: lines(
      'Create `draft.md` with the outline of a database migration.',
      '',
      'The endpoint may fail; write what you can.',
    ),
    files: {},
    acceptStatuses: ['blocked'],
    timeoutMs: 240_000,
    async accept({ read, board, usage }) {
      assert.match(await read('draft.md'), /^# Migration plan$/m);
      assert.ok(usage.own.totalTokens > 0, 'the failed turn recorded no spend');
      assert.ok(
        board.task.notes.some((note) => /Blocked by an error/.test(note)),
        JSON.stringify(board.task.notes),
      );
    },
    mock: [
      { tool: 'write_file', args: { path: 'draft.md', content: lines('# Migration plan', '', '1. Add the column.', '2. Backfill.') } },
      // Every attempt fails: the turn dies after a round that was already paid for.
      { http: 500 },
    ],
  },

  {
    id: 'mission-budget',
    role: 'Backend Engineer',
    title: 'Write a long report',
    detail: lines('Write `report.md` one section at a time.', '', 'Work through the sections in order.'),
    files: {},
    env: { OFFICE_MISSION_TOKEN_BUDGET: '1020' },
    acceptStatuses: ['blocked'],
    timeoutMs: 240_000,
    async accept({ read, board, usage }) {
      assert.match(await read('part-1.md'), /^# Part 1$/m);
      assert.ok(
        board.task.notes.some((note) => /Mission budget reached/.test(note)),
        JSON.stringify(board.task.notes),
      );
      assert.equal(usage.own.totalTokens, 1020, 'the round that ran has to be billed');
    },
    mock: [
      { tool: 'write_file', args: { path: 'part-1.md', content: lines('# Part 1') } },
      { tool: 'write_file', args: { path: 'part-2.md', content: lines('# Part 2') } },
      { tool: 'write_file', args: { path: 'part-3.md', content: lines('# Part 3') } },
    ],
  },

  {
    id: 'empty-completion',
    role: 'QA Engineer',
    title: 'Check the empty folder',
    detail: lines(
      'Confirm whether this folder needs any change at all. If it does not, record why and finish.',
      '',
      'An empty folder may well be correct.',
    ),
    files: {},
    timeoutMs: 240_000,
    async accept({ board, walk }) {
      assert.deepEqual(await walk(), [], 'the folder should still be empty');
      assert.ok(
        board.task.notes.some((note) => /No change was needed/.test(note)),
        JSON.stringify(board.task.notes),
      );
      assert.ok(
        board.task.notes.some((note) => /asked for evidence/.test(note)),
        'the gate should have asked for evidence once',
      );
    },
    mock: [
      // "Done" with no work and no check: the gate must ask once before accepting.
      { tool: 'complete_task', args: { summary: 'This folder is already in order.' } },
      { tool: 'add_note', args: { text: 'No change was needed: the folder is already in order.' } },
      { tool: 'complete_task', args: { summary: 'Verified; nothing needed changing.' } },
    ],
  },
];
