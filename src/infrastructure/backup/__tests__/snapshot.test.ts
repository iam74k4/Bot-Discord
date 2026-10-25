import Database from 'better-sqlite3';
import { EventEmitter } from 'events';
import { existsSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  resolveSqliteDriver,
  snapshotInWorker,
  type SnapshotJob,
  type SnapshotWorker,
} from '../snapshot.js';

/**
 * The copy runs in a real worker thread against real SQLite files, because
 * the claims worth testing are about threads and files: the main thread keeps
 * writing while the copy is made, the copy is a consistent database, and a
 * worker that cannot run is told apart from a copy that failed.
 */

let dir: string;

function job(overrides: Partial<SnapshotJob> = {}): SnapshotJob {
  return {
    source: join(dir, 'live.db'),
    destination: join(dir, 'copy.db'),
    driver: resolveSqliteDriver(),
    ...overrides,
  };
}

/** A worker double whose events the test fires by hand. */
class FakeWorker extends EventEmitter implements SnapshotWorker {
  terminate = vi.fn(async () => {
    this.emit('exit', 1);
    return 1;
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bot-snapshot-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('snapshotInWorker with a real worker', () => {
  it('copies a WAL database consistently while the main thread keeps writing to it', async () => {
    const live = new Database(join(dir, 'live.db'));
    live.pragma('journal_mode = WAL');
    live.exec(
      'CREATE TABLE events (id INTEGER PRIMARY KEY, payload TEXT NOT NULL)'
    );
    const insert = live.prepare('INSERT INTO events (payload) VALUES (?)');
    live.transaction(() => {
      for (let i = 0; i < 2000; i++) insert.run('x'.repeat(200));
    })();
    // The bot keeps recording VC joins and leaves while the copy runs.
    const writer = setInterval(() => insert.run('during'), 1);

    let outcome;
    try {
      outcome = await snapshotInWorker(job());
    } finally {
      clearInterval(writer);
    }

    expect(outcome).toEqual({ status: 'done' });
    // The main thread was free the whole time: its writes went through.
    expect(
      live
        .prepare('SELECT COUNT(*) AS n FROM events WHERE payload = ?')
        .get('during')
    ).not.toEqual({ n: 0 });
    live.close();

    const copy = new Database(join(dir, 'copy.db'), { fileMustExist: true });
    expect(copy.pragma('integrity_check', { simple: true })).toBe('ok');
    // Every row committed before the copy started is in it.
    expect(
      copy
        .prepare(
          'SELECT COUNT(*) AS n, MIN(id) AS first, MAX(id) AS last FROM events WHERE payload != ?'
        )
        .get('during')
    ).toEqual({ n: 2000, first: 1, last: 2000 });
    copy.close();
  });

  it('reports a copy that failed, without creating the destination', async () => {
    const outcome = await snapshotInWorker(job());

    expect(outcome).toMatchObject({ status: 'failed' });
    expect((outcome as { error: string }).error).not.toBe('');
    expect(existsSync(join(dir, 'copy.db'))).toBe(false);
  });

  it('tells a worker that could not load the driver apart from a failed copy', async () => {
    const outcome = await snapshotInWorker(
      job({ driver: join(dir, 'missing-driver.js') })
    );

    expect(outcome).toMatchObject({ status: 'unavailable' });
    expect((outcome as { error: string }).error).toContain('missing-driver');
  });
});

describe('snapshotInWorker outcomes', () => {
  it('is unavailable when no worker can be created', async () => {
    const outcome = await snapshotInWorker(job(), {
      spawn: () => {
        throw new Error('ERR_WORKER_INIT_FAILED');
      },
    });

    expect(outcome).toEqual({
      status: 'unavailable',
      error: 'ERR_WORKER_INIT_FAILED',
    });
  });

  it('waits for the worker to exit before settling, so its connection is closed', async () => {
    const worker = new FakeWorker();
    let settled = false;
    const result = snapshotInWorker(job(), { spawn: () => worker }).then(
      (outcome) => {
        settled = true;
        return outcome;
      }
    );

    worker.emit('message', { type: 'started' });
    worker.emit('message', { type: 'done' });
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);

    worker.emit('exit', 0);

    await expect(result).resolves.toEqual({ status: 'done' });
  });

  it('passes on the error of a copy that failed inside the worker', async () => {
    const worker = new FakeWorker();
    const result = snapshotInWorker(job(), { spawn: () => worker });

    worker.emit('message', { type: 'started' });
    worker.emit('message', { type: 'done', error: 'database or disk is full' });
    worker.emit('exit', 0);

    await expect(result).resolves.toEqual({
      status: 'failed',
      error: 'database or disk is full',
    });
  });

  it('counts a crash after the worker started as a failed copy', async () => {
    const worker = new FakeWorker();
    const result = snapshotInWorker(job(), { spawn: () => worker });

    worker.emit('message', { type: 'started' });
    worker.emit(
      'error',
      new Error('Worker terminated due to reaching memory limit')
    );
    worker.emit('exit', 1);

    await expect(result).resolves.toEqual({
      status: 'failed',
      error: 'Worker terminated due to reaching memory limit',
    });
  });

  it('counts a crash before the worker started as no worker at all', async () => {
    const worker = new FakeWorker();
    const result = snapshotInWorker(job(), { spawn: () => worker });

    worker.emit('error', new Error('Cannot find module'));
    worker.emit('exit', 1);

    await expect(result).resolves.toEqual({
      status: 'unavailable',
      error: 'Cannot find module',
    });
  });

  it('reports an exit that left no message', async () => {
    const started = new FakeWorker();
    const startedResult = snapshotInWorker(job(), { spawn: () => started });
    started.emit('message', { type: 'started' });
    started.emit('exit', 7);

    const silent = new FakeWorker();
    const silentResult = snapshotInWorker(job(), { spawn: () => silent });
    silent.emit('message', 'unrelated');
    silent.emit('exit', 3);

    await expect(startedResult).resolves.toEqual({
      status: 'failed',
      error: 'Backup worker exited with code 7',
    });
    await expect(silentResult).resolves.toEqual({
      status: 'unavailable',
      error: 'Backup worker exited with code 3',
    });
  });

  it('stops a copy that runs past the timeout and reports it as failed', async () => {
    vi.useFakeTimers();
    try {
      const worker = new FakeWorker();
      const result = snapshotInWorker(job(), {
        spawn: () => worker,
        timeoutMs: 60_000,
      });
      worker.emit('message', { type: 'started' });

      await vi.advanceTimersByTimeAsync(59_999);
      expect(worker.terminate).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);

      expect(worker.terminate).toHaveBeenCalledTimes(1);
      await expect(result).resolves.toEqual({
        status: 'failed',
        error: 'Backup did not finish within 60 s',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not stop a worker that finished in time', async () => {
    vi.useFakeTimers();
    try {
      const worker = new FakeWorker();
      const result = snapshotInWorker(job(), {
        spawn: () => worker,
        timeoutMs: 1_000,
      });
      worker.emit('message', { type: 'started' });
      worker.emit('message', { type: 'done' });
      worker.emit('exit', 0);
      await expect(result).resolves.toEqual({ status: 'done' });

      await vi.advanceTimersByTimeAsync(5_000);

      expect(worker.terminate).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
