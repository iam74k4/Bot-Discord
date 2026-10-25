import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { cooldownStore } from '../cooldownStore.js';

/**
 * The store keeps an expiry timestamp per (command, user) and schedules a
 * timer to drop it once it lapses. Time is faked throughout so expiry is
 * exact: "remaining" is computed from Date.now(), and the cleanup timer is
 * what actually forgets the entry.
 */

const NOW = new Date('2026-01-01T00:00:00Z').getTime();

describe('CooldownStore', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    cooldownStore.clearAll();
  });

  afterEach(() => {
    cooldownStore.clearAll();
    vi.useRealTimers();
  });

  describe('setCooldown', () => {
    it('should set a cooldown for a user', () => {
      cooldownStore.setCooldown('test-command', 'user1', 5000);
      expect(cooldownStore.isOnCooldown('test-command', 'user1')).toBe(true);
    });

    it('should allow different users to have separate cooldowns', () => {
      cooldownStore.setCooldown('test-command', 'user1', 5000);
      cooldownStore.setCooldown('test-command', 'user2', 5000);

      expect(cooldownStore.isOnCooldown('test-command', 'user1')).toBe(true);
      expect(cooldownStore.isOnCooldown('test-command', 'user2')).toBe(true);
      expect(cooldownStore.isOnCooldown('test-command', 'user3')).toBe(false);
    });

    it('should allow same user to have cooldowns on different commands', () => {
      cooldownStore.setCooldown('command1', 'user1', 5000);
      cooldownStore.setCooldown('command2', 'user1', 5000);

      expect(cooldownStore.isOnCooldown('command1', 'user1')).toBe(true);
      expect(cooldownStore.isOnCooldown('command2', 'user1')).toBe(true);
    });

    it('records the absolute expiry time', () => {
      cooldownStore.setCooldown('test-command', 'user1', 5000);

      expect(cooldownStore.checkCooldown('test-command', 'user1')).toBe(
        NOW + 5000
      );
    });

    it('restarts the window when set again, and the old timer cannot cut it short', () => {
      cooldownStore.setCooldown('test-command', 'user1', 5000);
      vi.advanceTimersByTime(3000);

      cooldownStore.setCooldown('test-command', 'user1', 5000);
      expect(vi.getTimerCount()).toBe(1);

      // The first timer would have fired here.
      vi.advanceTimersByTime(2000);
      expect(cooldownStore.getRemainingCooldown('test-command', 'user1')).toBe(
        3000
      );

      vi.advanceTimersByTime(3000);
      expect(cooldownStore.isOnCooldown('test-command', 'user1')).toBe(false);
    });

    it('evicts the oldest user once a command tracks 10,000 users', () => {
      for (let i = 0; i < 10_000; i++) {
        cooldownStore.setCooldown('popular', `user-${i}`, 60_000);
      }
      expect(cooldownStore.isOnCooldown('popular', 'user-0')).toBe(true);

      cooldownStore.setCooldown('popular', 'user-10000', 60_000);

      expect(cooldownStore.isOnCooldown('popular', 'user-0')).toBe(false);
      expect(cooldownStore.isOnCooldown('popular', 'user-1')).toBe(true);
      expect(cooldownStore.isOnCooldown('popular', 'user-10000')).toBe(true);
    });

    it('does not evict anyone when an already-tracked user is refreshed at capacity', () => {
      for (let i = 0; i < 10_000; i++) {
        cooldownStore.setCooldown('popular', `user-${i}`, 60_000);
      }

      cooldownStore.setCooldown('popular', 'user-5', 60_000);

      expect(cooldownStore.isOnCooldown('popular', 'user-0')).toBe(true);
      expect(cooldownStore.isOnCooldown('popular', 'user-5')).toBe(true);
    });

    it('lets the cleanup timer of an evicted user lapse harmlessly', () => {
      // Only the evicted user's timer is due inside the advanced window, so
      // the fake clock does not have to fire 10,000 timers.
      cooldownStore.setCooldown('popular', 'user-0', 1000);
      for (let i = 1; i <= 10_000; i++) {
        cooldownStore.setCooldown('popular', `user-${i}`, 60_000);
      }
      expect(cooldownStore.isOnCooldown('popular', 'user-0')).toBe(false);
      const timersBefore = vi.getTimerCount();

      expect(() => vi.advanceTimersByTime(1000)).not.toThrow();

      expect(vi.getTimerCount()).toBe(timersBefore - 1);
      expect(cooldownStore.isOnCooldown('popular', 'user-1')).toBe(true);
      expect(cooldownStore.isOnCooldown('popular', 'user-10000')).toBe(true);
    });

    it('forgets the oldest command once 100 commands are tracked', () => {
      for (let i = 0; i < 100; i++) {
        cooldownStore.setCooldown(`cmd-${i}`, 'user1', 60_000);
      }

      cooldownStore.setCooldown('cmd-100', 'user1', 60_000);

      expect(cooldownStore.isOnCooldown('cmd-0', 'user1')).toBe(false);
      expect(cooldownStore.isOnCooldown('cmd-1', 'user1')).toBe(true);
      expect(cooldownStore.isOnCooldown('cmd-100', 'user1')).toBe(true);
      // The evicted command's timer still fires; it must find nothing to do.
      expect(() => vi.advanceTimersByTime(60_000)).not.toThrow();
    });
  });

  describe('expiry', () => {
    it('stays on cooldown until the full window has elapsed', () => {
      cooldownStore.setCooldown('test-command', 'user1', 5000);

      vi.advanceTimersByTime(4999);
      expect(cooldownStore.isOnCooldown('test-command', 'user1')).toBe(true);
      expect(cooldownStore.getRemainingCooldown('test-command', 'user1')).toBe(
        1
      );

      vi.advanceTimersByTime(1);
      expect(cooldownStore.isOnCooldown('test-command', 'user1')).toBe(false);
      expect(cooldownStore.getRemainingCooldown('test-command', 'user1')).toBe(
        0
      );
    });

    it('drops the entry when the cleanup timer fires', () => {
      cooldownStore.setCooldown('test-command', 'user1', 5000);
      expect(vi.getTimerCount()).toBe(1);

      vi.advanceTimersByTime(5000);

      expect(cooldownStore.checkCooldown('test-command', 'user1')).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    });

    it('reports zero remaining for an expired entry even before cleanup runs', () => {
      cooldownStore.setCooldown('test-command', 'user1', 5000);

      // Move the clock without running timers.
      vi.setSystemTime(NOW + 6000);

      expect(cooldownStore.getRemainingCooldown('test-command', 'user1')).toBe(
        0
      );
      expect(cooldownStore.isOnCooldown('test-command', 'user1')).toBe(false);
    });

    it('expires each user independently', () => {
      cooldownStore.setCooldown('test-command', 'user1', 1000);
      cooldownStore.setCooldown('test-command', 'user2', 3000);

      vi.advanceTimersByTime(1000);

      expect(cooldownStore.isOnCooldown('test-command', 'user1')).toBe(false);
      expect(cooldownStore.isOnCooldown('test-command', 'user2')).toBe(true);
    });
  });

  describe('getRemainingCooldown', () => {
    it('should return remaining cooldown time', () => {
      cooldownStore.setCooldown('test-command', 'user1', 5000);
      expect(cooldownStore.getRemainingCooldown('test-command', 'user1')).toBe(
        5000
      );

      vi.advanceTimersByTime(1250);
      expect(cooldownStore.getRemainingCooldown('test-command', 'user1')).toBe(
        3750
      );
    });

    it('should return 0 for user not on cooldown', () => {
      cooldownStore.setCooldown('test-command', 'someone-else', 5000);
      expect(cooldownStore.getRemainingCooldown('test-command', 'user1')).toBe(
        0
      );
    });

    it('should return 0 for non-existent command', () => {
      expect(cooldownStore.getRemainingCooldown('non-existent', 'user1')).toBe(
        0
      );
    });
  });

  describe('checkCooldown', () => {
    it('returns 0 for an unknown command or user', () => {
      expect(cooldownStore.checkCooldown('non-existent', 'user1')).toBe(0);

      cooldownStore.setCooldown('test-command', 'user1', 5000);
      expect(cooldownStore.checkCooldown('test-command', 'user2')).toBe(0);
    });
  });

  describe('isOnCooldown', () => {
    it('should return true when user is on cooldown', () => {
      cooldownStore.setCooldown('test-command', 'user1', 5000);
      expect(cooldownStore.isOnCooldown('test-command', 'user1')).toBe(true);
    });

    it('should return false when user is not on cooldown', () => {
      expect(cooldownStore.isOnCooldown('test-command', 'user1')).toBe(false);
    });
  });

  describe('clearCooldown', () => {
    it('should clear cooldown for a specific user', () => {
      cooldownStore.setCooldown('test-command', 'user1', 5000);
      cooldownStore.setCooldown('test-command', 'user2', 5000);

      cooldownStore.clearCooldown('test-command', 'user1');

      expect(cooldownStore.isOnCooldown('test-command', 'user1')).toBe(false);
      expect(cooldownStore.isOnCooldown('test-command', 'user2')).toBe(true);
    });

    it('cancels the pending cleanup timer', () => {
      cooldownStore.setCooldown('test-command', 'user1', 5000);
      cooldownStore.setCooldown('test-command', 'user2', 5000);

      cooldownStore.clearCooldown('test-command', 'user1');

      expect(vi.getTimerCount()).toBe(1);
    });

    it('allows a fresh cooldown right after clearing', () => {
      cooldownStore.setCooldown('test-command', 'user1', 5000);
      cooldownStore.clearCooldown('test-command', 'user1');
      vi.advanceTimersByTime(1000);

      cooldownStore.setCooldown('test-command', 'user1', 5000);

      expect(cooldownStore.getRemainingCooldown('test-command', 'user1')).toBe(
        5000
      );
    });

    it('is a no-op for an unknown command or user', () => {
      cooldownStore.setCooldown('test-command', 'user1', 5000);

      expect(() => {
        cooldownStore.clearCooldown('non-existent', 'user1');
        cooldownStore.clearCooldown('test-command', 'user2');
      }).not.toThrow();
      expect(cooldownStore.isOnCooldown('test-command', 'user1')).toBe(true);
    });
  });

  describe('clearCooldownTree', () => {
    it('clears a path and every path beneath it for that user only', () => {
      cooldownStore.setCooldown('voice', 'user1', 5000);
      cooldownStore.setCooldown('voice record', 'user1', 5000);
      cooldownStore.setCooldown('voice autojoin exclude', 'user1', 5000);
      cooldownStore.setCooldown('voice record', 'user2', 5000);
      cooldownStore.setCooldown('voicemail', 'user1', 5000);

      cooldownStore.clearCooldownTree('voice', 'user1');

      expect(cooldownStore.isOnCooldown('voice', 'user1')).toBe(false);
      expect(cooldownStore.isOnCooldown('voice record', 'user1')).toBe(false);
      expect(
        cooldownStore.isOnCooldown('voice autojoin exclude', 'user1')
      ).toBe(false);
      // Another user, and a command that merely starts with the same letters.
      expect(cooldownStore.isOnCooldown('voice record', 'user2')).toBe(true);
      expect(cooldownStore.isOnCooldown('voicemail', 'user1')).toBe(true);
    });

    it('leaves sibling paths of a subcommand alone', () => {
      cooldownStore.setCooldown('voice record', 'user1', 5000);
      cooldownStore.setCooldown('voice status', 'user1', 5000);

      cooldownStore.clearCooldownTree('voice record', 'user1');

      expect(cooldownStore.isOnCooldown('voice record', 'user1')).toBe(false);
      expect(cooldownStore.isOnCooldown('voice status', 'user1')).toBe(true);
    });
  });

  describe('clearAll', () => {
    it('should clear all cooldowns', () => {
      cooldownStore.setCooldown('command1', 'user1', 5000);
      cooldownStore.setCooldown('command2', 'user2', 5000);

      cooldownStore.clearAll();

      expect(cooldownStore.isOnCooldown('command1', 'user1')).toBe(false);
      expect(cooldownStore.isOnCooldown('command2', 'user2')).toBe(false);
    });

    it('cancels every pending timer so shutdown does not hang', () => {
      cooldownStore.setCooldown('command1', 'user1', 5000);
      cooldownStore.setCooldown('command2', 'user2', 60_000);
      expect(vi.getTimerCount()).toBe(2);

      cooldownStore.clearAll();

      expect(vi.getTimerCount()).toBe(0);
    });
  });
});
