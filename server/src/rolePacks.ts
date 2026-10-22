/**
 * What each role on the team is actually expected to do, and the practice every
 * role shares.
 *
 * A generic agent prompt produces generic work: a Frontend Engineer and a Data
 * Engineer receive the same thousand tokens of instructions and both answer
 * with the same middling paragraph. A pack is the missing half — the craft bar,
 * the evidence that counts as done, and the failure the independent reviewer
 * should refuse for that role specifically.
 *
 * Three things keep this honest:
 * - `resolveRolePack` never throws and never returns null: an unknown or
 *   free-form role gets the default pack, because a worker with no playbook is
 *   worse than a worker with a general one.
 * - The shared doctrine is one block, identical for every worker, so the
 *   provider can cache the prefix. Only the pack after it varies.
 * - `scripts/prompt-check.mjs` pins the order and the budget, and proves that
 *   every seeded role lands on its own pack instead of the default.
 *
 * Two joins live here because they are the same question from two sides. A
 * choice carries its reason (`source` + `evidence`), so a wrong pack is a bug
 * someone can report rather than a mystery in a prompt. And a refusal is mapped
 * back to the bullet it cites, so a pack whose bar is misspoken is found by
 * counting rather than by re-reading thirteen playbooks.
 */
import type { MessageKey } from '../../shared/i18n.ts';
import type {
  PackRefusal,
  PackRefusalRule,
  PackSource,
  RefusalSummary,
  Task,
} from '../../shared/types.ts';

/** One rule of team practice: a title for the eye, a sentence for the model. */
export interface DoctrineRule {
  id: string;
  title: string;
  text: string;
}

/**
 * How this team works, in the order a task actually moves: brief, build,
 * prove, hand off.
 *
 * "Briefing is prompt engineering" is first on purpose. Most bad work in a
 * multi-agent office is not a bad model, it is a vague handoff — a subtask that
 * names no file, keeps no contract, and cannot be checked.
 */
export const TEAM_DOCTRINE: DoctrineRule[] = [
  {
    id: 'brief',
    title: 'Briefing is prompt engineering',
    text: [
      'Whoever picks up your task sees only what you wrote, so a brief carries six things:',
      'the goal in one sentence, the exact files it owns, the contract it must keep, the acceptance',
      'test that proves it, what is out of scope, and what done looks like. Name paths, not "the UI".',
      'Stable context first, the ask last — that is also the part a provider can cache.',
    ].join(' '),
  },
  {
    id: 'evidence',
    title: 'Evidence beats assertion',
    text: [
      'Done means a check you ran, a file you read, or an output you pasted — not a sentence',
      'claiming it works. Name what you could not verify and why. A summary that lists work the',
      'folder does not contain costs the next person a whole task to discover.',
    ].join(' '),
  },
  {
    id: 'steps',
    title: 'Small steps, real state',
    text: [
      'Read before you write. Change one thing, run the nearest check, then the next. A turn',
      'that ends in a broken build is worse than one that ends early and says what blocks it. Never',
      'leave a test disabled or an assertion weakened to make a step look green.',
    ].join(' '),
  },
  {
    id: 'handoff',
    title: 'State the contract at the boundary',
    text: [
      'When work leaves your hands, say what you produced, what the receiver may rely on —',
      'paths, shapes, names, status codes — and what is still open. "It should work" is not a',
      'handoff; "GET /api/x returns {ok, items} and 400 on a missing id" is.',
    ].join(' '),
  },
  {
    id: 'decide',
    title: 'Ask once, then decide',
    text: [
      'A missing detail that changes the outcome goes back to the lead as one question with the',
      'options you see. Everything else you decide and record in a note, so the next worker inherits',
      'the reason instead of re-litigating the choice.',
    ].join(' '),
  },
  {
    id: 'leave-clean',
    title: 'Leave the folder as you found it',
    text: [
      'No scratch files, no stray logs, no generated output the task did not ask for. The',
      'completion gate refuses leftovers, and a clean diff is what lets the reviewer read the change',
      'at all.',
    ].join(' '),
  },
  {
    id: 'review',
    title: 'Review is about the diff, not the author',
    text: [
      'The independent reviewer reads the diff and the task, never your account of them. When',
      'it refuses, fix the thing it named instead of re-explaining the same diff. Reviewing a',
      'colleague: name the file and the failing case, not an adjective.',
    ].join(' '),
  },
];

/** A role's playbook: what good work looks like, and what the reviewer checks. */
export interface RolePack {
  id: string;
  /** The role title this pack is written for. */
  label: string;
  /** Lowercase tokens that select this pack; matched as whole words. */
  match: string[];
  /** The craft bar — how this role's work is judged before any test runs. */
  craft: string[];
  /** Evidence that closes a task in this role. */
  done: string[];
  /** What the independent reviewer should refuse for this role. */
  review: string[];
}

/**
 * Packs in matching order. Specific before general: "ML Engineer" is also an
 * engineer, and "Prompt Engineer" is also an AI engineer, so those two are
 * matched before the broader packs.
 */
export const ROLE_PACKS: RolePack[] = [
  {
    id: 'lead',
    label: 'Tech Lead',
    // Not a bare "manager": a Product Manager is a product role, and this pack
    // comes first in the list, so it would swallow them.
    match: ['tech lead', 'lead', 'architect', 'head of', 'engineering manager'],
    craft: [
      'Plan in waves: what can run now, what waits on it. Hand out at most four subtasks, one owner each, with file sets that do not overlap.',
      'Write the brief, not the code. A lead who implements leaves the integration unowned.',
      'Reconcile what came back against the task — read the files — and never against what the workers said they did.',
      'Decide the trade-off, record why in a note, and move on. An unresolved question blocks the whole team.',
    ],
    done: [
      'Every subtask has an owner, an owned file set and a result you have actually read.',
      'The final summary names the files delivered and the checks that passed, and claims nothing the folder does not contain.',
    ],
    review: [
      'A subtask dropped or reassigned with no note, or two workers claiming the same file.',
      'A summary that lists work no file shows.',
    ],
  },
  {
    id: 'prompt',
    label: 'Prompt Engineer',
    match: ['prompt', 'prompt engineer', 'evaluation engineer'],
    craft: [
      'A prompt is a spec: role, goal, inputs by exact path, constraints, acceptance test, output shape. If a reader could interpret it two ways, it is not finished.',
      'Version prompts like code — one file, one owner — and a change needs a case that proves it is better, not a feeling that it reads nicer.',
      'Write the negative cases too: what the model must refuse or leave empty, not just the happy path.',
      'Three real examples outrank a paragraph of "be precise". Prefer a schema over a request for a format.',
      'Count the tokens before shipping. Every round pays for the whole system message again, so stable text goes first and variables last.',
    ],
    done: [
      'The prompt file states its input contract, and an evaluation (a script or a named case list) passes against it.',
      'Token cost and the failure mode of an unreadable reply are both stated.',
    ],
    review: [
      'A prompt changed with no case that proves it improved, or a reply parsed by scraping prose instead of a declared shape.',
      'Instructions that contradict the tool schema the model is given.',
    ],
  },
  {
    id: 'frontend',
    label: 'Frontend Engineer',
    match: ['frontend', 'front end', 'front-end', 'ui', 'web'],
    craft: [
      'The DOM is a contract: empty, loading, error and success each have a rendered representation, and every interactive element is a real button or link with an accessible name.',
      'Reuse the existing tokens and classes. Read the stylesheet before inventing a colour, a spacing value or a component.',
      'Keyboard parity: anything clickable is reachable with Tab and activatable with Enter, and focus is visible.',
      'Wire the real endpoint or show an honest empty state. Never hard-code the data the task was supposed to fetch.',
    ],
    done: [
      'The page returns 200, its assets resolve and the text the task asked for is on it — proven with http_check, and looked at with preview_screenshot.',
      'The changed component renders its states, not only the happy path.',
    ],
    review: [
      'Hard-coded markup where the task asked for behaviour, a clickable div instead of a button, or inline styles bypassing the design tokens.',
      'A component that was not checked in a browser at all.',
    ],
  },
  {
    id: 'backend',
    label: 'Backend Engineer',
    match: ['backend', 'back end', 'back-end', 'api', 'server engineer'],
    craft: [
      'One clear status code per outcome, one error envelope, and no internal detail leaking into a response.',
      'Validate at the edge, then trust: the handler should not re-check what the schema already proved.',
      'Own the transaction. A retry with the same key must not create the work twice.',
      'Pagination, limits and timeouts belong in the first version, not a follow-up.',
      'Read the neighbouring route before adding one — match its naming, its error shape and its tests.',
    ],
    done: [
      'The endpoint answered a real request, and the failure path returns a status and a message rather than a stack trace.',
      "The folder's suite runs the new path.",
    ],
    review: [
      'A handler with no input validation, a status code that contradicts the body, or a query built by string concatenation.',
      'A test that only exercises the happy path when the task named a failure case.',
    ],
  },
  {
    id: 'mobile',
    label: 'Mobile App Engineer',
    match: ['mobile', 'android', 'ios', 'flutter', 'react native'],
    craft: [
      'A screen has four states: loading, empty, error, offline. A mobile screen without an offline path is unfinished.',
      'State lives in one place; widgets read it rather than keeping their own copy.',
      'Respect the platform: safe areas, back navigation, system font scaling, and a layout that survives 320dp.',
      'Network calls go through one client with timeouts and retries — never scattered through widgets.',
    ],
    done: [
      'The project analyzes clean and the screen was exercised in each of its states.',
      'Any permission or native capability used is declared in the manifest, not assumed.',
    ],
    review: [
      'A screen with no offline or error state, or a network call made directly from a widget.',
      'A layout that only works at one screen width.',
    ],
  },
  {
    id: 'ai',
    label: 'AI Engineer',
    match: ['ai', 'llm', 'agent engineer', 'applied ai'],
    craft: [
      'Prompt first, code second: the system message states the job, the tools available, the refusal conditions and the shape of the reply.',
      'Parse defensively. A reply that cannot be read is a failure, never an implicit success — return null and log the reason.',
      'Put stable instructions first and variable content last, so the provider can cache the prefix across rounds.',
      'Measure tokens in, tokens out, latency, and a small set of cases that must keep passing.',
    ],
    done: [
      'The model call was run for real, and both the accepted and the unreadable-reply paths were observed.',
      "Cost per task is stated — the meter exists, so a guess is not acceptable.",
    ],
    review: [
      'An unparseable reply treated as success, or a prompt change with no evaluation behind it.',
      'Retry logic that re-sends the whole conversation without a bound.',
    ],
  },
  {
    id: 'ml',
    label: 'ML Engineer',
    match: ['ml', 'machine learning', 'data scien', 'research engineer'],
    craft: [
      'Split before you train: no test row may influence a feature, a threshold or a hyperparameter.',
      'Baseline first — majority class or a simple heuristic — and report the delta, not just the metric.',
      'Leakage audit: target-derived columns, time order, and duplicate rows across splits.',
      'Pin seeds, versions and data hashes so a run can be reproduced exactly.',
    ],
    done: [
      'A baseline and the trained model are compared on the same split, with the numbers recorded.',
      'The training command is in the folder and runs from a clean state.',
    ],
    review: [
      'A metric with no baseline, or an evaluation on data the model has seen.',
      'A training script that cannot be re-run because its data or seed is not pinned.',
    ],
  },
  {
    id: 'qa',
    label: 'QA Engineer',
    match: ['qa', 'quality', 'test engineer', 'sdet'],
    craft: [
      'A test earns its place by failing for a reason: write it, watch it fail, then fix the code.',
      'Cover the boundary and the refusal — empty, huge, malformed, unauthorized — not only the happy path.',
      'Reproduce first. A bug report without a failing case is a guess, and a guess costs a round.',
      'Never weaken an assertion to go green. If the expectation genuinely changed, change the test deliberately and say so.',
    ],
    done: [
      'The failing case exists, fails before the fix, and passes after it.',
      "The suite runs green and the run's own output is quoted.",
    ],
    review: [
      'A deleted, skipped or loosened test; an assertion on a mock where the behaviour was the point.',
      'A fix with no regression case.',
    ],
  },
  {
    id: 'security',
    label: 'Security Engineer',
    match: ['security', 'appsec', 'pentest', 'infosec'],
    craft: [
      'Name the trust boundary you are protecting and who is on the other side of it.',
      'Input is untrusted until validated at the edge; output is untrusted until escaped at the sink.',
      'Secrets never enter code, logs, prompts or error messages — redact at the source, not at the display.',
      'Authorization is a server decision on every request. A hidden button is not access control.',
      'Report what you verified and what remains unverified. A clean scan is not a clean system.',
    ],
    done: [
      'Each finding names the file and line, the attack path, and the smallest fix that closes it.',
      'The claim was demonstrated or clearly marked as unverified.',
    ],
    review: [
      'A vulnerability report with no reachable path, or a fix that only hides the UI.',
      'A secret left in code or in a log line "temporarily".',
    ],
  },
  {
    id: 'data',
    label: 'Data Engineer',
    match: ['data', 'etl', 'warehouse', 'analytics', 'database'],
    craft: [
      'Schema first: types, nullability, keys and the grain of one row — before the query.',
      'Idempotent and re-runnable: a backfill run twice lands the same rows, not twice the rows.',
      'Check the count and a checksum after every load, and keep the query that produced them.',
      'Index for the access pattern you measured. Run EXPLAIN before and after, and quote both.',
    ],
    done: [
      'Row counts before and after the load are stated, and they reconcile.',
      'The pipeline was run twice and the second run changed nothing.',
    ],
    review: [
      'A non-idempotent load, an unstated row count, or an index added without a plan to justify it.',
      'A migration that would block writes on a large table.',
    ],
  },
  {
    id: 'devops',
    label: 'DevOps Engineer',
    match: ['devops', 'sre', 'platform', 'infra', 'ops'],
    craft: [
      'Everything as a file. A deploy that exists only in your shell cannot be repeated by anyone else.',
      'Health first: a start command, a health endpoint, an obvious log line, and a clean stop.',
      'Least privilege and pinned versions. A floating tag is an outage waiting for a maintenance window.',
      'Rollback is part of the change: say how to undo it before you apply it.',
    ],
    done: [
      'The service started, answered its health check, and stopped cleanly — with the log lines quoted.',
      'The command that repeats the whole thing is written down in the folder.',
    ],
    review: [
      'A deployment change with no rollback, an unpinned image, or a secret in a config file.',
      'A process left running that nobody will stop.',
    ],
  },
  {
    id: 'product',
    label: 'Product Manager',
    match: ['product', 'pm', 'owner', 'analyst'],
    craft: [
      'Write the acceptance criteria before the feature: who does what, and how we will know it worked.',
      'The smallest slice a user can finish end to end beats a broad half-feature.',
      'Name the non-goals. Scope grows wherever nobody wrote the boundary.',
      'Every claim about behaviour cites evidence — a screen, a log, a test — not a plan.',
    ],
    done: [
      'Each requirement is testable and each one is either met with evidence or reported as not met.',
      'The summary says what a user can now do that they could not do before.',
    ],
    review: [
      'A requirement that cannot be checked, or a scope that silently grew to include unrelated work.',
      'A status report that cannot be traced to the folder.',
    ],
  },
];

/** The pack a free-form role gets when nothing matches: general, still useful. */
export const DEFAULT_ROLE_PACK: RolePack = {
  id: 'general',
  label: 'Engineer',
  match: [],
  craft: [
    'Read the surrounding code and match it: naming, error handling, file layout, test style.',
    'Make the smallest change that satisfies the task, then prove it with the nearest check.',
    'Leave a note where a decision was not obvious, so the next worker inherits the reason.',
  ],
  done: [
    'The change is in the folder and the nearest check was run against it.',
    'Anything that could not be verified is named in the summary.',
  ],
  review: [
    'A claim the diff does not support, or a rewrite where the task asked for a change.',
  ],
};

/**
 * Picks a pack by matching whole words, so "AI Engineer" cannot be caught by
 * "ml" through a substring and "Product Manager" cannot be caught by "manager"
 * in a way that hides the product work.
 */
export function resolveRolePack(role: string): RolePack {
  const normalised = ` ${role.toLowerCase().replace(/[^a-z0-9+]+/g, ' ').trim()} `;
  for (const pack of ROLE_PACKS) {
    for (const term of pack.match) {
      if (normalised.includes(` ${term} `)) return pack;
    }
  }
  return DEFAULT_ROLE_PACK;
}

/** Every pack id, for the tool schema and the check that all of them are covered. */
export const ROLE_PACK_IDS: string[] = [DEFAULT_ROLE_PACK.id, ...ROLE_PACKS.map((pack) => pack.id)];

/** A pack by id, or null — an invented id must not silently become something else. */
export function packById(id: string | null | undefined): RolePack | null {
  if (!id) return null;
  const wanted = id.trim().toLowerCase();
  if (wanted === DEFAULT_ROLE_PACK.id) return DEFAULT_ROLE_PACK;
  return ROLE_PACKS.find((pack) => pack.id === wanted) ?? null;
}

/**
 * What a plain job title cannot express: what this task actually is.
 *
 * Every pack answers "how is work in this craft judged". The signals below say
 * "this deliverable is that craft" — a `.tsx` component, a migration, a prompt
 * file. They are only consulted when the role itself is generic, so a
 * specialist is never overruled by a keyword.
 *
 * Two weights keep a guess from being arbitrary:
 * - an artefact (a file that will exist when the task is done) scores 3;
 * - a word about the work scores 1, and a second distinct word in the same
 *   signal scores one more. "responsive button" is stronger evidence than
 *   "button", and a real `.html` beats any number of adjectives.
 *
 * The score and the evidence are kept, not thrown away: the log says which pack
 * a task runs under and what in the brief put it there, so a wrong guess is a
 * reportable bug instead of a mystery inside a prompt.
 */
interface TaskSignal {
  id: string;
  /** A file or named artefact. Strong evidence: it is what will exist. */
  artifact: RegExp | null;
  /** Words about the work. Weak alone, meaningful in pairs. */
  words: RegExp;
}

/** Points an artefact is worth: more than any pair of words can earn. */
const ARTIFACT_SCORE = 3;
/** Points one distinct word is worth, capped so a long sentence cannot win alone. */
const WORD_SCORE = 1;
const MAX_WORD_SCORE = 2;

/**
 * Specific before general, and "prompt" before "ai" so a prompt file is not
 * swallowed by the broader craft that also uses prompts. Ties keep this order.
 */
const TASK_SIGNALS: TaskSignal[] = [
  {
    id: 'prompt',
    artifact: /[\w./-]*\.prompt\b/i,
    words: /\b(prompt template|prompt file|evaluation set|few-shot|system prompt|prompt engineer|prompt)\b/i,
  },
  {
    id: 'frontend',
    artifact: /[\w./-]*\.(?:tsx|jsx|css|scss|html)\b/i,
    words: /\b(component|landing page|stylesheet|button|responsive|layout|design tokens)\b/i,
  },
  {
    id: 'backend',
    artifact: /[\w./-]*\.(?:route|controller|handler)\.[cm]?[jt]s\b/i,
    words: /\b(endpoint|status code|middleware|rest api|api route|request handler)\b/i,
  },
  {
    id: 'mobile',
    artifact: /[\w./-]*\.dart\b|AndroidManifest\.xml/i,
    words: /\b(flutter|android|ios|react native|widget|offline)\b/i,
  },
  {
    id: 'data',
    artifact: /[\w./-]*\.sql\b|[\w./-]*migration[\w./-]*\.[a-z]+\b/i,
    words: /\b(migration|backfill|warehouse|etl|row count|index on|schema)\b/i,
  },
  {
    id: 'devops',
    artifact: /[\w./-]*Dockerfile\b|[\w./-]*docker-compose\.ya?ml\b|\.github\/workflows\/[\w./-]+/i,
    words: /\b(docker|compose|ci pipeline|deploy|kubernetes|systemd)\b/i,
  },
  {
    id: 'qa',
    artifact: /[\w./-]*\.(?:test|spec)\.[cm]?[jt]sx?\b/i,
    words: /\b(regression|failing test|test suite|reproduce|flaky|coverage)\b/i,
  },
  {
    id: 'security',
    artifact: null,
    words: /\b(vulnerab\w*|owasp|injection|xss|secret leak|authori[sz]ation|csrf)\b/i,
  },
  {
    id: 'ai',
    artifact: null,
    words: /\b(llm|model call|system message|tool schema|agent loop|tool calls|inference)\b/i,
  },
  {
    id: 'ml',
    artifact: null,
    words: /\b(train\w*|dataset|accuracy|precision|recall|embedding|fine-?tun\w*|baseline model)\b/i,
  },
  {
    id: 'product',
    artifact: /[\w./-]*prd\.md\b/i,
    words: /\b(acceptance criteria|user story|scope|roadmap|feature spec|non-goals)\b/i,
  },
  {
    id: 'lead',
    artifact: null,
    words: /\b(delegate|reconcile|plan the work|split the work)\b/i,
  },
];

export interface SignalScore {
  id: string;
  score: number;
  /** What matched: the artefact, or the distinct words that carried it. */
  evidence: string;
}

/** Every signal the brief hits, strongest first. Ties keep the list order. */
export function rankTaskSignals(text: string): SignalScore[] {
  const hits: SignalScore[] = [];
  for (const signal of TASK_SIGNALS) {
    const artifact = signal.artifact ? new RegExp(signal.artifact.source, `${signal.artifact.flags}g`).exec(text) : null;
    // `matchAll` needs a global regex; the pattern itself stays reusable.
    const words = [...new Set(
      [...text.matchAll(new RegExp(signal.words.source, `${signal.words.flags.replace('g', '')}g`))]
        .map((match) => match[0].toLowerCase()),
    )];
    if (!artifact && words.length === 0) continue;
    hits.push({
      id: signal.id,
      score: (artifact ? ARTIFACT_SCORE : 0) + Math.min(words.length, MAX_WORD_SCORE) * WORD_SCORE,
      evidence: artifact ? artifact[0] : words.slice(0, 2).join(', '),
    });
  }
  return hits.sort((left, right) => right.score - left.score);
}

/** A pack and the reason it was chosen, which is what the board and log need. */
export interface PackChoice {
  pack: RolePack;
  source: PackSource;
  /** What in the brief decided it; null when the role or the operator did. */
  evidence: string | null;
  /** Packs the brief also matched, when they scored the same. */
  alsoMatched: string[];
}

/**
 * Picks the playbook for one turn, in the order that respects the operator:
 * an explicit choice, then the worker's role, then what the task is about.
 *
 * Returns the choice rather than just the pack, so the caller can say why. An
 * unknown explicit id falls through to the role instead of becoming the generic
 * pack — a typo in `role_pack` must not silently flatten a specialist's bar.
 */
export function resolvePackChoice(input: {
  role: string;
  pack?: string | null;
  title?: string;
  detail?: string;
}): PackChoice {
  const explicit = packById(input.pack);
  if (explicit) {
    // A specialist keeps their own bar unless the operator named another pack:
    // naming one IS the override, and it is the only way to run a frontend
    // mission under the data pack on purpose.
    return { pack: explicit, source: 'operator', evidence: null, alsoMatched: [] };
  }

  const byRole = resolveRolePack(input.role);
  if (byRole.id !== DEFAULT_ROLE_PACK.id) {
    return { pack: byRole, source: 'role', evidence: input.role, alsoMatched: [] };
  }

  const ranked = rankTaskSignals(`${input.title ?? ''}\n${input.detail ?? ''}`);
  const [best] = ranked;
  if (!best) return { pack: DEFAULT_ROLE_PACK, source: 'default', evidence: null, alsoMatched: [] };

  return {
    pack: packById(best.id) ?? DEFAULT_ROLE_PACK,
    source: 'brief',
    evidence: best.evidence,
    // A tie is worth showing: it is the case where the operator may disagree
    // with the guess, and the case where a report would be valid.
    alsoMatched: ranked.filter((entry) => entry.score === best.score && entry.id !== best.id).map((entry) => entry.id),
  };
}

/** The pack alone, for callers that only build a prompt out of it. */
export function resolvePackFor(input: {
  role: string;
  pack?: string | null;
  title?: string;
  detail?: string;
}): RolePack {
  return resolvePackChoice(input).pack;
}

/**
 * The activity-log line for a choice, in the four shapes the dictionary knows.
 *
 * The evidence is the brief's own words (a path, a keyword), so it stays as
 * written in both languages: it is a quotation, not prose the office wrote.
 */
export function packLogLine(choice: PackChoice, name: string, title: string): string {
  const subject = `${name} runs "${title}" under the ${choice.pack.id} playbook`;
  switch (choice.source) {
    case 'operator':
      return `${subject}: the operator chose it.`;
    case 'role':
      return `${subject}: the job title chose it.`;
    case 'brief': {
      const head = `${subject}: the brief points there (${choice.evidence ?? 'a named deliverable'})`;
      // A tie is named in the line the operator actually reads: it is the case
      // where the guess is a coin flip, and where a complaint is justified.
      if (choice.alsoMatched.length > 0) return `${head}; ${choice.alsoMatched.join(', ')} also fits.`;
      return `${head}.`;
    }
    default:
      return `${subject}: no signal matched, so it falls back to the general pack.`;
  }
}

/**
 * Review refusals as evidence about the packs themselves.
 *
 * A refusal is a sentence the reviewer wrote, not a code, so it is matched back
 * to the pack's own review bullets by shared words. Two matched words are the
 * floor: one is a coincidence ("the diff does not..."), and a wrong attribution
 * would send the operator to rewrite the wrong rule. Refusals that match no
 * bullet are counted separately rather than forced onto one.
 */
const REFUSAL_STOPWORDS = new Set([
  'about', 'after', 'again', 'against', 'because', 'been', 'before', 'being', 'between',
  'cannot', 'change', 'changed', 'changes', 'could', 'does', 'doing', 'done', 'every',
  'file', 'files', 'from', 'have', 'into', 'must', 'never', 'only', 'other', 'should',
  'still', 'support', 'than', 'that', 'their', 'there', 'these', 'they', 'this', 'those',
  'through', 'under', 'until', 'what', 'when', 'where', 'which', 'while', 'with', 'without',
  'work', 'worker', 'would', 'your',
]);

function significantWords(text: string): string[] {
  return (text.toLowerCase().match(/[a-z][a-z0-9-]{4,}/g) ?? []).filter(
    (word) => !REFUSAL_STOPWORDS.has(word),
  );
}

/** Two words that name the same thing: equal, or one inside the other. */
function sameWord(left: string, right: string): boolean {
  if (left === right) return true;
  if (left.length >= 6 && right.includes(left)) return true;
  return right.length >= 6 && left.includes(right);
}

/**
 * Which review bullet a refusal cites, or null when none is close enough.
 * Exported so the check can prove the attribution instead of trusting it.
 */
export function attributeRefusal(reasons: string[], pack: RolePack): number | null {
  const said = [...new Set(significantWords(reasons.join(' ')))];
  if (said.length === 0) return null;

  let best: { rule: number; hits: number } | null = null;
  pack.review.forEach((line, rule) => {
    const words = [...new Set(significantWords(line))];
    const hits = words.filter((word) => said.some((saidWord) => sameWord(saidWord, word))).length;
    if (hits < 2) return;
    if (!best || hits > best.hits) best = { rule, hits };
  });
  return best ? (best as { rule: number; hits: number }).rule : null;
}

/** Refusals grouped by pack, ranked by how often that pack was refused. */
export function summariseRefusals(tasks: Task[]): RefusalSummary {
  const order = [...ROLE_PACKS, DEFAULT_ROLE_PACK].map((pack) => pack.id);
  const buckets = new Map<string, { count: number; rules: Map<number, number>; unmatched: number }>();
  let total = 0;

  for (const task of tasks) {
    for (const refusal of task.reviewRefusals ?? []) {
      total += 1;
      const pack = packById(refusal.pack) ?? DEFAULT_ROLE_PACK;
      const bucket = buckets.get(pack.id) ?? { count: 0, rules: new Map(), unmatched: 0 };
      bucket.count += 1;
      const rule = attributeRefusal(refusal.reasons, pack);
      if (rule === null) bucket.unmatched += 1;
      else bucket.rules.set(rule, (bucket.rules.get(rule) ?? 0) + 1);
      buckets.set(pack.id, bucket);
    }
  }

  const packs: PackRefusal[] = [...buckets.entries()]
    .map(([pack, bucket]) => ({
      pack,
      count: bucket.count,
      rules: [...bucket.rules.entries()]
        .map(([rule, count]): PackRefusalRule => ({ rule, count }))
        .sort((left, right) => right.count - left.count || left.rule - right.rule),
      unmatched: bucket.unmatched,
    }))
    .sort((left, right) => right.count - left.count || order.indexOf(left.pack) - order.indexOf(right.pack));

  return { total, packs };
}

/** The doctrine as the model reads it: one block, identical for every worker. */
export function doctrineBrief(): string {
  const rules = TEAM_DOCTRINE.map((rule) => `- ${rule.title}. ${rule.text}`);
  return ['How this team works:', ...rules].join('\n');
}

/** The role's half of the prompt: craft, done, and what the reviewer refuses. */
export function buildRoleBrief(role: string): string {
  return buildPackBrief(resolveRolePack(role));
}

/** The same block, for a pack that was already resolved (explicit or inferred). */
export function buildPackBrief(pack: RolePack): string {
  return [
    `Your job as ${pack.label}.`,
    'Craft:',
    ...pack.craft.map((line) => `- ${line}`),
    'Done means:',
    ...pack.done.map((line) => `- ${line}`),
    'The reviewer refuses:',
    ...pack.review.map((line) => `- ${line}`),
  ].join('\n');
}

/**
 * What the independent reviewer is told about the role. Short on purpose: the
 * reviewer already has the task and the diff, and a long role essay would make
 * it grade the prose instead of the change.
 */
export function roleReviewBrief(role: string, packId?: string | null): string {
  const pack = resolvePackFor({ role, pack: packId });
  return [
    `Judge this as a ${pack.label}. This team's bar for that role:`,
    ...pack.review.map((line) => `- ${line}`),
    'A missing deliverable is decisive; style is not.',
  ].join('\n');
}

/** What `GET /api/playbook` returns, so the operator can read what workers get. */
export function playbook(tasks: Task[] = []): {
  doctrine: DoctrineRule[];
  packs: Pick<RolePack, 'id' | 'label' | 'craft' | 'done' | 'review'>[];
  /** Which packs the reviewer keeps refusing, and which rule it cites. */
  refusals: RefusalSummary;
} {
  return {
    doctrine: TEAM_DOCTRINE,
    // The lead first: every mission starts there, and the fallback pack is the
    // least interesting thing in the list, so it goes last.
    packs: [...ROLE_PACKS, DEFAULT_ROLE_PACK].map(({ id, label, craft, done, review }) => ({
      id,
      label,
      craft,
      done,
      review,
    })),
    refusals: summariseRefusals(tasks),
  };
}
