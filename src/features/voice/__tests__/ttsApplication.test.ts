import {
  type AutocompleteInteraction,
  ChannelType,
  type ChatInputCommandInteraction,
  Collection,
  type EmbedBuilder,
  type Message,
  MessageFlags,
  PermissionFlagsBits,
} from 'discord.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const connectionManager = vi.hoisted(() => ({
  getAllConnections: vi.fn(),
  getConnection: vi.fn(),
  connect: vi.fn(),
  disconnect: vi.fn(),
  waitUntilReady: vi.fn(),
  enableReceive: vi.fn(),
}));

vi.mock('../recording/connectionManager.js', () => ({ connectionManager }));

const ttsSessions = vi.hoisted(() => ({
  start: vi.fn(),
  stop: vi.fn(),
  skip: vi.fn(),
  getForGuild: vi.fn(),
  findForTextChannel: vi.fn(),
  enqueue: vi.fn(),
  warmUp: vi.fn(),
  creditCharacter: vi.fn(),
}));

vi.mock('../tts/sessionManager.js', () => ({ ttsSessions }));

const ttsRepository = vi.hoisted(() => ({
  clearCache: vi.fn(),
  compiledDictionary: vi.fn(),
  countDictionary: vi.fn(),
  forgetGuild: vi.fn(),
  getDictionaryEntry: vi.fn(),
  getUserSettings: vi.fn(),
  listDictionary: vi.fn(),
  removeDictionaryEntry: vi.fn(),
  setUserSettings: vi.fn(),
  upsertDictionaryEntry: vi.fn(),
}));

vi.mock('../repositories/ttsRepository.js', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('../repositories/ttsRepository.js')
  >()),
  ttsRepository,
}));

const mayAutoJoin = vi.hoisted(() => vi.fn());

vi.mock('../repositories/voiceSettingsRepository.js', () => ({
  voiceSettingsRepository: { mayAutoJoin },
}));

const getVoicevoxClient = vi.hoisted(() => vi.fn());

vi.mock('../tts/voicevoxClient.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../tts/voicevoxClient.js')>()),
  getVoicevoxClient,
}));

const announceBuffering = vi.hoisted(() => vi.fn());

vi.mock('../application/announce.js', () => ({ announceBuffering }));

const resolveLocale = vi.hoisted(() =>
  vi.fn((interaction: { locale: string }) =>
    interaction.locale === 'ja' ? 'ja' : 'en'
  )
);

vi.mock('../../../locales/guildLocale.js', () => ({
  resolveLocale,
  // The server's language, for posts no interaction asked for.
  resolveBackgroundLocale: (guild: { preferredLocale: string }) =>
    guild.preferredLocale.startsWith('ja') ? 'ja' : 'en',
}));

const {
  AUTOCOMPLETE_WAIT_MS,
  autocompleteTts,
  executeTtsCommand,
  handleTtsMessage,
  warmUpTts,
} = await import('../application/tts.js');
const { applyDictionary, compileDictionary, dictionaryKey } =
  await import('../tts/textNormalizer.js');
const { commandMention, clearCommandIds, setCommandIds } =
  await import('../../../shared/utils/commandMentions.js');
const { formatPermissionNames } =
  await import('../../../shared/utils/discord.js');
const { cooldownMiddleware, cooldownStore } =
  await import('../../../middleware/cooldown/index.js');
const { command: ttsCommand } = await import('../commands/tts.js');
const { MAX_DICTIONARY_ENTRIES } =
  await import('../repositories/ttsRepository.js');
const { t } = await import('../../../locales/index.js');
const { COLORS } = await import('../../../shared/utils/constants/index.js');

type Locale = 'en' | 'ja';

const GUILD = 'guild-1';
const VC = 'vc-1';
const TEXT = 'text-1';
const USER = 'user-1';

const VOICES = [
  { id: 3, character: 'ずんだもん', style: 'ノーマル' },
  { id: 1, character: 'ずんだもん', style: 'あまあま' },
  { id: 2, character: '四国めたん', style: 'ノーマル' },
];

function fakeClient() {
  return {
    isAvailable: vi.fn().mockResolvedValue(true),
    listVoices: vi.fn().mockResolvedValue(VOICES),
    peekVoices: vi.fn(() => null as typeof VOICES | null),
  };
}

const MANAGE_SERVER = (locale: Locale) =>
  formatPermissionNames(PermissionFlagsBits.ManageGuild, locale);

/** The connection `connect` hands back, and `waitUntilReady` once ready. */
const JOINED = { kind: 'connection' };

let client: ReturnType<typeof fakeClient>;

/** Characters the session has credited; the default one from the start. */
let credited: Set<string>;

/** A guild whose caches resolve the mentions used in these tests. */
function fakeGuild(me: object | null = { id: 'bot' }) {
  return {
    id: GUILD,
    preferredLocale: 'en-US',
    members: {
      me,
      cache: new Collection<string, { displayName: string }>([
        ['111', { displayName: 'はなこ' }],
      ]),
    },
    roles: {
      cache: new Collection<string, { name: string }>([
        ['222', { name: '管理者' }],
      ]),
    },
    channels: {
      cache: new Collection<string, { name: string }>([
        ['333', { name: '雑談' }],
      ]),
    },
    client: {
      users: {
        cache: new Collection<string, { displayName: string }>([
          ['444', { displayName: 'よそのひと' }],
        ]),
      },
    },
  };
}

interface CommandOptions {
  subcommand?: string;
  group?: string | null;
  options?: Record<string, string | number | null>;
  locale?: string;
  inGuild?: boolean;
  /** The caller's voice channel id; null when not in voice. */
  voice?: string | null;
  manager?: boolean;
  me?: object | null;
  /** Permissions the bot holds in the caller's voice channel; null = none resolvable. */
  botPermissions?: bigint[] | null;
  userId?: string;
  displayName?: string;
  /** The caller's voice channel is a Stage. */
  stage?: boolean;
  /** Who is in the caller's voice channel; defaults to the caller alone. */
  members?: Array<{ id: string; bot?: boolean }>;
  /** The bot's permissions in the channel the command was used in. */
  appPermissions?: bigint[];
  /** The channel the command was used in. */
  channelId?: string;
}

/** A channel the bot can post in, as the guild cache returns it. */
function sendableChannel(id: string) {
  return {
    id,
    isSendable: () => true,
    send: vi.fn(async (_payload: { embeds: EmbedBuilder[] }) => undefined),
  };
}

function command(opts: CommandOptions = {}) {
  const voiceId = opts.voice === undefined ? VC : opts.voice;
  const botPermissions =
    opts.botPermissions === undefined
      ? [PermissionFlagsBits.Connect, PermissionFlagsBits.Speak]
      : opts.botPermissions;
  const userId = opts.userId ?? USER;
  const members = opts.members ?? [{ id: userId }];
  const voiceChannel = voiceId
    ? {
        ...sendableChannel(voiceId),
        type: opts.stage ? ChannelType.GuildStageVoice : ChannelType.GuildVoice,
        isVoiceBased: () => true,
        members: new Collection(
          members.map(
            (m) => [m.id, { id: m.id, user: { bot: m.bot ?? false } }] as const
          )
        ),
        permissionsFor: vi.fn(() =>
          botPermissions === null
            ? null
            : { has: (flag: bigint) => botPermissions.includes(flag) }
        ),
      }
    : null;
  const guild = fakeGuild(opts.me === undefined ? { id: 'bot' } : opts.me);
  const textChannel = sendableChannel(TEXT);
  const channels = guild.channels.cache as Collection<string, unknown>;
  channels.set(TEXT, textChannel);
  if (voiceChannel) channels.set(voiceChannel.id, voiceChannel);
  const values = opts.options ?? {};
  const appPermissions = opts.appPermissions ?? [
    PermissionFlagsBits.ViewChannel,
  ];

  const interaction = {
    commandName: 'tts',
    locale: opts.locale ?? 'en-US',
    guildId: GUILD,
    channelId: opts.channelId ?? TEXT,
    guild,
    appPermissions: {
      has: (flag: bigint) => appPermissions.includes(flag),
    },
    user: { id: userId },
    member: {
      displayName: opts.displayName ?? 'たろう',
      voice: { channel: voiceChannel, channelId: voiceId },
    },
    memberPermissions: {
      has: vi.fn(
        (flag: bigint) =>
          opts.manager === true && flag === PermissionFlagsBits.ManageGuild
      ),
    },
    inCachedGuild: () => opts.inGuild !== false,
    options: {
      getSubcommandGroup: vi.fn(() => opts.group ?? null),
      getSubcommand: vi.fn(() => opts.subcommand ?? 'start'),
      getString: vi.fn((name: string) => values[name] ?? null),
      getInteger: vi.fn((name: string) => values[name] ?? null),
      getNumber: vi.fn((name: string) => values[name] ?? null),
    },
    deferred: false,
    replied: false,
    reply: vi.fn(async () => {
      interaction.replied = true;
    }),
    deferReply: vi.fn(async () => {
      interaction.deferred = true;
    }),
    editReply: vi.fn(async () => undefined),
  };

  return {
    interaction,
    voiceChannel,
    textChannel,
    guild,
    run: () =>
      executeTtsCommand(interaction as unknown as ChatInputCommandInteraction),
  };
}

type FakeCommand = ReturnType<typeof command>['interaction'];

interface Payload {
  embeds?: EmbedBuilder[];
  content?: string;
  flags?: number;
}

function payloads(mock: unknown): Payload[] {
  return vi
    .mocked(mock as (p?: Payload) => unknown)
    .mock.calls.map(([p]) => p ?? {});
}

function replied(interaction: FakeCommand): Payload {
  expect(interaction.reply).toHaveBeenCalledTimes(1);
  return payloads(interaction.reply)[0];
}

function edited(interaction: FakeCommand): Payload {
  const all = payloads(interaction.editReply);
  expect(all.length).toBeGreaterThan(0);
  return all[all.length - 1];
}

const embedOf = (payload: Payload) => payload.embeds![0].toJSON();

/**
 * A reply in place of the result: ephemeral before deferring, an edit
 * after. Errors are ours; warnings and notes are refusals the member can act
 * on, so they are not shown in red.
 */
function expectError(
  interaction: FakeCommand,
  title: string,
  description: string,
  {
    deferred = false,
    color = COLORS.ERROR,
  }: { deferred?: boolean; color?: unknown } = {}
) {
  let payload: Payload;
  if (deferred) {
    expect(interaction.reply).not.toHaveBeenCalled();
    payload = edited(interaction);
  } else {
    expect(interaction.editReply).not.toHaveBeenCalled();
    payload = replied(interaction);
    expect(payload.flags).toBe(MessageFlags.Ephemeral);
  }
  const embed = embedOf(payload);
  expect(embed.title).toBe(title);
  expect(embed.description).toBe(description);
  expect(embed.color).toBe(color);
}

const WARNING = { color: COLORS.WARNING };
const INFO = { color: COLORS.INFO };

beforeEach(() => {
  vi.clearAllMocks();
  client = fakeClient();
  getVoicevoxClient.mockReturnValue(client);
  connectionManager.getAllConnections.mockReturnValue(new Map());
  connectionManager.getConnection.mockReturnValue(undefined);
  connectionManager.connect.mockResolvedValue(JOINED);
  connectionManager.disconnect.mockResolvedValue(undefined);
  connectionManager.waitUntilReady.mockResolvedValue(JOINED);
  connectionManager.enableReceive.mockReturnValue(true);
  mayAutoJoin.mockReturnValue(true);
  announceBuffering.mockResolvedValue(undefined);
  ttsSessions.getForGuild.mockReturnValue(undefined);
  ttsSessions.findForTextChannel.mockReturnValue(undefined);
  ttsSessions.skip.mockReturnValue(false);
  ttsSessions.stop.mockReturnValue(true);
  ttsSessions.enqueue.mockReturnValue(true);
  credited = new Set(['ずんだもん']);
  ttsSessions.creditCharacter.mockImplementation(
    (_voiceChannelId: string, character: string) => {
      if (credited.has(character)) return false;
      credited.add(character);
      return true;
    }
  );
  ttsRepository.getUserSettings.mockReturnValue(null);
  ttsRepository.listDictionary.mockReturnValue([]);
  ttsRepository.compiledDictionary.mockImplementation((guildId: string) =>
    compileDictionary(ttsRepository.listDictionary(guildId))
  );
  ttsRepository.getDictionaryEntry.mockReturnValue(null);
  ttsRepository.countDictionary.mockReturnValue(0);
  ttsRepository.upsertDictionaryEntry.mockReturnValue(true);
  ttsRepository.removeDictionaryEntry.mockReturnValue(true);
});

describe('executeTtsCommand', () => {
  it('refuses outside a server', async () => {
    const { interaction, run } = command({ inGuild: false });
    await run();
    expectError(
      interaction,
      t('common.error', 'en'),
      t('common.guildOnly', 'en')
    );
  });

  it('answers in the resolved locale', async () => {
    const { interaction, run } = command({ inGuild: false, locale: 'ja' });
    await run();
    expect(resolveLocale).toHaveBeenCalledWith(interaction);
    expectError(
      interaction,
      t('common.error', 'ja'),
      t('common.guildOnly', 'ja')
    );
  });
});

describe('/tts start', () => {
  const start = (opts: CommandOptions = {}) =>
    command({ subcommand: 'start', ...opts });

  it('explains when no engine is configured', async () => {
    getVoicevoxClient.mockReturnValue(null);
    const { interaction, run } = start();

    await run();

    expectError(
      interaction,
      t('tts.errors.notConfigured', 'en'),
      t('tts.errors.notConfiguredDesc', 'en')
    );
    expect(interaction.deferReply).not.toHaveBeenCalled();
  });

  it('requires the caller to be in a voice channel', async () => {
    const { interaction, run } = start({ voice: null });

    await run();

    expectError(
      interaction,
      t('tts.errors.notInVoice', 'en'),
      t('tts.errors.notInVoiceDesc', 'en', {
        command: commandMention('tts start'),
      }),
      WARNING
    );
    expect(connectionManager.connect).not.toHaveBeenCalled();
  });

  it.each<Locale>(['en', 'ja'])(
    'refuses a Stage channel up front, where it could not be heard (%s)',
    async (locale) => {
      const { interaction, run } = start({ stage: true, locale });

      await run();

      expectError(
        interaction,
        t('tts.errors.stageUnsupported', locale),
        t('tts.errors.stageUnsupportedDesc', locale),
        WARNING
      );
      expect(interaction.deferReply).not.toHaveBeenCalled();
      expect(connectionManager.connect).not.toHaveBeenCalled();
      expect(ttsSessions.start).not.toHaveBeenCalled();
    }
  );

  it('refuses while the bot is in another voice channel of this server', async () => {
    connectionManager.getAllConnections.mockReturnValue(
      new Map([
        ['vc-elsewhere', { guildId: 'guild-2', channelId: 'vc-elsewhere' }],
        ['vc-busy', { guildId: GUILD, channelId: 'vc-busy' }],
      ])
    );
    const { interaction, run } = start();

    await run();

    expectError(
      interaction,
      t('tts.errors.busyElsewhere', 'en'),
      t('tts.errors.busyElsewhereDesc', 'en', { channel: 'vc-busy' }),
      WARNING
    );
    expect(interaction.deferReply).not.toHaveBeenCalled();
    expect(connectionManager.connect).not.toHaveBeenCalled();
    expect(ttsSessions.start).not.toHaveBeenCalled();
  });

  it('ignores connections in other servers', async () => {
    connectionManager.getAllConnections.mockReturnValue(
      new Map([['vc-x', { guildId: 'guild-2', channelId: 'vc-x' }]])
    );
    const { run } = start();
    await run();
    expect(ttsSessions.start).toHaveBeenCalled();
  });

  it('reports a down engine after deferring, without joining', async () => {
    client.isAvailable.mockResolvedValue(false);
    const { interaction, run } = start();

    await run();

    expect(interaction.deferReply).toHaveBeenCalledWith();
    expectError(
      interaction,
      t('tts.errors.engineDown', 'en'),
      t('tts.errors.engineDownDesc', 'en'),
      { deferred: true }
    );
    expect(connectionManager.connect).not.toHaveBeenCalled();
  });

  it('reports a failed join', async () => {
    connectionManager.connect.mockResolvedValue(null);
    const { interaction, run } = start();

    await run();

    expectError(
      interaction,
      t('tts.errors.cannotJoin', 'en'),
      t('tts.errors.cannotJoinDesc', 'en'),
      { deferred: true }
    );
    expect(announceBuffering).not.toHaveBeenCalled();
    expect(connectionManager.waitUntilReady).not.toHaveBeenCalled();
    expect(ttsSessions.start).not.toHaveBeenCalled();
  });

  it('reports a connection that never becomes ready', async () => {
    connectionManager.waitUntilReady.mockResolvedValue(null);
    const { interaction, run } = start();

    await run();

    expect(connectionManager.waitUntilReady).toHaveBeenCalledWith(VC, 15_000);
    expectError(
      interaction,
      t('tts.errors.cannotJoin', 'en'),
      t('tts.errors.cannotJoinDesc', 'en'),
      { deferred: true }
    );
    expect(ttsSessions.start).not.toHaveBeenCalled();
    // The join was made for this session; leaving it would strand the bot.
    // Only that join, though: a replacement made meanwhile is not removed.
    expect(connectionManager.disconnect).toHaveBeenCalledTimes(1);
    expect(connectionManager.disconnect).toHaveBeenCalledWith(VC, JOINED);
  });

  it('joins listening and announces buffering where auto-join is allowed', async () => {
    mayAutoJoin.mockReturnValue(true);
    const { voiceChannel, guild, run } = start();

    await run();

    expect(mayAutoJoin).toHaveBeenCalledWith(GUILD, VC);
    expect(connectionManager.connect).toHaveBeenCalledWith(
      guild,
      voiceChannel,
      { receive: true }
    );
    expect(announceBuffering).toHaveBeenCalledWith(voiceChannel);
  });

  it('joins without listening, and without announcing, where auto-join is off', async () => {
    mayAutoJoin.mockReturnValue(false);
    const { voiceChannel, guild, run } = start();

    await run();

    expect(connectionManager.connect).toHaveBeenCalledWith(
      guild,
      voiceChannel,
      { receive: false }
    );
    expect(announceBuffering).not.toHaveBeenCalled();
    expect(ttsSessions.start).toHaveBeenCalled();
  });

  it('reuses an existing connection to the same channel', async () => {
    connectionManager.getAllConnections.mockReturnValue(
      new Map([[VC, { guildId: GUILD, channelId: VC }]])
    );
    connectionManager.getConnection.mockReturnValue({
      guildId: GUILD,
      channelId: VC,
      receiving: true,
    });
    const { run } = start();

    await run();

    expect(connectionManager.connect).not.toHaveBeenCalled();
    expect(mayAutoJoin).not.toHaveBeenCalled();
    expect(announceBuffering).not.toHaveBeenCalled();
    expect(connectionManager.waitUntilReady).toHaveBeenCalledWith(VC, 15_000);
    expect(ttsSessions.start).toHaveBeenCalled();
  });

  it('leaves an existing connection alone when it is not ready in time', async () => {
    connectionManager.getConnection.mockReturnValue({
      guildId: GUILD,
      channelId: VC,
      receiving: true,
    });
    connectionManager.waitUntilReady.mockResolvedValue(null);
    const { interaction, run } = start();

    await run();

    expectError(
      interaction,
      t('tts.errors.cannotJoin', 'en'),
      t('tts.errors.cannotJoinDesc', 'en'),
      { deferred: true }
    );
    // Auto-join owns that connection; reading must not tear it down.
    expect(connectionManager.disconnect).not.toHaveBeenCalled();
    expect(ttsSessions.start).not.toHaveBeenCalled();
  });

  it('starts the session, credits the voice and explains how it works', async () => {
    const { interaction, run } = start();

    await run();

    expect(ttsSessions.start).toHaveBeenCalledWith({
      guildId: GUILD,
      voiceChannelId: VC,
      textChannelId: TEXT,
      startedBy: USER,
      // What the footer names, so it is not posted again on first use.
      creditedCharacters: new Set(['ずんだもん']),
    });
    // Fetched right after deferring, alongside the health check and join.
    expect(client.listVoices.mock.invocationCallOrder[0]).toBeLessThan(
      client.isAvailable.mock.invocationCallOrder[0]
    );
    expect(interaction.reply).not.toHaveBeenCalled();

    const embed = embedOf(edited(interaction));
    expect(embed.title).toBe(t('tts.started', 'en'));
    expect(embed.description).toBe(t('tts.startedDesc', 'en', { voice: VC }));
    expect(embed.color).toBe(COLORS.SUCCESS);
    expect(embed.fields).toEqual([
      {
        name: t('tts.howToTitle', 'en'),
        value: t('tts.howTo', 'en', {
          voice: VC,
          voiceCommand: commandMention('tts voice'),
          dictCommand: commandMention('tts dict add'),
          skipCommand: commandMention('tts skip'),
          stopCommand: commandMention('tts stop'),
        }),
      },
    ]);
    // Public, and naming the character as VOICEVOX's terms require.
    expect(embed.footer?.text).toBe(
      t('tts.credit', 'en', { credits: 'VOICEVOX:ずんだもん' })
    );
  });

  it('links the commands it mentions once their ids are known', async () => {
    setCommandIds([{ name: 'tts', id: '42' }]);
    try {
      const { interaction, run } = start();

      await run();

      const howTo = embedOf(edited(interaction)).fields![0].value;
      expect(howTo).toContain('</tts voice:42>');
      expect(howTo).toContain('</tts dict add:42>');
      expect(howTo).toContain('</tts skip:42>');
      expect(howTo).toContain('</tts stop:42>');
    } finally {
      clearCommandIds();
    }
  });

  it('loads the voices of everyone in the channel without waiting for the engine', async () => {
    ttsRepository.getUserSettings.mockImplementation((id: string) =>
      id === 'friend' ? { speakerId: 14, speed: 1 } : null
    );
    let warmed: number[] = [];
    ttsSessions.warmUp.mockImplementation((ids: number[]) => {
      warmed = [...ids];
    });
    const { interaction, run } = start({
      members: [{ id: USER }, { id: 'friend' }, { id: 'music-bot', bot: true }],
    });

    await run();

    // The default voice, plus every member's own; bots are never read.
    expect(warmed.sort((a, b) => a - b)).toEqual([3, 14]);
    expect(ttsRepository.getUserSettings).not.toHaveBeenCalledWith('music-bot');
    expect(embedOf(edited(interaction)).title).toBe(t('tts.started', 'en'));
  });

  it('does not fail when warming the voice list fails', async () => {
    client.listVoices.mockRejectedValue(new Error('engine hiccup'));
    const { interaction, run } = start();

    await run();
    await Promise.resolve();

    expect(embedOf(edited(interaction)).title).toBe(t('tts.started', 'en'));
  });

  describe('voice credits', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    const footer = (interaction: FakeCommand) =>
      embedOf(edited(interaction)).footer?.text;

    it.each<[Locale, string]>([
      ['en', 'VOICEVOX:ずんだもん and VOICEVOX:四国めたん'],
      ['ja', 'VOICEVOX:ずんだもん、VOICEVOX:四国めたん'],
    ])(
      'names every character in use by the people in the channel (%s)',
      async (locale, credits) => {
        ttsRepository.getUserSettings.mockImplementation((id: string) =>
          id === 'metan-fan'
            ? { speakerId: 2, speed: 1 }
            : id === 'amaama-fan'
              ? { speakerId: 1, speed: 1 }
              : null
        );
        const { interaction, run } = start({
          locale,
          members: [
            { id: USER },
            { id: 'metan-fan' },
            // Another ずんだもん style: credited once.
            { id: 'amaama-fan' },
            // Bots are not read, so their settings do not count.
            { id: 'some-bot', bot: true },
          ],
        });

        await run();

        expect(footer(interaction)).toBe(t('tts.credit', locale, { credits }));
        expect(ttsSessions.start).toHaveBeenCalledWith(
          expect.objectContaining({
            creditedCharacters: new Set(['ずんだもん', '四国めたん']),
          })
        );
        expect(ttsRepository.getUserSettings).not.toHaveBeenCalledWith(
          'some-bot'
        );
      }
    );

    it('uses a voice list that only arrives while the bot is joining', async () => {
      ttsRepository.getUserSettings.mockReturnValue({ speakerId: 2, speed: 1 });
      // One request shared by every caller, as the real client does.
      let answer!: (voices: typeof VOICES) => void;
      const list = new Promise<typeof VOICES>((resolve) => {
        answer = resolve;
      });
      client.listVoices.mockReturnValue(list);
      connectionManager.waitUntilReady.mockImplementation(async () => {
        answer(VOICES);
        return JOINED;
      });
      const { interaction, run } = start();

      await run();

      expect(footer(interaction)).toBe(
        t('tts.credit', 'en', {
          credits: 'VOICEVOX:ずんだもん and VOICEVOX:四国めたん',
        })
      );
    });

    it('credits only the default voice when the list fails, leaving the rest to first use', async () => {
      ttsRepository.getUserSettings.mockReturnValue({ speakerId: 2, speed: 1 });
      client.listVoices.mockRejectedValue(new Error('engine hiccup'));
      const { interaction, run } = start();

      await run();

      expect(embedOf(edited(interaction)).title).toBe(t('tts.started', 'en'));
      expect(footer(interaction)).toBe(
        t('tts.credit', 'en', { credits: 'VOICEVOX:ずんだもん' })
      );
      // 四国めたん was not named, so the session still owes its credit.
      expect(ttsSessions.start).toHaveBeenCalledWith(
        expect.objectContaining({
          creditedCharacters: new Set(['ずんだもん']),
        })
      );
    });

    it('uses the cached voice list without waiting on the engine', async () => {
      ttsRepository.getUserSettings.mockReturnValue({ speakerId: 2, speed: 1 });
      client.peekVoices.mockReturnValue(VOICES);
      client.listVoices.mockReturnValue(new Promise(() => undefined));
      const { interaction, run } = start();

      await run();

      expect(footer(interaction)).toBe(
        t('tts.credit', 'en', {
          credits: 'VOICEVOX:ずんだもん and VOICEVOX:四国めたん',
        })
      );
    });

    it('stops waiting on a slow engine two seconds after joining', async () => {
      vi.useFakeTimers();
      ttsRepository.getUserSettings.mockReturnValue({ speakerId: 2, speed: 1 });
      client.listVoices.mockReturnValue(new Promise(() => undefined));
      const { interaction, run } = start();

      const running = run();
      await vi.advanceTimersByTimeAsync(1_999);
      expect(interaction.editReply).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await running;

      expect(footer(interaction)).toBe(
        t('tts.credit', 'en', { credits: 'VOICEVOX:ずんだもん' })
      );
      expect(ttsSessions.start).toHaveBeenCalledWith(
        expect.objectContaining({
          creditedCharacters: new Set(['ずんだもん']),
        })
      );
    });
  });

  describe('when the bot cannot view the channel the command was used in', () => {
    it('reads only the voice chat and says why', async () => {
      const { interaction, run } = start({ appPermissions: [] });

      await run();

      // Discord would never deliver this channel's messages.
      expect(ttsSessions.start).toHaveBeenCalledWith(
        expect.objectContaining({ voiceChannelId: VC, textChannelId: VC })
      );
      expect(embedOf(edited(interaction)).description).toBe(
        `${t('tts.startedDescVoiceOnly', 'en', { voice: VC })}\n\n${t('tts.noViewPermission', 'en')}`
      );
    });

    it('does not warn when the command was used in the voice chat itself', async () => {
      const { interaction, run } = start({ appPermissions: [], channelId: VC });

      await run();

      expect(ttsSessions.start).toHaveBeenCalledWith(
        expect.objectContaining({ textChannelId: VC })
      );
      expect(embedOf(edited(interaction)).description).toBe(
        t('tts.startedDesc', 'en', { voice: VC })
      );
    });

    it('also warns about Speak when both are missing', async () => {
      const { interaction, run } = start({
        appPermissions: [],
        botPermissions: [PermissionFlagsBits.Connect],
        locale: 'ja',
      });

      await run();

      expect(embedOf(edited(interaction)).description).toBe(
        [
          t('tts.startedDescVoiceOnly', 'ja', { voice: VC }),
          t('tts.noViewPermission', 'ja'),
          t('tts.noSpeakPermission', 'ja', { voice: VC }),
        ].join('\n\n')
      );
    });
  });

  it.each<[string, CommandOptions]>([
    ['the bot lacks Speak', { botPermissions: [PermissionFlagsBits.Connect] }],
    ['permissions cannot be resolved', { botPermissions: null }],
    ['the bot member is not cached', { me: null }],
  ])('warns that it may not be heard when %s', async (_label, opts) => {
    const { interaction, run } = start(opts);

    await run();

    expect(embedOf(edited(interaction)).description).toBe(
      `${t('tts.startedDesc', 'en', { voice: VC })}\n\n${t('tts.noSpeakPermission', 'en', { voice: VC })}`
    );
    expect(ttsSessions.start).toHaveBeenCalled();
  });

  it('speaks Japanese to a Japanese server', async () => {
    const { interaction, run } = start({ locale: 'ja' });

    await run();

    const embed = embedOf(edited(interaction));
    expect(embed.title).toBe(t('tts.started', 'ja'));
    expect(embed.footer?.text).toBe(
      t('tts.credit', 'ja', { credits: 'VOICEVOX:ずんだもん' })
    );
  });
});

describe.each(['stop', 'skip'])('/tts %s access control', (subcommand) => {
  it('says nothing is being read when there is no session', async () => {
    const { interaction, run } = command({ subcommand });

    await run();

    expectError(
      interaction,
      t('tts.errors.notRunning', 'en'),
      t('tts.errors.notRunningDesc', 'en', {
        command: commandMention('tts start'),
      }),
      INFO
    );
    expect(ttsSessions.stop).not.toHaveBeenCalled();
    expect(ttsSessions.skip).not.toHaveBeenCalled();
  });

  it.each<[string, string | null]>([
    ['another voice channel', 'vc-other'],
    ['no voice channel', null],
  ])('refuses a member in %s without Manage Server', async (_label, voice) => {
    ttsSessions.getForGuild.mockReturnValue({ voiceChannelId: VC });
    const { interaction, run } = command({ subcommand, voice });

    await run();

    expect(interaction.memberPermissions.has).toHaveBeenCalledWith(
      PermissionFlagsBits.ManageGuild
    );
    expectError(
      interaction,
      t('tts.errors.notInSameVoice', 'en'),
      t('tts.errors.notInSameVoiceDesc', 'en', {
        channel: VC,
        permission: MANAGE_SERVER('en'),
      }),
      WARNING
    );
    expect(embedOf(replied(interaction)).description).toContain(
      'Manage Server'
    );
    expect(ttsSessions.stop).not.toHaveBeenCalled();
    expect(ttsSessions.skip).not.toHaveBeenCalled();
  });

  it('allows a member in the voice channel being read', async () => {
    ttsSessions.getForGuild.mockReturnValue({ voiceChannelId: VC });
    const { interaction, run } = command({ subcommand, voice: VC });

    await run();

    const called = subcommand === 'stop' ? ttsSessions.stop : ttsSessions.skip;
    expect(called).toHaveBeenCalledWith(VC);
    expect(interaction.reply).toHaveBeenCalledTimes(1);
  });

  it('allows a server manager from anywhere', async () => {
    ttsSessions.getForGuild.mockReturnValue({ voiceChannelId: VC });
    const { run } = command({ subcommand, voice: null, manager: true });

    await run();

    const called = subcommand === 'stop' ? ttsSessions.stop : ttsSessions.skip;
    expect(called).toHaveBeenCalledWith(VC);
  });
});

describe('/tts stop', () => {
  beforeEach(() => {
    ttsSessions.getForGuild.mockReturnValue({ voiceChannelId: VC });
  });

  it('stops the session and leaves a connection made only for reading', async () => {
    connectionManager.getConnection.mockReturnValue({ receiving: false });
    mayAutoJoin.mockReturnValue(false);
    const { interaction, run } = command({ subcommand: 'stop' });

    await run();

    expect(ttsSessions.stop).toHaveBeenCalledWith(VC);
    expect(connectionManager.getConnection).toHaveBeenCalledWith(VC);
    expect(connectionManager.disconnect).toHaveBeenCalledWith(VC);
    expect(connectionManager.enableReceive).not.toHaveBeenCalled();

    const payload = replied(interaction);
    expect(payload.flags).toBeUndefined();
    const embed = embedOf(payload);
    expect(embed.title).toBe(t('tts.stopped', 'en'));
    expect(embed.description).toBe(
      t('tts.stoppedDesc', 'en', { command: commandMention('tts start') })
    );
    expect(embed.color).toBe(COLORS.INFO);
  });

  it.each<[string, object | undefined]>([
    ['a recording connection', { receiving: true }],
    ['a connection from before the flag existed', {}],
    ['no connection', undefined],
  ])('stays connected for %s', async (_label, connection) => {
    connectionManager.getConnection.mockReturnValue(connection);
    const { interaction, run } = command({ subcommand: 'stop' });

    await run();

    expect(ttsSessions.stop).toHaveBeenCalledWith(VC);
    expect(connectionManager.disconnect).not.toHaveBeenCalled();
    expect(embedOf(replied(interaction)).title).toBe(t('tts.stopped', 'en'));
  });
});

describe('/tts stop after auto-join was turned back on', () => {
  beforeEach(() => {
    ttsSessions.getForGuild.mockReturnValue({ voiceChannelId: VC });
    connectionManager.getConnection.mockReturnValue({ receiving: false });
    mayAutoJoin.mockReturnValue(true);
  });

  it('hands the occupied channel back to auto-join instead of leaving', async () => {
    const { interaction, voiceChannel, run } = command({
      subcommand: 'stop',
      members: [{ id: USER }, { id: 'listener' }],
    });

    await run();

    expect(ttsSessions.stop).toHaveBeenCalledWith(VC);
    expect(mayAutoJoin).toHaveBeenCalledWith(GUILD, VC);
    // In place: leaving and rejoining would race the bot's own voice events.
    expect(connectionManager.enableReceive).toHaveBeenCalledWith(VC);
    expect(connectionManager.disconnect).not.toHaveBeenCalled();
    // Members are told their audio is now kept, as on any auto-join.
    expect(announceBuffering).toHaveBeenCalledWith(voiceChannel);
    expect(embedOf(replied(interaction)).title).toBe(t('tts.stopped', 'en'));
  });

  it('replies without waiting for the buffering notice to go out', async () => {
    announceBuffering.mockReturnValue(new Promise(() => undefined));
    const { interaction, run } = command({
      subcommand: 'stop',
      members: [{ id: USER }],
    });

    await run();

    expect(connectionManager.enableReceive).toHaveBeenCalledWith(VC);
    expect(announceBuffering).toHaveBeenCalled();
    expect(embedOf(replied(interaction)).title).toBe(t('tts.stopped', 'en'));
  });

  it.each<[string, Partial<CommandOptions>, () => void]>([
    ['only bots are left', { members: [{ id: 'a-bot', bot: true }] }, () => {}],
    [
      'the channel is still excluded',
      {},
      () => mayAutoJoin.mockReturnValue(false),
    ],
    ['the channel is not cached', { voice: 'vc-uncached' }, () => {}],
    [
      'the connection cannot start listening',
      {},
      () => connectionManager.enableReceive.mockReturnValue(false),
    ],
  ])('leaves when %s', async (_label, opts, arrange) => {
    arrange();
    const { guild, run } = command({
      subcommand: 'stop',
      manager: true,
      ...opts,
    });
    if (opts.voice === 'vc-uncached') {
      (guild.channels.cache as Collection<string, unknown>).delete(VC);
    }

    await run();

    expect(connectionManager.disconnect).toHaveBeenCalledWith(VC);
    expect(announceBuffering).not.toHaveBeenCalled();
  });
});

describe('/tts skip', () => {
  beforeEach(() => {
    ttsSessions.getForGuild.mockReturnValue({ voiceChannelId: VC });
  });

  it('confirms a skip privately', async () => {
    ttsSessions.skip.mockReturnValue(true);
    const { interaction, run } = command({ subcommand: 'skip' });

    await run();

    expect(replied(interaction)).toEqual({
      content: t('tts.skipped', 'en'),
      flags: MessageFlags.Ephemeral,
    });
  });

  it('says when there was nothing to skip', async () => {
    ttsSessions.skip.mockReturnValue(false);
    const { interaction, run } = command({ subcommand: 'skip' });

    await run();

    expect(replied(interaction)).toEqual({
      content: t('tts.nothingToSkip', 'en'),
      flags: MessageFlags.Ephemeral,
    });
  });
});

describe('/tts voice', () => {
  const voice = (opts: CommandOptions = {}) =>
    command({ subcommand: 'voice', ...opts });

  /** A session reading the voice chat and the usual text channel. */
  const session = () => ({
    voiceChannelId: VC,
    textChannelIds: new Set([VC, TEXT]),
  });

  function currentText(
    label: string,
    speed: string,
    locale: Locale = 'en'
  ): string {
    return t('tts.voice.current', locale, { voice: label, speed });
  }

  it('explains when no engine is configured', async () => {
    getVoicevoxClient.mockReturnValue(null);
    const { interaction, run } = voice();

    await run();

    expectError(
      interaction,
      t('tts.errors.notConfigured', 'en'),
      t('tts.errors.notConfiguredDesc', 'en')
    );
  });

  it('reports a down engine privately', async () => {
    client.listVoices.mockRejectedValue(new Error('down'));
    const { interaction, run } = voice();

    await run();

    expect(interaction.deferReply).toHaveBeenCalledWith({
      flags: MessageFlags.Ephemeral,
    });
    expectError(
      interaction,
      t('tts.errors.engineDown', 'en'),
      t('tts.errors.engineDownDesc', 'en'),
      { deferred: true }
    );
  });

  describe('without options', () => {
    it('shows the defaults to someone who never chose', async () => {
      const { interaction, run } = voice();

      await run();

      expect(ttsRepository.getUserSettings).toHaveBeenCalledWith(USER);
      const embed = embedOf(edited(interaction));
      expect(embed.title).toBe(t('tts.voice.currentTitle', 'en'));
      expect(embed.description).toBe(
        `${currentText('ずんだもん（ノーマル）', '1')}\n\n${t('tts.voice.changeHint', 'en', { command: commandMention('tts voice') })}`
      );
      expect(embed.color).toBe(COLORS.INFO);
      expect(embed.footer?.text).toBe(
        t('tts.voice.credit', 'en', { character: 'ずんだもん' })
      );
      expect(ttsRepository.setUserSettings).not.toHaveBeenCalled();
    });

    it('shows the saved voice and a tidy speed', async () => {
      ttsRepository.getUserSettings.mockReturnValue({
        speakerId: 2,
        speed: 1.333333,
      });
      const { interaction, run } = voice();

      await run();

      const embed = embedOf(edited(interaction));
      expect(embed.description).toContain(
        currentText('四国めたん（ノーマル）', '1.33')
      );
      expect(embed.footer?.text).toBe(
        t('tts.voice.credit', 'en', { character: '四国めたん' })
      );
    });

    it('shows a saved voice the engine no longer has by number, without credit', async () => {
      ttsRepository.getUserSettings.mockReturnValue({
        speakerId: 99,
        speed: 1.5,
      });
      const { interaction, run } = voice();

      await run();

      const embed = embedOf(edited(interaction));
      expect(embed.description).toContain(currentText('#99', '1.5'));
      expect(embed.footer).toBeUndefined();
    });
  });

  describe('with options', () => {
    it('rejects a speaker the engine does not offer', async () => {
      const { interaction, run } = voice({ options: { speaker: 999 } });

      await run();

      expectError(
        interaction,
        t('tts.voice.unknown', 'en'),
        t('tts.voice.unknownDesc', 'en'),
        { deferred: true, ...WARNING }
      );
      expect(ttsRepository.setUserSettings).not.toHaveBeenCalled();
    });

    it('rejects a speed-only change when the saved speaker is gone', async () => {
      ttsRepository.getUserSettings.mockReturnValue({
        speakerId: 99,
        speed: 1,
      });
      const { interaction, run } = voice({ options: { speed: 1.5 } });

      await run();

      expect(embedOf(edited(interaction)).title).toBe(
        t('tts.voice.unknown', 'en')
      );
      expect(ttsRepository.setUserSettings).not.toHaveBeenCalled();
    });

    it('changes the speaker and keeps the saved speed', async () => {
      ttsRepository.getUserSettings.mockReturnValue({
        speakerId: 3,
        speed: 1.2,
      });
      const { interaction, run } = voice({ options: { speaker: 2 } });

      await run();

      expect(ttsRepository.setUserSettings).toHaveBeenCalledWith(USER, {
        speakerId: 2,
        speed: 1.2,
      });
      const embed = embedOf(edited(interaction));
      expect(embed.title).toBe(t('tts.voice.setTitle', 'en'));
      expect(embed.description).toBe(
        currentText('四国めたん（ノーマル）', '1.2')
      );
      expect(embed.color).toBe(COLORS.SUCCESS);
      expect(embed.footer?.text).toBe(
        t('tts.voice.credit', 'en', { character: '四国めたん' })
      );
    });

    it('changes the speed and keeps the saved speaker', async () => {
      ttsRepository.getUserSettings.mockReturnValue({
        speakerId: 1,
        speed: 1,
      });
      const { run } = voice({ options: { speed: 0.75 } });

      await run();

      expect(ttsRepository.setUserSettings).toHaveBeenCalledWith(USER, {
        speakerId: 1,
        speed: 0.75,
      });
    });

    it.each([
      [5, 2],
      [0.1, 0.5],
    ])('clamps speed %s to %s', async (speed, expected) => {
      const { interaction, run } = voice({ options: { speed } });

      await run();

      expect(ttsRepository.setUserSettings).toHaveBeenCalledWith(USER, {
        speakerId: 3,
        speed: expected,
      });
      expect(embedOf(edited(interaction)).description).toBe(
        currentText('ずんだもん（ノーマル）', String(expected))
      );
    });

    it('previews the new voice when the caller is being read', async () => {
      ttsSessions.getForGuild.mockReturnValue(session());
      ttsRepository.listDictionary.mockReturnValue([
        { word: 'Taro', reading: 'たろー', createdBy: 'x' },
      ]);
      const { guild, run } = voice({
        voice: VC,
        displayName: 'Taro🌸',
        options: { speaker: 1, speed: 1.5 },
      });

      await run();

      expect(ttsRepository.compiledDictionary).toHaveBeenCalledWith(guild.id);
      // A preview is its own line: never folded into the caller's messages.
      expect(ttsSessions.enqueue).toHaveBeenCalledWith(VC, {
        authorId: USER,
        authorName: 'たろー',
        text: t('tts.voice.preview', 'en'),
        speakerId: 1,
        speed: 1.5,
        mergeable: false,
      });
      // The preview line itself loads the voice; no separate warm-up.
      expect(ttsSessions.warmUp).not.toHaveBeenCalled();
    });

    it('does not preview for a caller outside the voice channel being read, but loads the voice', async () => {
      ttsSessions.getForGuild.mockReturnValue(session());
      const { run } = voice({ voice: 'vc-other', options: { speaker: 1 } });

      await run();

      expect(ttsRepository.setUserSettings).toHaveBeenCalled();
      expect(ttsSessions.enqueue).not.toHaveBeenCalled();
      // Reading is running in this server, so the voice will be needed soon.
      expect(ttsSessions.warmUp).toHaveBeenCalledWith([1]);
    });

    it('does not preview, or load the voice, when nothing is being read', async () => {
      const { run } = voice({ options: { speaker: 1 } });

      await run();

      expect(ttsSessions.enqueue).not.toHaveBeenCalled();
      expect(ttsSessions.warmUp).not.toHaveBeenCalled();
    });
  });

  describe('public credit for a voice change during a session', () => {
    it('posts the new voice and its credit in the channel the command was used in', async () => {
      ttsSessions.getForGuild.mockReturnValue(session());
      const { interaction, textChannel, voiceChannel, run } = voice({
        voice: VC,
        options: { speaker: 2 },
      });

      await run();

      expect(textChannel.send).toHaveBeenCalledTimes(1);
      expect(voiceChannel!.send).not.toHaveBeenCalled();
      const embed = textChannel.send.mock.calls[0][0].embeds[0].toJSON();
      expect(embed.description).toBe(
        t('tts.voice.changed', 'en', {
          user: USER,
          voice: '四国めたん（ノーマル）',
        })
      );
      expect(embed.footer?.text).toBe(
        t('tts.voice.credit', 'en', { character: '四国めたん' })
      );
      // The caller's own confirmation stays private.
      expect(embedOf(edited(interaction)).title).toBe(
        t('tts.voice.setTitle', 'en')
      );
    });

    it('uses the voice chat when the command came from a channel not being read', async () => {
      ttsSessions.getForGuild.mockReturnValue(session());
      const { textChannel, voiceChannel, run } = voice({
        voice: VC,
        channelId: 'elsewhere',
        locale: 'ja',
        options: { speaker: 2 },
      });

      await run();

      expect(textChannel.send).not.toHaveBeenCalled();
      expect(voiceChannel!.send).toHaveBeenCalledTimes(1);
      const embed = voiceChannel!.send.mock.calls[0][0].embeds[0].toJSON();
      expect(embed.footer?.text).toBe(
        t('tts.voice.credit', 'ja', { character: '四国めたん' })
      );
    });

    it('posts nothing when only the speed changed', async () => {
      ttsSessions.getForGuild.mockReturnValue(session());
      const { textChannel, run } = voice({
        voice: VC,
        options: { speed: 1.5 },
      });

      await run();

      expect(ttsSessions.enqueue).toHaveBeenCalled();
      expect(ttsSessions.creditCharacter).toHaveBeenCalledWith(
        VC,
        'ずんだもん'
      );
      expect(textChannel.send).not.toHaveBeenCalled();
    });

    it('credits each character once, however often styles are switched', async () => {
      ttsSessions.getForGuild.mockReturnValue(session());
      const sent: unknown[] = [];
      // ずんだもん (3, 1) is credited from the start; 四国めたん (2) is new.
      for (const speaker of [1, 3, 1, 2, 1, 2, 3]) {
        const { textChannel, run } = voice({
          voice: VC,
          options: { speaker },
        });
        await run();
        sent.push(...textChannel.send.mock.calls);
      }

      expect(sent).toHaveLength(1);
      expect(ttsSessions.enqueue).toHaveBeenCalledTimes(7);
    });

    it('posts nothing for a caller who is not being read', async () => {
      ttsSessions.getForGuild.mockReturnValue(session());
      const { textChannel, run } = voice({
        voice: 'vc-other',
        options: { speaker: 2 },
      });

      await run();

      expect(textChannel.send).not.toHaveBeenCalled();
    });

    it.each<[string, (channel: ReturnType<typeof sendableChannel>) => void]>([
      [
        'the post fails',
        (c) => c.send.mockRejectedValue(new Error('Missing Access')),
      ],
      [
        'the channel cannot be posted in',
        (c) => Object.assign(c, { isSendable: () => false }),
      ],
    ])('still confirms the change when %s', async (_label, breakIt) => {
      ttsSessions.getForGuild.mockReturnValue(session());
      const { interaction, textChannel, run } = voice({
        voice: VC,
        options: { speaker: 2 },
      });
      breakIt(textChannel);

      await run();

      expect(ttsRepository.setUserSettings).toHaveBeenCalled();
      expect(embedOf(edited(interaction)).title).toBe(
        t('tts.voice.setTitle', 'en')
      );
    });
  });
});

describe('/tts dict', () => {
  const dict = (subcommand: string, opts: CommandOptions = {}) =>
    command({ group: 'dict', subcommand, ...opts });

  describe('list', () => {
    it('says the dictionary is empty', async () => {
      const { interaction, run } = dict('list');

      await run();

      expect(ttsRepository.listDictionary).toHaveBeenCalledWith(GUILD);
      const payload = replied(interaction);
      expect(payload.flags).toBe(MessageFlags.Ephemeral);
      const embed = embedOf(payload);
      expect(embed.title).toBe(t('tts.dict.listTitle', 'en'));
      expect(embed.description).toBe(
        t('tts.dict.listEmpty', 'en', {
          command: commandMention('tts dict add'),
        })
      );
      expect(embed.color).toBe(COLORS.INFO);
    });

    it('lists every word with its reading', async () => {
      ttsRepository.listDictionary.mockReturnValue([
        { word: 'w', reading: 'わら', createdBy: 'a' },
        { word: '草', reading: 'くさ', createdBy: 'b' },
      ]);
      const { interaction, run } = dict('list');

      await run();

      expect(embedOf(replied(interaction)).description).toBe(
        '・`w` → `わら`\n・`草` → `くさ`'
      );
    });

    it('shows markdown in words and readings as typed, not rendered', async () => {
      ttsRepository.listDictionary.mockReturnValue([
        {
          word: '*bold*',
          reading: '[Free Nitro](https://evil.example)',
          createdBy: 'a',
        },
      ]);
      const { interaction, run } = dict('list');

      await run();

      expect(embedOf(replied(interaction)).description).toBe(
        '・`*bold*` → `[Free Nitro](https://evil.example)`'
      );
    });

    it('stops before the embed limit and still counts the rest', async () => {
      ttsRepository.listDictionary.mockReturnValue(
        Array.from({ length: 45 }, (_, i) => ({
          word: `${i}`.padStart(50, 'w'),
          reading: 'あ'.repeat(100),
          createdBy: 'a',
        }))
      );
      const { interaction, run } = dict('list');

      await run();

      const description = embedOf(replied(interaction)).description!;
      expect(description.length).toBeLessThanOrEqual(4096);
      const lines = description.split('\n');
      const shown = lines.length - 1;
      expect(shown).toBeGreaterThan(0);
      expect(shown).toBeLessThan(40);
      expect(lines[shown]).toBe(
        t('tts.dict.listMore', 'en', { count: 45 - shown })
      );
    });

    it('shows the first 40 and counts the rest', async () => {
      ttsRepository.listDictionary.mockReturnValue(
        Array.from({ length: 45 }, (_, i) => ({
          word: `word${i}`,
          reading: `よみ${i}`,
          createdBy: 'a',
        }))
      );
      const { interaction, run } = dict('list');

      await run();

      const lines = embedOf(replied(interaction)).description!.split('\n');
      expect(lines).toHaveLength(41);
      expect(lines[0]).toBe('・`word0` → `よみ0`');
      expect(lines[39]).toBe('・`word39` → `よみ39`');
      expect(lines[40]).toBe(t('tts.dict.listMore', 'en', { count: 5 }));
    });

    it('shows exactly 40 without a remainder line', async () => {
      ttsRepository.listDictionary.mockReturnValue(
        Array.from({ length: 40 }, (_, i) => ({
          word: `w${i}`,
          reading: `r${i}`,
          createdBy: 'a',
        }))
      );
      const { interaction, run } = dict('list');

      await run();

      expect(
        embedOf(replied(interaction)).description!.split('\n')
      ).toHaveLength(40);
    });
  });

  describe('add', () => {
    const invalid = () =>
      t('tts.dict.invalid', 'en', { wordMax: 50, readingMax: 100 });

    it.each<[string, string, string]>([
      ['a blank word', '   ', 'よみ'],
      ['a word over 50 characters', 'x'.repeat(51), 'よみ'],
      ['a blank reading', 'w', '  '],
      ['a reading over 100 characters', 'w', 'あ'.repeat(101)],
    ])('rejects %s', async (_label, word, reading) => {
      const { interaction, run } = dict('add', { options: { word, reading } });

      await run();

      expectError(
        interaction,
        t('tts.dict.invalidTitle', 'en'),
        invalid(),
        WARNING
      );
      expect(ttsRepository.upsertDictionaryEntry).not.toHaveBeenCalled();
    });

    it('accepts words and readings at the length limits, trimmed', async () => {
      const word = 'x'.repeat(50);
      const reading = 'あ'.repeat(100);
      const { run } = dict('add', {
        options: { word: `  ${word} `, reading: ` ${reading}  ` },
      });

      await run();

      expect(ttsRepository.upsertDictionaryEntry).toHaveBeenCalledWith(
        GUILD,
        word,
        reading,
        USER
      );
    });

    it('adds a new word and announces it publicly', async () => {
      const { interaction, run } = dict('add', {
        options: { word: ' w ', reading: ' わら ' },
      });

      await run();

      expect(ttsRepository.getDictionaryEntry).toHaveBeenCalledWith(GUILD, 'w');
      expect(ttsRepository.upsertDictionaryEntry).toHaveBeenCalledWith(
        GUILD,
        'w',
        'わら',
        USER
      );
      const payload = replied(interaction);
      expect(payload.flags).toBeUndefined();
      const embed = embedOf(payload);
      expect(embed.title).toBe(t('tts.dict.addedTitle', 'en'));
      expect(embed.description).toBe(
        t('tts.dict.added', 'en', { word: '`w`', reading: '`わら`' })
      );
      expect(embed.color).toBe(COLORS.SUCCESS);
    });

    it('lets the member who added a word change it', async () => {
      ttsRepository.getDictionaryEntry.mockReturnValue({
        word: 'w',
        reading: 'わら',
        createdBy: USER,
      });
      const { interaction, run } = dict('add', {
        options: { word: 'w', reading: 'くさ' },
      });

      await run();

      expect(ttsRepository.upsertDictionaryEntry).toHaveBeenCalledWith(
        GUILD,
        'w',
        'くさ',
        USER
      );
      expect(embedOf(replied(interaction)).description).toBe(
        t('tts.dict.updated', 'en', { word: '`w`', reading: '`くさ`' })
      );
    });

    it.each<Locale>(['en', 'ja'])(
      "refuses to change another member's word, and writes nothing (%s)",
      async (locale) => {
        ttsRepository.getDictionaryEntry.mockReturnValue({
          word: 'Taka',
          reading: 'たか',
          createdBy: 'someone-else',
        });
        const { interaction, run } = dict('add', {
          locale,
          options: { word: 'taka', reading: 'ばか' },
        });

        await run();

        expectError(
          interaction,
          t('tts.dict.notOwnerTitle', locale),
          t('tts.dict.notOwner', locale, { permission: MANAGE_SERVER(locale) }),
          WARNING
        );
        expect(ttsRepository.upsertDictionaryEntry).not.toHaveBeenCalled();
      }
    );

    it.each([
      ['fullwidth', 'ａｌｉｃｅ', 'ＡＬＩＣＥ'],
      ['accented', 'café', 'CAFÉ'],
      ['Greek', 'αλίκη', 'ΑΛΊΚΗ'],
    ])(
      "refuses a %s case variant of another member's word",
      async (_label, owned, variant) => {
        // Looked up by the same folded key the repository stores.
        ttsRepository.getDictionaryEntry.mockImplementation(
          (_guildId: string, word: string) =>
            dictionaryKey(word) === dictionaryKey(owned)
              ? { word: owned, reading: 'ありす', createdBy: 'someone-else' }
              : null
        );
        const add = dict('add', {
          options: { word: variant, reading: 'ばか' },
        });
        await add.run();
        expectError(
          add.interaction,
          t('tts.dict.notOwnerTitle', 'en'),
          t('tts.dict.notOwner', 'en', { permission: MANAGE_SERVER('en') }),
          WARNING
        );
        expect(ttsRepository.upsertDictionaryEntry).not.toHaveBeenCalled();

        const remove = dict('remove', { options: { word: variant } });
        await remove.run();
        expect(ttsRepository.removeDictionaryEntry).not.toHaveBeenCalled();
      }
    );

    it("lets a server manager change anyone's word", async () => {
      ttsRepository.getDictionaryEntry.mockReturnValue({
        word: 'Taka',
        reading: 'ばか',
        createdBy: 'someone-else',
      });
      const { interaction, run } = dict('add', {
        manager: true,
        options: { word: 'Taka', reading: 'たか' },
      });

      await run();

      // The repository keeps the original author on an update.
      expect(ttsRepository.upsertDictionaryEntry).toHaveBeenCalledWith(
        GUILD,
        'Taka',
        'たか',
        USER
      );
      expect(embedOf(replied(interaction)).description).toBe(
        t('tts.dict.updated', 'en', { word: '`Taka`', reading: '`たか`' })
      );
    });

    it('stores the text as typed but shows it without rendering markdown', async () => {
      const reading = '[Discord Nitro 無料配布](https://evil.example)';
      const { interaction, run } = dict('add', {
        options: { word: 'nitro_*', reading },
      });

      await run();

      expect(ttsRepository.upsertDictionaryEntry).toHaveBeenCalledWith(
        GUILD,
        'nitro_*',
        reading,
        USER
      );
      expect(embedOf(replied(interaction)).description).toBe(
        t('tts.dict.added', 'en', {
          word: '`nitro_*`',
          reading: '`[Discord Nitro 無料配布](https://evil.example)`',
        })
      );
    });

    /** The reply with every inline code span taken out. */
    const outsideCode = (description: string) =>
      description.replace(/`[^`]*`/g, '');

    it.each<Locale>(['en', 'ja'])(
      'cannot form a link from a word and a reading together (%s)',
      async (locale) => {
        const { interaction, run } = dict('add', {
          locale,
          options: {
            word: '[Claim your reward',
            reading: '](https://phish.example)',
          },
        });

        await run();

        const description = embedOf(replied(interaction)).description!;
        expect(description).toBe(
          t('tts.dict.added', locale, {
            word: '`[Claim your reward`',
            reading: '`](https://phish.example)`',
          })
        );
        // Every bracket sits inside a code span, where Discord renders no
        // links.
        expect(outsideCode(description)).not.toMatch(/[[\]()]/);
      }
    );

    it('cannot form a link from two masked links in one word', async () => {
      const word = '[a](b)[Steam gift](https://e.example)';
      const { interaction, run } = dict('add', {
        options: { word, reading: 'x' },
      });

      await run();

      const description = embedOf(replied(interaction)).description!;
      expect(outsideCode(description)).not.toMatch(/[[\]()]/);
      expect(description).toContain(`\`${word}\``);
    });

    it('cannot close the code span early with a backtick', async () => {
      const { interaction, run } = dict('add', {
        options: { word: 'a`[x](https://e.example)`b', reading: '``y' },
      });

      await run();

      const description = embedOf(replied(interaction)).description!;
      expect(description).toBe(
        t('tts.dict.added', 'en', {
          word: '`aˋ[x](https://e.example)ˋb`',
          reading: '`ˋˋy`',
        })
      );
      expect(outsideCode(description)).not.toMatch(/[[\]()]/);
    });

    it(`refuses a new word once the server has ${MAX_DICTIONARY_ENTRIES}`, async () => {
      ttsRepository.countDictionary.mockReturnValue(MAX_DICTIONARY_ENTRIES);
      const { interaction, run } = dict('add', {
        options: { word: 'new', reading: 'にゅー' },
      });

      await run();

      expect(ttsRepository.countDictionary).toHaveBeenCalledWith(GUILD);
      expectError(
        interaction,
        t('tts.dict.fullTitle', 'en'),
        t('tts.dict.full', 'en', {
          max: MAX_DICTIONARY_ENTRIES,
          command: commandMention('tts dict remove'),
        }),
        WARNING
      );
      expect(ttsRepository.upsertDictionaryEntry).not.toHaveBeenCalled();
    });

    it('accepts a new word one below the limit', async () => {
      ttsRepository.countDictionary.mockReturnValue(MAX_DICTIONARY_ENTRIES - 1);
      const { run } = dict('add', {
        options: { word: 'new', reading: 'にゅー' },
      });

      await run();

      expect(ttsRepository.upsertDictionaryEntry).toHaveBeenCalled();
    });

    it('still updates an existing word when the dictionary is full', async () => {
      ttsRepository.countDictionary.mockReturnValue(MAX_DICTIONARY_ENTRIES);
      ttsRepository.getDictionaryEntry.mockReturnValue({
        word: 'w',
        reading: 'わら',
        createdBy: USER,
      });
      const { interaction, run } = dict('add', {
        options: { word: 'w', reading: 'くさ' },
      });

      await run();

      expect(ttsRepository.upsertDictionaryEntry).toHaveBeenCalledWith(
        GUILD,
        'w',
        'くさ',
        USER
      );
      expect(embedOf(replied(interaction)).description).toBe(
        t('tts.dict.updated', 'en', { word: '`w`', reading: '`くさ`' })
      );
    });
  });

  describe('remove', () => {
    const entry = (createdBy: string) => ({
      word: 'w',
      reading: 'わら',
      createdBy,
    });

    it('says when the word is not there', async () => {
      const { interaction, run } = dict('remove', {
        options: { word: ' nope ' },
      });

      await run();

      expect(ttsRepository.getDictionaryEntry).toHaveBeenCalledWith(
        GUILD,
        'nope'
      );
      expectError(
        interaction,
        t('tts.dict.notFoundTitle', 'en'),
        t('tts.dict.notFound', 'en', { word: '`nope`' }),
        WARNING
      );
      expect(ttsRepository.removeDictionaryEntry).not.toHaveBeenCalled();
    });

    it('refuses someone who neither added it nor manages the server', async () => {
      ttsRepository.getDictionaryEntry.mockReturnValue(entry('someone-else'));
      const { interaction, run } = dict('remove', { options: { word: 'w' } });

      await run();

      expectError(
        interaction,
        t('tts.dict.notOwnerTitle', 'en'),
        t('tts.dict.notOwner', 'en', { permission: MANAGE_SERVER('en') }),
        WARNING
      );
      expect(ttsRepository.removeDictionaryEntry).not.toHaveBeenCalled();
    });

    it('lets the member who added it remove it', async () => {
      ttsRepository.getDictionaryEntry.mockReturnValue(entry(USER));
      const { interaction, run } = dict('remove', { options: { word: 'w' } });

      await run();

      expect(ttsRepository.removeDictionaryEntry).toHaveBeenCalledWith(
        GUILD,
        'w'
      );
      const payload = replied(interaction);
      expect(payload.flags).toBeUndefined();
      const embed = embedOf(payload);
      expect(embed.title).toBe(t('tts.dict.removedTitle', 'en'));
      expect(embed.description).toBe(
        t('tts.dict.removed', 'en', { word: '`w`' })
      );
      expect(embed.color).toBe(COLORS.INFO);
    });

    it('shows the word without rendering markdown', async () => {
      ttsRepository.getDictionaryEntry.mockReturnValue({
        word: '**x**',
        reading: 'えっくす',
        createdBy: USER,
      });
      const removed = dict('remove', { options: { word: '**x**' } });
      await removed.run();
      expect(embedOf(replied(removed.interaction)).description).toBe(
        t('tts.dict.removed', 'en', { word: '`**x**`' })
      );
      expect(ttsRepository.removeDictionaryEntry).toHaveBeenCalledWith(
        GUILD,
        '**x**'
      );

      ttsRepository.getDictionaryEntry.mockReturnValue(null);
      const missing = dict('remove', { options: { word: '||x||' } });
      await missing.run();
      expect(embedOf(replied(missing.interaction)).description).toBe(
        t('tts.dict.notFound', 'en', { word: '`||x||`' })
      );
    });

    it('lets a server manager remove anyone’s word', async () => {
      ttsRepository.getDictionaryEntry.mockReturnValue(entry('someone-else'));
      const { run } = dict('remove', {
        options: { word: 'w' },
        manager: true,
      });

      await run();

      expect(ttsRepository.removeDictionaryEntry).toHaveBeenCalledWith(
        GUILD,
        'w'
      );
    });
  });
});

describe('/tts dict add option descriptions', () => {
  it('give an example that is safe to copy', () => {
    interface Option {
      name: string;
      description: string;
      options?: Option[];
    }
    const json = ttsCommand.data.toJSON() as unknown as { options: Option[] };
    const add = json.options
      .find((o) => o.name === 'dict')
      ?.options?.find((o) => o.name === 'add') as { options: Option[] };
    const example = (name: string) =>
      /e\.g\. (.+)\)$/.exec(
        add!.options.find((o) => o.name === name)!.description
      )![1];
    const rule = { word: example('word'), reading: example('reading') };

    // Words match inside other words: following the example must not
    // rewrite ordinary chat.
    const chat = 'Windows wow 草www Twitter見た？ web開発';
    expect(applyDictionary(chat, [rule])).toBe(chat);
    expect(applyDictionary(`${rule.word}で読む`, [rule])).toBe(
      `${rule.reading}で読む`
    );
  });
});

describe('autocompleteTts', () => {
  function autocomplete(
    name: string,
    value: string | number,
    guildId: string | null = GUILD
  ) {
    const interaction = {
      guildId,
      options: { getFocused: vi.fn(() => ({ name, value })) },
      respond: vi.fn(
        async (_choices: Array<{ name: string; value: string | number }>) =>
          undefined
      ),
    };
    return {
      interaction,
      run: () =>
        autocompleteTts(interaction as unknown as AutocompleteInteraction),
      choices: () => {
        expect(interaction.respond).toHaveBeenCalledTimes(1);
        return interaction.respond.mock.calls[0][0];
      },
    };
  }

  describe('speaker', () => {
    it('suggests voices whose label contains the query, case-insensitively', async () => {
      client.listVoices.mockResolvedValue([
        ...VOICES,
        { id: 10, character: 'No.7', style: 'Normal' },
      ]);
      const { run, choices } = autocomplete('speaker', '  NORMAL ');

      await run();

      expect(choices()).toEqual([{ name: 'No.7（Normal）', value: 10 }]);
    });

    it('matches Japanese labels', async () => {
      const { run, choices } = autocomplete('speaker', 'ずんだ');

      await run();

      expect(choices()).toEqual([
        { name: 'ずんだもん（ノーマル）', value: 3 },
        { name: 'ずんだもん（あまあま）', value: 1 },
      ]);
    });

    it('offers at most 25 voices', async () => {
      client.listVoices.mockResolvedValue(
        Array.from({ length: 30 }, (_, i) => ({
          id: i,
          character: `voice${i}`,
          style: 'ノーマル',
        }))
      );
      const { run, choices } = autocomplete('speaker', '');

      await run();

      expect(choices()).toHaveLength(25);
      expect(choices()[0]).toEqual({ name: 'voice0（ノーマル）', value: 0 });
    });

    it('offers nothing when the engine is unreachable', async () => {
      client.listVoices.mockRejectedValue(new Error('down'));
      const { run, choices } = autocomplete('speaker', '');

      await run();

      expect(choices()).toEqual([]);
    });

    it('offers nothing when no engine is configured', async () => {
      getVoicevoxClient.mockReturnValue(null);
      const { run, choices } = autocomplete('speaker', '');

      await run();

      expect(choices()).toEqual([]);
    });

    it('answers from the cached list without waiting for the engine', async () => {
      client.peekVoices.mockReturnValue(VOICES);
      // A refresh that never comes back must not hold the answer up.
      client.listVoices.mockReturnValue(new Promise(() => undefined));
      const { run, choices } = autocomplete('speaker', 'めたん');

      await run();

      expect(choices()).toEqual([{ name: '四国めたん（ノーマル）', value: 2 }]);
      // Asked anyway, so an old list is refreshed in the background.
      expect(client.listVoices).toHaveBeenCalledTimes(1);
    });

    it('answers from the last list at once and refreshes it in the background', async () => {
      client.peekVoices.mockReturnValue(VOICES);
      client.listVoices.mockReturnValue(new Promise(() => undefined));
      const { run, choices } = autocomplete('speaker', 'めたん');

      await run();

      expect(choices()).toEqual([{ name: '四国めたん（ノーマル）', value: 2 }]);
      expect(client.listVoices).toHaveBeenCalledTimes(1);
    });

    describe('with nothing cached and an engine that hangs', () => {
      beforeEach(() => {
        vi.useFakeTimers();
        client.listVoices.mockReturnValue(new Promise(() => undefined));
      });

      afterEach(() => {
        vi.useRealTimers();
      });

      it(`offers nothing after ${AUTOCOMPLETE_WAIT_MS} ms, inside Discord's 3 s`, async () => {
        const { interaction, run } = autocomplete('speaker', '');

        const running = run();
        await vi.advanceTimersByTimeAsync(AUTOCOMPLETE_WAIT_MS - 1);
        expect(interaction.respond).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(1);
        await running;
        expect(interaction.respond).toHaveBeenCalledWith([]);
        expect(AUTOCOMPLETE_WAIT_MS).toBeLessThan(3_000);
      });
    });

    it('leaves no timer behind when the engine answers in time', async () => {
      vi.useFakeTimers();
      try {
        const { run, choices } = autocomplete('speaker', 'ずんだ');

        await run();

        expect(choices()).toHaveLength(2);
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it("answers within Discord's deadline when a cold engine is slow", async () => {
      vi.useFakeTimers();
      try {
        client.listVoices.mockReturnValue(new Promise(() => undefined));
        const { interaction, run, choices } = autocomplete('speaker', '');

        const running = run();
        await vi.advanceTimersByTimeAsync(1_999);
        expect(interaction.respond).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        await running;

        expect(choices()).toEqual([]);
      } finally {
        vi.useRealTimers();
      }
    });

    it('never cuts a voice name inside a surrogate pair', async () => {
      client.listVoices.mockResolvedValue([
        { id: 8, character: `a${'𠮷'.repeat(60)}`, style: 'ノーマル' },
      ]);
      const { run, choices } = autocomplete('speaker', '');

      await run();

      const name = choices()[0].name;
      expect(name).toBe(`a${'𠮷'.repeat(49)}`);
      expect(name.length).toBe(99);
    });

    it('keeps voice names within 100 characters', async () => {
      client.listVoices.mockResolvedValue([
        { id: 7, character: 'き'.repeat(80), style: 'す'.repeat(40) },
      ]);
      const { run, choices } = autocomplete('speaker', '');

      await run();

      expect(choices()[0].name).toHaveLength(100);
      expect(choices()[0].value).toBe(7);
    });
  });

  describe('word', () => {
    it('suggests words matching the word or the reading', async () => {
      ttsRepository.listDictionary.mockReturnValue([
        { word: 'Apple', reading: 'あっぷる', createdBy: 'a' },
        { word: 'banana', reading: 'ばなな', createdBy: 'a' },
        { word: '林檎', reading: 'りんご', createdBy: 'a' },
      ]);

      const byWord = autocomplete('word', 'APP');
      await byWord.run();
      expect(byWord.choices()).toEqual([
        { name: 'Apple → あっぷる', value: 'Apple' },
      ]);

      const byReading = autocomplete('word', 'りん');
      await byReading.run();
      expect(byReading.choices()).toEqual([
        { name: '林檎 → りんご', value: '林檎' },
      ]);
      expect(ttsRepository.listDictionary).toHaveBeenCalledWith(GUILD);
    });

    it('offers at most 25 and keeps names within 100 characters', async () => {
      ttsRepository.listDictionary.mockReturnValue(
        Array.from({ length: 30 }, (_, i) => ({
          word: `w${i}`,
          reading: 'あ'.repeat(100),
          createdBy: 'a',
        }))
      );
      const { run, choices } = autocomplete('word', '');

      await run();

      expect(choices()).toHaveLength(25);
      expect(choices()[0].name).toHaveLength(100);
      expect(choices()[0].value).toBe('w0');
    });

    it('offers nothing outside a server', async () => {
      const { run, choices } = autocomplete('word', 'w', null);

      await run();

      expect(choices()).toEqual([]);
      expect(ttsRepository.listDictionary).not.toHaveBeenCalled();
    });
  });

  it('offers nothing for any other option', async () => {
    const { run, choices } = autocomplete('reading', 'x');

    await run();

    expect(choices()).toEqual([]);
  });
});

describe('cooldowns', () => {
  afterEach(() => {
    cooldownStore.clearAll();
  });

  /** Run a command the way the router does: cooldown first, then the handler. */
  async function remainingAfter(opts: CommandOptions): Promise<number> {
    const { interaction, run } = command(opts);
    const passed = await cooldownMiddleware(
      interaction as unknown as ChatInputCommandInteraction,
      ttsCommand
    );
    expect(passed.success).toBe(true);
    await run();
    const path = ['tts', opts.group, opts.subcommand ?? 'start']
      .filter(Boolean)
      .join(' ');
    return cooldownStore.getRemainingCooldown(path, USER);
  }

  it.each<[string, CommandOptions, () => void]>([
    ['the caller is not in a voice channel', { voice: null }, () => {}],
    [
      'the bot is busy in another channel',
      {},
      () =>
        connectionManager.getAllConnections.mockReturnValue(
          new Map([['vc-busy', { guildId: GUILD, channelId: 'vc-busy' }]])
        ),
    ],
    ['nothing is being read', { subcommand: 'stop' }, () => {}],
    [
      'the caller is in another voice channel',
      { subcommand: 'skip', voice: 'vc-other' },
      () => ttsSessions.getForGuild.mockReturnValue({ voiceChannelId: VC }),
    ],
    [
      'the voice does not exist',
      { subcommand: 'voice', options: { speaker: 999 } },
      () => {},
    ],
    [
      'a dictionary word is too long',
      {
        group: 'dict',
        subcommand: 'add',
        options: { word: 'x'.repeat(51), reading: 'よみ' },
      },
      () => {},
    ],
    [
      'the dictionary is full',
      {
        group: 'dict',
        subcommand: 'add',
        options: { word: 'new', reading: 'にゅー' },
      },
      () =>
        ttsRepository.countDictionary.mockReturnValue(MAX_DICTIONARY_ENTRIES),
    ],
    [
      'the word is not in the dictionary',
      { group: 'dict', subcommand: 'remove', options: { word: 'nope' } },
      () => {},
    ],
    [
      'the word belongs to someone else',
      { group: 'dict', subcommand: 'remove', options: { word: 'w' } },
      () =>
        ttsRepository.getDictionaryEntry.mockReturnValue({
          word: 'w',
          reading: 'わら',
          createdBy: 'someone-else',
        }),
    ],
  ])('gives the cooldown back when %s', async (_label, opts, arrange) => {
    arrange();
    expect(await remainingAfter({ subcommand: 'start', ...opts })).toBe(0);
  });

  it.each<[string, CommandOptions, () => void]>([
    ['reading starts', { subcommand: 'start' }, () => {}],
    [
      'the engine is down',
      { subcommand: 'start' },
      () => client.isAvailable.mockResolvedValue(false),
    ],
    [
      'a word is added',
      {
        group: 'dict',
        subcommand: 'add',
        options: { word: 'w', reading: 'わら' },
      },
      () => {},
    ],
  ])('keeps the cooldown when %s', async (_label, opts, arrange) => {
    arrange();
    expect(await remainingAfter(opts)).toBeGreaterThan(0);
  });
});

describe('warmUpTts', () => {
  it('warms the voice list and the default voice once the bot is up', () => {
    warmUpTts();

    expect(client.listVoices).toHaveBeenCalledTimes(1);
    expect(ttsSessions.warmUp).toHaveBeenCalledWith([3]);
  });

  it('does nothing without an engine', () => {
    getVoicevoxClient.mockReturnValue(null);

    warmUpTts();

    expect(ttsSessions.warmUp).not.toHaveBeenCalled();
  });

  it('shrugs off an engine that is not up yet', async () => {
    client.listVoices.mockRejectedValue(new Error('starting'));

    expect(() => warmUpTts()).not.toThrow();
    await Promise.resolve();
  });
});

describe('handleTtsMessage', () => {
  interface MessageOptions {
    content?: string;
    inGuild?: boolean;
    bot?: boolean;
    webhookId?: string | null;
    system?: boolean;
    member?: {
      displayName: string;
      voice: { channelId: string | null };
    } | null;
    attachments?: Array<{ contentType: string | null }>;
    stickers?: string[];
    channelId?: string;
  }

  function message(opts: MessageOptions = {}) {
    const guild = fakeGuild();
    (guild.channels.cache as Collection<string, unknown>).set(VC, voiceChat);
    return {
      inGuild: () => opts.inGuild !== false,
      guildId: GUILD,
      channelId: opts.channelId ?? TEXT,
      guild,
      author: { id: 'author-1', bot: opts.bot ?? false },
      webhookId: opts.webhookId ?? null,
      system: opts.system ?? false,
      content: opts.content ?? 'こんにちは',
      member:
        opts.member === undefined
          ? { displayName: 'たろう', voice: { channelId: VC } }
          : opts.member,
      attachments: new Collection(
        (opts.attachments ?? []).map((a, i) => [`att-${i}`, a] as const)
      ),
      stickers: new Collection(
        (opts.stickers ?? []).map((name, i) => [`st-${i}`, { name }] as const)
      ),
    };
  }

  const handle = (msg: ReturnType<typeof message>) =>
    handleTtsMessage(msg as unknown as Message);

  /** The voice channel's own chat, where first-use credits go. */
  let voiceChat: ReturnType<typeof sendableChannel>;

  beforeEach(() => {
    ttsSessions.findForTextChannel.mockReturnValue({ voiceChannelId: VC });
    voiceChat = sendableChannel(VC);
  });

  describe('crediting a voice the first time it is read', () => {
    const sentCredits = () =>
      voiceChat.send.mock.calls.map(([payload]) => payload);

    it('posts the credit for a character the session has not credited yet', async () => {
      client.peekVoices.mockReturnValue(VOICES);
      ttsRepository.getUserSettings.mockReturnValue({ speakerId: 2, speed: 1 });

      await handle(message());

      expect(ttsSessions.enqueue).toHaveBeenCalledWith(
        VC,
        expect.objectContaining({ speakerId: 2 })
      );
      expect(ttsSessions.creditCharacter).toHaveBeenCalledWith(
        VC,
        '四国めたん'
      );
      expect(sentCredits()).toEqual([
        {
          content: t('tts.voice.credit', 'en', { character: '四国めたん' }),
          allowedMentions: { parse: [] },
        },
      ]);
    });

    it('posts nothing for a character already credited', async () => {
      client.peekVoices.mockReturnValue(VOICES);

      // Default voice, named in the start message; then a second line.
      await handle(message());
      ttsRepository.getUserSettings.mockReturnValue({ speakerId: 2, speed: 1 });
      await handle(message());
      await handle(message());

      expect(sentCredits()).toHaveLength(1);
    });

    it('fetches the voice list when it is not cached yet, and credits after', async () => {
      ttsRepository.getUserSettings.mockReturnValue({ speakerId: 2, speed: 1 });
      let answer!: (voices: typeof VOICES) => void;
      client.listVoices.mockReturnValue(
        new Promise((resolve) => {
          answer = resolve;
        })
      );

      await handle(message());
      // Reading does not wait for the list.
      expect(ttsSessions.enqueue).toHaveBeenCalled();
      expect(voiceChat.send).not.toHaveBeenCalled();

      answer(VOICES);
      await vi.waitFor(() => expect(voiceChat.send).toHaveBeenCalledTimes(1));
    });

    it('gives up quietly when the list cannot be fetched', async () => {
      ttsRepository.getUserSettings.mockReturnValue({ speakerId: 2, speed: 1 });
      client.listVoices.mockRejectedValue(new Error('down'));

      await handle(message());
      await Promise.resolve();

      expect(ttsSessions.enqueue).toHaveBeenCalled();
      expect(ttsSessions.creditCharacter).not.toHaveBeenCalled();
      expect(voiceChat.send).not.toHaveBeenCalled();
    });

    it.each<[string, () => void]>([
      [
        'the voice is not in the list',
        () =>
          ttsRepository.getUserSettings.mockReturnValue({
            speakerId: 99,
            speed: 1,
          }),
      ],
      [
        'no engine is configured',
        () => getVoicevoxClient.mockReturnValue(null),
      ],
      [
        'the voice chat cannot be posted in',
        () => {
          ttsRepository.getUserSettings.mockReturnValue({
            speakerId: 2,
            speed: 1,
          });
          Object.assign(voiceChat, { isSendable: () => false });
        },
      ],
    ])('posts nothing when %s', async (_label, arrange) => {
      client.peekVoices.mockReturnValue(VOICES);
      arrange();

      await handle(message());

      expect(voiceChat.send).not.toHaveBeenCalled();
    });

    it('still reads when the credit cannot be posted', async () => {
      client.peekVoices.mockReturnValue(VOICES);
      ttsRepository.getUserSettings.mockReturnValue({ speakerId: 2, speed: 1 });
      voiceChat.send.mockRejectedValue(new Error('Missing Access'));

      await handle(message());
      await Promise.resolve();

      expect(ttsSessions.enqueue).toHaveBeenCalled();
    });

    it('credits a voice changed from another server once it is read here', async () => {
      client.peekVoices.mockReturnValue(VOICES);
      // In another server, where nothing is being read: saved, nothing posted.
      const elsewhere = command({
        subcommand: 'voice',
        voice: null,
        options: { speaker: 2 },
      });
      await elsewhere.run();
      expect(ttsRepository.setUserSettings).toHaveBeenCalledWith(USER, {
        speakerId: 2,
        speed: 1,
      });
      expect(elsewhere.textChannel.send).not.toHaveBeenCalled();

      // Back in the server being read, the first line in it is credited.
      ttsRepository.getUserSettings.mockReturnValue({ speakerId: 2, speed: 1 });
      await handle(message());

      expect(sentCredits()).toEqual([
        expect.objectContaining({
          content: t('tts.voice.credit', 'en', { character: '四国めたん' }),
        }),
      ]);
    });
  });

  it.each<[string, MessageOptions]>([
    ['direct messages', { inGuild: false }],
    ['bots', { bot: true }],
    ['webhooks', { webhookId: 'hook-1' }],
    ['system messages', { system: true }],
  ])('ignores %s', async (_label, opts) => {
    await handle(message(opts));

    expect(ttsSessions.findForTextChannel).not.toHaveBeenCalled();
    expect(ttsSessions.enqueue).not.toHaveBeenCalled();
  });

  it('ignores channels no session reads', async () => {
    ttsSessions.findForTextChannel.mockReturnValue(undefined);

    await handle(message({ channelId: 'random' }));

    expect(ttsSessions.findForTextChannel).toHaveBeenCalledWith(
      GUILD,
      'random'
    );
    expect(ttsSessions.enqueue).not.toHaveBeenCalled();
  });

  it.each([';内緒', '  ；ないしょ'])('ignores %j', async (content) => {
    await handle(message({ content }));
    expect(ttsSessions.enqueue).not.toHaveBeenCalled();
  });

  it.each<[string, MessageOptions['member']]>([
    ['not in voice', { displayName: 'x', voice: { channelId: null } }],
    [
      'in another voice channel',
      { displayName: 'x', voice: { channelId: 'vc-2' } },
    ],
    ['not cached as a member', null],
  ])('ignores an author %s', async (_label, member) => {
    await handle(message({ member }));
    expect(ttsSessions.enqueue).not.toHaveBeenCalled();
  });

  it('ignores a message with nothing to say', async () => {
    await handle(message({ content: '👍👍' }));
    expect(ttsSessions.enqueue).not.toHaveBeenCalled();
  });

  it('reads with the default voice for someone who never chose', async () => {
    await handle(message({ content: 'こんにちは' }));

    expect(ttsRepository.getUserSettings).toHaveBeenCalledWith('author-1');
    expect(ttsSessions.enqueue).toHaveBeenCalledWith(VC, {
      authorId: 'author-1',
      authorName: 'たろう',
      text: 'こんにちは',
      speakerId: 3,
      speed: 1,
    });
  });

  it('reads with the author’s saved voice', async () => {
    ttsRepository.getUserSettings.mockReturnValue({ speakerId: 8, speed: 1.4 });

    await handle(message());

    expect(ttsSessions.enqueue).toHaveBeenCalledWith(
      VC,
      expect.objectContaining({ speakerId: 8, speed: 1.4 })
    );
  });

  it('resolves mentions from the guild caches and applies the dictionary', async () => {
    ttsRepository.listDictionary.mockReturnValue([
      { word: 'たろう', reading: 'タロー', createdBy: 'x' },
    ]);

    await handle(
      message({
        content: '<@111> <@444> <@999> <@&222> <#333> さん',
      })
    );

    expect(ttsRepository.compiledDictionary).toHaveBeenCalledWith(GUILD);
    expect(ttsSessions.enqueue).toHaveBeenCalledWith(VC, {
      authorId: 'author-1',
      authorName: 'タロー',
      text: 'はなこ よそのひと だれか 管理者 雑談 さん',
      speakerId: 3,
      speed: 1,
    });
  });

  it('mentions attachments and stickers', async () => {
    await handle(
      message({
        content: '見て',
        attachments: [
          { contentType: 'application/pdf' },
          { contentType: null },
        ],
        stickers: ['ねこ'],
      })
    );

    expect(ttsSessions.enqueue).toHaveBeenCalledWith(
      VC,
      expect.objectContaining({ text: '見て、ファイル、スタンプ ねこ' })
    );
  });

  it('says 画像 when an attachment is an image', async () => {
    await handle(
      message({
        content: '',
        attachments: [
          { contentType: 'text/plain' },
          { contentType: 'image/png' },
        ],
      })
    );

    expect(ttsSessions.enqueue).toHaveBeenCalledWith(
      VC,
      expect.objectContaining({ text: '画像' })
    );
  });
});
