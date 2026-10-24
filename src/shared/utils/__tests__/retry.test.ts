import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { withRetry, createRetryWrapper } from '../retry.js';

vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
  getErrorMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)),
}));

describe('retry utility', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  describe('withRetry', () => {
    it('should return result on first successful attempt', async () => {
      const fn = vi.fn().mockResolvedValue('success');

      const result = await withRetry(fn);

      expect(result).toBe('success');
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('should retry on failure and succeed', async () => {
      const fn = vi
        .fn()
        .mockRejectedValueOnce(new Error('network error'))
        .mockResolvedValue('success');

      const resultPromise = withRetry(fn, {
        maxRetries: 3,
        baseDelayMs: 100,
        operationName: 'test',
      });

      await vi.advanceTimersByTimeAsync(200);

      const result = await resultPromise;

      expect(result).toBe('success');
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it('should throw after max retries exceeded', async () => {
      const error = new Error('network error');
      const fn = vi.fn().mockRejectedValue(error);

      const resultPromise = withRetry(fn, {
        maxRetries: 2,
        baseDelayMs: 100,
        shouldRetry: () => true,
      });
      // Attach the expectation before advancing time so the rejection is
      // never unhandled.
      const rejection = expect(resultPromise).rejects.toBe(error);

      await vi.advanceTimersByTimeAsync(1000);
      await rejection;

      await expect(resultPromise).rejects.toThrow('network error');
      expect(fn).toHaveBeenCalledTimes(3);
    });

    it('should not retry when shouldRetry returns false', async () => {
      const error = new Error('400 Bad Request');
      const fn = vi.fn().mockRejectedValue(error);

      await expect(
        withRetry(fn, {
          maxRetries: 3,
          shouldRetry: () => false,
        })
      ).rejects.toThrow('400 Bad Request');

      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('should use default shouldRetry for network errors', async () => {
      const fn = vi
        .fn()
        .mockRejectedValueOnce(new Error('network timeout'))
        .mockResolvedValue('success');

      const resultPromise = withRetry(fn, { baseDelayMs: 100 });

      await vi.advanceTimersByTimeAsync(200);

      const result = await resultPromise;

      expect(result).toBe('success');
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it('should apply exponential backoff', async () => {
      const fn = vi
        .fn()
        .mockRejectedValueOnce(new Error('500'))
        .mockRejectedValueOnce(new Error('500'))
        .mockResolvedValue('success');

      const resultPromise = withRetry(fn, {
        maxRetries: 3,
        baseDelayMs: 1000,
        maxDelayMs: 10000,
      });

      await vi.advanceTimersByTimeAsync(1500);
      expect(fn).toHaveBeenCalledTimes(2);

      await vi.advanceTimersByTimeAsync(3000);
      expect(fn).toHaveBeenCalledTimes(3);

      const result = await resultPromise;
      expect(result).toBe('success');
    });

    it('should cap delay at maxDelayMs', async () => {
      const fn = vi
        .fn()
        .mockRejectedValueOnce(new Error('500'))
        .mockRejectedValueOnce(new Error('500'))
        .mockRejectedValueOnce(new Error('500'))
        .mockResolvedValue('success');

      const resultPromise = withRetry(fn, {
        maxRetries: 5,
        baseDelayMs: 1000,
        maxDelayMs: 3000,
      });

      await vi.advanceTimersByTimeAsync(15000);

      const result = await resultPromise;
      expect(result).toBe('success');
    });
  });

  describe('createRetryWrapper', () => {
    it('should create wrapper with default options', async () => {
      const wrapper = createRetryWrapper({
        maxRetries: 2,
        baseDelayMs: 100,
      });

      const fn = vi.fn().mockResolvedValue('wrapped');

      const result = await wrapper(fn);

      expect(result).toBe('wrapped');
    });

    it('should allow override of default options', async () => {
      const wrapper = createRetryWrapper({
        maxRetries: 1,
        baseDelayMs: 100,
      });

      const fn = vi.fn().mockRejectedValue(new Error('500'));

      const resultPromise = wrapper(fn, {
        maxRetries: 0,
        shouldRetry: () => true,
      });

      await expect(resultPromise).rejects.toThrow('500');
      expect(fn).toHaveBeenCalledTimes(1);
    });
  });
});
