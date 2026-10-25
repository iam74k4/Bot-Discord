import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChatInputCommandInteraction,
  escapeMarkdown,
} from 'discord.js';
import type { ExtendedClient } from '../../../client.js';
import { env } from '../../../config/index.js';
import { createEmbed } from '../../../shared/utils/embed.js';
import { COLORS } from '../../../shared/utils/constants/index.js';
import { type Locale, t } from '../../../locales/index.js';
import { formatDuration, formatNumber } from '../../../locales/format.js';
import { databaseStatsRepository } from '../repositories/index.js';
import {
  formatHealthStatus,
  getHealthStatus,
} from '../../../infrastructure/health/index.js';
import { backupService } from '../../../infrastructure/backup/index.js';
import { metrics } from '../../../infrastructure/metrics/index.js';
import {
  PANEL_MAX_LIFETIME,
  runComponentPanel,
  type PanelPayload,
} from '../../../shared/utils/panel.js';
import { runBackupSafely } from './backupRun.js';

type AdminPanelView =
  'stats' | 'db' | 'guilds' | 'health' | 'metrics' | 'backups';

const PANEL_TIMEOUT = 120_000;
/**
 * Slack for the panel's own timers, which start a moment before this code
 * reads the clock: a result this close to the close is shown disabled.
 */
const PANEL_CLOSE_MARGIN_MS = 1_000;
const SECONDS_PER_DAY = 86_400;
const DB_STATS_TABLES = [
  'guild_settings',
  'audit_logs',
  'notification_channels',
  'voice_sessions',
];

function buildMainRow(
  locale: Locale,
  view: AdminPanelView,
  disabled: boolean = false
): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId('admin-panel:stats')
      .setLabel(t('admin.panel.statsTab', locale))
      .setStyle(view === 'stats' ? ButtonStyle.Primary : ButtonStyle.Secondary)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId('admin-panel:db')
      .setLabel(t('admin.panel.dbTab', locale))
      .setStyle(view === 'db' ? ButtonStyle.Primary : ButtonStyle.Secondary)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId('admin-panel:guilds')
      .setLabel(t('admin.panel.guildsTab', locale))
      .setStyle(view === 'guilds' ? ButtonStyle.Primary : ButtonStyle.Secondary)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId('admin-panel:health')
      .setLabel(t('admin.panel.healthTab', locale))
      .setStyle(view === 'health' ? ButtonStyle.Primary : ButtonStyle.Secondary)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId('admin-panel:metrics')
      .setLabel(t('admin.panel.metricsTab', locale))
      .setStyle(
        view === 'metrics' ? ButtonStyle.Primary : ButtonStyle.Secondary
      )
      .setDisabled(disabled)
  );
}

function buildUtilityRow(
  locale: Locale,
  view: AdminPanelView,
  disabled: boolean = false
): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId('admin-panel:backups')
      .setLabel(t('admin.panel.backupsTab', locale))
      .setStyle(
        view === 'backups' ? ButtonStyle.Primary : ButtonStyle.Secondary
      )
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId('admin-panel:refresh')
      .setLabel(t('admin.panel.refresh', locale))
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId('admin-panel:run-backup')
      .setLabel(t('admin.panel.runBackup', locale))
      .setStyle(ButtonStyle.Success)
      .setDisabled(disabled)
  );
}

/**
 * `1日2時間3分` / `1d 2h 3m`. formatDuration stops at hours, which reads
 * badly for a process that has been up for weeks, so days are added here.
 */
export function formatUptime(seconds: number, locale: Locale): string {
  const safeSeconds = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
  const days = Math.floor(safeSeconds / SECONDS_PER_DAY);
  const restSeconds = safeSeconds - days * SECONDS_PER_DAY;
  const rest = formatDuration(restSeconds * 1000, locale);
  if (days === 0) return rest;

  const daysText = t('admin.panel.uptimeDays', locale, { count: days });
  if (restSeconds < 60) return daysText;
  return t('common.duration.pair', locale, { first: daysText, second: rest });
}

function buildStatsEmbed(
  interaction: ChatInputCommandInteraction,
  locale: Locale
) {
  const client = interaction.client;
  const guildCount = client.guilds.cache.size;
  const userCount = client.guilds.cache.reduce(
    (acc, guild) => acc + guild.memberCount,
    0
  );
  const channelCount = client.channels.cache.size;
  const memoryMB = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
  // Only the bot's own client carries the command registry; a bare Client
  // reads as zero instead of breaking the panel.
  const commandCount =
    (client as Partial<Pick<ExtendedClient, 'commands'>>).commands?.size ?? 0;

  return createEmbed({
    title: t('admin.panel.statsTitle', locale),
    color: COLORS.INFO,
    fields: [
      {
        name: t('admin.panel.serversLabel', locale),
        value: formatNumber(guildCount, locale),
        inline: true,
      },
      {
        name: t('admin.panel.usersLabel', locale),
        value: formatNumber(userCount, locale),
        inline: true,
      },
      {
        name: t('admin.panel.channelsLabel', locale),
        value: formatNumber(channelCount, locale),
        inline: true,
      },
      {
        name: t('admin.panel.uptimeLabel', locale),
        value: formatUptime(process.uptime(), locale),
        inline: true,
      },
      {
        name: t('admin.panel.memoryLabel', locale),
        value: `${formatNumber(memoryMB, locale)} MB`,
        inline: true,
      },
      {
        name: t('admin.panel.nodeLabel', locale),
        value: process.version,
        inline: true,
      },
      {
        name: t('admin.panel.environmentLabel', locale),
        value: env.NODE_ENV,
        inline: true,
      },
      {
        name: t('admin.panel.commandsLabel', locale),
        value: formatNumber(commandCount, locale),
        inline: true,
      },
    ],
    timestamp: true,
  });
}

function buildDbEmbed(locale: Locale) {
  const tableCounts = DB_STATS_TABLES.map((table) => ({
    name: table,
    count: databaseStatsRepository.getTableRowCount(table),
  })).filter(
    (table): table is { name: string; count: number } => table.count !== null
  );

  return createEmbed({
    title: t('admin.panel.dbTitle', locale),
    color: COLORS.INFO,
    fields: [
      {
        name: t('admin.panel.tablesLabel', locale),
        value:
          tableCounts.length > 0
            ? tableCounts
                .map(
                  (table) =>
                    `\`${table.name}\`: ${formatNumber(table.count, locale)}`
                )
                .join('\n')
            : t('common.noData', locale),
        inline: false,
      },
    ],
    timestamp: true,
  });
}

function buildGuildsEmbed(
  interaction: ChatInputCommandInteraction,
  locale: Locale
) {
  // `sorted` copies: `sort` would reorder the live guild cache in place.
  const guilds = interaction.client.guilds.cache
    .sorted((a, b) => b.memberCount - a.memberCount)
    .first(20);

  return createEmbed({
    title: t('admin.panel.guildsTitle', locale),
    description:
      guilds
        .map(
          (guild, index) =>
            `${index + 1}. **${escapeMarkdown(guild.name)}** (${formatNumber(
              guild.memberCount,
              locale
            )})`
        )
        .join('\n') || t('common.noData', locale),
    color: COLORS.INFO,
    timestamp: true,
  });
}

function buildHealthEmbed(
  interaction: ChatInputCommandInteraction,
  locale: Locale
) {
  const health = getHealthStatus(interaction.client);
  const statusColor =
    health.status === 'healthy'
      ? COLORS.SUCCESS
      : health.status === 'degraded'
        ? COLORS.WARNING
        : COLORS.ERROR;

  return createEmbed({
    title: t('admin.panel.healthTitle', locale),
    description: formatHealthStatus(health),
    color: statusColor,
    timestamp: true,
  });
}

function buildMetricsEmbed(locale: Locale) {
  return createEmbed({
    title: t('admin.panel.metricsTitle', locale),
    description: metrics.formatForDisplay(),
    color: COLORS.INFO,
    timestamp: true,
  });
}

/** Backups named in the list; the rest are counted. */
const BACKUPS_LISTED = 10;

/**
 * The newest backups, one per line. Times are Discord timestamps, so each
 * viewer reads them in their own language and time zone.
 */
export async function formatBackupList(locale: Locale): Promise<string> {
  const backups = await backupService.listBackups();
  if (backups.length === 0) return t('admin.panel.noBackups', locale);

  const lines = backups.slice(0, BACKUPS_LISTED).map((backup, index) => {
    const sizeKb = formatNumber(Math.round(backup.size / 1024), locale);
    const at = Math.floor(backup.createdAt.getTime() / 1000);
    return `${index + 1}. \`${backup.filename}\` (${sizeKb} KB) - <t:${at}:f>`;
  });
  if (backups.length > BACKUPS_LISTED) {
    lines.push(
      t('admin.panel.moreBackups', locale, {
        count: formatNumber(backups.length - BACKUPS_LISTED, locale),
      })
    );
  }
  return lines.join('\n');
}

async function buildBackupsEmbed(
  locale: Locale,
  lastRunMessage: string | null
) {
  const backupList = await formatBackupList(locale);
  const description = lastRunMessage
    ? `${lastRunMessage}\n\n${backupList}`
    : backupList;

  return createEmbed({
    title: t('admin.panel.backupsTitle', locale),
    description,
    color: COLORS.INFO,
    footer: t('admin.panel.backupsFooter', locale),
    timestamp: true,
  });
}

/** What the panel says about the backup it just ran. */
async function runBackupForPanel(locale: Locale): Promise<string> {
  const result = await runBackupSafely();

  return result.success
    ? t('admin.panel.backupSuccess', locale, {
        filename: result.filename,
        size: String(Math.round(result.size / 1024)),
      })
    : t('admin.panel.backupFailure', locale, {
        error: result.error || t('owner.backup.noReason', locale),
      });
}

export async function showAdminSystemPanel(
  interaction: ChatInputCommandInteraction,
  locale: Locale,
  initialView: AdminPanelView
): Promise<void> {
  let currentView = initialView;
  let lastBackupMessage: string | null = null;

  const renderEmbed = async () => {
    switch (currentView) {
      case 'stats':
        return buildStatsEmbed(interaction, locale);
      case 'db':
        return buildDbEmbed(locale);
      case 'guilds':
        return buildGuildsEmbed(interaction, locale);
      case 'health':
        return buildHealthEmbed(interaction, locale);
      case 'metrics':
        return buildMetricsEmbed(locale);
      case 'backups':
        return buildBackupsEmbed(locale, lastBackupMessage);
    }
  };

  const rows = (disabled: boolean) => [
    buildMainRow(locale, currentView, disabled),
    buildUtilityRow(locale, currentView, disabled),
  ];

  const render = async (): Promise<PanelPayload> => ({
    embeds: [await renderEmbed()],
    components: rows(false),
  });

  // When the panel's collector will have closed: idle since the last click,
  // or at the end of its lifetime. A backup can outlast either, and its
  // result must not switch the buttons back on with nothing listening.
  const openedAt = Date.now();
  const closedBy = (clickedAt: number) =>
    Math.min(
      clickedAt + PANEL_TIMEOUT - PANEL_CLOSE_MARGIN_MS,
      openedAt + PANEL_MAX_LIFETIME - PANEL_CLOSE_MARGIN_MS
    );

  await runComponentPanel({
    interaction,
    locale,
    label: 'admin system panel',
    timeout: PANEL_TIMEOUT,
    render,
    renderDisabled: () => rows(true),
    onComponent: async (componentInteraction) => {
      const action = componentInteraction.customId.replace('admin-panel:', '');

      if (
        action === 'stats' ||
        action === 'db' ||
        action === 'guilds' ||
        action === 'health' ||
        action === 'metrics' ||
        action === 'backups'
      ) {
        currentView = action;
      }

      if (action === 'run-backup') {
        const clickedAt = Date.now();
        currentView = 'backups';
        // Answer the click with a visible "running" state and every button
        // off, so the owner sees it started and cannot start a second one.
        await componentInteraction.update({
          embeds: [
            createEmbed({
              title: t('admin.panel.backupsTitle', locale),
              description: t('owner.backup.running', locale),
              color: COLORS.INFO,
            }),
          ],
          components: rows(true),
        });

        lastBackupMessage = await runBackupForPanel(locale);
        // The panel closed while the backup ran (it has already said so):
        // show the result, but keep the buttons off.
        const expired = Date.now() >= closedBy(clickedAt);
        await interaction.editReply({
          embeds: [await renderEmbed()],
          components: rows(expired),
        });
        // Already answered and edited above; nothing left for the panel.
        return 'handled';
      }

      if (action === 'refresh') {
        lastBackupMessage = null;
      }

      return 'update';
    },
  });
}
