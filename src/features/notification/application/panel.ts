import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ChannelType,
  ChatInputCommandInteraction,
  Guild,
  MessageComponentInteraction,
  MessageFlags,
  PermissionFlagsBits,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  escapeMarkdown,
} from 'discord.js';
import { createEmbed, createErrorEmbed } from '../../../shared/utils/embed.js';
import { COLORS } from '../../../shared/utils/constants/index.js';
import { t, type Locale } from '../../../locales/index.js';
import { formatDuration } from '../../../locales/format.js';
import {
  notificationChannelRepository,
  type NotificationChannelRecord,
  type NotificationType,
} from '../repositories/notificationChannelRepository.js';
import { voiceSessionRepository } from '../repositories/voiceSessionRepository.js';
import { voiceTracker } from '../tracking/voiceTracker.js';
import {
  DEFAULT_STATS_TIME_ZONE,
  dayKey,
  daySegments,
  getStatsTimeZone,
} from '../stats/calendar.js';
import {
  STATS_PERIODS,
  isStatsPeriod,
  periodStartDay,
  type StatsPeriod,
} from '../stats/periods.js';
import { interactionHasGuildPermission } from '../../../shared/utils/discord.js';
import { runComponentPanel } from '../../../shared/utils/panel.js';
import { audit } from '../../../infrastructure/audit/index.js';
import { checkNotificationChannel } from './channelCheck.js';
import { describePostLanguage } from './postLanguage.js';

type NotificationPanelView = 'status' | 'stats';

const NOTIFICATION_TYPES: readonly NotificationType[] = [
  'voice',
  'member_join',
];

const PANEL_TIMEOUT = 120_000;
/** Channels listed by name; any beyond this are summed into "and N more". */
const STATS_MAX_ROWS = 10;
const RANK_MARKS = ['🥇', '🥈', '🥉'];

const AUDIT_KIND: Record<NotificationType, 'Voice' | 'Welcome'> = {
  voice: 'Voice',
  member_join: 'Welcome',
};

const REMOVE_ID = /^notification-panel:(voice|member_join):remove$/;
const REMOVE_CONFIRM_ID =
  /^notification-panel:(voice|member_join):remove-confirm$/;
const REMOVE_CANCEL_ID = 'notification-panel:remove-cancel';

function typeLabel(type: NotificationType, locale: Locale): string {
  return type === 'voice'
    ? t('notification.status.voiceLabel', locale)
    : t('notification.status.welcomeLabel', locale);
}

function buildNavigationRow(
  locale: Locale,
  view: NotificationPanelView,
  canManageGuild: boolean,
  disabled: boolean = false
): ActionRowBuilder<ButtonBuilder> {
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId('notification-panel:stats')
      .setLabel(t('notification.panel.statsTab', locale))
      .setStyle(view === 'stats' ? ButtonStyle.Primary : ButtonStyle.Secondary)
      .setDisabled(disabled)
  );

  if (canManageGuild) {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId('notification-panel:status')
        .setLabel(t('notification.panel.statusTab', locale))
        .setStyle(
          view === 'status' ? ButtonStyle.Primary : ButtonStyle.Secondary
        )
        .setDisabled(disabled)
    );
  }

  return row;
}

function buildStatsPeriodRow(
  locale: Locale,
  period: StatsPeriod,
  disabled: boolean = false
): ActionRowBuilder<StringSelectMenuBuilder> {
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('notification-panel:stats-period')
      .setPlaceholder(t('notification.panel.periodPlaceholder', locale))
      .setDisabled(disabled)
      .addOptions(
        STATS_PERIODS.map((value) =>
          new StringSelectMenuOptionBuilder()
            .setLabel(t(`notification.stats.periods.${value}`, locale))
            .setValue(value)
            .setDefault(period === value)
        )
      )
  );
}

function buildChannelSelectRow(
  guild: Guild,
  locale: Locale,
  type: NotificationType,
  record: NotificationChannelRecord | undefined,
  disabled: boolean = false
): ActionRowBuilder<ChannelSelectMenuBuilder> {
  const placeholder =
    type === 'voice'
      ? t('notification.panel.voicePlaceholder', locale)
      : t('notification.panel.welcomePlaceholder', locale);

  const menu = new ChannelSelectMenuBuilder()
    .setCustomId(`notification-panel:${type}:channel`)
    .setPlaceholder(placeholder)
    .setChannelTypes(ChannelType.GuildText)
    .setMinValues(1)
    .setMaxValues(1)
    .setDisabled(disabled);

  // Show the current target as selected. A deleted channel would be an
  // invalid default, so only one the bot can still see is used.
  if (record?.enabled && guild.channels.cache.has(record.channel_id)) {
    menu.setDefaultChannels(record.channel_id);
  }

  return new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(menu);
}

function buildRemovalRow(
  locale: Locale,
  records: NotificationChannelRecord[],
  pendingRemoval: NotificationType | null,
  disabled: boolean = false
): ActionRowBuilder<ButtonBuilder> {
  if (pendingRemoval) {
    return new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`notification-panel:${pendingRemoval}:remove-confirm`)
        .setLabel(t('notification.panel.confirmRemoveButton', locale))
        .setStyle(ButtonStyle.Danger)
        .setDisabled(disabled),
      new ButtonBuilder()
        .setCustomId(REMOVE_CANCEL_ID)
        .setLabel(t('notification.panel.cancelRemoveButton', locale))
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(disabled)
    );
  }

  // A stored but disabled row reads as 未設定 in the embed, so it has nothing
  // to switch off either.
  const isOn = (type: NotificationType) =>
    records.some((record) => record.type === type && record.enabled);
  const hasVoice = isOn('voice');
  const hasWelcome = isOn('member_join');

  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId('notification-panel:voice:remove')
      .setLabel(t('notification.panel.removeVoice', locale))
      .setStyle(ButtonStyle.Danger)
      .setDisabled(disabled || !hasVoice),
    new ButtonBuilder()
      .setCustomId('notification-panel:member_join:remove')
      .setLabel(t('notification.panel.removeWelcome', locale))
      .setStyle(ButtonStyle.Danger)
      .setDisabled(disabled || !hasWelcome)
  );
}

interface StatusState {
  /** A removal waiting for its confirm button. */
  pendingRemoval: NotificationType | null;
  /** What the last click changed, shown until the next click. */
  lastResult: string | null;
}

function buildStatusEmbed(guild: Guild, locale: Locale, state: StatusState) {
  const records = notificationChannelRepository.getAllForGuild(guild.id);

  const fields = NOTIFICATION_TYPES.map((type) => {
    const record = records.find((item) => item.type === type);
    return {
      name: typeLabel(type, locale),
      value: record?.enabled
        ? `<#${record.channel_id}>`
        : t('notification.status.disabled', locale),
      inline: true,
    };
  });

  const postLanguage = describePostLanguage(guild, locale);
  fields.push({
    name: t('notification.status.postLanguage', locale),
    value: postLanguage.hint
      ? `${postLanguage.name}\n${postLanguage.hint}`
      : postLanguage.name,
    inline: false,
  });

  const pending = state.pendingRemoval
    ? records.find((item) => item.type === state.pendingRemoval)
    : undefined;

  return createEmbed({
    title: t('notification.status.title', locale),
    description: pending
      ? t('notification.panel.confirmRemove', locale, {
          type: typeLabel(pending.type, locale),
          channel: pending.channel_id,
        })
      : (state.lastResult ?? t('notification.panel.statusDescription', locale)),
    color: pending ? COLORS.WARNING : COLORS.INFO,
    fields,
    timestamp: true,
  });
}

interface StatsRow {
  channelId: string;
  name: string;
  durationMs: number;
  sessions: number;
  live: boolean;
}

function dayBoundaryFooter(locale: Locale): string {
  const zone = getStatsTimeZone();
  return zone === DEFAULT_STATS_TIME_ZONE
    ? t('notification.stats.dayBoundaryJapan', locale)
    : t('notification.stats.dayBoundary', locale, { zone });
}

function formatStatsRow(row: StatsRow, index: number, locale: Locale): string {
  const rank = RANK_MARKS[index] ?? `${index + 1}.`;
  const live = row.live ? t('notification.stats.live', locale) : '';
  const sessions =
    row.sessions > 0
      ? t('notification.stats.sessions', locale, { count: row.sessions })
      : '';
  const duration = formatDuration(row.durationMs, locale);
  return `${rank} **${escapeMarkdown(row.name)}**${live} — ${duration}${sessions}`;
}

/**
 * The reader's VC time per channel for a period.
 *
 * The rollup only learns about a visit when it ends, so the visit in progress
 * is added from the tracker, split by day exactly as `endSession` will store
 * it, so the numbers do not jump when the user leaves.
 */
export function buildStatsEmbed(
  guild: Guild,
  userId: string,
  period: StatsPeriod,
  locale: Locale,
  now: number = Date.now()
) {
  const since = periodStartDay(period, now);
  const periodLabel = t(`notification.stats.periods.${period}`, locale);
  const footer = since === undefined ? undefined : dayBoundaryFooter(locale);

  const rows: StatsRow[] = voiceSessionRepository
    .getUserChannelStats(guild.id, userId, since)
    .map((stat) => ({
      channelId: stat.channel_id,
      // The name the channel has now, when the bot can still see it.
      name:
        guild.channels.cache.get(stat.channel_id)?.name ?? stat.channel_name,
      durationMs: stat.total_duration_ms,
      sessions: stat.session_count,
      live: false,
    }));

  let liveLine: string | null = null;
  const session = voiceTracker.getActiveSession(guild.id, userId);
  if (session) {
    const liveMs = daySegments(session.joinedAt, now)
      .filter((segment) => since === undefined || segment.day >= since)
      .reduce((sum, segment) => sum + segment.durationMs, 0);

    if (liveMs > 0) {
      liveLine = t('notification.stats.liveSession', locale, {
        channel: session.channelId,
        duration: formatDuration(now - session.joinedAt, locale),
      });

      let row = rows.find((item) => item.channelId === session.channelId);
      if (!row) {
        row = {
          channelId: session.channelId,
          name:
            guild.channels.cache.get(session.channelId)?.name ??
            session.channelName,
          durationMs: 0,
          sessions: 0,
          live: true,
        };
        rows.push(row);
      }
      row.durationMs += liveMs;
      row.live = true;
      // A visit counts on the day it started, as in the rollup.
      if (since === undefined || dayKey(session.joinedAt) >= since) {
        row.sessions += 1;
      }
      rows.sort((a, b) => b.durationMs - a.durationMs);
    }
  }

  const periodField = {
    name: t('notification.stats.period', locale),
    value: periodLabel,
    inline: true,
  };

  if (rows.length === 0) {
    let description = t('notification.stats.noData', locale, {
      period: periodLabel,
    });
    if (
      since !== undefined &&
      voiceSessionRepository.getUserTotalDuration(guild.id, userId) > 0
    ) {
      const hint = t('notification.stats.noDataInPeriodHint', locale, {
        all: t('notification.stats.periods.all', locale),
      });
      description += `\n\n${hint}`;
    }

    return createEmbed({
      title: t('notification.stats.title', locale),
      description,
      color: COLORS.INFO,
      fields: [periodField],
      footer,
      timestamp: true,
    });
  }

  const totalMs = rows.reduce((sum, row) => sum + row.durationMs, 0);
  const lines = rows
    .slice(0, STATS_MAX_ROWS)
    .map((row, index) => formatStatsRow(row, index, locale));
  if (rows.length > STATS_MAX_ROWS) {
    lines.push(
      t('notification.stats.more', locale, {
        count: rows.length - STATS_MAX_ROWS,
      })
    );
  }

  return createEmbed({
    title: t('notification.stats.title', locale),
    description: [...(liveLine ? [liveLine, ''] : []), ...lines].join('\n'),
    color: COLORS.INFO,
    fields: [
      {
        name: t('notification.stats.total', locale),
        value: formatDuration(totalMs, locale),
        inline: true,
      },
      periodField,
    ],
    footer,
    timestamp: true,
  });
}

function buildComponents(
  guild: Guild,
  locale: Locale,
  view: NotificationPanelView,
  period: StatsPeriod,
  canManageGuild: boolean,
  pendingRemoval: NotificationType | null,
  disabled: boolean = false
) {
  const rows: ActionRowBuilder<
    ButtonBuilder | StringSelectMenuBuilder | ChannelSelectMenuBuilder
  >[] = [buildNavigationRow(locale, view, canManageGuild, disabled)];

  if (view === 'stats') {
    rows.push(buildStatsPeriodRow(locale, period, disabled));
    return rows;
  }

  if (!canManageGuild) {
    return rows;
  }

  const records = notificationChannelRepository.getAllForGuild(guild.id);
  for (const type of NOTIFICATION_TYPES) {
    const record = records.find((item) => item.type === type);
    rows.push(buildChannelSelectRow(guild, locale, type, record, disabled));
  }
  rows.push(buildRemovalRow(locale, records, pendingRemoval, disabled));
  return rows;
}

export async function showNotificationPanel(
  interaction: ChatInputCommandInteraction,
  locale: Locale,
  options?: {
    initialView?: NotificationPanelView;
    initialPeriod?: StatsPeriod;
  }
): Promise<void> {
  if (!interaction.guild || !interaction.guildId) {
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

  const guild = interaction.guild;
  const canManageGuild = interactionHasGuildPermission(
    interaction,
    PermissionFlagsBits.ManageGuild
  );
  let view: NotificationPanelView =
    options?.initialView === 'status' && canManageGuild ? 'status' : 'stats';
  let period: StatsPeriod = options?.initialPeriod ?? 'all';
  const status: StatusState = { pendingRemoval: null, lastResult: null };

  const components = (disabled: boolean) =>
    buildComponents(
      guild,
      locale,
      view,
      period,
      canManageGuild,
      status.pendingRemoval,
      disabled
    );

  /** Settings-view buttons; only reached for Manage Server holders. */
  const onSettingsButton = (
    customId: string,
    userId: string,
    pendingRemoval: NotificationType | null
  ) => {
    if (customId === 'notification-panel:status') {
      view = 'status';
    }

    if (customId === REMOVE_CANCEL_ID) {
      view = 'status';
    }

    const remove = REMOVE_ID.exec(customId);
    if (remove) {
      const type = remove[1] as NotificationType;
      view = 'status';
      // Nothing switched on means nothing to confirm: a stale or forged click.
      if (notificationChannelRepository.getEnabled(guild.id, type)) {
        status.pendingRemoval = type;
      }
    }

    // Only the removal the user was just asked about: a confirm without that
    // step (stale or forged) removes nothing.
    const confirm = REMOVE_CONFIRM_ID.exec(customId);
    if (confirm && pendingRemoval && confirm[1] === pendingRemoval) {
      const previous = notificationChannelRepository.get(
        guild.id,
        pendingRemoval
      );
      view = 'status';
      if (notificationChannelRepository.remove(guild.id, pendingRemoval)) {
        void audit.notifyRemove(
          interaction.client,
          guild.id,
          userId,
          AUDIT_KIND[pendingRemoval]
        );
        status.lastResult = t('notification.panel.removed', locale, {
          type: typeLabel(pendingRemoval, locale),
          channel: previous?.channel_id ?? '',
        });
      }
    }
  };

  const onChannelSelect = async (
    componentInteraction: MessageComponentInteraction & { values: string[] },
    before: StatusState
  ): Promise<'update' | 'handled'> => {
    const type: NotificationType =
      componentInteraction.customId === 'notification-panel:voice:channel'
        ? 'voice'
        : 'member_join';
    const channelId = componentInteraction.values[0];
    const check = await checkNotificationChannel(guild, channelId, locale);

    if (!check.ok) {
      // The panel is left as it was, including a removal awaiting confirm.
      Object.assign(status, before);
      await componentInteraction.reply({
        embeds: [createErrorEmbed(t('common.error', locale), check.message)],
        flags: MessageFlags.Ephemeral,
      });
      return 'handled';
    }

    notificationChannelRepository.set(guild.id, type, channelId);
    void audit.notifySetup(
      interaction.client,
      guild.id,
      componentInteraction.user.id,
      channelId,
      AUDIT_KIND[type]
    );
    status.lastResult = t('notification.panel.changed', locale, {
      type: typeLabel(type, locale),
      channel: channelId,
    });
    view = 'status';
    return 'update';
  };

  await runComponentPanel({
    interaction,
    locale,
    label: 'notification panel',
    timeout: PANEL_TIMEOUT,
    render: () => ({
      embeds: [
        view === 'status'
          ? buildStatusEmbed(guild, locale, status)
          : buildStatsEmbed(guild, interaction.user.id, period, locale),
      ],
      components: components(false),
    }),
    renderDisabled: () => components(true),
    onComponent: async (componentInteraction) => {
      // A removal waits for its confirm button and a result line lasts one
      // render: any other click clears both.
      const before = { ...status };
      status.pendingRemoval = null;
      status.lastResult = null;

      if (componentInteraction.isButton()) {
        if (componentInteraction.customId === 'notification-panel:stats') {
          view = 'stats';
        } else if (canManageGuild) {
          onSettingsButton(
            componentInteraction.customId,
            componentInteraction.user.id,
            before.pendingRemoval
          );
        }
      }

      if (componentInteraction.isStringSelectMenu()) {
        view = 'stats';
        const [value] = componentInteraction.values;
        if (isStatsPeriod(value)) period = value;
      }

      if (canManageGuild && componentInteraction.isChannelSelectMenu()) {
        return onChannelSelect(componentInteraction, before);
      }

      return 'update';
    },
  });
}
