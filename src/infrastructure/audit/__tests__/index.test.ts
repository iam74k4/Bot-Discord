import Database, { type Database as DatabaseType } from 'better-sqlite3';
import { Collection, EmbedBuilder, type Client } from 'discord.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { COLORS } from '../../../shared/utils/constants/index.js';
import { proxyDatabase } from '../../database/__tests__/infrastructure.helpers.js';
import { formatAuditTarget, shortenAuditDetails } from '../format.js';

/**
 * logAuditAction is fire-and-forget for its callers, so the properties that
 * matter are: the row is always written, delivery to the audit channel is
 * best-effort, and nothing it does can reject back into the caller.
 * Persistence runs on real SQLite; Discord is a hand-built stub.
 */
let db: DatabaseType = new Database(':memory:');

vi.mock('../../database/connection.js', () => ({
  database: proxyDatabase(() => db),
}));

const logger = vi.hoisted(() => ({
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
}));

vi.mock('../../../shared/utils/logger.js', () => ({
  logger,
  getErrorMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)),
}));

vi.mock('../../../config/index.js', () => ({
  env: { AUDIT_LOG_RETENTION_DAYS: 90 },
}));

const {
  audit,
  auditActionLabel,
  auditLocaleOf,
  auditRepository,
  logAuditAction,
} = await import('../index.js');
const { guildSettingsRepository } =
  await import('../../guildSettings/index.js');
const { t } = await import('../../../locales/index.js');
const migrations = await Promise.all([
  import('../../database/migrations/003_settings.js'),
  import('../../database/migrations/007_voice_autojoin.js'),
  import('../../database/migrations/008_announcement_channel.js'),
]);

const NOW = new Date('2026-07-01T12:00:00Z').getTime();
const GUILD_ID = 'guild-1';
const ACTOR_ID = 'actor-1';
const TARGET_ID = 'target-1';
const AUDIT_CHANNEL_ID = 'audit-chan';

const KNOWN_USERS: Record<string, { tag: string }> = {
  [ACTOR_ID]: { tag: 'Actor#0001' },
  [TARGET_ID]: { tag: 'Target#0002' },
};

/**
 * The audit trail is written in the server's language. These guilds are on
 * "automatic" and not Community servers unless a test says otherwise, so
 * that is Japanese; `userWithName` and the field names follow it.
 */
function userWithName(id: string, name: string, locale: 'ja' | 'en' = 'ja') {
  return t('audit.userWithName', locale, { mention: `<@${id}>`, name });
}

function createDiscord(
  guildExtras: { features?: string[]; preferredLocale?: string } = {}
) {
  const send = vi.fn().mockResolvedValue(undefined);
  const channels = new Collection<string, unknown>([
    [AUDIT_CHANNEL_ID, { id: AUDIT_CHANNEL_ID, isTextBased: () => true, send }],
  ]);
  const guilds = new Collection<string, unknown>([
    [GUILD_ID, { id: GUILD_ID, channels: { cache: channels }, ...guildExtras }],
  ]);
  const fetchUser = vi.fn(async (id: string) => {
    const user = KNOWN_USERS[id];
    if (!user) throw new Error('Unknown User');
    return user;
  });
  const client = {
    guilds: { cache: guilds },
    users: { fetch: fetchUser },
  } as unknown as Client;

  return { client, send, channels, guilds, fetchUser };
}

let discord: ReturnType<typeof createDiscord>;

/** The single embed passed to channel.send, as Discord would receive it. */
function sentEmbed() {
  expect(discord.send).toHaveBeenCalledTimes(1);
  const payload = discord.send.mock.calls[0][0] as { embeds: EmbedBuilder[] };
  expect(payload.embeds).toHaveLength(1);
  return payload.embeds[0].toJSON();
}

function configureAuditChannel(): void {
  guildSettingsRepository.setAuditChannel(GUILD_ID, AUDIT_CHANNEL_ID);
}

describe('audit', () => {
  beforeEach(() => {
    db = new Database(':memory:');
    for (const migration of migrations) migration.up();
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    discord = createDiscord();
  });

  afterEach(() => {
    vi.useRealTimers();
    db.close();
  });

  describe('formatAuditTarget', () => {
    it('formats audit setup targets as channel mentions', () => {
      expect(formatAuditTarget('AUDIT_SETUP', '123456')).toBe('<#123456>');
    });

    it('formats non-channel targets as user mentions', () => {
      expect(formatAuditTarget('SETTINGS_CHANGE', '123456')).toBe('<@123456>');
    });

    it('returns null when target is absent', () => {
      expect(formatAuditTarget('AUDIT_SETUP', null)).toBeNull();
      expect(formatAuditTarget('ROLE_ADD', undefined)).toBeNull();
      expect(formatAuditTarget('ROLE_ADD', '')).toBeNull();
    });
  });

  describe('shortenAuditDetails', () => {
    it('keeps details that fit, joined onto one line', () => {
      expect(shortenAuditDetails('ロール: <@&1>\n  （mods）')).toBe(
        'ロール: <@&1> （mods）'
      );
    });

    it('cuts long details to the limit, ending in an ellipsis', () => {
      const shortened = shortenAuditDetails('a'.repeat(200), 10);
      expect(shortened).toBe(`${'a'.repeat(9)}…`);
    });

    it('counts an emoji as one character and never splits it', () => {
      // Nine code points fit before the ellipsis; each 🎉 is two UTF-16
      // units, so a UTF-16 cut would leave half of the last one.
      const shortened = shortenAuditDetails(`${'🎉'.repeat(12)}`, 10);
      expect(shortened).toBe(`${'🎉'.repeat(9)}…`);
    });

    it.each([
      ['role', 'Role: <@&123456789012345678> (mods)'],
      ['channel', 'Channel: <#123456789012345678>'],
      ['user', 'User: <@!123456789012345678>'],
      ['timestamp', 'At: <t:1700000000:R>'],
    ])('drops a %s mention the cut would break', (_kind, tail) => {
      const head = 'x'.repeat(10);
      // The cut falls inside the mention, a few characters after its "<".
      const shortened = shortenAuditDetails(
        `${head} ${tail}`,
        head.length + tail.indexOf('<') + 6
      );
      expect(shortened).toBe(
        `${head} ${tail.slice(0, tail.indexOf('<')).trimEnd()}…`
      );
      expect(shortened).not.toContain('<');
    });

    it('keeps a mention that closes before the cut', () => {
      const shortened = shortenAuditDetails(
        'Role: <@&1> and a long tail of words',
        16
      );
      expect(shortened).toBe('Role: <@&1> and…');
    });

    it('keeps a plain "<" that is not Discord markup', () => {
      expect(shortenAuditDetails('limit < 5 then more words', 12)).toBe(
        'limit < 5 t…'
      );
    });
  });

  describe('logAuditAction', () => {
    describe('persistence', () => {
      it('records the action even when no audit channel is configured', async () => {
        await logAuditAction(
          discord.client,
          GUILD_ID,
          ACTOR_ID,
          'ROLE_ADD',
          TARGET_ID,
          'Role: Member'
        );

        expect(auditRepository.getLogs(GUILD_ID)).toEqual([
          expect.objectContaining({
            guild_id: GUILD_ID,
            user_id: ACTOR_ID,
            action: 'ROLE_ADD',
            target_id: TARGET_ID,
            details: 'Role: Member',
            created_at: NOW,
          }),
        ]);
        expect(discord.send).not.toHaveBeenCalled();
        expect(discord.fetchUser).not.toHaveBeenCalled();
      });

      it('logs and swallows a failed write without touching Discord', async () => {
        configureAuditChannel();
        db.exec('DROP TABLE audit_logs');

        await expect(
          logAuditAction(discord.client, GUILD_ID, ACTOR_ID, 'NOTIFY_ENABLE')
        ).resolves.toBeUndefined();

        expect(logger.error).toHaveBeenCalledWith(
          `Failed to persist audit log (NOTIFY_ENABLE) for guild ${GUILD_ID}:`,
          expect.objectContaining({
            message: expect.stringContaining('no such table: audit_logs'),
          })
        );
        expect(discord.send).not.toHaveBeenCalled();
      });

      it('keeps the row but skips delivery when the channel lookup fails', async () => {
        db.exec('DROP TABLE guild_settings');

        await expect(
          logAuditAction(discord.client, GUILD_ID, ACTOR_ID, 'NOTIFY_DISABLE')
        ).resolves.toBeUndefined();

        expect(auditRepository.getLogsCount(GUILD_ID)).toBe(1);
        expect(logger.error).toHaveBeenCalledTimes(1);
        expect(discord.send).not.toHaveBeenCalled();
      });
    });

    describe('delivery', () => {
      beforeEach(() => {
        configureAuditChannel();
      });

      it('posts an embed naming the actor, the target, and the details', async () => {
        await logAuditAction(
          discord.client,
          GUILD_ID,
          ACTOR_ID,
          'ROLE_ADD',
          TARGET_ID,
          'Role: Member'
        );

        expect(discord.send).toHaveBeenCalledWith({
          embeds: [expect.any(EmbedBuilder)],
        });
        expect(sentEmbed()).toEqual({
          title: t('audit.actions.ROLE_ADD', 'ja'),
          color: COLORS.SUCCESS,
          timestamp: new Date(NOW).toISOString(),
          fields: [
            {
              name: t('audit.fields.user', 'ja'),
              value: userWithName(ACTOR_ID, 'Actor#0001'),
              inline: true,
            },
            {
              name: t('audit.fields.target', 'ja'),
              value: userWithName(TARGET_ID, 'Target#0002'),
              inline: true,
            },
            {
              name: t('audit.fields.details', 'ja'),
              value: 'Role: Member',
              inline: false,
            },
          ],
        });
      });

      it('writes in English for a server set to English', async () => {
        guildSettingsRepository.setLanguage(GUILD_ID, 'en');

        await logAuditAction(
          discord.client,
          GUILD_ID,
          ACTOR_ID,
          'ROLE_ADD',
          TARGET_ID
        );

        expect(sentEmbed()).toMatchObject({
          title: 'Role Added',
          fields: [
            { name: 'User', value: userWithName(ACTOR_ID, 'Actor#0001', 'en') },
            {
              name: 'Target',
              value: userWithName(TARGET_ID, 'Target#0002', 'en'),
            },
          ],
        });
      });

      it.each([
        [
          'follows the server language of a Community server',
          ['COMMUNITY'],
          'Role Added',
        ],
        // Discord keeps every other server on en-US, which nobody chose.
        ['ignores the server language of other servers', [], 'ロールを付与'],
      ])('on automatic, %s', async (_case, features, title) => {
        discord = createDiscord({ features, preferredLocale: 'en-US' });

        await logAuditAction(discord.client, GUILD_ID, ACTOR_ID, 'ROLE_ADD');

        expect(sentEmbed().title).toBe(title);
      });

      it('escapes markdown in names so they cannot restyle the entry', async () => {
        discord.fetchUser.mockResolvedValue({ tag: '*bold*_name_' });

        await logAuditAction(discord.client, GUILD_ID, ACTOR_ID, 'ROLE_ADD');

        expect(sentEmbed().fields?.[0]?.value).toBe(
          userWithName(ACTOR_ID, '\\*bold\\*\\_name\\_')
        );
      });

      it('shows only the actor when there is no target or details', async () => {
        await logAuditAction(
          discord.client,
          GUILD_ID,
          ACTOR_ID,
          'NOTIFY_ENABLE'
        );

        expect(sentEmbed().fields).toEqual([
          {
            name: t('audit.fields.user', 'ja'),
            value: userWithName(ACTOR_ID, 'Actor#0001'),
            inline: true,
          },
        ]);
      });

      it('treats an empty target ID as no target', async () => {
        await logAuditAction(
          discord.client,
          GUILD_ID,
          ACTOR_ID,
          'ROLE_REMOVE',
          '',
          'Role: Member'
        );

        expect(sentEmbed().fields?.map((field) => field.name)).toEqual([
          t('audit.fields.user', 'ja'),
          t('audit.fields.details', 'ja'),
        ]);
      });

      it('falls back to plain mentions when users cannot be fetched', async () => {
        discord.fetchUser.mockRejectedValue(new Error('Unknown User'));

        await logAuditAction(
          discord.client,
          GUILD_ID,
          ACTOR_ID,
          'ROLE_ADD',
          TARGET_ID
        );

        expect(sentEmbed().fields?.map((field) => field.value)).toEqual([
          `<@${ACTOR_ID}>`,
          `<@${TARGET_ID}>`,
        ]);
        expect(logger.error).not.toHaveBeenCalled();
      });

      it('keeps the actor tag when only the target lookup fails', async () => {
        discord.fetchUser.mockImplementation(async (id: string) => {
          if (id === ACTOR_ID) return KNOWN_USERS[ACTOR_ID];
          throw new Error('Unknown User');
        });

        await logAuditAction(
          discord.client,
          GUILD_ID,
          ACTOR_ID,
          'ROLE_REMOVE',
          TARGET_ID
        );

        expect(sentEmbed().fields?.map((field) => field.value)).toEqual([
          userWithName(ACTOR_ID, 'Actor#0001'),
          `<@${TARGET_ID}>`,
        ]);
        expect(logger.error).not.toHaveBeenCalled();
      });

      it('keeps the target tag when only the actor lookup fails', async () => {
        discord.fetchUser.mockImplementation(async (id: string) => {
          if (id === TARGET_ID) return KNOWN_USERS[TARGET_ID];
          throw new Error('Unknown User');
        });

        await logAuditAction(
          discord.client,
          GUILD_ID,
          ACTOR_ID,
          'ROLE_ADD',
          TARGET_ID
        );

        expect(sentEmbed().fields?.map((field) => field.value)).toEqual([
          `<@${ACTOR_ID}>`,
          userWithName(TARGET_ID, 'Target#0002'),
        ]);
      });

      it('accepts details right at the 1024-character field limit', async () => {
        const details = 'x'.repeat(1024);

        await logAuditAction(
          discord.client,
          GUILD_ID,
          ACTOR_ID,
          'SETTINGS_CHANGE',
          undefined,
          details
        );

        expect(sentEmbed().fields).toContainEqual({
          name: t('audit.fields.details', 'ja'),
          value: details,
          inline: false,
        });
      });

      it('shows an AUDIT_SETUP target as a channel without looking it up as a user', async () => {
        await logAuditAction(
          discord.client,
          GUILD_ID,
          ACTOR_ID,
          'AUDIT_SETUP',
          'new-audit-chan'
        );

        expect(sentEmbed().fields).toContainEqual({
          name: t('audit.fields.target', 'ja'),
          value: '<#new-audit-chan>',
          inline: true,
        });
        expect(discord.fetchUser).toHaveBeenCalledTimes(1);
        expect(discord.fetchUser).toHaveBeenCalledWith(ACTOR_ID);
      });

      it.each([
        ['NOTIFY_SETUP', '通知を設定', 'Notification Setup', COLORS.SUCCESS],
        [
          'NOTIFY_ENABLE',
          '通知を有効化',
          'Notifications Enabled',
          COLORS.SUCCESS,
        ],
        [
          'NOTIFY_DISABLE',
          '通知を無効化',
          'Notifications Disabled',
          COLORS.WARNING,
        ],
        [
          'NOTIFY_REMOVE',
          '通知を解除',
          'Notification Settings Removed',
          COLORS.ERROR,
        ],
        ['SETTINGS_CHANGE', '設定を変更', 'Settings Changed', COLORS.INFO],
        ['AUDIT_SETUP', '監査ログを設定', 'Audit Log Configured', COLORS.INFO],
        ['ROLE_ADD', 'ロールを付与', 'Role Added', COLORS.SUCCESS],
        ['ROLE_REMOVE', 'ロールを外す', 'Role Removed', COLORS.WARNING],
      ] as const)('titles and colours %s', async (action, ja, en, color) => {
        await logAuditAction(discord.client, GUILD_ID, ACTOR_ID, action);
        expect(sentEmbed()).toMatchObject({ title: ja, color });
        expect(auditActionLabel(action, 'en')).toBe(en);
      });

      it('names an action this version does not know as readable text', () => {
        expect(auditActionLabel('SOMETHING_NEW', 'ja')).toBe('SOMETHING NEW');
      });

      it('posts to the channel it is told to instead of the configured one', async () => {
        const otherSend = vi.fn().mockResolvedValue(undefined);
        discord.channels.set('old-audit', {
          id: 'old-audit',
          isTextBased: () => true,
          send: otherSend,
        });

        await logAuditAction(
          discord.client,
          GUILD_ID,
          ACTOR_ID,
          'AUDIT_SETUP',
          undefined,
          'cleared',
          { deliverTo: 'old-audit' }
        );

        expect(otherSend).toHaveBeenCalledTimes(1);
        expect(discord.send).not.toHaveBeenCalled();
      });

      it('posts nowhere when told to deliver to no channel', async () => {
        await logAuditAction(
          discord.client,
          GUILD_ID,
          ACTOR_ID,
          'AUDIT_SETUP',
          undefined,
          undefined,
          { deliverTo: null }
        );

        expect(discord.send).not.toHaveBeenCalled();
        expect(auditRepository.getLogsCount(GUILD_ID)).toBe(1);
      });
    });

    describe('when the audit channel cannot be used', () => {
      beforeEach(() => {
        configureAuditChannel();
      });

      async function expectRecordedButNotSent(): Promise<void> {
        await expect(
          logAuditAction(discord.client, GUILD_ID, ACTOR_ID, 'NOTIFY_ENABLE')
        ).resolves.toBeUndefined();

        expect(auditRepository.getLogsCount(GUILD_ID)).toBe(1);
        expect(discord.send).not.toHaveBeenCalled();
        expect(logger.error).not.toHaveBeenCalled();
      }

      it('skips delivery when the bot is no longer in the guild', async () => {
        discord.guilds.delete(GUILD_ID);

        await expectRecordedButNotSent();
      });

      it('skips delivery when the configured channel was deleted', async () => {
        discord.channels.delete(AUDIT_CHANNEL_ID);

        await expectRecordedButNotSent();
      });

      it('skips delivery to a channel that is not text-based', async () => {
        discord.channels.set(AUDIT_CHANNEL_ID, {
          id: AUDIT_CHANNEL_ID,
          isTextBased: () => false,
          send: discord.send,
        });

        await expectRecordedButNotSent();
      });

      it('skips delivery to a text-based channel that cannot be sent to', async () => {
        discord.channels.set(AUDIT_CHANNEL_ID, {
          id: AUDIT_CHANNEL_ID,
          isTextBased: () => true,
        });

        await expectRecordedButNotSent();
      });
    });

    describe('when sending fails', () => {
      beforeEach(() => {
        configureAuditChannel();
      });

      it('logs a permission error once without retrying or rejecting', async () => {
        const missingPermissions = new Error('Missing Permissions');
        discord.send.mockRejectedValue(missingPermissions);

        await expect(
          logAuditAction(discord.client, GUILD_ID, ACTOR_ID, 'ROLE_ADD')
        ).resolves.toBeUndefined();

        expect(discord.send).toHaveBeenCalledTimes(1);
        expect(logger.error).toHaveBeenCalledWith(
          'Failed to send audit log:',
          missingPermissions
        );
        expect(auditRepository.getLogsCount(GUILD_ID)).toBe(1);
      });

      it('records but does not post details longer than an embed field allows', async () => {
        const details = 'x'.repeat(1025);

        await expect(
          logAuditAction(
            discord.client,
            GUILD_ID,
            ACTOR_ID,
            'SETTINGS_CHANGE',
            undefined,
            details
          )
        ).resolves.toBeUndefined();

        // The full text is kept in the database even though Discord would
        // reject it, and the embed failure is logged rather than rethrown.
        expect(auditRepository.getLogs(GUILD_ID)).toEqual([
          expect.objectContaining({ action: 'SETTINGS_CHANGE', details }),
        ]);
        expect(discord.send).not.toHaveBeenCalled();
        expect(logger.error).toHaveBeenCalledTimes(1);
        expect(logger.error).toHaveBeenCalledWith(
          'Failed to send audit log:',
          expect.any(Error)
        );
      });

      it('retries a transient network failure and then delivers', async () => {
        discord.send
          .mockRejectedValueOnce(new Error('socket hang up'))
          .mockResolvedValueOnce(undefined);

        const pending = logAuditAction(
          discord.client,
          GUILD_ID,
          ACTOR_ID,
          'ROLE_ADD'
        );
        await vi.runAllTimersAsync();
        await pending;

        expect(discord.send).toHaveBeenCalledTimes(2);
        expect(logger.error).not.toHaveBeenCalled();
      });

      it('gives up after two retries and logs the last error', async () => {
        const outage = new Error('503 Service Unavailable');
        discord.send.mockRejectedValue(outage);

        const pending = logAuditAction(
          discord.client,
          GUILD_ID,
          ACTOR_ID,
          'ROLE_ADD'
        );
        await vi.runAllTimersAsync();
        await expect(pending).resolves.toBeUndefined();

        expect(discord.send).toHaveBeenCalledTimes(3);
        expect(logger.error).toHaveBeenCalledWith(
          'Failed to send audit log:',
          outage
        );
      });
    });
  });

  describe('helpers', () => {
    type Case = [
      string,
      (client: Client) => Promise<void>,
      { action: string; target_id: string | null; details: string | null },
    ];

    // Details are written once, in the server's language (Japanese here).
    const cases: Case[] = [
      [
        'notifySetup with a kind',
        (client) =>
          audit.notifySetup(client, GUILD_ID, ACTOR_ID, 'chan-5', 'Voice'),
        {
          action: 'NOTIFY_SETUP',
          target_id: null,
          details: 'VC入退室通知 → <#chan-5>',
        },
      ],
      [
        'notifySetup with a kind it does not know',
        (client) =>
          audit.notifySetup(client, GUILD_ID, ACTOR_ID, 'chan-5', 'Polls'),
        {
          action: 'NOTIFY_SETUP',
          target_id: null,
          details: t('audit.details.notifySetup', 'ja', {
            kind: 'Polls',
            channel: 'chan-5',
          }),
        },
      ],
      [
        'notifySetup without a kind',
        (client) => audit.notifySetup(client, GUILD_ID, ACTOR_ID, 'chan-5'),
        {
          action: 'NOTIFY_SETUP',
          target_id: null,
          details: t('audit.details.notifyChannel', 'ja', {
            channel: 'chan-5',
          }),
        },
      ],
      [
        'notifyEnable',
        (client) => audit.notifyEnable(client, GUILD_ID, ACTOR_ID),
        { action: 'NOTIFY_ENABLE', target_id: null, details: null },
      ],
      [
        'notifyDisable',
        (client) => audit.notifyDisable(client, GUILD_ID, ACTOR_ID),
        { action: 'NOTIFY_DISABLE', target_id: null, details: null },
      ],
      [
        'notifyRemove with a kind',
        (client) => audit.notifyRemove(client, GUILD_ID, ACTOR_ID, 'Welcome'),
        {
          action: 'NOTIFY_REMOVE',
          target_id: null,
          details: t('audit.details.notifyRemove', 'ja', {
            kind: t('audit.kinds.Welcome', 'ja'),
          }),
        },
      ],
      [
        'notifyRemove without a kind',
        (client) => audit.notifyRemove(client, GUILD_ID, ACTOR_ID),
        { action: 'NOTIFY_REMOVE', target_id: null, details: null },
      ],
      [
        'roleAdd',
        (client) =>
          audit.roleAdd(client, GUILD_ID, ACTOR_ID, TARGET_ID, 'Role: Member'),
        { action: 'ROLE_ADD', target_id: TARGET_ID, details: 'Role: Member' },
      ],
      [
        'roleRemove',
        (client) =>
          audit.roleRemove(client, GUILD_ID, ACTOR_ID, TARGET_ID, 'Role: VIP'),
        { action: 'ROLE_REMOVE', target_id: TARGET_ID, details: 'Role: VIP' },
      ],
      [
        'settingsChange',
        (client) =>
          audit.settingsChange(client, GUILD_ID, ACTOR_ID, 'Language: en'),
        {
          action: 'SETTINGS_CHANGE',
          target_id: null,
          details: 'Language: en',
        },
      ],
    ];

    it.each(cases)('%s records the expected entry', async (_, call, row) => {
      await call(discord.client);

      expect(auditRepository.getLogs(GUILD_ID)).toEqual([
        expect.objectContaining({ user_id: ACTOR_ID, ...row }),
      ]);
    });

    it('writes helper details in English for a server set to English', async () => {
      guildSettingsRepository.setLanguage(GUILD_ID, 'en');

      await audit.notifySetup(
        discord.client,
        GUILD_ID,
        ACTOR_ID,
        'chan-5',
        'Voice'
      );

      expect(auditRepository.getLogs(GUILD_ID)[0]?.details).toBe(
        'Voice notifications → <#chan-5>'
      );
    });

    it('delivers helper entries to the audit channel too', async () => {
      configureAuditChannel();

      await audit.notifySetup(
        discord.client,
        GUILD_ID,
        ACTOR_ID,
        'chan-5',
        'Voice'
      );

      expect(sentEmbed()).toMatchObject({
        title: t('audit.actions.NOTIFY_SETUP', 'ja'),
        fields: expect.arrayContaining([
          {
            name: t('audit.fields.details', 'ja'),
            value: 'VC入退室通知 → <#chan-5>',
            inline: false,
          },
        ]),
      });
    });
  });

  describe('auditLocaleOf', () => {
    it('honours the configured language of a guild the bot has not cached', () => {
      guildSettingsRepository.setLanguage('uncached', 'en');

      expect(auditLocaleOf(discord.client, 'uncached')).toBe('en');
      expect(auditLocaleOf(discord.client, 'unknown')).toBe('ja');
    });
  });
});
