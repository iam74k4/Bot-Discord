import Database from 'better-sqlite3';
import {
  Collection,
  MessageFlags,
  PermissionFlagsBits,
  PermissionsBitField,
  type ChatInputCommandInteraction,
  type Client,
  type Guild,
} from 'discord.js';
import {
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
const { formatPermissionNames } =
  await import('../../../shared/utils/discord.js');
const { commandMention } =
  await import('../../../shared/utils/commandMentions.js');

const MOD_LOG = textChannelStub({ id: 'mod-log', name: 'mod-log' });
const NEWS = textChannelStub({ id: 'news', name: 'news' });
const READ_ONLY = textChannelStub({
  id: 'read-only',
  name: 'read-only',
  canSend: false,
});
/** The bot can post there, but not embeds - and every post is an embed. */
const NO_EMBEDS = textChannelStub({
  id: 'no-embeds',
  name: 'no-embeds',
  permissions: [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages,
  ],
});

function setup(
  options: {
    subcommand?: string;
    guild?: Guild | null;
    permissions?: PermissionsBitField | string;
    channel?: { id: string } | null;
    lang?: string;
    locale?: string;
    client?: Client;
  } = {}
) {
  const guild =
    options.guild === undefined
      ? guildStub({ channels: [MOD_LOG, NEWS, READ_ONLY, NO_EMBEDS] })
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
    client: options.client ?? clientStub(),
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

function replied(reply: Mock) {
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
      permissions: formatPermissionNames(PermissionFlagsBits.ManageGuild, 'en'),
    });

    it('requires Manage Server, named the way Discord names it', async () => {
      const { interaction, reply } = setup({
        subcommand: 'language',
        lang: 'ja',
        permissions: new PermissionsBitField(PermissionFlagsBits.ManageRoles),
      });

      await executeSettingsCommand(interaction);

      const { payload, embed } = replied(reply);
      expect(payload.flags).toBe(MessageFlags.Ephemeral);
      expect(embed.title).toBe(t('common.permissionDeniedTitle', 'en'));
      expect(embed.description).toBe(denied);
      expect(embed.description).toContain('Manage Server');
      expect(embed.color).toBe(COLORS.WARNING);
      expect(settingsRow(db)).toBeUndefined();
      expect(auditRows(db)).toEqual([]);
    });

    it('denies when the member permissions are not resolved', async () => {
      // Uncached members arrive as API objects whose permissions are a string.
      const { interaction, reply } = setup({ permissions: '32' });

      await executeSettingsCommand(interaction);

      expect(replied(reply).embed.description).toBe(denied);
    });

    it('accepts the permissions Discord sent with the interaction', async () => {
      const { interaction, reply } = setup({ permissions: '32' });
      Object.assign(interaction, {
        memberPermissions: new PermissionsBitField(
          PermissionFlagsBits.ManageGuild
        ),
      });

      await executeSettingsCommand(interaction);

      expect(replied(reply).embed.title).toBe(t('settings.title', 'en'));
    });

    it('says the command only works in a server outside one', async () => {
      const { interaction, reply } = setup({ guild: null });

      await executeSettingsCommand(interaction);

      const { embed } = replied(reply);
      expect(embed.title).toBe(t('common.serverOnlyTitle', 'en'));
      expect(embed.description).toBe(t('common.guildOnly', 'en'));
    });

    it('answers in the guild language when one is configured', async () => {
      guildSettingsRepository.setLanguage(GUILD_ID, 'ja');
      const { interaction, reply } = setup({
        permissions: new PermissionsBitField(),
        locale: 'en-US',
      });

      await executeSettingsCommand(interaction);

      expect(replied(reply).embed.title).toBe(
        t('common.permissionDeniedTitle', 'ja')
      );
    });
  });

  describe('language', () => {
    it.each([
      ['ja', 'ja', '日本語'],
      ['en', 'en', 'English'],
    ] as const)(
      'stores %s, audit-logs it and confirms in that language',
      async (lang, stored, display) => {
        const { interaction, reply } = setup({ subcommand: 'language', lang });

        await executeSettingsCommand(interaction);

        expect(settingsRow(db)?.language).toBe(stored);
        // Details are written in the server's language, now the new one.
        expect(auditRows(db)).toEqual([
          {
            action: 'SETTINGS_CHANGE',
            user_id: USER_ID,
            target_id: null,
            details: t('audit.details.language', stored, {
              language: display,
            }),
          },
        ]);
        const { payload, embed } = replied(reply);
        expect(payload.flags).toBe(MessageFlags.Ephemeral);
        expect(embed.color).toBe(COLORS.SUCCESS);
        // Resolved after the change: an English-client admin who picks 日本語
        // sees the confirmation in Japanese already.
        expect(embed.title).toBe(t('settings.language.name', stored));
        expect(embed.description).toContain(
          t('settings.language.changed', stored, { language: display })
        );
        expect(embed.description).toContain(
          commandMention('admin settings view')
        );
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
      // A non-Community server on automatic posts in Japanese.
      expect(auditRows(db).map((r) => r.details)).toEqual([
        t('audit.details.language', 'ja', {
          language: t('settings.language.auto', 'ja'),
        }),
      ]);
      // Resolved after the change: back to the admin's own language.
      expect(replied(reply).embed.description).toContain(
        t('settings.language.changed', 'en', {
          language: t('settings.language.auto', 'en'),
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
      // The audit channel is AUDIT_SETUP's target, shown as a channel, and
      // not repeated in the details.
      target: MOD_LOG.id as string | null,
      details: null as string | null,
      clearedDetails: t('audit.details.auditChannelCleared', 'ja'),
      nextWhenSet: 'admin settings logs',
      nextWhenCleared: 'admin settings audit',
    },
    {
      subcommand: 'announcements',
      column: 'announcement_channel_id' as const,
      nameKey: 'settings.announcements.name' as const,
      configuredKey: 'settings.announcements.configured' as const,
      disabledKey: 'settings.announcements.disabled' as const,
      channel: NEWS,
      action: 'SETTINGS_CHANGE',
      // A SETTINGS_CHANGE target is read as a member, so the channel is
      // named in the details instead.
      target: null,
      details: t('audit.details.announcementChannelSet', 'ja', {
        channel: NEWS.id,
      }) as string | null,
      clearedDetails: t('audit.details.announcementChannelCleared', 'ja'),
      nextWhenSet: 'admin settings view',
      nextWhenCleared: 'admin settings announcements',
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
          target_id: c.target,
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
        )}: ${commandMention(c.nextWhenSet)}`
      );
    });

    it('names every permission the bot lacks in a channel it cannot post in', async () => {
      guildSettingsRepository.update(GUILD_ID, { [c.column]: 'previous' });
      const { interaction, reply } = setup({
        subcommand: c.subcommand,
        channel: { id: READ_ONLY.id },
      });

      await executeSettingsCommand(interaction);

      expect(settingsRow(db)?.[c.column]).toBe('previous');
      expect(auditRows(db)).toEqual([]);
      const { payload, embed } = replied(reply);
      expect(payload.flags).toBe(MessageFlags.Ephemeral);
      expect(embed.description).toBe(
        t('settings.errors.channelMissingPermissions', 'en', {
          channel: READ_ONLY.id,
          permissions: formatPermissionNames(
            [
              PermissionFlagsBits.ViewChannel,
              PermissionFlagsBits.SendMessages,
              PermissionFlagsBits.EmbedLinks,
            ],
            'en'
          ),
        })
      );
    });

    it('rejects a channel where the bot may post but not embed', async () => {
      // Send Messages alone used to pass, and every post then failed.
      const { interaction, reply } = setup({
        subcommand: c.subcommand,
        channel: { id: NO_EMBEDS.id },
      });

      await executeSettingsCommand(interaction);

      expect(settingsRow(db)).toBeUndefined();
      expect(replied(reply).embed.description).toBe(
        t('settings.errors.channelMissingPermissions', 'en', {
          channel: NO_EMBEDS.id,
          permissions: formatPermissionNames(
            PermissionFlagsBits.EmbedLinks,
            'en'
          ),
        })
      );
    });

    it('rejects a channel that no longer exists', async () => {
      guildSettingsRepository.update(GUILD_ID, { [c.column]: 'previous' });
      const { interaction, reply } = setup({
        subcommand: c.subcommand,
        channel: { id: 'deleted' },
      });

      await executeSettingsCommand(interaction);

      expect(settingsRow(db)?.[c.column]).toBe('previous');
      expect(auditRows(db)).toEqual([]);
      expect(replied(reply).embed.description).toBe(
        t('settings.errors.channelNotSendable', 'en')
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
        t('settings.errors.channelNotSendable', 'en')
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
        `${t(c.disabledKey, 'en')}\n\n${t(
          'common.nextStep',
          'en'
        )}: ${commandMention(c.nextWhenCleared)}`
      );
    });

    /**
     * Regression: clearing used to write NULL and reply without calling
     * `logAuditAction`, while the settings panel's "clear" button did audit
     * the same change, so a Manage Server holder could switch audit logging
     * (or announcements) off from the slash command without leaving a trace.
     */
    it('audit-logs who cleared the channel', async () => {
      guildSettingsRepository.update(GUILD_ID, { [c.column]: c.channel.id });
      const { interaction } = setup({
        subcommand: c.subcommand,
        channel: null,
      });

      await executeSettingsCommand(interaction);

      expect(auditRows(db)).toEqual([
        {
          action: c.action,
          user_id: USER_ID,
          target_id: null,
          details: c.clearedDetails,
        },
      ]);
    });

    it('records nothing when clearing a channel that was never set', async () => {
      const { interaction } = setup({
        subcommand: c.subcommand,
        channel: null,
      });

      await executeSettingsCommand(interaction);

      expect(auditRows(db)).toEqual([]);
    });
  });

  describe('clearing the audit channel', () => {
    it('posts the entry to the channel that stops receiving logs', async () => {
      const send = vi.fn().mockResolvedValue({});
      const oldChannel = { id: 'old-audit', isTextBased: () => true, send };
      const guild = guildStub({ channels: [MOD_LOG] });
      (guild.channels.cache as Collection<string, unknown>).set(
        oldChannel.id,
        oldChannel
      );
      guildSettingsRepository.setAuditChannel(GUILD_ID, oldChannel.id);
      const { interaction } = setup({
        subcommand: 'audit',
        channel: null,
        guild,
        client: clientStub([guild]),
      });

      await executeSettingsCommand(interaction);

      expect(settingsRow(db)?.audit_channel_id).toBeNull();
      await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
      const [{ embeds }] = send.mock.calls[0] as [
        { embeds: Array<{ toJSON(): { title?: string } }> },
      ];
      expect(embeds[0]!.toJSON().title).toBe(
        t('audit.actions.AUDIT_SETUP', 'ja')
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
