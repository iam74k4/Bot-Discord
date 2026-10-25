import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DEFAULT_LOCALE } from '../types.js';

const getLanguage = vi.fn();

vi.mock('../../infrastructure/guildSettings/index.js', () => ({
  guildSettingsRepository: {
    getLanguage: (guildId: string) => getLanguage(guildId),
  },
}));

const {
  DEFAULT_BACKGROUND_LOCALE,
  LANGUAGE_AUTO,
  getGuildLanguage,
  resolveBackgroundLocale,
  resolveGuildLocale,
  resolveLocale,
} = await import('../guildLocale.js');

describe('getGuildLanguage', () => {
  beforeEach(() => {
    getLanguage.mockReset();
  });

  it('returns the configured language', () => {
    getLanguage.mockReturnValue('en');
    expect(getGuildLanguage('g1')).toBe('en');
  });

  it('returns null when the guild follows the viewer (NULL)', () => {
    getLanguage.mockReturnValue(null);
    expect(getGuildLanguage('g1')).toBeNull();
  });

  it('returns null when the guild has no settings row', () => {
    getLanguage.mockReturnValue(null);
    expect(getGuildLanguage('g1')).toBeNull();
  });

  it('ignores an unsupported stored language', () => {
    getLanguage.mockReturnValue('ko');
    expect(getGuildLanguage('g1')).toBeNull();
  });

  it('returns null without querying for DM interactions', () => {
    expect(getGuildLanguage(null)).toBeNull();
    expect(getLanguage).not.toHaveBeenCalled();
  });
});

describe('resolveGuildLocale', () => {
  beforeEach(() => {
    getLanguage.mockReset();
  });

  it('prefers the guild setting over the fallback', () => {
    getLanguage.mockReturnValue('en');
    expect(resolveGuildLocale('g1', 'ja')).toBe('en');
  });

  it('uses the fallback when the guild is on automatic', () => {
    getLanguage.mockReturnValue(null);
    expect(resolveGuildLocale('g1', 'en')).toBe('en');
  });
});

describe('resolveLocale', () => {
  beforeEach(() => {
    getLanguage.mockReset();
  });

  it('answers in the guild language even for a differently-configured user', () => {
    getLanguage.mockReturnValue('en');
    expect(resolveLocale({ guildId: 'g1', locale: 'ja' })).toBe('en');
  });

  it('falls back to the user locale on automatic', () => {
    getLanguage.mockReturnValue(null);
    expect(resolveLocale({ guildId: 'g1', locale: 'en-US' })).toBe('en');
  });

  it('uses the user locale in DMs', () => {
    expect(resolveLocale({ guildId: null, locale: 'en-GB' })).toBe('en');
    expect(getLanguage).not.toHaveBeenCalled();
  });

  it('falls back to DEFAULT_LOCALE for unsupported user locales', () => {
    getLanguage.mockReturnValue(null);
    expect(resolveLocale({ guildId: 'g1', locale: 'fr' })).toBe(DEFAULT_LOCALE);
  });

  it('exposes the automatic sentinel used by the settings command', () => {
    expect(LANGUAGE_AUTO).toBe('auto');
  });
});

describe('resolveBackgroundLocale', () => {
  const COMMUNITY = ['COMMUNITY', 'NEWS'];

  beforeEach(() => {
    getLanguage.mockReset();
    getLanguage.mockReturnValue(null);
  });

  it('uses the language the guild chose, whatever Discord says', () => {
    getLanguage.mockReturnValue('en');
    expect(
      resolveBackgroundLocale({
        id: 'g1',
        preferredLocale: 'ja',
        features: COMMUNITY,
      })
    ).toBe('en');
    expect(getLanguage).toHaveBeenCalledWith('g1');
  });

  it('follows the server language on a Community server set to auto', () => {
    expect(
      resolveBackgroundLocale({
        id: 'g1',
        preferredLocale: 'en-GB',
        features: COMMUNITY,
      })
    ).toBe('en');
    expect(
      resolveBackgroundLocale({
        id: 'g1',
        preferredLocale: 'ja',
        features: COMMUNITY,
      })
    ).toBe('ja');
  });

  it.each([
    ['no features', []],
    ['features missing', undefined],
    ['other features only', ['NEWS', 'ANIMATED_ICON']],
  ])(
    'ignores the stuck en-US default on a non-Community server (%s)',
    (_label, features) => {
      expect(
        resolveBackgroundLocale({
          id: 'g1',
          preferredLocale: 'en-US',
          features,
        })
      ).toBe('ja');
    }
  );

  it('falls back to Japanese, not the viewer default, when nothing is known', () => {
    expect(DEFAULT_BACKGROUND_LOCALE).toBe('ja');
    expect(DEFAULT_BACKGROUND_LOCALE).not.toBe(DEFAULT_LOCALE);
    expect(resolveBackgroundLocale({ id: 'g1', features: COMMUNITY })).toBe(
      'ja'
    );
    expect(resolveBackgroundLocale(null)).toBe('ja');
    expect(getLanguage).toHaveBeenCalledTimes(1);
  });

  it('ignores an unsupported stored language', () => {
    getLanguage.mockReturnValue('ko');
    expect(
      resolveBackgroundLocale({ id: 'g1', preferredLocale: 'en-US' })
    ).toBe('ja');
  });
});
