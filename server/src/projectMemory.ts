import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * What the workers learned about one folder, kept next to the workspace so it
 * travels with the project rather than with the office's own state file.
 *
 * `.agent-office/` is already excluded from checkpoint commits, so remembering
 * something never shows up as a change the worker made.
 */
export const MEMORY_RELATIVE_PATH = '.agent-office/knowledge.md';

/** Facts kept on disk. Older ones fall off; a memory that grows without bound is noise. */
const MAX_FACTS = 60;

/** One fact is one line, short enough to stay in a prompt without crowding it. */
const MAX_FACT_CHARS = 240;

/** Budget for the whole block injected into a system prompt. */
const MAX_PROMPT_CHARS = 2_000;

const HEADER =
  '# Project memory\n\n' +
  'Facts earlier missions recorded about this folder, newest first. ' +
  'Edit or delete a line freely — it is plain Markdown.\n\n';

export interface ProjectMemory {
  /** Absolute path of the memory file. */
  path: string;
  /** Newest first, one fact per entry. */
  facts: string[];
}

/**
 * Read-modify-write runs one at a time. A team mission finishes several
 * subtasks at once, and parallel writers would otherwise drop each other's
 * facts (both read the same file, both write their own version).
 */
let writeChain: Promise<unknown> = Promise.resolve();

/** A fact is one line: whitespace collapses, length is capped, empties are dropped. */
export function normaliseFact(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const oneLine = value.replace(/\s+/g, ' ').trim();
  if (oneLine.length === 0) return null;
  return oneLine.slice(0, MAX_FACT_CHARS);
}

/** Case and spacing are not meaning: "Build: npm run build" twice is one fact. */
function factKey(fact: string): string {
  return fact.toLowerCase().replace(/[`*_]/g, '').replace(/\s+/g, ' ').trim();
}

/**
 * Reads what is known about `root`. A missing file means "nothing learned yet";
 * an unreadable or hand-mangled one degrades to the bullet lines that parse
 * instead of failing the turn.
 */
export async function readProjectMemory(root: string): Promise<ProjectMemory> {
  const target = path.join(root, MEMORY_RELATIVE_PATH);
  const raw = await fs.readFile(target, 'utf8').catch(() => '');
  const facts: string[] = [];
  const seen = new Set<string>();
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('- ')) continue;
    const fact = normaliseFact(trimmed.slice(2));
    if (!fact) continue;
    const key = factKey(fact);
    if (seen.has(key)) continue;
    seen.add(key);
    facts.push(fact);
  }
  return { path: target, facts };
}

/**
 * Appends facts to the folder's memory, skipping anything already known.
 * Newest go first so the trim keeps the most recent knowledge.
 */
export async function recordProjectMemory(
  root: string,
  input: { facts: unknown[] },
): Promise<{ written: string[]; path: string }> {
  const candidates: string[] = [];
  const candidateKeys = new Set<string>();
  for (const raw of input.facts) {
    const fact = normaliseFact(raw);
    if (!fact) continue;
    const key = factKey(fact);
    if (candidateKeys.has(key)) continue;
    candidateKeys.add(key);
    candidates.push(fact);
  }

  const target = path.join(root, MEMORY_RELATIVE_PATH);
  if (candidates.length === 0) return { written: [], path: target };

  const write = async (): Promise<{ written: string[]; path: string }> => {
    const current = await readProjectMemory(root);
    const known = new Set(current.facts.map(factKey));
    const written = candidates.filter((fact) => !known.has(factKey(fact)));
    if (written.length === 0) return { written, path: current.path };

    // Newest first: later facts in one batch are newer than earlier ones, so
    // the batch is reversed before it goes on top of what was already known.
    const merged = [...written.slice().reverse(), ...current.facts].slice(0, MAX_FACTS);
    await fs.mkdir(path.dirname(current.path), { recursive: true });
    await fs.writeFile(current.path, `${HEADER}${merged.map((fact) => `- ${fact}`).join('\n')}\n`, 'utf8');
    return { written, path: current.path };
  };

  const queued = writeChain.then(write, write);
  // A failed write must not poison the queue for the next mission.
  writeChain = queued.catch(() => undefined);
  return queued;
}

/** Words too common to say anything about which fact is relevant. */
const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'when', 'then',
  'than', 'have', 'has', 'had', 'was', 'were', 'are', 'its', 'it', 'you', 'your',
  'can', 'will', 'would', 'should', 'must', 'not', 'but', 'all', 'any', 'each',
  'run', 'runs', 'ran', 'use', 'used', 'using', 'via', 'add', 'new', 'get',
  'set', 'make', 'need', 'needs', 'task', 'file', 'files', 'folder', 'work',
]);

/** Lowercased meaningful terms, with a light suffix trim so "tests" matches "test". */
function terms(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9_./-]+/)
    .map((word) => word.replace(/(?:ing|ies|es|s)$/, ''))
    .filter((word) => word.length >= 3 && !STOPWORDS.has(word));
}

/**
 * Picks the facts worth spending prompt tokens on for *this* task.
 *
 * Newest-first was the whole policy at 20 facts. At 60 it stops working: the
 * fact that explains the failing test is often older than three notes about a
 * build flag nobody touched again. This is BM25's core — rare shared terms
 * score higher than common ones — plus a small recency nudge, so relevance
 * leads and freshness breaks ties.
 */
export function selectFacts(
  facts: string[],
  query: string,
  options: { budgetChars?: number; maxFacts?: number } = {},
): string[] {
  if (facts.length === 0) return [];
  const budget = options.budgetChars ?? MAX_PROMPT_CHARS;
  const maxFacts = options.maxFacts ?? 12;
  const queryTerms = new Set(terms(query));
  if (queryTerms.size === 0) return facts.slice(0, maxFacts);

  const documents = facts.map((fact) => terms(fact));
  const documentFrequency = new Map<string, number>();
  for (const documentTerms of documents) {
    for (const term of new Set(documentTerms)) {
      documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
    }
  }

  const scored = facts.map((fact, index) => {
    let score = 0;
    for (const term of new Set(documents[index] ?? [])) {
      if (!queryTerms.has(term)) continue;
      // log(1 + N/df): a term in every fact is nearly worthless, a rare one is not.
      score += Math.log(1 + facts.length / (documentFrequency.get(term) ?? 1));
    }
    // Positions are newest-first, so index 0 is the freshest memory.
    const recency = Math.max(0, 0.5 - index * 0.01);
    return { fact, index, score: score > 0 ? score + recency : 0 };
  });

  const chosen: { fact: string; index: number }[] = [];
  let used = 0;
  for (const entry of [...scored].sort((left, right) => right.score - left.score || left.index - right.index)) {
    if (entry.score <= 0) continue;
    const cost = entry.fact.length + 3;
    if (used + cost > budget) continue;
    chosen.push({ fact: entry.fact, index: entry.index });
    used += cost;
    if (chosen.length >= maxFacts) break;
  }

  // A brief that shares no words with any fact still deserves the folder's
  // newest knowledge: an empty block would make memory look broken rather than
  // simply unmatched.
  if (chosen.length === 0) {
    let fallbackUsed = 0;
    for (const [index, fact] of facts.entries()) {
      const cost = fact.length + 3;
      if (fallbackUsed + cost > budget || chosen.length >= maxFacts) break;
      chosen.push({ fact, index });
      fallbackUsed += cost;
    }
  }

  // Back into the file's own order: the block reads as a short note, not a ranking.
  return chosen.sort((left, right) => left.index - right.index).map((entry) => entry.fact);
}

/**
 * The block injected into every mission's system prompt.
 * Empty when the folder has taught us nothing yet — no empty heading, no
 * "no memories" line the model would only have to ignore.
 *
 * `query` is the task brief: with it, the block is about this job. Without it,
 * the newest facts win, which is what a chat turn wants.
 */
export function renderProjectMemory(memory: ProjectMemory, query = ''): string {
  if (memory.facts.length === 0) return '';
  const lines: string[] = [];
  let used = 0;
  for (const fact of selectFacts(memory.facts, query)) {
    const line = `- ${fact}`;
    if (used + line.length + 1 > MAX_PROMPT_CHARS) break;
    lines.push(line);
    used += line.length + 1;
  }
  if (lines.length === 0) return '';
  return [
    'Project memory — facts earlier missions recorded about this folder.',
    'Trust them, but re-read a file before changing it if a fact looks stale.',
    ...lines,
  ].join('\n');
}
