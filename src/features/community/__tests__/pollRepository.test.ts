import Database from 'better-sqlite3';
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

/**
 * The pointer table is all that survives the move to native polls, and its one
 * job is answering "which message is this user's open poll here". These run
 * against real SQLite because the interesting parts are the query predicates.
 */
const db = new Database(':memory:');

vi.mock('../../../infrastructure/database/connection.js', () => ({
  database: db,
}));

vi.mock('../../../shared/utils/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
  getErrorMessage: (e: unknown) => String(e),
}));

const { pollRepository } = await import('../poll/pollRepository.js');
const { up: nativePolls } =
  await import('../../../infrastructure/database/migrations/010_native_polls.js');
const { logger } = await import('../../../shared/utils/logger.js');

const HOUR = 60 * 60 * 1000;

function record(
  overrides: Partial<Parameters<typeof pollRepository.create>[0]>
) {
  return {
    message_id: 'msg-1',
    guild_id: 'guild-1',
    channel_id: 'chan-1',
    creator_id: 'user-1',
    expires_at: Date.now() + HOUR,
    ...overrides,
  };
}

describe('pollRepository', () => {
  beforeEach(() => {
    db.exec('DROP TABLE IF EXISTS polls');
    nativePolls();
  });

  it("finds the creator's own poll in this channel", () => {
    pollRepository.create(record({}));

    expect(
      pollRepository.findActiveByCreator('user-1', 'chan-1')?.message_id
    ).toBe('msg-1');
  });

  it('does not hand a poll to another user or another channel', () => {
    pollRepository.create(record({}));

    expect(pollRepository.findActiveByCreator('user-2', 'chan-1')).toBeNull();
    expect(pollRepository.findActiveByCreator('user-1', 'chan-2')).toBeNull();
  });

  it('ignores a poll Discord has already closed', () => {
    pollRepository.create(record({ expires_at: Date.now() - 1 }));

    expect(pollRepository.findActiveByCreator('user-1', 'chan-1')).toBeNull();
  });

  it('prunes only expired rows', () => {
    pollRepository.create(record({ message_id: 'live' }));
    pollRepository.create(
      record({ message_id: 'stale', expires_at: Date.now() - 1 })
    );

    expect(pollRepository.removeExpired()).toBe(1);
    expect(
      pollRepository.findActiveByCreator('user-1', 'chan-1')?.message_id
    ).toBe('live');
  });

  it('removes only the named poll', () => {
    pollRepository.create(record({ message_id: 'keep', channel_id: 'chan-2' }));
    pollRepository.create(record({ message_id: 'drop' }));

    pollRepository.remove('drop');

    expect(pollRepository.findActiveByCreator('user-1', 'chan-1')).toBeNull();
    expect(
      pollRepository.findActiveByCreator('user-1', 'chan-2')?.message_id
    ).toBe('keep');
  });

  it('treats removing an unknown poll as a no-op', () => {
    pollRepository.create(record({}));

    expect(() => pollRepository.remove('missing')).not.toThrow();
    expect(
      pollRepository.findActiveByCreator('user-1', 'chan-1')?.message_id
    ).toBe('msg-1');
  });

  it('overwrites the pointer when the same message is recorded again', () => {
    pollRepository.create(record({ expires_at: Date.now() - 1 }));
    pollRepository.create(record({ expires_at: Date.now() + HOUR }));

    expect(db.prepare('SELECT COUNT(*) AS n FROM polls').get()).toEqual({
      n: 1,
    });
    expect(
      pollRepository.findActiveByCreator('user-1', 'chan-1')?.message_id
    ).toBe('msg-1');
  });

  it("finds the creator's poll anywhere in the server, but not in another", () => {
    pollRepository.create(record({ channel_id: 'chan-2' }));

    expect(
      pollRepository.findActiveByCreatorInGuild('user-1', 'guild-1')?.message_id
    ).toBe('msg-1');
    expect(
      pollRepository.findActiveByCreatorInGuild('user-1', 'guild-2')
    ).toBeNull();
    expect(
      pollRepository.findActiveByCreatorInGuild('user-2', 'guild-1')
    ).toBeNull();
  });

  it('finds an open poll by its message, and not once it has expired', () => {
    pollRepository.create(record({ message_id: 'open' }));
    pollRepository.create(
      record({ message_id: 'closed', expires_at: Date.now() - 1 })
    );

    expect(pollRepository.findActive('open')).toMatchObject({
      message_id: 'open',
      creator_id: 'user-1',
      guild_id: 'guild-1',
    });
    expect(pollRepository.findActive('closed')).toBeNull();
    expect(pollRepository.findActive('missing')).toBeNull();
  });

  describe('on a frozen clock', () => {
    const NOW = new Date('2026-05-01T12:00:00Z').getTime();

    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(NOW);
    });

    // Restores the real clock even when a test throws midway.
    afterEach(() => {
      vi.useRealTimers();
    });

    it('stamps created_at with the current time', () => {
      pollRepository.create(record({ expires_at: NOW + HOUR }));

      expect(
        pollRepository.findActiveByCreator('user-1', 'chan-1')
      ).toMatchObject({ created_at: NOW, expires_at: NOW + HOUR });
    });

    it('returns the most recent poll when a user has several open', () => {
      pollRepository.create(record({ message_id: 'older' }));
      vi.advanceTimersByTime(1_000);
      pollRepository.create(record({ message_id: 'newer' }));

      expect(
        pollRepository.findActiveByCreator('user-1', 'chan-1')?.message_id
      ).toBe('newer');
    });

    it('prefers the newest poll server-wide too', () => {
      pollRepository.create(record({ message_id: 'older' }));
      vi.advanceTimersByTime(1_000);
      pollRepository.create(
        record({ message_id: 'newer', channel_id: 'chan-2' })
      );

      expect(
        pollRepository.findActiveByCreatorInGuild('user-1', 'guild-1')
          ?.message_id
      ).toBe('newer');
    });

    it("lists the creator's open polls in the server, newest first, up to the limit", () => {
      for (const [index, id] of ['a', 'b', 'c', 'd'].entries()) {
        pollRepository.create(
          record({ message_id: id, channel_id: `chan-${index}` })
        );
        vi.advanceTimersByTime(1_000);
      }
      pollRepository.create(record({ message_id: 'theirs', creator_id: 'x' }));
      pollRepository.create(record({ message_id: 'away', guild_id: 'g-2' }));
      pollRepository.create(
        record({ message_id: 'over', expires_at: Date.now() })
      );

      expect(
        pollRepository
          .listActiveByCreatorInGuild('user-1', 'guild-1', 3)
          .map((poll) => poll.message_id)
      ).toEqual(['d', 'c', 'b']);
    });

    describe('at the exact expiry instant', () => {
      it('no longer offers the poll and prunes it', () => {
        pollRepository.create(record({ expires_at: NOW }));

        expect(
          pollRepository.findActiveByCreator('user-1', 'chan-1')
        ).toBeNull();
        expect(pollRepository.removeExpired()).toBe(1);
      });

      it('still offers a poll one millisecond before expiry', () => {
        pollRepository.create(record({ expires_at: NOW + 1 }));

        expect(
          pollRepository.findActiveByCreator('user-1', 'chan-1')
        ).not.toBeNull();
        expect(pollRepository.removeExpired()).toBe(0);
      });
    });
  });

  it('reports nothing pruned, and warns, when the table is unavailable', () => {
    vi.mocked(logger.warn).mockClear();
    db.exec('DROP TABLE polls');

    expect(pollRepository.removeExpired()).toBe(0);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Failed to prune expired polls')
    );
  });
});

describe('native poll migration', () => {
  it('replaces the custom poll schema exactly once', () => {
    db.exec('DROP TABLE IF EXISTS polls');
    // A database still carrying the button-era schema, with a live poll in it.
    db.exec(`
      CREATE TABLE polls (
        message_id TEXT PRIMARY KEY,
        question TEXT NOT NULL,
        options TEXT NOT NULL
      )
    `);
    db.exec(`
      CREATE TABLE poll_votes (message_id TEXT, user_id TEXT, option_index INTEGER)
    `);
    db.prepare('INSERT INTO polls VALUES (?, ?, ?)').run(
      'old',
      'Lunch?',
      '["a","b"]'
    );

    nativePolls();
    pollRepository.create(record({ message_id: 'kept' }));
    // Re-running on every boot must not wipe what the first run created.
    nativePolls();
    nativePolls();

    expect(
      pollRepository.findActiveByCreator('user-1', 'chan-1')?.message_id
    ).toBe('kept');
    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='poll_votes'"
        )
        .get()
    ).toBeUndefined();
  });
});

afterAll(() => {
  db.close();
});
