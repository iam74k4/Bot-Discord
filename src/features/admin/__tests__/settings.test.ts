import Database from 'better-sqlite3';
import {
  MessageFlags,
  PermissionFlagsBits,
  PermissionsBitField,
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
  embedAt,
  guildStub,
  migrateAdminSchema,
  payloadOf,
  settingsRow,
  textChannelStub,
} from './admin.helpers.js';

/**
 * `/admin settings` subcommands write the guild-wide configuration every other
 * feature reads (locale, audit channel, announcement opt-in). These run the
 * real repositories and audit service against in-memory SQLite, so a passing
 * test means the value really is stored and the change really is on record.
 */

const db = new Database(':memory:');

vi.mock('../../../infrastructure/database/connection.js', () => ({
  database: db,
}));

vi.mock('../../../shared/utils/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
  getErrorMessage: (e: unknown) => String(e),
}));

const { executeSettingsCommand } = await import('../application/settings.js');
const { t } = await import('../../../locales/index.js');
const { COLORS } = await import('../../../shared/utils/constants/index.js');
const { guildSettingsRepository } =
  await import('../../../infrastructure/guildSettings/index.js');

const MOD_LOG = textChannelStub({ id: 'mod-log', name: 'mod-log' });
const NEWS = textChannelStub({ id: 'news', name: 'news' });
const READ_ONLY = textChannelStub({
  id: 'read-only',
  name: 'read-only',
  canSend: false,
});

function setup(
  options: {
    subcommand?: string;
    guild?: Guild | null;
    permissions?: PermissionsBitField | string;
    channel?: { id: string } | null;
    lang?: string;
    locale?: string;
  } = {}
) {
  const guild =
    options.guild === undefined
      ? guildStub({ channels: [MOD_LOG, NEWS, READ_ONLY] })
      : options.guild;
  const reply = vi.fn().mockResolvedValue({});
  const interaction = {
    guild,
    guildId: guild?.id ?? null,
    user: { id: USER_ID },
    member: {
      permissions:
        options.permissions ??
        new PermissionsBitField(PermissionFlagsBits.ManageGuild),
    },
    client: clientStub(),
    locale: options.locale ?? 'en-US',
    options: {
      getSubcommand: vi.fn(() => options.subcommand ?? 'view'),
      getChannel: vi.fn(() => options.channel ?? null),
      getString: vi.fn(() => options.lang ?? null),
    },
    reply,
  } as unknown as ChatInputCommandInteraction;
  return { interaction, reply };
}

function replied(reply: ReturnType<typeof vi.fn>) {
  const payload = payloadOf<{ embeds: unknown[]; flags?: number }>(reply);
  return { payload, embed: embedAt(payload) };
}

describe('executeSettingsCommand', () => {
  beforeAll(async () => {
    await migrateAdminSchema();
  });

  beforeEach(() => {
    clearAdminTables(db);
    vi.clearAllMocks();
  });

  describe('access', () => {
    const denied = t('common.permissionsRequired', 'en', {
      permissions: t('help.permission.manageGuild', 'en'),
    });

    it('requires Manage Server', async () => {
      const { interaction, reply } = setup({
        subcommand: 'language',
        lang: 'ja',
        permissions: new PermissionsBitField(PermissionFlagsBits.ManageRoles),
      });

      await executeSettingsCommand(interaction);

      const { payload, embed } = replied(reply);
      expect(payload.flags).toBe(MessageFlags.Ephemeral);
      expect(embed.description).toBe(denied);
      expect(settingsRow(db)).toBeUndefined();
      expect(auditRows(db)).toEqual([]);
    });

    it('denies when the member permissions are not resolved', async () => {
      // Uncached members arrive as API objects whose permissions are a string.
      const { interaction, reply } = setup({ permissions: '32' });

      await executeSettingsCommand(interaction);

      expect(replied(reply).embed.description).toBe(denied);
    });

    it('denies outside a guild', async () => {
      const { interaction, reply } = setup({ guild: null });

      await executeSettingsCommand(interaction);

      expect(replied(reply).embed.description).toBe(denied);
    });

    it('answers in the guild language when one is configured', async () => {
      guildSettingsRepository.setLanguage(GUILD_ID, 'ja');
      const { interaction, reply } = setup({
        permissions: new PermissionsBitField(),
        locale: 'en-US',
      });

      await executeSettingsCommand(interaction);

      expect(replied(reply).embed.title).toBe(t('common.error', 'ja'));
    });
  });

  describe('language', () => {
    it.each([
      ['ja', 'ja', '日本語'],
      ['en', 'en', 'English'],
    ])(
      'stores %s and audit-logs the change',
      async (lang, stored, display) => {
        const { interaction, reply } = setup({ subcommand: 'language', lang });

        await executeSettingsCommand(interaction);

        expect(settingsRow(db)?.language).toBe(stored);
        expect(auditRows(db)).toEqual([
          {
            action: 'SETTINGS_CHANGE',
            user_id: USER_ID,
            target_id: null,
            details: `Language changed to: ${lang}`,
          },
        ]);
        const { payload, embed } = replied(reply);
        expect(payload.flags).toBe(MessageFlags.Ephemeral);
        expect(embed.color).toBe(COLORS.SUCCESS);
        expect(embed.description).toContain(
          t('settings.language.changed', 'en', { language: display })
        );
        expect(embed.description).toContain('/admin settings view');
      }
    );

    it('stores "auto" as NULL so replies follow each viewer', async () => {
      guildSettingsRepository.setLanguage(GUILD_ID, 'ja');
      const { interaction, reply } = setup({
        subcommand: 'language',
        lang: 'auto',
        locale: 'en-US',
      });

      await executeSettingsCommand(interaction);

      expect(settingsRow(db)?.language).toBeNull();
      expect(auditRows(db).map((r) => r.details)).toEqual([
        'Language changed to: auto',
      ]);
      // The reply was resolved before the change, in the then-current language.
      expect(replied(reply).embed.description).toContain(
        t('settings.language.changed', 'ja', {
          language: t('settings.language.auto', 'ja'),
        })
      );
    });

    it('keeps the audit channel when only the language changes', async () => {
      guildSettingsRepository.setAuditChannel(GUILD_ID, 'mod-log');
      const { interaction } = setup({ subcommand: 'language', lang: 'en' });

      await executeSettingsCommand(interaction);

      expect(settingsRow(db)).toMatchObject({
        language: 'en',
        audit_channel_id: 'mod-log',
      });
    });
  });

  describe.each([
    {
      subcommand: 'audit',
      column: 'audit_channel_id' as const,
      nameKey: 'settings.audit.name' as const,
      configuredKey: 'settings.audit.configured' as const,
      disabledKey: 'settings.audit.disabled' as const,
      channel: MOD_LOG,
      action: 'AUDIT_SETUP',
      details: 'Audit channel set to: #mod-log',
      nextWhenSet: '/admin settings logs',
      nextWhenCleared: '/admin settings audit',
    },
    {
      subcommand: 'announcements',
      column: 'announcement_channel_id' as const,
      nameKey: 'settings.announcements.name' as const,
      configuredKey: 'settings.announcements.configured' as const,
      disabledKey: 'settings.announcements.disabled' as const,
      channel: NEWS,
      action: 'SETTINGS_CHANGE',
      details: 'Announcement channel set to: #news',
      nextWhenSet: '/admin settings view',
      nextWhenCleared: '/admin settings announcements',
    },
  ])('$subcommand channel', (c) => {
    it('stores a sendable channel and audit-logs it', async () => {
      const { interaction, reply } = setup({
        subcommand: c.subcommand,
        channel: { id: c.channel.id },
      });

      await executeSettingsCommand(interaction);

      expect(settingsRow(db)?.[c.column]).toBe(c.channel.id);
      expect(auditRows(db)).toEqual([
        {
          action: c.action,
          user_id: USER_ID,
          target_id: c.channel.id,
          details: c.details,
        },
      ]);
      const { payload, embed } = replied(reply);
      expect(payload.flags).toBe(MessageFlags.Ephemeral);
      expect(embed.title).toBe(t(c.nameKey, 'en'));
      expect(embed.color).toBe(COLORS.SUCCESS);
      expect(embed.description).toBe(
        `${t(c.configuredKey, 'en', { channel: c.channel.id })}\n\n${t(
          'common.nextStep',
          'en'
        )}: ${c.nextWhenSet}`
      );
    });

    it.each([
      ['the bot cannot send there', 'read-only'],
      ['it no longer exists', 'deleted'],
    ])('rejects a channel when %s', async (_case, channelId) => {
      guildSettingsRepository.update(GUILD_ID, { [c.column]: 'previous' });
      const { interaction, reply } = setup({
        subcommand: c.subcommand,
        channel: { id: channelId },
      });

      await executeSettingsCommand(interaction);

      expect(settingsRow(db)?.[c.column]).toBe('previous');
      expect(auditRows(db)).toEqual([]);
      const { payload, embed } = replied(reply);
      expect(payload.flags).toBe(MessageFlags.Ephemeral);
      expect(embed.description).toBe(
        t('notification.errors.channelNotSendable', 'en')
      );
    });

    it('rejects every channel while the bot member is not cached', async () => {
      const { interaction, reply } = setup({
        subcommand: c.subcommand,
        guild: guildStub({ channels: [c.channel], withBot: false }),
        channel: { id: c.channel.id },
      });

      await executeSettingsCommand(interaction);

      expect(settingsRow(db)).toBeUndefined();
      expect(replied(reply).embed.description).toBe(
        t('notification.errors.channelNotSendable', 'en')
      );
    });

    it('clears the channel when the option is left empty', async () => {
      guildSettingsRepository.update(GUILD_ID, { [c.column]: c.channel.id });
      const { interaction, reply } = setup({
        subcommand: c.subcommand,
        channel: null,
      });

      await executeSettingsCommand(interaction);

      expect(settingsRow(db)?.[c.column]).toBeNull();
      const { payload, embed } = replied(reply);
      expect(payload.flags).toBe(MessageFlags.Ephemeral);
      expect(embed.color).toBe(COLORS.WARNING);
      expect(embed.description).toBe(
        `${t(c.disabledKey, 'en')}\n\n${t('common.nextStep', 'en')}: ${
          c.nextWhenCleared
        }`
      );
    });
  });

  describe('panels', () => {
    it('opens the overview panel for "view"', async () => {
      guildSettingsRepository.setAnnouncementChannel(GUILD_ID, 'news');
      const { interaction, reply } = setup({ subcommand: 'view' });

      await executeSettingsCommand(interaction);

      const { payload, embed } = replied(reply);
      expect(payload.flags).toBe(MessageFlags.Ephemeral);
      expect(embed.title).toBe(t('settings.title', 'en'));
      expect(embed.fields?.[2]?.value).toBe('<#news>');
    });

    it('opens the logs panel for "logs"', async () => {
      const { interaction, reply } = setup({ subcommand: 'logs' });

      await executeSettingsCommand(interaction);

      const { embed } = replied(reply);
      expect(embed.title).toBe(t('settings.logs.title', 'en'));
      expect(embed.description).toBe(t('settings.logs.noLogs', 'en'));
    });
  });

  it('does nothing for an unknown subcommand', async () => {
    const { interaction, reply } = setup({ subcommand: 'bogus' });

    await executeSettingsCommand(interaction);

    expect(reply).not.toHaveBeenCalled();
    expect(settingsRow(db)).toBeUndefined();
  });
});
