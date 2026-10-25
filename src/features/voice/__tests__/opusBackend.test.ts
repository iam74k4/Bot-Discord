import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The startup log of which Opus module prism-media loaded. prism loads it
 * lazily with the first stream, so the log opens and closes a throwaway
 * decoder when nothing is loaded yet. The module keeps a "logged" flag, so
 * each test imports a fresh copy.
 */

const prismState = vi.hoisted(() => ({
  /** What `Decoder.type` reports; prism sets it when it loads a module. */
  loaded: undefined as string | undefined,
  /** The module the loader would pick, or null when none is installed. */
  available: 'opusscript' as string | null,
  created: 0,
  destroyed: 0,
}));

vi.mock('prism-media', () => ({
  default: {
    opus: {
      Decoder: class {
        static get type() {
          return prismState.loaded;
        }
        constructor() {
          if (!prismState.available) {
            throw new Error('Could not find an Opus module!');
          }
          prismState.loaded = prismState.available;
          prismState.created++;
        }
        destroy() {
          prismState.destroyed++;
        }
      },
    },
  },
}));

vi.mock('../../../shared/utils/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
  getErrorMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)),
}));

async function load() {
  vi.resetModules();
  const { logger } = await import('../../../shared/utils/logger.js');
  const { logOpusBackend } = await import('../recording/connectionManager.js');
  return { logger, logOpusBackend };
}

describe('logOpusBackend', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismState.loaded = undefined;
    prismState.available = 'opusscript';
    prismState.created = 0;
    prismState.destroyed = 0;
  });

  it('loads the module with a throwaway decoder and names it, once', async () => {
    const { logger, logOpusBackend } = await load();

    logOpusBackend();
    logOpusBackend();

    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith(
      'Opus decoder backend: opusscript'
    );
    // The probe decoder is closed again, so it holds no opusscript slot.
    expect(prismState.created).toBe(1);
    expect(prismState.destroyed).toBe(1);
  });

  it('names the native module without probing when it is already loaded', async () => {
    prismState.loaded = '@discordjs/opus';
    const { logger, logOpusBackend } = await load();

    logOpusBackend();

    expect(logger.info).toHaveBeenCalledWith(
      'Opus decoder backend: @discordjs/opus'
    );
    expect(prismState.created).toBe(0);
  });

  it('warns instead of throwing when no Opus module is installed', async () => {
    prismState.available = null;
    const { logger, logOpusBackend } = await load();

    expect(() => logOpusBackend()).not.toThrow();

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('No Opus module could be loaded')
    );
    expect(logger.info).not.toHaveBeenCalled();
  });
});
