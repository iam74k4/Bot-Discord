import { describe, expect, it } from 'vitest';
import { parseConfig, type EnvSource } from '../schema.js';

/**
 * VOICEVOX_URL turns text-to-speech (and the Message Content intent) on, so
 * a malformed value must fail at startup rather than at the first `/tts`.
 */
function source(overrides: EnvSource = {}): EnvSource {
  return {
    DISCORD_TOKEN: 'test-token',
    DISCORD_CLIENT_ID: '123456789012345678',
    BOT_OWNER_IDS: '123456789012345678',
    NODE_ENV: 'development',
    ...overrides,
  };
}

const voicevoxUrl = (value: string | undefined) =>
  parseConfig(source({ VOICEVOX_URL: value })).config.VOICEVOX_URL;

describe('VOICEVOX_URL', () => {
  it.each([
    ['unset', undefined],
    ['empty', ''],
    ['whitespace only', '   '],
  ])('disables text-to-speech when %s', (_label, value) => {
    expect(voicevoxUrl(value)).toBe('');
  });

  it('keeps a plain http URL for private networking', () => {
    expect(voicevoxUrl('http://voicevox.railway.internal:50021')).toBe(
      'http://voicevox.railway.internal:50021'
    );
  });

  it('keeps an https URL with a path', () => {
    expect(voicevoxUrl('https://tts.example.com/engine')).toBe(
      'https://tts.example.com/engine'
    );
  });

  it.each([
    ['one trailing slash', 'http://localhost:50021/', 'http://localhost:50021'],
    [
      'several trailing slashes',
      'https://tts.example.com/engine///',
      'https://tts.example.com/engine',
    ],
    [
      'surrounding whitespace',
      '  http://localhost:50021/ ',
      'http://localhost:50021',
    ],
  ])('strips %s', (_label, value, expected) => {
    expect(voicevoxUrl(value)).toBe(expected);
  });

  it.each(['not a url', 'http://', 'http://exa mple.com', '://missing-scheme'])(
    'rejects %j as invalid',
    (value) => {
      expect(() => voicevoxUrl(value)).toThrow(
        'VOICEVOX_URL is not a valid URL'
      );
    }
  );

  it.each([
    'ftp://voicevox.local',
    'ws://voicevox.local:50021',
    'file:///tmp/x',
  ])('rejects the non-http protocol of %j', (value) => {
    expect(() => voicevoxUrl(value)).toThrow(
      'VOICEVOX_URL must use http or https'
    );
  });

  it('rejects a scheme-less host:port (it parses with scheme "localhost:")', () => {
    expect(() => voicevoxUrl('localhost:50021')).toThrow(
      'VOICEVOX_URL must use http or https'
    );
  });

  it('adds no warnings for a valid value', () => {
    const { warnings } = parseConfig(
      source({ VOICEVOX_URL: 'http://localhost:50021' })
    );
    expect(warnings.join(' ')).not.toContain('VOICEVOX');
  });
});
