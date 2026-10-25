import { describe, expect, it } from 'vitest';
import { parseConfig, type EnvSource } from '../schema.js';

/**
 * WHISPER_URL turns captions on. A malformed URL or language must fail at
 * startup rather than at the first `/caption start`: a wrong language hint
 * makes Whisper translate instead of transcribe, silently.
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

const config = (overrides: EnvSource) => parseConfig(source(overrides)).config;

describe('WHISPER_URL', () => {
  it.each([
    ['unset', undefined],
    ['empty', ''],
    ['whitespace only', '   '],
  ])('disables captions when %s', (_label, value) => {
    expect(config({ WHISPER_URL: value }).WHISPER_URL).toBe('');
  });

  it('keeps a plain http URL for private networking, without a trailing slash', () => {
    expect(
      config({ WHISPER_URL: 'http://whisper.railway.internal:8000/' })
        .WHISPER_URL
    ).toBe('http://whisper.railway.internal:8000');
  });

  it('rejects something that is not a URL', () => {
    expect(() => config({ WHISPER_URL: 'not a url' })).toThrow(
      'WHISPER_URL is not a valid URL'
    );
  });

  it('rejects a scheme other than http or https', () => {
    expect(() => config({ WHISPER_URL: 'ftp://whisper.local' })).toThrow(
      'WHISPER_URL must use http or https'
    );
  });
});

describe('WHISPER_LANGUAGE', () => {
  it('defaults to Japanese', () => {
    expect(config({}).WHISPER_LANGUAGE).toBe('ja');
  });

  it('accepts a language code in any case', () => {
    expect(config({ WHISPER_LANGUAGE: ' EN ' }).WHISPER_LANGUAGE).toBe('en');
  });

  it('turns `auto` into no hint, so Whisper detects the language', () => {
    expect(config({ WHISPER_LANGUAGE: 'auto' }).WHISPER_LANGUAGE).toBe('');
  });

  it.each(['japanese', 'ja-JP', '日本語'])('rejects %s', (value) => {
    expect(() => config({ WHISPER_LANGUAGE: value })).toThrow(
      'WHISPER_LANGUAGE must be a language code'
    );
  });
});

describe('WHISPER_MODEL', () => {
  it('is empty unless set, and trimmed', () => {
    expect(config({}).WHISPER_MODEL).toBe('');
    expect(
      config({ WHISPER_MODEL: ' Systran/faster-whisper-small ' }).WHISPER_MODEL
    ).toBe('Systran/faster-whisper-small');
  });
});
