import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { metrics } from '../index.js';

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
});
