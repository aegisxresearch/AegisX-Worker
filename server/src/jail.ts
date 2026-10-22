import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * A real jail, not a longer allowlist.
 *
 * The path guard and the binary allowlist are ergonomics: they stop a worker
 * from *accidentally* leaving the folder. They cannot stop `node -e` or a
 * `postinstall` script from reading `~/.ssh`, because the process is still the
 * operator's process. bubblewrap gives the child its own mount and pid
 * namespaces with only the workspace (read-write) and the toolchain
 * (read-only) visible — so the allowlist can stay generous without the folder
 * being the only thing between a model and the home directory.
 *
 * Everything here is opt-out (`OFFICE_JAIL=0`) and degrades loudly: when
 * bubblewrap is missing the office keeps working, the log says the jail is off,
 * and `scripts/jail-check.mjs` reports the real isolation status.
 */

export interface JailStatus {
  available: boolean;
  /** Why the jail cannot be used, when it cannot. */
  reason: string | null;
  binary: string | null;
}

let cached: JailStatus | null = null;

/** Filesystem roots a jailed command needs to run the toolchain. */
const READ_ONLY_ROOTS = ['/usr', '/bin', '/sbin', '/lib', '/lib64', '/lib32', '/etc', '/opt'];

/** `/bin` and `/lib` may be symlinks into `/usr` on a merged-usr distro. */
function bindRoot(target: string, args: string[]): void {
  if (!fs.existsSync(target)) return;
  const stat = fs.lstatSync(target);
  if (stat.isSymbolicLink()) {
    const link = fs.readlinkSync(target);
    const resolved = path.resolve(path.dirname(target), link);
    const relative = path.relative('/', resolved);
    args.push('--symlink', relative, target);
    return;
  }
  args.push('--ro-bind', target, target);
}

/**
 * Probes bubblewrap once, by actually creating a sandbox. A version check is
 * not enough: `bwrap` exists on hosts where unprivileged user namespaces are
 * disabled, and every command would then fail with the same opaque error.
 */
export function jailStatus(): JailStatus {
  if (cached) return cached;
  const binary = ['/usr/bin/bwrap', '/bin/bwrap', '/usr/local/bin/bwrap'].find((candidate) =>
    fs.existsSync(candidate),
  );
  if (!binary) {
    cached = { available: false, reason: 'bubblewrap (bwrap) is not installed', binary: null };
    return cached;
  }

  // The probe must bind the same roots a real command gets: a dynamic binary
  // needs /lib, and a probe that omits it fails for a reason the jail would not.
  const args = ['--die-with-parent', '--unshare-pid', '--dev', '/dev', '--proc', '/proc', '--tmpfs', '/tmp'];
  for (const target of READ_ONLY_ROOTS) bindRoot(target, args);
  args.push('--clearenv', '--setenv', 'PATH', '/usr/bin:/bin');
  args.push('--', '/usr/bin/true');

  try {
    execFileSync(binary, args, { stdio: 'ignore', timeout: 5_000, env: {} });
    cached = { available: true, reason: null, binary };
  } catch (error) {
    const detail = error instanceof Error ? error.message.split('\n')[0] : 'unknown error';
    cached = {
      available: false,
      reason: `bubblewrap could not start a sandbox (${detail})`,
      binary,
    };
  }
  return cached;
}

export interface JailRequest {
  argv: string[];
  /** Folder the command runs in, inside the workspace. */
  cwd: string;
  /** The workspace root: bound read-write, and the only writable tree. */
  root: string;
  /** Writable HOME inside the jail, typically `.agent-office/jail-home`. */
  home: string;
  /** Whether the command may use the network. Servers need it; probes do not. */
  net: boolean;
  /** Extra read-only paths (a node install outside `/usr`, for example). */
  readOnly?: string[];
  /** Extra environment, applied after the sandbox is cleared. */
  env?: Record<string, string>;
}

export type JailPlan =
  | { ok: true; command: string; args: string[] }
  | { ok: false; reason: string };

/**
 * Builds the argv for one jailed command. The caller spawns `command args…`
 * directly — there is no shell anywhere in this path, on either side.
 */
export function planJail(request: JailRequest): JailPlan {
  const status = jailStatus();
  if (!status.available || !status.binary) {
    return { ok: false, reason: status.reason ?? 'the jail is unavailable' };
  }

  const args: string[] = [
    '--die-with-parent',
    // No `--new-session`: it puts the child in its own session, which would let a
    // dev server survive `kill(-pid)` on the sandbox. The stdio pipes are not a
    // terminal, so there is no TTY to defend against here.
    '--unshare-pid',
    '--unshare-ipc',
    '--unshare-uts',
    '--unshare-cgroup-try',
    '--dev',
    '/dev',
    '--proc',
    '/proc',
    '--tmpfs',
    '/tmp',
    '--clearenv',
  ];

  if (!request.net) args.push('--unshare-net');

  for (const target of READ_ONLY_ROOTS) bindRoot(target, args);
  for (const extra of request.readOnly ?? []) {
    if (fs.existsSync(extra)) args.push('--ro-bind', extra, extra);
  }

  // The workspace is the only writable tree; HOME is a scratch dir inside the
  // state folder so npm/git caches survive between commands without opening the
  // operator's real home.
  args.push('--bind', request.root, request.root);
  fs.mkdirSync(request.home, { recursive: true });
  args.push('--bind', request.home, request.home);

  const pathParts = [
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    ...(request.readOnly ?? []).map((entry) => path.join(entry, 'bin')),
  ];
  args.push('--setenv', 'PATH', pathParts.join(':'));
  args.push('--setenv', 'HOME', request.home);
  args.push('--setenv', 'TMPDIR', '/tmp');
  args.push('--setenv', 'LANG', process.env.LANG ?? 'C.UTF-8');
  args.push('--setenv', 'TERM', 'dumb');
  // LD_PRELOAD inside a sandbox points at a library that is not bound in, which
  // turns every command into a warning on stderr.
  if (process.env.PORT) args.push('--setenv', 'PORT', process.env.PORT);
  for (const [key, value] of Object.entries(request.env ?? {})) {
    args.push('--setenv', key, value);
  }

  args.push('--chdir', request.cwd);
  args.push('--', ...request.argv);
  return { ok: true, command: status.binary, args };
}

/** The read-only roots a node install outside `/usr` needs bound in. */
export function toolchainRoots(): string[] {
  const roots = new Set<string>();
  const execPath = process.execPath;
  // /home/user/.nvm/versions/node/v24/bin/node — bind the version prefix only,
  // never the whole home directory.
  const prefix = path.resolve(path.dirname(execPath), '..');
  if (!['/usr', '/bin', '/opt'].some((allowed) => prefix === allowed || prefix.startsWith(`${allowed}/`))) {
    roots.add(prefix);
  }
  return [...roots];
}
