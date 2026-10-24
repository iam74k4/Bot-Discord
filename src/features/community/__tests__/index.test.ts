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
 * Discord closes polls by itself, so the community feature's only lifecycle
 * job is pruning pointers to polls that have expired: once at start, then
 * daily until stopped. Real SQLite and fake timers make both observable.
 */
const db = new Database(':memory:');

vi.mock('../../../infrastructure/database/connection.js', () => ({
  database: db,
}));

vi.mock('../../../shared/utils/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
  getErrorMessage: (e: unknown) => String(e),
}));

const community = await import('../index.js');
const { pollRepository } = await import('../poll/pollRepository.js');
const { up: nativePolls } =
  await import('../../../infrastructure/database/migrations/010_native_polls.js');
const { logger } = await import('../../../shared/utils/logger.js');

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function seed(messageId: string, expiresIn: number) {
  pollRepository.create({
    message_id: messageId,
    guild_id: 'guild-1',
    channel_id: 'chan-1',
    creator_id: 'user-1',
    expires_at: Date.now() + expiresIn,
  });
}

function storedIds(): string[] {
  return (
    db.prepare('SELECT message_id FROM polls ORDER BY message_id').all() as {
      message_id: string;
    }[]
  ).map((row) => row.message_id);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-05-01T00:00:00Z'));
  vi.clearAllMocks();
  db.exec('DROP TABLE IF EXISTS polls');
  nativePolls();
});

afterEach(() => {
  community.stop();
  vi.useRealTimers();
});

afterAll(() => {
  db.close();
});

describe('community feature lifecycle', () => {
  it('registers under the community name', () => {
    expect(community.name).toBe('community');
  });

  it('prunes expired poll pointers on start and keeps live ones', () => {
    seed('stale-1', -1);
    seed('stale-2', -HOUR);
    seed('live', HOUR);

    community.start();

    expect(storedIds()).toEqual(['live']);
    expect(logger.info).toHaveBeenCalledWith('Pruned 2 expired poll record(s)');
    expect(logger.info).toHaveBeenCalledWith('Community feature started');
  });

  it('stays quiet about pruning when nothing has expired', () => {
    seed('live', HOUR);

    community.start();

    expect(logger.info).not.toHaveBeenCalledWith(
      expect.stringContaining('Pruned')
    );
    expect(storedIds()).toEqual(['live']);
  });

  it('prunes again once a day while running', () => {
    community.start();
    seed('expires-soon', HOUR);

    vi.advanceTimersByTime(DAY - 1);
    expect(storedIds()).toEqual(['expires-soon']);

    vi.advanceTimersByTime(1);
    expect(storedIds()).toEqual([]);
  });

  it('stops pruning once stopped', () => {
    community.start();
    community.stop();
    seed('expires-soon', HOUR);

    vi.advanceTimersByTime(2 * DAY);

    expect(storedIds()).toEqual(['expires-soon']);
  });

  it('does not start a second schedule when started twice', () => {
    community.start();
    community.start();
    community.stop();
    seed('expires-soon', HOUR);

    vi.advanceTimersByTime(2 * DAY);

    // A leaked second interval would have pruned the row.
    expect(storedIds()).toEqual(['expires-soon']);
    expect(
      vi
        .mocked(logger.info)
        .mock.calls.filter(([msg]) => msg === 'Community feature started')
    ).toHaveLength(1);
  });

  it('can be started again after a stop', () => {
    community.start();
    community.stop();
    community.start();
    seed('expires-soon', HOUR);

    vi.advanceTimersByTime(DAY);

    expect(storedIds()).toEqual([]);
  });

  it('tolerates stop before start', () => {
    expect(() => community.stop()).not.toThrow();
  });

  it('starts even when the poll table cannot be read', () => {
    db.exec('DROP TABLE polls');

    expect(() => community.start()).not.toThrow();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Failed to prune expired polls')
    );
    expect(logger.info).toHaveBeenCalledWith('Community feature started');
  });
});
