import path from 'node:path';

/** Resolves paths relative to the repository root, independent of the cwd. */
export const REPO_ROOT = path.resolve(import.meta.dirname, '../..');

/** OpenAI-compatible gateway used out of the box. Users may point it elsewhere. */
export const DEFAULT_ENDPOINT = 'https://ai.sinarcloud.com/v1';

/**
 * Free-tier model verified working on the default endpoint.
 * It is the session default and the automatic fallback when a paid model
 * runs out of credit, so the office never goes dark.
 */
export const FREE_MODEL = 'deepseek/deepseek-v4-1-flash';

/** Model id used when the session does not pick one explicitly. */
export const DEFAULT_MODEL = FREE_MODEL;

export const SERVER_PORT = Number(process.env.OFFICE_PORT ?? 8787);

export const CLIENT_ORIGIN = process.env.OFFICE_CLIENT_ORIGIN ?? 'http://127.0.0.1:5173';

/** Sandboxed root for agent file/command access. */
export const WORKSPACE_DIR = path.resolve(
  REPO_ROOT,
  process.env.OFFICE_WORKSPACE ?? 'workspace',
);

/** Outbound web access is opt-in, but the CLI turns it on when it launches. */
export const WEB_ENABLED = process.env.OFFICE_WEB === '1';

export const CLIENT_DIST_DIR = path.resolve(REPO_ROOT, 'client/dist');

/**
 * Local state that must outlive a restart. Overridable so a check can run
 * against its own folder instead of the operator's real one.
 */
const STATE_DIR = path.resolve(REPO_ROOT, process.env.OFFICE_STATE_DIR ?? '.agent-office');

/** Roster, mission board and recent history, written on change and read at boot. */
export const OFFICE_STATE_FILE = path.join(STATE_DIR, 'office-state.json');

/**
 * Model/tool round trips allowed per turn. A real feature (read, patch, run,
 * fail, repair) needs dozens; six only ever covered a demo. Overridable so a
 * big refactor can raise it without a code change.
 */
export const MAX_ACTION_ROUNDS = Number(process.env.OFFICE_MAX_ROUNDS ?? 40);

/** Token ceiling per turn. The loop stops cleanly instead of running up a bill. */
export const ACTION_TOKEN_BUDGET = Number(process.env.OFFICE_TOKEN_BUDGET ?? 400_000);

/** Identical tool calls tolerated in a row before the loop forces a new plan. */
export const REPEAT_ACTION_LIMIT = 3;

/**
 * Times the verification gate may reopen a finished task before the result is
 * accepted with a warning. Two repair attempts cover the common case (a typo or
 * a missing file) without letting a stuck worker loop forever.
 */
export const VERIFY_ATTEMPTS = Number(process.env.OFFICE_VERIFY_ATTEMPTS ?? 2);

/** Verification check timeout. `npm test` on a small project fits easily. */
export const VERIFY_TIMEOUT_MS = 120_000;

/** Whether the completion gate runs at all. */
export const VERIFY_ENABLED = process.env.OFFICE_VERIFY !== '0';

/** Whether a workspace without git gets an automatic checkpoint repo. */
export const GIT_CHECKPOINT_ENABLED = process.env.OFFICE_GIT !== '0';

export const COMMAND_TIMEOUT_MS = 20_000;
export const MAX_FILE_BYTES = 256 * 1024;

/** Max lines returned by one `read_file` call; the model pages with offset. */
export const READ_WINDOW_LINES = 400;
