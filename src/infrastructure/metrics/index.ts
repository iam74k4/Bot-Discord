import {
  monitorEventLoopDelay,
  performance,
  type EventLoopUtilization,
} from 'node:perf_hooks';
import { SnowflakeUtil } from 'discord.js';
import { logger } from '../../shared/utils/logger.js';

/**
 * Metrics data structure
 */
export interface Metrics {
  commands: {
    executed: number;
    errors: number;
    byName: Map<string, number>;
  };
  voice: {
    recordings: number;
    totalSeconds: number;
  };
  startTime: number;
}

/**
 * Main-thread health over the current window (an hour at most). Delays are
 * how late the event loop ran a timer, with the sampling interval already
 * subtracted, so 0 means "on time".
 */
export interface EventLoopStats {
  p50Ms: number;
  p99Ms: number;
  maxMs: number;
  /** Share of the window the loop spent busy, 0-1. */
  utilization: number;
  windowSeconds: number;
}

/**
 * How long users waited for the bot to acknowledge an interaction: from the
 * moment Discord created it (its snowflake) to our accepted callback.
 * Discord fails the interaction at 3 s.
 */
export interface AcknowledgementStats {
  count: number;
  /** Callbacks Discord rejected (expired or already acknowledged). */
  failures: number;
  p50Ms: number | null;
  p95Ms: number | null;
  /** Labels (command path, `component:x`, `autocomplete:x`) by p95, slowest first. */
  slowest: { label: string; p95Ms: number; count: number }[];
}

/**
 * Metrics snapshot for serialization
 */
export interface MetricsSnapshot {
  commands: {
    executed: number;
    errors: number;
    byName: Record<string, number>;
  };
  voice: {
    recordings: number;
    totalSeconds: number;
  };
  startTime: number;
  uptimeSeconds: number;
  /** Null until `startEventLoopMonitor` runs. */
  eventLoop: EventLoopStats | null;
  acknowledgements: AcknowledgementStats;
}

/** The part of an event-loop delay histogram the monitor reads (ns values). */
export interface EventLoopHistogram {
  enable(): unknown;
  disable(): unknown;
  reset(): void;
  readonly count: number;
  readonly max: number;
  percentile(percentile: number): number;
}

/**
 * Where event-loop figures come from: `node:perf_hooks` in production, a
 * fake in tests so they need neither real time nor a blocked thread.
 */
export interface EventLoopSampler {
  createHistogram(resolutionMs: number): EventLoopHistogram;
  utilization(since?: EventLoopUtilization): EventLoopUtilization;
}

const nodeEventLoopSampler: EventLoopSampler = {
  createHistogram: (resolution) => monitorEventLoopDelay({ resolution }),
  utilization: (since) => performance.eventLoopUtilization(since),
};

/** The parts of a `@discordjs/rest` response event this module reads. */
export interface RestResponseRequest {
  route: string;
  path: string;
}
export interface RestResponseLike {
  status: number;
}

/** Event-loop sampling interval; ~0.2% of a vCPU when idle. */
const EVENT_LOOP_RESOLUTION_MS = 50;
const EVENT_LOOP_WINDOW_MS = 60 * 60_000;
/** p99 delay worth a log line: audio and TTS start to stutter around here. */
const EVENT_LOOP_WARN_MS = 100;

const INTERACTION_CALLBACK_ROUTE = '/interactions/:id/:token/callback';
/** An acknowledgement this slow is one bad network hop from failing. */
const ACK_WARN_MS = 2_500;
const ACK_SAMPLES_TOTAL = 500;
const ACK_SAMPLES_PER_LABEL = 200;
/** Interactions awaiting their callback; old entries fall off the front. */
const PENDING_LABELS_MAX = 1_000;
const SLOWEST_LABELS_SHOWN = 3;

/**
 * Internal metrics state
 */
const metricsState: Metrics = {
  commands: {
    executed: 0,
    errors: 0,
    byName: new Map(),
  },
  voice: {
    recordings: 0,
    totalSeconds: 0,
  },
  startTime: Date.now(),
};

interface EventLoopMonitor {
  sampler: EventLoopSampler;
  histogram: EventLoopHistogram;
  windowStart: number;
  utilizationStart: EventLoopUtilization;
  rollover: NodeJS.Timeout;
}

let eventLoop: EventLoopMonitor | null = null;

const acknowledgements = {
  pending: new Map<string, string>(),
  all: [] as number[],
  byLabel: new Map<string, number[]>(),
  count: 0,
  failures: 0,
};

function pushBounded(values: number[], value: number, max: number): void {
  values.push(value);
  if (values.length > max) values.shift();
}

/** Nearest-rank percentile of unsorted samples, or null without any. */
function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[Math.min(sorted.length, rank) - 1];
}

/** Histogram nanoseconds to "ms late", minus the sampling interval. */
function lateMs(nanoseconds: number): number {
  const ms = nanoseconds / 1e6 - EVENT_LOOP_RESOLUTION_MS;
  return Math.max(0, Math.round(ms * 10) / 10);
}

function readEventLoop(monitor: EventLoopMonitor): EventLoopStats {
  const { histogram } = monitor;
  const hasSamples = histogram.count > 0;
  const { utilization } = monitor.sampler.utilization(monitor.utilizationStart);
  return {
    p50Ms: hasSamples ? lateMs(histogram.percentile(50)) : 0,
    p99Ms: hasSamples ? lateMs(histogram.percentile(99)) : 0,
    maxMs: hasSamples ? lateMs(histogram.max) : 0,
    utilization: Number.isFinite(utilization) ? utilization : 0,
    windowSeconds: Math.round((Date.now() - monitor.windowStart) / 1000),
  };
}

function resetEventLoopWindow(monitor: EventLoopMonitor): void {
  monitor.histogram.reset();
  monitor.windowStart = Date.now();
  monitor.utilizationStart = monitor.sampler.utilization();
}

function readAcknowledgements(): AcknowledgementStats {
  const slowest = [...acknowledgements.byLabel.entries()]
    .map(([label, samples]) => ({
      label,
      p95Ms: percentile(samples, 95) ?? 0,
      count: samples.length,
    }))
    .sort((a, b) => b.p95Ms - a.p95Ms)
    .slice(0, SLOWEST_LABELS_SHOWN);

  return {
    count: acknowledgements.count,
    failures: acknowledgements.failures,
    p50Ms: percentile(acknowledgements.all, 50),
    p95Ms: percentile(acknowledgements.all, 95),
    slowest,
  };
}

function resetAcknowledgements(): void {
  acknowledgements.pending.clear();
  acknowledgements.all = [];
  acknowledgements.byLabel.clear();
  acknowledgements.count = 0;
  acknowledgements.failures = 0;
}

/**
 * Metrics service for tracking bot usage
 */
export const metrics = {
  /**
   * Increment command execution count
   */
  incrementCommand(name: string): void {
    metricsState.commands.executed++;
    const current = metricsState.commands.byName.get(name) ?? 0;
    metricsState.commands.byName.set(name, current + 1);
  },

  /**
   * Increment command error count
   */
  incrementError(name?: string): void {
    metricsState.commands.errors++;
    if (name) {
      const errorKey = `${name}:error`;
      const current = metricsState.commands.byName.get(errorKey) ?? 0;
      metricsState.commands.byName.set(errorKey, current + 1);
    }
  },

  /**
   * Record a voice recording
   */
  recordVoiceRecording(durationSeconds: number): void {
    metricsState.voice.recordings++;
    metricsState.voice.totalSeconds += durationSeconds;
  },

  /**
   * Start sampling event-loop delay and utilization. Idempotent. Every hour
   * the window starts over, with a warning if its p99 delay was high.
   * `sampler` is for tests; production samples through `node:perf_hooks`.
   */
  startEventLoopMonitor(
    sampler: EventLoopSampler = nodeEventLoopSampler
  ): void {
    if (eventLoop) return;

    const histogram = sampler.createHistogram(EVENT_LOOP_RESOLUTION_MS);
    histogram.enable();

    const monitor: EventLoopMonitor = {
      sampler,
      histogram,
      windowStart: Date.now(),
      utilizationStart: sampler.utilization(),
      rollover: setInterval(() => {
        const stats = readEventLoop(monitor);
        if (stats.p99Ms > EVENT_LOOP_WARN_MS) {
          logger.warn(
            `Event loop was slow over the last ${stats.windowSeconds}s: p99 ${stats.p99Ms} ms, max ${stats.maxMs} ms, ${Math.round(stats.utilization * 100)}% busy`
          );
        }
        resetEventLoopWindow(monitor);
      }, EVENT_LOOP_WINDOW_MS),
    };
    monitor.rollover.unref();
    eventLoop = monitor;
  },

  /** Stop sampling, leaving no timer or histogram behind. */
  stopEventLoopMonitor(): void {
    if (!eventLoop) return;
    clearInterval(eventLoop.rollover);
    eventLoop.histogram.disable();
    eventLoop = null;
  },

  /** Event-loop figures for the current window, or null when not monitoring. */
  getEventLoopStats(): EventLoopStats | null {
    return eventLoop ? readEventLoop(eventLoop) : null;
  },

  /**
   * Remember what an interaction was (`voice record`, `component:help`), so
   * its acknowledgement can be attributed when the callback goes out.
   */
  noteInteraction(id: string, label: string): void {
    if (!id) return;
    const { pending } = acknowledgements;
    pending.delete(id);
    pending.set(id, label);
    while (pending.size > PENDING_LABELS_MAX) {
      const oldest = pending.keys().next().value;
      if (oldest === undefined) break;
      pending.delete(oldest);
    }
  },

  /**
   * Record the callback for an interaction: on success, the time since
   * Discord created it.
   */
  recordAcknowledgement(id: string, ok: boolean, now = Date.now()): void {
    const label = acknowledgements.pending.get(id) ?? 'unknown';
    acknowledgements.pending.delete(id);

    if (!ok) {
      acknowledgements.failures++;
      return;
    }

    const latency = Math.max(0, now - Number(SnowflakeUtil.timestampFrom(id)));
    acknowledgements.count++;
    pushBounded(acknowledgements.all, latency, ACK_SAMPLES_TOTAL);
    let samples = acknowledgements.byLabel.get(label);
    if (!samples) {
      samples = [];
      acknowledgements.byLabel.set(label, samples);
    }
    pushBounded(samples, latency, ACK_SAMPLES_PER_LABEL);

    if (latency > ACK_WARN_MS) {
      logger.warn(
        `Slow interaction acknowledgement: ${label} took ${latency} ms`
      );
    }
  },

  /**
   * A listener for `client.rest.on(RESTEvents.Response, ...)` that records
   * every interaction callback. It never throws: a metrics bug must not
   * break a REST request.
   */
  createAcknowledgementListener(): (
    request: RestResponseRequest,
    response: RestResponseLike
  ) => void {
    return (request, response) => {
      try {
        if (request.route !== INTERACTION_CALLBACK_ROUTE) return;
        const id = request.path.split('/')[2];
        if (!id || !/^\d+$/.test(id)) return;
        const ok = response.status >= 200 && response.status < 300;
        metrics.recordAcknowledgement(id, ok);
      } catch (error) {
        logger.debug(`Failed to record an acknowledgement: ${String(error)}`);
      }
    };
  },

  /** Acknowledgement figures since start (or the last reset). */
  getAcknowledgementStats(): AcknowledgementStats {
    return readAcknowledgements();
  },

  /**
   * Get metrics snapshot
   */
  getSnapshot(): MetricsSnapshot {
    return {
      commands: {
        executed: metricsState.commands.executed,
        errors: metricsState.commands.errors,
        byName: Object.fromEntries(metricsState.commands.byName),
      },
      voice: {
        recordings: metricsState.voice.recordings,
        totalSeconds: metricsState.voice.totalSeconds,
      },
      startTime: metricsState.startTime,
      uptimeSeconds: Math.floor((Date.now() - metricsState.startTime) / 1000),
      eventLoop: metrics.getEventLoopStats(),
      acknowledgements: readAcknowledgements(),
    };
  },

  /**
   * Reset all metrics
   */
  reset(): void {
    metricsState.commands.executed = 0;
    metricsState.commands.errors = 0;
    metricsState.commands.byName.clear();
    metricsState.voice.recordings = 0;
    metricsState.voice.totalSeconds = 0;
    metricsState.startTime = Date.now();
    resetAcknowledgements();
    if (eventLoop) resetEventLoopWindow(eventLoop);
  },

  /**
   * Format metrics for display
   */
  formatForDisplay(): string {
    const snapshot = this.getSnapshot();
    const topCommands = Object.entries(snapshot.commands.byName)
      .filter(([key]) => !key.endsWith(':error'))
      .sort(([, a], [, b]) => b - a)
      .slice(0, 5)
      .map(([name, count]) => `  ${name}: ${count}`)
      .join('\n');

    const ack = snapshot.acknowledgements;
    const ackLines =
      ack.p50Ms === null
        ? [`└ Acknowledged: 0 (failed: ${ack.failures})`]
        : [
            `├ Acknowledged: ${ack.count} (failed: ${ack.failures})`,
            `├ Time to acknowledge p50 / p95: ${ack.p50Ms} / ${ack.p95Ms} ms`,
            `└ Slowest p95: ${ack.slowest
              .map((entry) => `${entry.label} ${entry.p95Ms} ms`)
              .join(', ')}`,
          ];

    const loop = snapshot.eventLoop;
    const loopLines = loop
      ? [
          `├ Delay p50 / p99: ${loop.p50Ms} / ${loop.p99Ms} ms`,
          `├ Max delay: ${loop.maxMs} ms`,
          `└ Utilization: ${Math.round(loop.utilization * 100)}% (last ${Math.round(loop.windowSeconds / 60)} min)`,
        ]
      : ['└ Not monitored'];

    const lines = [
      '**Commands**',
      `├ Executed: ${snapshot.commands.executed}`,
      `├ Errors: ${snapshot.commands.errors}`,
      `└ Top Commands:`,
      topCommands || '  (none)',
      '',
      '**Voice**',
      `├ Recordings: ${snapshot.voice.recordings}`,
      `└ Total Duration: ${Math.round(snapshot.voice.totalSeconds / 60)} min`,
      '',
      '**Interactions**',
      ...ackLines,
      '',
      '**Event loop**',
      ...loopLines,
    ];

    return lines.join('\n');
  },
};
