import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VoiceState } from 'discord.js';
import {
  createMockClient,
  createMockGuild,
  createMockUser,
} from '../../../__tests__/helpers/discord.js';

const startSession = vi.fn();
const endSession = vi.fn();
const getEnabled = vi.fn();
const getSendableTextChannel = vi.fn();
const send = vi.fn();

vi.mock('../tracking/voiceTracker.js', () => ({
  voiceTracker: {
    startSession,
    endSession,
  },
}));

vi.mock('../repositories/notificationChannelRepository.js', () => ({
  notificationChannelRepository: {
    getEnabled,
  },
}));

vi.mock('../../../shared/utils/discord.js', () => ({
  getSendableTextChannel,
}));

vi.mock('../../../shared/utils/logger.js', () => ({
  logger: {
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
  },
  getErrorMessage: (error: unknown) =>
    error instanceof Error ? error.message : String(error),
}));

vi.mock('../../../locales/index.js', () => ({
  mapDiscordLocale: () => 'en',
  t: (key: string) => key,
}));

// The real resolver reads guild_settings, which would open the on-disk test
// database. These tests are about session order and batching, not language.
vi.mock('../../../locales/guildLocale.js', () => ({
  resolveGuildLocale: (_guildId: unknown, fallback: string) => fallback,
}));

function createVoiceState(overrides: {
  channelId?: string | null;
  channelName?: string;
  userId?: string;
  bot?: boolean;
}): VoiceState {
  const guild = createMockGuild({ preferredLocale: 'en-US' } as never);
  const user = createMockUser({
    id: overrides.userId ?? 'user-1',
    bot: overrides.bot ?? false,
  });
  const channel =
    overrides.channelId == null
      ? null
      : ({
          id: overrides.channelId,
          name: overrides.channelName ?? `channel-${overrides.channelId}`,
        } as VoiceState['channel']);

  return {
    guild,
    channel,
    member: {
      user,
      displayName: user.displayName,
    },
  } as unknown as VoiceState;
}

describe('voiceNotification event', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    // Digest windows are module state keyed by guild; a window left open by
    // one test would silently swallow the next test's first notification.
    const { resetVoiceDigests } =
      await import('../events/voiceNotification.js');
    resetVoiceDigests();
    getEnabled.mockReturnValue('notify-channel');
    getSendableTextChannel.mockResolvedValue({ send });
    send.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    const { resetVoiceDigests } =
      await import('../events/voiceNotification.js');
    resetVoiceDigests();
  });

  it('completes move session transition before awaiting leave notification', async () => {
    const { event } = await import('../events/voiceNotification.js');
    const client = Object.assign(createMockClient(), { isFullyReady: true });

    let releaseLeaveSend!: () => void;
    const leaveSendGate = new Promise<void>((resolve) => {
      releaseLeaveSend = resolve;
    });

    let sendCalls = 0;
    send.mockImplementation(() => {
      sendCalls += 1;
      if (sendCalls === 1) {
        return leaveSendGate;
      }
      return Promise.resolve(undefined);
    });

    const order: string[] = [];
    endSession.mockImplementation(() => {
      order.push('endSession');
    });
    startSession.mockImplementation(() => {
      order.push('startSession');
    });

    const oldState = createVoiceState({
      channelId: 'vc-a',
      channelName: 'A',
    });
    const newState = createVoiceState({
      channelId: 'vc-b',
      channelName: 'B',
    });

    const movePromise = event.execute(client as never, oldState, newState);

    // Flush microtasks so handleMove reaches the first awaited Discord send.
    await Promise.resolve();
    await Promise.resolve();

    // Session transition must be done before the first Discord send resolves.
    expect(order).toEqual(['endSession', 'startSession']);
    expect(endSession).toHaveBeenCalledWith(oldState.guild.id, 'user-1');
    expect(startSession).toHaveBeenCalledWith(
      newState.guild.id,
      'user-1',
      'vc-b',
      'B'
    );
    expect(sendCalls).toBe(1);

    // Concurrent leave while leave-notify is in flight ends the already-started
    // destination session instead of racing ahead of startSession.
    endSession.mockClear();
    const leaveState = createVoiceState({
      channelId: 'vc-b',
      channelName: 'B',
    });
    const emptyState = createVoiceState({ channelId: null });
    await event.execute(client as never, leaveState, emptyState);
    expect(endSession).toHaveBeenCalledWith(leaveState.guild.id, 'user-1');

    releaseLeaveSend();
    await movePromise;

    // Move must not call startSession again after the concurrent leave.
    expect(startSession).toHaveBeenCalledTimes(1);
  });

  it('starts a session on join before sending the join notification', async () => {
    const { event } = await import('../events/voiceNotification.js');
    const client = Object.assign(createMockClient(), { isFullyReady: true });

    const order: string[] = [];
    startSession.mockImplementation(() => {
      order.push('startSession');
    });
    send.mockImplementation(async () => {
      order.push('send');
    });

    const oldState = createVoiceState({ channelId: null });
    const newState = createVoiceState({
      channelId: 'vc-a',
      channelName: 'A',
    });

    await event.execute(client as never, oldState, newState);

    expect(order).toEqual(['startSession', 'send']);
  });
});

describe('voice notification batching', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    const { resetVoiceDigests } =
      await import('../events/voiceNotification.js');
    resetVoiceDigests();
    getEnabled.mockReturnValue('notify-channel');
    getSendableTextChannel.mockResolvedValue({ send });
    send.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    const { resetVoiceDigests } =
      await import('../events/voiceNotification.js');
    resetVoiceDigests();
    vi.useRealTimers();
  });

  async function joinVoice(
    client: unknown,
    userId: string,
    channelId: string
  ): Promise<void> {
    const { event } = await import('../events/voiceNotification.js');
    await event.execute(
      client as never,
      createVoiceState({ channelId: null, userId }),
      createVoiceState({ channelId, userId })
    );
  }

  it('announces the first change immediately and batches the rest', async () => {
    const client = Object.assign(createMockClient(), { isFullyReady: true });

    await joinVoice(client, 'user-1', 'vc-a');
    expect(send).toHaveBeenCalledTimes(1);

    // Four more people pile in during the window: still one message, later.
    await joinVoice(client, 'user-2', 'vc-a');
    await joinVoice(client, 'user-3', 'vc-a');
    await joinVoice(client, 'user-4', 'vc-a');
    await joinVoice(client, 'user-5', 'vc-a');
    expect(send).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(send).toHaveBeenCalledTimes(2);

    const digest = send.mock.calls[1][0] as {
      embeds: Array<{ data: { description: string } }>;
    };
    const description = digest.embeds[0].data.description;
    expect(description.split('\n')).toHaveLength(4);
  });

  it('sends nothing extra when the window collected nothing', async () => {
    const client = Object.assign(createMockClient(), { isFullyReady: true });

    await joinVoice(client, 'user-1', 'vc-a');
    await vi.advanceTimersByTimeAsync(30_000);

    expect(send).toHaveBeenCalledTimes(1);
  });

  it('says nothing about someone who joined and left within one window', async () => {
    const { event } = await import('../events/voiceNotification.js');
    const client = Object.assign(createMockClient(), { isFullyReady: true });

    // First change opens the window and is announced on its own.
    await joinVoice(client, 'user-1', 'vc-a');

    await joinVoice(client, 'user-2', 'vc-a');
    await event.execute(
      client as never,
      createVoiceState({ channelId: 'vc-a', userId: 'user-2' }),
      createVoiceState({ channelId: null, userId: 'user-2' })
    );

    await vi.advanceTimersByTimeAsync(30_000);

    // user-2 was never there as far as anyone reading the channel is concerned.
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('accepts a new immediate announcement once the window closes', async () => {
    const client = Object.assign(createMockClient(), { isFullyReady: true });

    await joinVoice(client, 'user-1', 'vc-a');
    await vi.advanceTimersByTimeAsync(30_000);

    await joinVoice(client, 'user-2', 'vc-a');
    expect(send).toHaveBeenCalledTimes(2);
  });
});
