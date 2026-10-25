import { createRequire } from 'module';
import { Worker } from 'worker_threads';

/**
 * Copying the database off the main thread.
 *
 * `database.backup()` on the bot's own connection copies in small steps, but
 * its last step commits and syncs the whole destination file in one go: a
 * 30-150 ms freeze of the event loop for an 11-107 MB database. During that
 * freeze TTS playback stutters and `/voice record` clips get a gap, because
 * audio is placed by the time it arrives. A short-lived worker thread with its
 * own read connection does the whole copy instead, and the main thread only
 * waits for a message.
 */

/** What the worker needs; plain data, because it crosses a thread boundary. */
export interface SnapshotJob {
  /** The live database file. */
  source: string;
  /** Where the copy goes. Must not be the source. */
  destination: string;
  /** Resolved path of better-sqlite3, so the worker loads the same driver. */
  driver: string;
}

/** The part of `Worker` the backup uses, so tests can drive a fake one. */
export interface SnapshotWorker {
  on(event: 'message', listener: (message: unknown) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  on(event: 'exit', listener: (code: number) => void): unknown;
  terminate(): Promise<number>;
}

export type SpawnSnapshotWorker = (job: SnapshotJob) => SnapshotWorker;

/**
 * How a worker copy ended.
 * - `done`: the destination is a complete, synced copy.
 * - `failed`: the copy itself failed (disk full, unreadable source, timeout).
 *   Retrying on the main thread would most likely fail the same way.
 * - `unavailable`: no worker could run (it failed to start or to load the
 *   driver) and nothing was copied, so copying on the main thread is the
 *   right fallback.
 */
export type SnapshotOutcome =
  | { status: 'done' }
  | { status: 'failed'; error: string }
  | { status: 'unavailable'; error: string };

/** A copy that takes this long is stuck rather than slow. */
export const SNAPSHOT_TIMEOUT_MS = 5 * 60_000;

/**
 * The worker's code, run with `eval` so it needs no file of its own.
 *
 * A worker file would have to be found as `.ts` under tsx and Vitest and as
 * `.js` under `node dist`, and Node 22.12 cannot load TypeScript in a worker
 * without a loader. Inline CommonJS runs the same way everywhere.
 *
 * - `started` is posted once the driver has loaded: an error before it means
 *   the worker could not run at all, an error after it means the copy failed.
 * - The source opens as an ordinary connection that never writes. In WAL mode
 *   a reader does not block the bot's writes, and the small page cache keeps
 *   the worker's memory spike to a few tens of MB.
 * - better-sqlite3 transfers 0 pages first, then what `progress` returns;
 *   returning every page makes the copy one step inside one read
 *   transaction. A copy split into steps restarts each time another
 *   connection writes, so on a busy bot it might never finish.
 * - The last step commits the destination with SQLite's default FULL sync,
 *   so `done` means the copy has reached the disk - the step that used to
 *   freeze the main thread.
 * - No checkpoint here: TRUNCATE/RESTART/FULL take the write lock and would
 *   leave the bot's connection waiting on it.
 */
export const SNAPSHOT_WORKER_SOURCE = `'use strict';
const { parentPort, workerData } = require('node:worker_threads');
const Database = require(workerData.driver);
parentPort.postMessage({ type: 'started' });
(async () => {
  let db = null;
  try {
    db = new Database(workerData.source, { fileMustExist: true });
    db.pragma('cache_size = -2000');
    await db.backup(workerData.destination, { progress: () => 0x7fffffff });
    parentPort.postMessage({ type: 'done' });
  } catch (error) {
    parentPort.postMessage({
      type: 'done',
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    if (db) db.close();
  }
})();
`;

/** Resolve better-sqlite3 the way this module would import it. */
export function resolveSqliteDriver(): string {
  return createRequire(import.meta.url).resolve('better-sqlite3');
}

export const spawnSnapshotWorker: SpawnSnapshotWorker = (job) =>
  new Worker(SNAPSHOT_WORKER_SOURCE, { eval: true, workerData: job });

function isMessage(
  message: unknown
): message is { type: 'started' } | { type: 'done'; error?: string } {
  return (
    typeof message === 'object' &&
    message !== null &&
    'type' in message &&
    (message.type === 'started' || message.type === 'done')
  );
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Copy `job.source` to `job.destination` in a worker thread.
 *
 * Settles only once the worker has exited, so its connection is closed
 * before anyone closes the main connection or replaces the file. Never
 * rejects; the outcome says what happened.
 */
export function snapshotInWorker(
  job: SnapshotJob,
  options: { spawn?: SpawnSnapshotWorker; timeoutMs?: number } = {}
): Promise<SnapshotOutcome> {
  const spawn = options.spawn ?? spawnSnapshotWorker;
  const timeoutMs = options.timeoutMs ?? SNAPSHOT_TIMEOUT_MS;

  let worker: SnapshotWorker;
  try {
    worker = spawn(job);
  } catch (error) {
    return Promise.resolve({ status: 'unavailable', error: errorText(error) });
  }

  return new Promise((resolve) => {
    let started = false;
    let outcome: SnapshotOutcome | null = null;

    const settleWith = (next: SnapshotOutcome): void => {
      outcome ??= next;
    };

    const timer = setTimeout(() => {
      settleWith({
        status: 'failed',
        error: `Backup did not finish within ${Math.round(timeoutMs / 1000)} s`,
      });
      void worker.terminate();
    }, timeoutMs);

    worker.on('message', (message) => {
      if (!isMessage(message)) return;
      if (message.type === 'started') {
        started = true;
        return;
      }
      settleWith(
        message.error === undefined
          ? { status: 'done' }
          : { status: 'failed', error: message.error }
      );
    });

    worker.on('error', (error) => {
      const text = errorText(error);
      settleWith(
        started
          ? { status: 'failed', error: text }
          : { status: 'unavailable', error: text }
      );
    });

    worker.on('exit', (code) => {
      clearTimeout(timer);
      const reason = `Backup worker exited with code ${code}`;
      resolve(
        outcome ??
          (started
            ? { status: 'failed', error: reason }
            : { status: 'unavailable', error: reason })
      );
    });
  });
}
