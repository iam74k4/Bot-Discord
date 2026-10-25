import { describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import {
  COMPILE_CACHE_DIR,
  enableCompileCache,
  flushCompileCache,
  type CompileCacheApi,
} from '../compileCache.js';

vi.mock('../../shared/utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  getErrorMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)),
}));

function api(directory?: string) {
  let active = directory;
  return {
    getCompileCacheDir: vi.fn(() => active),
    enableCompileCache: vi.fn((dir?: unknown) => {
      active = String(dir);
      return { status: 1, directory: active };
    }),
    flushCompileCache: vi.fn(),
  } satisfies CompileCacheApi;
}

describe('enableCompileCache', () => {
  it('turns the cache on inside the data directory', () => {
    const fake = api();

    expect(enableCompileCache('data/', fake as never)).toBe(
      join('data/', COMPILE_CACHE_DIR)
    );
    expect(fake.enableCompileCache).toHaveBeenCalledWith(
      join('data/', COMPILE_CACHE_DIR)
    );
  });

  it('keeps a cache NODE_COMPILE_CACHE already turned on', () => {
    const fake = api('/app/cache');

    expect(enableCompileCache('data/', fake as never)).toBe('/app/cache');
    expect(fake.enableCompileCache).not.toHaveBeenCalled();
  });

  it('degrades quietly where the API is missing or fails', () => {
    expect(enableCompileCache('data/', {})).toBeUndefined();
    expect(
      enableCompileCache('data/', {
        getCompileCacheDir: () => undefined,
        enableCompileCache: () => {
          throw new Error('EACCES');
        },
      } as never)
    ).toBeUndefined();
  });
});

describe('flushCompileCache', () => {
  it('writes the cache out when it is on', () => {
    const fake = api('/app/cache');

    flushCompileCache(fake as never);

    expect(fake.flushCompileCache).toHaveBeenCalledTimes(1);
  });

  it('does nothing when the cache is off', () => {
    const fake = api();

    flushCompileCache(fake as never);

    expect(fake.flushCompileCache).not.toHaveBeenCalled();
  });

  it('swallows a failed flush: startup must not fail over a cache', () => {
    const fake = api('/app/cache');
    fake.flushCompileCache.mockImplementation(() => {
      throw new Error('ENOSPC');
    });

    expect(() => flushCompileCache(fake as never)).not.toThrow();
    expect(() => flushCompileCache({})).not.toThrow();
  });

  it('works against the real node:module', () => {
    expect(() => flushCompileCache()).not.toThrow();
  });
});
