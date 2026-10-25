import {
  ApplicationCommandOptionType,
  InteractionContextType,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type APIApplicationCommandSubcommandOption,
  type APIEmbed,
  type RESTPostAPIChatInputApplicationCommandsJSONBody,
} from 'discord.js';
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { executeGeneralCommand } from '../application/general.js';
import { command } from '../commands/general.js';
import { buildHelpCatalog } from '../../../shared/help/catalog.js';
import { t, type Locale } from '../../../locales/index.js';
import { loadConfig } from '../../../config/env.js';
import { COLORS } from '../../../shared/utils/constants/index.js';
import {
  clearCommandIds,
  setCommandIds,
} from '../../../shared/utils/commandMentions.js';
import { database } from '../../../infrastructure/database/connection.js';
import { initializeDatabase } from '../../../infrastructure/database/migrations/index.js';
import { guildSettingsRepository } from '../../../infrastructure/guildSettings/index.js';
import type { Command } from '../../../shared/types/index.js';
import {
  autocompleteInteraction,
  chatInteraction,
  embedAt,
  helpCommand,
  payloadAt,
  type ChatInteractionOptions,
} from './general.helpers.js';

/**
 * `/general` is the entry point: `help` and `ping` hand off to their own
 * modules (exercised for real, not mocked), `about` tells members what the
 * bot does, how it handles voice in their server, and why it answers in the
 * language it does. Guild settings live in a real in-memory database.
 */

vi.mock('../../../shared/utils/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
  getErrorMessage: (e: unknown) => String(e),
}));

vi.mock('../../../infrastructure/database/connection.js', async () => {
  const { default: Database } = await import('better-sqlite3');
  return {
    database: new Database(':memory:'),
    closeDatabase: vi.fn(),
    getTableCount: vi.fn(() => 0),
  };
});

const resolveLocale = vi.hoisted(() => vi.fn());
vi.mock('../../../locales/guildLocale.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../locales/guildLocale.js')>()),
  resolveLocale,
}));

// The real config, with audio settings that differ from the defaults so the
// about page provably reads them.
vi.mock('../../../config/env.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../config/env.js')>();
  actual.loadConfig({
    BOT_OWNER_IDS: 'owner-1',
    NODE_ENV: 'production',
    MAX_RECORDING_DURATION: '180',
    AUDIO_BUFFER_DURATION: '180',
    RECORDING_RETENTION_HOURS: '6',
  });
  return actual;
});

const NOW = new Date('2026-05-01T12:00:00Z').getTime();
const GUILD_ID = 'guild-1';

const json =
  command.data.toJSON() as RESTPostAPIChatInputApplicationCommandsJSONBody;
const subcommands = (json.options ??
  []) as APIApplicationCommandSubcommandOption[];

const DEMO = { en: 'Demo', ja: 'デモ' };

/** The commands the about page points at, as small stand-ins. */
const notification = helpCommand(
  new SlashCommandBuilder()
    .setName('notification')
    .setDescription('n')
    .addSubcommand((sub) =>
      sub
        .setName('stats')
        .setDescription('Your voice time')
        .setDescriptionLocalizations({ ja: 'VC滞在時間' })
    ),
  { category: DEMO }
);
const community = helpCommand(
  new SlashCommandBuilder()
    .setName('community')
    .setDescription('c')
    .setContexts(InteractionContextType.Guild)
    .addSubcommandGroup((group) =>
      group
        .setName('poll')
        .setDescription('Polls')
        .addSubcommand((sub) =>
          sub
            .setName('create')
            .setDescription('Start a poll')
            .setDescriptionLocalizations({ ja: '投票を作成' })
        )
    )
    .addSubcommandGroup((group) =>
      group
        .setName('roulette')
        .setDescription('Roulette')
        .addSubcommand((sub) =>
          sub
            .setName('team')
            .setDescription('Split into teams')
            .setDescriptionLocalizations({ ja: 'チーム分け' })
        )
    ),
  { category: DEMO }
);
const voice = helpCommand(
  new SlashCommandBuilder()
    .setName('voice')
    .setDescription('v')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((sub) => sub.setName('record').setDescription('Record')),
  { category: DEMO }
);
const tts = helpCommand(
  new SlashCommandBuilder()
    .setName('tts')
    .setDescription('t')
    .setContexts(InteractionContextType.Guild)
    .addSubcommand((sub) =>
      sub
        .setName('start')
        .setDescription('Read this channel aloud')
        .setDescriptionLocalizations({ ja: '読み上げを開始' })
    ),
  { category: DEMO }
);
const admin = helpCommand(
  new SlashCommandBuilder()
    .setName('admin')
    .setDescription('a')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommandGroup((group) =>
      group
        .setName('settings')
        .setDescription('s')
        .addSubcommand((sub) =>
          sub.setName('language').setDescription('Language')
        )
    ),
  { category: DEMO }
);

const FULL_BOT = [command, notification, community, voice, tts, admin];

async function runGeneral(options: ChatInteractionOptions) {
  const stub = chatInteraction({ commands: [command], ...options });
  await executeGeneralCommand(stub.interaction);
  return stub;
}

async function about(options: ChatInteractionOptions = {}): Promise<{
  embed: APIEmbed;
  flags: number | undefined;
}> {
  const { reply } = await runGeneral({
    subcommand: 'about',
    commands: FULL_BOT,
    ...options,
  });
  expect(reply).toHaveBeenCalledTimes(1);
  return { embed: embedAt(reply), flags: payloadAt(reply).flags };
}

function fieldValue(
  embed: APIEmbed,
  nameKey: Parameters<typeof t>[0],
  locale: Locale = 'en'
) {
  return embed.fields?.find((f) => f.name === t(nameKey, locale))?.value;
}

beforeAll(async () => {
  await initializeDatabase();
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.clearAllMocks();
  clearCommandIds();
  database.exec('DELETE FROM guild_settings');
  resolveLocale.mockReturnValue('en');
});

afterEach(() => {
  clearCommandIds();
  vi.useRealTimers();
});

describe('/general about', () => {
  it('tells members what the bot does and where to start, in the open', async () => {
    const { embed, flags } = await about();

    expect(resolveLocale).toHaveBeenCalled();
    expect(flags).toBeUndefined();
    expect(embed).toMatchObject({
      title: t('about.title', 'en'),
      description: t('about.description', 'en', { help: '`/general help`' }),
      color: COLORS.INFO,
    });
    expect(embed.fields?.map((f) => f.name)).toEqual([
      t('about.popularTitle', 'en'),
      t('about.voiceTitle', 'en'),
      t('about.languageTitle', 'en'),
    ]);
    // Nothing aimed at whoever hosts the bot.
    expect(JSON.stringify(embed)).not.toMatch(/production|NODE_ENV/);
  });

  it('lists the popular commands this build loaded and the asker may run', async () => {
    const { embed } = await about();

    expect(fieldValue(embed, 'about.popularTitle')).toBe(
      [
        '`/general help` - Browse commands and how to use them',
        '`/notification stats` - Your voice time',
        '`/community poll create` - Start a poll',
        '`/community roulette team` - Split into teams',
        '`/tts start` - Read this channel aloud',
      ].join('\n')
    );
  });

  it('makes the popular commands tappable once command ids are known', async () => {
    setCommandIds([
      { name: 'general', id: '10' },
      { name: 'community', id: '20' },
    ]);
    resolveLocale.mockReturnValue('ja');

    const { embed } = await about();

    const lines = fieldValue(embed, 'about.popularTitle', 'ja')?.split('\n');
    expect(lines?.[0]).toBe(
      '</general help:10> - コマンドの一覧と使い方を表示'
    );
    expect(lines?.[2]).toBe('</community poll create:20> - 投票を作成');
    expect(lines?.[1]).toBe('`/notification stats` - VC滞在時間');
  });

  it('leaves out server-only commands in the bot DM, where they cannot run', async () => {
    const { embed } = await about({ inGuild: false });

    expect(fieldValue(embed, 'about.popularTitle')).toBe(
      [
        '`/general help` - Browse commands and how to use them',
        '`/notification stats` - Your voice time',
      ].join('\n')
    );
  });

  it('leaves out commands that are not loaded or not visible to the asker', async () => {
    const restricted = helpCommand(
      new SlashCommandBuilder()
        .setName('notification')
        .setDescription('n')
        .addSubcommand((sub) => sub.setName('stats').setDescription('Stats')),
      { category: DEMO, permission: 'manageGuild' }
    );

    const { embed } = await about({ commands: [command, restricted] });

    expect(fieldValue(embed, 'about.popularTitle')).toBe(
      '`/general help` - Browse commands and how to use them'
    );
  });

  it('explains that audio is being kept, for how long, and how to stop it', async () => {
    const { embed } = await about();

    expect(fieldValue(embed, 'about.voiceTitle')).toBe(
      [
        t('about.voiceOn', 'en', {
          duration: '3 minutes',
          disable: '`/voice autojoin disable`',
        }),
        t('about.recordings', 'en', {
          record: '`/voice record`',
          retention: '6 hours',
        }),
      ].join('\n')
    );
  });

  it.each<[Locale, string]>([
    ['en', '1 minute 30 seconds'],
    ['ja', '1分30秒'],
  ])(
    'never rounds the kept audio down (90 seconds, %s)',
    async (locale, duration) => {
      const config = loadConfig() as { AUDIO_BUFFER_DURATION: number };
      const configured = config.AUDIO_BUFFER_DURATION;
      config.AUDIO_BUFFER_DURATION = 90;
      resolveLocale.mockReturnValue(locale);
      try {
        const { embed } = await about();

        expect(fieldValue(embed, 'about.voiceTitle', locale)).toContain(
          t('about.voiceOn', locale, {
            duration,
            disable: '`/voice autojoin disable`',
          })
        );
      } finally {
        config.AUDIO_BUFFER_DURATION = configured;
      }
    }
  );

  it('says no audio is kept once auto-join is off in this server', async () => {
    guildSettingsRepository.setVoiceAutoJoinEnabled(GUILD_ID, false);
    resolveLocale.mockReturnValue('ja');

    const { embed } = await about();

    expect(fieldValue(embed, 'about.voiceTitle', 'ja')).toBe(
      [
        t('about.voiceOff', 'ja', { enable: '`/voice autojoin enable`' }),
        t('about.recordings', 'ja', {
          record: '`/voice record`',
          retention: '6時間',
        }),
      ].join('\n')
    );
  });

  it('only describes voice in a server that has the voice command', async () => {
    const inDm = await about({ inGuild: false });
    const withoutVoice = await about({
      commands: FULL_BOT.filter((c) => c !== voice),
    });

    for (const { embed } of [inDm, withoutVoice]) {
      expect(fieldValue(embed, 'about.voiceTitle')).toBeUndefined();
    }
  });

  it('says the language follows each member when the server set none', async () => {
    const { embed } = await about();

    expect(fieldValue(embed, 'about.languageTitle')).toBe(
      [
        t('about.languageAuto', 'en', { language: 'English' }),
        t('about.languageChange', 'en', {
          command: '`/admin settings language`',
        }),
      ].join('\n')
    );
  });

  it('says the language was set for the server when it was', async () => {
    guildSettingsRepository.setLanguage(GUILD_ID, 'ja');
    resolveLocale.mockReturnValue('ja');

    const { embed } = await about();

    expect(fieldValue(embed, 'about.languageTitle', 'ja')).toBe(
      [
        t('about.languageGuild', 'ja', { language: '日本語' }),
        t('about.languageChange', 'ja', {
          command: '`/admin settings language`',
        }),
      ].join('\n')
    );
  });

  it('does not point at the server setting in DMs or without /admin', async () => {
    const inDm = await about({ inGuild: false });
    const withoutAdmin = await about({
      commands: FULL_BOT.filter((c) => c !== admin),
    });

    for (const { embed } of [inDm, withoutAdmin]) {
      expect(fieldValue(embed, 'about.languageTitle')).toBe(
        t('about.languageAuto', 'en', { language: 'English' })
      );
    }
  });

  it('localizes every label', async () => {
    const render = async (locale: Locale): Promise<APIEmbed> => {
      resolveLocale.mockReturnValue(locale);
      return (await about()).embed;
    };

    const en = await render('en');
    const ja = await render('ja');

    // The Japanese reply really is Japanese, not the English copy.
    for (const text of [
      ja.title,
      ja.description,
      ...(ja.fields ?? []).flatMap((f) => [f.name, f.value]),
    ]) {
      expect(text).toMatch(/[぀-ヿ一-鿿]/);
    }
    for (const text of [
      en.title,
      en.description,
      ...(en.fields ?? []).flatMap((f) => [f.name, f.value]),
    ]) {
      expect(text).not.toMatch(/[぀-ヿ一-鿿]/);
    }
  });
});

describe('/general routing', () => {
  it('hands help to the help overview', async () => {
    const { reply, deferReply } = await runGeneral({ subcommand: 'help' });

    expect(deferReply).not.toHaveBeenCalled();
    expect(embedAt(reply)).toMatchObject({
      title: t('help.title', 'en'),
      fields: [{ name: 'General' }],
    });
  });

  it('passes the command option through to help', async () => {
    const { reply } = await runGeneral({
      subcommand: 'help',
      commandOption: 'general ping',
    });

    expect(embedAt(reply).title).toBe('/general ping');
  });

  it('hands ping to the latency check', async () => {
    const { reply, deferReply, editReply } = await runGeneral({
      subcommand: 'ping',
      createdTimestamp: NOW,
      deferReply: vi.fn().mockResolvedValue({
        resource: { message: { createdTimestamp: NOW + 20 } },
      }),
      wsPing: 33,
    });

    expect(reply).not.toHaveBeenCalled();
    expect(deferReply).toHaveBeenCalledWith({ withResponse: true });
    expect(embedAt(editReply)).toMatchObject({
      title: t('ping.title', 'en'),
      fields: [{ value: '20ms' }, { value: '33ms' }],
    });
  });

  it('hands about to the about page', async () => {
    const { reply } = await runGeneral({ subcommand: 'about' });

    expect(embedAt(reply).title).toBe(t('about.title', 'en'));
  });

  it('does nothing for an unknown subcommand', async () => {
    const { reply, deferReply, editReply } = await runGeneral({
      subcommand: 'unknown',
    });

    expect(reply).not.toHaveBeenCalled();
    expect(deferReply).not.toHaveBeenCalled();
    expect(editReply).not.toHaveBeenCalled();
  });
});

describe('/general command definition', () => {
  it('registers help, ping and about as subcommands', () => {
    expect(json.name).toBe('general');
    expect(json.description_localizations?.ja).toBeTruthy();
    expect(subcommands.map((s) => [s.name, s.type])).toEqual([
      ['help', ApplicationCommandOptionType.Subcommand],
      ['ping', ApplicationCommandOptionType.Subcommand],
      ['about', ApplicationCommandOptionType.Subcommand],
    ]);
    for (const sub of subcommands) {
      expect(sub.description_localizations?.ja, sub.name).toBeTruthy();
    }
  });

  it('gives help an optional, autocompleted command option and an optional public flag', () => {
    const help = subcommands.find((s) => s.name === 'help');

    expect(help?.options).toEqual([
      expect.objectContaining({
        name: 'command',
        name_localizations: { ja: 'コマンド' },
        type: ApplicationCommandOptionType.String,
        autocomplete: true,
        // Discord refuses anything longer, which bounds the search a
        // query costs (a miss frees the cooldown, so it can repeat).
        max_length: 100,
      }),
      expect.objectContaining({
        name: 'public',
        name_localizations: { ja: 'みんなに表示' },
        type: ApplicationCommandOptionType.Boolean,
      }),
    ]);
    for (const option of help?.options ?? []) {
      expect(option.required ?? false, option.name).toBe(false);
      expect(option.description_localizations?.ja, option.name).toBeTruthy();
    }
  });

  it('runs behind a 3 second cooldown', () => {
    expect(command.middleware).toEqual(['cooldown']);
    expect(command.options?.cooldown).toBe(3000);
    expect(command.options?.permissions).toBeUndefined();
  });

  it('lists every subcommand in help, open to everyone, with its options', () => {
    const [category] = buildHelpCatalog([command]);

    expect(category.name).toEqual({ en: 'General', ja: '一般' });
    expect(category.commands).toMatchObject(
      subcommands.map((sub) => ({
        name: `general ${sub.name}`,
        description: {
          en: sub.description,
          ja: sub.description_localizations?.ja,
        },
        usage: `/general ${sub.name}`,
        requiredPermission: 'everyone',
        leaves: [
          {
            path: `general ${sub.name}`,
            options: (sub.options ?? []).map((option) => ({
              name: { en: option.name, ja: option.name_localizations?.ja },
            })),
          },
        ],
      }))
    );
  });

  it('shows examples on the help entry in both languages', () => {
    const [category] = buildHelpCatalog([command]);
    const helpEntry = category.commands.find((c) => c.name === 'general help');
    const examples = helpEntry?.leaves?.[0].examples ?? [];

    expect(examples.length).toBeGreaterThan(0);
    for (const example of examples) {
      expect(example.en).toMatch(/^`\/general help /);
      expect(example.ja).toMatch(/^`\/general help /);
    }
  });

  it('executes through the application layer', async () => {
    const { interaction, reply } = chatInteraction({
      subcommand: 'about',
      commands: [command],
    });

    await command.execute(interaction);

    expect(embedAt(reply).title).toBe(t('about.title', 'en'));
  });

  it('autocompletes help with the loaded commands', async () => {
    const { interaction, respond } = autocompleteInteraction({
      commands: [command] as Command[],
      focused: 'general p',
    });

    await command.autocomplete?.(interaction);

    const ping = subcommands.find((s) => s.name === 'ping');
    expect(respond).toHaveBeenCalledWith([
      { name: `general ping - ${ping?.description}`, value: 'general ping' },
    ]);
  });
});
