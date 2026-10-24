import Database from 'better-sqlite3';
import {
  ButtonStyle,
  ChannelType,
  ComponentType,
  MessageFlags,
  type ChatInputCommandInteraction,
  type Guild,
} from 'discord.js';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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

const AUDIT_CHANNEL = textChannelStub({ id: 'audit-chan', name: 'mod-log' });
const MUTED_CHANNEL = textChannelStub({
  id: 'muted-chan',
  name: 'read-only',
  canSend: false,
});

function setup(options: { guild?: Guild | null } = {}) {
  const harness = createPanelHarness();
  const client = clientStub();
  const guild =
    options.guild === undefined
      ? guildStub({ channels: [AUDIT_CHANNEL, MUTED_CHANNEL] })
      : options.guild;
  const interaction = {
    guild,
    guildId: guild?.id ?? null,
    user: { id: USER_ID },
    client,
    locale: 'en-US',
    reply: harness.reply,
    editReply: harness.editReply,
  } as unknown as ChatInputCommandInteraction;
  return { interaction, harness, client };
}

/** The last payload the panel re-rendered with after a component. */
function lastUpdate(component: { update: ReturnType<typeof vi.fn> }) {
  return payloadOf<{ embeds: unknown[]; components: unknown[] }>(
    component.update,
    component.update.mock.calls.length - 1
  );
}

describe('showSettingsPanel', () => {
  beforeAll(async () => {
    await migrateAdminSchema();
  });

  beforeEach(() => {
    clearAdminTables(db);
    vi.clearAllMocks();
  });

  it('refuses to open outside a guild', async () => {
    const { interaction, harness } = setup({ guild: null });

    await showSettingsPanel(interaction, 'en');

    const payload = payloadOf<{ embeds: unknown[]; flags: number }>(
      harness.reply
    );
    expect(payload.flags).toBe(MessageFlags.Ephemeral);
    expect(embedAt(payload).description).toBe(t('common.guildOnly', 'en'));
    expect(harness.message.createMessageComponentCollector).not.toHaveBeenCalled();
  });

  describe('overview tab', () => {
    it('shows defaults for a guild that never configured anything', async () => {
      const { interaction, harness } = setup();

      await showSettingsPanel(interaction, 'en');

      const payload = payloadOf<{
        embeds: unknown[];
        components: unknown[];
        flags: number;
      }>(harness.reply);
      const embed = embedAt(payload);
      expect(payload.flags).toBe(MessageFlags.Ephemeral);
      expect(embed.title).toBe(t('settings.title', 'en'));
      expect(embed.fields?.map((f) => f.value)).toEqual([
        t('settings.language.auto', 'en'),
        t('settings.audit.notSet', 'en'),
        t('settings.announcements.notSet', 'en'),
      ]);
      expect(embed.footer?.text).toBe(t('settings.panel.overviewFooter', 'en'));

      // Only the tab row: overview has nothing to edit inline.
      const rows = rowsOf(payload.components);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.map((c) => c.custom_id)).toEqual([
        'settings-panel:overview',
        'settings-panel:language',
        'settings-panel:audit',
        'settings-panel:logs',
      ]);
      expect(rows[0]!.map((c) => c.style)).toEqual([
        ButtonStyle.Primary,
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

    it('keeps the panel alive for two minutes', async () => {
      const { interaction, harness } = setup();

      await showSettingsPanel(interaction, 'en');

      expect(
        harness.message.createMessageComponentCollector
      ).toHaveBeenCalledWith({ time: 120_000 });
    });
  });

  describe('language tab', () => {
    it('marks "auto" as current when nothing is stored', async () => {
      const { interaction, harness } = setup();

      await showSettingsPanel(interaction, 'en', 'language');

      const payload = payloadOf<{ embeds: unknown[]; components: unknown[] }>(
        harness.reply
      );
      expect(embedAt(payload).description).toContain(
        `**${t('settings.language.auto', 'en')}**`
      );
      const [tabs, select] = rowsOf(payload.components);
      expect(tabs!.find((c) => c.style === ButtonStyle.Primary)?.custom_id).toBe(
        'settings-panel:language'
      );
      expect(select![0]!.custom_id).toBe('settings-panel:language-select');
      expect(
        select![0]!.options?.map((o) => [o.value, o.default ?? false])
      ).toEqual([
        ['en', false],
        ['ja', false],
        ['auto', true],
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
      expect(auditRows(db)).toEqual([
        {
          action: 'SETTINGS_CHANGE',
          user_id: USER_ID,
          target_id: null,
          details: 'Language changed to: en',
        },
      ]);
      const update = lastUpdate(select);
      expect(embedAt(update).description).toContain('**English**');
      expect(
        rowsOf(update.components)[1]![0]!.options?.find((o) => o.default)
          ?.value
      ).toBe('en');
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
        'Language changed to: auto',
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

  describe('audit tab', () => {
    it('disables "clear" while no audit channel is set', async () => {
      const { interaction, harness } = setup();

      await showSettingsPanel(interaction, 'en', 'audit');

      const payload = payloadOf<{ embeds: unknown[]; components: unknown[] }>(
        harness.reply
      );
      expect(embedAt(payload).description).toBe(
        t('settings.audit.notSet', 'en')
      );
      const [, channelSelect, actions] = rowsOf(payload.components);
      expect(channelSelect![0]).toMatchObject({
        type: ComponentType.ChannelSelect,
        custom_id: 'settings-panel:audit-channel',
        channel_types: [ChannelType.GuildText],
      });
      expect(actions![0]).toMatchObject({
        custom_id: 'settings-panel:audit-clear',
        disabled: true,
      });
    });

    it('persists and audit-logs a sendable channel picked from the select', async () => {
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
          target_id: 'audit-chan',
          details: 'Audit channel set to: #mod-log',
        },
      ]);
      const update = lastUpdate(select);
      expect(embedAt(update).description).toBe('<#audit-chan>');
      expect(rowsOf(update.components)[2]![0]!.disabled).toBe(false);
    });

    it.each([
      ['the bot cannot send in it', 'muted-chan'],
      ['it is not cached and cannot be fetched', 'deleted-chan'],
    ])('rejects a channel when %s', async (_case, channelId) => {
      const { interaction, harness } = setup();
      await showSettingsPanel(interaction, 'en', 'audit');

      const select = componentStub('channel', 'settings-panel:audit-channel', {
        values: [channelId],
      });
      await harness.collect(select);

      const reply = payloadOf<{ embeds: unknown[]; flags: number }>(
        select.reply
      );
      expect(reply.flags).toBe(MessageFlags.Ephemeral);
      expect(embedAt(reply).description).toBe(
        t('notification.errors.channelNotSendable', 'en')
      );
      // The error was the response; the panel must not also update.
      expect(select.update).not.toHaveBeenCalled();
      expect(settingsRow(db)).toBeUndefined();
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
          details: 'Audit channel disabled from settings panel',
        },
      ]);
      const update = lastUpdate(clear);
      expect(embedAt(update).description).toBe(
        t('settings.audit.notSet', 'en')
      );
      expect(rowsOf(update.components)[2]![0]!.disabled).toBe(true);
    });
  });

  describe('logs tab', () => {
    it('shows an empty state without pagination', async () => {
      const { interaction, harness } = setup();

      await showSettingsPanel(interaction, 'en', 'logs');

      const payload = payloadOf<{ embeds: unknown[]; components: unknown[] }>(
        harness.reply
      );
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

    it('formats each entry with a relative time, actor, action and target', async () => {
      const at = 1_700_000_000_000;
      insertAuditLogs(db, 1, {
        action: 'AUDIT_SETUP',
        targetId: 'chan-9',
        baseTime: at,
      });
      insertAuditLogs(db, 1, {
        action: 'ROLE_ADD',
        targetId: 'member-9',
        baseTime: at + 60_000,
      });
      insertAuditLogs(db, 1, { action: 'SETTINGS_CHANGE', baseTime: at + 120_000 });
      const { interaction, harness } = setup();

      await showSettingsPanel(interaction, 'en', 'logs');

      // Newest first; channel targets render as channels, others as users.
      expect(embedAt(payloadOf(harness.reply)).description?.split('\n')).toEqual(
        [
          `<t:${(at + 120_000) / 1000}:R> <@actor-0> **SETTINGS CHANGE**`,
          `<t:${(at + 60_000) / 1000}:R> <@actor-0> **ROLE ADD** → <@member-9>`,
          `<t:${at / 1000}:R> <@actor-0> **AUDIT SETUP** → <#chan-9>`,
        ]
      );
    });

    it('pages through logs ten at a time and stops at both ends', async () => {
      insertAuditLogs(db, 25);
      const { interaction, harness } = setup();
      await showSettingsPanel(interaction, 'en', 'logs');

      const first = payloadOf<{ embeds: unknown[]; components: unknown[] }>(
        harness.reply
      );
      expect(embedAt(first).description?.split('\n')).toHaveLength(10);
      expect(embedAt(first).description).toContain('<@actor-24>');
      expect(embedAt(first).footer?.text).toBe(
        `${t('settings.logs.showing', 'en', { count: 25, total: 25 })} | 1/3`
      );
      const [, pager] = rowsOf(first.components);
      expect(pager!.map((c) => [c.custom_id, c.label, c.disabled])).toEqual([
        ['settings-panel:logs-prev', '<', true],
        ['settings-panel:logs-page', '1/3', true],
        ['settings-panel:logs-next', '>', false],
      ]);

      const next = componentStub('button', 'settings-panel:logs-next');
      await harness.collect(next);
      await harness.collect(next);
      const last = lastUpdate(next);
      expect(embedAt(last).description?.split('\n')).toHaveLength(5);
      expect(embedAt(last).description).toContain('<@actor-0>');
      expect(rowsOf(last.components)[1]!.map((c) => c.disabled)).toEqual([
        false,
        true,
        true,
      ]);

      // Pressing "next" on the last page is clamped instead of going blank.
      await harness.collect(next);
      expect(embedAt(lastUpdate(next)).footer?.text).toMatch(/\| 3\/3$/);

      const prev = componentStub('button', 'settings-panel:logs-prev');
      await harness.collect(prev);
      expect(embedAt(lastUpdate(prev)).footer?.text).toMatch(/\| 2\/3$/);
      await harness.collect(prev);
      await harness.collect(prev);
      expect(embedAt(lastUpdate(prev)).footer?.text).toMatch(/\| 1\/3$/);
    });

    it('caps the list at the 50 newest entries but reports the full total', async () => {
      insertAuditLogs(db, 60);
      const { interaction, harness } = setup();

      await showSettingsPanel(interaction, 'en', 'logs');

      const payload = payloadOf<{ embeds: unknown[]; components: unknown[] }>(
        harness.reply
      );
      expect(embedAt(payload).footer?.text).toBe(
        `${t('settings.logs.showing', 'en', { count: 50, total: 60 })} | 1/5`
      );
      expect(rowsOf(payload.components)[1]![1]!.label).toBe('1/5');
    });

    it('ignores pager buttons pressed while another tab is shown', async () => {
      insertAuditLogs(db, 25);
      const { interaction, harness } = setup();
      await showSettingsPanel(interaction, 'en', 'overview');

      await harness.collect(componentStub('button', 'settings-panel:logs-next'));
      const toLogs = componentStub('button', 'settings-panel:logs');
      await harness.collect(toLogs);

      expect(embedAt(lastUpdate(toLogs)).footer?.text).toMatch(/\| 1\/3$/);
    });
  });

  describe('tab navigation', () => {
    it('switches tabs and highlights the active one', async () => {
      const { interaction, harness } = setup();
      await showSettingsPanel(interaction, 'en');

      for (const [tab, title] of [
        ['language', t('settings.language.name', 'en')],
        ['audit', t('settings.audit.name', 'en')],
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

      await harness.collect(componentStub('button', 'settings-panel:logs-next'));
      await harness.collect(componentStub('button', 'settings-panel:overview'));
      const back = componentStub('button', 'settings-panel:logs');
      await harness.collect(back);

      expect(embedAt(lastUpdate(back)).footer?.text).toMatch(/\| 1\/3$/);
    });

    it('keeps the current log page when the logs tab is pressed again', async () => {
      insertAuditLogs(db, 25);
      const { interaction, harness } = setup();
      await showSettingsPanel(interaction, 'en', 'logs');

      await harness.collect(componentStub('button', 'settings-panel:logs-next'));
      const again = componentStub('button', 'settings-panel:logs');
      await harness.collect(again);

      expect(embedAt(lastUpdate(again)).footer?.text).toMatch(/\| 2\/3$/);
    });
  });

  describe('when the panel expires', () => {
    it.each([
      ['overview', 1],
      ['language', 2],
      ['audit', 3],
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
