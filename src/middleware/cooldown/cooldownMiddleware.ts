import { ChatInputCommandInteraction } from 'discord.js';
import { Command } from '../../shared/types/index.js';
import { cooldownStore } from './cooldownStore.js';
import { t } from '../../locales/index.js';
import { resolveLocale } from '../../locales/guildLocale.js';
import {
  commandMention,
  commandPathOf,
} from '../../shared/utils/commandMentions.js';
import type { MiddlewareOutcome } from '../types.js';

const DEFAULT_COOLDOWN = 3000;

/**
 * The cooldown for one invoked path: the longest matching `cooldowns` key,
 * else the command's `cooldown`, else the default.
 */
export function resolveCooldownMs(command: Command, path: string): number {
  const perPath = command.options?.cooldowns;
  if (perPath) {
    const parts = path.split(' ');
    for (let length = parts.length; length > 0; length--) {
      const key = parts.slice(0, length).join(' ');
      if (Object.hasOwn(perPath, key)) return perPath[key];
    }
  }
  return command.options?.cooldown ?? DEFAULT_COOLDOWN;
}

/**
 * Per-user cooldown, keyed by the full subcommand path: running
 * `/voice status` does not hold up `/voice record`, and `/community poll
 * create` does not block `/community poll end`.
 *
 * The cooldown starts when the command is let through. A handler that turns
 * the request down before doing any work (not in a VC, invalid input) calls
 * `releaseCooldown(interaction)` so the user can fix it and retry at once.
 */
export async function cooldownMiddleware(
  interaction: ChatInputCommandInteraction,
  command: Command
): Promise<MiddlewareOutcome> {
  const path = commandPathOf(interaction);
  const cooldownAmount = resolveCooldownMs(command, path);

  if (cooldownAmount <= 0) {
    return { success: true };
  }

  const userId = interaction.user.id;

  const remainingMs = cooldownStore.getRemainingCooldown(path, userId);
  if (remainingMs > 0) {
    const locale = resolveLocale(interaction);
    return {
      success: false,
      title: t('common.cooldownTitle', locale),
      message: t('common.cooldown', locale, {
        // Whole seconds, rounded up: "0 seconds" would read as "now".
        seconds: Math.ceil(remainingMs / 1000),
        command: commandMention(path),
      }),
    };
  }

  cooldownStore.setCooldown(path, userId, cooldownAmount);

  return { success: true };
}

/**
 * Clear a user's cooldown for a command path and every path beneath it:
 * `clearCooldown('voice', id)` also frees `voice record`.
 */
export function clearCooldown(commandOrPath: string, userId: string): void {
  cooldownStore.clearCooldownTree(commandOrPath, userId);
}

/**
 * Give back the cooldown this interaction just started. Call it when a
 * command turns the request down before doing any real work - the user is
 * not in a VC, the input is invalid, nothing to pick from - so fixing the
 * problem and retrying is not met with "slow down". Do not call it once the
 * expensive part (a recording, an animation) has begun.
 */
export function releaseCooldown(interaction: {
  commandName: string;
  options?: unknown;
  user: { id: string };
}): void {
  cooldownStore.clearCooldown(commandPathOf(interaction), interaction.user.id);
}
