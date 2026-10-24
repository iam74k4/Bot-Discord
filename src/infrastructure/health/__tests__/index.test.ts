import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from 'vitest';
import type { Client } from 'discord.js';
import type { HealthStatus } from '../index.js';

vi.mock('../../database/connection.js', () => ({
  getTableCount: vi.fn().mockReturnValue(5),
}));

const MB = 1024 * 1024;
const NOW = new Date('2026-04-01T00:00:00Z').getTime();

/**
 * Low, fixed heap figures so status checks never depend on where the real V8
 * heap happens to be (it can sit above 90% just before a GC).
 */
const CALM_MEMORY: NodeJS.MemoryUsage = {
  heapUsed: 40 * MB,
  heapTotal: 100 * MB,
  rss: 200 * MB,
  external: 0,
  arrayBuffers: 0,
};

let health: typeof import('../index.js');
let getTableCount: ReturnType<typeof vi.fn>;
let memoryUsage: MockInstance<typeof process.memoryUsage>;

function createMockClient(
  overrides: {
    isReady?: boolean;
    ping?: number;
  } = {}
): Client {
  return {
    isReady: vi.fn().mockReturnValue(overrides.isReady ?? true),
    ws: { ping: overrides.ping ?? 50 },
  } as unknown as Client;
}

describe('health service', () => {
  beforeEach(async () => {
    // A fresh module per test: the tracked-services map is module state.
    vi.resetModules();
    health = await import('../index.js');
    const connection = await import('../../database/connection.js');
    getTableCount = vi.mocked(connection.getTableCount);

    memoryUsage = vi
      .spyOn(process, 'memoryUsage')
      .mockReturnValue({ ...CALM_MEMORY });
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('setServiceStatus', () => {
    it('updates service tracking and getHealthStatus reflects it', () => {
      health.setServiceStatus('testService', true);
      const status = health.getHealthStatus(createMockClient());
      expect(status.services).toEqual({ testService: true });

      health.setServiceStatus('testService', false);
      const statusAfter = health.getHealthStatus(createMockClient());
      expect(statusAfter.services).toEqual({ testService: false });
    });

    it('tracks multiple services independently', () => {
      health.setServiceStatus('voice', true);
      health.setServiceStatus('notification', false);
      const status = health.getHealthStatus(createMockClient());

      expect(status.services).toEqual({ voice: true, notification: false });
    });

    it('reports no services until one registers', () => {
      expect(health.getHealthStatus(createMockClient()).services).toEqual({});
    });

    it('does not let a stopped service change the overall status', () => {
      health.setServiceStatus('voice', false);

      expect(health.getHealthStatus(createMockClient()).status).toBe('healthy');
    });
  });

  describe('getHealthStatus', () => {
    it('reports every figure it gathered', () => {
      vi.spyOn(process, 'uptime').mockReturnValue(1234.5);

      expect(health.getHealthStatus(createMockClient())).toEqual({
        status: 'healthy',
        uptime: 1234.5,
        memory: { used: 40, total: 100, percentage: 40, rss: 200 },
        database: { connected: true, tables: 5 },
        discord: { connected: true, ping: 50 },
        services: {},
        timestamp: NOW,
      });
    });

    it('rounds memory figures to whole megabytes and percent', () => {
      memoryUsage.mockReturnValue({
        ...CALM_MEMORY,
        heapUsed: 33.4 * MB,
        heapTotal: 99.6 * MB,
        rss: 512.5 * MB,
      });

      expect(health.getHealthStatus(createMockClient()).memory).toEqual({
        used: 33,
        total: 100,
        percentage: 33,
        rss: 513,
      });
    });
  });

  describe('formatHealthStatus', () => {
    const baseHealth: HealthStatus = {
      status: 'healthy',
      uptime: 3661, // 1h 1m 1s
      memory: { used: 50, total: 128, percentage: 39, rss: 260 },
      database: { connected: true, tables: 5 },
      discord: { connected: true, ping: 50 },
      services: {},
      timestamp: 1234567890000,
    };

    it('returns formatted string with expected sections', () => {
      const formatted = health.formatHealthStatus(baseHealth);

      expect(formatted).toContain('**Status:**');
      expect(formatted).toContain('**Uptime:**');
      expect(formatted).toContain('**Memory**');
      expect(formatted).toContain('**Discord**');
      expect(formatted).toContain('**Database**');
      expect(formatted).toContain('**Services**');
    });

    it('includes status emoji for healthy', () => {
      const formatted = health.formatHealthStatus({
        ...baseHealth,
        status: 'healthy',
      });
      expect(formatted).toContain('🟢');
      expect(formatted).toContain('HEALTHY');
    });

    it('includes status emoji for degraded', () => {
      const formatted = health.formatHealthStatus({
        ...baseHealth,
        status: 'degraded',
      });
      expect(formatted).toContain('🟡');
      expect(formatted).toContain('DEGRADED');
    });

    it('includes status emoji for unhealthy', () => {
      const formatted = health.formatHealthStatus({
        ...baseHealth,
        status: 'unhealthy',
      });
      expect(formatted).toContain('🔴');
      expect(formatted).toContain('UNHEALTHY');
    });

    it('formats uptime as days, hours, minutes', () => {
      const formatted = health.formatHealthStatus({
        ...baseHealth,
        uptime: 90061, // 1d 1h 1m 1s
      });
      expect(formatted).toContain('1d 1h 1m');
    });

    it('formats an uptime under a day with zero days', () => {
      expect(health.formatHealthStatus(baseHealth)).toContain(
        '**Uptime:** 0d 1h 1m'
      );
    });

    it('formats memory section with heap figures and RSS', () => {
      const formatted = health.formatHealthStatus(baseHealth);
      expect(formatted).toContain('Heap used: 50 MB');
      expect(formatted).toContain('Heap total: 128 MB');
      expect(formatted).toContain('Heap usage: 39%');
      // RSS is the figure that reflects the voice mix buffers.
      expect(formatted).toContain('RSS: 260 MB');
    });

    it('formats Discord section with connection status and ping', () => {
      const formatted = health.formatHealthStatus(baseHealth);
      expect(formatted).toContain('Connected: ✅');
      expect(formatted).toContain('Ping: 50ms');
    });

    it('formats Database section with connection status and tables', () => {
      const formatted = health.formatHealthStatus(baseHealth);
      expect(formatted).toContain('Connected: ✅');
      expect(formatted).toContain('Tables: 5');
    });

    it('marks a disconnected gateway and database with a cross', () => {
      const lines = health
        .formatHealthStatus({
          ...baseHealth,
          status: 'unhealthy',
          discord: { connected: false, ping: -1 },
          database: { connected: false, tables: 0 },
        })
        .split('\n');

      const after = (heading: string) => lines[lines.indexOf(heading) + 1];
      expect(after('**Discord**')).toBe('├ Connected: ❌');
      expect(after('**Database**')).toBe('├ Connected: ❌');
    });

    it('shows "No tracked services" when services object is empty', () => {
      const formatted = health.formatHealthStatus(baseHealth);
      expect(formatted).toContain('└ No tracked services');
    });

    it('formats tracked services with labels and status', () => {
      const formatted = health.formatHealthStatus({
        ...baseHealth,
        services: { voiceManager: true, notificationService: false },
      });
      expect(formatted).toContain('Voice Manager: ✅');
      expect(formatted).toContain('Notification Service: ❌');
    });

    it('lists services alphabetically and closes the tree on the last one', () => {
      const lines = health
        .formatHealthStatus({
          ...baseHealth,
          services: { voiceManager: true, backup: false, audit: true },
        })
        .split('\n');

      expect(lines.slice(lines.indexOf('**Services**') + 1)).toEqual([
        '├ Audit: ✅',
        '├ Backup: ❌',
        '└ Voice Manager: ✅',
      ]);
    });
  });

  describe('determineStatus logic (via getHealthStatus)', () => {
    it('returns healthy when all OK (discord connected, db connected, low memory, low ping)', () => {
      const mockClient = createMockClient({ isReady: true, ping: 50 });
      const status = health.getHealthStatus(mockClient);

      expect(status.status).toBe('healthy');
      expect(status.database.connected).toBe(true);
      expect(status.discord.connected).toBe(true);
    });

    it('returns unhealthy when Discord is disconnected', () => {
      const mockClient = createMockClient({ isReady: false, ping: 50 });
      const status = health.getHealthStatus(mockClient);

      expect(status.status).toBe('unhealthy');
      expect(status.discord.connected).toBe(false);
    });

    it('returns degraded when ping is high (> 500)', () => {
      const mockClient = createMockClient({ isReady: true, ping: 501 });
      const status = health.getHealthStatus(mockClient);

      expect(status.status).toBe('degraded');
      expect(status.discord.ping).toBe(501);
    });

    it('stays healthy when ping is exactly 500 (boundary: > 500)', () => {
      const mockClient = createMockClient({ isReady: true, ping: 500 });
      const status = health.getHealthStatus(mockClient);

      expect(status.status).toBe('healthy');
    });

    it('returns unhealthy when database throws', () => {
      getTableCount.mockImplementationOnce(() => {
        throw new Error('DB connection failed');
      });

      const mockClient = createMockClient();
      const status = health.getHealthStatus(mockClient);

      expect(status.database.connected).toBe(false);
      expect(status.database.tables).toBe(0);
      expect(status.status).toBe('unhealthy');
    });

    it('prefers unhealthy over degraded when a critical service is down', () => {
      memoryUsage.mockReturnValue({
        ...CALM_MEMORY,
        heapUsed: 95 * MB,
        heapTotal: 100 * MB,
      });

      const status = health.getHealthStatus(
        createMockClient({ isReady: false, ping: 900 })
      );

      expect(status.status).toBe('unhealthy');
    });

    it('returns degraded when memory percentage > 90%', () => {
      memoryUsage.mockReturnValue({
        ...CALM_MEMORY,
        heapUsed: 950 * MB,
        heapTotal: 1000 * MB,
      });

      const mockClient = createMockClient({ isReady: true, ping: 50 });
      const status = health.getHealthStatus(mockClient);

      expect(status.memory.percentage).toBe(95);
      expect(status.status).toBe('degraded');
    });

    it('stays healthy when memory percentage is exactly 90% (boundary: > 90)', () => {
      memoryUsage.mockReturnValue({
        ...CALM_MEMORY,
        heapUsed: 90 * MB,
        heapTotal: 100 * MB,
      });

      const status = health.getHealthStatus(createMockClient());

      expect(status.memory.percentage).toBe(90);
      expect(status.status).toBe('healthy');
    });
  });
});
