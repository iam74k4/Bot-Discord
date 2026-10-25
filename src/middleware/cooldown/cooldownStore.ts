import { Collection } from 'discord.js';
import { BoundedMap } from '../../shared/utils/lruCache.js';

const MAX_USERS_PER_COMMAND = 10000;
const MAX_COMMANDS = 100;

class CooldownStore {
  private cooldowns = new BoundedMap<string, Collection<string, number>>(
    MAX_COMMANDS
  );

  /** Pending timeout IDs for cleanup on shutdown */
  private timers = new Map<string, NodeJS.Timeout>();

  private getTimestamps(commandName: string): Collection<string, number> {
    let timestamps = this.cooldowns.get(commandName);
    if (!timestamps) {
      timestamps = new Collection<string, number>();
      this.cooldowns.set(commandName, timestamps);
    }
    return timestamps;
  }

  checkCooldown(commandName: string, userId: string): number {
    const timestamps = this.cooldowns.get(commandName);
    if (!timestamps) return 0;

    const timestamp = timestamps.get(userId);
    if (!timestamp) return 0;

    return timestamp;
  }

  setCooldown(commandName: string, userId: string, cooldownMs: number): void {
    const timestamps = this.getTimestamps(commandName);

    if (timestamps.size >= MAX_USERS_PER_COMMAND && !timestamps.has(userId)) {
      const firstKey = timestamps.keys().next().value;
      if (firstKey) timestamps.delete(firstKey);
    }

    const expirationTime = Date.now() + cooldownMs;
    timestamps.set(userId, expirationTime);

    const key = `${commandName}:${userId}`;
    const existing = this.timers.get(key);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      this.timers.delete(key);
      this.removeCooldown(commandName, userId, expirationTime);
    }, cooldownMs);
    this.timers.set(key, timer);
  }

  private removeCooldown(
    commandName: string,
    userId: string,
    expectedExpiration?: number
  ): void {
    const timestamps = this.cooldowns.get(commandName);
    if (!timestamps) return;

    if (expectedExpiration !== undefined) {
      const current = timestamps.get(userId);
      if (current !== expectedExpiration) return;
    }

    timestamps.delete(userId);
  }

  clearCooldown(commandName: string, userId: string): void {
    const key = `${commandName}:${userId}`;
    const timer = this.timers.get(key);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(key);
    }
    const timestamps = this.cooldowns.get(commandName);
    if (timestamps) {
      timestamps.delete(userId);
    }
  }

  /**
   * Clear `key` and every key beneath it (`voice` also clears `voice record`
   * and `voice autojoin exclude`) for one user.
   */
  clearCooldownTree(key: string, userId: string): void {
    for (const commandKey of [...this.cooldowns.keys()]) {
      if (commandKey === key || commandKey.startsWith(`${key} `)) {
        this.clearCooldown(commandKey, userId);
      }
    }
  }

  clearAll(): void {
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
    this.cooldowns.clear();
  }

  getRemainingCooldown(commandName: string, userId: string): number {
    const timestamps = this.cooldowns.get(commandName);
    if (!timestamps) return 0;

    const expirationTime = timestamps.get(userId);
    if (!expirationTime) return 0;

    const remaining = expirationTime - Date.now();
    return remaining > 0 ? remaining : 0;
  }

  isOnCooldown(commandName: string, userId: string): boolean {
    return this.getRemainingCooldown(commandName, userId) > 0;
  }
}

export const cooldownStore = new CooldownStore();
