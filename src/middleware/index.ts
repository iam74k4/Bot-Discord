import { ChatInputCommandInteraction, MessageFlags } from 'discord.js';
import { Command, MiddlewareName } from '../shared/types/index.js';
import { permissionsMiddleware } from './permissions.js';
import { cooldownMiddleware } from './cooldown/index.js';
import { createWarningEmbed } from '../shared/utils/embed.js';
import { getErrorMessage, logger } from '../shared/utils/logger.js';
import { t, type TranslationKey } from '../locales/index.js';
import { resolveLocale } from '../locales/guildLocale.js';
import type { MiddlewareOutcome } from './types.js';

type BuiltInMiddleware = (
  interaction: ChatInputCommandInteraction,
  command: Command
) => Promise<MiddlewareOutcome>;

const middlewareRegistry: Record<MiddlewareName, BuiltInMiddleware> = {
  permissions: permissionsMiddleware,
  cooldown: cooldownMiddleware,
};

/** Heading for a rejection that did not bring its own title. */
const DEFAULT_TITLES: Record<MiddlewareName, TranslationKey> = {
  permissions: 'common.permissionDeniedTitle',
  cooldown: 'common.cooldownTitle',
};

/**
 * Run all middleware for a command.
 *
 * A rejection is answered privately with a warning, not an error: being
 * asked to wait or lacking a permission is not something that went wrong.
 * @returns true if all middleware passed, false otherwise
 */
export async function runMiddleware(
  interaction: ChatInputCommandInteraction,
  command: Command
): Promise<boolean> {
  const middlewareNames = command.middleware ?? [];

  for (const name of middlewareNames) {
    const middleware = middlewareRegistry[name];

    if (!middleware) {
      logger.warn(`Unknown middleware: ${name}`);
      continue;
    }

    const result = await middleware(interaction, command);

    if (!result.success) {
      const locale = resolveLocale(interaction);
      const embed = createWarningEmbed(
        result.title || t(DEFAULT_TITLES[name], locale),
        result.message || t('common.noPermission', locale)
      );

      try {
        if (interaction.deferred || interaction.replied) {
          await interaction.editReply({ embeds: [embed] });
        } else {
          await interaction.reply({
            embeds: [embed],
            flags: MessageFlags.Ephemeral,
          });
        }
      } catch (e: unknown) {
        logger.debug(
          `Failed to send middleware rejection: ${getErrorMessage(e)}`
        );
      }

      return false;
    }
  }

  return true;
}

export {
  clearCooldown,
  releaseCooldown,
  resolveCooldownMs,
} from './cooldown/index.js';
export type { MiddlewareOutcome } from './types.js';
