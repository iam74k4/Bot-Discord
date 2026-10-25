import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ChannelType,
  ChatInputCommandInteraction,
  MessageFlags,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  type EmbedBuilder,
  type Guild,
} from 'discord.js';
import { createEmbed, createErrorEmbed } from '../../../shared/utils/embed.js';
import { COLORS } from '../../../shared/utils/constants/index.js';
import { type Locale, t, type TranslationKey } from '../../../locales/index.js';
import {
  LANGUAGE_AUTO,
  resolveBackgroundLocale,
  resolveLocale,
} from '../../../locales/guildLocale.js';
import { guildSettingsRepository } from '../../../infrastructure/guildSettings/index.js';
import {
  auditActionLabel,
  auditRepository,
  type AuditLogRecord,
  logAuditAction,
} from '../../../infrastructure/audit/index.js';
import {
  formatAuditTarget,
  shortenAuditDetails,
} from '../../../infrastructure/audit/format.js';
import { collectSettingsSummaries } from '../../../shared/settingsSummary/index.js';
import {
  runComponentPanel,
  type PanelPayload,
} from '../../../shared/utils/panel.js';
import {
  checkPostableChannel,
  describeChannelProblem,
} from './channelCheck.js';
import {
  ANNOUNCEMENT_CHANNEL_SETTING,
  AUDIT_CHANNEL_SETTING,
  saveChannelSetting,
  type ChannelSetting,
} from './channelSettings.js';
import {
  automaticPostLocale,
  isSupportedLanguageValue,
  languageDisplayName,
} from './languages.js';

type SettingsPanelView =
  | 'overview'
  | 'language'
  | 'audit'
  | 'announcements'
  | 'logs';

const PANEL_TIMEOUT = 120_000;
const LOGS_PAGE_SIZE = 10;
/** Discord's limit on fields per embed. */
const MAX_EMBED_FIELDS = 25;

/** The tab row: five buttons, the most one row holds. */
const TABS: ReadonlyArray<{
  view: SettingsPanelView;
  label: TranslationKey;
  emoji: string;
}> = [
  { view: 'overview', label: 'settings.panel.tabOverview', emoji: '🏠' },
  { view: 'language', label: 'settings.panel.tabLanguage', emoji: '🌐' },
  { view: 'audit', label: 'settings.panel.tabAudit', emoji: '🛡️' },
  {
    view: 'announcements',
    label: 'settings.panel.tabAnnouncements',
    emoji: '📢',
  },
  { view: 'logs', label: 'settings.panel.tabLogs', emoji: '📜' },
];

const TAB_BY_ID = new Map<string, SettingsPanelView>(
  TABS.map((tab) => [`settings-panel:${tab.view}`, tab.view])
);

/** A channel setting's tab: what its select and clear button change. */
interface ChannelTab {
  setting: ChannelSetting;
  selectId: string;
  clearId: string;
  titleKey: TranslationKey;
  notSetKey: TranslationKey;
  placeholderKey: TranslationKey;
  clearKey: TranslationKey;
  footerKey: TranslationKey;
}

const CHANNEL_TABS: Record<'audit' | 'announcements', ChannelTab> = {
  audit: {
    setting: AUDIT_CHANNEL_SETTING,
    selectId: 'settings-panel:audit-channel',
    clearId: 'settings-panel:audit-clear',
    titleKey: 'settings.audit.name',
    notSetKey: 'settings.audit.notSet',
    placeholderKey: 'settings.panel.auditPlaceholder',
    clearKey: 'settings.panel.clearAudit',
    footerKey: 'settings.panel.auditFooter',
  },
  announcements: {
    setting: ANNOUNCEMENT_CHANNEL_SETTING,
    selectId: 'settings-panel:announcement-channel',
    clearId: 'settings-panel:announcement-clear',
    titleKey: 'settings.announcements.name',
    notSetKey: 'settings.announcements.notSet',
    placeholderKey: 'settings.panel.announcementPlaceholder',
    clearKey: 'settings.panel.clearAnnouncements',
    footerKey: 'settings.panel.announcementsFooter',
  },
};

type ChannelTabView = keyof typeof CHANNEL_TABS;

const CHANNEL_TAB_BY_SELECT = new Map(
  (Object.keys(CHANNEL_TABS) as ChannelTabView[]).map(
    (view) => [CHANNEL_TABS[view].selectId, view] as const
  )
);
const CHANNEL_TAB_BY_CLEAR = new Map(
  (Object.keys(CHANNEL_TABS) as ChannelTabView[]).map(
    (view) => [CHANNEL_TABS[view].clearId, view] as const
  )
);

type PanelRow = ActionRowBuilder<
  ButtonBuilder | StringSelectMenuBuilder | ChannelSelectMenuBuilder
>;

/** Stored NULL means "follow the viewer"; the panel shows it as `auto`. */
function currentLanguageValue(guildId: string): string {
  return guildSettingsRepository.get(guildId)?.language ?? LANGUAGE_AUTO;
}

function buildTabRow(
  locale: Locale,
  view: SettingsPanelView,
  disabled: boolean
): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    TABS.map((tab) =>
      new ButtonBuilder()
        .setCustomId(`settings-panel:${tab.view}`)
        .setLabel(t(tab.label, locale))
        .setEmoji({ name: tab.emoji })
        .setStyle(
          view === tab.view ? ButtonStyle.Primary : ButtonStyle.Secondary
        )
        .setDisabled(disabled)
    )
  );
}

function buildLanguageRow(
  locale: Locale,
  currentLanguage: string,
  disabled: boolean
): ActionRowBuilder<StringSelectMenuBuilder> {
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('settings-panel:language-select')
      .setPlaceholder(t('settings.panel.languagePlaceholder', locale))
      .setDisabled(disabled)
      .addOptions(
        new StringSelectMenuOptionBuilder()
          .setLabel('English')
          .setValue('en')
          .setDefault(currentLanguage === 'en'),
        new StringSelectMenuOptionBuilder()
          .setLabel('日本語')
          .setValue('ja')
          .setDefault(currentLanguage === 'ja'),
        new StringSelectMenuOptionBuilder()
          .setLabel(t('settings.language.auto', locale))
          .setValue(LANGUAGE_AUTO)
          .setDefault(currentLanguage === LANGUAGE_AUTO)
      )
  );
}

function buildChannelRows(
  tab: ChannelTab,
  guild: Guild,
  locale: Locale,
  current: string | null,
  disabled: boolean
): PanelRow[] {
  const select = new ChannelSelectMenuBuilder()
    .setCustomId(tab.selectId)
    .setPlaceholder(t(tab.placeholderKey, locale))
    .setChannelTypes(ChannelType.GuildText)
    .setMinValues(1)
    .setMaxValues(1)
    .setDisabled(disabled);
  // Preselect only a channel that still exists: a default pointing at a
  // deleted channel could make Discord reject the whole panel, on the very
  // tab an admin opens to pick a new channel or clear the old one.
  if (current && guild.channels.cache.has(current)) {
    select.setDefaultChannels(current);
  }

  return [
    new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(select),
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(tab.clearId)
        .setLabel(t(tab.clearKey, locale))
        .setStyle(ButtonStyle.Danger)
        .setDisabled(disabled || !current)
    ),
  ];
}

function buildLogsPaginationRow(
  locale: Locale,
  page: number,
  totalPages: number,
  disabled: boolean
): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId('settings-panel:logs-prev')
      .setLabel(t('settings.panel.prevPage', locale))
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabled || page === 0),
    new ButtonBuilder()
      .setCustomId('settings-panel:logs-page')
      .setLabel(`${page + 1}/${totalPages}`)
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(true),
    new ButtonBuilder()
      .setCustomId('settings-panel:logs-next')
      .setLabel(t('settings.panel.nextPage', locale))
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabled || page >= totalPages - 1)
  );
}

/**
 * The whole setup on one screen: this panel's own settings, then whatever
 * other features registered (notification channels, VC auto-join), each
 * pointing at the command that changes it.
 */
async function buildOverviewEmbed(
  guild: Guild,
  locale: Locale
): Promise<EmbedBuilder> {
  const guildSettings = guildSettingsRepository.get(guild.id);
  const others = await collectSettingsSummaries({
    guildId: guild.id,
    guild,
    locale,
  });

  return createEmbed({
    title: t('settings.title', locale),
    color: COLORS.INFO,
    fields: [
      {
        name: t('settings.language.name', locale),
        value: languageDisplayName(
          guildSettings?.language ?? LANGUAGE_AUTO,
          locale
        ),
        inline: true,
      },
      {
        name: t('settings.audit.name', locale),
        value: guildSettings?.audit_channel_id
          ? `<#${guildSettings.audit_channel_id}>`
          : t('settings.audit.notSet', locale),
        inline: true,
      },
      {
        name: t('settings.announcements.name', locale),
        value: guildSettings?.announcement_channel_id
          ? `<#${guildSettings.announcement_channel_id}>`
          : t('settings.announcements.notSet', locale),
        inline: true,
      },
      ...others,
    ].slice(0, MAX_EMBED_FIELDS),
    footer: t('settings.panel.overviewFooter', locale),
  });
}

function buildLanguageEmbed(guild: Guild, locale: Locale): EmbedBuilder {
  const languageDisplay = languageDisplayName(
    currentLanguageValue(guild.id),
    locale
  );

  return createEmbed({
    title: t('settings.language.name', locale),
    description:
      `${t('settings.language.current', locale)}: **${languageDisplay}**` +
      `\n\n${t('settings.language.autoHint', locale, {
        lang: languageDisplayName(automaticPostLocale(guild), locale),
      })}`,
    color: COLORS.INFO,
    footer: t('settings.panel.languageFooter', locale),
  });
}

function buildChannelEmbed(
  tab: ChannelTab,
  current: string | null,
  locale: Locale
): EmbedBuilder {
  return createEmbed({
    title: t(tab.titleKey, locale),
    description: current ? `<#${current}>` : t(tab.notSetKey, locale),
    color: COLORS.INFO,
    footer: t(tab.footerKey, locale),
  });
}

/**
 * One entry: when, who, what, to whom; then the stored details, which name
 * the role, channel or language involved.
 */
function formatLog(log: AuditLogRecord, locale: Locale): string {
  const timestamp = Math.floor(log.created_at / 1000);
  const targetDisplay = formatAuditTarget(log.action, log.target_id);
  const target = targetDisplay ? ` → ${targetDisplay}` : '';
  const line = `<t:${timestamp}:R> <@${log.user_id}> **${auditActionLabel(
    log.action,
    locale
  )}**${target}`;
  return log.details ? `${line}\n└ ${shortenAuditDetails(log.details)}` : line;
}

interface LogsView {
  embed: EmbedBuilder;
  /** The page shown, clamped to the pages that exist. */
  page: number;
  totalPages: number;
  total: number;
}

/**
 * One page of the audit log, read with a count and a single page query, so
 * every entry kept is reachable and each render reads only what it shows.
 */
function buildLogsView(
  guildId: string,
  locale: Locale,
  page: number
): LogsView {
  const total = auditRepository.getLogsCount(guildId);

  if (total === 0) {
    return {
      embed: createEmbed({
        title: t('settings.logs.title', locale),
        description: t('settings.logs.noLogs', locale),
        color: COLORS.INFO,
      }),
      page: 0,
      totalPages: 1,
      total: 0,
    };
  }

  const totalPages = Math.ceil(total / LOGS_PAGE_SIZE);
  const safePage = Math.min(Math.max(0, page), totalPages - 1);
  const logs = auditRepository.getLogs(
    guildId,
    LOGS_PAGE_SIZE,
    safePage * LOGS_PAGE_SIZE
  );
  const from = safePage * LOGS_PAGE_SIZE + 1;

  return {
    embed: createEmbed({
      title: t('settings.logs.title', locale),
      description: logs.map((log) => formatLog(log, locale)).join('\n'),
      color: COLORS.INFO,
      footer: t('settings.logs.showingRange', locale, {
        from,
        to: from + Math.max(0, logs.length - 1),
        total,
      }),
    }),
    page: safePage,
    totalPages,
    total,
  };
}

export async function showSettingsPanel(
  interaction: ChatInputCommandInteraction,
  initialLocale: Locale,
  initialView: SettingsPanelView = 'overview'
): Promise<void> {
  const guild = interaction.guild;
  if (!guild || !interaction.guildId) {
    await interaction.reply({
      embeds: [
        createErrorEmbed(
          t('common.error', initialLocale),
          t('common.guildOnly', initialLocale)
        ),
      ],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // Re-resolved after a language change, so the whole panel switches at once.
  let locale = initialLocale;
  let currentView = initialView;
  let logsPage = 0;
  /** The logs page last rendered; the expired panel reuses its pager. */
  let lastLogs: Pick<LogsView, 'total' | 'totalPages'> | null = null;

  const components = (
    disabled: boolean,
    logs: Pick<LogsView, 'total' | 'totalPages'> | null
  ): PanelRow[] => {
    const rows: PanelRow[] = [buildTabRow(locale, currentView, disabled)];

    if (currentView === 'language') {
      rows.push(
        buildLanguageRow(locale, currentLanguageValue(guild.id), disabled)
      );
    } else if (currentView === 'audit' || currentView === 'announcements') {
      const tab = CHANNEL_TABS[currentView];
      rows.push(
        ...buildChannelRows(
          tab,
          guild,
          locale,
          tab.setting.read(guild.id),
          disabled
        )
      );
    } else if (currentView === 'logs' && logs && logs.total > 0) {
      rows.push(
        buildLogsPaginationRow(locale, logsPage, logs.totalPages, disabled)
      );
    }

    return rows;
  };

  const render = async (): Promise<PanelPayload> => {
    switch (currentView) {
      case 'overview':
        return {
          embeds: [await buildOverviewEmbed(guild, locale)],
          components: components(false, null),
        };
      case 'language':
        return {
          embeds: [buildLanguageEmbed(guild, locale)],
          components: components(false, null),
        };
      case 'audit':
      case 'announcements': {
        const tab = CHANNEL_TABS[currentView];
        return {
          embeds: [buildChannelEmbed(tab, tab.setting.read(guild.id), locale)],
          components: components(false, null),
        };
      }
      case 'logs': {
        const logs = buildLogsView(guild.id, locale, logsPage);
        logsPage = logs.page;
        lastLogs = logs;
        return { embeds: [logs.embed], components: components(false, logs) };
      }
    }
  };

  await runComponentPanel({
    interaction,
    // The language tab can switch the panel's language while it is open.
    locale: () => locale,
    label: 'settings panel',
    timeout: PANEL_TIMEOUT,
    render,
    renderDisabled: () => components(true, lastLogs),
    onComponent: async (componentInteraction) => {
      const id = componentInteraction.customId;

      if (componentInteraction.isButton()) {
        const tab = TAB_BY_ID.get(id);
        if (tab) {
          currentView = tab;
          if (currentView !== 'logs') logsPage = 0;
        }

        if (currentView === 'logs' && id === 'settings-panel:logs-prev') {
          logsPage = Math.max(0, logsPage - 1);
        }
        if (currentView === 'logs' && id === 'settings-panel:logs-next') {
          logsPage++;
        }

        const cleared = CHANNEL_TAB_BY_CLEAR.get(id);
        if (cleared) {
          saveChannelSetting(CHANNEL_TABS[cleared].setting, {
            client: interaction.client,
            guild,
            userId: componentInteraction.user.id,
            channelId: null,
          });
          currentView = cleared;
        }
      }

      if (
        componentInteraction.isStringSelectMenu() &&
        id === 'settings-panel:language-select'
      ) {
        const value = componentInteraction.values[0];
        if (isSupportedLanguageValue(value)) {
          guildSettingsRepository.setLanguage(
            guild.id,
            value === LANGUAGE_AUTO ? null : value
          );
          const auditLocale = resolveBackgroundLocale(guild);
          // Not awaited: posting to the audit channel can be slow or rate
          // limited, and the click must be answered within 3 seconds. The
          // row itself is written before this call returns.
          void logAuditAction(
            interaction.client,
            guild.id,
            componentInteraction.user.id,
            'SETTINGS_CHANGE',
            undefined,
            t('audit.details.language', auditLocale, {
              language: languageDisplayName(value, auditLocale),
            })
          );
          locale = resolveLocale(componentInteraction);
          currentView = 'language';
        }
      }

      if (componentInteraction.isChannelSelectMenu()) {
        const view = CHANNEL_TAB_BY_SELECT.get(id);
        const channelId = componentInteraction.values[0];
        if (view && channelId) {
          const check = await checkPostableChannel(guild, channelId);
          if (!check.ok) {
            // Re-render first, so the select goes back to the stored channel
            // instead of showing the rejected one as if it had been saved;
            // then say why it was refused.
            currentView = view;
            await componentInteraction.update(await render());
            await componentInteraction.followUp({
              embeds: [
                createErrorEmbed(
                  t('common.error', locale),
                  describeChannelProblem(check, locale)
                ),
              ],
              flags: MessageFlags.Ephemeral,
            });
            return 'handled';
          }

          saveChannelSetting(CHANNEL_TABS[view].setting, {
            client: interaction.client,
            guild,
            userId: componentInteraction.user.id,
            channelId,
          });
          currentView = view;
        }
      }

      return 'update';
    },
  });
}
