import {
  ChatInputCommandInteraction,
  InteractionReplyOptions,
  MessageComponentInteraction,
  MessageComponentType,
  MessageFlags,
} from 'discord.js';
import { getErrorMessage, logger } from './logger.js';
import { commandMention, commandPathOf } from './commandMentions.js';
import { t, type Locale } from '../../locales/index.js';
import { trackLiveComponents } from '../interactions/liveComponents.js';
import { createErrorId, describeError } from '../interactions/errors.js';

/** How long a panel waits for the next click before it closes. */
const DEFAULT_PANEL_IDLE = 120_000;

/**
 * Hard cap on a panel's life. The final edit that closes it goes through the
 * interaction token, which Discord expires after 15 minutes, so the panel
 * must close before that however busy it is.
 */
export const PANEL_MAX_LIFETIME = 14 * 60_000;

/** Ends after which there is no message left to edit. */
const SILENT_END_REASONS = new Set([
  'messageDelete',
  'channelDelete',
  'guildDelete',
  'threadDelete',
]);

/** What a panel renders: the same shape a reply takes. */
export type PanelPayload = Required<
  Pick<InteractionReplyOptions, 'embeds' | 'components'>
>;

/**
 * What the panel should do after a component was handled.
 * - `update`: re-render from current state (the common case)
 * - `handled`: the callback already responded, leave the message alone
 */
export type PanelOutcome = 'update' | 'handled';

export interface ComponentPanelOptions {
  interaction: ChatInputCommandInteraction;
  /**
   * Language of the panel's own notes (someone else's click, a failed
   * action, expiry). A function is read each time one is sent, for a panel
   * whose language can change while it is open.
   */
  locale: Locale | (() => Locale);
  /** Used in log messages so failures name the panel that produced them. */
  label: string;
  /** Current view of the panel; called for the first reply and each update. */
  render: () => PanelPayload | Promise<PanelPayload>;
  /** Same components, disabled, for when the panel expires. */
  renderDisabled: () => PanelPayload['components'];
  onComponent: (
    interaction: MessageComponentInteraction
  ) => PanelOutcome | Promise<PanelOutcome>;
  /**
   * Idle time in ms before the panel closes. Every click restarts it, so a
   * panel in use stays open (up to `PANEL_MAX_LIFETIME`).
   */
  timeout?: number;
  /** Panels are ephemeral unless a caller opts out (e.g. `/general help`). */
  ephemeral?: boolean;
  componentType?: MessageComponentType;
  /**
   * Command path to suggest once the panel has closed, and to point other
   * users at (`'admin settings view'`). Defaults to the command that opened
   * the panel.
   */
  reopenCommand?: string;
}

/**
 * Reply with an interactive panel and keep it in sync until it expires.
 *
 * Every panel in the bot needs the same scaffolding - reply, collect, turn
 * away other users, re-render, report a failed click, close when idle and
 * say so - and each one had grown its own copy. Panels now describe their
 * state (`render`) and their reaction to a component (`onComponent`); this
 * owns the lifecycle around them.
 */
export async function runComponentPanel(
  options: ComponentPanelOptions
): Promise<void> {
  const { interaction, label, render, renderDisabled, onComponent } = options;
  const localeOf = options.locale;
  const currentLocale = (): Locale =>
    typeof localeOf === 'function' ? localeOf() : localeOf;
  const ephemeral = options.ephemeral ?? true;
  const reopenPath = options.reopenCommand ?? commandPathOf(interaction);

  const initial = await render();
  const response = await interaction.reply({
    embeds: initial.embeds,
    components: initial.components,
    ...(ephemeral ? { flags: MessageFlags.Ephemeral } : {}),
    withResponse: true,
  });

  // Some transports (and test doubles) hand back no message to collect on;
  // there is nothing to keep in sync then.
  const message = response.resource?.message;
  if (typeof message?.createMessageComponentCollector !== 'function') {
    return;
  }

  const collector = message.createMessageComponentCollector({
    ...(options.componentType === undefined
      ? {}
      : { componentType: options.componentType }),
    idle: options.timeout ?? DEFAULT_PANEL_IDLE,
    time: PANEL_MAX_LIFETIME,
  });

  // While the collector runs, the interaction router leaves this message's
  // components to it; shutdown stops it so the panel closes visibly.
  let markEnded: () => void = () => undefined;
  const ended = new Promise<void>((resolve) => {
    markEnded = resolve;
  });
  const untrack =
    typeof message.id === 'string'
      ? trackLiveComponents(message.id, {
          stop: (reason) => collector.stop(reason),
          ended,
        })
      : () => undefined;

  collector.on('collect', async (componentInteraction) => {
    if (componentInteraction.user.id !== interaction.user.id) {
      await componentInteraction
        .reply({
          content: t('common.onlyCommandUser', currentLocale(), {
            user: `<@${interaction.user.id}>`,
            command: commandMention(reopenPath || interaction.commandName),
          }),
          flags: MessageFlags.Ephemeral,
          allowedMentions: { parse: [] },
        })
        .catch((error: unknown) => {
          logger.debug(
            `Failed to reject other user on ${label}: ${getErrorMessage(error)}`
          );
        });
      return;
    }

    try {
      if ((await onComponent(componentInteraction)) === 'handled') {
        return;
      }

      const next = await render();
      await componentInteraction.update({
        embeds: next.embeds,
        components: next.components,
      });
    } catch (error) {
      // Tell the user the click did not take, with a reference to the log.
      const errorId = createErrorId();
      logger.warn(
        `[${errorId}] Failed to update ${label}:`,
        describeError(error)
      );
      const payload = {
        content: t('common.actionFailed', currentLocale(), { id: errorId }),
        flags: MessageFlags.Ephemeral,
      } as const;
      const answer =
        componentInteraction.replied || componentInteraction.deferred
          ? componentInteraction.followUp(payload)
          : componentInteraction.reply(payload);
      await answer.catch((replyError: unknown) => {
        logger.debug(
          `Failed to report a failed click on ${label}: ${getErrorMessage(replyError)}`
        );
      });
    }
  });

  collector.on('end', async (_collected, reason) => {
    untrack();
    try {
      if (SILENT_END_REASONS.has(reason)) return;

      await interaction
        .editReply({
          content: reopenPath
            ? t('common.panelExpired', currentLocale(), {
                command: commandMention(reopenPath),
              })
            : t('common.panelExpiredGeneric', currentLocale()),
          components: renderDisabled(),
        })
        .catch((error: unknown) => {
          logger.debug(
            `Failed to disable ${label} components: ${getErrorMessage(error)}`
          );
        });
    } finally {
      markEnded();
    }
  });
}
