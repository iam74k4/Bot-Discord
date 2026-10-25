import {
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
  type Interaction,
  MessageFlags,
} from 'discord.js';
import type { ExtendedClient } from '../../client.js';
import { clearCooldown, runMiddleware } from '../../middleware/index.js';
import { getErrorMessage, logger } from '../../shared/utils/logger.js';
import { createErrorEmbed } from '../../shared/utils/embed.js';
import { metrics } from '../../infrastructure/metrics/index.js';
import { t } from '../../locales/index.js';
import { resolveLocale } from '../../locales/guildLocale.js';
import { isGuildAllowed } from '../guildAllowlist.js';

async function handleAutocompleteInteraction(
  client: ExtendedClient,
  interaction: AutocompleteInteraction
): Promise<void> {
  const command = client.commands.get(interaction.commandName);

  if (!command || !command.autocomplete) {
    await interaction.respond([]).catch((error: unknown) => {
      logger.debug(
        `Failed to respond to autocomplete: ${getErrorMessage(error)}`
      );
    });
    return;
  }

  try {
    await command.autocomplete(interaction);
  } catch (error) {
    logger.error(
      `Autocomplete error for ${interaction.commandName}:`,
      getErrorMessage(error)
    );
    await interaction.respond([]).catch((respondError: unknown) => {
      logger.debug(
        `Failed to respond to autocomplete error: ${getErrorMessage(respondError)}`
      );
    });
  }
}

async function handleUnknownCommand(
  interaction: ChatInputCommandInteraction
): Promise<void> {
  logger.warn(`Unknown command: ${interaction.commandName}`);
  const locale = resolveLocale(interaction);
  await interaction
    .reply({
      embeds: [
        createErrorEmbed(
          t('help.commandNotFound', locale),
          t('help.commandNotFoundDesc', locale, {
            command: interaction.commandName,
          })
        ),
      ],
      flags: MessageFlags.Ephemeral,
    })
    .catch((error: unknown) => {
      logger.debug(
        `Failed to reply unknown command: ${getErrorMessage(error)}`
      );
    });
}

async function handleCommandExecution(
  client: ExtendedClient,
  interaction: ChatInputCommandInteraction
): Promise<void> {
  const command = client.commands.get(interaction.commandName);

  if (!command) {
    await handleUnknownCommand(interaction);
    return;
  }

  try {
    const passed = await runMiddleware(interaction, command);
    if (!passed) return;

    await command.execute(interaction);
    metrics.incrementCommand(interaction.commandName);
    logger.debug(
      `Command executed: ${interaction.commandName} by ${interaction.user.tag}`
    );
  } catch (error) {
    if (command.middleware?.includes('cooldown')) {
      clearCooldown(command.data.name, interaction.user.id);
    }

    metrics.incrementError(interaction.commandName);
    logger.error(
      `Error executing command ${interaction.commandName}:`,
      getErrorMessage(error)
    );

    const locale = resolveLocale(interaction);
    const errorEmbed = createErrorEmbed(
      t('common.error', locale),
      t('common.unexpectedError', locale)
    );

    if (interaction.deferred || interaction.replied) {
      await interaction
        .editReply({ embeds: [errorEmbed] })
        .catch((replyError) => {
          logger.debug(
            `Failed to edit reply with error embed: ${getErrorMessage(replyError)}`
          );
        });
      return;
    }

    await interaction
      .reply({ embeds: [errorEmbed], flags: MessageFlags.Ephemeral })
      .catch((replyError: unknown) => {
        logger.debug(
          `Failed to reply with error embed: ${getErrorMessage(replyError)}`
        );
      });
  }
}

/**
 * A server outside ALLOWED_GUILD_IDS gets a short refusal rather than
 * silence, so whoever typed the command knows it is the bot's configuration
 * and not their permissions. See guildAllowlist.ts.
 */
async function refuseDisallowedGuild(
  interaction: ChatInputCommandInteraction
): Promise<void> {
  logger.debug(
    `Refused /${interaction.commandName} in ${interaction.guildId}: not in ALLOWED_GUILD_IDS`
  );
  const locale = resolveLocale(interaction);
  await interaction
    .reply({
      content: t('common.guildNotAllowed', locale),
      flags: MessageFlags.Ephemeral,
    })
    .catch((error: unknown) => {
      logger.debug(
        `Failed to refuse a disallowed server: ${getErrorMessage(error)}`
      );
    });
}

export async function routeInteraction(
  client: ExtendedClient,
  interaction: Interaction
): Promise<void> {
  if (!isGuildAllowed(interaction.guildId)) {
    if (interaction.isAutocomplete()) {
      await interaction.respond([]).catch((error: unknown) => {
        logger.debug(
          `Failed to respond to autocomplete: ${getErrorMessage(error)}`
        );
      });
    } else if (interaction.isChatInputCommand()) {
      await refuseDisallowedGuild(interaction);
    }
    return;
  }

  if (interaction.isAutocomplete()) {
    await handleAutocompleteInteraction(client, interaction);
    return;
  }

  if (!interaction.isChatInputCommand()) {
    return;
  }

  await handleCommandExecution(client, interaction);
}
