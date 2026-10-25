import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Collection, type Guild, type VoiceState } from 'discord.js';
import {
  createMockClient,
  createMockGuild,
  createMockUser,
} from '../../../__tests__/helpers/discord.js';
import { t } from '../../../locales/index.js';

const startSession = vi.fn();
const endSession = vi.fn();
const getEnabled = vi.fn();
const getSendableTextChannel = vi.fn();
const send = vi.fn();
const resolveBackgroundLocale = vi.fn((_guild: unknown) => 'en');

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

// The real resolver reads guild_settings, which would open the on-disk test
// database. Which language a guild gets is covered by guildLocale's tests;
// here it only matters that the post uses whatever it returns.
vi.mock('../../../locales/guildLocale.js', () => ({
  resolveBackgroundLocale: (guild: unknown) => resolveBackgroundLocale(guild),
}));

const { event, resetVoiceDigests, DIGEST_WINDOW_MS } =
  await import('../events/voiceNotification.js');

const BOT_USER_ID = '123456789012345678';

function readyClient() {
  return Object.assign(createMockClient(), { isFullyReady: true });
}

interface FakeVoiceStateEntry {
  id: string;
  channelId: string;
  /** `undefined` models a member the bot has not cached. */
  bot?: boolean;
}

/** A guild whose voice-state cache holds `entries` (everyone in a VC). */
function createGuild(
  options: { entries?: FakeVoiceStateEntry[]; afkChannelId?: string } = {}
): Guild {
  const voiceStates = options.entries
    ? {
        cache: new Collection(
          options.entries.map((entry) => [
            entry.id,
            {
              id: entry.id,
              channelId: entry.channelId,
              member:
                entry.bot === undefined
                  ? null
                  : { user: { id: entry.id, bot: entry.bot } },
            },
          ])
        ),
      }
    : undefined;

  return createMockGuild({
    preferredLocale: 'en-US',
    afkChannelId: options.afkChannelId ?? null,
    ...(voiceStates ? { voiceStates } : {}),
  } as never);
}

function createVoiceState(overrides: {
  channelId?: string | null;
  channelName?: string;
  userId?: string;
  displayName?: string;
  bot?: boolean;
  guild?: Guild;
}): VoiceState {
  const guild = overrides.guild ?? createGuild();
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
    id: user.id,
    guild,
    channel,
    member: {
      user,
      displayName: overrides.displayName ?? user.displayName,
    },
  } as unknown as VoiceState;
}

function descriptionOf(call: number): string {
  const payload = send.mock.calls[call][0] as {
    embeds: Array<{ data: { description: string } }>;
  };
  return payload.embeds[0].data.description;
}

const joinLine = (name: string, channel: string) =>
  t('notification.events.voiceJoin', 'en', { name, channel });

describe('voiceNotification event', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Digest windows are module state keyed by guild; a window left open by
    // one test would silently swallow the next test's first notification.
    resetVoiceDigests();
    getEnabled.mockReturnValue('notify-channel');
    getSendableTextChannel.mockResolvedValue({ send });
    send.mockResolvedValue(undefined);
  });

  afterEach(() => {
    resetVoiceDigests();
  });

  it('completes move session transition before awaiting leave notification', async () => {
    const client = readyClient();

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
    const order: string[] = [];
    startSession.mockImplementation(() => {
      order.push('startSession');
    });
    send.mockImplementation(async () => {
      order.push('send');
    });

    await event.execute(
      readyClient() as never,
      createVoiceState({ channelId: null }),
      createVoiceState({ channelId: 'vc-a', channelName: 'A' })
    );

    expect(order).toEqual(['startSession', 'send']);
  });

  it('posts in the language resolved for the guild', async () => {
    resolveBackgroundLocale.mockReturnValueOnce('ja');
    const newState = createVoiceState({
      channelId: 'vc-a',
      displayName: 'Alice',
    });

    await event.execute(
      readyClient() as never,
      createVoiceState({ channelId: null }),
      newState
    );

    expect(resolveBackgroundLocale).toHaveBeenCalledWith(newState.guild);
    expect(descriptionOf(0)).toBe(
      t('notification.events.voiceJoin', 'ja', {
        name: 'Alice',
        channel: 'vc-a',
      })
    );
  });

  it('escapes markdown in display names so the line keeps its bold name', async () => {
    await event.execute(
      readyClient() as never,
      createVoiceState({ channelId: null }),
      createVoiceState({ channelId: 'vc-a', displayName: '*star*_fan' })
    );

    expect(descriptionOf(0)).toBe(joinLine('\\*star\\*\\_fan', 'vc-a'));
  });

  describe('the AFK channel', () => {
    const guild = () => createGuild({ afkChannelId: 'afk' });

    it('reports an idle move into the AFK channel as a leave', async () => {
      const g = guild();

      await event.execute(
        readyClient() as never,
        createVoiceState({ channelId: 'vc-a', displayName: 'Bob', guild: g }),
        createVoiceState({ channelId: 'afk', displayName: 'Bob', guild: g })
      );

      expect(descriptionOf(0)).toBe(
        t('notification.events.voiceLeave', 'en', {
          name: 'Bob',
          channel: 'vc-a',
        })
      );
      // Idle time is not VC time.
      expect(endSession).toHaveBeenCalledWith(g.id, 'user-1');
      expect(startSession).not.toHaveBeenCalled();
    });

    it('reports coming back from the AFK channel as a join', async () => {
      const g = guild();

      await event.execute(
        readyClient() as never,
        createVoiceState({ channelId: 'afk', displayName: 'Bob', guild: g }),
        createVoiceState({
          channelId: 'vc-a',
          channelName: 'A',
          displayName: 'Bob',
          guild: g,
        })
      );

      expect(descriptionOf(0)).toBe(joinLine('Bob', 'vc-a'));
      expect(startSession).toHaveBeenCalledWith(g.id, 'user-1', 'vc-a', 'A');
    });

    it('says nothing about joining or leaving the AFK channel itself', async () => {
      const g = guild();

      await event.execute(
        readyClient() as never,
        createVoiceState({ channelId: null, guild: g }),
        createVoiceState({ channelId: 'afk', guild: g })
      );
      await event.execute(
        readyClient() as never,
        createVoiceState({ channelId: 'afk', guild: g }),
        createVoiceState({ channelId: null, guild: g })
      );

      expect(send).not.toHaveBeenCalled();
      expect(startSession).not.toHaveBeenCalled();
    });
  });
});

describe('voice notification batching', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    resetVoiceDigests();
    getEnabled.mockReturnValue('notify-channel');
    getSendableTextChannel.mockResolvedValue({ send });
    send.mockResolvedValue(undefined);
  });

  afterEach(() => {
    resetVoiceDigests();
    vi.useRealTimers();
  });

  async function joinVoice(
    userId: string,
    channelId: string,
    guild?: Guild
  ): Promise<void> {
    await event.execute(
      readyClient() as never,
      createVoiceState({ channelId: null, userId, guild }),
      createVoiceState({ channelId, userId, displayName: userId, guild })
    );
  }

  it('announces the first change immediately and batches the rest', async () => {
    await joinVoice('user-1', 'vc-a');
    expect(send).toHaveBeenCalledTimes(1);

    // Four more people pile in during the window: still one message, later.
    await joinVoice('user-2', 'vc-a');
    await joinVoice('user-3', 'vc-a');
    await joinVoice('user-4', 'vc-a');
    await joinVoice('user-5', 'vc-a');
    expect(send).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(DIGEST_WINDOW_MS);
    expect(send).toHaveBeenCalledTimes(2);
    expect(descriptionOf(1).split('\n')).toHaveLength(4);
  });

  it('sends nothing extra when the window collected nothing', async () => {
    await joinVoice('user-1', 'vc-a');
    await vi.advanceTimersByTimeAsync(DIGEST_WINDOW_MS);

    expect(send).toHaveBeenCalledTimes(1);
  });

  it('says nothing about someone who joined and left within one window', async () => {
    // First change opens the window and is announced on its own.
    await joinVoice('user-1', 'vc-a');

    await joinVoice('user-2', 'vc-a');
    await event.execute(
      readyClient() as never,
      createVoiceState({ channelId: 'vc-a', userId: 'user-2' }),
      createVoiceState({ channelId: null, userId: 'user-2' })
    );

    await vi.advanceTimersByTimeAsync(DIGEST_WINDOW_MS);

    // user-2 was never there as far as anyone reading the channel is concerned.
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('accepts a new immediate announcement once the window closes', async () => {
    await joinVoice('user-1', 'vc-a');
    await vi.advanceTimersByTimeAsync(DIGEST_WINDOW_MS);

    await joinVoice('user-2', 'vc-a');
    expect(send).toHaveBeenCalledTimes(2);
  });

  describe('when a call starts', () => {
    it('announces a join into an empty VC immediately even while a window is open', async () => {
      await joinVoice('user-1', 'vc-a');

      await vi.advanceTimersByTimeAsync(5_000);
      await joinVoice(
        'user-2',
        'vc-b',
        createGuild({
          entries: [
            { id: 'user-1', channelId: 'vc-a', bot: false },
            { id: 'user-2', channelId: 'vc-b', bot: false },
          ],
        })
      );

      expect(send).toHaveBeenCalledTimes(2);
      expect(descriptionOf(1)).toBe(joinLine('user-2', 'vc-b'));
    });

    it('still batches a second joiner into an occupied VC', async () => {
      await joinVoice('user-1', 'vc-a');

      await joinVoice(
        'user-2',
        'vc-a',
        createGuild({
          entries: [
            { id: 'user-1', channelId: 'vc-a', bot: false },
            { id: 'user-2', channelId: 'vc-a', bot: false },
          ],
        })
      );

      expect(send).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(DIGEST_WINDOW_MS);
      expect(send).toHaveBeenCalledTimes(2);
    });

    it('flushes the buffered lines first, in order, and restarts the window', async () => {
      const occupied = createGuild({
        entries: [
          { id: 'user-1', channelId: 'vc-a', bot: false },
          { id: 'user-2', channelId: 'vc-a', bot: false },
        ],
      });
      await joinVoice('user-1', 'vc-a');
      await joinVoice('user-2', 'vc-a', occupied);

      await vi.advanceTimersByTimeAsync(10_000);
      await joinVoice(
        'user-3',
        'vc-b',
        createGuild({ entries: [{ id: 'user-3', channelId: 'vc-b' }] })
      );

      expect(send).toHaveBeenCalledTimes(2);
      expect(descriptionOf(1).split('\n')).toEqual([
        joinLine('user-2', 'vc-a'),
        joinLine('user-3', 'vc-b'),
      ]);

      // The next change waits a full window from the flush, not from the
      // first announcement.
      await joinVoice('user-4', 'vc-a', occupied);
      await vi.advanceTimersByTimeAsync(DIGEST_WINDOW_MS - 1);
      expect(send).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(send).toHaveBeenCalledTimes(3);
      expect(descriptionOf(2)).toBe(joinLine('user-4', 'vc-a'));
    });

    it('does not count bots, the bot itself included, as people in the call', async () => {
      await joinVoice('user-1', 'vc-a');

      await joinVoice(
        'user-2',
        'vc-b',
        createGuild({
          entries: [
            { id: 'music-bot', channelId: 'vc-b', bot: true },
            // The bot's own connection, its member object not cached.
            { id: BOT_USER_ID, channelId: 'vc-b' },
            { id: 'user-2', channelId: 'vc-b', bot: false },
          ],
        })
      );

      expect(send).toHaveBeenCalledTimes(2);
    });

    it('counts a member it cannot identify as a person', async () => {
      await joinVoice('user-1', 'vc-a');

      await joinVoice(
        'user-2',
        'vc-b',
        createGuild({
          entries: [
            { id: 'someone', channelId: 'vc-b' },
            { id: 'user-2', channelId: 'vc-b', bot: false },
          ],
        })
      );

      expect(send).toHaveBeenCalledTimes(1);
    });

    it('treats a move into an empty VC as a call start', async () => {
      await joinVoice('user-1', 'vc-a');
      const g = createGuild({
        entries: [
          { id: 'user-1', channelId: 'vc-a', bot: false },
          { id: 'user-2', channelId: 'vc-c', bot: false },
        ],
      });

      await event.execute(
        readyClient() as never,
        createVoiceState({ channelId: 'vc-b', userId: 'user-2', guild: g }),
        createVoiceState({
          channelId: 'vc-c',
          userId: 'user-2',
          displayName: 'user-2',
          guild: g,
        })
      );

      expect(send).toHaveBeenCalledTimes(2);
      expect(descriptionOf(1)).toBe(
        t('notification.events.voiceMove', 'en', {
          name: 'user-2',
          from: 'vc-b',
          to: 'vc-c',
        })
      );
    });
  });
});
