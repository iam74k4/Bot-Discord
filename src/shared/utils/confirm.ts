import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  ChatInputCommandInteraction,
  ComponentType,
  MessageFlags,
  type MessageComponentInteraction,
} from 'discord.js';
import { createInfoEmbed, createWarningEmbed } from './embed.js';
import {
  commandMention,
  commandPathOf,
  originCommandPathOf,
} from './commandMentions.js';
import { getErrorMessage, logger } from './logger.js';
import { t, type Locale } from '../../locales/index.js';
import { resolveLocale } from '../../locales/guildLocale.js';
import { trackLiveComponents } from '../interactions/liveComponents.js';

const DEFAULT_TIMEOUT = 30_000;

export interface ConfirmationOptions {
  /** How long to wait for a press, in ms (default 30 s). */
  timeout?: number;
  ephemeral?: boolean;
  /**
   * Heading that says what is about to happen, e.g. 「この投票を締め切りますか？」.
   * Defaults to the generic 「本当に実行しますか？」.
   */
  title?: string;
  /** Verb for the confirm button, e.g. 「締め切る」. Defaults to 「確認」. */
  confirmLabel?: string;
  /**
   * Danger (default) for destructive or irreversible actions; Primary or
   * Success for safe ones such as taking a backup.
   */
  confirmStyle?:
    | ButtonStyle.Primary
    | ButtonStyle.Secondary
    | ButtonStyle.Success
    | ButtonStyle.Danger;
  confirmEmoji?: string;
  /** Label for the cancel button, e.g. 「やめる」. Defaults to 「キャンセル」. */
  cancelLabel?: string;
  /**
   * Command to suggest after a timeout. Defaults to the slash command that
   * asked for the confirmation.
   */
  retryCommand?: string;
}

export type ConfirmationOutcome = 'confirmed' | 'cancelled' | 'timeout';

/**
 * - `confirmed`: `response` is the button press, NOT yet acknowledged. The
 *   caller must answer it within 3 seconds, normally with a single
 *   `response.update({ ... })` that shows progress or the result - doing the
 *   work first leaves the user with "This interaction failed".
 * - `cancelled` / `timeout`: the prompt has already been updated to say so;
 *   the caller just returns. `timeout` also covers a prompt closed because
 *   the bot is shutting down: either way nothing was done.
 */
export type ConfirmationResult =
  | { outcome: 'confirmed'; response: ButtonInteraction }
  | { outcome: 'cancelled' }
  | { outcome: 'timeout' };

type PromptInteraction = ChatInputCommandInteraction | ButtonInteraction;

interface Prompt {
  locale: Locale;
  timeoutMs: number;
  confirmId: string;
  row: ActionRowBuilder<ButtonBuilder>;
}

function buildPrompt(
  interaction: PromptInteraction,
  options: ConfirmationOptions
): Prompt {
  const locale = resolveLocale(interaction);
  const confirmId = `confirm_${interaction.id}`;
  const cancelId = `cancel_${interaction.id}`;

  const confirmButton = new ButtonBuilder()
    .setCustomId(confirmId)
    .setLabel(options.confirmLabel ?? t('common.confirm', locale))
    .setStyle(options.confirmStyle ?? ButtonStyle.Danger);
  if (options.confirmEmoji) confirmButton.setEmoji(options.confirmEmoji);

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    confirmButton,
    new ButtonBuilder()
      .setCustomId(cancelId)
      .setLabel(options.cancelLabel ?? t('common.cancel', locale))
      .setStyle(ButtonStyle.Secondary)
  );

  return {
    locale,
    timeoutMs: options.timeout ?? DEFAULT_TIMEOUT,
    confirmId,
    row,
  };
}

function disabledRow(
  row: ActionRowBuilder<ButtonBuilder>
): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    row.components.map((button) =>
      ButtonBuilder.from(button.toJSON()).setDisabled(true)
    )
  );
}

/** Politely turn away someone pressing another user's prompt. */
async function rejectOtherUser(
  press: MessageComponentInteraction,
  owner: PromptInteraction,
  locale: Locale
): Promise<void> {
  const path = retryPathOf(owner);
  const user = `<@${owner.user.id}>`;
  try {
    await press.reply({
      content: path
        ? t('common.onlyCommandUser', locale, {
            user,
            command: commandMention(path),
          })
        : t('common.onlyCommandUserGeneric', locale, { user }),
      flags: MessageFlags.Ephemeral,
      allowedMentions: { parse: [] },
    });
  } catch (error) {
    logger.debug(
      `Failed to turn away another user's press: ${getErrorMessage(error)}`
    );
  }
}

/** The slash command behind a prompt, to suggest when it times out. */
function retryPathOf(interaction: PromptInteraction): string {
  if (
    'commandName' in interaction &&
    typeof interaction.commandName === 'string'
  ) {
    return commandPathOf(interaction);
  }
  // A prompt opened from a panel button: the command that opened the panel.
  return originCommandPathOf((interaction as { message?: unknown }).message);
}

/** Why there is no press to act on. */
type NoPressReason = 'timeout' | 'shutdown';

type Wait =
  | { press: ButtonInteraction }
  | { press: null; reason: NoPressReason };

/** A promise plus the function that settles it. */
function settleable(): { promise: Promise<void>; settle: () => void } {
  let settle: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    settle = resolve;
  });
  return { promise, settle };
}

/**
 * Post the prompt and wait for the invoking user's press.
 *
 * While waiting, the prompt is registered as live: the router leaves its
 * buttons to us, and shutdown can close it (`stopLiveComponents`), which
 * ends the wait with reason `shutdown`. `ended` is what shutdown then waits
 * for: the caller settles it once the prompt shows its final state.
 */
async function postAndWait(
  interaction: PromptInteraction,
  message: string,
  prompt: Prompt,
  options: ConfirmationOptions,
  ended: Promise<void>
): Promise<Wait> {
  const ephemeral = options.ephemeral ?? true;
  const embed = createWarningEmbed(
    options.title ?? t('common.confirmMessage', prompt.locale),
    message
  );

  const response = await interaction.reply({
    embeds: [embed],
    components: [prompt.row],
    flags: ephemeral ? MessageFlags.Ephemeral : undefined,
    withResponse: true,
  });

  const sent = response.resource?.message;
  if (!sent) return { press: null, reason: 'timeout' };

  let closed = false;
  let accepted = false;
  let stop: (reason: string) => void = () => undefined;
  const stopped = new Promise<Wait>((resolve) => {
    stop = () => {
      closed = true;
      resolve({ press: null, reason: 'shutdown' });
    };
  });

  const untrack =
    typeof sent.id === 'string'
      ? trackLiveComponents(sent.id, { stop, ended })
      : () => undefined;

  const pressed: Promise<Wait> = sent
    .awaitMessageComponent({
      componentType: ComponentType.Button,
      filter: async (press) => {
        if (press.user.id !== interaction.user.id) {
          await rejectOtherUser(press, interaction, prompt.locale);
          return false;
        }
        // Closed by shutdown: the router answers anything still arriving.
        if (closed) return false;
        if (accepted) {
          // A second press while the first is handled (a double click):
          // acknowledge it and let the first one decide.
          await press.deferUpdate().catch((error: unknown) => {
            logger.debug(
              `Failed to acknowledge a repeated press: ${getErrorMessage(error)}`
            );
          });
          return false;
        }
        accepted = true;
        return true;
      },
      time: prompt.timeoutMs,
    })
    .then(
      (press): Wait => {
        if (closed) {
          // Pressed just as shutdown closed the prompt; nothing will run.
          press.deferUpdate().catch(() => undefined);
          return { press: null, reason: 'shutdown' };
        }
        return { press };
      },
      (): Wait => ({ press: null, reason: 'timeout' })
    );

  try {
    return await Promise.race([pressed, stopped]);
  } finally {
    untrack();
  }
}

/** The prompt's last state when it closed without a press. */
function closedEmbed(reason: NoPressReason, prompt: Prompt, path: string) {
  if (reason === 'shutdown') {
    return createInfoEmbed(
      t('common.promptClosedTitle', prompt.locale),
      path
        ? t('common.confirmInterruptedRetry', prompt.locale, {
            command: commandMention(path),
          })
        : t('common.confirmInterrupted', prompt.locale)
    );
  }

  const seconds = Math.round(prompt.timeoutMs / 1000);
  return createInfoEmbed(
    t('common.timedOutTitle', prompt.locale),
    path
      ? t('common.confirmTimedOutRetry', prompt.locale, {
          seconds,
          command: commandMention(path),
        })
      : t('common.confirmTimedOut', prompt.locale, { seconds })
  );
}

/**
 * Ask the invoking user to confirm, and report exactly what happened.
 *
 * Cancel and timeout are answered here (the prompt says "cancelled" or "timed
 * out - nothing was done"); on confirm the press is handed back unanswered so
 * the caller can acknowledge it with the next state in one round trip.
 *
 * The interaction must not have been replied to or deferred yet.
 */
export async function awaitConfirmationResult(
  interaction: PromptInteraction,
  message: string,
  options: ConfirmationOptions = {}
): Promise<ConfirmationResult> {
  const prompt = buildPrompt(interaction, options);
  const ended = settleable();

  try {
    const wait = await postAndWait(
      interaction,
      message,
      prompt,
      options,
      ended.promise
    );

    if (!wait.press) {
      const path = options.retryCommand ?? retryPathOf(interaction);
      await interaction
        .editReply({
          embeds: [closedEmbed(wait.reason, prompt, path)],
          components: [],
        })
        .catch((error: unknown) => {
          logger.debug(
            `Failed to mark a confirmation closed: ${getErrorMessage(error)}`
          );
        });
      return { outcome: 'timeout' };
    }

    const { press } = wait;
    if (press.customId !== prompt.confirmId) {
      await press
        .update({
          embeds: [createInfoEmbed(t('common.cancelled', prompt.locale))],
          components: [],
        })
        .catch((error: unknown) => {
          logger.debug(
            `Failed to acknowledge a cancelled confirmation: ${getErrorMessage(error)}`
          );
        });
      return { outcome: 'cancelled' };
    }

    return { outcome: 'confirmed', response: press };
  } finally {
    ended.settle();
  }
}

/**
 * Show a confirmation dialog with Confirm and Cancel buttons.
 * Returns true if the user confirmed, false if cancelled or timed out.
 * The interaction must not have been replied to or deferred yet.
 *
 * @deprecated Use `awaitConfirmationResult`: it tells a timeout from a
 * cancel and saves a round trip after the press. This wrapper acknowledges
 * the press by disabling the buttons, so the caller's `editReply` is a second
 * request.
 */
export async function awaitConfirmation(
  interaction: PromptInteraction,
  message: string,
  options: ConfirmationOptions = {}
): Promise<boolean> {
  const prompt = buildPrompt(interaction, options);
  const disabled = disabledRow(prompt.row);
  const ended = settleable();

  try {
    const { press } = await postAndWait(
      interaction,
      message,
      prompt,
      options,
      ended.promise
    );

    if (press) {
      try {
        await press.update({ components: [disabled] });
        return press.customId === prompt.confirmId;
      } catch {
        // Fail closed: an unacknowledged confirm must not run the action.
      }
    }

    await interaction.editReply({ components: [disabled] }).catch(() => {});
    return false;
  } finally {
    ended.settle();
  }
}
