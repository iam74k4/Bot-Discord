import {
  type AttachmentBuilder,
  ChannelType,
  ChatInputCommandInteraction,
  DiscordAPIError,
  type EmbedBuilder,
  HTTPError,
  MessageFlags,
  PermissionFlagsBits,
  RESTJSONErrorCodes,
} from 'discord.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const getConnection = vi.hoisted(() => vi.fn());
const connect = vi.hoisted(() => vi.fn());
const getConnectedChannelInGuild = vi.hoisted(() => vi.fn());
const isAtLimit = vi.hoisted(() => vi.fn());
const recordAudio = vi.hoisted(() => vi.fn());
const releaseCooldown = vi.hoisted(() => vi.fn());
const announceBuffering = vi.hoisted(() => vi.fn());
const settings = vi.hoisted(() => ({
  autoJoin: true,
  excluded: new Set<string>(),
}));

/** Mutable so individual tests can probe the limit and retry boundaries. */
const limits = vi.hoisted(() => ({
  maxRecording: 300,
  buffer: 600,
  retryMax: 0,
}));

vi.mock('../recording/connectionManager.js', () => ({
  connectionManager: {
    getConnection,
    connect,
    getConnectedChannelInGuild,
    isAtLimit,
  },
}));

vi.mock('../repositories/voiceSettingsRepository.js', () => ({
  voiceSettingsRepository: {
    isAutoJoinEnabled: () => settings.autoJoin,
    isChannelExcluded: (_guildId: string, channelId: string) =>
      settings.excluded.has(channelId),
  },
}));

vi.mock('../application/announce.js', () => ({ announceBuffering }));

vi.mock('../../../middleware/index.js', () => ({ releaseCooldown }));

vi.mock('../recording/recordingService.js', () => ({
  parseDurationString: (value: string) => {
    const seconds: Record<string, number> = {
      '30s': 30,
      '1m': 60,
      '5m': 300,
      '6m': 360,
    };
    if (value in seconds) return seconds[value];
    throw new Error('Invalid duration format');
  },
  recordAudio,
  RecordingNoAudibleAudioError: class RecordingNoAudibleAudioError extends Error {
    constructor(readonly checkedSeconds?: number) {
      super('No audible audio');
      this.name = 'RecordingNoAudibleAudioError';
    }
  },
  RecordingInProgressError: class RecordingInProgressError extends Error {
    constructor() {
      super('Recording already in progress for this channel');
      this.name = 'RecordingInProgressError';
    }
  },
}));

vi.mock('../../../config/index.js', async () => {
  const actual = await vi.importActual<
    typeof import('../../../config/index.js')
  >('../../../config/index.js');
  return {
    ...actual,
    env: {
      ...actual.env,
      MAX_CONCURRENT_VC_CONNECTIONS: 4,
      get MAX_RECORDING_DURATION() {
        return limits.maxRecording;
      },
      get AUDIO_BUFFER_DURATION() {
        return limits.buffer;
      },
    },
    RETRY: {
      ...actual.RETRY,
      get RECORDING_RETRY_MAX() {
        return limits.retryMax;
      },
    },
  };
});

vi.mock('../../../shared/utils/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
  getErrorMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)),
}));

import { executeRecordCommand } from '../application/record.js';
import {
  RecordingInProgressError,
  RecordingNoAudibleAudioError,
} from '../recording/recordingService.js';
import { metrics } from '../../../infrastructure/metrics/index.js';
import { t } from '../../../locales/index.js';
import { logger } from '../../../shared/utils/logger.js';
import { DISCORD_LIMITS } from '../../../config/index.js';
import { COLORS } from '../../../shared/utils/constants/index.js';

const MiB = 1024 * 1024;

interface RecordInteractionOptions {
  duration?: string;
  locale?: string;
  hasGuild?: boolean;
  hasMember?: boolean;
  voiceChannel?: { id: string; name: string; type: ChannelType } | null;
  botMember?: { id: string } | null;
  /** Text channel the command was used in; `null` for none. */
  channel?: object | null;
  /** Permissions the bot holds there; `null` when Discord cannot resolve any. */
  granted?: bigint[] | null;
  /** Bot permissions in the voice channel (for the diagnosis). */
  voiceGranted?: bigint[];
  /** `interaction.attachmentSizeLimit`; undefined leaves it out. */
  attachmentSizeLimit?: number;
}

function createRecordInteraction(
  followUpImpl: (payload: unknown) => Promise<unknown>,
  options: RecordInteractionOptions = {}
): ChatInputCommandInteraction {
  const voiceGranted = options.voiceGranted ?? [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.Connect,
  ];
  const voiceChannel =
    options.voiceChannel === undefined
      ? {
          id: 'voice-1',
          name: 'General',
          type: ChannelType.GuildVoice,
          permissionsFor: () => ({
            has: (flag: bigint) => voiceGranted.includes(flag),
          }),
        }
      : options.voiceChannel;

  const granted =
    options.granted === undefined
      ? [PermissionFlagsBits.AttachFiles, PermissionFlagsBits.ViewChannel]
      : options.granted;
  const permissions =
    granted === null
      ? null
      : { has: vi.fn((flag: bigint) => granted.includes(flag)) };

  const channel =
    options.channel === undefined
      ? {
          id: 'text-1',
          permissionsFor: vi.fn().mockReturnValue(permissions),
        }
      : options.channel;

  return {
    locale: options.locale ?? 'en-US',
    commandName: 'voice',
    // No guildId keeps locale resolution off the database.
    guildId: null,
    channelId: 'text-1',
    attachmentSizeLimit: options.attachmentSizeLimit,
    user: { id: 'user-1', tag: 'User#0001' },
    member:
      options.hasMember === false ? null : { voice: { channel: voiceChannel } },
    guild:
      options.hasGuild === false
        ? null
        : {
            id: 'guild-1',
            members: {
              me:
                options.botMember === undefined
                  ? { id: 'bot-1' }
                  : options.botMember,
            },
          },
    channel,
    options: {
      getString: vi.fn().mockReturnValue(options.duration ?? '5m'),
    },
    reply: vi.fn().mockResolvedValue({}),
    deferReply: vi.fn().mockResolvedValue({}),
    editReply: vi.fn().mockResolvedValue({}),
    followUp: vi.fn(followUpImpl),
  } as unknown as ChatInputCommandInteraction;
}

const delivered = async () => ({});

/** Every file upload fails; plain messages (warnings) still go through. */
const uploadsFail = (error: () => unknown) => async (payload: unknown) => {
  if ((payload as Payload).files) throw error();
  return {};
};

type Payload = {
  embeds?: EmbedBuilder[];
  files?: AttachmentBuilder[];
  content?: string;
  flags?: number;
};

function payloadsOf(mock: unknown): Payload[] {
  return vi
    .mocked(mock as (p: Payload) => unknown)
    .mock.calls.map(([payload]) => payload);
}

/** Embed of the most recent editReply - the message the user ends up seeing. */
function lastEditEmbed(interaction: ChatInputCommandInteraction) {
  const edits = payloadsOf(interaction.editReply);
  expect(edits.length).toBeGreaterThan(0);
  return edits[edits.length - 1].embeds![0].toJSON();
}

/** The single private reply - a refusal or the progress message. */
function replyEmbed(interaction: ChatInputCommandInteraction) {
  expect(interaction.reply).toHaveBeenCalledTimes(1);
  const [payload] = payloadsOf(interaction.reply);
  expect(payload.flags).toBe(MessageFlags.Ephemeral);
  return payload.embeds![0].toJSON();
}

/** A WAV part as recordAudio returns it. */
function part(name: string, size: number, start: number, end: number) {
  return {
    filePath: `/tmp/recordings/${name}`,
    size,
    data: Buffer.alloc(16, name.length),
    startSeconds: start,
    endSeconds: end,
  };
}

function apiError(status: number, code: number) {
  return new DiscordAPIError(
    { message: 'rejected', code },
    code,
    status,
    'POST',
    '/webhooks/x',
    {}
  );
}

function splitResult() {
  const parts = [
    part('recording_part1.wav', 12 * MiB, 0, 150),
    part('recording_part2.wav', 12 * MiB, 150, 300),
  ];
  return {
    filePath: parts[0].filePath,
    fileSize: 24 * MiB,
    duration: 300,
    requestedDuration: 300,
    isSplit: true,
    additionalFiles: [parts[1].filePath],
    parts,
  };
}

function resetState() {
  vi.clearAllMocks();
  limits.maxRecording = 300;
  limits.buffer = 600;
  limits.retryMax = 0;
  settings.autoJoin = true;
  settings.excluded.clear();
  getConnection.mockReturnValue({ channelId: 'voice-1' });
  getConnectedChannelInGuild.mockReturnValue(undefined);
  isAtLimit.mockReturnValue(false);
  connect.mockResolvedValue(null);
  announceBuffering.mockResolvedValue(undefined);
}

describe('executeRecordCommand split delivery', () => {
  beforeEach(() => {
    resetState();
    recordAudio.mockResolvedValue(splitResult());
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('turns the progress message into the result and sends the other parts after it', async () => {
    const interaction = createRecordInteraction(delivered);

    await executeRecordCommand(interaction);

    const result = lastEditEmbed(interaction);
    expect(result.title).toBe(t('record.success', 'en'));
    expect(result.footer?.text).toBe(
      t('record.fileSizeSplit', 'en', { size: '24.00', count: 2 })
    );
    const [edit] = payloadsOf(interaction.editReply);
    expect(edit.files?.[0].name).toBe('recording_part1.wav');

    const [second] = payloadsOf(interaction.followUp);
    expect(second.content).toBe(
      t('record.partLabel', 'en', {
        part: 2,
        total: 2,
        from: '2:30',
        to: '5:00',
      })
    );
    expect(second.files?.[0].name).toBe('recording_part2.wav');
    expect(second.flags).toBe(MessageFlags.Ephemeral);
    expect(interaction.followUp).toHaveBeenCalledTimes(1);
  });

  it('uploads the parts from memory instead of reading them back from disk', async () => {
    const interaction = createRecordInteraction(delivered);

    await executeRecordCommand(interaction);

    const [edit] = payloadsOf(interaction.editReply);
    const [second] = payloadsOf(interaction.followUp);
    const parts = splitResult().parts;
    expect(edit.files?.[0].attachment).toEqual(parts[0].data);
    expect(second.files?.[0].attachment).toEqual(parts[1].data);
  });

  it('labels parts without times when the result carries only paths', async () => {
    recordAudio.mockResolvedValue({
      filePath: '/tmp/recording_part1.wav',
      fileSize: 24 * MiB,
      duration: 300,
      isSplit: true,
      additionalFiles: ['/tmp/recording_part2.wav'],
    });
    const interaction = createRecordInteraction(delivered);

    await executeRecordCommand(interaction);

    const [second] = payloadsOf(interaction.followUp);
    expect(second.content).toBe(
      t('record.partLabelShort', 'en', { part: 2, total: 2 })
    );
    expect(second.files?.[0].attachment).toBe('/tmp/recording_part2.wav');
  });

  it('notifies the user when a split part fails after retries', async () => {
    const interaction = createRecordInteraction(
      uploadsFail(() => new Error('upload failed'))
    );

    await executeRecordCommand(interaction);

    const payloads = payloadsOf(interaction.followUp);
    const warning = payloads[payloads.length - 1];
    expect(warning.flags).toBe(MessageFlags.Ephemeral);
    expect(warning.embeds![0].toJSON().title).toBe(
      t('record.errors.deliveryIncomplete', 'en')
    );
    // The delivered file stays: the result message is not overwritten.
    expect(lastEditEmbed(interaction).title).toBe(t('record.success', 'en'));
  });

  it('does not warn when every split part is delivered', async () => {
    const interaction = createRecordInteraction(delivered);

    await executeRecordCommand(interaction);

    expect(JSON.stringify(payloadsOf(interaction.followUp))).not.toContain(
      t('record.errors.deliveryIncomplete', 'en')
    );
  });

  it('counts the recording so /owner system metrics is not stuck at zero', async () => {
    const before = metrics.getSnapshot().voice;

    await executeRecordCommand(createRecordInteraction(delivered));

    const after = metrics.getSnapshot().voice;
    expect(after.recordings).toBe(before.recordings + 1);
    expect(after.totalSeconds).toBe(before.totalSeconds + 300);
  });

  it('falls back to generic attachment names when a path has no file name', async () => {
    recordAudio.mockResolvedValue({
      filePath: '/tmp/recordings/',
      fileSize: 1024 * 1024,
      duration: 300,
      isSplit: true,
      additionalFiles: ['/tmp/recordings/part/'],
    });
    const interaction = createRecordInteraction(delivered);

    await executeRecordCommand(interaction);

    expect(payloadsOf(interaction.editReply)[0].files?.[0].name).toBe(
      'recording.wav'
    );
    expect(payloadsOf(interaction.followUp)[0].files?.[0].name).toBe(
      'recording_part.wav'
    );
  });

  it('retries a split part and stays quiet once it lands', async () => {
    vi.useFakeTimers();
    limits.retryMax = 1;
    let calls = 0;
    const interaction = createRecordInteraction(async () => {
      calls += 1;
      if (calls === 1) throw new Error('socket hang up');
      return {};
    });

    const run = executeRecordCommand(interaction);
    await vi.runAllTimersAsync();
    await run;

    expect(interaction.followUp).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(payloadsOf(interaction.followUp))).not.toContain(
      t('record.errors.deliveryIncomplete', 'en')
    );
  });

  it('backs off exponentially between split-part retries', async () => {
    vi.useFakeTimers();
    limits.retryMax = 3;
    let calls = 0;
    // The extra part fails three times, then lands. Three retries are needed
    // to tell 1s/2s/4s apart from 1s/2s/3s.
    const interaction = createRecordInteraction(async () => {
      calls += 1;
      if (calls <= 3) throw new Error('socket hang up');
      return {};
    });
    const followUps = () => vi.mocked(interaction.followUp).mock.calls.length;

    const run = executeRecordCommand(interaction);
    for (const [delay, attemptsSoFar] of [
      [1000, 1],
      [2000, 2],
      [4000, 3],
    ] as const) {
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(followUps()).toBe(attemptsSoFar);
      await vi.advanceTimersByTimeAsync(1);
      expect(followUps()).toBe(attemptsSoFar + 1);
    }
    await run;

    expect(followUps()).toBe(4);
  });

  it('does not retry a part Discord rejected outright', async () => {
    limits.retryMax = 3;
    const interaction = createRecordInteraction(
      uploadsFail(() => apiError(413, RESTJSONErrorCodes.RequestEntityTooLarge))
    );

    await executeRecordCommand(interaction);

    // One attempt for the part, then the incomplete-delivery warning.
    const payloads = payloadsOf(interaction.followUp);
    expect(payloads).toHaveLength(2);
    expect(payloads[1].embeds![0].toJSON().title).toBe(
      t('record.errors.deliveryIncomplete', 'en')
    );
  });

  it('warns about missing parts in the caller language', async () => {
    const interaction = createRecordInteraction(
      uploadsFail(() => new Error('upload failed')),
      { locale: 'ja' }
    );

    await executeRecordCommand(interaction);

    const payloads = payloadsOf(interaction.followUp);
    const warning = payloads[payloads.length - 1].embeds![0].toJSON();
    expect(warning.title).toBe(t('record.errors.deliveryIncomplete', 'ja'));
    expect(warning.description).toBe(
      t('record.errors.deliveryIncompleteDesc', 'ja', {
        parts: '2',
        total: 2,
        command: '`/voice record`',
      })
    );
  });

  // Regression: the incomplete-delivery warning used to tell users to retry
  // `/record`, a command that no longer exists; recording is `/voice record`.
  for (const locale of ['en', 'ja'] as const) {
    it(`points ${locale} users at /voice record to retry`, async () => {
      const interaction = createRecordInteraction(
        uploadsFail(() => new Error('upload failed')),
        { locale }
      );

      await executeRecordCommand(interaction);

      const payloads = payloadsOf(interaction.followUp);
      expect(
        payloads[payloads.length - 1].embeds![0].toJSON().description
      ).toContain('`/voice record`');
      expect(t('record.errors.deliveryIncompleteDesc', locale)).not.toContain(
        '`/record`'
      );
    });
  }

  it('lists every part that could not be delivered', async () => {
    const parts = [
      part('recording_part1.wav', 9 * MiB, 0, 100),
      part('recording_part2.wav', 9 * MiB, 100, 200),
      part('recording_part3.wav', 9 * MiB, 200, 300),
    ];
    recordAudio.mockResolvedValue({
      ...splitResult(),
      fileSize: 27 * MiB,
      additionalFiles: [parts[1].filePath, parts[2].filePath],
      parts,
    });
    const interaction = createRecordInteraction(
      uploadsFail(() => new Error('upload failed'))
    );

    await executeRecordCommand(interaction);

    const payloads = payloadsOf(interaction.followUp);
    const warning = payloads[payloads.length - 1].embeds![0].toJSON();
    expect(warning.description).toBe(
      t('record.errors.deliveryIncompleteDesc', 'en', {
        parts: '2, 3',
        total: 3,
        command: '`/voice record`',
      })
    );
  });

  it('does not fail the command when even the error message cannot be sent', async () => {
    const interaction = createRecordInteraction(async () => {
      throw new Error('gone');
    });

    await expect(executeRecordCommand(interaction)).resolves.toBeUndefined();
    expect(logger.debug).toHaveBeenCalledWith(
      'Failed to report a recording failure:',
      'gone'
    );
  });

  it('never overwrites the delivered file when sending the warning fails', async () => {
    let calls = 0;
    const interaction = createRecordInteraction(async () => {
      calls += 1;
      if (calls === 1) throw new Error('upload failed'); // part 2
      if (calls === 2) throw new Error('warning failed'); // the warning
      return {};
    });

    await executeRecordCommand(interaction);

    // The result message with the file is still the last edit.
    expect(lastEditEmbed(interaction).title).toBe(t('record.success', 'en'));
    const last = payloadsOf(interaction.followUp).at(-1)!;
    expect(last.embeds![0].toJSON().title).toBe(
      t('record.errors.failed', 'en')
    );
  });
});

describe('executeRecordCommand', () => {
  beforeEach(() => {
    resetState();
    recordAudio.mockResolvedValue({
      filePath: '/tmp/recording.wav',
      fileSize: 2 * 1024 * 1024,
      duration: 300,
      requestedDuration: 300,
      isSplit: false,
      parts: [part('recording.wav', 2 * MiB, 0, 300)],
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('refusals, answered at once and privately', () => {
    it('refuses outside a guild', async () => {
      const interaction = createRecordInteraction(delivered, {
        hasGuild: false,
      });

      await executeRecordCommand(interaction);

      const embed = replyEmbed(interaction);
      expect(embed.title).toBe(t('common.error', 'en'));
      expect(embed.description).toBe(t('common.guildOnly', 'en'));
      expect(interaction.deferReply).not.toHaveBeenCalled();
      expect(recordAudio).not.toHaveBeenCalled();
    });

    it('refuses when there is no member to read a voice state from', async () => {
      const interaction = createRecordInteraction(delivered, {
        hasMember: false,
      });

      await executeRecordCommand(interaction);

      expect(replyEmbed(interaction).description).toBe(
        t('common.guildOnly', 'en')
      );
      expect(recordAudio).not.toHaveBeenCalled();
    });

    it('asks the caller to join a voice channel first, and gives the cooldown back', async () => {
      const interaction = createRecordInteraction(delivered, {
        voiceChannel: null,
      });

      await executeRecordCommand(interaction);

      const embed = replyEmbed(interaction);
      expect(embed.title).toBe(t('record.errors.notInVoice', 'en'));
      expect(embed.description).toBe(t('record.errors.notInVoiceDesc', 'en'));
      expect(releaseCooldown).toHaveBeenCalledWith(interaction);
    });

    it('answers in the caller language', async () => {
      const interaction = createRecordInteraction(delivered, {
        voiceChannel: null,
        locale: 'ja',
      });

      await executeRecordCommand(interaction);

      expect(replyEmbed(interaction).title).toBe(
        t('record.errors.notInVoice', 'ja')
      );
    });

    it('rejects a channel type that cannot carry voice', async () => {
      const interaction = createRecordInteraction(delivered, {
        voiceChannel: {
          id: 'text-9',
          name: 'chat',
          type: ChannelType.GuildText,
        },
      });

      await executeRecordCommand(interaction);

      expect(replyEmbed(interaction).title).toBe(
        t('record.errors.notInVoice', 'en')
      );
      expect(getConnection).not.toHaveBeenCalled();
    });

    it('says the bot state is unknown when its member is not cached', async () => {
      const interaction = createRecordInteraction(delivered, {
        botMember: null,
      });

      await executeRecordCommand(interaction);

      expect(replyEmbed(interaction).description).toBe(
        t('record.errors.botUnavailable', 'en')
      );
      expect(recordAudio).not.toHaveBeenCalled();
    });

    it.each([
      ['cannot attach files', [PermissionFlagsBits.ViewChannel]],
      ['cannot view the channel', [PermissionFlagsBits.AttachFiles]],
      ['has no resolvable permissions', null],
    ])(
      'refuses before recording when the bot %s, naming the channel',
      async (_label, granted: bigint[] | null) => {
        const interaction = createRecordInteraction(delivered, { granted });

        await executeRecordCommand(interaction);

        const embed = replyEmbed(interaction);
        expect(embed.title).toBe(t('record.errors.noPermission', 'en'));
        expect(embed.description).toBe(
          t('record.errors.noPermissionDesc', 'en', { channel: 'text-1' })
        );
        expect(recordAudio).not.toHaveBeenCalled();
      }
    );

    it('skips the permission check where the channel cannot report one', async () => {
      const interaction = createRecordInteraction(delivered, { channel: null });

      await executeRecordCommand(interaction);

      expect(recordAudio).toHaveBeenCalled();
    });

    it('rejects a duration it cannot parse', async () => {
      const interaction = createRecordInteraction(delivered, {
        duration: 'soon',
      });

      await executeRecordCommand(interaction);

      const embed = replyEmbed(interaction);
      expect(embed.title).toBe(t('record.errors.invalidDuration', 'en'));
      expect(embed.description).toBe(
        t('record.errors.invalidDurationDesc', 'en')
      );
      expect(releaseCooldown).toHaveBeenCalled();
      expect(recordAudio).not.toHaveBeenCalled();
    });

    it('rejects a duration above the recording maximum, in words', async () => {
      const interaction = createRecordInteraction(delivered, {
        duration: '6m',
      });

      await executeRecordCommand(interaction);

      const embed = replyEmbed(interaction);
      expect(embed.title).toBe(t('record.errors.durationTooLong', 'en'));
      expect(embed.description).toBe(
        t('record.errors.durationTooLongDesc', 'en', { max: '5 minutes' })
      );
      expect(recordAudio).not.toHaveBeenCalled();
    });

    it('accepts a duration exactly at the recording maximum', async () => {
      await executeRecordCommand(
        createRecordInteraction(delivered, { duration: '5m' })
      );

      expect(recordAudio).toHaveBeenCalledWith(
        expect.objectContaining({ duration: 300 })
      );
    });

    it('rejects a duration longer than the audio actually kept', async () => {
      limits.maxRecording = 600;
      limits.buffer = 60;
      const interaction = createRecordInteraction(delivered, {
        duration: '5m',
        locale: 'ja',
      });

      await executeRecordCommand(interaction);

      const embed = replyEmbed(interaction);
      expect(embed.title).toBe(t('record.errors.durationExceedsBuffer', 'ja'));
      expect(embed.description).toBe(
        t('record.errors.durationExceedsBufferDesc', 'ja', { buffer: '1分' })
      );
      expect(recordAudio).not.toHaveBeenCalled();
    });

    it('accepts a duration exactly as long as the buffer', async () => {
      limits.buffer = 300;

      await executeRecordCommand(createRecordInteraction(delivered));

      expect(recordAudio).toHaveBeenCalled();
    });
  });

  describe('when the bot is not keeping that channel', () => {
    beforeEach(() => {
      getConnection.mockReturnValue(undefined);
    });

    function notBufferedDescription(interaction: ChatInputCommandInteraction) {
      const embed = replyEmbed(interaction);
      expect(embed.title).toBe(t('record.errors.notBuffered', 'en'));
      expect(recordAudio).not.toHaveBeenCalled();
      expect(releaseCooldown).toHaveBeenCalledWith(interaction);
      return embed.description;
    }

    const beforeJoin = () => t('record.notBuffered.beforeJoinNote', 'en');

    it('explains that auto-join is off and how to turn it on', async () => {
      settings.autoJoin = false;
      const interaction = createRecordInteraction(delivered);

      await executeRecordCommand(interaction);

      expect(notBufferedDescription(interaction)).toBe(
        `${t('record.notBuffered.autoJoinOff', 'en', {
          command: '`/voice autojoin enable`',
        })}\n${beforeJoin()}`
      );
      expect(connect).not.toHaveBeenCalled();
    });

    it('explains that the channel is excluded', async () => {
      settings.excluded.add('voice-1');
      const interaction = createRecordInteraction(delivered);

      await executeRecordCommand(interaction);

      expect(notBufferedDescription(interaction)).toContain(
        t('record.notBuffered.excluded', 'en', {
          channel: 'voice-1',
          command: '`/voice autojoin include`',
        })
      );
    });

    it('names the other channel when the bot is busy elsewhere in the server', async () => {
      getConnectedChannelInGuild.mockReturnValue('voice-2');
      const interaction = createRecordInteraction(delivered);

      await executeRecordCommand(interaction);

      expect(notBufferedDescription(interaction)).toContain(
        t('record.notBuffered.busyElsewhere', 'en', { other: 'voice-2' })
      );
      expect(connect).not.toHaveBeenCalled();
    });

    it('explains a text-to-speech-only connection keeps nothing', async () => {
      getConnection.mockReturnValue({ channelId: 'voice-1', receiving: false });
      getConnectedChannelInGuild.mockReturnValue('voice-1');
      const interaction = createRecordInteraction(delivered);

      await executeRecordCommand(interaction);

      expect(notBufferedDescription(interaction)).toContain(
        t('record.notBuffered.readOnly', 'en', { channel: 'voice-1' })
      );
    });

    it('explains the bot is at its connection limit', async () => {
      isAtLimit.mockReturnValue(true);
      const interaction = createRecordInteraction(delivered);

      await executeRecordCommand(interaction);

      expect(notBufferedDescription(interaction)).toContain(
        t('record.notBuffered.atLimit', 'en', { max: 4 })
      );
    });

    it('names the missing voice permission', async () => {
      const interaction = createRecordInteraction(delivered, {
        voiceGranted: [PermissionFlagsBits.ViewChannel],
      });

      await executeRecordCommand(interaction);

      expect(notBufferedDescription(interaction)).toContain(
        t('record.notBuffered.noPermission', 'en', { channel: 'voice-1' })
      );
      expect(connect).not.toHaveBeenCalled();
    });

    it('joins now when nothing stands in the way, and says only later audio can be saved', async () => {
      connect.mockResolvedValue({ joined: true });
      const interaction = createRecordInteraction(delivered);

      await executeRecordCommand(interaction);

      expect(connect).toHaveBeenCalledTimes(1);
      expect(announceBuffering).toHaveBeenCalledTimes(1);
      const embed = replyEmbed(interaction);
      expect(embed.title).toBe(t('record.notBuffered.startedTitle', 'en'));
      expect(embed.description).toBe(
        `${t('record.notBuffered.startedNow', 'en')}\n${beforeJoin()}`
      );
      expect(recordAudio).not.toHaveBeenCalled();
      expect(releaseCooldown).toHaveBeenCalledWith(interaction);
    });

    it('falls back to "not joined yet" when joining now fails', async () => {
      connect.mockResolvedValue(null);
      const interaction = createRecordInteraction(delivered);

      await executeRecordCommand(interaction);

      expect(notBufferedDescription(interaction)).toContain(
        t('record.notBuffered.notYetJoined', 'en')
      );
      expect(announceBuffering).not.toHaveBeenCalled();
    });
  });

  describe('recording', () => {
    it("records the caller's channel and turns the progress message into the result", async () => {
      const interaction = createRecordInteraction(delivered, {
        duration: '30s',
        attachmentSizeLimit: 25 * MiB,
      });

      await executeRecordCommand(interaction);

      const progress = replyEmbed(interaction);
      expect(progress.title).toBe(t('record.recording', 'en'));
      expect(progress.description).toBe(
        `${t('record.recordingDesc', 'en', { duration: '30 seconds' })}\n\n${t(
          'record.inProgressNote',
          'en'
        )}`
      );
      expect(progress.color).not.toBe(COLORS.WARNING);
      expect(interaction.deferReply).not.toHaveBeenCalled();

      expect(recordAudio).toHaveBeenCalledWith({
        duration: 30,
        channelId: 'voice-1',
        userId: 'user-1',
        guildId: 'guild-1',
        maxUploadBytes: 25 * MiB,
      });

      expect(interaction.followUp).not.toHaveBeenCalled();
      const [edit] = payloadsOf(interaction.editReply);
      expect(edit.files).toHaveLength(1);
      expect(edit.files?.[0].name).toBe('recording.wav');
      const embed = edit.embeds![0].toJSON();
      expect(embed.title).toBe(t('record.success', 'en'));
      expect(embed.footer?.text).toBe(
        t('record.fileSize', 'en', { size: '2.00' })
      );
      expect(embed.description).toContain(t('record.saveWarning', 'en'));
    });

    it('splits for the fallback limit when the interaction carries none', async () => {
      await executeRecordCommand(createRecordInteraction(delivered));

      expect(recordAudio).toHaveBeenCalledWith(
        expect.objectContaining({
          maxUploadBytes: DISCORD_LIMITS.FALLBACK_ATTACHMENT_BYTES,
        })
      );
    });

    it('says how much was saved when the bot had not been listening long enough', async () => {
      recordAudio.mockResolvedValue({
        filePath: '/tmp/recording.wav',
        fileSize: 1024,
        duration: 40,
        requestedDuration: 300,
        isSplit: false,
        parts: [part('recording.wav', 1024, 0, 40)],
      });
      const interaction = createRecordInteraction(delivered, { locale: 'ja' });

      await executeRecordCommand(interaction);

      const { description } = lastEditEmbed(interaction);
      expect(description).toContain(
        t('record.successDesc', 'ja', { duration: '40秒' })
      );
      expect(description).toContain(
        t('record.trimmedNote', 'ja', { available: '40秒' })
      );
    });

    it('names the attachment from a Windows-style path', async () => {
      recordAudio.mockResolvedValue({
        filePath: 'C:\\recordings\\guild-1\\take.wav',
        fileSize: 1024 * 1024,
        duration: 300,
        isSplit: false,
      });
      const interaction = createRecordInteraction(delivered);

      await executeRecordCommand(interaction);

      expect(payloadsOf(interaction.editReply)[0].files?.[0].name).toBe(
        'take.wav'
      );
    });

    it('retries the main file with exponential backoff', async () => {
      vi.useFakeTimers();
      limits.retryMax = 2;
      const interaction = createRecordInteraction(delivered);
      vi.mocked(interaction.editReply)
        .mockRejectedValueOnce(new Error('socket hang up'))
        .mockResolvedValue({} as never);

      const run = executeRecordCommand(interaction);
      await vi.advanceTimersByTimeAsync(999);
      expect(interaction.editReply).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      await run;

      expect(interaction.editReply).toHaveBeenCalledTimes(2);
      expect(lastEditEmbed(interaction).title).toBe(t('record.success', 'en'));
    });

    it('does not retry an upload Discord rejects as too large, and says so', async () => {
      limits.retryMax = 3;
      const interaction = createRecordInteraction(delivered, {
        attachmentSizeLimit: 10 * MiB,
      });
      vi.mocked(interaction.editReply)
        .mockRejectedValueOnce(
          apiError(413, RESTJSONErrorCodes.RequestEntityTooLarge)
        )
        .mockResolvedValue({} as never);

      await executeRecordCommand(interaction);

      // One upload attempt, then the error edit.
      expect(interaction.editReply).toHaveBeenCalledTimes(2);
      const embed = lastEditEmbed(interaction);
      expect(embed.title).toBe(t('record.errors.tooLarge', 'en'));
      expect(embed.description).toBe(
        t('record.errors.tooLargeDesc', 'en', {
          size: '2.00',
          limit: 10,
          command: '`/voice record`',
        })
      );
    });

    it('treats an HTML 413 from the edge as too large as well', async () => {
      limits.retryMax = 3;
      const interaction = createRecordInteraction(delivered);
      vi.mocked(interaction.editReply)
        .mockRejectedValueOnce(
          new HTTPError(413, 'Payload Too Large', 'POST', '/x', {})
        )
        .mockResolvedValue({} as never);

      await executeRecordCommand(interaction);

      expect(interaction.editReply).toHaveBeenCalledTimes(2);
      expect(lastEditEmbed(interaction).title).toBe(
        t('record.errors.tooLarge', 'en')
      );
    });

    it('reports a permission rejection from Discord as the permission problem', async () => {
      const interaction = createRecordInteraction(delivered);
      vi.mocked(interaction.editReply)
        .mockRejectedValueOnce(
          apiError(403, RESTJSONErrorCodes.MissingPermissions)
        )
        .mockResolvedValue({} as never);

      await executeRecordCommand(interaction);

      expect(lastEditEmbed(interaction).description).toBe(
        t('record.errors.noPermissionDesc', 'en', { channel: 'text-1' })
      );
    });

    it('reports a failure with an error id, keeping the raw error in the log only', async () => {
      const interaction = createRecordInteraction(delivered);
      vi.mocked(interaction.editReply)
        .mockRejectedValueOnce(new Error('socket hang up'))
        .mockResolvedValue({} as never);

      await executeRecordCommand(interaction);

      const embed = lastEditEmbed(interaction);
      expect(embed.title).toBe(t('record.errors.failed', 'en'));
      const id = embed.description?.match(/`([0-9a-f]{6})`/)?.[1];
      expect(id).toBeDefined();
      expect(embed.description).toBe(
        t('record.errors.failedDesc', 'en', { id: id! })
      );
      expect(embed.description).not.toContain('socket hang up');
      expect(logger.error).toHaveBeenCalledWith(
        `[${id}] Recording failed for channel voice-1:`,
        expect.stringContaining('socket hang up')
      );
    });

    it('does not leak server file paths in the error shown to users', async () => {
      recordAudio.mockRejectedValue(
        new Error(
          "ENOENT: open '/var/lib/bot/recordings/a.wav' or C:\\Users\\bot\\b.wav"
        )
      );
      const interaction = createRecordInteraction(delivered);

      await executeRecordCommand(interaction);

      const { description } = lastEditEmbed(interaction);
      expect(description).not.toContain('/var/lib');
      expect(description).not.toContain('Users');
    });

    it('reports non-Error rejections as well', async () => {
      recordAudio.mockRejectedValue('disk full');
      const interaction = createRecordInteraction(delivered);

      await executeRecordCommand(interaction);

      expect(lastEditEmbed(interaction).title).toBe(
        t('record.errors.failed', 'en')
      );
    });

    it('says another recording is being saved instead of showing an internal message', async () => {
      recordAudio.mockRejectedValue(new RecordingInProgressError());
      const interaction = createRecordInteraction(delivered, { locale: 'ja' });

      await executeRecordCommand(interaction);

      const embed = lastEditEmbed(interaction);
      expect(embed.title).toBe(t('record.errors.busy', 'ja'));
      expect(embed.description).toBe(t('record.errors.busyDesc', 'ja'));
      expect(releaseCooldown).toHaveBeenCalledWith(interaction);
    });

    it('says the window was silent instead of sending an empty file', async () => {
      recordAudio.mockRejectedValue(new RecordingNoAudibleAudioError());
      const before = metrics.getSnapshot().voice.recordings;
      const interaction = createRecordInteraction(delivered, {
        duration: '1m',
      });

      await executeRecordCommand(interaction);

      const embed = lastEditEmbed(interaction);
      expect(embed.title).toBe(t('record.errors.noAudibleAudio', 'en'));
      expect(embed.description).toBe(
        `${t('record.errors.noAudibleAudioDesc', 'en', {
          duration: '1 minute',
        })}\n${t('record.errors.noAudibleAudioLongerHint', 'en')}`
      );
      expect(interaction.followUp).not.toHaveBeenCalled();
      expect(metrics.getSnapshot().voice.recordings).toBe(before);
    });

    it('names the length actually checked, and offers no longer window, when the bot has not heard that long', async () => {
      // Asked for 1 minute; the bot had only been hearing the channel 13 s.
      recordAudio.mockRejectedValue(new RecordingNoAudibleAudioError(13));
      const interaction = createRecordInteraction(delivered, {
        duration: '1m',
      });

      await executeRecordCommand(interaction);

      expect(lastEditEmbed(interaction).description).toBe(
        t('record.errors.noAudibleAudioDesc', 'en', { duration: '13 seconds' })
      );
    });

    it('offers no longer window when the bot has heard nothing yet', async () => {
      recordAudio.mockRejectedValue(new RecordingNoAudibleAudioError(0));
      const interaction = createRecordInteraction(delivered, {
        duration: '30s',
      });

      await executeRecordCommand(interaction);

      expect(lastEditEmbed(interaction).description).toBe(
        t('record.errors.noAudibleAudioDesc', 'en', { duration: '30 seconds' })
      );
    });

    it('does not suggest a longer window when the longest one was silent', async () => {
      recordAudio.mockRejectedValue(new RecordingNoAudibleAudioError());
      const interaction = createRecordInteraction(delivered, {
        duration: '5m',
      });

      await executeRecordCommand(interaction);

      expect(lastEditEmbed(interaction).description).toBe(
        t('record.errors.noAudibleAudioDesc', 'en', { duration: '5 minutes' })
      );
    });
  });
});
