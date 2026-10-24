import { describe, it, expect, vi } from 'vitest';
import type { Client } from 'discord.js';

vi.mock('../../database/connection.js', () => ({
  getTableCount: vi.fn().mockReturnValue(5),
}));

import {
  setServiceStatus,
  getHealthStatus,
  formatHealthStatus,
  type HealthStatus,
} from '../index.js';
import { getTableCount } from '../../database/connection.js';

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
  describe('setServiceStatus', () => {
    it('updates service tracking and getHealthStatus reflects it', () => {
      setServiceStatus('testService', true);
      const health = getHealthStatus(createMockClient());
      expect(health.services).toHaveProperty('testService', true);

      setServiceStatus('testService', false);
      const healthAfter = getHealthStatus(createMockClient());
      expect(healthAfter.services).toHaveProperty('testService', false);
    });

    it('tracks multiple services independently', () => {
      setServiceStatus('voice', true);
      setServiceStatus('notification', false);
      const health = getHealthStatus(createMockClient());

      expect(health.services).toHaveProperty('voice', true);
      expect(health.services).toHaveProperty('notification', false);
    });
  });

  describe('getHealthStatus', () => {
    it('returns proper structure with all fields', () => {
      const mockClient = createMockClient();
      const health = getHealthStatus(mockClient);

      expect(health).toMatchObject({
        status: expect.any(String),
        uptime: expect.any(Number),
        memory: {
          used: expect.any(Number),
          total: expect.any(Number),
          percentage: expect.any(Number),
          rss: expect.any(Number),
        },
        database: {
          connected: true,
          tables: 5,
        },
        discord: {
          connected: true,
          ping: 50,
        },
        services: expect.any(Object),
        timestamp: expect.any(Number),
      });

      expect(['healthy', 'degraded', 'unhealthy']).toContain(health.status);
      expect(health.uptime).toBeGreaterThanOrEqual(0);
      expect(health.memory.percentage).toBeGreaterThanOrEqual(0);
      expect(health.memory.percentage).toBeLessThanOrEqual(100);
      expect(health.timestamp).toBeGreaterThan(0);
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
      const formatted = formatHealthStatus(baseHealth);

      expect(formatted).toContain('**Status:**');
      expect(formatted).toContain('**Uptime:**');
      expect(formatted).toContain('**Memory**');
      expect(formatted).toContain('**Discord**');
      expect(formatted).toContain('**Database**');
      expect(formatted).toContain('**Services**');
    });

    it('includes status emoji for healthy', () => {
      const formatted = formatHealthStatus({
        ...baseHealth,
        status: 'healthy',
      });
      expect(formatted).toContain('🟢');
      expect(formatted).toContain('HEALTHY');
    });

    it('includes status emoji for degraded', () => {
      const formatted = formatHealthStatus({
        ...baseHealth,
        status: 'degraded',
      });
      expect(formatted).toContain('🟡');
      expect(formatted).toContain('DEGRADED');
    });

    it('includes status emoji for unhealthy', () => {
      const formatted = formatHealthStatus({
        ...baseHealth,
        status: 'unhealthy',
      });
      expect(formatted).toContain('🔴');
      expect(formatted).toContain('UNHEALTHY');
    });

    it('formats uptime as days, hours, minutes', () => {
      const formatted = formatHealthStatus({
        ...baseHealth,
        uptime: 90061, // 1d 1h 1m 1s
      });
      expect(formatted).toContain('1d 1h 1m');
    });

    it('formats memory section with heap figures and RSS', () => {
      const formatted = formatHealthStatus(baseHealth);
      expect(formatted).toContain('Heap used: 50 MB');
      expect(formatted).toContain('Heap total: 128 MB');
      expect(formatted).toContain('Heap usage: 39%');
      // RSS is the figure that reflects the voice mix buffers.
      expect(formatted).toContain('RSS: 260 MB');
    });

    it('formats Discord section with connection status and ping', () => {
      const formatted = formatHealthStatus(baseHealth);
      expect(formatted).toContain('Connected: ✅');
      expect(formatted).toContain('Ping: 50ms');
    });

    it('formats Database section with connection status and tables', () => {
      const formatted = formatHealthStatus(baseHealth);
      expect(formatted).toContain('Connected: ✅');
      expect(formatted).toContain('Tables: 5');
    });

    it('shows "No tracked services" when services object is empty', () => {
      const formatted = formatHealthStatus(baseHealth);
      expect(formatted).toContain('└ No tracked services');
    });

    it('formats tracked services with labels and status', () => {
      const formatted = formatHealthStatus({
        ...baseHealth,
        services: { voiceManager: true, notificationService: false },
      });
      expect(formatted).toContain('Voice Manager: ✅');
      expect(formatted).toContain('Notification Service: ❌');
    });
  });

  describe('determineStatus logic (via getHealthStatus)', () => {
    it('returns healthy when all OK (discord connected, db connected, low memory, low ping)', () => {
      const mockClient = createMockClient({ isReady: true, ping: 50 });
      const health = getHealthStatus(mockClient);

      expect(health.status).toBe('healthy');
      expect(health.database.connected).toBe(true);
      expect(health.discord.connected).toBe(true);
    });

    it('returns unhealthy when Discord is disconnected', () => {
      const mockClient = createMockClient({ isReady: false, ping: 50 });
      const health = getHealthStatus(mockClient);

      expect(health.status).toBe('unhealthy');
      expect(health.discord.connected).toBe(false);
    });

    it('returns degraded when ping is high (> 500)', () => {
      const mockClient = createMockClient({ isReady: true, ping: 501 });
      const health = getHealthStatus(mockClient);

      expect(health.status).toBe('degraded');
      expect(health.discord.ping).toBe(501);
    });

    it('returns degraded when ping is exactly 500 (boundary: > 500)', () => {
      const mockClient = createMockClient({ isReady: true, ping: 500 });
      const health = getHealthStatus(mockClient);

      expect(health.status).toBe('healthy');
    });

    it('returns unhealthy when database throws', () => {
      vi.mocked(getTableCount).mockImplementationOnce(() => {
        throw new Error('DB connection failed');
      });

      const mockClient = createMockClient();
      const health = getHealthStatus(mockClient);

      expect(health.database.connected).toBe(false);
      expect(health.database.tables).toBe(0);
      expect(health.status).toBe('unhealthy');
    });

    it('returns degraded when memory percentage > 90%', () => {
      const memoryUsage = vi.spyOn(process, 'memoryUsage').mockReturnValue({
        heapUsed: 950 * 1024 * 1024,
        heapTotal: 1000 * 1024 * 1024,
        rss: 0,
        external: 0,
        arrayBuffers: 0,
      });

      try {
        const mockClient = createMockClient({ isReady: true, ping: 50 });
        const health = getHealthStatus(mockClient);

        expect(health.memory.percentage).toBeGreaterThan(90);
        expect(health.status).toBe('degraded');
      } finally {
        memoryUsage.mockRestore();
      }
    });
  });
});
