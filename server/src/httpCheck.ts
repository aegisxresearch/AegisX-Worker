/**
 * `http_check`: does the page the worker just served actually work?
 *
 * A worker's usual way to answer that was a hand-written `node -e` probe, which
 * reported a status string and nothing about the assets the page needs. One
 * missing script then read as a healthy page, and a deliberately private path
 * (`/lib/...`) read as a broken one. This module answers the question the board
 * actually cares about: the page responds, every same-origin asset it references
 * responds, and the copy the task asked for is on the page.
 *
 * Loopback only. It is a check for the worker's own dev server, not a general
 * fetch tool — `web_fetch` is the one that goes to the public internet, behind
 * its own SSRF guard.
 */

export class HttpCheckError extends Error {}

export interface HttpAssetResult {
  path: string;
  status: number;
  contentType: string;
  bytes: number;
  ok: boolean;
}

export interface HttpCheckResult {
  ok: boolean;
  url: string;
  page: { status: number; contentType: string; bytes: number };
  assets: HttpAssetResult[];
  /** Same-origin references that were not checked (too many, or not assets). */
  skipped: string[];
  textMatched: boolean | null;
  failures: string[];
  message: string;
}

const TIMEOUT_MS = 5000;
const MAX_BODY_BYTES = 512 * 1024;
const MAX_ASSETS = 30;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

const REFERENCE_PATTERNS: { tag: string; pattern: RegExp }[] = [
  { tag: 'script', pattern: /<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi },
  { tag: 'link', pattern: /<link\b[^>]*\bhref\s*=\s*["']([^"']+)["']/gi },
  { tag: 'img', pattern: /<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi },
  { tag: 'source', pattern: /<source\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi },
];

/** Rejects anything that is not a loopback http(s) URL. */
function assertLoopback(rawUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new HttpCheckError(`"${rawUrl}" is not an absolute URL. Example: http://127.0.0.1:3000/`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new HttpCheckError(`Only http(s) URLs can be checked, not "${parsed.protocol}".`);
  }
  if (!LOOPBACK_HOSTS.has(parsed.hostname)) {
    throw new HttpCheckError(
      `http_check only reaches this machine (localhost / 127.0.0.1), not "${parsed.hostname}". Use web_fetch for public pages.`,
    );
  }
  return parsed;
}

/** Same-origin references, resolved and de-duplicated, in document order. */
export function referencedAssets(html: string, pageUrl: URL): { urls: string[]; skipped: string[] } {
  const found: { index: number; url: string }[] = [];
  const skipped: string[] = [];
  const seen = new Set<string>();

  for (const { pattern } of REFERENCE_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of html.matchAll(pattern)) {
      const reference = (match[1] ?? '').trim();
      if (reference.length === 0) continue;
      if (/^(data:|mailto:|javascript:|tel:|#)/i.test(reference)) continue;
      let resolved: URL;
      try {
        resolved = new URL(reference, pageUrl);
      } catch {
        skipped.push(reference);
        continue;
      }
      if (resolved.origin !== pageUrl.origin) {
        skipped.push(reference);
        continue;
      }
      resolved.hash = '';
      const key = resolved.toString();
      if (seen.has(key)) continue;
      seen.add(key);
      found.push({ index: match.index ?? 0, url: key });
    }
  }

  // The patterns run tag by tag, so sort by where the reference sits in the
  // document: a page's own order is what a reader (and the model) expects.
  found.sort((left, right) => left.index - right.index);
  return { urls: found.map((entry) => entry.url), skipped };
}

async function readBody(response: Response): Promise<Uint8Array> {
  const buffer = new Uint8Array(await response.arrayBuffer());
  return buffer.byteLength > MAX_BODY_BYTES ? buffer.slice(0, MAX_BODY_BYTES) : buffer;
}

/**
 * Fetches the page, then every same-origin asset it references. Returns a
 * result rather than throwing for a failed asset: a 404 on a stylesheet is the
 * answer, not an exception.
 */
export async function httpCheck(request: {
  url: string;
  expectText?: string;
  checkAssets?: boolean;
}): Promise<HttpCheckResult> {
  const pageUrl = assertLoopback(request.url);
  let response: Response;
  try {
    response = await fetch(pageUrl, {
      redirect: 'follow',
      headers: { Accept: 'text/html,text/plain;q=0.9,*/*;q=0.8' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'unknown error';
    throw new HttpCheckError(`Could not reach ${pageUrl.toString()}: ${reason}. Is the server running?`);
  }

  const contentType = response.headers.get('content-type') ?? '';
  const body = await readBody(response).catch(() => new Uint8Array());
  const html = /text\/html|text\/plain|application\/json|text\/javascript/i.test(contentType)
    ? new TextDecoder('utf-8', { fatal: false }).decode(body)
    : '';

  const expected = request.expectText?.trim() ?? '';
  const textMatched =
    expected.length === 0 ? null : html.toLowerCase().includes(expected.toLowerCase());

  const failures: string[] = [];
  if (!response.ok) failures.push(`${pageUrl.pathname} → ${response.status}`);

  const assets: HttpAssetResult[] = [];
  let skipped: string[] = [];
  if (request.checkAssets !== false && /text\/html/i.test(contentType)) {
    const references = referencedAssets(html, pageUrl);
    skipped = references.skipped;
    for (const assetUrl of references.urls.slice(0, MAX_ASSETS)) {
      const path = new URL(assetUrl).pathname;
      try {
        const assetResponse = await fetch(assetUrl, {
          redirect: 'follow',
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        const assetBytes = (await readBody(assetResponse).catch(() => new Uint8Array())).byteLength;
        const ok = assetResponse.ok;
        assets.push({
          path,
          status: assetResponse.status,
          contentType: assetResponse.headers.get('content-type') ?? '',
          bytes: assetBytes,
          ok,
        });
        if (!ok) failures.push(`${path} → ${assetResponse.status}`);
      } catch (error) {
        const reason = error instanceof Error ? error.message : 'unknown error';
        assets.push({ path, status: 0, contentType: '', bytes: 0, ok: false });
        failures.push(`${path} → unreachable (${reason})`);
      }
    }
  }

  if (textMatched === false) failures.push(`expected text not found: "${expected}"`);

  const failedAssets = assets.filter((asset) => !asset.ok).length;
  const pagePart = `${pageUrl.pathname} → ${response.status} (${contentType.split(';')[0] || 'unknown'}, ${Math.round(body.byteLength / 1024)} KB)`;
  const assetPart =
    assets.length > 0
      ? `${assets.length - failedAssets}/${assets.length} asset(s) OK`
      : 'no same-origin assets found';

  return {
    ok: failures.length === 0,
    url: pageUrl.toString(),
    page: { status: response.status, contentType, bytes: body.byteLength },
    assets,
    skipped,
    textMatched,
    failures,
    message:
      failures.length === 0
        ? `GET ${pagePart}; ${assetPart}${textMatched ? '; expected text found' : ''}`
        : `GET ${pagePart}; ${assetPart}; ${failures.length} problem(s): ${failures.join(', ')}`,
  };
}

/** One line per asset for the model's `detail` field. */
export function describeHttpCheck(result: HttpCheckResult): string {
  const lines = [
    `page: ${result.url}`,
    `status: ${result.page.status} ${result.page.contentType} ${result.page.bytes} bytes`,
  ];
  if (result.textMatched === true) lines.push('expected text: found');
  if (result.textMatched === false) lines.push('expected text: NOT found');
  if (result.assets.length > 0) {
    lines.push('assets:');
    for (const asset of result.assets) {
      lines.push(
        `  ${asset.ok ? 'ok  ' : 'FAIL'} ${asset.path} → ${asset.status || 'unreachable'} ${asset.contentType.split(';')[0] ?? ''} ${asset.bytes} bytes`.trimEnd(),
      );
    }
  }
  if (result.skipped.length > 0) {
    lines.push(`not checked (external or inline): ${result.skipped.slice(0, 8).join(', ')}`);
  }
  if (result.failures.length > 0) lines.push(`problems: ${result.failures.join(', ')}`);
  return lines.join('\n');
}
