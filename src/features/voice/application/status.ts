import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ChannelType,
  type ChatInputCommandInteraction,
  type Guild,
  type GuildMember,
  type MessageActionRowComponentBuilder,
  type MessageComponentInteraction,
  MessageFlags,
  PermissionFlagsBits,
} from 'discord.js';
import { env, DISCORD_LIMITS } from '../../../config/index.js';
import { COLORS } from '../../../shared/utils/constants/index.js';
import { createEmbed, createErrorEmbed } from '../../../shared/utils/embed.js';
import {
  runComponentPanel,
  type PanelPayload,
} from '../../../shared/utils/panel.js';
import { t, type Locale } from '../../../locales/index.js';
import { commandMention } from '../../../shared/utils/commandMentions.js';
import { resolveLocale } from '../../../locales/guildLocale.js';
import { formatDuration } from '../../../locales/format.js';
import { connectionManager } from '../recording/connectionManager.js';
import { channelMixRingManager } from '../recording/channelMixRing.js';
import { voiceSettingsRepository } from '../repositories/voiceSettingsRepository.js';
import {
  describeBufferingGap,
  diagnoseBufferingGap,
  isBuffering,
} from './diagnose.js';
import { getAnnouncementProblem } from './announce.js';
import { describeReconcile } from './autojoin.js';
import {
  applyExclusionChanges,
  disableAutoJoin,
  enableAutoJoin,
} from './policy.js';
import { auditVoiceSettingChange } from './settingsAudit.js';

const PANEL_PREFIX = 'voice-panel:';
const IDS = {
  enable: `${PANEL_PREFIX}autojoin-on`,
  disable: `${PANEL_PREFIX}autojoin-off`,
  confirmDisable: `${PANEL_PREFIX}autojoin-off-confirm`,
  cancelDisable: `${PANEL_PREFIX}autojoin-off-cancel`,
  exclusions: `${PANEL_PREFIX}exclusions`,
} as const;

/** Discord's cap on a select menu's selections and default values. */
const MAX_SELECT = 25;
/** Embed field values are capped at 1024 characters. */
const FIELD_VALUE_LIMIT = 1024;
const BYTES_PER_MB = 1024 * 1024;

/** Panel state that lives as long as one `/voice status` panel. */
interface PanelState {
  /** The admin pressed "turn off" and is being asked to confirm. */
  confirmingDisable: boolean;
  /** One line about what the last click did. */
  lastAction: string | null;
  /** Exclusions preselected in the menu at the last render. */
  shownExclusions: string[];
}

function spokenDuration(seconds: number, locale: Locale): string {
  return formatDuration(seconds * 1000, locale, {
    style: 'long',
    precision: 'seconds',
  });
}

function channelMentions(ids: readonly string[], locale: Locale): string {
  return ids.length > 0
    ? ids.map((id) => `<#${id}>`).join(' ')
    : t('record.autojoin.exclusionsNone', locale);
}

/** `<#a> <#b> 他3件`, cut to fit an embed field. */
export function exclusionList(ids: readonly string[], locale: Locale): string {
  if (ids.length === 0) return t('record.autojoin.exclusionsNone', locale);
  const mentions = ids.map((id) => `<#${id}>`);
  const render = (shown: number) =>
    shown === mentions.length
      ? mentions.join(' ')
      : `${mentions.slice(0, shown).join(' ')} ${t(
          'record.autojoin.exclusionsMore',
          locale,
          { count: mentions.length - shown }
        )}`.trim();

  let shown = mentions.length;
  while (shown > 0 && render(shown).length > FIELD_VALUE_LIMIT) shown--;
  return render(shown);
}

/** The "is my channel being kept?" line for the caller. */
function currentChannelLine(
  guild: Guild,
  memberChannelId: string | null,
  locale: Locale
): string {
  if (!memberChannelId) {
    return t('record.autojoin.currentChannelNone', locale);
  }
  if (voiceSettingsRepository.isChannelExcluded(guild.id, memberChannelId)) {
    return t('record.autojoin.currentChannelExcluded', locale, {
      channel: memberChannelId,
    });
  }
  if (isBuffering(memberChannelId)) {
    const buffered = Math.floor(
      Math.min(
        channelMixRingManager.getBufferedSeconds(memberChannelId),
        env.MAX_RECORDING_DURATION
      )
    );
    return buffered > 0
      ? t('record.autojoin.currentChannelBuffered', locale, {
          channel: memberChannelId,
          available: spokenDuration(buffered, locale),
        })
      : t('record.autojoin.currentChannelListening', locale, {
          channel: memberChannelId,
        });
  }

  const channel = guild.channels.cache.get(memberChannelId);
  const reason =
    channel && 'permissionsFor' in channel
      ? describeBufferingGap(
          diagnoseBufferingGap(guild, channel),
          memberChannelId,
          locale
        )
      : t('record.notBuffered.notYetJoined', locale);
  return t('record.autojoin.currentChannelNotBuffered', locale, {
    channel: memberChannelId,
    reason,
  });
}

/** A notice that could not be posted, phrased for the admin. */
function noticeProblemLine(
  memberChannelId: string | null,
  locale: Locale
): string | null {
  // Only relevant while the bot is actually keeping that channel's audio.
  if (!memberChannelId || !isBuffering(memberChannelId)) return null;
  const problem = getAnnouncementProblem(memberChannelId);
  if (!problem) return null;
  return t(
    problem === 'noPermission'
      ? 'record.status.noticeNoPermission'
      : 'record.status.noticeSendFailed',
    locale,
    { channel: memberChannelId }
  );
}

/** The caller as a cached guild member; null for an uncached API member. */
function viewerOf(
  interaction: ChatInputCommandInteraction
): GuildMember | null {
  return interaction.member && 'voice' in interaction.member
    ? interaction.member
    : null;
}

function memberChannelOf(
  interaction: ChatInputCommandInteraction
): string | null {
  return viewerOf(interaction)?.voice.channelId ?? null;
}

/**
 * Whether the caller can see a channel. A default value the caller cannot
 * view may be dropped from the submission by Discord, which the diff would
 * read as "removed" and quietly re-include; such channels are never
 * preselected, so the menu cannot touch them.
 */
function viewerCanSee(
  guild: Guild,
  channelId: string,
  viewer: GuildMember | null
): boolean {
  const channel = guild.channels.cache.get(channelId);
  if (!channel) return false;
  if (!viewer || !('permissionsFor' in channel)) return true;
  return (
    channel.permissionsFor(viewer)?.has(PermissionFlagsBits.ViewChannel) ?? true
  );
}

function uploadLimitOf(interaction: ChatInputCommandInteraction): number {
  const limit = interaction.attachmentSizeLimit;
  return typeof limit === 'number' && limit > 0
    ? limit
    : DISCORD_LIMITS.FALLBACK_ATTACHMENT_BYTES;
}

function renderPanel(
  interaction: ChatInputCommandInteraction,
  guild: Guild,
  locale: Locale,
  state: PanelState,
  disabled = false
): PanelPayload {
  const autoJoinEnabled = voiceSettingsRepository.isAutoJoinEnabled(guild.id);
  const exclusions = voiceSettingsRepository.listExclusions(guild.id);
  const memberChannelId = memberChannelOf(interaction);
  const botChannelId = connectionManager.getConnectedChannelInGuild(guild.id);
  const longest = Math.min(
    env.MAX_RECORDING_DURATION,
    env.AUDIO_BUFFER_DURATION
  );

  const lines = [
    t('record.statusHint', locale),
    currentChannelLine(guild, memberChannelId, locale),
  ];
  const problem = noticeProblemLine(memberChannelId, locale);
  if (problem) lines.push(problem);
  if (state.confirmingDisable) {
    lines.push(t('record.panel.confirmDisablePrompt', locale));
  } else if (state.lastAction) {
    lines.push(state.lastAction);
  }

  // Only channels Discord still knows, and the caller can see, can be
  // preselected; any other exclusion (a deleted channel, one hidden from this
  // admin) is left alone instead of being "removed" by the menu.
  const viewer = viewerOf(interaction);
  const known = exclusions.filter((id) => guild.channels.cache.has(id));
  const selectable = known.filter((id) => viewerCanSee(guild, id, viewer));
  const menuFits = selectable.length <= MAX_SELECT;
  if (!menuFits) {
    lines.push(
      t('record.panel.tooManyExclusions', locale, {
        exclude: commandMention('voice autojoin exclude'),
        include: commandMention('voice autojoin include'),
      })
    );
  } else if (selectable.length < known.length) {
    lines.push(
      t('record.panel.hiddenExclusions', locale, {
        count: known.length - selectable.length,
      })
    );
  }
  state.shownExclusions = menuFits ? selectable : [];

  const embed = createEmbed({
    title: t('record.status.title', locale),
    description: lines.join('\n\n'),
    color: COLORS.INFO,
    fields: [
      {
        name: t('record.autojoin.title', locale),
        value: autoJoinEnabled
          ? t('record.autojoin.statusEnabled', locale)
          : t('record.autojoin.statusDisabled', locale),
        inline: true,
      },
      {
        name: t('record.status.botChannel', locale),
        value: botChannelId
          ? `<#${botChannelId}>`
          : t('record.autojoin.exclusionsNone', locale),
        inline: true,
      },
      {
        name: t('record.status.capacity', locale),
        value: connectionManager.isAtLimit()
          ? t('record.status.capacityFull', locale)
          : t('record.status.capacityAvailable', locale),
        inline: true,
      },
      {
        name: t('record.status.saveLimit', locale),
        value: t('record.status.saveLimitValue', locale, {
          max: spokenDuration(longest, locale),
          limit: Math.floor(uploadLimitOf(interaction) / BYTES_PER_MB),
        }),
        inline: false,
      },
      {
        name: t('record.autojoin.exclusions', locale),
        value: exclusionList(exclusions, locale),
        inline: false,
      },
    ],
  });

  const toggle = new ActionRowBuilder<MessageActionRowComponentBuilder>();
  if (!autoJoinEnabled) {
    toggle.addComponents(
      new ButtonBuilder()
        .setCustomId(IDS.enable)
        .setLabel(t('record.panel.enable', locale))
        .setStyle(ButtonStyle.Success)
        .setDisabled(disabled)
    );
  } else if (state.confirmingDisable) {
    toggle.addComponents(
      new ButtonBuilder()
        .setCustomId(IDS.confirmDisable)
        .setLabel(t('record.panel.confirmDisable', locale))
        .setStyle(ButtonStyle.Danger)
        .setDisabled(disabled),
      new ButtonBuilder()
        .setCustomId(IDS.cancelDisable)
        .setLabel(t('record.panel.cancelDisable', locale))
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(disabled)
    );
  } else {
    toggle.addComponents(
      new ButtonBuilder()
        .setCustomId(IDS.disable)
        .setLabel(t('record.panel.disable', locale))
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(disabled)
    );
  }

  const components = [toggle];
  if (menuFits) {
    const menu = new ChannelSelectMenuBuilder()
      .setCustomId(IDS.exclusions)
      .setPlaceholder(t('record.panel.exclusionsPlaceholder', locale))
      .setChannelTypes(ChannelType.GuildVoice, ChannelType.GuildStageVoice)
      .setMinValues(0)
      .setMaxValues(MAX_SELECT)
      .setDisabled(disabled);
    if (selectable.length > 0) menu.setDefaultChannels(selectable);
    components.push(
      new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
        menu
      )
    );
  }

  return { embeds: [embed], components };
}

function audit(
  interaction: MessageComponentInteraction,
  guild: Guild,
  change: Parameters<typeof auditVoiceSettingChange>[3]
): void {
  auditVoiceSettingChange(
    interaction.client,
    guild,
    interaction.user.id,
    change,
    'statusPanel'
  );
}

async function handlePanelComponent(
  component: MessageComponentInteraction,
  guild: Guild,
  locale: Locale,
  state: PanelState
): Promise<'update'> {
  switch (component.customId) {
    case IDS.enable: {
      const outcome = await enableAutoJoin(guild);
      state.lastAction = [
        t('record.autojoin.enabled', locale, {
          minutes: Math.round(env.AUDIO_BUFFER_DURATION / 60),
        }),
        describeReconcile(outcome, locale),
      ]
        .filter(Boolean)
        .join('\n');
      audit(component, guild, { kind: 'autoJoinEnabled' });
      return 'update';
    }
    case IDS.disable:
      state.confirmingDisable = true;
      return 'update';
    case IDS.cancelDisable:
      state.confirmingDisable = false;
      state.lastAction = null;
      return 'update';
    case IDS.confirmDisable: {
      state.confirmingDisable = false;
      const dropped = await disableAutoJoin(guild.id);
      state.lastAction =
        dropped > 0
          ? `${t('record.panel.disabled', locale)}\n${t('record.autojoin.disabledDropped', locale)}`
          : t('record.panel.disabled', locale);
      audit(component, guild, { kind: 'autoJoinDisabled' });
      return 'update';
    }
    case IDS.exclusions: {
      if (!component.isChannelSelectMenu()) return 'update';
      const selected = new Set(component.values);
      const before = new Set(state.shownExclusions);
      const added = [...selected].filter((id) => !before.has(id));
      const removed = [...before].filter((id) => !selected.has(id));

      if (added.length === 0 && removed.length === 0) {
        state.lastAction = t('record.panel.nothingChanged', locale);
        return 'update';
      }

      // One change: the whole list is stored before the bot moves, so it
      // never joins a channel this same submission excludes.
      const changes = await applyExclusionChanges(guild, added, removed);
      if (changes.added.length === 0 && changes.removed.length === 0) {
        state.lastAction = t('record.panel.nothingChanged', locale);
        return 'update';
      }
      state.lastAction = [
        t('record.panel.exclusionsUpdated', locale, {
          added: channelMentions(changes.added, locale),
          removed: channelMentions(changes.removed, locale),
        }),
        describeReconcile(changes.outcome, locale),
      ]
        .filter(Boolean)
        .join('\n');
      audit(component, guild, {
        kind: 'exclusionsChanged',
        added: changes.added,
        removed: changes.removed,
      });
      return 'update';
    }
    default:
      return 'update';
  }
}

/**
 * `/voice status` - whether the caller's channel is being kept (and if not,
 * why), the guild's auto-join settings, and a panel to change them: turn
 * auto-join on or off and pick the excluded channels in one menu.
 */
export async function executeStatusCommand(
  interaction: ChatInputCommandInteraction
): Promise<void> {
  const locale = resolveLocale(interaction);
  const guild = interaction.guild;

  if (!guild) {
    await interaction.reply({
      embeds: [
        createErrorEmbed(
          t('common.error', locale),
          t('common.guildOnly', locale)
        ),
      ],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const state: PanelState = {
    confirmingDisable: false,
    lastAction: null,
    shownExclusions: [],
  };

  await runComponentPanel({
    interaction,
    locale,
    label: 'voice status panel',
    render: () => renderPanel(interaction, guild, locale, state),
    renderDisabled: () =>
      renderPanel(interaction, guild, locale, state, true).components,
    onComponent: (component) =>
      handlePanelComponent(component, guild, locale, state),
  });
}
