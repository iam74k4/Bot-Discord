import Database, { type Database as DatabaseType } from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { proxyDatabase } from './infrastructure.helpers.js';

let db: DatabaseType = new Database(':memory:');

vi.mock('../connection.js', () => ({
  database: proxyDatabase(() => db),
}));

const { runTransaction } = await import('../transaction.js');

function insert(value: string): void {
  db.prepare('INSERT INTO items (value) VALUES (?)').run(value);
}

function values(): string[] {
  return (
    db.prepare('SELECT value FROM items ORDER BY rowid').all() as Array<{
      value: string;
    }>
  ).map((row) => row.value);
}

describe('runTransaction', () => {
  beforeEach(() => {
    db = new Database(':memory:');
    db.exec('CREATE TABLE items (value TEXT NOT NULL UNIQUE)');
  });

  afterEach(() => {
    db.close();
  });

  it('commits the writes and returns what the callback returns', () => {
    const result = runTransaction(() => {
      insert('a');
      insert('b');
      return 42;
    });

    expect(result).toBe(42);
    expect(values()).toEqual(['a', 'b']);
    expect(db.inTransaction).toBe(false);
  });

  it('rolls back every write and rethrows when the callback throws', () => {
    const failure = new Error('validation failed');

    expect(() =>
      runTransaction(() => {
        insert('a');
        insert('b');
        throw failure;
      })
    ).toThrow(failure);

    expect(values()).toEqual([]);
    expect(db.inTransaction).toBe(false);
  });

  it('rolls back earlier writes when a later statement violates a constraint', () => {
    insert('existing');

    expect(() =>
      runTransaction(() => {
        insert('new');
        insert('existing');
      })
    ).toThrow(/UNIQUE constraint failed/);

    expect(values()).toEqual(['existing']);
  });

  it('leaves the connection usable after a rollback', () => {
    expect(() =>
      runTransaction(() => {
        insert('a');
        throw new Error('boom');
      })
    ).toThrow('boom');

    runTransaction(() => insert('b'));

    expect(values()).toEqual(['b']);
  });

  it('undoes only the inner work when a nested failure is caught', () => {
    runTransaction(() => {
      insert('outer');
      try {
        runTransaction(() => {
          insert('inner');
          throw new Error('inner failed');
        });
      } catch {
        // The caller chose to carry on without the inner write.
      }
      insert('outer-after');
    });

    expect(values()).toEqual(['outer', 'outer-after']);
  });

  it('rejects async callbacks and keeps nothing they wrote synchronously', () => {
    // better-sqlite3 cannot hold a transaction across an await.
    expect(() =>
      runTransaction(async () => {
        insert('a');
        await Promise.resolve();
      })
    ).toThrow(TypeError);

    expect(values()).toEqual([]);
    expect(db.inTransaction).toBe(false);
  });
});
