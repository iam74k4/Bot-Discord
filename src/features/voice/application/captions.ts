import type { VoiceConnection } from '@discordjs/voice';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type ChatInputCommandInteraction,
  type Guild,
  type MessageComponentInteraction,
  MessageFlags,
  PermissionFlagsBits,
  type VoiceBasedChannel,
} from 'discord.js';
import { COLORS } from '../../../shared/utils/constants/index.js';
import {
  createEmbed,
  createErrorEmbed,
  createInfoEmbed,
  createWarningEmbed,
} from '../../../shared/utils/embed.js';
import { commandMention } from '../../../shared/utils/commandMentions.js';
import { formatPermissionNames } from '../../../shared/utils/discord.js';
import { getErrorMessage, logger } from '../../../shared/utils/logger.js';
import { releaseCooldown } from '../../../middleware/index.js';
import { t, type Locale } from '../../../locales/index.js';
import {
  resolveBackgroundLocale,
  resolveLocale,
} from '../../../locales/guildLocale.js';
import { keepsAudio } from '../recording/audioMode.js';
import { connectionManager } from '../recording/connectionManager.js';
import { captionConsentRepository } from '../repositories/captionConsentRepository.js';
import { voiceSettingsRepository } from '../repositories/voiceSettingsRepository.js';
import { captionSessions } from '../captions/sessionManager.js';
import { getWhisperClient } from '../captions/whisperClient.js';
import { ttsSessions } from '../tts/sessionManager.js';
import { announceBuffering } from './announce.js';
import { resumeAutoJoin } from './listening.js';

/**
 * `/caption` - show what people say in a voice channel as text in its chat,
 * transcribed by a self-hosted Whisper engine.
 *
 * Consent comes first. Anyone in a voice channel may start captions there,
 * because starting them captions nobody: only members who said yes with
 * `/caption consent` (or the button on the start message) are transcribed,
 * each for one server at a time. Everyone else's audio never reaches the
 * engine.
 *
 * Captions need to hear people but not to keep what they hear. Where the
 * server lets auto-join keep audio, the bot joins as auto-join would; where
 * it does not, it joins listening only, and nothing goes into the
 * `/voice record` buffer.
 */

/** customId prefix of the consent buttons; the rest is `allow` or `revoke`. */
export const CAPTION_CONSENT_PREFIX = 'caption-consent:';
const CONNECT_TIMEOUT_MS = 15_000;

type GuildInteraction = ChatInputCommandInteraction<'cached'>;
type Severity = 'error' | 'warning' | 'info';

const EMBED_FOR: Record<
  Severity,
  (title: string, description: string) => ReturnType<typeof createErrorEmbed>
> = {
  error: createErrorEmbed,
  warning: createWarningEmbed,
  info: createInfoEmbed,
};

/** A private answer in place of the result: before or after deferring. */
async function replyNotice(
  interaction: ChatInputCommandInteraction,
  severity: Severity,
  title: string,
  description: string
): Promise<void> {
  const embed = EMBED_FOR[severity](title, description);
  if (interaction.deferred || interaction.replied) {
    await interaction.editReply({ embeds: [embed] });
    return;
  }
  await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}

/**
 * Turned down before any work, for a reason the member can fix: the
 * cooldown is given back so the retry goes through at once.
 */
function refuse(
  interaction: ChatInputCommandInteraction,
  severity: Exclude<Severity, 'error'>,
  title: string,
  description: string
): Promise<void> {
  releaseCooldown(interaction);
  return replyNotice(interaction, severity, title, description);
}

function consentRow(locale: Locale): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${CAPTION_CONSENT_PREFIX}allow`)
      .setLabel(t('captions.consent.allowButton', locale))
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`${CAPTION_CONSENT_PREFIX}revoke`)
      .setLabel(t('captions.consent.revokeButton', locale))
      .setStyle(ButtonStyle.Secondary)
  );
}

function humanMembers(channel: VoiceBasedChannel) {
  return channel.members.filter((member) => !member.user.bot);
}

/** Best effort: a caption that cannot be posted is lost, not retried. */
async function postCaption(
  guild: Guild,
  channelId: string,
  content: string
): Promise<void> {
  try {
    const channel = guild.channels.cache.get(channelId);
    if (!channel?.isSendable()) return;
    await channel.send({
      content,
      allowedMentions: { parse: [] },
      // A line every few seconds must not ping everyone in the channel.
      flags: MessageFlags.SuppressNotifications,
    });
  } catch (error) {
    logger.debug(
      `Could not post a caption in ${channelId}: ${getErrorMessage(error)}`
    );
  }
}

async function postEngineTrouble(
  guild: Guild,
  channelId: string
): Promise<void> {
  try {
    const channel = guild.channels.cache.get(channelId);
    if (!channel?.isSendable()) return;
    const locale = resolveBackgroundLocale(guild);
    await channel.send({
      embeds: [
        createWarningEmbed(
          t('captions.engineTrouble', locale),
          t('captions.engineTroubleDesc', locale)
        ),
      ],
    });
  } catch (error) {
    logger.debug(
      `Could not post a caption notice in ${channelId}: ${getErrorMessage(error)}`
    );
  }
}

function speakerName(guild: Guild, userId: string): string {
  return (
    guild.members.cache.get(userId)?.displayName ??
    t('captions.unknownSpeaker', resolveBackgroundLocale(guild))
  );
}

export async function executeCaptionCommand(
  interaction: ChatInputCommandInteraction
): Promise<void> {
  const locale = resolveLocale(interaction);

  if (!interaction.inCachedGuild()) {
    await replyNotice(
      interaction,
      'error',
      t('common.error', locale),
      t('common.guildOnly', locale)
    );
    return;
  }

  switch (interaction.options.getSubcommand()) {
    case 'start':
      await handleStart(interaction, locale);
      return;
    case 'stop':
      await handleStop(interaction, locale);
      return;
    default:
      await handleConsent(interaction, locale);
  }
}

async function handleStart(
  interaction: GuildInteraction,
  locale: Locale
): Promise<void> {
  const client = getWhisperClient();
  if (!client) {
    await replyNotice(
      interaction,
      'error',
      t('captions.errors.notConfigured', locale),
      t('captions.errors.notConfiguredDesc', locale)
    );
    return;
  }

  const voiceChannel = interaction.member.voice.channel;
  if (!voiceChannel) {
    await refuse(
      interaction,
      'warning',
      t('captions.errors.notInVoice', locale),
      t('captions.errors.notInVoiceDesc', locale, {
        command: commandMention('caption start'),
      })
    );
    return;
  }

  const busyChannelId = connectionManager.getConnectedChannelInGuild(
    interaction.guildId
  );
  if (busyChannelId && busyChannelId !== voiceChannel.id) {
    await refuse(
      interaction,
      'warning',
      t('captions.errors.busyElsewhere', locale),
      t('captions.errors.busyElsewhereDesc', locale, {
        channel: busyChannelId,
      })
    );
    return;
  }

  // The health check and joining can take longer than Discord's 3 s.
  await interaction.deferReply();

  if (!(await client.isAvailable())) {
    await replyNotice(
      interaction,
      'error',
      t('captions.errors.engineDown', locale),
      t('captions.errors.engineDownDesc', locale)
    );
    return;
  }

  // The join this call made, if any; null when the bot was already there.
  let joined: VoiceConnection | null = null;
  const existing = connectionManager.getConnection(voiceChannel.id);
  if (!existing) {
    // Captions never override a server's choice not to have audio kept:
    // where auto-join may not keep it, the bot only listens.
    const buffer = voiceSettingsRepository.mayAutoJoin(
      interaction.guildId,
      voiceChannel.id
    );
    joined = await connectionManager.connect(interaction.guild, voiceChannel, {
      receive: true,
      buffer,
    });
    if (!joined) {
      await replyNotice(
        interaction,
        'error',
        t('captions.errors.cannotJoin', locale),
        t('captions.errors.cannotJoinDesc', locale)
      );
      return;
    }
    if (buffer) await announceBuffering(voiceChannel);
  } else if (existing.receiving === false) {
    // Here, deafened, to read chat aloud: listen too, still keeping nothing.
    connectionManager.enableReceive(voiceChannel.id, { buffer: false });
  }

  if (
    !(await connectionManager.waitUntilReady(
      voiceChannel.id,
      CONNECT_TIMEOUT_MS
    ))
  ) {
    // Only the join made here: whatever replaced it meanwhile is not ours.
    if (joined) await connectionManager.disconnect(voiceChannel.id, joined);
    await replyNotice(
      interaction,
      'error',
      t('captions.errors.cannotJoin', locale),
      t('captions.errors.cannotJoinDesc', locale)
    );
    return;
  }

  const guild = interaction.guild;
  captionSessions.start({
    guildId: interaction.guildId,
    voiceChannelId: voiceChannel.id,
    startedBy: interaction.user.id,
    post: (content) => postCaption(guild, voiceChannel.id, content),
    nameOf: (userId) => speakerName(guild, userId),
    onEngineTrouble: () => void postEngineTrouble(guild, voiceChannel.id),
  });

  const members = humanMembers(voiceChannel);
  const consented = members.filter((member) =>
    captionConsentRepository.hasConsented(interaction.guildId, member.id)
  ).size;
  const me = guild.members.me;
  const canPost = me
    ? (voiceChannel
        .permissionsFor(me)
        ?.has([
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
        ]) ?? false)
    : false;

  await interaction.editReply({
    embeds: [
      createEmbed({
        title: t('captions.started', locale),
        description: [
          t('captions.startedDesc', locale, { voice: voiceChannel.id }),
          t('captions.consentCount', locale, {
            consented,
            members: members.size,
          }),
          ...(canPost
            ? []
            : [
                t('captions.noPostPermission', locale, {
                  voice: voiceChannel.id,
                }),
              ]),
        ].join('\n\n'),
        color: COLORS.SUCCESS,
        fields: [
          {
            name: t('captions.consent.title', locale),
            value: t('captions.consent.explain', locale, {
              command: commandMention('caption consent'),
            }),
          },
          {
            name: t('captions.howToTitle', locale),
            value: t('captions.howTo', locale, {
              stopCommand: commandMention('caption stop'),
            }),
          },
        ],
      }),
    ],
    // Public, with the buttons: everyone in the channel can say yes here.
    components: [consentRow(locale)],
  });
}

/**
 * Stopping is limited to people in the channel being captioned, plus server
 * managers, as with reading aloud.
 */
async function handleStop(
  interaction: GuildInteraction,
  locale: Locale
): Promise<void> {
  const session = captionSessions.getForGuild(interaction.guildId);
  if (!session) {
    await refuse(
      interaction,
      'info',
      t('captions.errors.notRunning', locale),
      t('captions.errors.notRunningDesc', locale, {
        command: commandMention('caption start'),
      })
    );
    return;
  }

  const inChannel =
    interaction.member.voice.channelId === session.voiceChannelId;
  const isManager = interaction.memberPermissions.has(
    PermissionFlagsBits.ManageGuild
  );
  if (!inChannel && !isManager) {
    await refuse(
      interaction,
      'warning',
      t('captions.errors.notInSameVoice', locale),
      t('captions.errors.notInSameVoiceDesc', locale, {
        channel: session.voiceChannelId,
        permission: formatPermissionNames(
          PermissionFlagsBits.ManageGuild,
          locale
        ),
      })
    );
    return;
  }

  captionSessions.stop(session.voiceChannelId);
  await stopListening(interaction.guild, session.voiceChannelId);

  await interaction.reply({
    embeds: [
      createEmbed({
        title: t('captions.stopped', locale),
        description: t('captions.stoppedDesc', locale, {
          command: commandMention('caption start'),
        }),
        color: COLORS.INFO,
      }),
    ],
  });
}

/**
 * A connection that listened only for captions has no reason to listen
 * any more: it goes back to reading aloud deafened if a reading session
 * still uses it, is handed to auto-join if auto-join now covers the
 * channel, and otherwise leaves. A buffering connection is auto-join's and
 * stays as it is.
 */
async function stopListening(guild: Guild, channelId: string): Promise<void> {
  const info = connectionManager.getConnection(channelId);
  if (!info || info.receiving === false || keepsAudio(info)) return;
  if (ttsSessions.get(channelId)) {
    connectionManager.disableReceive(channelId);
    return;
  }
  if (!(await resumeAutoJoin(guild, channelId))) {
    await connectionManager.disconnect(channelId);
  }
}

/** Record a member's answer; withdrawing also drops what is in flight. */
function applyConsent(guildId: string, userId: string, allow: boolean): void {
  captionConsentRepository.setConsent(guildId, userId, allow);
  if (!allow) captionSessions.forgetUser(guildId, userId);
}

function consentResultEmbed(allow: boolean, locale: Locale) {
  return createEmbed({
    title: allow
      ? t('captions.consent.allowedTitle', locale)
      : t('captions.consent.revokedTitle', locale),
    description: allow
      ? t('captions.consent.allowed', locale, {
          command: commandMention('caption consent'),
        })
      : t('captions.consent.revoked', locale, {
          command: commandMention('caption consent'),
        }),
    color: allow ? COLORS.SUCCESS : COLORS.INFO,
  });
}

async function handleConsent(
  interaction: GuildInteraction,
  locale: Locale
): Promise<void> {
  const allow = interaction.options.getBoolean('allow');
  if (allow === null) {
    const consented = captionConsentRepository.hasConsented(
      interaction.guildId,
      interaction.user.id
    );
    await interaction.reply({
      embeds: [
        createEmbed({
          title: t('captions.consent.title', locale),
          description: [
            consented
              ? t('captions.consent.statusAllowed', locale)
              : t('captions.consent.statusNotAllowed', locale),
            t('captions.consent.explain', locale, {
              command: commandMention('caption consent'),
            }),
          ].join('\n\n'),
          color: COLORS.INFO,
        }),
      ],
      components: [consentRow(locale)],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  applyConsent(interaction.guildId, interaction.user.id, allow);
  await interaction.reply({
    embeds: [consentResultEmbed(allow, locale)],
    flags: MessageFlags.Ephemeral,
  });
}

/**
 * The consent buttons on the start message and on `/caption consent`.
 *
 * Registered as a persistent component route, so buttons posted before a
 * restart keep working. Stateless: the answer is in the customId and the
 * server is where the button was pressed. Each press answers for the
 * presser only, privately; pressing twice is harmless.
 */
export async function handleConsentClick(
  interaction: MessageComponentInteraction
): Promise<void> {
  const locale = resolveLocale(interaction);
  const choice = interaction.customId.slice(CAPTION_CONSENT_PREFIX.length);
  if (!interaction.inGuild() || (choice !== 'allow' && choice !== 'revoke')) {
    await interaction.reply({
      content: t('common.guildOnly', locale),
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const allow = choice === 'allow';
  applyConsent(interaction.guildId, interaction.user.id, allow);
  await interaction.reply({
    embeds: [consentResultEmbed(allow, locale)],
    flags: MessageFlags.Ephemeral,
  });
}
