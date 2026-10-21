import fs from 'node:fs/promises';
import path from 'node:path';
import { OFFICE_STATE_FILE } from './config.ts';
import type { OfficeDiskState } from './store.ts';

/**
 * Mission state on disk.
 *
 * The office keeps the board, the roster and recent history in one JSON file
 * next to the workspace picker. Writes are debounced and atomic (temp file then
 * rename), so a kill -9 can leave the previous good file behind but never a
 * half-written one.
 */

const FORMAT_VERSION = 1;
const WRITE_DELAY_MS = 400;

interface PersistedEnvelope {
  version: number;
  savedAt: number;
  state: OfficeDiskState;
}

export interface RestoredOffice {
  state: OfficeDiskState;
  savedAt: number;
}

function isDiskState(value: unknown): value is OfficeDiskState {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<OfficeDiskState>;
  return (
    typeof candidate.settings === 'object' &&
    candidate.settings !== null &&
    Array.isArray(candidate.agents) &&
    Array.isArray(candidate.tasks) &&
    Array.isArray(candidate.logs) &&
    Array.isArray(candidate.chats)
  );
}

/**
 * Reads the saved office, or null when there is nothing usable.
 * An unreadable file is moved aside instead of deleted: a crash during a write
 * is worth inspecting once, not silently overwriting on the next boot.
 */
export async function loadOfficeState(file = OFFICE_STATE_FILE): Promise<RestoredOffice | null> {
  const raw = await fs.readFile(file, 'utf8').catch(() => null);
  if (raw === null) return null;

  try {
    const parsed: unknown = JSON.parse(raw);
    const envelope = parsed as Partial<PersistedEnvelope>;
    if (envelope.version !== FORMAT_VERSION || !isDiskState(envelope.state)) {
      throw new Error('unrecognised state format');
    }
    return {
      state: envelope.state,
      savedAt: typeof envelope.savedAt === 'number' ? envelope.savedAt : 0,
    };
  } catch (error) {
    const quarantine = `${file}.corrupt-${Date.now()}`;
    await fs.rename(file, quarantine).catch(() => undefined);
    console.log(
      `[persist] ${path.basename(file)} could not be read (${error instanceof Error ? error.message : 'unknown error'}) — moved to ${path.basename(quarantine)}.`,
    );
    return null;
  }
}

/**
 * Debounced writer. Subscribing it to the event bus means every mutation is on
 * disk shortly after it happens, without paying a write per token streamed.
 */
export class OfficePersistence {
  readonly #snapshot: () => OfficeDiskState;
  readonly #file: string;
  #timer: NodeJS.Timeout | null = null;
  /** Serialises writes so two flushes can never interleave their renames. */
  #tail: Promise<void> = Promise.resolve();
  #stopped = false;
  #lastError = '';

  constructor(snapshot: () => OfficeDiskState, file = OFFICE_STATE_FILE) {
    this.#snapshot = snapshot;
    this.#file = file;
  }

  /** Coalesces a burst of events into one write. */
  schedule(delayMs = WRITE_DELAY_MS): void {
    if (this.#stopped || this.#timer !== null) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      void this.flush();
    }, delayMs);
    this.#timer.unref();
  }

  flush(): Promise<void> {
    this.#tail = this.#tail.then(() => this.#write());
    return this.#tail;
  }

  /** Stops scheduling and writes whatever is pending. Used on shutdown. */
  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    await this.flush();
  }

  async #write(): Promise<void> {
    const envelope: PersistedEnvelope = {
      version: FORMAT_VERSION,
      savedAt: Date.now(),
      state: this.#snapshot(),
    };
    try {
      await fs.mkdir(path.dirname(this.#file), { recursive: true });
      const temporary = `${this.#file}.${process.pid}.tmp`;
      await fs.writeFile(temporary, `${JSON.stringify(envelope)}\n`, 'utf8');
      await fs.rename(temporary, this.#file);
      this.#lastError = '';
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown error';
      if (message !== this.#lastError) {
        this.#lastError = message;
        console.log(`[persist] could not save the office state: ${message}`);
      }
    }
  }
}
