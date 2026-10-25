import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  CheckboxBuilder,
  ChatInputCommandInteraction,
  ComponentType,
  DiscordAPIError,
  DiscordjsError,
  DiscordjsErrorCodes,
  LabelBuilder,
  MessageFlags,
  ModalBuilder,
  RadioGroupBuilder,
  RESTJSONErrorCodes,
  TextInputBuilder,
  TextInputStyle,
  escapeMarkdown,
  type AutocompleteInteraction,
  type ButtonInteraction,
  type InteractionReplyOptions,
  type Message,
  type ModalSubmitInteraction,
  type Poll,
  type PollAnswerData,
} from 'discord.js';
import { awaitConfirmationResult } from '../../../shared/utils/confirm.js';
import { commandMention } from '../../../shared/utils/commandMentions.js';
import { COLORS } from '../../../shared/utils/constants/index.js';
import { createEmbed, createErrorEmbed } from '../../../shared/utils/embed.js';
import { getErrorMessage, logger } from '../../../shared/utils/logger.js';
import {
  createErrorId,
  describeError,
  trackLiveComponents,
} from '../../../shared/interactions/index.js';
import { releaseCooldown } from '../../../middleware/index.js';
import { t, type Locale, type TranslationKey } from '../../../locales/index.js';
import { formatDuration } from '../../../locales/format.js';
import { resolveLocale } from '../../../locales/guildLocale.js';
import { pollRepository, type PollRecord } from './pollRepository.js';

/** Highest option slot offered by `/community poll create`. */
const MAX_POLL_OPTIONS = 10;
/** Discord's limit on a poll question. */
const MAX_QUESTION_LENGTH = 300;
/** Discord's limit on each poll answer. Exported for the test that pins it. */
export const MAX_ANSWER_LENGTH = 55;
/** Used when the creator does not pick a duration. */
const DEFAULT_POLL_DURATION_HOURS = 24;
/**
 * Room for ten full-length answers, their line breaks and some slack; longer
 * lines are reported one by one rather than cut off by the text box.
 */
const MAX_OPTIONS_TEXT_LENGTH = 1000;
/** How long the form waits to be submitted. Dismissing it sends nothing. */
const MODAL_TIMEOUT_MS = 10 * 60_000;
/** How long "edit and try again" stays pressable under a rejected form. */
const RETRY_TIMEOUT_MS = 5 * 60_000;
/** Discord's cap on autocomplete choices. */
const MAX_CHOICES = 25;
const MAX_CHOICE_NAME_LENGTH = 100;
/**
 * How many of the caller's newest polls autocomplete reads before filtering
 * by what was typed, so typing can find polls beyond the first page.
 */
const AUTOCOMPLETE_WINDOW = 100;

const HOUR_MS = 60 * 60 * 1000;

/** The durations the form offers, matching the slash command's choices. */
const POLL_DURATIONS: ReadonlyArray<{ hours: number; label: TranslationKey }> =
  [
    { hours: 1, label: 'poll.durations.oneHour' },
    { hours: 4, label: 'poll.durations.fourHours' },
    { hours: 8, label: 'poll.durations.eightHours' },
    { hours: 24, label: 'poll.durations.oneDay' },
    { hours: 72, label: 'poll.durations.threeDays' },
    { hours: 168, label: 'poll.durations.sevenDays' },
  ];

/** The durations offered, in hours; the slash choices must be the same. */
export const POLL_DURATION_HOURS: readonly number[] = POLL_DURATIONS.map(
  (d) => d.hours
);

/** Custom ids of the form's fields. */
export const POLL_FORM_FIELDS = {
  question: 'question',
  options: 'options',
  duration: 'duration',
  multi: 'multi',
} as const;

/**
 * Read and validate the answers, or explain what is wrong.
 *
 * Discord rejects an over-long answer with an opaque API error, so the same
 * limits are checked here where the reply can name the problem.
 */
export function collectAnswers(
  optionAt: (index: number) => string | null
): { answers: PollAnswerData[] } | { error: 'tooLong' | 'notEnough' } {
  const answers: PollAnswerData[] = [];

  for (let i = 1; i <= MAX_POLL_OPTIONS; i++) {
    const option = optionAt(i);
    if (!option) continue;
    if (option.length > MAX_ANSWER_LENGTH) return { error: 'tooLong' };
    answers.push({ text: option });
  }

  if (answers.length < 2) return { error: 'notEnough' };
  return { answers };
}

export type AnswerLinesProblem =
  | { error: 'notEnough' }
  | { error: 'tooMany'; count: number }
  | { error: 'lineTooLong'; line: number; length: number };

/**
 * The form's answers: one per line, trimmed, blank lines and repeats dropped.
 * A problem names the line it is on, counted the way the user sees the text.
 */
export function parseAnswerLines(
  text: string
): { answers: PollAnswerData[] } | AnswerLinesProblem {
  const answers: PollAnswerData[] = [];
  const seen = new Set<string>();
  const lines = text.split(/\r?\n/);

  for (const [index, raw] of lines.entries()) {
    const option = raw.trim();
    if (!option || seen.has(option)) continue;
    if (option.length > MAX_ANSWER_LENGTH) {
      return { error: 'lineTooLong', line: index + 1, length: option.length };
    }
    seen.add(option);
    answers.push({ text: option });
  }

  if (answers.length > MAX_POLL_OPTIONS) {
    return { error: 'tooMany', count: answers.length };
  }
  if (answers.length < 2) return { error: 'notEnough' };
  return { answers };
}

function describeAnswerProblem(
  problem: AnswerLinesProblem,
  locale: Locale
): string {
  switch (problem.error) {
    case 'lineTooLong':
      return t('poll.errors.optionLineTooLong', locale, {
        line: problem.line,
        length: problem.length,
      });
    case 'tooMany':
      return t('poll.errors.tooManyOptions', locale, { count: problem.count });
    case 'notEnough':
      return t('poll.errors.notEnoughOptions', locale);
  }
}

async function replyError(
  interaction: ChatInputCommandInteraction,
  locale: Locale,
  titleKey: TranslationKey,
  body: string
): Promise<void> {
  await interaction.reply({
    embeds: [createErrorEmbed(t(titleKey, locale), body)],
    flags: MessageFlags.Ephemeral,
  });
}

interface PollSpec {
  question: string;
  answers: PollAnswerData[];
  hours: number;
  allowMultiselect: boolean;
}

/**
 * Post the poll as the reply to `responder` and keep a pointer to it.
 *
 * Discord renders, tallies and closes the poll; the reply is the poll. The
 * creator then gets a private note on how to close it early, which nothing
 * else in the flow tells them.
 */
async function postPoll(
  responder: ChatInputCommandInteraction | ModalSubmitInteraction,
  spec: PollSpec,
  locale: Locale
): Promise<void> {
  const response = await responder.reply({
    poll: {
      question: { text: spec.question },
      answers: spec.answers,
      duration: spec.hours,
      allowMultiselect: spec.allowMultiselect,
    },
    withResponse: true,
  });

  const message = response.resource?.message;
  if (!message) {
    logger.error('Poll created but Discord returned no message to track');
    return;
  }

  // Only a pointer for `/community poll end`; the poll survives without it.
  try {
    pollRepository.create({
      message_id: message.id,
      guild_id: responder.guildId ?? '',
      channel_id: responder.channelId ?? message.channelId,
      creator_id: responder.user.id,
      expires_at: Date.now() + spec.hours * HOUR_MS,
    });
  } catch (error) {
    logger.warn(`Failed to record poll message: ${getErrorMessage(error)}`);
  }

  logger.info(
    `Poll created: "${spec.question}" with ${spec.answers.length} answers by ${responder.user.tag}`
  );

  await responder
    .followUp({
      content: t('poll.createdHint', locale, {
        command: commandMention('community poll end'),
      }),
      flags: MessageFlags.Ephemeral,
    })
    .catch((error: unknown) => {
      logger.debug(`Failed to send the poll hint: ${getErrorMessage(error)}`);
    });
}

/** What the form is prefilled with, and what a rejected form gave back. */
interface PollDraft {
  question: string;
  optionsText: string;
  hours: number;
  allowMultiselect: boolean;
}

function buildCreateModal(
  customId: string,
  draft: PollDraft,
  locale: Locale
): ModalBuilder {
  const question = new TextInputBuilder()
    .setCustomId(POLL_FORM_FIELDS.question)
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMinLength(1)
    .setMaxLength(MAX_QUESTION_LENGTH);
  if (draft.question) {
    question.setValue(draft.question.slice(0, MAX_QUESTION_LENGTH));
  }

  const options = new TextInputBuilder()
    .setCustomId(POLL_FORM_FIELDS.options)
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(true)
    .setMaxLength(MAX_OPTIONS_TEXT_LENGTH)
    .setPlaceholder(t('poll.modal.optionsPlaceholder', locale));
  if (draft.optionsText) {
    options.setValue(draft.optionsText.slice(0, MAX_OPTIONS_TEXT_LENGTH));
  }

  const duration = new RadioGroupBuilder()
    .setCustomId(POLL_FORM_FIELDS.duration)
    .setRequired(true)
    .setOptions(
      POLL_DURATIONS.map(({ hours, label }) => ({
        label: t(label, locale),
        value: String(hours),
        default: hours === draft.hours,
      }))
    );

  const multi = new CheckboxBuilder()
    .setCustomId(POLL_FORM_FIELDS.multi)
    .setDefault(draft.allowMultiselect);

  return new ModalBuilder()
    .setCustomId(customId)
    .setTitle(t('poll.modal.title', locale))
    .addLabelComponents(
      new LabelBuilder()
        .setLabel(t('poll.modal.question', locale))
        .setTextInputComponent(question),
      new LabelBuilder()
        .setLabel(t('poll.modal.options', locale))
        .setDescription(t('poll.modal.optionsDescription', locale))
        .setTextInputComponent(options),
      new LabelBuilder()
        .setLabel(t('poll.modal.duration', locale))
        .setRadioGroupComponent(duration),
      new LabelBuilder()
        .setLabel(t('poll.modal.multi', locale))
        .setCheckboxComponent(multi)
    );
}

/** A field the client left out reads as `fallback` rather than throwing. */
function readField<T>(read: () => T | null, fallback: T): T {
  try {
    return read() ?? fallback;
  } catch {
    return fallback;
  }
}

function readDraft(
  submit: ModalSubmitInteraction,
  previous: PollDraft
): PollDraft {
  const fields = submit.fields;
  const hours = Number(
    readField(() => fields.getRadioGroup(POLL_FORM_FIELDS.duration), '')
  );
  return {
    question: readField(
      () => fields.getTextInputValue(POLL_FORM_FIELDS.question),
      ''
    ).trim(),
    optionsText: readField(
      () => fields.getTextInputValue(POLL_FORM_FIELDS.options),
      ''
    ),
    hours: POLL_DURATION_HOURS.includes(hours) ? hours : previous.hours,
    allowMultiselect: readField(
      () => fields.getCheckbox(POLL_FORM_FIELDS.multi),
      previous.allowMultiselect
    ),
  };
}

/** The poll a submitted form describes, or what is wrong with it. */
function validateDraft(
  draft: PollDraft,
  locale: Locale
): { spec: PollSpec } | { problem: string } {
  if (!draft.question) {
    return { problem: t('poll.errors.questionMissing', locale) };
  }
  const parsed = parseAnswerLines(draft.optionsText);
  if ('error' in parsed) {
    return { problem: describeAnswerProblem(parsed, locale) };
  }
  return {
    spec: {
      question: draft.question,
      answers: parsed.answers,
      hours: draft.hours,
      allowMultiselect: draft.allowMultiselect,
    },
  };
}

/**
 * Turn a rejected form into a private note with an "edit and try again"
 * button, and wait for the press. The press comes back unanswered so the
 * caller can reopen the form with it; null when the user lets it lapse.
 */
async function offerRetry(
  submit: ModalSubmitInteraction,
  problem: string,
  locale: Locale
): Promise<ButtonInteraction | null> {
  const retryId = `poll-create-retry:${submit.id}`;
  const response = await submit.reply({
    embeds: [
      createErrorEmbed(
        t('poll.errors.createFailed', locale),
        `${problem}\n${t('poll.modal.retryHint', locale)}`
      ),
    ],
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(retryId)
          .setLabel(t('poll.modal.retry', locale))
          .setStyle(ButtonStyle.Primary)
      ),
    ],
    flags: MessageFlags.Ephemeral,
    withResponse: true,
  });

  const message = response.resource?.message;
  if (typeof message?.awaitMessageComponent !== 'function') return null;

  // The router leaves this button to us while we wait for it.
  const untrack =
    typeof message.id === 'string'
      ? trackLiveComponents(message.id)
      : () => undefined;

  let press: ButtonInteraction | null = null;
  try {
    press = await message.awaitMessageComponent({
      componentType: ComponentType.Button,
      filter: (i) => i.customId === retryId && i.user.id === submit.user.id,
      time: RETRY_TIMEOUT_MS,
    });
  } catch {
    // Lapsed: the note stays, without a button nothing answers any more.
  } finally {
    untrack();
  }

  const retired = submit
    .editReply({ components: [] })
    .catch((error: unknown) => {
      logger.debug(
        `Failed to retire the retry button: ${getErrorMessage(error)}`
      );
    });
  // A press is answered by reopening the form, which has to happen within
  // 3 s, so the button is retired alongside rather than first.
  if (!press) await retired;
  return press;
}

/** Answer a submission the flow failed on; the router cannot reach it. */
async function reportFormFailure(
  submit: ModalSubmitInteraction,
  error: unknown,
  locale: Locale
): Promise<void> {
  const errorId = createErrorId();
  logger.error(
    `[${errorId}] Failed to create a poll from the form:`,
    describeError(error)
  );
  const payload: InteractionReplyOptions = {
    embeds: [
      createErrorEmbed(
        t('common.error', locale),
        t('common.unexpectedError', locale, { id: errorId })
      ),
    ],
    flags: MessageFlags.Ephemeral,
  };
  await (
    submit.replied || submit.deferred
      ? submit.followUp(payload)
      : submit.reply(payload)
  ).catch((replyError: unknown) => {
    logger.debug(
      `Failed to report a failed poll form: ${getErrorMessage(replyError)}`
    );
  });
}

/**
 * Open the form and post the poll it describes. A rejected form explains the
 * problem and offers to reopen the form with what was typed, so a long list
 * of options is never lost to one over-long line.
 */
async function createPollFromModal(
  opener: ChatInputCommandInteraction | ButtonInteraction,
  draft: PollDraft,
  locale: Locale
): Promise<void> {
  const modalId = `poll-create:${opener.id}`;
  await opener.showModal(buildCreateModal(modalId, draft, locale));

  let submit: ModalSubmitInteraction;
  try {
    submit = await opener.awaitModalSubmit({
      time: MODAL_TIMEOUT_MS,
      filter: (i) => i.customId === modalId && i.user.id === opener.user.id,
    });
  } catch (error) {
    // Dismissed, or left open too long: Discord shows nothing, nor do we.
    logger.debug(`Poll form not submitted: ${getErrorMessage(error)}`);
    return;
  }

  const next = readDraft(submit, draft);

  try {
    const checked = validateDraft(next, locale);
    if ('problem' in checked) {
      const retry = await offerRetry(submit, checked.problem, locale);
      if (retry) await createPollFromModal(retry, next, locale);
      return;
    }

    await postPoll(submit, checked.spec, locale);
  } catch (error) {
    // The command's own response was the form, so the router could not show
    // this failure anywhere; answer on the submission instead.
    await reportFormFailure(submit, error, locale);
  }
}

async function handleCreatePoll(
  interaction: ChatInputCommandInteraction
): Promise<void> {
  const locale = resolveLocale(interaction);
  const question = interaction.options.getString('question', true);
  const hours =
    interaction.options.getInteger('duration') ?? DEFAULT_POLL_DURATION_HOURS;
  const allowMultiselect = interaction.options.getBoolean('multi') ?? false;

  const slots = Array.from({ length: MAX_POLL_OPTIONS }, (_, i) =>
    interaction.options.getString(`option${i + 1}`)
  );
  const given = slots.filter((option): option is string => Boolean(option));

  // Typing ten separate option fields is slow, on a phone above all; with
  // fewer than two given, the form takes them one per line instead.
  if (given.length < 2) {
    // The cooldown stays: every poll from the form takes opening one, so it
    // limits both, and each form left open waits ten minutes for its submit.
    await createPollFromModal(
      interaction,
      { question, optionsText: given.join('\n'), hours, allowMultiselect },
      locale
    );
    return;
  }

  if (question.length > MAX_QUESTION_LENGTH) {
    releaseCooldown(interaction);
    await replyError(
      interaction,
      locale,
      'poll.errors.createFailed',
      t('poll.errors.questionTooLong', locale)
    );
    return;
  }

  const collected = collectAnswers((index) => slots[index - 1]);
  if ('error' in collected) {
    releaseCooldown(interaction);
    await replyError(
      interaction,
      locale,
      'poll.errors.createFailed',
      t(
        collected.error === 'tooLong'
          ? 'poll.errors.optionTooLong'
          : 'poll.errors.notEnoughOptions',
        locale
      )
    );
    return;
  }

  await postPoll(
    interaction,
    { question, answers: collected.answers, hours, allowMultiselect },
    locale
  );
}

/** Why a poll cannot be reached or ended. */
type PollProblem =
  /** The message or channel is gone, or Discord already closed the poll. */
  | 'gone'
  /** The bot may not read the channel; an admin can fix that, so keep it. */
  | 'noAccess'
  /** Anything else, presumably passing: keep the pointer for a retry. */
  | 'unavailable';

function classifyPollError(error: unknown): PollProblem {
  // discord.js refuses, without asking Discord, to end a poll past its
  // deadline - as when it closes while the confirmation is up.
  if (
    error instanceof DiscordjsError &&
    error.code === DiscordjsErrorCodes.PollAlreadyExpired
  ) {
    return 'gone';
  }
  if (!(error instanceof DiscordAPIError)) return 'unavailable';
  switch (error.code) {
    case RESTJSONErrorCodes.UnknownMessage:
    case RESTJSONErrorCodes.UnknownChannel:
    case RESTJSONErrorCodes.PollExpired:
    case RESTJSONErrorCodes.CannotExpireANonPollMessage:
      return 'gone';
    case RESTJSONErrorCodes.MissingAccess:
    case RESTJSONErrorCodes.MissingPermissions:
      return 'noAccess';
    default:
      return 'unavailable';
  }
}

/**
 * Which of the caller's polls `/community poll end` is about: the one picked
 * in the `poll` option, else the newest in this channel, else the newest
 * anywhere in this server. `picked` tells a pick that matches none of the
 * caller's open polls (typed text, or a poll that closed since it was
 * suggested) from having no open poll at all.
 */
function findPollToEnd(
  interaction: ChatInputCommandInteraction
): { record: PollRecord } | { notFound: 'picked' | 'none' } {
  const userId = interaction.user.id;
  const guildId = interaction.guildId ?? '';

  const chosen = interaction.options.getString('poll');
  if (chosen) {
    const record = pollRepository.findActive(chosen);
    return record?.creator_id === userId && record.guild_id === guildId
      ? { record }
      : { notFound: 'picked' };
  }

  const record =
    pollRepository.findActiveByCreator(userId, interaction.channelId) ??
    (guildId
      ? pollRepository.findActiveByCreatorInGuild(userId, guildId)
      : null);
  return record ? { record } : { notFound: 'none' };
}

type EndablePoll = Message & { poll: Poll };

/**
 * Fetch the poll the pointer refers to, straight from Discord. The cached
 * copy is the one the bot posted, and without message intents nothing keeps
 * it current, so it would still look open after Discord closed or deleted it.
 */
async function fetchEndablePoll(
  interaction: ChatInputCommandInteraction,
  record: PollRecord
): Promise<
  { message: EndablePoll } | { problem: PollProblem; error?: unknown }
> {
  try {
    const channel =
      record.channel_id === interaction.channelId && interaction.channel
        ? interaction.channel
        : await interaction.guild?.channels.fetch(record.channel_id);
    // No guild to look the channel up in (not cached): try again later.
    if (channel === undefined) return { problem: 'unavailable' };
    if (!channel?.isTextBased()) return { problem: 'gone' };

    const message = await channel.messages.fetch({
      message: record.message_id,
      force: true,
    });
    const poll = message.poll;
    if (
      !poll ||
      poll.resultsFinalized ||
      // Past its deadline: Discord is closing it, and ending it would fail.
      (poll.expiresTimestamp !== null && poll.expiresTimestamp <= Date.now())
    ) {
      return { problem: 'gone' };
    }
    return { message: message as EndablePoll };
  } catch (error) {
    return { problem: classifyPollError(error), error };
  }
}

/**
 * The answer for a poll that could not be reached or ended, logged with
 * enough to tell the cases apart. Only a poll that is really gone loses its
 * pointer: the others can still be ended once the cause is fixed.
 */
function settlePollProblem(
  problem: PollProblem,
  record: PollRecord,
  locale: Locale,
  error?: unknown
) {
  if (problem === 'gone') {
    pollRepository.remove(record.message_id);
    return createErrorEmbed(
      t('poll.errors.pollEnded', locale),
      t('poll.errors.pollEndedDesc', locale)
    );
  }
  if (problem === 'noAccess') {
    logger.warn(
      `Cannot reach poll ${record.message_id} in channel ${record.channel_id}: ${getErrorMessage(error)}`
    );
    return createErrorEmbed(
      t('poll.errors.endFailed', locale),
      t('poll.errors.noAccessDesc', locale, { channel: record.channel_id })
    );
  }
  const errorId = createErrorId();
  logger.warn(
    `[${errorId}] Failed to end poll ${record.message_id}:`,
    describeError(error)
  );
  return createErrorEmbed(
    t('poll.errors.endFailed', locale),
    t('common.unexpectedError', locale, { id: errorId })
  );
}

async function handleEndPoll(
  interaction: ChatInputCommandInteraction
): Promise<void> {
  const locale = resolveLocale(interaction);
  const target = findPollToEnd(interaction);

  if ('notFound' in target) {
    releaseCooldown(interaction);
    if (target.notFound === 'picked') {
      await replyError(
        interaction,
        locale,
        'poll.errors.pickedNotFound',
        t('poll.errors.pickedNotFoundDesc', locale)
      );
      return;
    }
    await replyError(
      interaction,
      locale,
      'poll.noActivePoll',
      t('poll.noActivePollDesc', locale, {
        command: commandMention('community poll create'),
      })
    );
    return;
  }

  const { record } = target;

  const found = await fetchEndablePoll(interaction, record);
  if ('problem' in found) {
    releaseCooldown(interaction);
    await interaction.reply({
      embeds: [settlePollProblem(found.problem, record, locale, found.error)],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const { message } = found;
  const question = message.poll.question.text;
  const body = [
    question ? `**${escapeMarkdown(question)}**` : null,
    record.channel_id === interaction.channelId
      ? null
      : t('poll.confirm.inChannel', locale, { channel: record.channel_id }),
    t('poll.confirm.body', locale),
  ]
    .filter((line): line is string => line !== null)
    .join('\n');

  const result = await awaitConfirmationResult(interaction, body, {
    ephemeral: true,
    title: t('poll.confirm.title', locale),
    confirmLabel: t('poll.confirm.confirm', locale),
    confirmStyle: ButtonStyle.Danger,
    cancelLabel: t('poll.confirm.cancel', locale),
  });
  // A cancel or a timeout is already shown on the prompt.
  if (result.outcome !== 'confirmed') return;

  // Answer the press and end the poll at once: the press must be answered
  // within 3 s, and the outcome follows one round trip later.
  const [acknowledged, ended] = await Promise.allSettled([
    result.response.update({ components: [] }),
    message.poll.end(),
  ]);
  if (acknowledged.status === 'rejected') {
    logger.debug(
      `Failed to acknowledge the poll end press: ${getErrorMessage(acknowledged.reason)}`
    );
  }

  if (ended.status === 'rejected') {
    await interaction.editReply({
      embeds: [
        settlePollProblem(
          classifyPollError(ended.reason),
          record,
          locale,
          ended.reason
        ),
      ],
      components: [],
    });
    return;
  }

  pollRepository.remove(record.message_id);

  await interaction.editReply({
    embeds: [
      createEmbed({
        title: t('poll.ended', locale),
        description: t('poll.endedMessage', locale),
        color: COLORS.SUCCESS,
      }),
    ],
    components: [],
  });
}

/**
 * `text` cut to at most `max` UTF-16 units, ending in an ellipsis when cut,
 * and never through the middle of a character such as an emoji.
 */
function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  let clipped = '';
  for (const char of text) {
    if (clipped.length + char.length > max - 1) break;
    clipped += char;
  }
  return `${clipped}…`;
}

/**
 * Suggest the caller's open polls in this server for `/community poll end`,
 * newest first, by channel and time left. The pointer table keeps no
 * question text, and fetching every message would not fit in the 3 s an
 * autocomplete answer has.
 */
export async function autocompletePollToEnd(
  interaction: AutocompleteInteraction
): Promise<void> {
  const guildId = interaction.guildId;
  if (!guildId) {
    await interaction.respond([]);
    return;
  }

  const locale = resolveLocale(interaction);
  const typed = String(interaction.options.getFocused()).trim().toLowerCase();
  const now = Date.now();

  const choices = pollRepository
    .listActiveByCreatorInGuild(
      interaction.user.id,
      guildId,
      AUTOCOMPLETE_WINDOW
    )
    .map((record) => {
      const channel = interaction.guild?.channels.cache.get(record.channel_id);
      const remaining = formatDuration(record.expires_at - now, locale, {
        style: 'long',
      });
      // A long channel name is cut, never the time left.
      const room =
        MAX_CHOICE_NAME_LENGTH -
        t('poll.endChoice', locale, { channel: '', remaining }).length;
      return {
        name: t('poll.endChoice', locale, {
          channel: clip(channel?.name ?? record.channel_id, room),
          remaining,
        }),
        value: record.message_id,
      };
    })
    .filter((choice) => !typed || choice.name.toLowerCase().includes(typed))
    .slice(0, MAX_CHOICES);

  await interaction.respond(choices);
}

export async function executePollCommand(
  interaction: ChatInputCommandInteraction
): Promise<void> {
  const subcommand = interaction.options.getSubcommand();

  if (subcommand === 'create') {
    await handleCreatePoll(interaction);
    return;
  }

  if (subcommand === 'end') {
    await handleEndPoll(interaction);
  }
}
