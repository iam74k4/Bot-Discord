import Database from 'better-sqlite3';
import {
  ButtonStyle,
  ChannelType,
  Collection,
  ComponentType,
  MessageFlags,
  PermissionFlagsBits,
  type ChatInputCommandInteraction,
  type Client,
  type Guild,
} from 'discord.js';
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from 'vitest';
import {
  GUILD_ID,
  USER_ID,
  auditRows,
  clearAdminTables,
  clientStub,
  componentStub,
  createPanelHarness,
  embedAt,
  guildStub,
  insertAuditLogs,
  migrateAdminSchema,
  payloadOf,
  rowsOf,
  settingsRow,
  textChannelStub,
} from './admin.helpers.js';

/**
 * `/admin settings view|logs` open one panel that both shows and edits the
 * guild's settings. These drive the real panel through its collector against
 * real SQLite, because what matters is what each tab/select/button persists,
 * audit-logs and re-renders - not that a particular helper was called.
 */

const db = new Database(':memory:');

vi.mock('../../../infrastructure/database/connection.js', () => ({
  database: db,
}));

vi.mock('../../../shared/utils/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
  getErrorMessage: (e: unknown) => String(e),
}));

const { showSettingsPanel } = await import('../application/settingsPanel.js');
const { t } = await import('../../../locales/index.js');
const { guildSettingsRepository } =
  await import('../../../infrastructure/guildSettings/index.js');
const { auditRepository } =
  await import('../../../infrastructure/audit/index.js');
const { clearSettingsSummaries, registerSettingsSummary } =
  await import('../../../shared/settingsSummary/index.js');
const { formatPermissionNames } =
  await import('../../../shared/utils/discord.js');

const AUDIT_CHANNEL = textChannelStub({ id: 'audit-chan', name: 'mod-log' });
const NEWS_CHANNEL = textChannelStub({ id: 'news-chan', name: 'news' });
const MUTED_CHANNEL = textChannelStub({
  id: 'muted-chan',
  name: 'read-only',
  canSend: false,
});

const TAB_IDS = [
  'settings-panel:overview',
  'settings-panel:language',
  'settings-panel:audit',
  'settings-panel:announcements',
  'settings-panel:logs',
];

function setup(
  options: { guild?: Guild | null; client?: Client; locale?: string } = {}
) {
  const harness = createPanelHarness();
  const client = options.client ?? clientStub();
  const guild =
    options.guild === undefined
      ? guildStub({ channels: [AUDIT_CHANNEL, NEWS_CHANNEL, MUTED_CHANNEL] })
      : options.guild;
  const interaction = {
    guild,
    guildId: guild?.id ?? null,
    user: { id: USER_ID },
    client,
    locale: options.locale ?? 'en-US',
    reply: harness.reply,
    editReply: harness.editReply,
  } as unknown as ChatInputCommandInteraction;
  return { interaction, harness, client };
}

type Payload = { embeds: unknown[]; components: unknown[]; flags?: number };

/** The last payload the panel re-rendered with after a component. */
function lastUpdate(component: { update: Mock }) {
  return payloadOf<Payload>(
    component.update,
    component.update.mock.calls.length - 1
  );
}

/** The `n/total` label of the logs pager in a payload. */
function pageLabel(payload: Payload): string | undefined {
  return rowsOf(payload.components)[1]?.[1]?.label;
}

describe('showSettingsPanel', () => {
  beforeAll(async () => {
    await migrateAdminSchema();
  });

  beforeEach(() => {
    clearAdminTables(db);
    clearSettingsSummaries();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('refuses to open outside a guild', async () => {
    const { interaction, harness } = setup({ guild: null });

    await showSettingsPanel(interaction, 'en');

    const payload = payloadOf<Payload>(harness.reply);
    expect(payload.flags).toBe(MessageFlags.Ephemeral);
    expect(embedAt(payload).description).toBe(t('common.guildOnly', 'en'));
    expect(
      harness.message.createMessageComponentCollector
    ).not.toHaveBeenCalled();
  });

  describe('overview tab', () => {
    it('shows defaults for a guild that never configured anything', async () => {
      const { interaction, harness } = setup();

      await showSettingsPanel(interaction, 'en');

      const payload = payloadOf<Payload>(harness.reply);
      const embed = embedAt(payload);
      expect(payload.flags).toBe(MessageFlags.Ephemeral);
      expect(embed.title).toBe(t('settings.title', 'en'));
      expect(embed.fields?.map((f) => f.value)).toEqual([
        t('settings.language.auto', 'en'),
        t('settings.audit.notSet', 'en'),
        t('settings.announcements.notSet', 'en'),
      ]);
      expect(embed.footer?.text).toBe(t('settings.panel.overviewFooter', 'en'));

      // Only the tab row: overview has nothing to edit inline. Five tabs,
      // the most a row holds, each labelled and marked with an emoji.
      const rows = rowsOf(payload.components);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.map((c) => c.custom_id)).toEqual(TAB_IDS);
      expect(rows[0]!.map((c) => c.label)).toEqual([
        t('settings.panel.tabOverview', 'en'),
        t('settings.panel.tabLanguage', 'en'),
        t('settings.panel.tabAudit', 'en'),
        t('settings.panel.tabAnnouncements', 'en'),
        t('settings.panel.tabLogs', 'en'),
      ]);
      expect(rows[0]!.every((c) => Boolean(c.emoji?.name))).toBe(true);
      expect(rows[0]!.map((c) => c.style)).toEqual([
        ButtonStyle.Primary,
        ButtonStyle.Secondary,
        ButtonStyle.Secondary,
        ButtonStyle.Secondary,
        ButtonStyle.Secondary,
      ]);
    });

    it('shows the stored language and channels', async () => {
      guildSettingsRepository.update(GUILD_ID, {
        language: 'ja',
        audit_channel_id: 'audit-chan',
        announcement_channel_id: 'news-chan',
      });
      const { interaction, harness } = setup();

      await showSettingsPanel(interaction, 'ja');

      const embed = embedAt(payloadOf(harness.reply));
      expect(embed.title).toBe(t('settings.title', 'ja'));
      expect(embed.fields?.map((f) => f.value)).toEqual([
        '日本語',
        '<#audit-chan>',
        '<#news-chan>',
      ]);
    });

    it('shows a stored language code it has no name for as-is', async () => {
      guildSettingsRepository.setLanguage(GUILD_ID, 'ko');
      const { interaction, harness } = setup();

      await showSettingsPanel(interaction, 'en');

      expect(embedAt(payloadOf(harness.reply)).fields?.[0]?.value).toBe('ko');
    });

    it("lists other features' settings after its own, asked in the viewer's language", async () => {
      const provider = vi.fn(() => [
        { name: 'VC通知', value: '<#vc-log>', inline: true },
        { name: '参加通知', value: '未設定' },
      ]);
      registerSettingsSummary('notification', provider);
      const { interaction, harness } = setup();

      await showSettingsPanel(interaction, 'ja');

      expect(provider).toHaveBeenCalledWith({
        guildId: GUILD_ID,
        guild: interaction.guild,
        locale: 'ja',
      });
      expect(
        embedAt(payloadOf(harness.reply)).fields?.map((f) => f.name)
      ).toEqual([
        t('settings.language.name', 'ja'),
        t('settings.audit.name', 'ja'),
        t('settings.announcements.name', 'ja'),
        'VC通知',
        '参加通知',
      ]);
    });

    it('stays within the 25 fields an embed allows', async () => {
      registerSettingsSummary('many', () =>
        Array.from({ length: 30 }, (_, i) => ({ name: `f${i}`, value: 'v' }))
      );
      const { interaction, harness } = setup();

      await showSettingsPanel(interaction, 'en');

      expect(embedAt(payloadOf(harness.reply)).fields).toHaveLength(25);
    });

    it('closes after two idle minutes, and within the token lifetime', async () => {
      const { interaction, harness } = setup();

      await showSettingsPanel(interaction, 'en');

      expect(
        harness.message.createMessageComponentCollector
      ).toHaveBeenCalledWith({ idle: 120_000, time: 14 * 60_000 });
    });
  });

  describe('language tab', () => {
    it('marks "auto" as current when nothing is stored', async () => {
      const { interaction, harness } = setup();

      await showSettingsPanel(interaction, 'en', 'language');

      const payload = payloadOf<Payload>(harness.reply);
      expect(embedAt(payload).description).toContain(
        `**${t('settings.language.auto', 'en')}**`
      );
      const [tabs, select] = rowsOf(payload.components);
      expect(
        tabs!.find((c) => c.style === ButtonStyle.Primary)?.custom_id
      ).toBe('settings-panel:language');
      expect(select![0]!.custom_id).toBe('settings-panel:language-select');
      expect(
        select![0]!.options?.map((o) => [o.value, o.default ?? false])
      ).toEqual([
        ['en', false],
        ['ja', false],
        ['auto', true],
      ]);
    });

    it.each([
      // Discord keeps a non-Community server on en-US, which nobody chose.
      ['a non-Community server', [], 'en-US', '日本語'],
      ['a Community server set to English', ['COMMUNITY'], 'en-US', 'English'],
      ['a Community server set to Japanese', ['COMMUNITY'], 'ja', '日本語'],
    ])(
      'says which language channel posts use on automatic for %s',
      async (_case, features, preferredLocale, posts) => {
        const { interaction, harness } = setup({
          guild: guildStub({ features, preferredLocale }),
        });

        await showSettingsPanel(interaction, 'en', 'language');

        expect(embedAt(payloadOf(harness.reply)).description).toContain(
          t('settings.language.autoHint', 'en', { lang: posts })
        );
      }
    );

    it('preselects 日本語 for a guild stored as Japanese', async () => {
      guildSettingsRepository.setLanguage(GUILD_ID, 'ja');
      const { interaction, harness } = setup();

      await showSettingsPanel(interaction, 'en', 'language');

      const payload = payloadOf<Payload>(harness.reply);
      expect(embedAt(payload).description).toContain('**日本語**');
      const [, select] = rowsOf(payload.components);
      expect(
        select![0]!.options?.map((o) => [o.value, o.default ?? false])
      ).toEqual([
        ['en', false],
        ['ja', true],
        ['auto', false],
      ]);
    });

    it('persists and audit-logs a language picked from the select', async () => {
      const { interaction, harness } = setup();
      await showSettingsPanel(interaction, 'en', 'language');

      const select = componentStub('string', 'settings-panel:language-select', {
        values: ['en'],
      });
      await harness.collect(select);

      expect(settingsRow(db)?.language).toBe('en');
      // Written in the server's language, which is now English.
      expect(auditRows(db)).toEqual([
        {
          action: 'SETTINGS_CHANGE',
          user_id: USER_ID,
          target_id: null,
          details: t('audit.details.language', 'en', { language: 'English' }),
        },
      ]);
      const update = lastUpdate(select);
      expect(embedAt(update).description).toContain('**English**');
      expect(
        rowsOf(update.components)[1]![0]!.options?.find((o) => o.default)?.value
      ).toBe('en');
    });

    /**
     * Regression: the panel kept rendering in the language it was opened in,
     * so choosing 日本語 left it in English until it was reopened.
     */
    it('re-renders the whole panel in the language just chosen', async () => {
      const { interaction, harness } = setup();
      await showSettingsPanel(interaction, 'en', 'language');

      const toJapanese = componentStub(
        'string',
        'settings-panel:language-select',
        { values: ['ja'] }
      );
      await harness.collect(toJapanese);

      const update = lastUpdate(toJapanese);
      expect(embedAt(update).title).toBe(t('settings.language.name', 'ja'));
      expect(rowsOf(update.components)[0]!.map((c) => c.label)).toContain(
        t('settings.panel.tabOverview', 'ja')
      );

      // Back on automatic, it follows the person clicking again.
      const toAuto = componentStub('string', 'settings-panel:language-select', {
        values: ['auto'],
        locale: 'en-US',
      });
      await harness.collect(toAuto);
      expect(embedAt(lastUpdate(toAuto)).title).toBe(
        t('settings.language.name', 'en')
      );
    });

    it('stores "auto" as NULL so replies follow each viewer again', async () => {
      guildSettingsRepository.setLanguage(GUILD_ID, 'ja');
      const { interaction, harness } = setup();
      await showSettingsPanel(interaction, 'en', 'language');

      await harness.collect(
        componentStub('string', 'settings-panel:language-select', {
          values: ['auto'],
        })
      );

      expect(settingsRow(db)?.language).toBeNull();
      expect(auditRows(db).map((r) => r.details)).toEqual([
        t('audit.details.language', 'ja', {
          language: t('settings.language.auto', 'ja'),
        }),
      ]);
    });

    it('ignores values outside the supported languages', async () => {
      const { interaction, harness } = setup();
      await showSettingsPanel(interaction, 'en', 'language');

      const select = componentStub('string', 'settings-panel:language-select', {
        values: ['fr'],
      });
      await harness.collect(select);

      expect(settingsRow(db)).toBeUndefined();
      expect(auditRows(db)).toEqual([]);
      // Still re-rendered, unchanged.
      expect(select.update).toHaveBeenCalledTimes(1);
    });

    it('ignores a select with another custom id', async () => {
      const { interaction, harness } = setup();
      await showSettingsPanel(interaction, 'en', 'language');

      await harness.collect(
        componentStub('string', 'other-panel:select', { values: ['ja'] })
      );

      expect(settingsRow(db)).toBeUndefined();
    });
  });

  /**
   * Regression: the language select, the audit channel select and the clear
   * button awaited the audit channel post before answering the click, so a
   * slow or rate-limited audit channel made a saved change show "This
   * interaction failed".
   */
  describe('answering a click while the audit channel is slow', () => {
    function slowAuditChannel() {
      const send = vi.fn(() => new Promise(() => {}));
      const auditChannel = { id: 'slow-audit', isTextBased: () => true, send };
      const guild = guildStub({
        channels: [AUDIT_CHANNEL, NEWS_CHANNEL, MUTED_CHANNEL],
      });
      (guild.channels.cache as Collection<string, unknown>).set(
        auditChannel.id,
        auditChannel
      );
      guildSettingsRepository.setAuditChannel(GUILD_ID, auditChannel.id);
      return { guild, send, client: clientStub([guild]) };
    }

    it.each([
      [
        'a language pick',
        'language' as const,
        () =>
          componentStub('string', 'settings-panel:language-select', {
            values: ['en'],
          }),
      ],
      [
        'an announcement channel pick',
        'announcements' as const,
        () =>
          componentStub('channel', 'settings-panel:announcement-channel', {
            values: ['news-chan'],
          }),
      ],
    ])('updates the panel without waiting on %s', async (_case, view, make) => {
      const { guild, send, client } = slowAuditChannel();
      const { interaction, harness } = setup({ guild, client });
      await showSettingsPanel(interaction, 'en', view);

      const component = make();
      await harness.collect(component);

      expect(component.update).toHaveBeenCalledTimes(1);
      // On record before the panel answered, though not yet posted.
      expect(auditRows(db)).toHaveLength(1);
      await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    });
  });

  describe('audit tab', () => {
    it('disables "clear" while no audit channel is set', async () => {
      const { interaction, harness } = setup();

      await showSettingsPanel(interaction, 'en', 'audit');

      const payload = payloadOf<Payload>(harness.reply);
      expect(embedAt(payload).description).toBe(
        t('settings.audit.notSet', 'en')
      );
      const [, channelSelect, actions] = rowsOf(payload.components);
      expect(channelSelect![0]).toMatchObject({
        type: ComponentType.ChannelSelect,
        custom_id: 'settings-panel:audit-channel',
        channel_types: [ChannelType.GuildText],
      });
      expect(channelSelect![0]!.default_values).toBeUndefined();
      expect(actions![0]).toMatchObject({
        custom_id: 'settings-panel:audit-clear',
        disabled: true,
      });
    });

    it.each([
      ['audit', 'setAuditChannel', 'settings-panel:audit-clear'],
      [
        'announcements',
        'setAnnouncementChannel',
        'settings-panel:announcement-clear',
      ],
    ] as const)(
      '%s: does not preselect a stored channel that was deleted, and still offers "clear"',
      async (view, store, clearId) => {
        guildSettingsRepository[store](GUILD_ID, 'gone-chan');
        const { interaction, harness } = setup();

        await showSettingsPanel(interaction, 'en', view);

        const [, channelSelect, actions] = rowsOf(
          payloadOf<Payload>(harness.reply).components
        );
        expect(channelSelect![0]!.default_values).toBeUndefined();
        expect(actions![0]).toMatchObject({
          custom_id: clearId,
          disabled: false,
        });
      }
    );

    it('preselects the current audit channel', async () => {
      guildSettingsRepository.setAuditChannel(GUILD_ID, 'audit-chan');
      const { interaction, harness } = setup();

      await showSettingsPanel(interaction, 'en', 'audit');

      const [, channelSelect] = rowsOf(
        payloadOf<Payload>(harness.reply).components
      );
      expect(channelSelect![0]!.default_values).toEqual([
        { id: 'audit-chan', type: 'channel' },
      ]);
    });

    it('persists and audit-logs a postable channel picked from the select', async () => {
      const { interaction, harness } = setup();
      await showSettingsPanel(interaction, 'en', 'audit');

      const select = componentStub('channel', 'settings-panel:audit-channel', {
        values: ['audit-chan'],
      });
      await harness.collect(select);

      expect(settingsRow(db)?.audit_channel_id).toBe('audit-chan');
      expect(auditRows(db)).toEqual([
        {
          action: 'AUDIT_SETUP',
          user_id: USER_ID,
          // The channel is the target; details repeating it would show it
          // twice in the log line and the audit embed.
          target_id: 'audit-chan',
          details: null,
        },
      ]);
      const update = lastUpdate(select);
      expect(embedAt(update).description).toBe('<#audit-chan>');
      expect(rowsOf(update.components)[2]![0]!.disabled).toBe(false);
    });

    it.each([
      [
        'names what the bot lacks in a channel it cannot post in',
        'muted-chan',
        t('settings.errors.channelMissingPermissions', 'en', {
          channel: 'muted-chan',
          permissions: formatPermissionNames(
            [
              PermissionFlagsBits.ViewChannel,
              PermissionFlagsBits.SendMessages,
              PermissionFlagsBits.EmbedLinks,
            ],
            'en'
          ),
        }),
      ],
      [
        'rejects a channel that is not cached and cannot be fetched',
        'deleted-chan',
        t('settings.errors.channelNotSendable', 'en'),
      ],
    ])('%s', async (_case, channelId, message) => {
      guildSettingsRepository.setAuditChannel(GUILD_ID, 'audit-chan');
      const { interaction, harness } = setup();
      await showSettingsPanel(interaction, 'en', 'audit');

      const select = componentStub('channel', 'settings-panel:audit-channel', {
        values: [channelId],
      });
      await harness.collect(select);

      // The panel re-renders first, so the select shows the stored channel
      // again instead of the rejected one as if it had been saved.
      expect(select.update).toHaveBeenCalledTimes(1);
      const update = lastUpdate(select);
      expect(embedAt(update).description).toBe('<#audit-chan>');
      expect(rowsOf(update.components)[1]![0]!.default_values).toEqual([
        { id: 'audit-chan', type: 'channel' },
      ]);
      // Then the reason, privately.
      expect(select.reply).not.toHaveBeenCalled();
      const followUp = payloadOf<{ embeds: unknown[]; flags: number }>(
        select.followUp
      );
      expect(followUp.flags).toBe(MessageFlags.Ephemeral);
      expect(embedAt(followUp).description).toBe(message);
      expect(select.update.mock.invocationCallOrder[0]).toBeLessThan(
        select.followUp.mock.invocationCallOrder[0]!
      );
      expect(settingsRow(db)?.audit_channel_id).toBe('audit-chan');
      expect(auditRows(db)).toEqual([]);
    });

    it('clears the audit channel and records who disabled it', async () => {
      guildSettingsRepository.setAuditChannel(GUILD_ID, 'audit-chan');
      const { interaction, harness } = setup();
      await showSettingsPanel(interaction, 'en', 'audit');

      const clear = componentStub('button', 'settings-panel:audit-clear');
      await harness.collect(clear);

      expect(settingsRow(db)?.audit_channel_id).toBeNull();
      expect(auditRows(db)).toEqual([
        {
          action: 'AUDIT_SETUP',
          user_id: USER_ID,
          target_id: null,
          details: t('audit.details.auditChannelCleared', 'ja'),
        },
      ]);
      const update = lastUpdate(clear);
      expect(embedAt(update).description).toBe(
        t('settings.audit.notSet', 'en')
      );
      expect(rowsOf(update.components)[2]![0]!.disabled).toBe(true);
    });
  });

  describe('announcements tab', () => {
    it('shows that announcements are off, with "stop" disabled', async () => {
      const { interaction, harness } = setup();

      await showSettingsPanel(interaction, 'en', 'announcements');

      const payload = payloadOf<Payload>(harness.reply);
      const embed = embedAt(payload);
      expect(embed.title).toBe(t('settings.announcements.name', 'en'));
      expect(embed.description).toBe(t('settings.announcements.notSet', 'en'));
      expect(embed.footer?.text).toBe(
        t('settings.panel.announcementsFooter', 'en')
      );
      const [tabs, channelSelect, actions] = rowsOf(payload.components);
      expect(
        tabs!.find((c) => c.style === ButtonStyle.Primary)?.custom_id
      ).toBe('settings-panel:announcements');
      expect(channelSelect![0]).toMatchObject({
        type: ComponentType.ChannelSelect,
        custom_id: 'settings-panel:announcement-channel',
        channel_types: [ChannelType.GuildText],
      });
      expect(actions![0]).toMatchObject({
        custom_id: 'settings-panel:announcement-clear',
        label: t('settings.panel.clearAnnouncements', 'en'),
        disabled: true,
      });
    });

    it('persists and audit-logs the channel, naming it in the details', async () => {
      const { interaction, harness } = setup();
      await showSettingsPanel(interaction, 'en', 'announcements');

      const select = componentStub(
        'channel',
        'settings-panel:announcement-channel',
        { values: ['news-chan'] }
      );
      await harness.collect(select);

      expect(settingsRow(db)).toMatchObject({
        announcement_channel_id: 'news-chan',
        audit_channel_id: null,
      });
      expect(auditRows(db)).toEqual([
        {
          action: 'SETTINGS_CHANGE',
          user_id: USER_ID,
          // Not a member, so not the target: it would render as one.
          target_id: null,
          details: t('audit.details.announcementChannelSet', 'ja', {
            channel: 'news-chan',
          }),
        },
      ]);
      const update = lastUpdate(select);
      expect(embedAt(update).description).toBe('<#news-chan>');
      expect(rowsOf(update.components)[1]![0]!.default_values).toEqual([
        { id: 'news-chan', type: 'channel' },
      ]);
      expect(rowsOf(update.components)[2]![0]!.disabled).toBe(false);
    });

    it('rejects a channel the bot cannot post in', async () => {
      const { interaction, harness } = setup();
      await showSettingsPanel(interaction, 'en', 'announcements');

      const select = componentStub(
        'channel',
        'settings-panel:announcement-channel',
        { values: ['muted-chan'] }
      );
      await harness.collect(select);

      const update = lastUpdate(select);
      expect(embedAt(update).description).toBe(
        t('settings.announcements.notSet', 'en')
      );
      expect(rowsOf(update.components)[1]![0]!.default_values).toBeUndefined();
      expect(select.followUp).toHaveBeenCalledTimes(1);
      expect(settingsRow(db)).toBeUndefined();
      expect(auditRows(db)).toEqual([]);
    });

    it('stops announcements and records who stopped them', async () => {
      guildSettingsRepository.setAnnouncementChannel(GUILD_ID, 'news-chan');
      const { interaction, harness } = setup();
      await showSettingsPanel(interaction, 'en', 'announcements');

      const clear = componentStub(
        'button',
        'settings-panel:announcement-clear'
      );
      await harness.collect(clear);

      expect(settingsRow(db)?.announcement_channel_id).toBeNull();
      expect(auditRows(db)).toEqual([
        {
          action: 'SETTINGS_CHANGE',
          user_id: USER_ID,
          target_id: null,
          details: t('audit.details.announcementChannelCleared', 'ja'),
        },
      ]);
      expect(embedAt(lastUpdate(clear)).description).toBe(
        t('settings.announcements.notSet', 'en')
      );
    });

    it('keeps the audit channel when only announcements change', async () => {
      guildSettingsRepository.setAuditChannel(GUILD_ID, 'audit-chan');
      const { interaction, harness } = setup();
      await showSettingsPanel(interaction, 'en', 'announcements');

      await harness.collect(
        componentStub('channel', 'settings-panel:announcement-channel', {
          values: ['news-chan'],
        })
      );

      expect(settingsRow(db)).toMatchObject({
        audit_channel_id: 'audit-chan',
        announcement_channel_id: 'news-chan',
      });
    });

    it('ignores a channel select it does not own', async () => {
      const { interaction, harness } = setup();
      await showSettingsPanel(interaction, 'en', 'announcements');

      await harness.collect(
        componentStub('channel', 'other-panel:channel', {
          values: ['news-chan'],
        })
      );

      expect(settingsRow(db)).toBeUndefined();
    });
  });

  describe('logs tab', () => {
    it('shows an empty state without pagination', async () => {
      const { interaction, harness } = setup();

      await showSettingsPanel(interaction, 'en', 'logs');

      const payload = payloadOf<Payload>(harness.reply);
      expect(embedAt(payload).description).toBe(
        t('settings.logs.noLogs', 'en')
      );
      expect(rowsOf(payload.components)).toHaveLength(1);
    });

    it('only lists logs of this guild', async () => {
      insertAuditLogs(db, 3, { guildId: 'other-guild' });
      const { interaction, harness } = setup();

      await showSettingsPanel(interaction, 'en', 'logs');

      expect(embedAt(payloadOf(harness.reply)).description).toBe(
        t('settings.logs.noLogs', 'en')
      );
    });

    it('names each action in the viewer language, with its target and details', async () => {
      const at = 1_700_000_000_000;
      insertAuditLogs(db, 1, {
        action: 'AUDIT_SETUP',
        targetId: 'chan-9',
        baseTime: at,
      });
      insertAuditLogs(db, 1, {
        action: 'ROLE_ADD',
        targetId: 'member-9',
        details: 'Role: Helper (role-1)',
        baseTime: at + 60_000,
      });
      insertAuditLogs(db, 1, {
        action: 'SETTINGS_CHANGE',
        details: '言語を 日本語 に変更',
        baseTime: at + 120_000,
      });
      const { interaction, harness } = setup();

      await showSettingsPanel(interaction, 'ja', 'logs');

      // Newest first; channel targets render as channels, others as users.
      // Stored details are shown as written, on their own line.
      expect(
        embedAt(payloadOf(harness.reply)).description?.split('\n')
      ).toEqual([
        `<t:${(at + 120_000) / 1000}:R> <@actor-0> **${t('audit.actions.SETTINGS_CHANGE', 'ja')}**`,
        '└ 言語を 日本語 に変更',
        `<t:${(at + 60_000) / 1000}:R> <@actor-0> **${t('audit.actions.ROLE_ADD', 'ja')}** → <@member-9>`,
        '└ Role: Helper (role-1)',
        `<t:${at / 1000}:R> <@actor-0> **${t('audit.actions.AUDIT_SETUP', 'ja')}** → <#chan-9>`,
      ]);
    });

    it('shows an action code it does not know as readable text', async () => {
      insertAuditLogs(db, 1, { action: 'FUTURE_THING' });
      const { interaction, harness } = setup();

      await showSettingsPanel(interaction, 'en', 'logs');

      expect(embedAt(payloadOf(harness.reply)).description).toContain(
        '**FUTURE THING**'
      );
    });

    it('shortens long details to one line', async () => {
      insertAuditLogs(db, 1, { details: `first line\n${'x'.repeat(200)}` });
      const { interaction, harness } = setup();

      await showSettingsPanel(interaction, 'en', 'logs');

      const detailLine = embedAt(payloadOf(harness.reply))
        .description!.split('\n')
        .find((line) => line.startsWith('└ '))!;
      expect(detailLine.startsWith('└ first line x')).toBe(true);
      expect(detailLine.endsWith('…')).toBe(true);
      expect(detailLine.length).toBeLessThanOrEqual(2 + 90);
    });

    it('pages through logs ten at a time and stops at both ends', async () => {
      insertAuditLogs(db, 25);
      const { interaction, harness } = setup();
      await showSettingsPanel(interaction, 'en', 'logs');

      const first = payloadOf<Payload>(harness.reply);
      expect(embedAt(first).description?.split('\n')).toHaveLength(10);
      expect(embedAt(first).description).toContain('<@actor-24>');
      expect(embedAt(first).footer?.text).toBe(
        t('settings.logs.showingRange', 'en', { from: 1, to: 10, total: 25 })
      );
      const [, pager] = rowsOf(first.components);
      expect(pager!.map((c) => [c.custom_id, c.label, c.disabled])).toEqual([
        ['settings-panel:logs-prev', t('settings.panel.prevPage', 'en'), true],
        ['settings-panel:logs-page', '1/3', true],
        ['settings-panel:logs-next', t('settings.panel.nextPage', 'en'), false],
      ]);

      const next = componentStub('button', 'settings-panel:logs-next');
      await harness.collect(next);
      await harness.collect(next);
      const last = lastUpdate(next);
      expect(embedAt(last).description?.split('\n')).toHaveLength(5);
      expect(embedAt(last).description).toContain('<@actor-0>');
      expect(embedAt(last).footer?.text).toBe(
        t('settings.logs.showingRange', 'en', { from: 21, to: 25, total: 25 })
      );
      expect(rowsOf(last.components)[1]!.map((c) => c.disabled)).toEqual([
        false,
        true,
        true,
      ]);

      // Pressing "next" on the last page is clamped instead of going blank.
      await harness.collect(next);
      expect(pageLabel(lastUpdate(next))).toBe('3/3');

      const prev = componentStub('button', 'settings-panel:logs-prev');
      await harness.collect(prev);
      expect(pageLabel(lastUpdate(prev))).toBe('2/3');
      await harness.collect(prev);
      await harness.collect(prev);
      expect(pageLabel(lastUpdate(prev))).toBe('1/3');
    });

    /**
     * Regression: the view read only the newest 50 entries, so anything older
     * was unreachable and the footer read "50 of 60" while showing ten.
     */
    it('reaches every entry kept, not just the newest 50', async () => {
      insertAuditLogs(db, 60);
      const { interaction, harness } = setup();
      await showSettingsPanel(interaction, 'en', 'logs');

      expect(pageLabel(payloadOf<Payload>(harness.reply))).toBe('1/6');

      const next = componentStub('button', 'settings-panel:logs-next');
      for (let i = 0; i < 5; i++) await harness.collect(next);

      const last = lastUpdate(next);
      expect(pageLabel(last)).toBe('6/6');
      expect(embedAt(last).footer?.text).toBe(
        t('settings.logs.showingRange', 'en', { from: 51, to: 60, total: 60 })
      );
      expect(embedAt(last).description).toContain('<@actor-0>');
      expect(embedAt(last).description).not.toContain('<@actor-10>');
    });

    /** Regression: each render ran the count and the list query three times. */
    it('reads one page and one count per render', async () => {
      insertAuditLogs(db, 25);
      const getLogs = vi.spyOn(auditRepository, 'getLogs');
      const getLogsCount = vi.spyOn(auditRepository, 'getLogsCount');
      const { interaction, harness } = setup();

      await showSettingsPanel(interaction, 'en', 'logs');
      expect(getLogs).toHaveBeenCalledTimes(1);
      expect(getLogs).toHaveBeenCalledWith(GUILD_ID, 10, 0);
      expect(getLogsCount).toHaveBeenCalledTimes(1);

      await harness.collect(
        componentStub('button', 'settings-panel:logs-next')
      );
      expect(getLogs).toHaveBeenCalledTimes(2);
      expect(getLogs).toHaveBeenLastCalledWith(GUILD_ID, 10, 10);
      expect(getLogsCount).toHaveBeenCalledTimes(2);

      // Closing reuses the last page's pager instead of querying again.
      await harness.end();
      expect(getLogs).toHaveBeenCalledTimes(2);
    });

    it('ignores pager buttons pressed while another tab is shown', async () => {
      insertAuditLogs(db, 25);
      const { interaction, harness } = setup();
      await showSettingsPanel(interaction, 'en', 'overview');

      await harness.collect(
        componentStub('button', 'settings-panel:logs-next')
      );
      const toLogs = componentStub('button', 'settings-panel:logs');
      await harness.collect(toLogs);

      expect(pageLabel(lastUpdate(toLogs))).toBe('1/3');
    });
  });

  describe('tab navigation', () => {
    it('switches tabs and highlights the active one', async () => {
      const { interaction, harness } = setup();
      await showSettingsPanel(interaction, 'en');

      for (const [tab, title] of [
        ['language', t('settings.language.name', 'en')],
        ['audit', t('settings.audit.name', 'en')],
        ['announcements', t('settings.announcements.name', 'en')],
        ['logs', t('settings.logs.title', 'en')],
        ['overview', t('settings.title', 'en')],
      ] as const) {
        const button = componentStub('button', `settings-panel:${tab}`);
        await harness.collect(button);
        const update = lastUpdate(button);
        expect(embedAt(update).title).toBe(title);
        expect(
          rowsOf(update.components)[0]!.find(
            (c) => c.style === ButtonStyle.Primary
          )?.custom_id
        ).toBe(`settings-panel:${tab}`);
      }
    });

    it('returns to the first log page after visiting another tab', async () => {
      insertAuditLogs(db, 25);
      const { interaction, harness } = setup();
      await showSettingsPanel(interaction, 'en', 'logs');

      await harness.collect(
        componentStub('button', 'settings-panel:logs-next')
      );
      await harness.collect(componentStub('button', 'settings-panel:overview'));
      const back = componentStub('button', 'settings-panel:logs');
      await harness.collect(back);

      expect(pageLabel(lastUpdate(back))).toBe('1/3');
    });

    it('keeps the current log page when the logs tab is pressed again', async () => {
      insertAuditLogs(db, 25);
      const { interaction, harness } = setup();
      await showSettingsPanel(interaction, 'en', 'logs');

      await harness.collect(
        componentStub('button', 'settings-panel:logs-next')
      );
      const again = componentStub('button', 'settings-panel:logs');
      await harness.collect(again);

      expect(pageLabel(lastUpdate(again))).toBe('2/3');
    });
  });

  describe('when the panel expires', () => {
    it.each([
      ['overview', 1],
      ['language', 2],
      ['audit', 3],
      ['announcements', 3],
      ['logs', 2],
    ] as const)(
      'disables every component of the %s tab',
      async (view, rowCount) => {
        insertAuditLogs(db, 15);
        const { interaction, harness } = setup();
        await showSettingsPanel(interaction, 'en', view);

        await harness.end();

        const { components } = payloadOf<{ components: unknown[] }>(
          harness.editReply
        );
        const rows = rowsOf(components);
        expect(rows).toHaveLength(rowCount);
        expect(rows.flat().every((c) => c.disabled === true)).toBe(true);
      }
    );
  });
});
