import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  ChatInputCommandInteraction,
  ComponentType,
  GuildMember,
  MessageFlags,
  StageChannel,
  VoiceChannel,
  escapeMarkdown,
  type ButtonInteraction,
  type EmbedBuilder,
  type Message,
} from 'discord.js';
import { createEmbed, createErrorEmbed } from '../../../shared/utils/embed.js';
import { COLORS } from '../../../shared/utils/constants/index.js';
import { getErrorMessage, logger } from '../../../shared/utils/logger.js';
import { PANEL_MAX_LIFETIME } from '../../../shared/utils/panel.js';
import {
  createErrorId,
  describeError,
  trackLiveComponents,
} from '../../../shared/interactions/index.js';
import { releaseCooldown } from '../../../middleware/index.js';
import { t, type Locale, type TranslationKey } from '../../../locales/index.js';
import { resolveLocale } from '../../../locales/guildLocale.js';

const ANIMATION_DELAY = 800;
/** The candidate list stays up a little longer than a countdown step. */
const REVEAL_DELAY = ANIMATION_DELAY * 1.5;
/** When the result replaces the candidate list, from the first frame. */
const RESULT_AT = 3 * ANIMATION_DELAY + REVEAL_DELAY;

/**
 * How long the re-draw buttons wait for the next press. Each press restarts
 * it; `PANEL_MAX_LIFETIME` caps the whole, since retiring them edits through
 * the command's interaction token, which Discord expires after 15 minutes.
 */
export const REROLL_IDLE_MS = 5 * 60_000;
/**
 * Presses closer together than this are acknowledged and ignored: re-draws
 * skip the command cooldown, and two people pressing at once would otherwise
 * produce two results in a row.
 */
export const REROLL_MIN_INTERVAL_MS = 2_000;

export const ROULETTE_BUTTON_IDS = {
  again: 'roulette:again',
  excludeWinner: 'roulette:exclude',
  reshuffle: 'roulette:reshuffle',
} as const;

/** Ends after which there is no message left to edit. */
const SILENT_END_REASONS = new Set([
  'messageDelete',
  'channelDelete',
  'guildDelete',
  'threadDelete',
]);
/** The collector's end reason when the result, buttons and all, never landed. */
const RESULT_NOT_SHOWN = 'resultNotShown';

/** Discord's caps on an embed's description and on one field's value. */
const MAX_DESCRIPTION_LENGTH = 4096;
const MAX_FIELD_VALUE_LENGTH = 1024;
/**
 * What all team lists together may take. Discord also caps an embed at 6000
 * characters in total, which six full fields would pass; this leaves room for
 * the title, description, field names and footer.
 */
const TEAM_FIELDS_BUDGET = 5000;

type RouletteChannel = VoiceChannel | StageChannel;

interface Frame {
  embeds: EmbedBuilder[];
  components?: ActionRowBuilder<ButtonBuilder>[];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shuffle<T>(array: T[]): T[] {
  const result = [...array];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

function pickOne<T>(items: T[]): T {
  return items[Math.floor(Math.random() * items.length)];
}

function getVoiceMembers(channel: RouletteChannel): GuildMember[] {
  return Array.from(channel.members.values()).filter(
    (member) => !member.user.bot
  );
}

/** A display name that cannot break out of the surrounding markdown. */
function nameOf(member: GuildMember): string {
  return escapeMarkdown(member.displayName);
}

/**
 * `names` joined by `separator`, ending in "...and N more" where the whole
 * list would not fit in `max` characters. Cutting at a name keeps every shown
 * name whole and says how many are left out, where a blind cut would not.
 */
export function listWithin(
  names: string[],
  separator: string,
  max: number,
  locale: Locale
): string {
  const full = names.join(separator);
  if (full.length <= max) return full;

  const more = (count: number) => t('roulette.andMore', locale, { count });
  let best = more(names.length);
  let shown = '';
  for (let count = 1; count < names.length; count++) {
    shown = count === 1 ? names[0] : `${shown}${separator}${names[count - 1]}`;
    // Each name adds more than the shrinking count can save, so the first
    // candidate over the limit means no longer one fits either.
    const candidate = `${shown}${separator}${more(names.length - count)}`;
    if (candidate.length > max) break;
    best = candidate;
  }
  return best;
}

/**
 * The text of `key` with the candidates' names filled in, cut short so the
 * whole stays within an embed description.
 */
function withCandidates(
  key: TranslationKey,
  members: GuildMember[],
  locale: Locale,
  params: Record<string, string | number> = {}
): string {
  const frame = t(key, locale, { ...params, candidates: '' });
  return t(key, locale, {
    ...params,
    candidates: listWithin(
      members.map(nameOf),
      ', ',
      MAX_DESCRIPTION_LENGTH - frame.length,
      locale
    ),
  });
}

/**
 * Show `opening` as the reply, then each frame at its offset from the moment
 * the reply landed.
 *
 * Each edit is awaited before the next is scheduled, so frames never overtake
 * each other; the wait before a frame covers only what is left of its slot
 * after the previous round trip, so the animation lasts as designed instead
 * of as designed plus a round trip per frame.
 *
 * `onLastFrame` runs as the last frame is sent, with the reply's message and
 * that edit. Clients show an edit before its REST response comes back, so
 * whatever answers the last frame's buttons has to be listening by then.
 */
async function playAnimation(
  interaction: ChatInputCommandInteraction,
  opening: Frame,
  frames: Array<{ at: number; frame: Frame }>,
  onLastFrame: (message: Message | undefined, shown: Promise<unknown>) => void
): Promise<void> {
  await interaction.reply(opening);
  const start = Date.now();

  let message: Message | undefined;
  for (const [index, { at, frame }] of frames.entries()) {
    await sleep(Math.max(0, at - (Date.now() - start)));
    const edit = interaction.editReply(frame);
    if (index === frames.length - 1) onLastFrame(message, edit);
    message = await edit;
  }
}

function countdownFrame(title: string, count: number, locale: Locale): Frame {
  return {
    embeds: [
      createEmbed({
        title,
        description: `**${t('roulette.member.countdown', locale, { count })}**`,
        color: COLORS.WARNING,
        timestamp: false,
      }),
    ],
  };
}

/** Countdown 3-2-1, the list being drawn from, then `result`. */
function animation(
  title: string,
  drawing: string,
  result: Frame,
  locale: Locale
): { opening: Frame; frames: Array<{ at: number; frame: Frame }> } {
  return {
    opening: countdownFrame(title, 3, locale),
    frames: [
      { at: ANIMATION_DELAY, frame: countdownFrame(title, 2, locale) },
      { at: 2 * ANIMATION_DELAY, frame: countdownFrame(title, 1, locale) },
      {
        at: 3 * ANIMATION_DELAY,
        frame: {
          embeds: [
            createEmbed({
              title,
              description: drawing,
              color: COLORS.WARNING,
              timestamp: false,
            }),
          ],
        },
      },
      { at: RESULT_AT, frame: result },
    ],
  };
}

function button(
  customId: string,
  label: TranslationKey,
  emoji: string,
  locale: Locale,
  disabled = false
): ButtonBuilder {
  return new ButtonBuilder()
    .setCustomId(customId)
    .setLabel(t(label, locale))
    .setEmoji(emoji)
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(disabled);
}

async function refuse(
  interaction: ChatInputCommandInteraction,
  title: string,
  description: string
): Promise<void> {
  // Nothing was drawn, so fixing the problem and retrying is not "too soon".
  releaseCooldown(interaction);
  await interaction.reply({
    embeds: [createErrorEmbed(title, description)],
    flags: MessageFlags.Ephemeral,
  });
}

/** The invoker's voice channel, or null once they have been told why not. */
async function requireVoiceChannel(
  interaction: ChatInputCommandInteraction,
  locale: Locale
): Promise<RouletteChannel | null> {
  if (!interaction.guild || !interaction.member) {
    await refuse(
      interaction,
      t('common.error', locale),
      t('common.guildOnly', locale)
    );
    return null;
  }

  const member = interaction.member as GuildMember;
  const voiceChannel = member.voice.channel;

  if (
    !voiceChannel ||
    (voiceChannel.type !== ChannelType.GuildVoice &&
      voiceChannel.type !== ChannelType.GuildStageVoice)
  ) {
    await refuse(
      interaction,
      t('roulette.errors.notInVoice', locale),
      t('roulette.errors.notInVoiceDesc', locale)
    );
    return null;
  }

  return voiceChannel;
}

/** Tell a presser privately why their press did nothing. */
async function answerPrivately(
  press: ButtonInteraction,
  content: string
): Promise<void> {
  await press
    .reply({ content, flags: MessageFlags.Ephemeral })
    .catch((error: unknown) => {
      logger.debug(`Failed to answer a re-draw: ${getErrorMessage(error)}`);
    });
}

/**
 * Keep a result's re-draw buttons working until they go idle.
 *
 * Started as the result is sent (`shown` is that edit), so a press that comes
 * the moment the buttons appear is already collected. Anyone in the voice
 * channel may press them - a pick is for the whole channel, not only for
 * whoever ran the command - and each press reads the channel's members
 * afresh, so newcomers are in and leavers are out.
 */
function keepRerollButtons(options: {
  interaction: ChatInputCommandInteraction;
  message: Message | undefined;
  shown: Promise<unknown>;
  voiceChannel: RouletteChannel;
  locale: Locale;
  label: string;
  redraw: (press: ButtonInteraction) => Promise<void>;
}): void {
  const { interaction, message, voiceChannel, locale, label, redraw } = options;
  // Some transports (and test doubles) hand back no message to collect on.
  if (typeof message?.createMessageComponentCollector !== 'function') return;

  // Retiring the buttons edits through the command's token, which expires 15
  // minutes after the command, not after the animation; slow frame edits
  // (rate limits) must not push the last edit past it.
  const age = Date.now() - interaction.createdTimestamp;
  const collector = message.createMessageComponentCollector({
    componentType: ComponentType.Button,
    idle: REROLL_IDLE_MS,
    time: Math.max(1, PANEL_MAX_LIFETIME - age),
  });

  const landed = options.shown.then(
    () => true,
    () => false
  );
  void landed.then((ok) => {
    if (!ok) collector.stop(RESULT_NOT_SHOWN);
  });

  // While the collector runs the router leaves these buttons to it, and
  // shutdown stops it so they do not outlive the process that answers them.
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

  let lastRedrawAt = Number.NEGATIVE_INFINITY;

  collector.on('collect', async (press: ButtonInteraction) => {
    if (!voiceChannel.members.has(press.user.id)) {
      await answerPrivately(
        press,
        t('roulette.errors.onlyParticipants', locale, {
          channel: voiceChannel.id,
        })
      );
      return;
    }

    const now = Date.now();
    if (now - lastRedrawAt < REROLL_MIN_INTERVAL_MS) {
      await press.deferUpdate().catch((error: unknown) => {
        logger.debug(
          `Failed to acknowledge a repeated re-draw: ${getErrorMessage(error)}`
        );
      });
      return;
    }
    lastRedrawAt = now;

    try {
      await redraw(press);
    } catch (error) {
      const errorId = createErrorId();
      logger.warn(
        `[${errorId}] Failed to re-draw ${label}:`,
        describeError(error)
      );
      const payload = {
        content: t('common.actionFailed', locale, { id: errorId }),
        flags: MessageFlags.Ephemeral,
      } as const;
      await (
        press.replied || press.deferred
          ? press.followUp(payload)
          : press.reply(payload)
      ).catch((replyError: unknown) => {
        logger.debug(
          `Failed to report a failed re-draw: ${getErrorMessage(replyError)}`
        );
      });
    }
  });

  collector.on('end', async (_collected, reason: string) => {
    untrack();
    try {
      if (SILENT_END_REASONS.has(reason)) return;
      // A result still on its way would bring the buttons back after they
      // were removed; one that never landed left none to remove.
      if (!(await landed)) return;
      // The result stays; only the buttons nothing answers any more go.
      await interaction
        .editReply({ components: [] })
        .catch((error: unknown) => {
          logger.debug(
            `Failed to retire ${label} buttons: ${getErrorMessage(error)}`
          );
        });
    } finally {
      markEnded();
    }
  });
}

interface MemberDraw {
  winner: GuildMember;
  /** Who it was drawn from. */
  pool: GuildMember[];
  /** Earlier winners left out with "re-draw without the winner". */
  excluded: number;
}

function memberResult(
  draw: MemberDraw,
  voiceChannel: RouletteChannel,
  locale: Locale
): Frame {
  const footer =
    draw.excluded > 0
      ? t('roulette.member.footerExcluded', locale, {
          count: draw.pool.length,
          channel: voiceChannel.name,
          excluded: draw.excluded,
        })
      : t('roulette.member.footer', locale, {
          count: draw.pool.length,
          channel: voiceChannel.name,
        });

  return {
    embeds: [
      createEmbed({
        title: t('roulette.member.result', locale),
        description: t('roulette.member.winner', locale, {
          name: nameOf(draw.winner),
          mention: `<@${draw.winner.id}>`,
        }),
        color: COLORS.SUCCESS,
        footer,
        timestamp: true,
      }),
    ],
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        button(
          ROULETTE_BUTTON_IDS.again,
          'roulette.buttons.again',
          '🎲',
          locale
        ),
        // Leaving the winner out needs someone else to draw.
        button(
          ROULETTE_BUTTON_IDS.excludeWinner,
          'roulette.buttons.excludeWinner',
          '🙅',
          locale,
          draw.pool.length < 2
        )
      ),
    ],
  };
}

async function handleMemberRoulette(
  interaction: ChatInputCommandInteraction
): Promise<void> {
  const locale = resolveLocale(interaction);
  const voiceChannel = await requireVoiceChannel(interaction, locale);
  if (!voiceChannel) return;

  const members = getVoiceMembers(voiceChannel);

  if (members.length === 0) {
    await refuse(
      interaction,
      t('roulette.errors.noMembers', locale),
      t('roulette.errors.noMembersDesc', locale)
    );
    return;
  }

  if (members.length === 1) {
    await interaction.reply({
      embeds: [
        createEmbed({
          title: t('roulette.member.result', locale),
          description: t('roulette.member.onlyOne', locale, {
            name: nameOf(members[0]),
            mention: `<@${members[0].id}>`,
          }),
          color: COLORS.SUCCESS,
        }),
      ],
    });
    return;
  }

  let draw: MemberDraw = {
    winner: pickOne(members),
    pool: members,
    excluded: 0,
  };
  const { opening, frames } = animation(
    t('roulette.member.title', locale),
    withCandidates('roulette.member.selecting', members, locale),
    memberResult(draw, voiceChannel, locale),
    locale
  );

  const excluded = new Set<string>();
  const redraw = async (press: ButtonInteraction): Promise<void> => {
    const leaveOut = press.customId === ROULETTE_BUTTON_IDS.excludeWinner;
    const pool = getVoiceMembers(voiceChannel).filter(
      (member) =>
        !excluded.has(member.id) && !(leaveOut && member.id === draw.winner.id)
    );

    if (pool.length === 0) {
      await answerPrivately(
        press,
        t('roulette.errors.noCandidatesLeft', locale)
      );
      return;
    }

    if (leaveOut) excluded.add(draw.winner.id);
    draw = { winner: pickOne(pool), pool, excluded: excluded.size };
    await press.update(memberResult(draw, voiceChannel, locale));

    logger.info(
      `Roulette member re-draw: ${draw.winner.displayName} selected from ${pool.length} members by ${press.user.tag}`
    );
  };

  // Logged before the animation: a press can re-draw before it returns.
  logger.info(
    `Roulette member: ${draw.winner.displayName} selected from ${members.length} members by ${interaction.user.tag}`
  );

  await playAnimation(interaction, opening, frames, (message, shown) =>
    keepRerollButtons({
      interaction,
      message,
      shown,
      voiceChannel,
      locale,
      label: 'member roulette',
      redraw,
    })
  );
}

/** Deal shuffled members round-robin, so team sizes differ by at most one. */
function dealTeams(members: GuildMember[], teamCount: number): GuildMember[][] {
  const teams: GuildMember[][] = Array.from({ length: teamCount }, () => []);
  shuffle(members).forEach((member, index) => {
    teams[index % teamCount].push(member);
  });
  return teams;
}

function teamResult(
  teams: GuildMember[][],
  voiceChannel: RouletteChannel,
  locale: Locale
): Frame {
  const memberCount = teams.reduce((sum, team) => sum + team.length, 0);
  const perTeam = Math.min(
    MAX_FIELD_VALUE_LENGTH,
    Math.floor(TEAM_FIELDS_BUDGET / teams.length)
  );
  const fields = teams.map((team, index) => ({
    name: t('roulette.team.teamName', locale, {
      number: index + 1,
      count: team.length,
    }),
    value:
      listWithin(team.map(nameOf), '\n', perTeam, locale) ||
      t('roulette.team.noMembers', locale),
    inline: true,
  }));

  return {
    embeds: [
      createEmbed({
        title: t('roulette.team.result', locale),
        description: t('roulette.team.resultDesc', locale, {
          count: memberCount,
          teams: teams.length,
        }),
        color: COLORS.SUCCESS,
        fields,
        footer: t('roulette.team.footer', locale, {
          channel: voiceChannel.name,
        }),
        timestamp: true,
      }),
    ],
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        button(
          ROULETTE_BUTTON_IDS.reshuffle,
          'roulette.buttons.reshuffle',
          '🔀',
          locale
        )
      ),
    ],
  };
}

function notEnoughDescription(
  teamCount: number,
  current: number,
  locale: Locale
): string {
  return t('roulette.errors.notEnoughDesc', locale, {
    teams: teamCount,
    required: teamCount,
    current,
  });
}

async function handleTeamRoulette(
  interaction: ChatInputCommandInteraction
): Promise<void> {
  const locale = resolveLocale(interaction);
  const voiceChannel = await requireVoiceChannel(interaction, locale);
  if (!voiceChannel) return;

  const teamCount = interaction.options.getInteger('count', true);
  const members = getVoiceMembers(voiceChannel);

  if (members.length < teamCount) {
    await refuse(
      interaction,
      t('roulette.errors.notEnough', locale),
      notEnoughDescription(teamCount, members.length, locale)
    );
    return;
  }

  const { opening, frames } = animation(
    t('roulette.team.title', locale),
    withCandidates('roulette.team.shuffling', members, locale, {
      count: members.length,
      teams: teamCount,
    }),
    teamResult(dealTeams(members, teamCount), voiceChannel, locale),
    locale
  );

  const redraw = async (press: ButtonInteraction): Promise<void> => {
    const current = getVoiceMembers(voiceChannel);
    if (current.length < teamCount) {
      await answerPrivately(
        press,
        notEnoughDescription(teamCount, current.length, locale)
      );
      return;
    }

    await press.update(
      teamResult(dealTeams(current, teamCount), voiceChannel, locale)
    );

    logger.info(
      `Roulette team re-draw: ${current.length} members divided into ${teamCount} teams by ${press.user.tag}`
    );
  };

  await playAnimation(interaction, opening, frames, (message, shown) =>
    keepRerollButtons({
      interaction,
      message,
      shown,
      voiceChannel,
      locale,
      label: 'team roulette',
      redraw,
    })
  );

  logger.info(
    `Roulette team: ${members.length} members divided into ${teamCount} teams by ${interaction.user.tag}`
  );
}

export async function executeRouletteCommand(
  interaction: ChatInputCommandInteraction
): Promise<void> {
  const subcommand = interaction.options.getSubcommand();

  if (subcommand === 'member') {
    await handleMemberRoulette(interaction);
  } else if (subcommand === 'team') {
    await handleTeamRoulette(interaction);
  }
}
