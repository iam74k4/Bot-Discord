import Database from 'better-sqlite3';
import { MessageFlags } from 'discord.js';
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
  commandInteraction,
  embedAt,
  flagsAt,
  lastEmbed,
  mentioning,
} from './community.helpers.js';

/**
 * `/community poll create` hands the poll to Discord and keeps a pointer to
 * the message; `/community poll end` follows that pointer to close the poll
 * early. The pointer table is real SQLite so persistence is observed, not
 * assumed. The confirmation dialog is mocked: it is a shared utility, and the
 * interesting part here is what happens on each answer.
 */
const db = new Database(':memory:');

vi.mock('../../../infrastructure/database/connection.js', () => ({
  database: db,
}));

vi.mock('../../../shared/utils/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
  getErrorMessage: (e: unknown) => String(e),
}));

const resolveLocale = vi.hoisted(() => vi.fn());
vi.mock('../../../locales/guildLocale.js', () => ({ resolveLocale }));

const awaitConfirmation = vi.hoisted(() => vi.fn());
vi.mock('../../../shared/utils/confirm.js', () => ({ awaitConfirmation }));

const { executePollCommand } = await import('../poll/application.js');
const { pollRepository } = await import('../poll/pollRepository.js');
const { up: nativePolls } =
  await import('../../../infrastructure/database/migrations/010_native_polls.js');
const { t } = await import('../../../locales/index.js');
const { COLORS } = await import('../../../shared/utils/constants/index.js');
const { logger } = await import('../../../shared/utils/logger.js');

const HOUR = 60 * 60 * 1000;
const NOW = new Date('2026-05-01T12:00:00Z').getTime();

function storedPolls() {
  return db.prepare('SELECT * FROM polls ORDER BY created_at').all() as Array<
    Record<string, unknown>
  >;
}

/** Reply mock that resolves like `reply({ withResponse: true })` does. */
function replyWithMessage(id = 'poll-msg-1') {
  return vi.fn().mockResolvedValue({ resource: { message: { id } } });
}

function createInteraction(
  values: Record<string, string | number | boolean | null>,
  overrides: Parameters<typeof commandInteraction>[0] = {}
) {
  return commandInteraction({
    subcommand: 'create',
    values: {
      question: 'Lunch?',
      option1: 'Ramen',
      option2: 'Curry',
      ...values,
    },
    reply: replyWithMessage(),
    ...overrides,
  });
}

/** The `poll` payload sent with the reply. */
function pollPayload(reply: ReturnType<typeof vi.fn>) {
  return (
    reply.mock.calls[0][0] as {
      poll: {
        question: { text: string };
        answers: Array<{ text: string }>;
        duration: number;
        allowMultiselect: boolean;
      };
      withResponse: boolean;
      flags?: number;
    }
  ).poll;
}

/** A text channel whose message fetch yields `message` (or rejects). */
function textChannel(fetch: ReturnType<typeof vi.fn>) {
  return { isTextBased: () => true, messages: { fetch } };
}

function pollMessage(
  options: {
    /** discord.js types the question text as `string | null`. */
    question?: string | null;
    resultsFinalized?: boolean;
    end?: ReturnType<typeof vi.fn>;
  } = {}
) {
  return {
    id: 'poll-msg-1',
    poll: {
      question: {
        text: options.question === undefined ? 'Lunch?' : options.question,
      },
      resultsFinalized: options.resultsFinalized ?? false,
      end: options.end ?? vi.fn().mockResolvedValue(undefined),
    },
  };
}

function seedPoll(
  overrides: Partial<Parameters<typeof pollRepository.create>[0]> = {}
) {
  pollRepository.create({
    message_id: 'poll-msg-1',
    guild_id: 'guild-1',
    channel_id: 'chan-1',
    creator_id: 'user-1',
    expires_at: Date.now() + HOUR,
    ...overrides,
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.clearAllMocks();
  // clearAllMocks keeps implementations; without a reset, one test's answer
  // to the confirmation dialog would leak into the next.
  awaitConfirmation.mockReset();
  resolveLocale.mockReturnValue('en');
  db.exec('DROP TABLE IF EXISTS polls');
  nativePolls();
});

afterEach(() => {
  vi.useRealTimers();
});

afterAll(() => {
  db.close();
});

describe('executePollCommand', () => {
  it('ignores an unknown subcommand', async () => {
    const { interaction, reply } = commandInteraction({ subcommand: 'nope' });

    await executePollCommand(interaction);

    expect(reply).not.toHaveBeenCalled();
  });
});

describe('/community poll create', () => {
  it('posts a native poll with the defaults and records a pointer', async () => {
    const { interaction, reply } = createInteraction({});

    await executePollCommand(interaction);

    expect(reply).toHaveBeenCalledTimes(1);
    expect(reply).toHaveBeenCalledWith({
      poll: {
        question: { text: 'Lunch?' },
        answers: [{ text: 'Ramen' }, { text: 'Curry' }],
        duration: 24,
        allowMultiselect: false,
      },
      withResponse: true,
    });
    expect(flagsAt(reply)).toBeUndefined();
    expect(storedPolls()).toEqual([
      {
        message_id: 'poll-msg-1',
        guild_id: 'guild-1',
        channel_id: 'chan-1',
        creator_id: 'user-1',
        expires_at: NOW + 24 * HOUR,
        created_at: NOW,
      },
    ]);
    expect(logger.info).toHaveBeenCalledWith(
      mentioning('Lunch?', /\b2\b/, 'user-1#0001')
    );
  });

  it('passes all ten options through in order', async () => {
    const tenOptions = Object.fromEntries(
      Array.from({ length: 10 }, (_, i) => [
        `option${i + 1}`,
        `Choice ${i + 1}`,
      ])
    );
    const { interaction, reply, getString } = createInteraction(tenOptions);

    await executePollCommand(interaction);

    expect(pollPayload(reply).answers).toEqual(
      Array.from({ length: 10 }, (_, i) => ({ text: `Choice ${i + 1}` }))
    );
    expect(getString).not.toHaveBeenCalledWith('option11');
  });

  it('closes the gaps left by skipped option slots', async () => {
    const { interaction, reply } = createInteraction({
      option2: null,
      option3: 'Curry',
      option7: 'Sushi',
    });

    await executePollCommand(interaction);

    expect(pollPayload(reply).answers).toEqual([
      { text: 'Ramen' },
      { text: 'Curry' },
      { text: 'Sushi' },
    ]);
  });

  it.each([1, 4, 8, 24, 72, 168])(
    'keeps a %i hour poll open and endable for that long',
    async (hours) => {
      const { interaction, reply } = createInteraction({ duration: hours });

      await executePollCommand(interaction);

      expect(pollPayload(reply).duration).toBe(hours);
      expect(storedPolls()[0].expires_at).toBe(NOW + hours * HOUR);
    }
  );

  it.each([
    [true, true],
    [false, false],
    [null, false],
  ])('maps multi=%s to allowMultiselect=%s', async (multi, expected) => {
    const { interaction, reply } = createInteraction({ multi });

    await executePollCommand(interaction);

    expect(pollPayload(reply).allowMultiselect).toBe(expected);
  });

  it('accepts a question exactly at the 300 character limit', async () => {
    const question = 'q'.repeat(300);
    const { interaction, reply } = createInteraction({ question });

    await executePollCommand(interaction);

    expect(pollPayload(reply).question.text).toBe(question);
  });

  it.each([
    [
      'a question over 300 characters',
      { question: 'q'.repeat(301) },
      'poll.errors.questionTooLong',
    ],
    [
      'an option over 55 characters',
      { option2: 'o'.repeat(56) },
      'poll.errors.optionTooLong',
    ],
    ['a single option', { option2: null }, 'poll.errors.notEnoughOptions'],
    ['an empty second option', { option2: '' }, 'poll.errors.notEnoughOptions'],
  ] as const)('refuses %s ephemerally', async (_, values, bodyKey) => {
    const { interaction, reply } = createInteraction(values);

    await executePollCommand(interaction);

    expect(reply).toHaveBeenCalledTimes(1);
    expect(reply.mock.calls[0][0]).not.toHaveProperty('poll');
    expect(flagsAt(reply)).toBe(MessageFlags.Ephemeral);
    expect(embedAt(reply)).toMatchObject({
      title: t('common.error', 'en'),
      description: t(bodyKey, 'en'),
      color: COLORS.ERROR,
    });
    expect(storedPolls()).toEqual([]);
  });

  it('explains validation errors in the resolved locale', async () => {
    resolveLocale.mockReturnValue('ja');
    const { interaction, reply } = createInteraction({ option2: null });

    await executePollCommand(interaction);

    expect(embedAt(reply).description).toBe(
      t('poll.errors.notEnoughOptions', 'ja')
    );
  });

  it('logs and stores nothing when Discord returns no message', async () => {
    const { interaction } = createInteraction(
      {},
      { reply: vi.fn().mockResolvedValue({ resource: null }) }
    );

    await executePollCommand(interaction);

    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(storedPolls()).toEqual([]);
  });

  it('keeps the poll when the pointer cannot be saved', async () => {
    db.exec('DROP TABLE polls');
    const { interaction, reply } = createInteraction({});

    await expect(executePollCommand(interaction)).resolves.toBeUndefined();

    expect(reply).toHaveBeenCalledTimes(1);
    expect(pollPayload(reply).question.text).toBe('Lunch?');
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith(mentioning('Lunch?'));
  });

  it('stores an empty guild id for a poll created outside a guild', async () => {
    const { interaction } = createInteraction({}, { guildId: null });

    await executePollCommand(interaction);

    expect(storedPolls()[0].guild_id).toBe('');
  });

  it('lets a Discord API failure reach the command handler', async () => {
    const { interaction } = createInteraction(
      {},
      { reply: vi.fn().mockRejectedValue(new Error('Missing Permissions')) }
    );

    await expect(executePollCommand(interaction)).rejects.toThrow(
      'Missing Permissions'
    );
    expect(storedPolls()).toEqual([]);
  });

  it('allows several open polls per user, and end targets the newest', async () => {
    const first = createInteraction({}, { reply: replyWithMessage('older') });
    await executePollCommand(first.interaction);
    vi.advanceTimersByTime(1_000);
    const second = createInteraction({}, { reply: replyWithMessage('newer') });
    await executePollCommand(second.interaction);

    expect(storedPolls().map((row) => row.message_id)).toEqual([
      'older',
      'newer',
    ]);

    const fetch = vi.fn().mockResolvedValue(pollMessage());
    awaitConfirmation.mockResolvedValue(false);
    const end = commandInteraction({
      subcommand: 'end',
      textChannel: textChannel(fetch),
    });
    await executePollCommand(end.interaction);

    expect(fetch).toHaveBeenCalledWith('newer');
  });
});

describe('/community poll end', () => {
  function endInteraction(
    fetch: ReturnType<typeof vi.fn>,
    overrides: Parameters<typeof commandInteraction>[0] = {}
  ) {
    return commandInteraction({
      subcommand: 'end',
      textChannel: textChannel(fetch),
      ...overrides,
    });
  }

  function expectEphemeralError(
    reply: ReturnType<typeof vi.fn>,
    titleKey: Parameters<typeof t>[0],
    bodyKey: Parameters<typeof t>[0]
  ) {
    expect(reply).toHaveBeenCalledTimes(1);
    expect(flagsAt(reply)).toBe(MessageFlags.Ephemeral);
    expect(embedAt(reply)).toMatchObject({
      title: t(titleKey, 'en'),
      description: t(bodyKey, 'en'),
      color: COLORS.ERROR,
    });
  }

  it('says so when the user has no open poll here', async () => {
    const fetch = vi.fn();
    const { interaction, reply } = endInteraction(fetch);

    await executePollCommand(interaction);

    expectEphemeralError(reply, 'poll.noActivePoll', 'poll.noActivePollDesc');
    expect(fetch).not.toHaveBeenCalled();
    expect(awaitConfirmation).not.toHaveBeenCalled();
  });

  it('will not end a poll that belongs to someone else', async () => {
    seedPoll({ creator_id: 'owner' });
    const fetch = vi.fn().mockResolvedValue(pollMessage());
    const { interaction, reply } = endInteraction(fetch, {
      userId: 'intruder',
    });

    await executePollCommand(interaction);

    expectEphemeralError(reply, 'poll.noActivePoll', 'poll.noActivePollDesc');
    expect(fetch).not.toHaveBeenCalled();
    expect(storedPolls()).toHaveLength(1);
  });

  it('does not reach for a poll in another channel', async () => {
    seedPoll({ channel_id: 'elsewhere' });
    const { interaction, reply } = endInteraction(vi.fn());

    await executePollCommand(interaction);

    expectEphemeralError(reply, 'poll.noActivePoll', 'poll.noActivePollDesc');
  });

  it('treats a poll past its deadline as no poll at all', async () => {
    seedPoll({ expires_at: NOW + HOUR });
    vi.advanceTimersByTime(HOUR);
    const { interaction, reply } = endInteraction(vi.fn());

    await executePollCommand(interaction);

    expectEphemeralError(reply, 'poll.noActivePoll', 'poll.noActivePollDesc');
  });

  it('forgets the pointer when the poll message was deleted', async () => {
    seedPoll();
    const fetch = vi.fn().mockRejectedValue(new Error('Unknown Message'));
    const { interaction, reply } = endInteraction(fetch);

    await executePollCommand(interaction);

    expect(fetch).toHaveBeenCalledWith('poll-msg-1');
    expectEphemeralError(
      reply,
      'poll.errors.pollEnded',
      'poll.errors.pollEndedDesc'
    );
    expect(storedPolls()).toEqual([]);
    expect(awaitConfirmation).not.toHaveBeenCalled();
  });

  it('forgets the pointer when the message no longer carries a poll', async () => {
    seedPoll();
    const fetch = vi.fn().mockResolvedValue({ id: 'poll-msg-1', poll: null });
    const { interaction, reply } = endInteraction(fetch);

    await executePollCommand(interaction);

    expectEphemeralError(
      reply,
      'poll.errors.pollEnded',
      'poll.errors.pollEndedDesc'
    );
    expect(storedPolls()).toEqual([]);
  });

  it('forgets the pointer when Discord has already finalised the poll', async () => {
    seedPoll();
    const message = pollMessage({ resultsFinalized: true });
    const { interaction, reply } = endInteraction(
      vi.fn().mockResolvedValue(message)
    );

    await executePollCommand(interaction);

    expectEphemeralError(
      reply,
      'poll.errors.pollEnded',
      'poll.errors.pollEndedDesc'
    );
    expect(message.poll.end).not.toHaveBeenCalled();
    expect(storedPolls()).toEqual([]);
  });

  it.each([
    ['missing', null],
    ['not text-based', { isTextBased: () => false }],
  ])('keeps the pointer when the channel is %s', async (_, channel) => {
    seedPoll();
    const { interaction, reply } = commandInteraction({
      subcommand: 'end',
      textChannel: channel,
    });

    await executePollCommand(interaction);

    expectEphemeralError(
      reply,
      'poll.errors.pollEnded',
      'poll.errors.pollEndedDesc'
    );
    expect(storedPolls()).toHaveLength(1);
  });

  it('asks for confirmation, naming the poll, before ending it', async () => {
    seedPoll();
    awaitConfirmation.mockResolvedValue(true);
    const { interaction } = endInteraction(
      vi.fn().mockResolvedValue(pollMessage({ question: 'Lunch?' }))
    );

    await executePollCommand(interaction);

    expect(awaitConfirmation).toHaveBeenCalledWith(interaction, '**Lunch?**', {
      ephemeral: true,
    });
  });

  it.each([
    ['empty', ''],
    ['null', null],
  ])(
    'falls back to a generic label when the question text is %s',
    async (_, question) => {
      seedPoll();
      awaitConfirmation.mockResolvedValue(false);
      const { interaction } = endInteraction(
        vi.fn().mockResolvedValue(pollMessage({ question }))
      );

      await executePollCommand(interaction);

      expect(awaitConfirmation).toHaveBeenCalledWith(
        interaction,
        t('poll.ended', 'en'),
        { ephemeral: true }
      );
    }
  );

  it('leaves the poll running when the user cancels', async () => {
    seedPoll();
    awaitConfirmation.mockResolvedValue(false);
    const message = pollMessage();
    const { interaction, editReply } = endInteraction(
      vi.fn().mockResolvedValue(message)
    );

    await executePollCommand(interaction);

    expect(message.poll.end).not.toHaveBeenCalled();
    expect(editReply).toHaveBeenCalledTimes(1);
    expect(editReply.mock.calls[0][0]).toMatchObject({ components: [] });
    expect(lastEmbed(editReply)).toMatchObject({
      title: t('common.cancelled', 'en'),
      color: COLORS.INFO,
    });
    expect(storedPolls()).toHaveLength(1);
  });

  it('ends the poll on confirmation and forgets the pointer', async () => {
    seedPoll();
    awaitConfirmation.mockResolvedValue(true);
    const message = pollMessage();
    const { interaction, editReply } = endInteraction(
      vi.fn().mockResolvedValue(message)
    );

    await executePollCommand(interaction);

    expect(message.poll.end).toHaveBeenCalledTimes(1);
    expect(editReply).toHaveBeenCalledTimes(1);
    expect(editReply.mock.calls[0][0]).toMatchObject({ components: [] });
    expect(lastEmbed(editReply)).toMatchObject({
      title: t('poll.ended', 'en'),
      description: t('poll.endedMessage', 'en'),
      color: COLORS.SUCCESS,
    });
    expect(storedPolls()).toEqual([]);
  });

  it('reports a poll Discord refuses to end as already closed', async () => {
    seedPoll();
    awaitConfirmation.mockResolvedValue(true);
    const message = pollMessage({
      end: vi.fn().mockRejectedValue(new Error('Poll expired')),
    });
    const { interaction, editReply } = endInteraction(
      vi.fn().mockResolvedValue(message)
    );

    await executePollCommand(interaction);

    expect(logger.warn).toHaveBeenCalledWith(
      mentioning('poll-msg-1'),
      expect.any(Error)
    );
    expect(editReply.mock.calls[0][0]).toMatchObject({ components: [] });
    expect(lastEmbed(editReply)).toMatchObject({
      title: t('poll.errors.pollEnded', 'en'),
      description: t('poll.errors.pollEndedDesc', 'en'),
      color: COLORS.ERROR,
    });
    expect(storedPolls()).toEqual([]);
  });

  it('keeps the poll and its pointer when the confirmation cannot be shown', async () => {
    seedPoll();
    awaitConfirmation.mockRejectedValue(new Error('Unknown interaction'));
    const message = pollMessage();
    const { interaction, editReply } = endInteraction(
      vi.fn().mockResolvedValue(message)
    );

    await expect(executePollCommand(interaction)).rejects.toThrow(
      'Unknown interaction'
    );

    expect(message.poll.end).not.toHaveBeenCalled();
    expect(editReply).not.toHaveBeenCalled();
    expect(storedPolls()).toHaveLength(1);
  });

  it('still forgets an ended poll when the closing reply cannot be sent', async () => {
    seedPoll();
    awaitConfirmation.mockResolvedValue(true);
    const message = pollMessage();
    const { interaction, editReply } = endInteraction(
      vi.fn().mockResolvedValue(message)
    );
    editReply.mockRejectedValue(new Error('Unknown Webhook'));

    await expect(executePollCommand(interaction)).rejects.toThrow(
      'Unknown Webhook'
    );

    // The poll really is closed, so a stale pointer would only mislead the
    // next `/community poll end` into a "poll ended" error.
    expect(message.poll.end).toHaveBeenCalledTimes(1);
    expect(storedPolls()).toEqual([]);
  });

  it('answers in the resolved locale', async () => {
    resolveLocale.mockReturnValue('ja');
    seedPoll();
    awaitConfirmation.mockResolvedValue(true);
    const { interaction, editReply } = endInteraction(
      vi.fn().mockResolvedValue(pollMessage())
    );

    await executePollCommand(interaction);

    expect(lastEmbed(editReply).title).toBe(t('poll.ended', 'ja'));
  });
});
