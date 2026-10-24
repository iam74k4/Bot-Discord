import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Voice settings and the reading dictionary run against real SQLite: the
 * interesting parts are the upserts, the guild scoping and the ordering.
 */
const db = new Database(':memory:');

vi.mock('../../../infrastructure/database/connection.js', () => ({
  database: db,
}));

vi.mock('../../../shared/utils/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
  getErrorMessage: (e: unknown) => String(e),
}));

const { MAX_DICTIONARY_ENTRIES, ttsRepository } =
  await import('../repositories/ttsRepository.js');
const { up: ttsTables } =
  await import('../../../infrastructure/database/migrations/011_tts.js');
const { logger } = await import('../../../shared/utils/logger.js');

const T0 = new Date('2026-10-24T09:00:00.000Z').getTime();

describe('011_tts migration', () => {
  beforeEach(() => {
    db.exec(
      'DROP TABLE IF EXISTS tts_user_settings; DROP TABLE IF EXISTS tts_dictionary;'
    );
  });

  it('creates both tables and can run twice', () => {
    ttsTables();
    expect(() => ttsTables()).not.toThrow();

    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'tts_%' ORDER BY name"
      )
      .all() as Array<{ name: string }>;
    expect(tables.map((t) => t.name)).toEqual([
      'tts_dictionary',
      'tts_user_settings',
    ]);
  });

  it('defaults speed to 1.0', () => {
    ttsTables();
    db.prepare(
      'INSERT INTO tts_user_settings (user_id, speaker_id, updated_at) VALUES (?, ?, ?)'
    ).run('u', 3, 0);
    expect(ttsRepository.getUserSettings('u')).toEqual({
      speakerId: 3,
      speed: 1,
    });
  });

  it('keys the dictionary by guild and word', () => {
    ttsTables();
    const insert = db.prepare(
      'INSERT INTO tts_dictionary (guild_id, word, reading, created_by, created_at) VALUES (?, ?, ?, ?, ?)'
    );
    insert.run('g1', 'w', 'わら', 'u', 0);
    insert.run('g2', 'w', 'わら', 'u', 0);
    expect(() => insert.run('g1', 'w', 'だぶ', 'u', 0)).toThrow(/UNIQUE/);
  });
});

describe('ttsRepository', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
    db.exec(
      'DROP TABLE IF EXISTS tts_user_settings; DROP TABLE IF EXISTS tts_dictionary;'
    );
    ttsTables();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('user settings', () => {
    it('returns null for someone who never chose a voice', () => {
      expect(ttsRepository.getUserSettings('nobody')).toBeNull();
    });

    it('saves and reads back a voice and speed', () => {
      ttsRepository.setUserSettings('u1', { speakerId: 8, speed: 1.25 });

      expect(ttsRepository.getUserSettings('u1')).toEqual({
        speakerId: 8,
        speed: 1.25,
      });
      expect(
        db
          .prepare('SELECT updated_at FROM tts_user_settings WHERE user_id = ?')
          .get('u1')
      ).toEqual({ updated_at: T0 });
    });

    it('overwrites the previous choice instead of adding a row', () => {
      ttsRepository.setUserSettings('u1', { speakerId: 8, speed: 1.25 });
      vi.setSystemTime(T0 + 5_000);
      ttsRepository.setUserSettings('u1', { speakerId: 2, speed: 0.75 });

      expect(ttsRepository.getUserSettings('u1')).toEqual({
        speakerId: 2,
        speed: 0.75,
      });
      expect(
        db
          .prepare(
            'SELECT COUNT(*) AS n, MAX(updated_at) AS at FROM tts_user_settings'
          )
          .get()
      ).toEqual({ n: 1, at: T0 + 5_000 });
    });

    it('keeps users apart', () => {
      ttsRepository.setUserSettings('u1', { speakerId: 8, speed: 1 });
      ttsRepository.setUserSettings('u2', { speakerId: 2, speed: 2 });

      expect(ttsRepository.getUserSettings('u1')?.speakerId).toBe(8);
      expect(ttsRepository.getUserSettings('u2')?.speakerId).toBe(2);
    });

    it('reads degrade to null on a database failure', () => {
      db.exec('DROP TABLE tts_user_settings');

      expect(ttsRepository.getUserSettings('u1')).toBeNull();
      expect(logger.debug).toHaveBeenCalledWith(
        expect.stringContaining('Failed to read TTS settings for u1')
      );
    });

    it('writes surface a database failure to the caller', () => {
      db.exec('DROP TABLE tts_user_settings');
      expect(() =>
        ttsRepository.setUserSettings('u1', { speakerId: 1, speed: 1 })
      ).toThrow();
    });
  });

  describe('dictionary', () => {
    it('allows 200 entries per server', () => {
      expect(MAX_DICTIONARY_ENTRIES).toBe(200);
    });

    it('starts empty', () => {
      expect(ttsRepository.listDictionary('g1')).toEqual([]);
      expect(ttsRepository.countDictionary('g1')).toBe(0);
      expect(ttsRepository.getDictionaryEntry('g1', 'w')).toBeNull();
    });

    it('reports a new word as new and stores who added it', () => {
      expect(ttsRepository.upsertDictionaryEntry('g1', 'w', 'わら', 'u1')).toBe(
        true
      );

      expect(ttsRepository.getDictionaryEntry('g1', 'w')).toEqual({
        word: 'w',
        reading: 'わら',
        createdBy: 'u1',
      });
      expect(
        db
          .prepare('SELECT created_at FROM tts_dictionary WHERE word = ?')
          .get('w')
      ).toEqual({ created_at: T0 });
    });

    it('updates an existing word in place and reports it as not new', () => {
      ttsRepository.upsertDictionaryEntry('g1', 'w', 'わら', 'u1');
      vi.setSystemTime(T0 + 1_000);

      expect(ttsRepository.upsertDictionaryEntry('g1', 'w', 'くさ', 'u2')).toBe(
        false
      );

      expect(ttsRepository.getDictionaryEntry('g1', 'w')).toEqual({
        word: 'w',
        reading: 'くさ',
        createdBy: 'u2',
      });
      expect(ttsRepository.countDictionary('g1')).toBe(1);
      expect(
        db
          .prepare('SELECT created_at FROM tts_dictionary WHERE word = ?')
          .get('w')
      ).toEqual({ created_at: T0 + 1_000 });
    });

    it('lists a server’s words alphabetically, scoped to that server', () => {
      ttsRepository.upsertDictionaryEntry('g1', 'zeta', 'ぜーた', 'u1');
      ttsRepository.upsertDictionaryEntry('g1', 'alpha', 'あるふぁ', 'u2');
      ttsRepository.upsertDictionaryEntry('g1', 'mu', 'みゅー', 'u1');
      ttsRepository.upsertDictionaryEntry('g2', 'beta', 'べーた', 'u3');

      expect(ttsRepository.listDictionary('g1')).toEqual([
        { word: 'alpha', reading: 'あるふぁ', createdBy: 'u2' },
        { word: 'mu', reading: 'みゅー', createdBy: 'u1' },
        { word: 'zeta', reading: 'ぜーた', createdBy: 'u1' },
      ]);
      expect(ttsRepository.countDictionary('g1')).toBe(3);
      expect(ttsRepository.countDictionary('g2')).toBe(1);
      expect(ttsRepository.getDictionaryEntry('g2', 'alpha')).toBeNull();
    });

    it('treats case variants as one word, as chat matching does', () => {
      ttsRepository.upsertDictionaryEntry('g1', 'ABC', 'えーびーしー', 'u1');

      expect(ttsRepository.getDictionaryEntry('g1', 'abc')).toEqual({
        word: 'ABC',
        reading: 'えーびーしー',
        createdBy: 'u1',
      });
      expect(
        ttsRepository.upsertDictionaryEntry('g1', 'abc', 'あぶく', 'u2')
      ).toBe(false);
      expect(ttsRepository.countDictionary('g1')).toBe(1);
      expect(ttsRepository.listDictionary('g1')).toEqual([
        { word: 'abc', reading: 'あぶく', createdBy: 'u2' },
      ]);
      expect(ttsRepository.removeDictionaryEntry('g1', 'Abc')).toBe(true);
      expect(ttsRepository.countDictionary('g1')).toBe(0);
    });

    it('removes a word only from its own server', () => {
      ttsRepository.upsertDictionaryEntry('g1', 'w', 'わら', 'u1');
      ttsRepository.upsertDictionaryEntry('g2', 'w', 'わら', 'u1');

      expect(ttsRepository.removeDictionaryEntry('g1', 'w')).toBe(true);
      expect(ttsRepository.removeDictionaryEntry('g1', 'w')).toBe(false);
      expect(ttsRepository.getDictionaryEntry('g1', 'w')).toBeNull();
      expect(ttsRepository.getDictionaryEntry('g2', 'w')).not.toBeNull();
    });

    it('list degrades to empty on a database failure', () => {
      db.exec('DROP TABLE tts_dictionary');

      expect(ttsRepository.listDictionary('g1')).toEqual([]);
      expect(logger.debug).toHaveBeenCalledWith(
        expect.stringContaining('Failed to read TTS dictionary for g1')
      );
    });

    it('count and writes surface a database failure to the caller', () => {
      db.exec('DROP TABLE tts_dictionary');

      expect(() => ttsRepository.countDictionary('g1')).toThrow();
      expect(() => ttsRepository.getDictionaryEntry('g1', 'w')).toThrow();
      expect(() =>
        ttsRepository.upsertDictionaryEntry('g1', 'w', 'わら', 'u1')
      ).toThrow();
      expect(() => ttsRepository.removeDictionaryEntry('g1', 'w')).toThrow();
    });
  });
});
