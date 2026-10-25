import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Caption consent runs against real SQLite: what matters is that "yes" is
 * scoped to one server, that withdrawing removes it, and that a read the
 * database cannot answer never counts as "yes".
 */
const db = new Database(':memory:');

vi.mock('../../../infrastructure/database/connection.js', () => ({
  database: db,
}));

vi.mock('../../../shared/utils/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
  getErrorMessage: (e: unknown) => String(e),
}));

const { captionConsentRepository: consent } =
  await import('../repositories/captionConsentRepository.js');
const { up: consentTable } =
  await import('../../../infrastructure/database/migrations/013_caption_consent.js');

beforeEach(() => {
  db.exec('DROP TABLE IF EXISTS caption_consent');
  consentTable();
  consent.clearCache();
});

describe('013_caption_consent migration', () => {
  it('can run twice', () => {
    expect(() => consentTable()).not.toThrow();
  });
});

describe('captionConsentRepository', () => {
  it('says no until the member says yes', () => {
    expect(consent.hasConsented('g1', 'u1')).toBe(false);

    expect(consent.setConsent('g1', 'u1', true)).toBe(true);

    expect(consent.hasConsented('g1', 'u1')).toBe(true);
  });

  it('keeps an answer to its own server', () => {
    consent.setConsent('g1', 'u1', true);

    expect(consent.hasConsented('g2', 'u1')).toBe(false);
    expect(consent.hasConsented('g1', 'u2')).toBe(false);
  });

  it('reports whether a write changed anything', () => {
    expect(consent.setConsent('g1', 'u1', false)).toBe(false);
    expect(consent.setConsent('g1', 'u1', true)).toBe(true);
    expect(consent.setConsent('g1', 'u1', true)).toBe(false);
    expect(consent.setConsent('g1', 'u1', false)).toBe(true);
  });

  it('deletes the row when consent is withdrawn', () => {
    consent.setConsent('g1', 'u1', true);
    consent.setConsent('g1', 'u1', false);

    expect(consent.hasConsented('g1', 'u1')).toBe(false);
    expect(
      db.prepare('SELECT COUNT(*) AS n FROM caption_consent').get()
    ).toEqual({ n: 0 });
  });

  it('keeps the first consent time when asked again', () => {
    vi.useFakeTimers({ now: 1_000 });
    try {
      consent.setConsent('g1', 'u1', true);
      vi.setSystemTime(2_000);
      consent.setConsent('g1', 'u1', true);
    } finally {
      vi.useRealTimers();
    }

    expect(
      db.prepare('SELECT consented_at FROM caption_consent').get()
    ).toEqual({ consented_at: 1_000 });
  });

  it('answers from memory after the first read', () => {
    consent.setConsent('g1', 'u1', true);
    db.exec('DELETE FROM caption_consent');

    expect(consent.hasConsented('g1', 'u1')).toBe(true);
    consent.clearCache();
    expect(consent.hasConsented('g1', 'u1')).toBe(false);
  });

  it('treats a read the database cannot answer as no, and asks again next time', () => {
    db.exec('DROP TABLE caption_consent');
    expect(consent.hasConsented('g1', 'u1')).toBe(false);

    consentTable();
    db.prepare(
      'INSERT INTO caption_consent (guild_id, user_id, consented_at) VALUES (?, ?, ?)'
    ).run('g1', 'u1', 0);
    expect(consent.hasConsented('g1', 'u1')).toBe(true);
  });
});
