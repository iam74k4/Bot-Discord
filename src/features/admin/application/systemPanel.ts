import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChatInputCommandInteraction,
} from 'discord.js';
import { createEmbed } from '../../../shared/utils/embed.js';
import { COLORS } from '../../../shared/utils/constants/index.js';
import { type Locale, t } from '../../../locales/index.js';
import { databaseStatsRepository } from '../repositories/index.js';
import {
  formatHealthStatus,
  getHealthStatus,
} from '../../../infrastructure/health/index.js';
import { backupService } from '../../../infrastructure/backup/index.js';
import { metrics } from '../../../infrastructure/metrics/index.js';
import { runComponentPanel } from '../../../shared/utils/panel.js';

type AdminPanelView =
  'stats' | 'db' | 'guilds' | 'health' | 'metrics' | 'backups';

const PANEL_TIMEOUT = 120_000;
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
  const uptime = process.uptime();
  const days = Math.floor(uptime / 86400);
  const hours = Math.floor((uptime % 86400) / 3600);
  const minutes = Math.floor((uptime % 3600) / 60);
  const memoryMB = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);

  return createEmbed({
    title: t('admin.panel.statsTitle', locale),
    color: COLORS.INFO,
    fields: [
      {
        name: t('admin.panel.serversLabel', locale),
        value: guildCount.toLocaleString(),
        inline: true,
      },
      {
        name: t('admin.panel.usersLabel', locale),
        value: userCount.toLocaleString(),
        inline: true,
      },
      {
        name: t('admin.panel.channelsLabel', locale),
        value: channelCount.toLocaleString(),
        inline: true,
      },
      {
        name: t('admin.panel.uptimeLabel', locale),
        value: `${days}d ${hours}h ${minutes}m`,
        inline: true,
      },
      {
        name: t('admin.panel.memoryLabel', locale),
        value: `${memoryMB} MB`,
        inline: true,
      },
      {
        name: t('admin.panel.nodeLabel', locale),
        value: process.version,
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
                .map((table) => `\`${table.name}\`: ${table.count}`)
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
  const guilds = interaction.client.guilds.cache
    .sort((a, b) => b.memberCount - a.memberCount)
    .first(20);

  return createEmbed({
    title: t('admin.panel.guildsTitle', locale),
    description:
      guilds
        .map(
          (guild, index) =>
            `${index + 1}. **${guild.name}** (${guild.memberCount.toLocaleString()})`
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

async function buildBackupsEmbed(
  locale: Locale,
  lastRunMessage: string | null
) {
  const backupList = await backupService.formatBackupList();
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

export async function showAdminSystemPanel(
  interaction: ChatInputCommandInteraction,
  locale: Locale,
  initialView: AdminPanelView
): Promise<void> {
  let currentView = initialView;
  let lastBackupMessage: string | null = null;

  const render = async () => {
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

  await runComponentPanel({
    interaction,
    locale,
    label: 'admin system panel',
    timeout: PANEL_TIMEOUT,
    render: async () => ({
      embeds: [await render()],
      components: [
        buildMainRow(locale, currentView),
        buildUtilityRow(locale, currentView),
      ],
    }),
    renderDisabled: () => [
      buildMainRow(locale, currentView, true),
      buildUtilityRow(locale, currentView, true),
    ],
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
        currentView = 'backups';
        await componentInteraction.deferUpdate();

        const result = await backupService.runBackup();
        lastBackupMessage = result.success
          ? t('admin.panel.backupSuccess', locale, {
              filename: result.filename,
              size: String(Math.round(result.size / 1024)),
            })
          : t('admin.panel.backupFailure', locale, {
              error: result.error || t('common.unexpectedError', locale),
            });

        await interaction.editReply({
          embeds: [await render()],
          components: [
            buildMainRow(locale, currentView),
            buildUtilityRow(locale, currentView),
          ],
        });
        // Already deferred and edited above; nothing left for the panel to do.
        return 'handled';
      }

      if (action === 'refresh') {
        lastBackupMessage = null;
      }

      return 'update';
    },
  });
}
