import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * A cheap code map: file → declarations, built by reading the tree once and
 * matching the declaration shapes of the languages this office actually sees.
 *
 * It is deliberately not a language server. A compiler-grade index would cost
 * seconds and a dependency; this map costs milliseconds, answers "where is this
 * defined" and "who mentions it", and lets the worker read the right ten lines
 * instead of a four-hundred-line file.
 */

export type SymbolKind = 'function' | 'class' | 'interface' | 'type' | 'enum' | 'method' | 'constant';

export interface CodeSymbol {
  path: string;
  name: string;
  kind: SymbolKind;
  line: number;
  exported: boolean;
}

export interface CodeMap {
  root: string;
  builtAt: number;
  files: string[];
  symbols: CodeSymbol[];
  /** True when the file cap was hit, so an empty search is not proof of absence. */
  truncated: boolean;
}

export interface SymbolMatch extends CodeSymbol {
  /** Bigger is better: exact name, prefix, then substring; tests rank below sources. */
  score: number;
}

const SOURCE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.go', '.rs', '.java', '.kt', '.kts',
  '.rb', '.php', '.cs', '.swift', '.c', '.h', '.cc', '.cpp', '.hpp',
]);

const SKIP_DIRECTORIES = new Set([
  'node_modules', '.git', 'dist', 'build', 'coverage', '.next', '.agent-office',
  '.cache', '.venv', 'venv', '__pycache__', 'target', '.turbo', 'vendor',
]);

const MAX_FILES = 2_000;
const MAX_FILE_BYTES = 512 * 1024;
const CACHE_TTL_MS = 5_000;

interface DeclarationPattern {
  kind: SymbolKind;
  pattern: RegExp;
  /** Group holding the name, when it is not the first group. */
  nameGroup?: number;
  exportedPattern?: RegExp;
}

const TS_PATTERNS: DeclarationPattern[] = [
  {
    kind: 'function',
    pattern: /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/,
    exportedPattern: /^\s*export\s/,
  },
  {
    kind: 'class',
    pattern: /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/,
    exportedPattern: /^\s*export\s/,
  },
  {
    kind: 'interface',
    pattern: /^\s*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/,
    exportedPattern: /^\s*export\s/,
  },
  {
    kind: 'type',
    pattern: /^\s*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*=/,
    exportedPattern: /^\s*export\s/,
  },
  {
    kind: 'enum',
    pattern: /^\s*(?:export\s+)?(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)/,
    exportedPattern: /^\s*export\s/,
  },
  {
    kind: 'constant',
    pattern: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/,
    exportedPattern: /^\s*export\s/,
  },
];

const METHOD_KEYWORDS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'else', 'do',
  'with', 'super', 'this', 'await', 'yield', 'typeof', 'new', 'import', 'export',
]);

/** Matches `name(...) {` at class-body indentation, without matching calls. */
const METHOD_PATTERN = /^(\s{2,})(?:(?:public|private|protected|static|async|override|readonly|abstract)\s+)*([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\([^;]*\)\s*(?::\s*[^{;]+)?\{\s*$/;

const PYTHON_PATTERNS: DeclarationPattern[] = [
  { kind: 'function', pattern: /^(\s*)(?:async\s+)?def\s+([A-Za-z_]\w*)/, nameGroup: 2 },
  { kind: 'class', pattern: /^(\s*)class\s+([A-Za-z_]\w*)/, nameGroup: 2 },
  { kind: 'constant', pattern: /^([A-Z][A-Z0-9_]{2,})\s*(?::[^=]+)?=/, exportedPattern: /^[A-Z]/ },
];

const GO_PATTERNS: DeclarationPattern[] = [
  { kind: 'function', pattern: /^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/ },
  { kind: 'class', pattern: /^type\s+([A-Za-z_]\w*)\s+struct\b/ },
  { kind: 'interface', pattern: /^type\s+([A-Za-z_]\w*)\s+interface\b/ },
  { kind: 'type', pattern: /^type\s+([A-Za-z_]\w*)\s/ },
];

const RUST_PATTERNS: DeclarationPattern[] = [
  { kind: 'function', pattern: /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:const\s+)?fn\s+([A-Za-z_]\w*)/, exportedPattern: /^\s*pub\b/ },
  { kind: 'class', pattern: /^\s*(?:pub(?:\([^)]*\))?\s+)?struct\s+([A-Za-z_]\w*)/, exportedPattern: /^\s*pub\b/ },
  { kind: 'interface', pattern: /^\s*(?:pub(?:\([^)]*\))?\s+)?trait\s+([A-Za-z_]\w*)/, exportedPattern: /^\s*pub\b/ },
  { kind: 'enum', pattern: /^\s*(?:pub(?:\([^)]*\))?\s+)?enum\s+([A-Za-z_]\w*)/, exportedPattern: /^\s*pub\b/ },
];

const JVM_PATTERNS: DeclarationPattern[] = [
  {
    kind: 'class',
    pattern: /^\s*(?:public\s+|private\s+|protected\s+|internal\s+|open\s+|abstract\s+|final\s+|data\s+|sealed\s+|static\s+)*(?:class|object|record)\s+([A-Za-z_]\w*)/,
    exportedPattern: /^\s*(?:public|internal)\s/,
  },
  {
    kind: 'interface',
    pattern: /^\s*(?:public\s+|private\s+|protected\s+|internal\s+)*interface\s+([A-Za-z_]\w*)/,
    exportedPattern: /^\s*(?:public|internal)\s/,
  },
  {
    kind: 'function',
    pattern: /^\s*(?:public\s+|private\s+|protected\s+|internal\s+|open\s+|override\s+|suspend\s+|inline\s+|static\s+)*fun\s+(?:<[^>]*>\s*)?([A-Za-z_]\w*)/,
    exportedPattern: /^\s*(?:public|internal)\s/,
  },
];

function patternsFor(extension: string): DeclarationPattern[] {
  if (['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].includes(extension)) return TS_PATTERNS;
  if (extension === '.py') return PYTHON_PATTERNS;
  if (extension === '.go') return GO_PATTERNS;
  if (extension === '.rs') return RUST_PATTERNS;
  if (['.java', '.kt', '.kts'].includes(extension)) return JVM_PATTERNS;
  return GO_PATTERNS;
}

/** Extracts declarations from one file's text. Exported for tests. */
export function scanSymbols(relativePath: string, content: string): CodeSymbol[] {
  const extension = path.extname(relativePath).toLowerCase();
  const isTypeScript = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].includes(extension);
  const patterns = patternsFor(extension);
  const symbols: CodeSymbol[] = [];
  const lines = content.split('\n');

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (line.length > 400) continue;

    let matched = false;
    for (const declaration of patterns) {
      const hit = declaration.pattern.exec(line);
      if (!hit) continue;
      const name = hit[declaration.nameGroup ?? 1];
      if (!name) continue;
      // Python methods are indented; report them as methods, not free functions.
      const kind: SymbolKind =
        declaration.kind === 'function' && declaration.nameGroup === 2 && (hit[1] ?? '').length > 0
          ? 'method'
          : declaration.kind;
      symbols.push({
        path: relativePath,
        name,
        kind,
        line: index + 1,
        exported: declaration.exportedPattern ? declaration.exportedPattern.test(line) : true,
      });
      matched = true;
      break;
    }
    if (matched || !isTypeScript) continue;

    const method = METHOD_PATTERN.exec(line);
    const name = method?.[2];
    if (!name || METHOD_KEYWORDS.has(name)) continue;
    symbols.push({ path: relativePath, name, kind: 'method', line: index + 1, exported: true });
  }

  return symbols;
}

const cachedMaps = new Map<string, CodeMap>();

async function listSourceFiles(root: string): Promise<{ files: string[]; truncated: boolean }> {
  const files: string[] = [];
  let truncated = false;

  const walk = async (directory: string): Promise<void> => {
    if (files.length >= MAX_FILES) {
      truncated = true;
      return;
    }
    const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (files.length >= MAX_FILES) {
        truncated = true;
        return;
      }
      if (entry.name.startsWith('.') && entry.name !== '.github') continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRECTORIES.has(entry.name)) continue;
        await walk(absolute);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!SOURCE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
      files.push(path.relative(root, absolute).split(path.sep).join('/'));
    }
  };

  await walk(root);
  return { files: files.sort(), truncated };
}

/**
 * Builds (or returns the 5-second-old) map for this workspace. The TTL is what
 * keeps a burst of `search_symbol` calls from re-reading the tree each time,
 * while still noticing edits the worker made a moment ago.
 */
export async function buildCodeMap(root: string, options: { refresh?: boolean } = {}): Promise<CodeMap> {
  const cached = cachedMaps.get(root);
  if (!options.refresh && cached && Date.now() - cached.builtAt < CACHE_TTL_MS) return cached;

  const { files, truncated } = await listSourceFiles(root);
  const symbols: CodeSymbol[] = [];
  for (const relative of files) {
    const absolute = path.join(root, relative);
    const stats = await fs.stat(absolute).catch(() => null);
    if (!stats || stats.size > MAX_FILE_BYTES) continue;
    const content = await fs.readFile(absolute, 'utf8').catch(() => '');
    if (content.length === 0) continue;
    symbols.push(...scanSymbols(relative, content));
  }

  const map: CodeMap = { root, builtAt: Date.now(), files, symbols, truncated };
  cachedMaps.set(root, map);
  return map;
}

/** Ranking: exact name beats prefix beats substring; source beats its test. */
export function searchSymbols(
  map: CodeMap,
  query: string,
  options: { kind?: SymbolKind; limit?: number } = {},
): SymbolMatch[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return [];
  const limit = options.limit ?? 40;

  const matches: SymbolMatch[] = [];
  for (const symbol of map.symbols) {
    if (options.kind && symbol.kind !== options.kind) continue;
    const name = symbol.name.toLowerCase();
    let score = 0;
    if (name === needle) score = 100;
    else if (name.startsWith(needle)) score = 70;
    else if (name.includes(needle)) score = 45;
    else if (symbol.path.toLowerCase().includes(needle)) score = 10;
    if (score === 0) continue;
    if (symbol.exported) score += 6;
    if (/\.(test|spec)\.|__tests__|\/tests?\//.test(symbol.path)) score -= 8;
    if (symbol.kind === 'class' || symbol.kind === 'interface') score += 2;
    matches.push({ ...symbol, score });
  }

  return matches
    .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path) || left.line - right.line)
    .slice(0, limit);
}

export interface ReferenceHit {
  path: string;
  line: number;
  text: string;
  definition: boolean;
}

/** Word-boundary mentions, definitions included but flagged. */
export async function findReferences(
  map: CodeMap,
  name: string,
  options: { limit?: number } = {},
): Promise<ReferenceHit[]> {
  const limit = options.limit ?? 60;
  if (!/^[A-Za-z_$][\w$]*$/.test(name)) return [];
  const pattern = new RegExp(`\\b${name}\\b`);
  const definitions = new Set(
    map.symbols.filter((symbol) => symbol.name === name).map((symbol) => `${symbol.path}:${symbol.line}`),
  );

  const hits: ReferenceHit[] = [];
  for (const relative of map.files) {
    if (hits.length >= limit) break;
    const content = await fs.readFile(path.join(map.root, relative), 'utf8').catch(() => '');
    if (content.length === 0 || !content.includes(name)) continue;
    const lines = content.split('\n');
    for (let index = 0; index < lines.length; index += 1) {
      const text = lines[index] ?? '';
      if (!pattern.test(text)) continue;
      hits.push({
        path: relative,
        line: index + 1,
        text: text.trim().slice(0, 200),
        definition: definitions.has(`${relative}:${index + 1}`),
      });
      if (hits.length >= limit) break;
    }
  }
  return hits;
}
