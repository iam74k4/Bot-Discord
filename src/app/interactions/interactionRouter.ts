import { performance } from 'node:perf_hooks';
import {
  type APIActionRowComponent,
  type APIComponentInMessageActionRow,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
  type Interaction,
  type MessageComponentInteraction,
  type ModalSubmitInteraction,
  ComponentType,
  MessageFlags,
} from 'discord.js';
import type { ExtendedClient } from '../../client.js';
import { releaseCooldown, runMiddleware } from '../../middleware/index.js';
import { getErrorMessage, logger } from '../../shared/utils/logger.js';
import { createErrorEmbed } from '../../shared/utils/embed.js';
import {
  commandMention,
  commandPathOf,
  originCommandPathOf,
} from '../../shared/utils/commandMentions.js';
import {
  createErrorId,
  describeError,
  findComponentHandler,
  isComponentRoutingReady,
  isLiveComponentMessage,
  isSettledComponentMessage,
  type ComponentRoute,
} from '../../shared/interactions/index.js';
import { metrics } from '../../infrastructure/metrics/index.js';
import { t } from '../../locales/index.js';
import { resolveLocale } from '../../locales/guildLocale.js';

/**
 * How long a click on an unclaimed message waits for something else to
 * answer it before the router does. Discord allows 3 s from the click; this
 * leaves room for gateway delivery, an event-loop stall and our own reply.
 */
export const COMPONENT_GRACE_MS = 1_500;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function handleAutocompleteInteraction(
  client: ExtendedClient,
  interaction: AutocompleteInteraction
): Promise<void> {
  metrics.noteInteraction(
    interaction.id,
    `autocomplete:${interaction.commandName}`
  );
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

/**
 * Tell the user a command failed, with a reference id that is in the log.
 *
 * A public result the command already posted (a roulette pick, a poll) is
 * left in place and the apology is sent privately next to it; a private
 * reply or a pending "thinking..." is replaced.
 */
async function reportCommandFailure(
  interaction: ChatInputCommandInteraction,
  errorId: string
): Promise<void> {
  const locale = resolveLocale(interaction);
  const errorEmbed = createErrorEmbed(
    t('common.error', locale),
    t('common.unexpectedError', locale, { id: errorId })
  );

  if (interaction.replied && interaction.ephemeral === false) {
    await interaction
      .followUp({ embeds: [errorEmbed], flags: MessageFlags.Ephemeral })
      .catch((replyError: unknown) => {
        logger.debug(
          `Failed to follow up with error embed: ${getErrorMessage(replyError)}`
        );
      });
    return;
  }

  if (interaction.deferred || interaction.replied) {
    await interaction
      .editReply({ embeds: [errorEmbed] })
      .catch((replyError: unknown) => {
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

async function handleCommandExecution(
  client: ExtendedClient,
  interaction: ChatInputCommandInteraction
): Promise<void> {
  const path = commandPathOf(interaction);
  metrics.noteInteraction(interaction.id, path || interaction.commandName);
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
    logger.debug(`Command executed: ${path} by ${interaction.user.tag}`);
  } catch (error) {
    // A failed run must not cost the user a cooldown.
    if (command.middleware?.includes('cooldown')) {
      releaseCooldown(interaction);
    }

    const errorId = createErrorId();
    metrics.incrementError(interaction.commandName);
    logger.error(
      `[${errorId}] Error executing command ${path}:`,
      describeError(error)
    );

    await reportCommandFailure(interaction, errorId);
  }
}

/** `settings-panel:audit` -> `settings-panel`, for metrics labels. */
function componentFamily(customId: string): string {
  return customId.split(/[:_]/)[0] || customId;
}

/** A buttons-and-selects message, rebuilt with every component disabled. */
function disabledRows(
  interaction: MessageComponentInteraction
): APIActionRowComponent<APIComponentInMessageActionRow>[] | null {
  const rows = interaction.message?.components ?? [];
  const json = rows.map((row) => row.toJSON());
  if (!json.every((row) => row.type === ComponentType.ActionRow)) return null;

  return (json as APIActionRowComponent<APIComponentInMessageActionRow>[]).map(
    (row) => ({
      ...row,
      components: row.components.map((component) => ({
        ...component,
        disabled: true,
      })),
    })
  );
}

/**
 * Answer a click nothing else will: the collector that owned the message is
 * gone (the bot restarted, or the panel closed and its components could not
 * be disabled). Grey the components out for everyone and tell the clicker
 * which command to run again.
 */
async function answerExpiredComponent(
  interaction: MessageComponentInteraction
): Promise<void> {
  const locale = resolveLocale(interaction);
  // The slash command (with subcommands) the message answered, if any.
  const origin = originCommandPathOf(interaction.message);
  const content = origin
    ? t('common.componentExpired', locale, { command: commandMention(origin) })
    : t('common.componentExpiredGeneric', locale);

  const rows = disabledRows(interaction);
  try {
    if (rows) {
      await interaction.update({ components: rows });
      await interaction.followUp({ content, flags: MessageFlags.Ephemeral });
      return;
    }
    await interaction.reply({ content, flags: MessageFlags.Ephemeral });
  } catch (error) {
    logger.debug(
      `Failed to answer an expired component: ${getErrorMessage(error)}`
    );
    if (!interaction.replied && !interaction.deferred) {
      await interaction
        .reply({ content, flags: MessageFlags.Ephemeral })
        .catch(() => undefined);
    }
  }
}

/**
 * A click the router cannot place while features are starting or stopping:
 * it may belong to a persistent button whose handler is not registered yet
 * (or any more), so the message is left exactly as it is and only the
 * clicker is asked to try again.
 */
async function answerNotReady(
  interaction: MessageComponentInteraction
): Promise<void> {
  await interaction
    .reply({
      content: t('common.componentNotReady', resolveLocale(interaction)),
      flags: MessageFlags.Ephemeral,
    })
    .catch((error: unknown) => {
      logger.debug(
        `Failed to answer a click during startup or shutdown: ${getErrorMessage(error)}`
      );
    });
}

/**
 * A late click on a panel or prompt that has just settled: its owner is
 * replacing the message with the next state, so acknowledge without touching
 * it. Rebuilding the rows from this click's snapshot would put the old
 * buttons back, and "run it again" would be wrong for an action that is
 * already running.
 */
async function acknowledgeSettled(
  interaction: MessageComponentInteraction
): Promise<void> {
  await interaction.deferUpdate().catch((error: unknown) => {
    logger.debug(
      `Failed to acknowledge a click on a settled message: ${getErrorMessage(error)}`
    );
  });
}

async function runPersistentHandler(
  route: ComponentRoute,
  interaction: MessageComponentInteraction
): Promise<void> {
  try {
    await route.handle(interaction);
  } catch (error) {
    const errorId = createErrorId();
    logger.error(
      `[${errorId}] Component handler ${route.prefix} failed:`,
      describeError(error)
    );
    const payload = {
      content: t('common.actionFailed', resolveLocale(interaction), {
        id: errorId,
      }),
      flags: MessageFlags.Ephemeral,
    } as const;
    const answer =
      interaction.replied || interaction.deferred
        ? interaction.followUp(payload)
        : interaction.reply(payload);
    await answer.catch((replyError: unknown) => {
      logger.debug(
        `Failed to report a failed component: ${getErrorMessage(replyError)}`
      );
    });
  }
}

/**
 * Buttons and selects, in order of who owns them:
 * 1. a live collector (open panel or confirmation) - left alone;
 * 2. a persistent handler registered by customId prefix;
 * 3. a panel or prompt that settled moments ago - acknowledged quietly;
 * 4. nobody. A message older than this process cannot have a collector
 *    here, so it is answered at once; otherwise the router first gives
 *    anything it does not know about `COMPONENT_GRACE_MS` to acknowledge the
 *    click, and steps in only if nothing did. Once every feature has
 *    registered its persistent handlers the answer is a friendly "expired"
 *    note with the components greyed out; before that (and from the start of
 *    shutdown) it is only a private "try again in a moment".
 */
async function handleComponentInteraction(
  interaction: MessageComponentInteraction
): Promise<void> {
  metrics.noteInteraction(
    interaction.id,
    `component:${componentFamily(interaction.customId)}`
  );

  const messageId = interaction.message?.id;
  if (messageId && isLiveComponentMessage(messageId)) return;

  const route = findComponentHandler(interaction.customId);
  if (route) {
    await runPersistentHandler(route, interaction);
    return;
  }

  if (messageId && isSettledComponentMessage(messageId)) {
    await acknowledgeSettled(interaction);
    return;
  }

  const createdAt = interaction.message?.createdTimestamp ?? 0;
  if (createdAt >= performance.timeOrigin) {
    await delay(COMPONENT_GRACE_MS);
    if (interaction.replied || interaction.deferred) return;
    if (messageId && isLiveComponentMessage(messageId)) return;
    if (messageId && isSettledComponentMessage(messageId)) {
      await acknowledgeSettled(interaction);
      return;
    }
  }

  if (!isComponentRoutingReady()) {
    await answerNotReady(interaction);
    return;
  }

  await answerExpiredComponent(interaction);
}

/**
 * A submitted form nobody is waiting for: the bot restarted while it was
 * open, or it stayed open past the time its opener waits. Whoever opened a
 * form awaits its submission directly (`awaitModalSubmit`) and answers at
 * once, so the router gives it `COMPONENT_GRACE_MS` and steps in only if
 * nothing did - otherwise Discord would show the user a bare "Something
 * went wrong" and the typed input would vanish without a word.
 */
async function handleModalSubmit(
  interaction: ModalSubmitInteraction
): Promise<void> {
  metrics.noteInteraction(
    interaction.id,
    `modal:${componentFamily(interaction.customId)}`
  );

  await delay(COMPONENT_GRACE_MS);
  if (interaction.replied || interaction.deferred) return;

  await interaction
    .reply({
      content: t('common.formExpired', resolveLocale(interaction)),
      flags: MessageFlags.Ephemeral,
    })
    .catch((error: unknown) => {
      logger.debug(
        `Failed to answer an unclaimed form: ${getErrorMessage(error)}`
      );
    });
}

export async function routeInteraction(
  client: ExtendedClient,
  interaction: Interaction
): Promise<void> {
  if (interaction.isAutocomplete()) {
    await handleAutocompleteInteraction(client, interaction);
    return;
  }

  if (interaction.isChatInputCommand()) {
    await handleCommandExecution(client, interaction);
    return;
  }

  // Checked last, and defensively: stand-ins for slash commands in tests do
  // not implement every type guard.
  if (
    typeof interaction.isMessageComponent === 'function' &&
    interaction.isMessageComponent()
  ) {
    await handleComponentInteraction(interaction);
    return;
  }

  if (
    typeof interaction.isModalSubmit === 'function' &&
    interaction.isModalSubmit()
  ) {
    await handleModalSubmit(interaction);
  }
}
