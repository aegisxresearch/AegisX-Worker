import dns from 'node:dns/promises';
import net from 'node:net';

/** Result of one web search. */
export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

/** Result of fetching a page. */
export interface WebFetchResult {
  url: string;
  title: string;
  text: string;
  bytes: number;
}

const SEARCH_TIMEOUT_MS = 20_000;
const FETCH_TIMEOUT_MS = 20_000;
const MAX_FETCH_BYTES = 512 * 1024;
const MAX_TEXT_CHARS = 20_000;
const MAX_REDIRECTS = 3;
const USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36';

export class WebError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebError';
  }
}

// ── address guards ─────────────────────────────────────────────────────────

function ipv4IsPrivate(address: string): boolean {
  const parts = address.split('.').map((part) => Number.parseInt(part, 10));
  if (parts.length !== 4 || parts.some((part) => Number.isNaN(part))) return true;
  const [a = 0, b = 0] = parts;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 192 && b === 0) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a >= 224) return true;
  return false;
}

function ipv6IsPrivate(address: string): boolean {
  const normalized = address.toLowerCase().split('%')[0] ?? '';
  if (normalized === '::1' || normalized === '::') return true;
  if (normalized.startsWith('fe80') || normalized.startsWith('fc') || normalized.startsWith('fd')) return true;
  if (normalized.startsWith('::ffff:')) {
    const mapped = normalized.slice('::ffff:'.length);
    return net.isIPv4(mapped) ? ipv4IsPrivate(mapped) : true;
  }
  return false;
}

/** True when the address belongs to a private, loopback or link-local range. */
export function isPrivateAddress(address: string): boolean {
  if (net.isIPv4(address)) return ipv4IsPrivate(address);
  if (net.isIPv6(address)) return ipv6IsPrivate(address);
  return true;
}

/**
 * Rejects URLs that point at the host or a private network.
 * Every hop (including redirects) is re-validated before the request is made.
 */
export async function assertPublicUrl(rawUrl: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new WebError(`Not a valid URL: ${rawUrl}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new WebError(`Only http and https URLs are allowed (got ${url.protocol}).`);
  }
  if (url.username.length > 0 || url.password.length > 0) {
    throw new WebError('URLs with embedded credentials are rejected.');
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = await dns.lookup(hostname, { all: true }).catch(() => {
    throw new WebError(`Cannot resolve host ${hostname}.`);
  });
  if (addresses.length === 0) throw new WebError(`Cannot resolve host ${hostname}.`);
  for (const entry of addresses) {
    if (isPrivateAddress(entry.address)) {
      throw new WebError(`Host ${hostname} resolves to a private address and is blocked.`);
    }
  }
  return url;
}

// ── html helpers ───────────────────────────────────────────────────────────

const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&nbsp;': ' ',
};

function decodeEntities(text: string): string {
  return text
    .replace(/&(?:amp|lt|gt|quot|#39|nbsp);/g, (match) => ENTITIES[match] ?? match)
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)));
}

/** Reads the text of the first `<tag>` inside an XML block. */
function readXmlTag(block: string, tag: string): string {
  const match = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i').exec(block);
  return match?.[1] ? decodeEntities(match[1]).trim() : '';
}

function stripHtml(html: string): string {
  return decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function readTitle(html: string): string {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return match?.[1] ? stripHtml(match[1]).slice(0, 200) : '';
}

// ── search ─────────────────────────────────────────────────────────────────

function decodeDuckDuckGoUrl(href: string): string {
  const raw = href.replace(/&amp;/g, '&');
  const match = /[?&]uddg=([^&]+)/.exec(raw);
  if (match?.[1]) return decodeURIComponent(match[1]);
  if (raw.startsWith('//')) return `https:${raw}`;
  return raw;
}

/**
 * Keyless search through the DuckDuckGo HTML endpoint.
 * A POST with a browser-like header set is answered with real results, while
 * the plain GET to `lite.duckduckgo.com` returns a 202 challenge page.
 */
async function searchDuckDuckGo(query: string, limit: number): Promise<SearchResult[]> {
  const response = await fetch('https://html.duckduckgo.com/html/', {
    method: 'POST',
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'text/html,application/xhtml+xml',
      'Accept-Language': 'en-US,en;q=0.9',
      Referer: 'https://duckduckgo.com/',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ q: query, kl: 'us-en' }).toString(),
    signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
  });
  if (!response.ok) throw new WebError(`Search failed with HTTP ${response.status}.`);
  const html = await response.text();

  // Attribute order varies between responses, so the href is read from the tag.
  const linkPattern = /<a\b[^>]*\bclass=["']result__a["'][^>]*>([\s\S]*?)<\/a>/gi;
  const titles: { url: string; title: string }[] = [];
  let match = linkPattern.exec(html);
  while (match !== null && titles.length < limit) {
    const tag = match[0] ?? '';
    const href = /\bhref=["']([^"']+)["']/i.exec(tag)?.[1] ?? '';
    const title = stripHtml(match[1] ?? '');
    if (href.length > 0 && title.length > 0) {
      titles.push({ url: decodeDuckDuckGoUrl(href), title });
    }
    match = linkPattern.exec(html);
  }

  const snippetPattern = /<a\b[^>]*\bclass=["']result__snippet["'][^>]*>([\s\S]*?)<\/a>/gi;
  const snippets: string[] = [];
  let snippetMatch = snippetPattern.exec(html);
  while (snippetMatch !== null && snippets.length < limit) {
    snippets.push(stripHtml(snippetMatch[1] ?? '').slice(0, 400));
    snippetMatch = snippetPattern.exec(html);
  }

  return titles.map((entry, index) => ({
    title: entry.title,
    url: entry.url,
    snippet: snippets[index] ?? '',
  }));
}

/**
 * Bing's RSS endpoint needs no key and survives the bot challenge that blocks
 * the DuckDuckGo Lite HTML page from datacenter IPs.
 */
async function searchBingRss(query: string, limit: number): Promise<SearchResult[]> {
  const response = await fetch(
    `https://www.bing.com/search?q=${encodeURIComponent(query)}&format=rss&count=${limit}`,
    {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/rss+xml, application/xml;q=0.9' },
      signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
    },
  );
  if (!response.ok) throw new WebError(`Bing search failed with HTTP ${response.status}.`);
  const xml = await response.text();

  const results: SearchResult[] = [];
  const itemPattern = /<item>([\s\S]*?)<\/item>/gi;
  let match = itemPattern.exec(xml);
  while (match !== null && results.length < limit) {
    const block = match[1] ?? '';
    const title = readXmlTag(block, 'title');
    const url = readXmlTag(block, 'link');
    const snippet = stripHtml(readXmlTag(block, 'description')).slice(0, 400);
    if (title.length > 0 && /^https?:\/\//.test(url)) results.push({ title, url, snippet });
    match = itemPattern.exec(xml);
  }
  return results;
}

async function searchTavily(query: string, limit: number, apiKey: string): Promise<SearchResult[]> {
  const response = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ query, max_results: limit, search_depth: 'basic' }),
    signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
  });
  if (!response.ok) throw new WebError(`Tavily search failed with HTTP ${response.status}.`);
  const payload = (await response.json()) as {
    results?: { title?: unknown; url?: unknown; content?: unknown }[];
  };
  const results = Array.isArray(payload.results) ? payload.results : [];
  return results.slice(0, limit).map((entry) => ({
    title: typeof entry.title === 'string' ? entry.title : 'Untitled',
    url: typeof entry.url === 'string' ? entry.url : '',
    snippet: typeof entry.content === 'string' ? entry.content.slice(0, 400) : '',
  }));
}

async function searchBrave(query: string, limit: number, apiKey: string): Promise<SearchResult[]> {
  const response = await fetch(
    `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${limit}`,
    {
      headers: { Accept: 'application/json', 'X-Subscription-Token': apiKey },
      signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
    },
  );
  if (!response.ok) throw new WebError(`Brave search failed with HTTP ${response.status}.`);
  const payload = (await response.json()) as {
    web?: { results?: { title?: unknown; url?: unknown; description?: unknown }[] };
  };
  const results = Array.isArray(payload.web?.results) ? payload.web?.results ?? [] : [];
  return results.slice(0, limit).map((entry) => ({
    title: typeof entry.title === 'string' ? entry.title : 'Untitled',
    url: typeof entry.url === 'string' ? entry.url : '',
    snippet: typeof entry.description === 'string' ? entry.description.slice(0, 400) : '',
  }));
}

async function searchSerper(query: string, limit: number, apiKey: string): Promise<SearchResult[]> {
  const response = await fetch('https://google.serper.dev/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-KEY': apiKey },
    body: JSON.stringify({ q: query, num: limit }),
    signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
  });
  if (!response.ok) throw new WebError(`Serper search failed with HTTP ${response.status}.`);
  const payload = (await response.json()) as {
    organic?: { title?: unknown; link?: unknown; snippet?: unknown }[];
  };
  const results = Array.isArray(payload.organic) ? payload.organic : [];
  return results.slice(0, limit).map((entry) => ({
    title: typeof entry.title === 'string' ? entry.title : 'Untitled',
    url: typeof entry.link === 'string' ? entry.link : '',
    snippet: typeof entry.snippet === 'string' ? entry.snippet.slice(0, 400) : '',
  }));
}

/**
 * Searches the web. Uses a dedicated search API when one is configured in the
 * environment, otherwise falls back to the keyless DuckDuckGo Lite endpoint.
 */
export async function webSearch(query: string, limit = 5): Promise<SearchResult[]> {
  const trimmed = query.trim();
  if (trimmed.length === 0) throw new WebError('Search query must not be empty.');
  const count = Math.min(Math.max(limit, 1), 10);

  const tavilyKey = process.env.TAVILY_API_KEY?.trim();
  if (tavilyKey) return searchTavily(trimmed, count, tavilyKey);
  const braveKey = process.env.BRAVE_API_KEY?.trim();
  if (braveKey) return searchBrave(trimmed, count, braveKey);
  const serperKey = process.env.SERPER_API_KEY?.trim();
  if (serperKey) return searchSerper(trimmed, count, serperKey);

  // No key configured: try each keyless provider until one returns results.
  // DuckDuckGo answers datacenter IPs with a 202 challenge page, so Bing RSS
  // sits behind it as the second chance instead of failing the whole action.
  const failures: string[] = [];
  for (const provider of [searchDuckDuckGo, searchBingRss]) {
    try {
      const results = await provider(trimmed, count);
      if (results.length > 0) return results;
      failures.push(`${provider.name}: no results`);
    } catch (error) {
      failures.push(`${provider.name}: ${error instanceof Error ? error.message : 'failed'}`);
    }
  }
  throw new WebError(
    `Web search failed on every keyless provider (${failures.join('; ')}). Set TAVILY_API_KEY, BRAVE_API_KEY or SERPER_API_KEY for reliable search.`,
  );
}

// ── fetch ──────────────────────────────────────────────────────────────────

/**
 * Fetches a public page and returns its readable text.
 * Redirects are followed manually so every hop is re-validated.
 */
export async function webFetch(rawUrl: string): Promise<WebFetchResult> {
  let currentUrl = rawUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const url = await assertPublicUrl(currentUrl);
    const response = await fetch(url, {
      redirect: 'manual',
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,text/plain;q=0.9,*/*;q=0.8' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) throw new WebError(`HTTP ${response.status} without a Location header.`);
      currentUrl = new URL(location, url).toString();
      continue;
    }

    if (!response.ok) throw new WebError(`HTTP ${response.status} while fetching ${url.host}.`);

    const contentType = response.headers.get('content-type') ?? '';
    if (!/text\/html|text\/plain|text\/markdown|application\/json/i.test(contentType)) {
      throw new WebError(`Unsupported content type "${contentType}" for ${url.host}.`);
    }

    const buffer = await response.arrayBuffer();
    const bytes = Math.min(buffer.byteLength, MAX_FETCH_BYTES);
    const html = new TextDecoder('utf-8', { fatal: false }).decode(buffer.slice(0, bytes));
    const title = readTitle(html);
    const text = stripHtml(html).slice(0, MAX_TEXT_CHARS);
    return { url: url.toString(), title, text, bytes };
  }
  throw new WebError('Too many redirects while fetching the page.');
}
