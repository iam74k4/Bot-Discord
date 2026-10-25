import {
  ChannelType,
  type ChatInputCommandInteraction,
  Collection,
  type EmbedBuilder,
  type MessageComponentInteraction,
  MessageFlags,
  PermissionFlagsBits,
} from 'discord.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const connectionManager = vi.hoisted(() => ({
  getConnectedChannelInGuild: vi.fn(),
  getConnection: vi.fn(),
  connect: vi.fn(),
  disconnect: vi.fn(),
  waitUntilReady: vi.fn(),
  enableReceive: vi.fn(),
  disableReceive: vi.fn(),
}));
vi.mock('../recording/connectionManager.js', () => ({ connectionManager }));

const captionSessions = vi.hoisted(() => ({
  start: vi.fn(),
  stop: vi.fn(),
  getForGuild: vi.fn(),
  forgetUser: vi.fn(),
}));
vi.mock('../captions/sessionManager.js', () => ({ captionSessions }));

const ttsSessions = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('../tts/sessionManager.js', () => ({ ttsSessions }));

const consent = vi.hoisted(() => ({
  hasConsented: vi.fn(),
  setConsent: vi.fn(),
}));
vi.mock('../repositories/captionConsentRepository.js', () => ({
  captionConsentRepository: consent,
}));

const mayAutoJoin = vi.hoisted(() => vi.fn());
vi.mock('../repositories/voiceSettingsRepository.js', () => ({
  voiceSettingsRepository: { mayAutoJoin },
}));

const getWhisperClient = vi.hoisted(() => vi.fn());
vi.mock('../captions/whisperClient.js', () => ({ getWhisperClient }));

const announceBuffering = vi.hoisted(() => vi.fn());
vi.mock('../application/announce.js', () => ({ announceBuffering }));

const resumeAutoJoin = vi.hoisted(() => vi.fn());
vi.mock('../application/listening.js', () => ({ resumeAutoJoin }));

vi.mock('../../../locales/guildLocale.js', () => ({
  resolveLocale: (interaction: { locale: string }) =>
    interaction.locale === 'ja' ? 'ja' : 'en',
  resolveBackgroundLocale: (guild: { preferredLocale: string }) =>
    guild.preferredLocale.startsWith('ja') ? 'ja' : 'en',
}));

vi.mock('../../../shared/utils/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
  getErrorMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)),
}));

const { CAPTION_CONSENT_PREFIX, executeCaptionCommand, handleConsentClick } =
  await import('../application/captions.js');
const { commandMention } =
  await import('../../../shared/utils/commandMentions.js');
const { formatPermissionNames } =
  await import('../../../shared/utils/discord.js');
const { t } = await import('../../../locales/index.js');
const { COLORS } = await import('../../../shared/utils/constants/index.js');

const GUILD = 'guild-1';
const VC = 'vc-1';
const USER = 'user-1';
/** What `connect` hands back, and `waitUntilReady` once ready. */
const JOINED = { kind: 'connection' };

interface Payload {
  embeds?: EmbedBuilder[];
  content?: string;
  flags?: number;
  components?: Array<{
    toJSON(): { components: Array<{ custom_id: string }> };
  }>;
  allowedMentions?: unknown;
}

function sendableChannel(id: string) {
  return {
    id,
    isSendable: () => true,
    send: vi.fn(async (_payload: Payload) => undefined),
  };
}

interface CommandOptions {
  subcommand?: string;
  allow?: boolean | null;
  inGuild?: boolean;
  /** The caller's voice channel id; null when not in voice. */
  voice?: string | null;
  manager?: boolean;
  /** Who is in the caller's voice channel; defaults to the caller alone. */
  members?: Array<{ id: string; bot?: boolean }>;
  /** Permissions the bot holds in the voice channel. */
  botPermissions?: bigint[];
}

function command(opts: CommandOptions = {}) {
  const voiceId = opts.voice === undefined ? VC : opts.voice;
  const members = opts.members ?? [{ id: USER }];
  const botPermissions = opts.botPermissions ?? [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages,
  ];
  const voiceChannel = voiceId
    ? {
        ...sendableChannel(voiceId),
        type: ChannelType.GuildVoice,
        members: new Collection(
          members.map(
            (m) => [m.id, { id: m.id, user: { bot: m.bot ?? false } }] as const
          )
        ),
        permissionsFor: vi.fn(() => ({
          has: (flags: bigint[]) =>
            flags.every((flag) => botPermissions.includes(flag)),
        })),
      }
    : null;
  const guild = {
    id: GUILD,
    preferredLocale: 'en-US',
    members: {
      me: { id: 'bot' },
      cache: new Collection<string, { displayName: string }>([
        ['alice', { displayName: 'Alice' }],
      ]),
    },
    channels: { cache: new Collection<string, unknown>() },
  };
  if (voiceChannel) guild.channels.cache.set(voiceChannel.id, voiceChannel);

  const interaction = {
    commandName: 'caption',
    locale: 'en-US',
    guildId: GUILD,
    channelId: 'text-1',
    guild,
    user: { id: USER },
    member: { voice: { channel: voiceChannel, channelId: voiceId } },
    memberPermissions: {
      has: (flag: bigint) =>
        opts.manager === true && flag === PermissionFlagsBits.ManageGuild,
    },
    inCachedGuild: () => opts.inGuild !== false,
    options: {
      getSubcommand: () => opts.subcommand ?? 'start',
      getBoolean: () => opts.allow ?? null,
    },
    deferred: false,
    replied: false,
    reply: vi.fn(async (_payload: Payload) => {
      interaction.replied = true;
    }),
    deferReply: vi.fn(async () => {
      interaction.deferred = true;
    }),
    editReply: vi.fn(async (_payload: Payload) => undefined),
  };

  return {
    interaction,
    voiceChannel,
    guild,
    run: () =>
      executeCaptionCommand(
        interaction as unknown as ChatInputCommandInteraction
      ),
  };
}

type FakeCommand = ReturnType<typeof command>['interaction'];

function replied(interaction: FakeCommand): Payload {
  expect(interaction.reply).toHaveBeenCalledTimes(1);
  return interaction.reply.mock.calls[0][0];
}

function edited(interaction: FakeCommand): Payload {
  const calls = interaction.editReply.mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  return calls[calls.length - 1][0];
}

const embedOf = (payload: Payload) => payload.embeds![0].toJSON();

const buttonIds = (payload: Payload) =>
  payload.components?.flatMap((row) =>
    row.toJSON().components.map((c) => c.custom_id)
  );

function fakeWhisper(available = true) {
  return { isAvailable: vi.fn(async () => available) };
}

type StartParams = {
  post(content: string): Promise<void>;
  nameOf(userId: string): string;
  onEngineTrouble(): void;
};

function startedWith(): StartParams {
  expect(captionSessions.start).toHaveBeenCalledTimes(1);
  return captionSessions.start.mock.calls[0][0] as StartParams;
}

beforeEach(() => {
  vi.clearAllMocks();
  getWhisperClient.mockReturnValue(fakeWhisper());
  connectionManager.getConnectedChannelInGuild.mockReturnValue(undefined);
  connectionManager.getConnection.mockReturnValue(undefined);
  connectionManager.connect.mockResolvedValue(JOINED);
  connectionManager.disconnect.mockResolvedValue(undefined);
  connectionManager.waitUntilReady.mockResolvedValue(JOINED);
  connectionManager.enableReceive.mockReturnValue(true);
  connectionManager.disableReceive.mockReturnValue(true);
  mayAutoJoin.mockReturnValue(true);
  announceBuffering.mockResolvedValue(undefined);
  captionSessions.getForGuild.mockReturnValue(undefined);
  ttsSessions.get.mockReturnValue(undefined);
  consent.hasConsented.mockReturnValue(false);
  resumeAutoJoin.mockResolvedValue(false);
});

describe('/caption start', () => {
  it('says so when no engine is configured, before joining anything', async () => {
    getWhisperClient.mockReturnValue(null);
    const { interaction, run } = command();

    await run();

    const payload = replied(interaction);
    expect(payload.flags).toBe(MessageFlags.Ephemeral);
    expect(embedOf(payload).title).toBe(
      t('captions.errors.notConfigured', 'en')
    );
    expect(connectionManager.connect).not.toHaveBeenCalled();
  });

  it('asks a member who is not in a voice channel to join one', async () => {
    const { interaction, run } = command({ voice: null });

    await run();

    const embed = embedOf(replied(interaction));
    expect(embed.title).toBe(t('captions.errors.notInVoice', 'en'));
    expect(embed.description).toBe(
      t('captions.errors.notInVoiceDesc', 'en', {
        command: commandMention('caption start'),
      })
    );
    expect(embed.color).toBe(COLORS.WARNING);
  });

  it('refuses while the bot is in another voice channel of the server', async () => {
    connectionManager.getConnectedChannelInGuild.mockReturnValue('vc-other');
    const { interaction, run } = command();

    await run();

    expect(embedOf(replied(interaction)).description).toBe(
      t('captions.errors.busyElsewhereDesc', 'en', { channel: 'vc-other' })
    );
    expect(connectionManager.connect).not.toHaveBeenCalled();
  });

  it('reports an engine that does not answer', async () => {
    getWhisperClient.mockReturnValue(fakeWhisper(false));
    const { interaction, run } = command();

    await run();

    expect(embedOf(edited(interaction)).title).toBe(
      t('captions.errors.engineDown', 'en')
    );
    expect(connectionManager.connect).not.toHaveBeenCalled();
    expect(captionSessions.start).not.toHaveBeenCalled();
  });

  it('joins as auto-join would where the server lets it keep audio, and says so', async () => {
    const { interaction, voiceChannel, guild, run } = command();

    await run();

    expect(connectionManager.connect).toHaveBeenCalledWith(
      guild,
      voiceChannel,
      { receive: true, buffer: true }
    );
    expect(announceBuffering).toHaveBeenCalledWith(voiceChannel);
    expect(captionSessions.start).toHaveBeenCalledWith(
      expect.objectContaining({
        guildId: GUILD,
        voiceChannelId: VC,
        startedBy: USER,
      })
    );
    expect(interaction.deferReply).toHaveBeenCalledWith();
  });

  it('only listens where auto-join may not keep audio', async () => {
    mayAutoJoin.mockReturnValue(false);
    const { voiceChannel, guild, run } = command();

    await run();

    expect(connectionManager.connect).toHaveBeenCalledWith(
      guild,
      voiceChannel,
      { receive: true, buffer: false }
    );
    expect(announceBuffering).not.toHaveBeenCalled();
    expect(captionSessions.start).toHaveBeenCalledTimes(1);
  });

  it('starts listening, still keeping nothing, on a join made only to read aloud', async () => {
    connectionManager.getConnection.mockReturnValue({ receiving: false });
    const { run } = command();

    await run();

    expect(connectionManager.enableReceive).toHaveBeenCalledWith(VC, {
      buffer: false,
    });
    expect(connectionManager.connect).not.toHaveBeenCalled();
    expect(captionSessions.start).toHaveBeenCalledTimes(1);
  });

  it('uses a connection that already listens as it is', async () => {
    connectionManager.getConnection.mockReturnValue({ receiving: true });
    const { run } = command();

    await run();

    expect(connectionManager.enableReceive).not.toHaveBeenCalled();
    expect(connectionManager.connect).not.toHaveBeenCalled();
    expect(captionSessions.start).toHaveBeenCalledTimes(1);
  });

  it('reports a join that fails', async () => {
    connectionManager.connect.mockResolvedValue(null);
    const { interaction, run } = command();

    await run();

    expect(embedOf(edited(interaction)).title).toBe(
      t('captions.errors.cannotJoin', 'en')
    );
    expect(captionSessions.start).not.toHaveBeenCalled();
  });

  it('removes its own join when it never becomes ready', async () => {
    connectionManager.waitUntilReady.mockResolvedValue(null);
    const { interaction, run } = command();

    await run();

    expect(connectionManager.disconnect).toHaveBeenCalledWith(VC, JOINED);
    expect(embedOf(edited(interaction)).title).toBe(
      t('captions.errors.cannotJoin', 'en')
    );
    expect(captionSessions.start).not.toHaveBeenCalled();
  });

  it('leaves a connection it did not make when that one is not ready', async () => {
    connectionManager.getConnection.mockReturnValue({ receiving: true });
    connectionManager.waitUntilReady.mockResolvedValue(null);
    const { run } = command();

    await run();

    expect(connectionManager.disconnect).not.toHaveBeenCalled();
  });

  it('answers in public with how many people here allowed captions, and the consent buttons', async () => {
    consent.hasConsented.mockImplementation(
      (_guildId: string, userId: string) => userId === 'alice'
    );
    const { interaction, run } = command({
      members: [{ id: USER }, { id: 'alice' }, { id: 'music-bot', bot: true }],
    });

    await run();

    const payload = edited(interaction);
    expect(payload.flags).toBeUndefined();
    const embed = embedOf(payload);
    expect(embed.title).toBe(t('captions.started', 'en'));
    expect(embed.description).toBe(
      [
        t('captions.startedDesc', 'en', { voice: VC }),
        t('captions.consentCount', 'en', { consented: 1, members: 2 }),
      ].join('\n\n')
    );
    expect(buttonIds(payload)).toEqual([
      `${CAPTION_CONSENT_PREFIX}allow`,
      `${CAPTION_CONSENT_PREFIX}revoke`,
    ]);
  });

  it('warns when the bot cannot post in the voice channel chat', async () => {
    const { interaction, run } = command({
      botPermissions: [PermissionFlagsBits.ViewChannel],
    });

    await run();

    expect(embedOf(edited(interaction)).description).toContain(
      t('captions.noPostPermission', 'en', { voice: VC })
    );
  });

  it('posts captions quietly in the voice channel chat, mentioning nobody', async () => {
    const { voiceChannel, run } = command();
    await run();

    await startedWith().post('**Alice**: @everyone');

    expect(voiceChannel!.send).toHaveBeenCalledWith({
      content: '**Alice**: @everyone',
      allowedMentions: { parse: [] },
      flags: MessageFlags.SuppressNotifications,
    });
  });

  it('swallows a caption Discord refuses', async () => {
    const { voiceChannel, run } = command();
    await run();
    voiceChannel!.send.mockRejectedValue(new Error('Missing Access'));

    await expect(startedWith().post('line')).resolves.toBeUndefined();
  });

  it('names speakers as the server shows them, with a stand-in for strangers', async () => {
    const { run } = command();
    await run();

    const { nameOf } = startedWith();
    expect(nameOf('alice')).toBe('Alice');
    expect(nameOf('gone')).toBe(t('captions.unknownSpeaker', 'en'));
  });

  it('tells the channel when the engine keeps failing', async () => {
    const { voiceChannel, run } = command();
    await run();

    startedWith().onEngineTrouble();
    await vi.waitFor(() => expect(voiceChannel!.send).toHaveBeenCalled());

    const [payload] = voiceChannel!.send.mock.calls[0];
    expect(embedOf(payload).title).toBe(t('captions.engineTrouble', 'en'));
  });

  it('works only in a server', async () => {
    const { interaction, run } = command({ inGuild: false });

    await run();

    expect(embedOf(replied(interaction)).description).toBe(
      t('common.guildOnly', 'en')
    );
  });
});

describe('/caption stop', () => {
  const SESSION = { guildId: GUILD, voiceChannelId: VC };

  it('says so when captions are not running', async () => {
    const { interaction, run } = command({ subcommand: 'stop' });

    await run();

    const embed = embedOf(replied(interaction));
    expect(embed.title).toBe(t('captions.errors.notRunning', 'en'));
    expect(embed.color).toBe(COLORS.INFO);
    expect(captionSessions.stop).not.toHaveBeenCalled();
  });

  it('refuses someone outside the captioned channel without Manage Server', async () => {
    captionSessions.getForGuild.mockReturnValue(SESSION);
    const { interaction, run } = command({
      subcommand: 'stop',
      voice: 'vc-other',
    });

    await run();

    expect(embedOf(replied(interaction)).description).toBe(
      t('captions.errors.notInSameVoiceDesc', 'en', {
        channel: VC,
        permission: formatPermissionNames(
          PermissionFlagsBits.ManageGuild,
          'en'
        ),
      })
    );
    expect(captionSessions.stop).not.toHaveBeenCalled();
  });

  it('lets a server manager stop it from anywhere', async () => {
    captionSessions.getForGuild.mockReturnValue(SESSION);
    const { interaction, run } = command({
      subcommand: 'stop',
      voice: null,
      manager: true,
    });

    await run();

    expect(captionSessions.stop).toHaveBeenCalledWith(VC);
    const payload = replied(interaction);
    expect(payload.flags).toBeUndefined();
    expect(embedOf(payload).title).toBe(t('captions.stopped', 'en'));
  });

  it('leaves a join that only listened for captions', async () => {
    captionSessions.getForGuild.mockReturnValue(SESSION);
    connectionManager.getConnection.mockReturnValue({
      receiving: true,
      buffering: false,
    });
    const { guild, run } = command({ subcommand: 'stop' });

    await run();

    expect(resumeAutoJoin).toHaveBeenCalledWith(guild, VC);
    expect(connectionManager.disconnect).toHaveBeenCalledWith(VC);
  });

  it('hands such a join to auto-join when auto-join now covers the channel', async () => {
    captionSessions.getForGuild.mockReturnValue(SESSION);
    connectionManager.getConnection.mockReturnValue({
      receiving: true,
      buffering: false,
    });
    resumeAutoJoin.mockResolvedValue(true);
    const { run } = command({ subcommand: 'stop' });

    await run();

    expect(connectionManager.disconnect).not.toHaveBeenCalled();
  });

  it('goes back to reading aloud deafened when a reading session still uses the join', async () => {
    captionSessions.getForGuild.mockReturnValue(SESSION);
    connectionManager.getConnection.mockReturnValue({
      receiving: true,
      buffering: false,
    });
    ttsSessions.get.mockReturnValue({ voiceChannelId: VC });
    const { run } = command({ subcommand: 'stop' });

    await run();

    expect(connectionManager.disableReceive).toHaveBeenCalledWith(VC);
    expect(connectionManager.disconnect).not.toHaveBeenCalled();
    expect(resumeAutoJoin).not.toHaveBeenCalled();
  });

  it('leaves a buffering connection to auto-join, as it was', async () => {
    captionSessions.getForGuild.mockReturnValue(SESSION);
    connectionManager.getConnection.mockReturnValue({ receiving: true });
    const { run } = command({ subcommand: 'stop' });

    await run();

    expect(captionSessions.stop).toHaveBeenCalledWith(VC);
    expect(connectionManager.disconnect).not.toHaveBeenCalled();
    expect(connectionManager.disableReceive).not.toHaveBeenCalled();
    expect(resumeAutoJoin).not.toHaveBeenCalled();
  });
});

describe('/caption consent', () => {
  it('shows the current answer privately, with what consent means and the buttons', async () => {
    consent.hasConsented.mockReturnValue(true);
    const { interaction, run } = command({ subcommand: 'consent' });

    await run();

    const payload = replied(interaction);
    expect(payload.flags).toBe(MessageFlags.Ephemeral);
    expect(embedOf(payload).description).toBe(
      [
        t('captions.consent.statusAllowed', 'en'),
        t('captions.consent.explain', 'en', {
          command: commandMention('caption consent'),
        }),
      ].join('\n\n')
    );
    expect(buttonIds(payload)).toHaveLength(2);
    expect(consent.setConsent).not.toHaveBeenCalled();
  });

  it('says when the member has not allowed it', async () => {
    const { interaction, run } = command({ subcommand: 'consent' });

    await run();

    expect(embedOf(replied(interaction)).description).toContain(
      t('captions.consent.statusNotAllowed', 'en')
    );
  });

  it('records a yes for this server', async () => {
    const { interaction, run } = command({
      subcommand: 'consent',
      allow: true,
    });

    await run();

    expect(consent.setConsent).toHaveBeenCalledWith(GUILD, USER, true);
    expect(captionSessions.forgetUser).not.toHaveBeenCalled();
    const payload = replied(interaction);
    expect(payload.flags).toBe(MessageFlags.Ephemeral);
    expect(embedOf(payload).title).toBe(
      t('captions.consent.allowedTitle', 'en')
    );
  });

  it('withdraws, dropping whatever of theirs is still in flight', async () => {
    const { interaction, run } = command({
      subcommand: 'consent',
      allow: false,
    });

    await run();

    expect(consent.setConsent).toHaveBeenCalledWith(GUILD, USER, false);
    expect(captionSessions.forgetUser).toHaveBeenCalledWith(GUILD, USER);
    expect(embedOf(replied(interaction)).title).toBe(
      t('captions.consent.revokedTitle', 'en')
    );
  });
});

describe('consent buttons', () => {
  function click(choice: string, inGuild = true) {
    const interaction = {
      customId: `${CAPTION_CONSENT_PREFIX}${choice}`,
      locale: 'en-US',
      guildId: GUILD,
      user: { id: 'alice' },
      inGuild: () => inGuild,
      reply: vi.fn(async (_payload: Payload) => undefined),
    };
    return {
      interaction,
      run: () =>
        handleConsentClick(
          interaction as unknown as MessageComponentInteraction
        ),
    };
  }

  it('records the presser’s yes, privately', async () => {
    const { interaction, run } = click('allow');

    await run();

    expect(consent.setConsent).toHaveBeenCalledWith(GUILD, 'alice', true);
    const [payload] = interaction.reply.mock.calls[0];
    expect(payload.flags).toBe(MessageFlags.Ephemeral);
    expect(embedOf(payload).title).toBe(
      t('captions.consent.allowedTitle', 'en')
    );
  });

  it('withdraws for the presser and drops what is in flight', async () => {
    const { run } = click('revoke');

    await run();

    expect(consent.setConsent).toHaveBeenCalledWith(GUILD, 'alice', false);
    expect(captionSessions.forgetUser).toHaveBeenCalledWith(GUILD, 'alice');
  });

  it.each([
    ['outside a server', 'allow', false],
    ['with an unknown choice', 'maybe', true],
  ])('changes nothing %s', async (_label, choice, inGuild) => {
    const { interaction, run } = click(choice, inGuild);

    await run();

    expect(consent.setConsent).not.toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledWith({
      content: t('common.guildOnly', 'en'),
      flags: MessageFlags.Ephemeral,
    });
  });
});
