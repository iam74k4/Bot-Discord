import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SnowflakeUtil } from 'discord.js';
import { metrics } from '../index.js';

const logger = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));
vi.mock('../../../shared/utils/logger.js', () => ({
  logger,
  getErrorMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)),
}));

/** A snowflake Discord would have minted at `ms`. */
function snowflakeAt(ms: number): string {
  return SnowflakeUtil.generate({ timestamp: ms }).toString();
}

function busyWait(ms: number): void {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    // Block the event loop on purpose.
  }
}

describe('metrics service', () => {
  beforeEach(() => {
    metrics.reset();
  });

  describe('incrementCommand', () => {
    it('increments commands.executed', () => {
      metrics.incrementCommand('ping');
      expect(metrics.getSnapshot().commands.executed).toBe(1);

      metrics.incrementCommand('help');
      expect(metrics.getSnapshot().commands.executed).toBe(2);
    });

    it('tracks commands by name in byName map', () => {
      metrics.incrementCommand('ping');
      metrics.incrementCommand('ping');
      metrics.incrementCommand('help');

      const snapshot = metrics.getSnapshot();
      expect(snapshot.commands.byName['ping']).toBe(2);
      expect(snapshot.commands.byName['help']).toBe(1);
    });
  });

  describe('incrementError', () => {
    it('increments commands.errors', () => {
      metrics.incrementError();
      expect(metrics.getSnapshot().commands.errors).toBe(1);

      metrics.incrementError();
      expect(metrics.getSnapshot().commands.errors).toBe(2);
    });

    it('tracks errors by command name with :error suffix when name provided', () => {
      metrics.incrementError('voice');
      metrics.incrementError('voice');
      metrics.incrementError('poll');

      const snapshot = metrics.getSnapshot();
      expect(snapshot.commands.byName['voice:error']).toBe(2);
      expect(snapshot.commands.byName['poll:error']).toBe(1);
    });

    it('does not add to byName when name is omitted', () => {
      metrics.incrementError();

      const snapshot = metrics.getSnapshot();
      expect(snapshot.commands.errors).toBe(1);
      expect(Object.keys(snapshot.commands.byName)).toHaveLength(0);
    });
  });

  describe('recordVoiceRecording', () => {
    it('increments voice.recordings', () => {
      metrics.recordVoiceRecording(60);
      expect(metrics.getSnapshot().voice.recordings).toBe(1);

      metrics.recordVoiceRecording(30);
      expect(metrics.getSnapshot().voice.recordings).toBe(2);
    });

    it('accumulates totalSeconds', () => {
      metrics.recordVoiceRecording(60);
      metrics.recordVoiceRecording(30);
      metrics.recordVoiceRecording(90);

      expect(metrics.getSnapshot().voice.totalSeconds).toBe(180);
    });

    it('handles fractional durations', () => {
      metrics.recordVoiceRecording(1.5);
      metrics.recordVoiceRecording(2.5);

      expect(metrics.getSnapshot().voice.totalSeconds).toBe(4);
    });
  });

  describe('getSnapshot', () => {
    it('returns correct structure with all required fields', () => {
      metrics.incrementCommand('test');
      metrics.incrementError('test');
      metrics.recordVoiceRecording(120);

      const snapshot = metrics.getSnapshot();

      expect(snapshot).toMatchObject({
        commands: {
          executed: 1,
          errors: 1,
          byName: expect.objectContaining({
            test: 1,
            'test:error': 1,
          }),
        },
        voice: {
          recordings: 1,
          totalSeconds: 120,
        },
      });
      expect(typeof snapshot.startTime).toBe('number');
      expect(typeof snapshot.uptimeSeconds).toBe('number');
      expect(snapshot.uptimeSeconds).toBeGreaterThanOrEqual(0);
    });

    it('converts byName Map to plain object', () => {
      metrics.incrementCommand('cmd1');
      const snapshot = metrics.getSnapshot();

      expect(snapshot.commands.byName).toEqual({ cmd1: 1 });
      expect(Array.isArray(snapshot.commands.byName)).toBe(false);
    });
  });

  describe('reset', () => {
    it('clears all counters', () => {
      metrics.incrementCommand('ping');
      metrics.incrementError('ping');
      metrics.recordVoiceRecording(60);

      metrics.reset();

      const snapshot = metrics.getSnapshot();
      expect(snapshot.commands.executed).toBe(0);
      expect(snapshot.commands.errors).toBe(0);
      expect(Object.keys(snapshot.commands.byName)).toHaveLength(0);
      expect(snapshot.voice.recordings).toBe(0);
      expect(snapshot.voice.totalSeconds).toBe(0);
    });

    describe('startTime', () => {
      const T1 = new Date('2026-01-01T00:00:00Z').getTime();
      const T2 = T1 + 90_000;

      beforeEach(() => {
        vi.useFakeTimers();
      });

      afterEach(() => {
        vi.useRealTimers();
      });

      it('moves startTime to the moment of the reset', () => {
        vi.setSystemTime(T1);
        metrics.reset();
        expect(metrics.getSnapshot().startTime).toBe(T1);

        vi.setSystemTime(T2);
        metrics.reset();

        expect(metrics.getSnapshot().startTime).toBe(T2);
      });

      it('restarts uptime from zero', () => {
        vi.setSystemTime(T1);
        metrics.reset();
        vi.setSystemTime(T2);
        expect(metrics.getSnapshot().uptimeSeconds).toBe(90);

        metrics.reset();

        expect(metrics.getSnapshot().uptimeSeconds).toBe(0);
      });
    });
  });

  describe('formatForDisplay', () => {
    it('returns non-empty string', () => {
      const output = metrics.formatForDisplay();
      expect(output).toBeTruthy();
      expect(typeof output).toBe('string');
      expect(output.length).toBeGreaterThan(0);
    });

    it('includes commands section', () => {
      metrics.incrementCommand('ping');
      const output = metrics.formatForDisplay();

      expect(output).toContain('**Commands**');
      expect(output).toContain('Executed: 1');
      expect(output).toContain('ping: 1');
    });

    it('includes voice section with duration in minutes', () => {
      metrics.recordVoiceRecording(120);
      const output = metrics.formatForDisplay();

      expect(output).toContain('**Voice**');
      expect(output).toContain('Recordings: 1');
      expect(output).toContain('Total Duration: 2 min');
    });

    it('lists at most five top commands, busiest first', () => {
      const counts: Array<[string, number]> = [
        ['a', 1],
        ['b', 6],
        ['c', 3],
        ['d', 5],
        ['e', 2],
        ['f', 4],
      ];
      for (const [name, count] of counts) {
        for (let i = 0; i < count; i++) metrics.incrementCommand(name);
      }

      const lines = metrics.formatForDisplay().split('\n');
      const top = lines.slice(
        lines.indexOf('└ Top Commands:') + 1,
        lines.indexOf('')
      );

      expect(top).toEqual(['  b: 6', '  d: 5', '  f: 4', '  c: 3', '  e: 2']);
    });

    it('shows the error count and rounds the voice total to whole minutes', () => {
      metrics.incrementError();
      metrics.incrementError('ping');
      metrics.recordVoiceRecording(89);

      const output = metrics.formatForDisplay();

      expect(output).toContain('├ Errors: 2');
      expect(output).toContain('Total Duration: 1 min');
    });

    it('shows (none) for top commands when empty', () => {
      const output = metrics.formatForDisplay();
      expect(output).toContain('(none)');
    });

    it('excludes :error keys from top commands', () => {
      metrics.incrementError('voice');
      metrics.incrementCommand('ping');
      const output = metrics.formatForDisplay();

      expect(output).toContain('ping: 1');
      expect(output).not.toContain('voice:error');
    });
  });

  describe('time to acknowledge', () => {
    const NOW = new Date('2026-05-01T12:00:00Z').getTime();

    beforeEach(() => {
      vi.clearAllMocks();
    });

    it('measures from the moment Discord created the interaction', () => {
      const id = snowflakeAt(NOW - 180);
      metrics.noteInteraction(id, 'voice record');

      metrics.recordAcknowledgement(id, true, NOW);

      expect(metrics.getAcknowledgementStats()).toEqual({
        count: 1,
        failures: 0,
        p50Ms: 180,
        p95Ms: 180,
        slowest: [{ label: 'voice record', p95Ms: 180, count: 1 }],
      });
    });

    it('reports percentiles over many samples and ranks the slowest labels', () => {
      for (let i = 1; i <= 100; i++) {
        const id = snowflakeAt(NOW - i * 10);
        metrics.noteInteraction(id, i <= 50 ? 'general ping' : 'voice record');
        metrics.recordAcknowledgement(id, true, NOW);
      }

      const stats = metrics.getAcknowledgementStats();
      expect(stats.count).toBe(100);
      expect(stats.p50Ms).toBe(500);
      expect(stats.p95Ms).toBe(950);
      expect(stats.slowest.map((entry) => entry.label)).toEqual([
        'voice record',
        'general ping',
      ]);
    });

    it('keeps only the most recent samples', () => {
      for (let i = 0; i < 600; i++) {
        const id = snowflakeAt(NOW - (i < 100 ? 2_000 : 100));
        metrics.recordAcknowledgement(id, true, NOW);
      }

      const stats = metrics.getAcknowledgementStats();
      expect(stats.count).toBe(600);
      // The 100 slow early samples have rolled out of the 500-sample window.
      expect(stats.p95Ms).toBe(100);
    });

    it('counts a rejected callback as a failure, not a latency', () => {
      const id = snowflakeAt(NOW - 100);
      metrics.noteInteraction(id, 'component:help');

      metrics.recordAcknowledgement(id, false, NOW);

      expect(metrics.getAcknowledgementStats()).toMatchObject({
        count: 0,
        failures: 1,
        p50Ms: null,
      });
    });

    it('labels an interaction it was not told about as unknown', () => {
      metrics.recordAcknowledgement(snowflakeAt(NOW - 5), true, NOW);

      expect(metrics.getAcknowledgementStats().slowest[0].label).toBe(
        'unknown'
      );
    });

    it('warns about an acknowledgement close to the 3 second deadline', () => {
      const id = snowflakeAt(NOW - 2_600);
      metrics.noteInteraction(id, 'voice record');

      metrics.recordAcknowledgement(id, true, NOW);

      expect(logger.warn).toHaveBeenCalledWith(
        'Slow interaction acknowledgement: voice record took 2600 ms'
      );
    });

    it('forgets the oldest pending labels beyond its bound', () => {
      const first = snowflakeAt(NOW - 10);
      metrics.noteInteraction(first, 'first');
      for (let i = 0; i < 1_000; i++) {
        metrics.noteInteraction(`${i + 1}`, 'filler');
      }

      metrics.recordAcknowledgement(first, true, NOW);

      expect(metrics.getAcknowledgementStats().slowest[0].label).toBe(
        'unknown'
      );
    });

    describe('REST listener', () => {
      it('records interaction callbacks with their outcome', () => {
        const listener = metrics.createAcknowledgementListener();
        const id = snowflakeAt(Date.now() - 50);
        metrics.noteInteraction(id, 'admin settings view');

        listener(
          {
            route: '/interactions/:id/:token/callback',
            path: `/interactions/${id}/tok/callback`,
          },
          { status: 204 }
        );
        listener(
          {
            route: '/interactions/:id/:token/callback',
            path: `/interactions/${snowflakeAt(Date.now())}/tok/callback`,
          },
          { status: 404 }
        );

        const stats = metrics.getAcknowledgementStats();
        expect(stats.count).toBe(1);
        expect(stats.failures).toBe(1);
        expect(stats.slowest[0].label).toBe('admin settings view');
      });

      it('ignores every other route and never throws', () => {
        const listener = metrics.createAcknowledgementListener();

        listener(
          { route: '/channels/:id/messages', path: '/channels/1/messages' },
          { status: 200 }
        );
        listener(
          {
            route: '/interactions/:id/:token/callback',
            path: '/interactions/not-a-snowflake/x/callback',
          },
          { status: 200 }
        );
        expect(() => listener(null as never, { status: 200 })).not.toThrow();

        expect(metrics.getAcknowledgementStats()).toMatchObject({
          count: 0,
          failures: 0,
        });
      });
    });

    it('is cleared by reset and part of the snapshot', () => {
      metrics.recordAcknowledgement(snowflakeAt(NOW - 5), true, NOW);
      expect(metrics.getSnapshot().acknowledgements.count).toBe(1);

      metrics.reset();

      expect(metrics.getSnapshot().acknowledgements).toEqual({
        count: 0,
        failures: 0,
        p50Ms: null,
        p95Ms: null,
        slowest: [],
      });
    });

    it('is shown in the display', () => {
      expect(metrics.formatForDisplay()).toContain(
        '**Interactions**\n└ Acknowledged: 0 (failed: 0)'
      );

      const id = snowflakeAt(NOW - 120);
      metrics.noteInteraction(id, 'voice record');
      metrics.recordAcknowledgement(id, true, NOW);

      const output = metrics.formatForDisplay();
      expect(output).toContain('├ Acknowledged: 1 (failed: 0)');
      expect(output).toContain('├ Time to acknowledge p50 / p95: 120 / 120 ms');
      expect(output).toContain('└ Slowest p95: voice record 120 ms');
    });
  });

  describe('event loop monitor', () => {
    const MS = 1e6; // the histogram reports nanoseconds

    /** A histogram and utilization source the test controls. */
    function fakeSampler() {
      const histogram = {
        enable: vi.fn(),
        disable: vi.fn(),
        reset: vi.fn(() => {
          histogram.count = 0;
          histogram.max = 0;
          histogram.p50 = 0;
          histogram.p99 = 0;
        }),
        count: 0,
        max: 0,
        p50: 0,
        p99: 0,
        percentile: vi.fn((p: number) =>
          p === 50 ? histogram.p50 : histogram.p99
        ),
      };
      /** Timers ran this many ms late (plus the 50 ms sampling interval). */
      const lateBy = (p50: number, p99: number, max: number) => {
        histogram.count = 100;
        histogram.p50 = (50 + p50) * MS;
        histogram.p99 = (50 + p99) * MS;
        histogram.max = (50 + max) * MS;
      };
      type Elu = { idle: number; active: number; utilization: number };
      let marks = 0;
      const sampler = {
        histogram,
        lateBy,
        busy: 0.25,
        createHistogram: vi.fn(() => histogram),
        // Without `since`, a numbered baseline; with it, the share busy since.
        utilization: vi.fn(
          (since?: Elu): Elu =>
            since
              ? { idle: 0, active: 0, utilization: sampler.busy }
              : { idle: ++marks, active: 0, utilization: 0 }
        ),
      };
      return sampler;
    }

    beforeEach(() => {
      vi.useFakeTimers();
      vi.clearAllMocks();
    });

    afterEach(() => {
      metrics.stopEventLoopMonitor();
      vi.useRealTimers();
    });

    it('reports nothing until it is started', () => {
      expect(metrics.getEventLoopStats()).toBeNull();
      expect(metrics.getSnapshot().eventLoop).toBeNull();
      expect(metrics.formatForDisplay()).toContain(
        '**Event loop**\n└ Not monitored'
      );
    });

    it('samples every 50 ms and reports delays net of that interval', () => {
      const sampler = fakeSampler();
      metrics.startEventLoopMonitor(sampler);
      expect(sampler.createHistogram).toHaveBeenCalledWith(50);
      expect(sampler.histogram.enable).toHaveBeenCalledTimes(1);

      sampler.lateBy(0.04, 120, 250);
      vi.advanceTimersByTime(90_000);

      expect(metrics.getEventLoopStats()).toEqual({
        p50Ms: 0, // on time reads 0, not 50
        p99Ms: 120,
        maxMs: 250,
        utilization: 0.25,
        windowSeconds: 90,
      });
      expect(metrics.getSnapshot().eventLoop?.p99Ms).toBe(120);
      const output = metrics.formatForDisplay();
      expect(output).toContain('├ Delay p50 / p99: 0 / 120 ms');
      expect(output).toContain('├ Max delay: 250 ms');
      expect(output).toContain('└ Utilization: 25% (last 2 min)');
    });

    it('reports zeros before the first sample and a nonsense utilization as 0', () => {
      const sampler = fakeSampler();
      sampler.busy = Number.NaN;
      metrics.startEventLoopMonitor(sampler);

      expect(metrics.getEventLoopStats()).toMatchObject({
        p50Ms: 0,
        p99Ms: 0,
        maxMs: 0,
        utilization: 0,
      });
    });

    it('starts a fresh window on reset', () => {
      const sampler = fakeSampler();
      metrics.startEventLoopMonitor(sampler);
      sampler.lateBy(1, 300, 400);
      vi.advanceTimersByTime(30 * 60_000);

      metrics.reset();

      expect(sampler.histogram.reset).toHaveBeenCalledTimes(1);
      expect(metrics.getEventLoopStats()).toMatchObject({
        maxMs: 0,
        windowSeconds: 0,
      });
      // Utilization is measured from a new baseline taken at the reset
      // (baseline 1 was taken at start).
      expect(sampler.utilization).toHaveBeenLastCalledWith(
        expect.objectContaining({ idle: 2 })
      );
    });

    it('can be started twice and stopped twice, leaving no timer behind', () => {
      const sampler = fakeSampler();
      metrics.startEventLoopMonitor(sampler);
      metrics.startEventLoopMonitor(sampler);
      expect(sampler.createHistogram).toHaveBeenCalledTimes(1);

      metrics.stopEventLoopMonitor();
      metrics.stopEventLoopMonitor();

      expect(sampler.histogram.disable).toHaveBeenCalledTimes(1);
      expect(metrics.getEventLoopStats()).toBeNull();
      expect(vi.getTimerCount()).toBe(0);
    });

    it('warns once an hour when the window was slow, then starts over', () => {
      const sampler = fakeSampler();
      metrics.startEventLoopMonitor(sampler);
      sampler.lateBy(2, 180, 400);

      vi.advanceTimersByTime(60 * 60_000 - 1);
      expect(logger.warn).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);

      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect(logger.warn).toHaveBeenCalledWith(
        'Event loop was slow over the last 3600s: p99 180 ms, max 400 ms, 25% busy'
      );
      expect(metrics.getEventLoopStats()).toMatchObject({
        p99Ms: 0,
        windowSeconds: 0,
      });
    });

    it('stays quiet after a calm hour', () => {
      const sampler = fakeSampler();
      metrics.startEventLoopMonitor(sampler);
      sampler.lateBy(1, 100, 140); // at the threshold, not over it

      vi.advanceTimersByTime(60 * 60_000);

      expect(logger.warn).not.toHaveBeenCalled();
      expect(sampler.histogram.reset).toHaveBeenCalledTimes(1);
    });

    it('catches a real stall of the main thread (smoke test, real time)', async () => {
      vi.useRealTimers();
      metrics.startEventLoopMonitor();
      await new Promise((resolve) => setTimeout(resolve, 60));

      busyWait(300);
      await new Promise((resolve) => setTimeout(resolve, 60));

      const stats = metrics.getEventLoopStats()!;
      // A 300 ms block shows up as a large delay however loaded the machine.
      expect(stats.maxMs).toBeGreaterThan(100);
      expect(stats.utilization).toBeGreaterThan(0);
      expect(stats.utilization).toBeLessThanOrEqual(1);
    });
  });
});
