import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export interface ScreenshotRequest {
  root: string;
  /** Workspace-relative HTML file to render. */
  htmlRelative: string;
  width: number;
  height: number;
}

export interface ScreenshotResult {
  ok: boolean;
  message: string;
  artifact?: string;
  bytes?: number;
}

const MAX_DIMENSION = 5_000;
const RENDER_TIMEOUT_MS = 45_000;

const BROWSER_CANDIDATES = [
  process.env.CHROME_PATH,
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/snap/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
].filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);

const PATH_CANDIDATES = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'];

let cachedBrowser: string | null | undefined;

function onPath(binary: string): string | null {
  const directories = (process.env.PATH ?? '').split(path.delimiter);
  const extensions = process.platform === 'win32' ? ['.exe', '.cmd', ''] : [''];
  for (const directory of directories) {
    if (directory.length === 0) continue;
    for (const extension of extensions) {
      const candidate = path.join(directory, `${binary}${extension}`);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/** Locates a Chromium binary. Cached: a miss costs a PATH scan every turn. */
export function findBrowser(): string | null {
  if (cachedBrowser !== undefined) return cachedBrowser;
  for (const candidate of BROWSER_CANDIDATES) {
    if (existsSync(candidate)) {
      cachedBrowser = candidate;
      return candidate;
    }
  }
  for (const binary of PATH_CANDIDATES) {
    const found = onPath(binary);
    if (found) {
      cachedBrowser = found;
      return found;
    }
  }
  cachedBrowser = null;
  return null;
}

function slug(value: string): string {
  return value
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'preview';
}

/**
 * Renders a workspace page in headless Chrome and writes a PNG the worker can
 * open. Without this the agent writes CSS blind.
 */
export async function captureScreenshot(request: ScreenshotRequest): Promise<ScreenshotResult> {
  const browser = findBrowser();
  if (!browser) {
    return { ok: false, message: 'No Chrome/Chromium binary found — cannot render a preview.' };
  }

  const htmlPath = path.resolve(request.root, request.htmlRelative);
  if (!htmlPath.startsWith(path.resolve(request.root))) {
    return { ok: false, message: 'That page is outside the workspace folder.' };
  }
  try {
    await fs.access(htmlPath);
  } catch {
    return { ok: false, message: `${request.htmlRelative} does not exist in the workspace.` };
  }

  const width = Math.min(Math.max(Math.round(request.width) || 1440, 240), MAX_DIMENSION);
  const height = Math.min(Math.max(Math.round(request.height) || 900, 240), MAX_DIMENSION);
  const outputDir = path.join(request.root, '.agent-office', 'previews');
  await fs.mkdir(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, `${slug(request.htmlRelative)}-${width}x${height}.png`);

  const profileDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aegisx-preview-'));
  const args = [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--hide-scrollbars',
    '--force-device-scale-factor=1',
    '--virtual-time-budget=4000',
    `--window-size=${width},${height}`,
    `--user-data-dir=${profileDir}`,
    `--screenshot=${outputPath}`,
    pathToFileURL(htmlPath).href,
  ];

  const exitCode = await new Promise<number>((resolve) => {
    execFile(browser, args, { timeout: RENDER_TIMEOUT_MS, maxBuffer: 2 * 1024 * 1024 }, (error) => {
      if (!error) {
        resolve(0);
        return;
      }
      resolve(typeof error.code === 'number' ? error.code : 1);
    });
  });
  await fs.rm(profileDir, { recursive: true, force: true }).catch(() => {});

  const stat = await fs.stat(outputPath).catch(() => null);
  if (exitCode !== 0 || !stat || stat.size === 0) {
    return { ok: false, message: `Chrome could not render ${request.htmlRelative} (exit ${exitCode}).` };
  }

  return {
    ok: true,
    message: `Rendered ${request.htmlRelative} at ${width}×${height}.`,
    artifact: path.relative(request.root, outputPath),
    bytes: stat.size,
  };
}
