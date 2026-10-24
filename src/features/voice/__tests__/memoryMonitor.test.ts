import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const disconnectOldest = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const getAllConnections = vi.hoisted(() => vi.fn());
const getTotalMixBufferSizeMB = vi.hoisted(() => vi.fn().mockReturnValue(86));
/**
 * `sendAlert` is split in two on purpose. `calls` records the arguments but
 * returns nothing; `result` is a plain function that builds the promise the
 * monitor gets back. A vi.fn returning the promise itself would subscribe to
 * it to track results, which marks a rejection as handled and hides a missing
 * `.catch` in the monitor.
 */
const alert = vi.hoisted(() => ({
  calls: vi.fn(),
  result: (): Promise<void> => Promise.resolve(),
}));
const sendAlert = alert.calls;
const logger = vi.hoisted(() => ({
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
}));

vi.mock('../recording/connectionManager.js', () => ({
  connectionManager: { disconnectOldest, getAllConnections },
}));

vi.mock('../recording/channelMixRing.js', () => ({
  channelMixRingManager: { getTotalMixBufferSizeMB },
}));

vi.mock('../../../shared/utils/alert.js', () => ({
  sendAlert: (...args: unknown[]) => {
    alert.calls(...args);
    return alert.result();
  },
}));

vi.mock('../../../shared/utils/logger.js', () => ({
  logger,
  getErrorMessage: (e: unknown) => String(e),
}));

vi.mock('../../../config/index.js', () => ({
  MONITORING: { MEMORY_MONITOR_INTERVAL_MS: 60_000 },
}));

const { MemoryMonitor } = await import('../jobs/memoryMonitor.js');

/** The monitor is built from what it is handed, not from ambient config. */
const config = { MEMORY_LIMIT_MB: 1000 };
const INTERVAL = 60_000;

/** Fake three connected channels so shedding has something to drop. */
function connections(count: number) {
  return new Map(
    Array.from({ length: count }, (_, i) => [`channel-${i}`, { channelId: i }])
  );
}

function mockMemory(rssMB: number) {
  vi.spyOn(process, 'memoryUsage').mockReturnValue({
    rss: rssMB * 1024 * 1024,
    heapUsed: 40 * 1024 * 1024,
    heapTotal: 60 * 1024 * 1024,
    external: 0,
    arrayBuffers: 0,
  } as NodeJS.MemoryUsage);
}

/**
 * Run one memory check now. The only place that reaches into the private
 * method, so renaming it touches one line; scheduling itself is covered
 * through start() and fake timers below.
 */
function check(monitor: InstanceType<typeof MemoryMonitor>): Promise<void> {
  return monitor['checkMemoryUsage']();
}

describe('MemoryMonitor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getAllConnections.mockReturnValue(connections(3));
    getTotalMixBufferSizeMB.mockReturnValue(86);
    alert.result = () => Promise.resolve();
    disconnectOldest.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('reports RSS, because mix rings live outside the V8 heap', async () => {
    mockMemory(700);
    const stats = await new MemoryMonitor(config).getStats();

    expect(stats.memoryUsageMB).toBeCloseTo(700);
    expect(stats.heapUsedMB).toBeCloseTo(40);
    expect(stats.limitMB).toBe(1000);
    expect(stats.totalBufferSizeMB).toBe(86);
    expect(stats.activeConnections).toBe(3);
  });

  it('sheds the oldest connections once RSS passes the critical ratio', async () => {
    mockMemory(900); // 90% of the 1000MB budget
    const monitor = new MemoryMonitor(config);

    await check(monitor);

    expect(sendAlert).toHaveBeenCalled();
    expect(disconnectOldest).toHaveBeenCalledWith(1);
  });

  it('warns without disconnecting between the warning and critical ratios', async () => {
    mockMemory(750); // 75%: above warn (70%), below critical (85%)
    const monitor = new MemoryMonitor(config);

    await check(monitor);

    expect(disconnectOldest).not.toHaveBeenCalled();
    expect(sendAlert).not.toHaveBeenCalled();
  });

  it('leaves connections alone below the warning ratio', async () => {
    mockMemory(300);
    const monitor = new MemoryMonitor(config);

    await check(monitor);

    expect(disconnectOldest).not.toHaveBeenCalled();
  });

  it('does not shed twice while a slow check is still running', async () => {
    mockMemory(950);
    let release: (() => void) | undefined;
    disconnectOldest.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        })
    );

    const monitor = new MemoryMonitor(config);
    const first = check(monitor);
    await check(monitor);

    expect(disconnectOldest).toHaveBeenCalledTimes(1);

    release?.();
    await first;
  });

  it('checks again once the slow check has finished', async () => {
    mockMemory(950);
    const monitor = new MemoryMonitor(config);

    await check(monitor);
    await check(monitor);

    expect(disconnectOldest).toHaveBeenCalledTimes(2);
  });

  describe('thresholds', () => {
    it('treats exactly the critical threshold as critical', async () => {
      mockMemory(850); // round(1000 * 0.85)
      await check(new MemoryMonitor(config));

      expect(disconnectOldest).toHaveBeenCalledTimes(1);
    });

    it('treats just under the critical threshold as a warning only', async () => {
      mockMemory(849.9);
      await check(new MemoryMonitor(config));

      expect(disconnectOldest).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Memory warning threshold exceeded')
      );
    });

    it('treats exactly the warning threshold as a warning', async () => {
      mockMemory(700); // round(1000 * 0.7)
      await check(new MemoryMonitor(config));

      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('>= 700MB')
      );
    });

    it('stays silent just under the warning threshold', async () => {
      mockMemory(699.9);
      await check(new MemoryMonitor(config));

      expect(logger.warn).not.toHaveBeenCalled();
      expect(logger.error).not.toHaveBeenCalled();
    });

    it('rounds thresholds derived from an uneven limit', async () => {
      // 333 * 0.85 = 283.05 -> 283
      mockMemory(283);
      await check(new MemoryMonitor({ MEMORY_LIMIT_MB: 333 }));

      expect(disconnectOldest).toHaveBeenCalledTimes(1);
    });
  });

  describe('critical response', () => {
    it('alerts with the context an operator needs', async () => {
      mockMemory(900);
      await check(new MemoryMonitor(config));

      expect(sendAlert).toHaveBeenCalledWith(
        'Critical Memory Threshold Exceeded',
        '900.0MB RSS >= 850MB',
        [
          { name: 'Active Connections', value: '3' },
          { name: 'Mix Buffers (MB)', value: '86.0' },
          { name: 'Heap Used (MB)', value: '40.0' },
        ]
      );
    });

    it('sheds a third of the connections, oldest first', async () => {
      mockMemory(900);
      getAllConnections.mockReturnValue(connections(9));

      await check(new MemoryMonitor(config));

      expect(disconnectOldest).toHaveBeenCalledWith(3);
    });

    it('always sheds at least one connection', async () => {
      mockMemory(900);
      getAllConnections.mockReturnValue(connections(2));

      await check(new MemoryMonitor(config));

      expect(disconnectOldest).toHaveBeenCalledWith(1);
    });

    // Counts where rounding up and rounding down disagree: shedding more than
    // a third would cut off people the monitor did not need to drop.
    it.each([
      [4, 1],
      [5, 1],
      [7, 2],
      [8, 2],
    ])(
      'rounds a third of %i connections down to %i',
      async (count, expected) => {
        mockMemory(900);
        getAllConnections.mockReturnValue(connections(count));

        await check(new MemoryMonitor(config));

        expect(disconnectOldest).toHaveBeenCalledWith(expected);
      }
    );

    it('alerts but has nothing to shed with no connections', async () => {
      mockMemory(900);
      getAllConnections.mockReturnValue(connections(0));

      await check(new MemoryMonitor(config));

      expect(sendAlert).toHaveBeenCalled();
      expect(disconnectOldest).not.toHaveBeenCalled();
    });

    it('still sheds when the alert webhook fails', async () => {
      mockMemory(900);
      alert.result = () => Promise.reject(new Error('webhook down'));

      await expect(check(new MemoryMonitor(config))).resolves.toBeUndefined();
      expect(disconnectOldest).toHaveBeenCalledWith(1);
    });

    it('swallows a failed alert instead of leaving an unhandled rejection', async () => {
      // An unhandled rejection can take the whole bot process down.
      mockMemory(900);
      alert.result = () => Promise.reject(new Error('webhook down'));
      const unhandled: unknown[] = [];
      const onUnhandled = (reason: unknown) => unhandled.push(reason);
      process.on('unhandledRejection', onUnhandled);

      try {
        await check(new MemoryMonitor(config));
        // Node reports unhandled rejections once the microtask queue drains.
        await new Promise((resolve) => setImmediate(resolve));
      } finally {
        process.off('unhandledRejection', onUnhandled);
      }

      expect(sendAlert).toHaveBeenCalledTimes(1);
      expect(unhandled).toEqual([]);
    });
  });

  describe('scheduling', () => {
    it('checks on every interval tick after start', async () => {
      vi.useFakeTimers();
      mockMemory(900);
      const monitor = new MemoryMonitor(config);

      monitor.start();
      expect(disconnectOldest).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(INTERVAL);
      expect(disconnectOldest).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(INTERVAL);
      expect(disconnectOldest).toHaveBeenCalledTimes(2);

      monitor.stop();
    });

    it('stops checking after stop', async () => {
      vi.useFakeTimers();
      mockMemory(900);
      const monitor = new MemoryMonitor(config);

      monitor.start();
      monitor.stop();
      await vi.advanceTimersByTimeAsync(INTERVAL * 3);

      expect(disconnectOldest).not.toHaveBeenCalled();
      expect(logger.info).toHaveBeenCalledWith('Memory monitor stopped');
    });

    it('refuses to start a second timer', async () => {
      vi.useFakeTimers();
      mockMemory(900);
      const monitor = new MemoryMonitor(config);

      monitor.start();
      monitor.start();
      await vi.advanceTimersByTimeAsync(INTERVAL);

      expect(logger.warn).toHaveBeenCalledWith(
        'Memory monitor is already running'
      );
      expect(disconnectOldest).toHaveBeenCalledTimes(1);

      monitor.stop();
    });

    it('logs the limit and thresholds it was configured with', () => {
      vi.useFakeTimers();
      const monitor = new MemoryMonitor(config);

      monitor.start();

      expect(logger.info).toHaveBeenCalledWith(
        expect.stringMatching(/limit 1000MB.*700MB.*850MB RSS/)
      );
      monitor.stop();
    });

    it('treats stop without start as a no-op', () => {
      const monitor = new MemoryMonitor(config);

      expect(() => monitor.stop()).not.toThrow();
      expect(logger.info).not.toHaveBeenCalled();
    });

    it('can be restarted after being stopped', async () => {
      vi.useFakeTimers();
      mockMemory(900);
      const monitor = new MemoryMonitor(config);

      monitor.start();
      monitor.stop();
      monitor.start();
      await vi.advanceTimersByTimeAsync(INTERVAL);

      expect(disconnectOldest).toHaveBeenCalledTimes(1);
      monitor.stop();
    });
  });
});
