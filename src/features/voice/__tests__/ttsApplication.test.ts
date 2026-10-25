import {
  type AutocompleteInteraction,
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

vi.mock('../../../locales/guildLocale.js', () => ({ resolveLocale }));

const {
  AUTOCOMPLETE_WAIT_MS,
  autocompleteTts,
  executeTtsCommand,
  handleTtsMessage,
  warmUpTts,
} = await import('../application/tts.js');
const { compileDictionary } = await import('../tts/textNormalizer.js');
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

let client: ReturnType<typeof fakeClient>;

/** A guild whose caches resolve the mentions used in these tests. */
function fakeGuild(me: object | null = { id: 'bot' }) {
  return {
    id: GUILD,
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
  /** Who else is in the caller's voice channel. */
  members?: Array<{ id: string; bot?: boolean }>;
}

function command(opts: CommandOptions = {}) {
  const voiceId = opts.voice === undefined ? VC : opts.voice;
  const botPermissions =
    opts.botPermissions === undefined
      ? [PermissionFlagsBits.Connect, PermissionFlagsBits.Speak]
      : opts.botPermissions;
  const members = new Collection(
    (opts.members ?? []).map(
      (member) =>
        [
          member.id,
          { id: member.id, user: { bot: member.bot ?? false } },
        ] as const
    )
  );
  const voiceChannel = voiceId
    ? {
        id: voiceId,
        members,
        permissionsFor: vi.fn(() =>
          botPermissions === null
            ? null
            : { has: (flag: bigint) => botPermissions.includes(flag) }
        ),
      }
    : null;
  const guild = fakeGuild(opts.me === undefined ? { id: 'bot' } : opts.me);
  const values = opts.options ?? {};

  const interaction = {
    commandName: 'tts',
    locale: opts.locale ?? 'en-US',
    guildId: GUILD,
    channelId: TEXT,
    guild,
    user: { id: opts.userId ?? USER },
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
  connectionManager.connect.mockResolvedValue({ kind: 'connection' });
  connectionManager.disconnect.mockResolvedValue(undefined);
  connectionManager.waitUntilReady.mockResolvedValue(true);
  mayAutoJoin.mockReturnValue(true);
  announceBuffering.mockResolvedValue(undefined);
  ttsSessions.getForGuild.mockReturnValue(undefined);
  ttsSessions.findForTextChannel.mockReturnValue(undefined);
  ttsSessions.skip.mockReturnValue(false);
  ttsSessions.stop.mockReturnValue(true);
  ttsSessions.enqueue.mockReturnValue(true);
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
    connectionManager.waitUntilReady.mockResolvedValue(false);
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
    expect(connectionManager.disconnect).toHaveBeenCalledWith(VC);
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
    connectionManager.waitUntilReady.mockResolvedValue(false);
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

  it('starts the session, warms the voice list and explains how it works', async () => {
    const { interaction, run } = start();

    await run();

    expect(ttsSessions.start).toHaveBeenCalledWith({
      guildId: GUILD,
      voiceChannelId: VC,
      textChannelId: TEXT,
      startedBy: USER,
    });
    expect(client.listVoices).toHaveBeenCalledTimes(1);
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
    expect(embed.footer?.text).toBe(t('tts.credit', 'en'));
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

  it.each<[string, CommandOptions]>([
    ['the bot lacks Speak', { botPermissions: [PermissionFlagsBits.Connect] }],
    ['permissions cannot be resolved', { botPermissions: null }],
    ['the bot member is not cached', { me: null }],
  ])('warns that it may not be heard when %s', async (_label, opts) => {
    const { interaction, run } = start(opts);

    await run();

    expect(embedOf(edited(interaction)).description).toBe(
      `${t('tts.startedDesc', 'en', { voice: VC })}\n\n${t('tts.noSpeakPermission', 'en')}`
    );
    expect(ttsSessions.start).toHaveBeenCalled();
  });

  it('speaks Japanese to a Japanese server', async () => {
    const { interaction, run } = start({ locale: 'ja' });

    await run();

    const embed = embedOf(edited(interaction));
    expect(embed.title).toBe(t('tts.started', 'ja'));
    expect(embed.footer?.text).toBe(t('tts.credit', 'ja'));
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
    const { interaction, run } = command({ subcommand: 'stop' });

    await run();

    expect(ttsSessions.stop).toHaveBeenCalledWith(VC);
    expect(connectionManager.getConnection).toHaveBeenCalledWith(VC);
    expect(connectionManager.disconnect).toHaveBeenCalledWith(VC);

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
      ttsSessions.getForGuild.mockReturnValue({ voiceChannelId: VC });
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
      ttsSessions.getForGuild.mockReturnValue({ voiceChannelId: VC });
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
        '・w → わら\n・草 → くさ'
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
      expect(lines[0]).toBe('・word0 → よみ0');
      expect(lines[39]).toBe('・word39 → よみ39');
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
        t('tts.dict.added', 'en', { word: 'w', reading: 'わら' })
      );
      expect(embed.color).toBe(COLORS.SUCCESS);
    });

    it('reports an existing word as updated', async () => {
      ttsRepository.getDictionaryEntry.mockReturnValue({
        word: 'w',
        reading: 'わら',
        createdBy: 'someone',
      });
      const { interaction, run } = dict('add', {
        options: { word: 'w', reading: 'くさ' },
      });

      await run();

      expect(embedOf(replied(interaction)).description).toBe(
        t('tts.dict.updated', 'en', { word: 'w', reading: 'くさ' })
      );
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
        createdBy: 'x',
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
        t('tts.dict.updated', 'en', { word: 'w', reading: 'くさ' })
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
        t('tts.dict.notFound', 'en', { word: 'nope' }),
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
        t('tts.dict.removed', 'en', { word: 'w' })
      );
      expect(embed.color).toBe(COLORS.INFO);
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
    return {
      inGuild: () => opts.inGuild !== false,
      guildId: GUILD,
      channelId: opts.channelId ?? TEXT,
      guild: fakeGuild(),
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

  beforeEach(() => {
    ttsSessions.findForTextChannel.mockReturnValue({ voiceChannelId: VC });
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
