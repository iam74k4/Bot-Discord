import {
  type AttachmentBuilder,
  ChannelType,
  ChatInputCommandInteraction,
  type EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits,
} from 'discord.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const getConnection = vi.hoisted(() => vi.fn());
const recordAudio = vi.hoisted(() => vi.fn());

/** Mutable so individual tests can probe the limit and retry boundaries. */
const limits = vi.hoisted(() => ({
  maxRecording: 300,
  buffer: 600,
  retryMax: 0,
}));

vi.mock('../recording/connectionManager.js', () => ({
  connectionManager: {
    getConnection,
  },
}));

vi.mock('../recording/recordingService.js', () => ({
  parseDurationString: (value: string) => {
    const seconds: Record<string, number> = { '30s': 30, '5m': 300, '6m': 360 };
    if (value in seconds) return seconds[value];
    throw new Error('Invalid duration format');
  },
  recordAudio,
  RecordingNoAudibleAudioError: class RecordingNoAudibleAudioError extends Error {
    constructor() {
      super('No audible audio');
      this.name = 'RecordingNoAudibleAudioError';
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
import { RecordingNoAudibleAudioError } from '../recording/recordingService.js';
import { metrics } from '../../../infrastructure/metrics/index.js';
import { t } from '../../../locales/index.js';

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
}

function createRecordInteraction(
  followUpImpl: (payload: unknown) => Promise<unknown>,
  options: RecordInteractionOptions = {}
): ChatInputCommandInteraction {
  const voiceChannel =
    options.voiceChannel === undefined
      ? { id: 'voice-1', name: 'General', type: ChannelType.GuildVoice }
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
    // No guildId keeps locale resolution off the database.
    guildId: null,
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

function replyEmbed(interaction: ChatInputCommandInteraction) {
  expect(interaction.reply).toHaveBeenCalledTimes(1);
  const [payload] = payloadsOf(interaction.reply);
  expect(payload.flags).toBe(MessageFlags.Ephemeral);
  return payload.embeds![0].toJSON();
}

describe('executeRecordCommand split delivery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    limits.maxRecording = 300;
    limits.buffer = 600;
    limits.retryMax = 0;
    getConnection.mockReturnValue({ channelId: 'voice-1' });
    recordAudio.mockResolvedValue({
      filePath: '/tmp/recording_part1.wav',
      fileSize: 24 * 1024 * 1024,
      duration: 300,
      isSplit: true,
      additionalFiles: ['/tmp/recording_part2.wav'],
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('notifies the user when a split part fails after retries', async () => {
    let followUpCalls = 0;
    const interaction = createRecordInteraction(async () => {
      followUpCalls += 1;
      if (followUpCalls === 1) {
        return {};
      }
      throw new Error('upload failed');
    });

    await executeRecordCommand(interaction);

    const payloads = vi
      .mocked(interaction.followUp)
      .mock.calls.map(([payload]) => payload as Record<string, unknown>);

    const incomplete = payloads.find(
      (payload) =>
        Array.isArray(payload.embeds) &&
        JSON.stringify(payload.embeds).includes('Delivery Incomplete')
    );

    expect(incomplete).toBeDefined();
    expect(incomplete?.flags).toBe(MessageFlags.Ephemeral);
  });

  it('does not warn when every split part is delivered', async () => {
    const interaction = createRecordInteraction(async () => ({}));

    await executeRecordCommand(interaction);

    const payloads = vi
      .mocked(interaction.followUp)
      .mock.calls.map(([payload]) => payload as Record<string, unknown>);
    const incomplete = payloads.find(
      (payload) =>
        Array.isArray(payload.embeds) &&
        JSON.stringify(payload.embeds).includes('Delivery Incomplete')
    );

    expect(incomplete).toBeUndefined();
    expect(interaction.followUp).toHaveBeenCalledTimes(2);
  });

  it('counts the recording so /owner system metrics is not stuck at zero', async () => {
    const before = metrics.getSnapshot().voice;

    await executeRecordCommand(createRecordInteraction(async () => ({})));

    const after = metrics.getSnapshot().voice;
    expect(after.recordings).toBe(before.recordings + 1);
    expect(after.totalSeconds).toBe(before.totalSeconds + 300);
  });

  it('labels each extra part and names the split in the footer', async () => {
    const interaction = createRecordInteraction(delivered);

    await executeRecordCommand(interaction);

    const [main, part] = payloadsOf(interaction.followUp);
    expect(main.embeds![0].toJSON().footer?.text).toBe(
      'File size: 24.00MB (split into 2 files)'
    );
    expect(main.files?.[0].name).toBe('recording_part1.wav');
    expect(part.content).toBe('Part 2/2');
    expect(part.files?.[0].name).toBe('recording_part2.wav');
    expect(part.flags).toBe(MessageFlags.Ephemeral);
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

    const [main, part] = payloadsOf(interaction.followUp);
    expect(main.files?.[0].name).toBe('recording.wav');
    expect(part.files?.[0].name).toBe('recording_part.wav');
  });

  it('retries a split part and stays quiet once it lands', async () => {
    vi.useFakeTimers();
    limits.retryMax = 1;
    let calls = 0;
    const interaction = createRecordInteraction(async () => {
      calls += 1;
      if (calls === 2) throw new Error('rate limited');
      return {};
    });

    const run = executeRecordCommand(interaction);
    await vi.runAllTimersAsync();
    await run;

    const payloads = payloadsOf(interaction.followUp);
    expect(payloads).toHaveLength(3);
    expect(payloads[2].content).toBe('Part 2/2');
    expect(JSON.stringify(payloads)).not.toContain(
      t('record.errors.deliveryIncomplete', 'en')
    );
  });

  it('lists every part that could not be delivered', async () => {
    recordAudio.mockResolvedValue({
      filePath: '/tmp/recording_part1.wav',
      fileSize: 30 * 1024 * 1024,
      duration: 300,
      isSplit: true,
      additionalFiles: ['/tmp/recording_part2.wav', '/tmp/recording_part3.wav'],
    });
    let calls = 0;
    const interaction = createRecordInteraction(async () => {
      calls += 1;
      if (calls === 1) return {};
      if (calls <= 3) throw new Error('upload failed');
      return {};
    });

    await executeRecordCommand(interaction);

    const payloads = payloadsOf(interaction.followUp);
    const warning = payloads[payloads.length - 1].embeds![0].toJSON();
    expect(warning.title).toBe(t('record.errors.deliveryIncomplete', 'en'));
    expect(warning.description).toBe(
      t('record.errors.deliveryIncompleteDesc', 'en', {
        parts: '2, 3',
        total: 3,
      })
    );
  });
});

describe('executeRecordCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    limits.maxRecording = 300;
    limits.buffer = 600;
    limits.retryMax = 0;
    getConnection.mockReturnValue({ channelId: 'voice-1' });
    recordAudio.mockResolvedValue({
      filePath: '/tmp/recording.wav',
      fileSize: 2 * 1024 * 1024,
      duration: 300,
      isSplit: false,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('before deferring', () => {
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

    it('asks the caller to join a voice channel first', async () => {
      const interaction = createRecordInteraction(delivered, {
        voiceChannel: null,
      });

      await executeRecordCommand(interaction);

      const embed = replyEmbed(interaction);
      expect(embed.title).toBe(t('record.errors.notInVoice', 'en'));
      expect(embed.description).toBe(t('record.errors.notInVoiceDesc', 'en'));
      expect(interaction.deferReply).not.toHaveBeenCalled();
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
  });

  describe('after deferring', () => {
    it('defers privately and explains when the bot is not buffering that channel', async () => {
      getConnection.mockReturnValue(undefined);
      const interaction = createRecordInteraction(delivered);

      await executeRecordCommand(interaction);

      expect(interaction.deferReply).toHaveBeenCalledWith({
        flags: MessageFlags.Ephemeral,
      });
      expect(getConnection).toHaveBeenCalledWith('voice-1');
      const embed = lastEditEmbed(interaction);
      expect(embed.title).toBe(t('record.errors.botNotInVoice', 'en'));
      expect(embed.description).toBe(
        t('record.errors.botNotInVoiceDesc', 'en')
      );
      expect(recordAudio).not.toHaveBeenCalled();
    });

    it('treats an uncached bot member as not connected', async () => {
      const interaction = createRecordInteraction(delivered, {
        botMember: null,
      });

      await executeRecordCommand(interaction);

      expect(lastEditEmbed(interaction).title).toBe(
        t('record.errors.botNotInVoice', 'en')
      );
      expect(recordAudio).not.toHaveBeenCalled();
    });

    it.each([
      ['cannot attach files', [PermissionFlagsBits.ViewChannel]],
      ['cannot view the channel', [PermissionFlagsBits.AttachFiles]],
      ['has no resolvable permissions', null],
    ])(
      'refuses before recording when the bot %s',
      async (_label, granted: bigint[] | null) => {
        const interaction = createRecordInteraction(delivered, { granted });

        await executeRecordCommand(interaction);

        const embed = lastEditEmbed(interaction);
        expect(embed.title).toBe(t('record.errors.noPermission', 'en'));
        expect(embed.description).toBe(
          t('record.errors.noPermissionDesc', 'en')
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

      const embed = lastEditEmbed(interaction);
      expect(embed.title).toBe(t('record.errors.invalidDuration', 'en'));
      expect(embed.description).toBe(
        t('record.errors.invalidDurationDesc', 'en')
      );
      expect(recordAudio).not.toHaveBeenCalled();
    });

    it('rejects a duration above the recording maximum', async () => {
      const interaction = createRecordInteraction(delivered, {
        duration: '6m',
      });

      await executeRecordCommand(interaction);

      const embed = lastEditEmbed(interaction);
      expect(embed.title).toBe(t('record.errors.durationTooLong', 'en'));
      expect(embed.description).toBe(
        t('record.errors.durationTooLongDesc', 'en', { max: 300 })
      );
      expect(recordAudio).not.toHaveBeenCalled();
    });

    it('accepts a duration exactly at the recording maximum', async () => {
      limits.maxRecording = 300;

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
      });

      await executeRecordCommand(interaction);

      const embed = lastEditEmbed(interaction);
      expect(embed.title).toBe(t('record.errors.durationExceedsBuffer', 'en'));
      expect(embed.description).toBe(
        t('record.errors.durationExceedsBufferDesc', 'en', { buffer: 60 })
      );
      expect(recordAudio).not.toHaveBeenCalled();
    });

    it('accepts a duration exactly as long as the buffer', async () => {
      limits.buffer = 300;

      await executeRecordCommand(createRecordInteraction(delivered));

      expect(recordAudio).toHaveBeenCalled();
    });
  });

  describe('recording', () => {
    it("records the caller's channel and delivers one private file", async () => {
      const interaction = createRecordInteraction(delivered, {
        duration: '30s',
      });

      await executeRecordCommand(interaction);

      const [progress] = payloadsOf(interaction.editReply);
      expect(progress.embeds![0].toJSON().title).toBe(
        t('record.recording', 'en')
      );
      expect(progress.embeds![0].toJSON().description).toBe(
        `${t('record.recordingDesc', 'en', { duration: '30s' })}\n\n${t('record.durationNote', 'en')}`
      );

      expect(recordAudio).toHaveBeenCalledWith({
        duration: 30,
        channelId: 'voice-1',
        userId: 'user-1',
        guildId: 'guild-1',
      });

      expect(interaction.followUp).toHaveBeenCalledTimes(1);
      const [result] = payloadsOf(interaction.followUp);
      expect(result.flags).toBe(MessageFlags.Ephemeral);
      expect(result.files).toHaveLength(1);
      expect(result.files?.[0].name).toBe('recording.wav');
      const embed = result.embeds![0].toJSON();
      expect(embed.title).toBe(t('record.success', 'en'));
      expect(embed.footer?.text).toBe('File size: 2.00MB');
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

      expect(payloadsOf(interaction.followUp)[0].files?.[0].name).toBe(
        'take.wav'
      );
    });

    it('retries the main file with exponential backoff', async () => {
      vi.useFakeTimers();
      limits.retryMax = 2;
      let calls = 0;
      const interaction = createRecordInteraction(async () => {
        calls += 1;
        if (calls === 1) throw new Error('rate limited');
        return {};
      });

      const run = executeRecordCommand(interaction);
      await vi.advanceTimersByTimeAsync(999);
      expect(interaction.followUp).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      await run;

      expect(interaction.followUp).toHaveBeenCalledTimes(2);
      expect(lastEditEmbed(interaction).title).toBe(
        t('record.recording', 'en')
      );
    });

    it('reports a failure once the main file cannot be delivered', async () => {
      const interaction = createRecordInteraction(async () => {
        throw new Error('upload failed');
      });

      await executeRecordCommand(interaction);

      const embed = lastEditEmbed(interaction);
      expect(embed.title).toBe(t('record.errors.failed', 'en'));
      expect(embed.description).toBe(
        t('record.errors.failedDesc', 'en', { error: 'upload failed' })
      );
    });

    it('says the window was silent instead of sending an empty file', async () => {
      recordAudio.mockRejectedValue(new RecordingNoAudibleAudioError());
      const before = metrics.getSnapshot().voice.recordings;
      const interaction = createRecordInteraction(delivered);

      await executeRecordCommand(interaction);

      const embed = lastEditEmbed(interaction);
      expect(embed.title).toBe(t('record.errors.noAudibleAudio', 'en'));
      expect(embed.description).toBe(
        t('record.errors.noAudibleAudioDesc', 'en')
      );
      expect(interaction.followUp).not.toHaveBeenCalled();
      expect(metrics.getSnapshot().voice.recordings).toBe(before);
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
      expect(description).toContain('[path]');
      expect(description).not.toContain('/var/lib');
      expect(description).not.toContain('Users');
    });

    it('reports non-Error rejections as well', async () => {
      recordAudio.mockRejectedValue('disk full');
      const interaction = createRecordInteraction(delivered);

      await executeRecordCommand(interaction);

      expect(lastEditEmbed(interaction).description).toBe(
        t('record.errors.failedDesc', 'en', { error: 'disk full' })
      );
    });
  });
});
