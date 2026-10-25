import Database from 'better-sqlite3';
import { ChannelType, MessageFlags, PermissionFlagsBits } from 'discord.js';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { COLORS } from '../../../shared/utils/constants/index.js';
import { t } from '../../../locales/index.js';
import { commandMention } from '../../../shared/utils/commandMentions.js';
import { formatPermissionNames } from '../../../shared/utils/discord.js';
import {
  GUILD_ID,
  POSTING_PERMISSIONS,
  USER_ID,
  clearNotificationTables,
  createCommandInteraction,
  createGuild,
  createTextChannel,
  embedOf,
  lastCallArg,
  migrateNotificationSchema,
  type FakeCommandOptions,
} from './notification.helpers.js';

/**
 * `/notification voice|welcome set|disable|status|stats`, from the command
 * router down to the stored configuration. Only the audit log is mocked (it
 * posts to Discord); the repository and guild-language lookup use real
 * in-memory SQLite and channel checks use the real `getSendableTextChannel`.
 */
const db = new Database(':memory:');

vi.mock('../../../infrastructure/database/connection.js', () => ({
  database: db,
}));

vi.mock('../../../shared/utils/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
  getErrorMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)),
}));

const notifySetup = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const notifyRemove = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock('../../../infrastructure/audit/index.js', () => ({
  audit: { notifySetup, notifyRemove },
}));

const {
  handleVoiceSet,
  handleVoiceRemove,
  handleWelcomeSet,
  handleWelcomeRemove,
  handleStatus,
} = await import('../application/notification.js');
const { command } = await import('../commands/notification.js');
const { notificationChannelRepository } =
  await import('../repositories/notificationChannelRepository.js');
const { guildSettingsRepository } =
  await import('../../../infrastructure/guildSettings/index.js');

const TARGET = 'notify-1';

function textOption(id = TARGET) {
  return { id, type: ChannelType.GuildText };
}

/** A guild where the bot can post in `TARGET`. */
function sendableGuild() {
  return createGuild({ cached: [createTextChannel(TARGET)] });
}

function replyOf(fake: ReturnType<typeof createCommandInteraction>) {
  expect(fake.reply).toHaveBeenCalledTimes(1);
  const payload = lastCallArg(fake.reply) as { flags?: number };
  return { payload, embed: embedOf(payload) };
}

function expectError(
  fake: ReturnType<typeof createCommandInteraction>,
  messageKey: Parameters<typeof t>[0],
  locale: 'en' | 'ja' = 'en'
) {
  const { payload, embed } = replyOf(fake);
  expect(payload.flags).toBe(MessageFlags.Ephemeral);
  expect(embed.title).toBe(t('common.error', locale));
  expect(embed.description).toBe(t(messageKey, locale));
  expect(embed.color).toBe(COLORS.ERROR);
}

/** The Manage Server refusal every settings subcommand shares. */
function expectPermissionDenied(
  fake: ReturnType<typeof createCommandInteraction>,
  locale: 'en' | 'ja' = 'en'
) {
  const { payload, embed } = replyOf(fake);
  expect(payload.flags).toBe(MessageFlags.Ephemeral);
  expect(embed.title).toBe(t('common.permissionDeniedTitle', locale));
  expect(embed.description).toBe(
    t('common.permissionsRequired', locale, {
      permissions: formatPermissionNames(
        PermissionFlagsBits.ManageGuild,
        locale
      ),
    })
  );
  expect(embed.color).toBe(COLORS.WARNING);
}

/**
 * The confirmation for a set: where posts go, which language they come out
 * in (an English reader on a server on "auto" is told they will be in
 * Japanese, and why), then the next step.
 */
function setDescription(
  keys: { body: Parameters<typeof t>[0]; next: Parameters<typeof t>[0] },
  options: { hint?: boolean; locale?: 'en' | 'ja' } = {}
) {
  const locale = options.locale ?? 'en';
  return [
    t(keys.body, locale, { channel: TARGET }),
    t('notification.language.line', locale, { language: '日本語' }),
    ...(options.hint === false
      ? []
      : [
          t('notification.language.autoHint', locale, {
            language: '日本語',
            command: commandMention('admin settings language'),
          }),
        ]),
    '',
    t(keys.next, locale, { command: commandMention('notification status') }),
  ].join('\n');
}

const setHandlers = [
  {
    name: 'handleVoiceSet',
    handler: handleVoiceSet,
    type: 'voice',
    auditKind: 'Voice',
    keys: {
      title: 'notification.voice.setTitle',
      body: 'notification.voice.set',
      next: 'notification.voice.nextStep',
    },
  },
  {
    name: 'handleWelcomeSet',
    handler: handleWelcomeSet,
    type: 'member_join',
    auditKind: 'Welcome',
    keys: {
      title: 'notification.welcome.setTitle',
      body: 'notification.welcome.set',
      next: 'notification.welcome.nextStep',
    },
  },
] as const;

const removeHandlers = [
  {
    name: 'handleVoiceRemove',
    handler: handleVoiceRemove,
    type: 'voice',
    otherType: 'member_join',
    auditKind: 'Voice',
    setCommand: 'notification voice set',
    keys: {
      title: 'notification.voice.removedTitle',
      body: 'notification.voice.removed',
      hint: 'notification.voice.disabledHint',
      label: 'notification.summary.voice',
      already: 'notification.voice.alreadyDisabled',
    },
  },
  {
    name: 'handleWelcomeRemove',
    handler: handleWelcomeRemove,
    type: 'member_join',
    otherType: 'voice',
    auditKind: 'Welcome',
    setCommand: 'notification welcome set',
    keys: {
      title: 'notification.welcome.removedTitle',
      body: 'notification.welcome.removed',
      hint: 'notification.welcome.disabledHint',
      label: 'notification.summary.welcome',
      already: 'notification.welcome.alreadyDisabled',
    },
  },
] as const;

beforeAll(async () => {
  await migrateNotificationSchema();
});

beforeEach(() => {
  vi.clearAllMocks();
  clearNotificationTables(db);
});

afterAll(() => {
  db.close();
});

describe('notification settings handlers', () => {
  describe.each(setHandlers)('$name', ({ handler, type, auditKind, keys }) => {
    it('stores the channel, audits it and confirms ephemerally', async () => {
      const fake = createCommandInteraction({
        guild: sendableGuild(),
        channel: textOption(),
      });

      await handler(fake.interaction);

      expect(notificationChannelRepository.getEnabled(GUILD_ID, type)).toBe(
        TARGET
      );
      expect(notifySetup).toHaveBeenCalledWith(
        fake.interaction.client,
        GUILD_ID,
        USER_ID,
        TARGET,
        auditKind
      );
      const { payload, embed } = replyOf(fake);
      expect(payload.flags).toBe(MessageFlags.Ephemeral);
      expect(embed.title).toBe(t(keys.title, 'en'));
      expect(embed.description).toBe(setDescription(keys));
      expect(embed.color).toBe(COLORS.SUCCESS);
    });

    it('tells a Japanese reader the posts are in Japanese, with no hint', async () => {
      const fake = createCommandInteraction({
        guild: sendableGuild(),
        channel: textOption(),
        locale: 'ja',
      });

      await handler(fake.interaction);

      expect(replyOf(fake).embed.description).toBe(
        setDescription(keys, { hint: false, locale: 'ja' })
      );
    });

    it('moves an existing configuration to the new channel', async () => {
      notificationChannelRepository.set(GUILD_ID, type, 'old-channel');
      const fake = createCommandInteraction({
        guild: sendableGuild(),
        channel: textOption(),
      });

      await handler(fake.interaction);

      expect(notificationChannelRepository.getAllForGuild(GUILD_ID)).toEqual([
        expect.objectContaining({ type, channel_id: TARGET, enabled: 1 }),
      ]);
    });

    it('accepts a channel the bot only finds by fetching', async () => {
      const fake = createCommandInteraction({
        guild: createGuild({ fetchable: [createTextChannel(TARGET)] }),
        channel: textOption(),
      });

      await handler(fake.interaction);

      expect(notificationChannelRepository.getEnabled(GUILD_ID, type)).toBe(
        TARGET
      );
    });

    it('replies in the guild language when one is configured', async () => {
      guildSettingsRepository.setLanguage(GUILD_ID, 'ja');
      const fake = createCommandInteraction({
        guild: sendableGuild(),
        channel: textOption(),
        locale: 'en-US',
      });

      await handler(fake.interaction);

      expect(replyOf(fake).embed.title).toBe(t(keys.title, 'ja'));
    });

    it('refuses outside a guild', async () => {
      const fake = createCommandInteraction({
        guild: null,
        channel: textOption(),
      });

      await handler(fake.interaction);

      expectError(fake, 'common.guildOnly');
      expect(notifySetup).not.toHaveBeenCalled();
    });

    it.each([ChannelType.GuildVoice, ChannelType.GuildAnnouncement])(
      'refuses a non-text channel (type %i)',
      async (channelType) => {
        const fake = createCommandInteraction({
          guild: sendableGuild(),
          channel: { id: TARGET, type: channelType },
        });

        await handler(fake.interaction);

        expectError(fake, 'notification.errors.textChannelOnly');
        expect(notificationChannelRepository.get(GUILD_ID, type)).toBeNull();
        expect(notifySetup).not.toHaveBeenCalled();
      }
    );

    it('refuses a channel the bot cannot post in, naming what is missing', async () => {
      const fake = createCommandInteraction({
        guild: createGuild({
          cached: [createTextChannel(TARGET, { canSend: false })],
        }),
        channel: textOption(),
      });

      await handler(fake.interaction);

      const { embed } = replyOf(fake);
      expect(embed.color).toBe(COLORS.ERROR);
      expect(embed.description).toBe(
        t('notification.errors.channelMissingPermissions', 'en', {
          channel: TARGET,
          permissions: 'View Channels, Send Messages, and Embed Links',
        })
      );
      expect(notificationChannelRepository.get(GUILD_ID, type)).toBeNull();
      expect(notifySetup).not.toHaveBeenCalled();
    });

    it('refuses a channel where the bot can send but not embed links', async () => {
      // Every notification is an embed: Send Messages alone is not enough.
      const fake = createCommandInteraction({
        guild: createGuild({
          cached: [
            createTextChannel(TARGET, {
              permissions:
                POSTING_PERMISSIONS & ~PermissionFlagsBits.EmbedLinks,
            }),
          ],
        }),
        channel: textOption(),
        locale: 'ja',
      });

      await handler(fake.interaction);

      expect(replyOf(fake).embed.description).toBe(
        t('notification.errors.channelMissingPermissions', 'ja', {
          channel: TARGET,
          permissions: '「埋め込みリンク」',
        })
      );
      expect(notificationChannelRepository.get(GUILD_ID, type)).toBeNull();
    });

    it('refuses a channel that no longer exists', async () => {
      const fake = createCommandInteraction({
        guild: createGuild({ cached: [] }),
        channel: textOption(),
      });

      await handler(fake.interaction);

      expectError(fake, 'notification.errors.channelNotSendable');
      expect(notificationChannelRepository.get(GUILD_ID, type)).toBeNull();
    });

    it('keeps the previous channel when the new one is rejected', async () => {
      notificationChannelRepository.set(GUILD_ID, type, 'old-channel');
      const fake = createCommandInteraction({
        guild: createGuild({ cached: [], me: null }),
        channel: textOption(),
      });

      await handler(fake.interaction);

      expect(notificationChannelRepository.getEnabled(GUILD_ID, type)).toBe(
        'old-channel'
      );
    });
  });

  describe.each(removeHandlers)(
    '$name',
    ({ handler, type, otherType, auditKind, setCommand, keys }) => {
      it('removes only its own configuration, audits it and confirms', async () => {
        notificationChannelRepository.set(GUILD_ID, type, 'chan-a');
        notificationChannelRepository.set(GUILD_ID, otherType, 'chan-b');
        const fake = createCommandInteraction();

        await handler(fake.interaction);

        expect(notificationChannelRepository.get(GUILD_ID, type)).toBeNull();
        expect(
          notificationChannelRepository.getEnabled(GUILD_ID, otherType)
        ).toBe('chan-b');
        expect(notifyRemove).toHaveBeenCalledWith(
          fake.interaction.client,
          GUILD_ID,
          USER_ID,
          auditKind
        );
        const { payload, embed } = replyOf(fake);
        expect(payload.flags).toBe(MessageFlags.Ephemeral);
        expect(embed.title).toBe(t(keys.title, 'en'));
        expect(embed.description).toBe(
          `${t(keys.body, 'en')}\n\n${t(keys.hint, 'en', {
            command: commandMention(setCommand),
          })}`
        );
        expect(embed.color).toBe(COLORS.SUCCESS);
      });

      it('says it is already off, names the set command and does not audit', async () => {
        notificationChannelRepository.set(GUILD_ID, otherType, 'chan-b');
        const fake = createCommandInteraction();

        await handler(fake.interaction);

        // A no-op disable is information, not a red error.
        const { payload, embed } = replyOf(fake);
        expect(payload.flags).toBe(MessageFlags.Ephemeral);
        expect(embed.title).toBe(t(keys.label, 'en'));
        expect(embed.description).toBe(
          t(keys.already, 'en', { command: commandMention(setCommand) })
        );
        expect(embed.color).toBe(COLORS.INFO);
        expect(notifyRemove).not.toHaveBeenCalled();
        expect(
          notificationChannelRepository.getEnabled(GUILD_ID, otherType)
        ).toBe('chan-b');
      });

      it('refuses outside a guild', async () => {
        const fake = createCommandInteraction({ guild: null });

        await handler(fake.interaction);

        expectError(fake, 'common.guildOnly');
        expect(notifyRemove).not.toHaveBeenCalled();
      });
    }
  );

  describe('handleStatus', () => {
    it('opens the panel on the settings view for managers', async () => {
      notificationChannelRepository.set(GUILD_ID, 'voice', 'vc-log');
      const fake = createCommandInteraction({ manageGuild: true });

      await handleStatus(fake.interaction);

      const { embed } = replyOf(fake);
      expect(embed.title).toBe(t('notification.status.title', 'en'));
      expect(embed.fields?.[0].value).toBe('<#vc-log>');
    });

    it('uses the invoking user locale when the guild has no language', async () => {
      const fake = createCommandInteraction({
        manageGuild: true,
        locale: 'ja',
      });

      await handleStatus(fake.interaction);

      expect(replyOf(fake).embed.title).toBe(
        t('notification.status.title', 'ja')
      );
    });
  });
});

describe('/notification command', () => {
  async function run(options: FakeCommandOptions) {
    const fake = createCommandInteraction(options);
    await command.execute(fake.interaction);
    return fake;
  }

  describe('definition', () => {
    const json = command.data.toJSON();
    const optionsByName = Object.fromEntries(
      (json.options ?? []).map((option) => [option.name, option])
    ) as Record<
      string,
      {
        options?: Array<{
          name: string;
          options?: Array<{
            name: string;
            required?: boolean;
            channel_types?: number[];
          }>;
        }>;
      }
    >;

    it('is a guild-only command with voice, welcome, status and stats', () => {
      expect(json.name).toBe('notification');
      expect(json.contexts).toEqual([0]);
      expect(Object.keys(optionsByName).sort()).toEqual([
        'stats',
        'status',
        'voice',
        'welcome',
      ]);
    });

    it.each(['voice', 'welcome'])(
      '%s has set (required text channel) and disable',
      (group) => {
        const subcommands = optionsByName[group].options ?? [];
        expect(subcommands.map((s) => s.name)).toEqual(['set', 'disable']);
        const [channelOption] = subcommands[0].options ?? [];
        expect(channelOption).toMatchObject({
          name: 'channel',
          name_localizations: { ja: 'チャンネル' },
          required: true,
          channel_types: [ChannelType.GuildText],
        });
      }
    );

    it('offers the four stats periods the panel understands', () => {
      const [period] = (optionsByName.stats.options ?? []) as Array<{
        name: string;
        name_localizations?: { ja?: string };
        description_localizations?: { ja?: string };
        choices?: Array<{
          value: string;
          name: string;
          name_localizations?: { ja?: string };
        }>;
      }>;
      expect(period.name).toBe('period');
      // Japanese clients see a Japanese chip, and learn the default.
      expect(period.name_localizations?.ja).toBe('期間');
      expect(period.description_localizations?.ja).toBe(
        '集計する期間（未指定なら全期間）'
      );
      expect(period.choices?.map((c) => c.value)).toEqual([
        'today',
        'week',
        'month',
        'all',
      ]);
      // The same labels as the panel's period menu: rolling windows, not
      // calendar weeks and months.
      expect(period.choices?.map((c) => c.name)).toEqual(
        (['today', 'week', 'month', 'all'] as const).map((p) =>
          t(`notification.stats.periods.${p}`, 'en')
        )
      );
      expect(period.choices?.map((c) => c.name_localizations?.ja)).toEqual(
        (['today', 'week', 'month', 'all'] as const).map((p) =>
          t(`notification.stats.periods.${p}`, 'ja')
        )
      );
    });

    it('documents which subcommands need Manage Server', () => {
      expect(command.help?.permission).toBe('everyone');
      expect(command.help?.subcommandPermissions).toEqual({
        'notification voice': 'manageGuild',
        'notification welcome': 'manageGuild',
        'notification status': 'manageGuild',
      });
    });
  });

  describe('permission gate', () => {
    it.each([
      ['voice', 'set'],
      ['voice', 'disable'],
      ['welcome', 'set'],
      ['welcome', 'disable'],
      [null, 'status'],
    ])(
      'denies %s %s to members without Manage Server',
      async (subcommandGroup, subcommand) => {
        notificationChannelRepository.set(GUILD_ID, 'voice', 'vc-log');
        notificationChannelRepository.set(GUILD_ID, 'member_join', 'welcome');

        const fake = await run({
          manageGuild: false,
          subcommandGroup,
          subcommand,
          guild: sendableGuild(),
          channel: textOption(),
        });

        expectPermissionDenied(fake);
        expect(
          notificationChannelRepository
            .getAllForGuild(GUILD_ID)
            .map((r) => r.channel_id)
            .sort()
        ).toEqual(['vc-log', 'welcome']);
        expect(fake.createMessageComponentCollector).not.toHaveBeenCalled();
      }
    );

    it('words the denial in the invoking user locale', async () => {
      const fake = await run({
        manageGuild: false,
        subcommandGroup: 'voice',
        subcommand: 'disable',
        locale: 'ja',
      });

      expectPermissionDenied(fake, 'ja');
    });

    it('lets anyone open their own stats', async () => {
      const fake = await run({
        manageGuild: false,
        subcommand: 'stats',
        period: 'today',
      });

      const { embed } = replyOf(fake);
      expect(embed.title).toBe(t('notification.stats.title', 'en'));
      expect(embed.fields?.at(-1)?.value).toBe(
        t('notification.stats.periods.today', 'en')
      );
    });

    it('defaults stats to all time when no period is given', async () => {
      const fake = await run({ manageGuild: false, subcommand: 'stats' });

      expect(replyOf(fake).embed.fields?.at(-1)?.value).toBe(
        t('notification.stats.periods.all', 'en')
      );
    });

    it('treats a DM as lacking Manage Server', async () => {
      const fake = await run({
        guild: null,
        subcommandGroup: 'welcome',
        subcommand: 'set',
        channel: textOption(),
      });

      expectPermissionDenied(fake);
    });

    it('still answers stats in a DM with a guild-only error', async () => {
      const fake = await run({ guild: null, subcommand: 'stats' });

      expectError(fake, 'common.guildOnly');
    });
  });

  describe('routing for managers', () => {
    it('voice set stores the VC notification channel', async () => {
      await run({
        manageGuild: true,
        subcommandGroup: 'voice',
        subcommand: 'set',
        guild: sendableGuild(),
        channel: textOption(),
      });

      expect(notificationChannelRepository.getEnabled(GUILD_ID, 'voice')).toBe(
        TARGET
      );
      expect(
        notificationChannelRepository.get(GUILD_ID, 'member_join')
      ).toBeNull();
    });

    it('welcome set stores the welcome channel', async () => {
      await run({
        manageGuild: true,
        subcommandGroup: 'welcome',
        subcommand: 'set',
        guild: sendableGuild(),
        channel: textOption(),
      });

      expect(
        notificationChannelRepository.getEnabled(GUILD_ID, 'member_join')
      ).toBe(TARGET);
      expect(notificationChannelRepository.get(GUILD_ID, 'voice')).toBeNull();
    });

    it('voice disable removes only the VC configuration', async () => {
      notificationChannelRepository.set(GUILD_ID, 'voice', 'vc-log');
      notificationChannelRepository.set(GUILD_ID, 'member_join', 'welcome');

      await run({
        manageGuild: true,
        subcommandGroup: 'voice',
        subcommand: 'disable',
      });

      expect(notificationChannelRepository.get(GUILD_ID, 'voice')).toBeNull();
      expect(
        notificationChannelRepository.getEnabled(GUILD_ID, 'member_join')
      ).toBe('welcome');
    });

    it('welcome disable removes only the welcome configuration', async () => {
      notificationChannelRepository.set(GUILD_ID, 'voice', 'vc-log');
      notificationChannelRepository.set(GUILD_ID, 'member_join', 'welcome');

      await run({
        manageGuild: true,
        subcommandGroup: 'welcome',
        subcommand: 'disable',
      });

      expect(
        notificationChannelRepository.get(GUILD_ID, 'member_join')
      ).toBeNull();
      expect(notificationChannelRepository.getEnabled(GUILD_ID, 'voice')).toBe(
        'vc-log'
      );
    });

    it('status opens the settings panel', async () => {
      const fake = await run({ manageGuild: true, subcommand: 'status' });

      expect(replyOf(fake).embed.title).toBe(
        t('notification.status.title', 'en')
      );
      expect(fake.createMessageComponentCollector).toHaveBeenCalledTimes(1);
    });

    it('stats opens the stats view even for managers', async () => {
      const fake = await run({
        manageGuild: true,
        subcommand: 'stats',
        period: 'month',
      });

      const { embed } = replyOf(fake);
      expect(embed.title).toBe(t('notification.stats.title', 'en'));
      expect(embed.fields?.at(-1)?.value).toBe(
        t('notification.stats.periods.month', 'en')
      );
    });

    it.each([
      ['voice', 'unknown'],
      ['welcome', 'unknown'],
      ['other', 'set'],
      [null, 'unknown'],
    ])(
      'does not reply to an unrecognised %s %s',
      async (subcommandGroup, subcommand) => {
        const fake = await run({
          manageGuild: true,
          subcommandGroup,
          subcommand,
        });

        expect(fake.reply).not.toHaveBeenCalled();
        expect(notificationChannelRepository.getAllForGuild(GUILD_ID)).toEqual(
          []
        );
      }
    );
  });
});
