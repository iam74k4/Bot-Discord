import Database from 'better-sqlite3';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

/**
 * Every migration re-runs on every boot, so the full set must apply cleanly to
 * a database it has already migrated. 006 used to create an index on
 * `polls.ends_at` after 010 had rebuilt the table without that column, which
 * made every boot after the first fail with "no such column: ends_at".
 */
const db = new Database(':memory:');

vi.mock('../connection.js', () => ({ database: db }));

const MIGRATIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'migrations'
);

async function loadMigrations(): Promise<Array<() => void>> {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((file) => /^\d{3}_.*\.ts$/.test(file))
    .sort();
  const ups: Array<() => void> = [];
  for (const file of files) {
    const mod = (await import(`../migrations/${file}`)) as { up: () => void };
    ups.push(mod.up);
  }
  return ups;
}

function schema(): Array<{ type: string; name: string; sql: string | null }> {
  return db
    .prepare(
      "SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name"
    )
    .all() as Array<{ type: string; name: string; sql: string | null }>;
}

describe('migrations on an already-migrated database', () => {
  it('apply again on the next boot without errors or schema changes', async () => {
    const ups = await loadMigrations();
    const boot = db.transaction(() => ups.forEach((up) => up()));

    boot();
    db.prepare(
      'INSERT INTO polls (message_id, guild_id, channel_id, creator_id, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run('m1', 'g1', 'c1', 'u1', Date.now() + 60_000, Date.now());
    const before = schema();

    expect(() => boot()).not.toThrow();
    expect(() => boot()).not.toThrow();

    expect(schema()).toEqual(before);
    expect(
      db.prepare('SELECT message_id FROM polls').all() as Array<{
        message_id: string;
      }>
    ).toEqual([{ message_id: 'm1' }]);
  });
});
