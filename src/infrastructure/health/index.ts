import type { Client } from 'discord.js';
import { getTableCount } from '../database/connection.js';
import { metrics, type EventLoopStats } from '../metrics/index.js';

/**
 * Health status levels
 */
export type HealthStatusLevel = 'healthy' | 'degraded' | 'unhealthy';

/**
 * Health check result
 */
export interface HealthStatus {
  status: HealthStatusLevel;
  uptime: number;
  memory: {
    used: number;
    total: number;
    percentage: number;
    /** Resident set size in MB; includes off-heap voice mix buffers */
    rss: number;
  };
  database: {
    connected: boolean;
    tables: number;
  };
  discord: {
    connected: boolean;
    ping: number;
  };
  services: Record<string, boolean>;
  /**
   * Main-thread delay and utilization over the current window; null when
   * the monitor is not running. Shown, not used for the status: one long
   * recording export would otherwise flip the bot to "degraded".
   */
  eventLoop?: EventLoopStats | null;
  timestamp: number;
}

// Service status tracking (updated by services themselves)
const serviceStatus = new Map<string, boolean>();

/**
 * Update service status
 */
export function setServiceStatus(service: string, running: boolean): void {
  serviceStatus.set(service, running);
}

/**
 * Check database connection
 */
function checkDatabase(): { connected: boolean; tables: number } {
  try {
    return {
      connected: true,
      tables: getTableCount(),
    };
  } catch {
    return {
      connected: false,
      tables: 0,
    };
  }
}

/**
 * Check memory usage
 */
function checkMemory(): HealthStatus['memory'] {
  const memUsage = process.memoryUsage();
  const used = Math.round(memUsage.heapUsed / 1024 / 1024);
  const total = Math.round(memUsage.heapTotal / 1024 / 1024);
  const percentage = Math.round((used / total) * 100);
  const rss = Math.round(memUsage.rss / 1024 / 1024);

  return { used, total, percentage, rss };
}

/**
 * Determine overall health status
 */
function determineStatus(
  discord: { connected: boolean; ping: number },
  database: { connected: boolean },
  memory: { percentage: number }
): HealthStatusLevel {
  // Unhealthy if critical services are down
  if (!discord.connected || !database.connected) {
    return 'unhealthy';
  }

  // Degraded if memory is high or ping is high
  if (memory.percentage > 90 || discord.ping > 500) {
    return 'degraded';
  }

  return 'healthy';
}

/**
 * Get current health status
 */
export function getHealthStatus(client: Client): HealthStatus {
  const memory = checkMemory();
  const database = checkDatabase();
  const discord = {
    connected: client.isReady(),
    ping: client.ws.ping,
  };

  const status = determineStatus(discord, database, memory);

  return {
    status,
    uptime: process.uptime(),
    memory,
    database,
    discord,
    services: Object.fromEntries(serviceStatus),
    eventLoop: metrics.getEventLoopStats(),
    timestamp: Date.now(),
  };
}

function formatEventLoop(
  eventLoop: EventLoopStats | null | undefined
): string[] {
  if (!eventLoop) return [];
  return [
    '**Event loop**',
    `├ Delay p50 / p99: ${eventLoop.p50Ms} / ${eventLoop.p99Ms} ms`,
    `├ Max delay: ${eventLoop.maxMs} ms`,
    `└ Utilization: ${Math.round(eventLoop.utilization * 100)}%`,
    '',
  ];
}

/**
 * Format health status for display
 */
export function formatHealthStatus(health: HealthStatus): string {
  const statusEmoji =
    health.status === 'healthy'
      ? '🟢'
      : health.status === 'degraded'
        ? '🟡'
        : '🔴';

  const uptimeDays = Math.floor(health.uptime / 86400);
  const uptimeHours = Math.floor((health.uptime % 86400) / 3600);
  const uptimeMinutes = Math.floor((health.uptime % 3600) / 60);

  const serviceEntries = Object.entries(health.services).sort(([a], [b]) =>
    a.localeCompare(b)
  );
  const serviceLines =
    serviceEntries.length === 0
      ? ['└ No tracked services']
      : serviceEntries.map(([service, running], index) => {
          const prefix = index === serviceEntries.length - 1 ? '└' : '├';
          const label = service
            .replace(/([a-z])([A-Z])/g, '$1 $2')
            .replace(/^./, (value) => value.toUpperCase());
          return `${prefix} ${label}: ${running ? '✅' : '❌'}`;
        });

  const lines = [
    `**Status:** ${statusEmoji} ${health.status.toUpperCase()}`,
    `**Uptime:** ${uptimeDays}d ${uptimeHours}h ${uptimeMinutes}m`,
    '',
    '**Memory**',
    `├ Heap used: ${health.memory.used} MB`,
    `├ Heap total: ${health.memory.total} MB`,
    `├ Heap usage: ${health.memory.percentage}%`,
    `└ RSS: ${health.memory.rss} MB`,
    '',
    '**Discord**',
    `├ Connected: ${health.discord.connected ? '✅' : '❌'}`,
    `└ Ping: ${health.discord.ping}ms`,
    '',
    '**Database**',
    `├ Connected: ${health.database.connected ? '✅' : '❌'}`,
    `└ Tables: ${health.database.tables}`,
    '',
    ...formatEventLoop(health.eventLoop),
    '**Services**',
    ...serviceLines,
  ];

  return lines.join('\n');
}
