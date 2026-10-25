import Database from 'better-sqlite3';
import {
  ButtonStyle,
  ComponentType,
  DiscordAPIError,
  DiscordjsError,
  DiscordjsErrorCodes,
  MessageFlags,
  RESTJSONErrorCodes,
  type APIModalInteractionResponseCallbackData,
  type ModalBuilder,
} from 'discord.js';
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
 * the message; with fewer than two options it opens a form that takes them
 * one per line. `/community poll end` follows the pointer - from any channel
 * of the server - to close the poll early. The pointer table is real SQLite
 * and the cooldown store is the real one, so persistence and cooldown
 * refunds are observed, not assumed. The confirmation dialog is mocked: it
 * is a shared utility, and the interesting part here is each outcome.
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

const awaitConfirmationResult = vi.hoisted(() => vi.fn());
vi.mock('../../../shared/utils/confirm.js', () => ({
  awaitConfirmationResult,
}));

const { executePollCommand, autocompletePollToEnd } =
  await import('../poll/application.js');
const { pollRepository } = await import('../poll/pollRepository.js');
const { command } = await import('../commands/roulette.js');
const { cooldownMiddleware, clearCooldown } =
  await import('../../../middleware/cooldown/index.js');
const { up: nativePolls } =
  await import('../../../infrastructure/database/migrations/010_native_polls.js');
const { t } = await import('../../../locales/index.js');
const { formatDuration } = await import('../../../locales/format.js');
const { COLORS } = await import('../../../shared/utils/constants/index.js');
const { logger } = await import('../../../shared/utils/logger.js');
const { clearLiveComponents, isLiveComponentMessage } =
  await import('../../../shared/interactions/index.js');

const HOUR = 60 * 60 * 1000;
const NOW = new Date('2026-05-01T12:00:00Z').getTime();

function storedPolls() {
  return db.prepare('SELECT * FROM polls ORDER BY created_at').all() as Array<
    Record<string, unknown>
  >;
}

function storedIds(): string[] {
  return storedPolls().map((row) => String(row.message_id));
}

/** Reply mock that resolves like `reply({ withResponse: true })` does. */
function replyWithMessage(id = 'poll-msg-1') {
  return vi.fn().mockResolvedValue({ resource: { message: { id } } });
}

function apiError(code: number) {
  return new DiscordAPIError(
    { message: 'rejected', code },
    code,
    404,
    'GET',
    '/channels/x/messages/y',
    {}
  );
}

function createInteraction(
  values: Record<string, string | number | boolean | null>,
  overrides: Parameters<typeof commandInteraction>[0] = {}
) {
  return commandInteraction({
    group: 'poll',
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
function pollPayload(reply: ReturnType<typeof vi.fn>, call = 0) {
  return (
    reply.mock.calls[call][0] as {
      poll: {
        question: { text: string };
        answers: Array<{ text: string }>;
        duration: number;
        allowMultiselect: boolean;
      };
    }
  ).poll;
}

/** Whether the user is still on cooldown for the interaction's path. */
async function onCooldown(
  interaction: Parameters<typeof cooldownMiddleware>[0]
): Promise<boolean> {
  const result = await cooldownMiddleware(interaction, command);
  return !result.success;
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
    /** Discord's deadline for the poll; null for a poll that never ends. */
    expiresTimestamp?: number | null;
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
      expiresTimestamp:
        options.expiresTimestamp === undefined
          ? Date.now() + HOUR
          : options.expiresTimestamp,
      end: options.end ?? vi.fn().mockResolvedValue(undefined),
    },
  };
}

/** The error discord.js throws, without asking Discord, for a poll past its deadline. */
function pollAlreadyExpired(): Error {
  // The constructor is private in the typings; discord.js builds it like this.
  const Construct = DiscordjsError as unknown as new (code: string) => Error;
  return new Construct(DiscordjsErrorCodes.PollAlreadyExpired);
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

/** A confirm press the caller still has to answer. */
function confirmedPress() {
  const update = vi.fn().mockResolvedValue(undefined);
  awaitConfirmationResult.mockResolvedValue({
    outcome: 'confirmed',
    response: { update },
  });
  return update;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.clearAllMocks();
  // clearAllMocks keeps implementations; without a reset, one test's answer
  // to the confirmation dialog would leak into the next.
  awaitConfirmationResult.mockReset();
  resolveLocale.mockReturnValue('en');
  clearCooldown('community', 'user-1');
  clearLiveComponents();
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

  it('tells only the creator how to close the poll early', async () => {
    const { interaction, followUp } = createInteraction({});

    await executePollCommand(interaction);

    expect(followUp).toHaveBeenCalledTimes(1);
    expect(followUp).toHaveBeenCalledWith({
      content: t('poll.createdHint', 'en', {
        command: '`/community poll end`',
      }),
      flags: MessageFlags.Ephemeral,
    });
  });

  it('keeps the poll when the hint cannot be sent', async () => {
    const { interaction, followUp } = createInteraction({});
    followUp.mockRejectedValue(new Error('Unknown Webhook'));

    await expect(executePollCommand(interaction)).resolves.toBeUndefined();

    expect(storedIds()).toEqual(['poll-msg-1']);
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

  it('keeps the cooldown once a poll is posted', async () => {
    const { interaction } = createInteraction({});
    expect(await onCooldown(interaction)).toBe(false);

    await executePollCommand(interaction);

    expect(await onCooldown(interaction)).toBe(true);
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
  ] as const)(
    'refuses %s ephemerally and gives the cooldown back',
    async (_, values, bodyKey) => {
      const { interaction, reply } = createInteraction(values);
      expect(await onCooldown(interaction)).toBe(false);

      await executePollCommand(interaction);

      expect(reply).toHaveBeenCalledTimes(1);
      expect(reply.mock.calls[0][0]).not.toHaveProperty('poll');
      expect(flagsAt(reply)).toBe(MessageFlags.Ephemeral);
      expect(embedAt(reply)).toMatchObject({
        title: t('poll.errors.createFailed', 'en'),
        description: t(bodyKey, 'en'),
        color: COLORS.ERROR,
      });
      expect(storedPolls()).toEqual([]);
      expect(await onCooldown(interaction)).toBe(false);
    }
  );

  it('explains validation errors in the resolved locale', async () => {
    resolveLocale.mockReturnValue('ja');
    const { interaction, reply } = createInteraction({
      option2: 'o'.repeat(56),
    });

    await executePollCommand(interaction);

    expect(embedAt(reply)).toMatchObject({
      title: t('poll.errors.createFailed', 'ja'),
      description: t('poll.errors.optionTooLong', 'ja'),
    });
  });

  it('logs and stores nothing when Discord returns no message', async () => {
    const { interaction, followUp } = createInteraction(
      {},
      { reply: vi.fn().mockResolvedValue({ resource: null }) }
    );

    await executePollCommand(interaction);

    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(storedPolls()).toEqual([]);
    expect(followUp).not.toHaveBeenCalled();
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
});

describe('/community poll create with fewer than two options', () => {
  /** The form a showModal mock was called with, as Discord receives it. */
  function modalAt(
    showModal: ReturnType<typeof vi.fn>,
    call = 0
  ): APIModalInteractionResponseCallbackData {
    return (showModal.mock.calls[call][0] as ModalBuilder).toJSON();
  }

  type FieldJSON = {
    custom_id: string;
    value?: string;
    default?: boolean;
    max_length?: number;
    options?: Array<{ value: string; default?: boolean }>;
  };

  /** The component inside each label of the form, by custom id. */
  function fieldsOf(modal: APIModalInteractionResponseCallbackData) {
    return Object.fromEntries(
      modal.components.map((label) => {
        const field = (label as unknown as { component: FieldJSON }).component;
        return [field.custom_id, field];
      })
    ) as Record<string, FieldJSON>;
  }

  interface SubmitValues {
    question?: string;
    options?: string;
    duration?: string | null;
    multi?: boolean;
  }

  /** A form submission, answering like the real one. */
  function modalSubmit(values: SubmitValues, id = 'submit-1') {
    const reply = vi.fn(async (payload: { withResponse?: boolean }) =>
      payload.withResponse
        ? { resource: { message: { id: `poll-from-${id}` } } }
        : {}
    );
    return {
      id,
      customId: 'poll-create:interaction-1',
      user: { id: 'user-1', tag: 'user-1#0001' },
      guildId: 'guild-1',
      channelId: 'chan-1',
      replied: false,
      deferred: false,
      fields: {
        getTextInputValue: vi.fn((field: string) =>
          field === 'question'
            ? (values.question ?? 'Lunch?')
            : (values.options ?? 'Ramen\nCurry')
        ),
        getRadioGroup: vi.fn(() =>
          values.duration === undefined ? '24' : values.duration
        ),
        getCheckbox: vi.fn(() => values.multi ?? false),
      },
      reply,
      followUp: vi.fn().mockResolvedValue({}),
      editReply: vi.fn().mockResolvedValue({}),
    };
  }

  function formInteraction(
    values: Record<string, string | number | boolean | null>,
    submit?: ReturnType<typeof modalSubmit>
  ) {
    return createInteraction(
      { option1: null, option2: null, ...values },
      {
        awaitModalSubmit: submit
          ? vi.fn().mockResolvedValue(submit)
          : undefined,
      }
    );
  }

  it.each([
    ['no option', {}, undefined],
    ['a single option', { option1: 'Ramen' }, 'Ramen'],
    ['an empty second option', { option1: 'Ramen', option2: '' }, 'Ramen'],
  ])(
    'opens the form, prefilled, instead of refusing %s',
    async (_, values, optionsText) => {
      const { interaction, reply, showModal } = formInteraction(values);

      await executePollCommand(interaction);

      expect(reply).not.toHaveBeenCalled();
      expect(showModal).toHaveBeenCalledTimes(1);
      const modal = modalAt(showModal);
      expect(modal.title).toBe(t('poll.modal.title', 'en'));
      const fields = fieldsOf(modal);
      expect(fields.question.value).toBe('Lunch?');
      expect(fields.options.value).toBe(optionsText);
      expect(fields.options.max_length).toBeGreaterThanOrEqual(10 * 55 + 9);
      expect(storedPolls()).toEqual([]);
    }
  );

  it('carries the chosen duration and multi-select into the form', async () => {
    const { interaction, showModal } = formInteraction({
      duration: 72,
      multi: true,
    });

    await executePollCommand(interaction);

    const fields = fieldsOf(modalAt(showModal));
    expect(
      fields.duration.options?.filter((o) => o.default).map((o) => o.value)
    ).toEqual(['72']);
    expect(fields.multi.default).toBe(true);
  });

  it('offers the same durations as the slash command, defaulting to 24 hours', async () => {
    const { interaction, showModal } = formInteraction({});

    await executePollCommand(interaction);

    const durations = fieldsOf(modalAt(showModal)).duration.options ?? [];
    expect(durations.map((o) => o.value)).toEqual([
      '1',
      '4',
      '8',
      '24',
      '72',
      '168',
    ]);
    expect(durations.filter((o) => o.default).map((o) => o.value)).toEqual([
      '24',
    ]);
  });

  it('labels the form in the resolved locale', async () => {
    resolveLocale.mockReturnValue('ja');
    const { interaction, showModal } = formInteraction({});

    await executePollCommand(interaction);

    expect(modalAt(showModal).title).toBe(t('poll.modal.title', 'ja'));
  });

  it('keeps the cooldown when it opens the form, so forms come no faster than polls', async () => {
    // Every poll from the form takes opening one, and each form left open
    // waits ten minutes for its submit.
    const { interaction } = formInteraction({});
    expect(await onCooldown(interaction)).toBe(false);

    await executePollCommand(interaction);

    expect(await onCooldown(interaction)).toBe(true);
  });

  it('says and stores nothing when the form is dismissed', async () => {
    const { interaction, reply, followUp } = formInteraction({});

    await expect(executePollCommand(interaction)).resolves.toBeUndefined();

    expect(reply).not.toHaveBeenCalled();
    expect(followUp).not.toHaveBeenCalled();
    expect(storedPolls()).toEqual([]);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("only accepts this form, sent by the command's user", async () => {
    const { interaction, awaitModalSubmit } = formInteraction({});

    await executePollCommand(interaction);

    const { filter, time } = awaitModalSubmit.mock.calls[0][0] as {
      filter: (i: { customId: string; user: { id: string } }) => boolean;
      time: number;
    };
    const mine = {
      customId: 'poll-create:interaction-1',
      user: { id: 'user-1' },
    };
    expect(filter(mine)).toBe(true);
    expect(filter({ ...mine, user: { id: 'user-2' } })).toBe(false);
    expect(filter({ ...mine, customId: 'poll-create:other' })).toBe(false);
    expect(time).toBeGreaterThanOrEqual(5 * 60_000);
  });

  it('posts the poll the form describes, one option per line', async () => {
    const submit = modalSubmit({
      question: '  Dinner?  ',
      options: '  Ramen \r\n\nCurry\nRamen\n   \nSushi\n',
      duration: '8',
      multi: true,
    });
    const { interaction, reply } = formInteraction({}, submit);

    await executePollCommand(interaction);

    expect(reply).not.toHaveBeenCalled();
    expect(submit.reply).toHaveBeenCalledTimes(1);
    expect(submit.reply).toHaveBeenCalledWith({
      poll: {
        question: { text: 'Dinner?' },
        answers: [{ text: 'Ramen' }, { text: 'Curry' }, { text: 'Sushi' }],
        duration: 8,
        allowMultiselect: true,
      },
      withResponse: true,
    });
    expect(storedPolls()).toEqual([
      expect.objectContaining({
        message_id: 'poll-from-submit-1',
        guild_id: 'guild-1',
        channel_id: 'chan-1',
        creator_id: 'user-1',
        expires_at: NOW + 8 * HOUR,
      }),
    ]);
    expect(submit.followUp).toHaveBeenCalledWith(
      expect.objectContaining({ flags: MessageFlags.Ephemeral })
    );
  });

  it('falls back to the prefilled duration when the form sends none', async () => {
    const submit = modalSubmit({ duration: null });
    const { interaction } = formInteraction({ duration: 4 }, submit);

    await executePollCommand(interaction);

    expect(pollPayload(submit.reply).duration).toBe(4);
  });

  describe('a form that cannot become a poll', () => {
    /** The press on "edit and try again", which reopens the form. */
    function retryPress(next?: ReturnType<typeof modalSubmit>) {
      return {
        id: 'retry-press-1',
        customId: 'poll-create-retry:submit-1',
        user: { id: 'user-1' },
        showModal: vi.fn().mockResolvedValue(undefined),
        awaitModalSubmit: next
          ? vi.fn().mockResolvedValue(next)
          : vi.fn().mockRejectedValue(new Error('time')),
      };
    }

    /** Make the rejection note's button resolve to `press` (or lapse). */
    function withRetryButton(
      submit: ReturnType<typeof modalSubmit>,
      press: ReturnType<typeof retryPress> | null
    ) {
      const awaitMessageComponent = vi.fn(async (_options: unknown) => {
        if (!press) throw new Error('time');
        return press;
      });
      submit.reply.mockImplementationOnce(async () => ({
        resource: {
          message: { id: 'retry-note-1', awaitMessageComponent },
        },
      }));
      return awaitMessageComponent;
    }

    it.each([
      [
        'an option line over 55 characters',
        { options: `Ramen\n\n${'x'.repeat(56)}` },
        t('poll.errors.optionLineTooLong', 'en', { line: 3, length: 56 }),
      ],
      [
        'more than ten options',
        {
          options: Array.from({ length: 11 }, (_, i) => `c${i}`).join('\n'),
        },
        t('poll.errors.tooManyOptions', 'en', { count: 11 }),
      ],
      [
        'a single distinct option',
        { options: 'Ramen\nRamen' },
        t('poll.errors.notEnoughOptions', 'en'),
      ],
      [
        'a blank question',
        { question: '   ' },
        t('poll.errors.questionMissing', 'en'),
      ],
    ])(
      'explains %s privately and offers to edit it',
      async (_, values, problem) => {
        const submit = modalSubmit(values);
        withRetryButton(submit, null);
        const { interaction } = formInteraction({}, submit);

        await executePollCommand(interaction);

        expect(submit.reply).toHaveBeenCalledTimes(1);
        const note = submit.reply.mock.calls[0][0] as unknown as {
          flags: number;
          components: Array<{ toJSON(): { components: unknown[] } }>;
        };
        expect(note.flags).toBe(MessageFlags.Ephemeral);
        expect(embedAt(submit.reply)).toMatchObject({
          title: t('poll.errors.createFailed', 'en'),
          color: COLORS.ERROR,
        });
        expect(embedAt(submit.reply).description).toContain(problem);
        expect(note.components[0].toJSON().components).toEqual([
          expect.objectContaining({
            custom_id: 'poll-create-retry:submit-1',
            label: t('poll.modal.retry', 'en'),
            style: ButtonStyle.Primary,
          }),
        ]);
        expect(storedPolls()).toEqual([]);
      }
    );

    it('reopens the form with what was typed, and posts once it is fixed', async () => {
      const tooLong = 'x'.repeat(56);
      const fixed = modalSubmit(
        { question: 'Dinner?', options: 'Ramen\nCurry', duration: '1' },
        'submit-2'
      );
      const press = retryPress(fixed);
      const first = modalSubmit({
        question: 'Dinner?',
        options: `Ramen\n${tooLong}`,
        duration: '72',
        multi: true,
      });
      withRetryButton(first, press);
      const { interaction } = formInteraction({}, first);

      await executePollCommand(interaction);

      expect(press.showModal).toHaveBeenCalledTimes(1);
      const fields = fieldsOf(modalAt(press.showModal));
      expect(fields.question.value).toBe('Dinner?');
      expect(fields.options.value).toBe(`Ramen\n${tooLong}`);
      expect(fields.duration.options?.find((o) => o.default)?.value).toBe('72');
      expect(fields.multi.default).toBe(true);
      // The note's button is retired once used.
      expect(first.editReply).toHaveBeenCalledWith({ components: [] });

      expect(pollPayload(fixed.reply)).toMatchObject({
        question: { text: 'Dinner?' },
        answers: [{ text: 'Ramen' }, { text: 'Curry' }],
        duration: 1,
      });
      expect(storedIds()).toEqual(['poll-from-submit-2']);
    });

    it('reopens the form without waiting for the old button to be retired', async () => {
      // The press must be answered within 3 s; retiring the note's button is
      // a separate round trip that must not delay it.
      const fixed = modalSubmit({ options: 'Ramen\nCurry' }, 'submit-2');
      const press = retryPress(fixed);
      const first = modalSubmit({ options: 'Ramen' });
      first.editReply.mockReturnValue(new Promise(() => undefined));
      withRetryButton(first, press);
      const { interaction } = formInteraction({}, first);

      await executePollCommand(interaction);

      expect(press.showModal).toHaveBeenCalledTimes(1);
      expect(storedIds()).toEqual(['poll-from-submit-2']);
    });

    it('only answers the edit button for the user who sent the form', async () => {
      const submit = modalSubmit({ options: 'Ramen' });
      const awaitButton = withRetryButton(submit, null);
      const { interaction } = formInteraction({}, submit);

      await executePollCommand(interaction);

      const { filter } = awaitButton.mock.calls[0][0] as {
        filter: (i: { customId: string; user: { id: string } }) => boolean;
      };
      const mine = {
        customId: 'poll-create-retry:submit-1',
        user: { id: 'user-1' },
      };
      expect(filter(mine)).toBe(true);
      expect(filter({ ...mine, user: { id: 'user-2' } })).toBe(false);
    });

    it('leaves the button to its own wait while it is pressable', async () => {
      const submit = modalSubmit({ options: 'Ramen' });
      let liveWhileWaiting = false;
      submit.reply.mockImplementationOnce(async () => ({
        resource: {
          message: {
            id: 'retry-note-1',
            awaitMessageComponent: vi.fn(async () => {
              liveWhileWaiting = isLiveComponentMessage('retry-note-1');
              throw new Error('time');
            }),
          },
        },
      }));
      const { interaction } = formInteraction({}, submit);

      await executePollCommand(interaction);

      expect(liveWhileWaiting).toBe(true);
      expect(isLiveComponentMessage('retry-note-1')).toBe(false);
    });

    it('retires the button when it lapses, and posts nothing', async () => {
      const submit = modalSubmit({ options: 'Ramen' });
      withRetryButton(submit, null);
      const { interaction } = formInteraction({}, submit);

      await executePollCommand(interaction);

      expect(submit.editReply).toHaveBeenCalledWith({ components: [] });
      expect(submit.reply).toHaveBeenCalledTimes(1);
      expect(storedPolls()).toEqual([]);
    });
  });

  it('reports a failure on the form itself, with an id that is in the log', async () => {
    const submit = modalSubmit({});
    submit.reply.mockRejectedValueOnce(new Error('Missing Permissions'));
    const { interaction } = formInteraction({}, submit);

    await expect(executePollCommand(interaction)).resolves.toBeUndefined();

    const [logged] = vi.mocked(logger.error).mock.calls[0];
    const id = /\[([0-9a-f]{6})\]/.exec(String(logged))?.[1];
    expect(id).toBeDefined();
    expect(submit.reply).toHaveBeenCalledTimes(2);
    expect(flagsAt(submit.reply, 1)).toBe(MessageFlags.Ephemeral);
    expect(embedAt(submit.reply, 1).description).toBe(
      t('common.unexpectedError', 'en', { id: id! })
    );
    expect(storedPolls()).toEqual([]);
  });
});

describe('/community poll end', () => {
  function endInteraction(
    fetch: ReturnType<typeof vi.fn>,
    overrides: Parameters<typeof commandInteraction>[0] = {}
  ) {
    return commandInteraction({
      group: 'poll',
      subcommand: 'end',
      textChannel: textChannel(fetch),
      ...overrides,
    });
  }

  function expectEphemeralError(
    reply: ReturnType<typeof vi.fn>,
    title: string,
    description: string
  ) {
    expect(reply).toHaveBeenCalledTimes(1);
    expect(flagsAt(reply)).toBe(MessageFlags.Ephemeral);
    expect(embedAt(reply)).toMatchObject({
      title,
      description,
      color: COLORS.ERROR,
    });
  }

  const noPoll = () =>
    [
      t('poll.noActivePoll', 'en'),
      t('poll.noActivePollDesc', 'en', {
        command: '`/community poll create`',
      }),
    ] as const;
  const pollGone = () =>
    [
      t('poll.errors.pollEnded', 'en'),
      t('poll.errors.pollEndedDesc', 'en'),
    ] as const;
  const pickedNotFound = () =>
    [
      t('poll.errors.pickedNotFound', 'en'),
      t('poll.errors.pickedNotFoundDesc', 'en'),
    ] as const;

  it('says so, pointing at poll create, when the user has no open poll', async () => {
    const fetch = vi.fn();
    const { interaction, reply } = endInteraction(fetch);

    await executePollCommand(interaction);

    expectEphemeralError(reply, ...noPoll());
    expect(fetch).not.toHaveBeenCalled();
    expect(awaitConfirmationResult).not.toHaveBeenCalled();
  });

  it('gives the cooldown back when there is nothing to end', async () => {
    const { interaction } = endInteraction(vi.fn());
    expect(await onCooldown(interaction)).toBe(false);

    await executePollCommand(interaction);

    expect(await onCooldown(interaction)).toBe(false);
  });

  it('will not end a poll that belongs to someone else', async () => {
    seedPoll({ creator_id: 'owner' });
    const fetch = vi.fn().mockResolvedValue(pollMessage());
    const { interaction, reply } = endInteraction(fetch, {
      userId: 'intruder',
    });

    await executePollCommand(interaction);

    expectEphemeralError(reply, ...noPoll());
    expect(fetch).not.toHaveBeenCalled();
    expect(storedPolls()).toHaveLength(1);
  });

  it('ends the poll from another channel of the server, saying where it is', async () => {
    seedPoll({ channel_id: 'elsewhere' });
    const update = confirmedPress();
    const message = pollMessage();
    const remoteFetch = vi.fn().mockResolvedValue(message);
    const { interaction, editReply } = endInteraction(vi.fn(), {
      guildChannels: { elsewhere: textChannel(remoteFetch) },
    });

    await executePollCommand(interaction);

    expect(remoteFetch).toHaveBeenCalledWith({
      message: 'poll-msg-1',
      force: true,
    });
    const body = awaitConfirmationResult.mock.calls[0][1] as string;
    expect(body).toContain(
      t('poll.confirm.inChannel', 'en', { channel: 'elsewhere' })
    );
    expect(update).toHaveBeenCalledTimes(1);
    expect(message.poll.end).toHaveBeenCalledTimes(1);
    expect(lastEmbed(editReply).title).toBe(t('poll.ended', 'en'));
    expect(storedPolls()).toEqual([]);
  });

  it('prefers a poll in this channel over a newer one elsewhere', async () => {
    seedPoll({ message_id: 'here' });
    vi.advanceTimersByTime(1_000);
    seedPoll({ message_id: 'there', channel_id: 'elsewhere' });
    const fetch = vi.fn().mockResolvedValue(pollMessage());
    awaitConfirmationResult.mockResolvedValue({ outcome: 'cancelled' });
    const { interaction } = endInteraction(fetch);

    await executePollCommand(interaction);

    expect(fetch).toHaveBeenCalledWith({ message: 'here', force: true });
    const body = awaitConfirmationResult.mock.calls[0][1] as string;
    expect(body).not.toContain('<#');
  });

  it('targets the newest of several open polls here', async () => {
    seedPoll({ message_id: 'older' });
    vi.advanceTimersByTime(1_000);
    seedPoll({ message_id: 'newer' });
    const fetch = vi.fn().mockResolvedValue(pollMessage());
    awaitConfirmationResult.mockResolvedValue({ outcome: 'cancelled' });
    const { interaction } = endInteraction(fetch);

    await executePollCommand(interaction);

    expect(fetch).toHaveBeenCalledWith({ message: 'newer', force: true });
  });

  it('does not reach into another server', async () => {
    seedPoll({ guild_id: 'guild-2', channel_id: 'elsewhere' });
    const { interaction, reply } = endInteraction(vi.fn(), {
      guildChannels: { elsewhere: textChannel(vi.fn()) },
    });

    await executePollCommand(interaction);

    expectEphemeralError(reply, ...noPoll());
  });

  it('treats a poll past its deadline as no poll at all', async () => {
    seedPoll({ expires_at: NOW + HOUR });
    vi.advanceTimersByTime(HOUR);
    const { interaction, reply } = endInteraction(vi.fn());

    await executePollCommand(interaction);

    expectEphemeralError(reply, ...noPoll());
  });

  describe('with a poll picked in the `poll` option', () => {
    it('ends that poll, even when a newer one is open here', async () => {
      seedPoll({ message_id: 'older', channel_id: 'elsewhere' });
      vi.advanceTimersByTime(1_000);
      seedPoll({ message_id: 'newer' });
      const remoteFetch = vi.fn().mockResolvedValue(pollMessage());
      awaitConfirmationResult.mockResolvedValue({ outcome: 'cancelled' });
      const { interaction } = endInteraction(vi.fn(), {
        values: { poll: 'older' },
        guildChannels: { elsewhere: textChannel(remoteFetch) },
      });

      await executePollCommand(interaction);

      expect(remoteFetch).toHaveBeenCalledWith({
        message: 'older',
        force: true,
      });
    });

    it.each([
      ["someone else's poll", { creator_id: 'owner' }],
      ['a poll in another server', { guild_id: 'guild-2' }],
      ['a poll past its deadline', { expires_at: NOW }],
    ])('refuses %s', async (_, overrides) => {
      seedPoll({ message_id: 'picked', ...overrides });
      const fetch = vi.fn();
      const { interaction, reply } = endInteraction(fetch, {
        values: { poll: 'picked' },
      });

      await executePollCommand(interaction);

      // Not "you have no open poll": the caller may well have others.
      expectEphemeralError(reply, ...pickedNotFound());
      expect(fetch).not.toHaveBeenCalled();
    });

    it('refuses text that names no poll, giving the cooldown back', async () => {
      seedPoll();
      const { interaction, reply } = endInteraction(vi.fn(), {
        values: { poll: 'lunch' },
      });
      expect(await onCooldown(interaction)).toBe(false);

      await executePollCommand(interaction);

      expectEphemeralError(reply, ...pickedNotFound());
      expect(await onCooldown(interaction)).toBe(false);
      expect(storedPolls()).toHaveLength(1);
    });
  });

  it('asks Discord, not the cache, whether the poll is still open', async () => {
    // The cached copy is the one the bot posted; Discord closed it since.
    seedPoll();
    const fetch = vi.fn(async (options: { force?: boolean }) =>
      options.force
        ? pollMessage({ resultsFinalized: true })
        : pollMessage({ resultsFinalized: false })
    );
    const { interaction, reply } = endInteraction(fetch);

    await executePollCommand(interaction);

    expectEphemeralError(reply, ...pollGone());
    expect(awaitConfirmationResult).not.toHaveBeenCalled();
    expect(storedPolls()).toEqual([]);
  });

  it('treats a fetched poll past its deadline as closed, without asking to end it', async () => {
    // The pointer's expiry is a little later than Discord's own deadline.
    seedPoll({ expires_at: NOW + HOUR });
    const fetch = vi
      .fn()
      .mockResolvedValue(pollMessage({ expiresTimestamp: NOW }));
    const { interaction, reply } = endInteraction(fetch);

    await executePollCommand(interaction);

    expectEphemeralError(reply, ...pollGone());
    expect(awaitConfirmationResult).not.toHaveBeenCalled();
    expect(storedPolls()).toEqual([]);
  });

  it.each([
    ['a moment before its deadline', NOW + 1],
    ['with no deadline', null],
  ])('asks to end a poll %s', async (_, expiresTimestamp) => {
    seedPoll();
    awaitConfirmationResult.mockResolvedValue({ outcome: 'cancelled' });
    const { interaction } = endInteraction(
      vi.fn().mockResolvedValue(pollMessage({ expiresTimestamp }))
    );

    await executePollCommand(interaction);

    expect(awaitConfirmationResult).toHaveBeenCalledTimes(1);
  });

  it('forgets the pointer when the poll message was deleted', async () => {
    seedPoll();
    const fetch = vi
      .fn()
      .mockRejectedValue(apiError(RESTJSONErrorCodes.UnknownMessage));
    const { interaction, reply } = endInteraction(fetch);

    await executePollCommand(interaction);

    expectEphemeralError(reply, ...pollGone());
    expect(storedPolls()).toEqual([]);
    expect(awaitConfirmationResult).not.toHaveBeenCalled();
  });

  it("forgets the pointer when the poll's channel was deleted", async () => {
    seedPoll({ channel_id: 'elsewhere' });
    const { interaction, reply } = endInteraction(vi.fn());
    const guild = interaction.guild as unknown as {
      channels: { fetch: ReturnType<typeof vi.fn> };
    };
    guild.channels.fetch.mockRejectedValue(
      apiError(RESTJSONErrorCodes.UnknownChannel)
    );

    await executePollCommand(interaction);

    expectEphemeralError(reply, ...pollGone());
    expect(storedPolls()).toEqual([]);
  });

  it('forgets the pointer when the message no longer carries a poll', async () => {
    seedPoll();
    const fetch = vi.fn().mockResolvedValue({ id: 'poll-msg-1', poll: null });
    const { interaction, reply } = endInteraction(fetch);

    await executePollCommand(interaction);

    expectEphemeralError(reply, ...pollGone());
    expect(storedPolls()).toEqual([]);
  });

  it('forgets the pointer when the channel cannot hold messages', async () => {
    seedPoll();
    const { interaction, reply } = commandInteraction({
      group: 'poll',
      subcommand: 'end',
      textChannel: { isTextBased: () => false },
    });

    await executePollCommand(interaction);

    expectEphemeralError(reply, ...pollGone());
    expect(storedPolls()).toEqual([]);
  });

  it('looks the channel up when it is not cached', async () => {
    seedPoll();
    const fetch = vi.fn().mockResolvedValue(pollMessage());
    awaitConfirmationResult.mockResolvedValue({ outcome: 'cancelled' });
    const { interaction } = commandInteraction({
      group: 'poll',
      subcommand: 'end',
      textChannel: null,
      guildChannels: { 'chan-1': textChannel(fetch) },
    });

    await executePollCommand(interaction);

    expect(fetch).toHaveBeenCalledWith({ message: 'poll-msg-1', force: true });
  });

  it.each([
    ['missing access', RESTJSONErrorCodes.MissingAccess],
    ['missing permissions', RESTJSONErrorCodes.MissingPermissions],
  ])(
    'keeps the pointer and names the channel when the bot has %s',
    async (_, code) => {
      seedPoll({ channel_id: 'elsewhere' });
      const remoteFetch = vi.fn().mockRejectedValue(apiError(code));
      const { interaction, reply } = endInteraction(vi.fn(), {
        guildChannels: { elsewhere: textChannel(remoteFetch) },
      });

      await executePollCommand(interaction);

      expectEphemeralError(
        reply,
        t('poll.errors.endFailed', 'en'),
        t('poll.errors.noAccessDesc', 'en', { channel: 'elsewhere' })
      );
      expect(storedPolls()).toHaveLength(1);
    }
  );

  it('keeps the pointer on any other failure, with an id that is in the log', async () => {
    seedPoll();
    const fetch = vi.fn().mockRejectedValue(new Error('socket hang up'));
    const { interaction, reply } = endInteraction(fetch);

    await executePollCommand(interaction);

    const logged = vi
      .mocked(logger.warn)
      .mock.calls.map(([message]) => String(message))
      .find((message) => message.includes('poll-msg-1'));
    const id = /\[([0-9a-f]{6})\]/.exec(logged ?? '')?.[1];
    expect(id).toBeDefined();
    expectEphemeralError(
      reply,
      t('poll.errors.endFailed', 'en'),
      t('common.unexpectedError', 'en', { id: id! })
    );
    expect(storedPolls()).toHaveLength(1);
  });

  it('asks for confirmation, saying what ending does', async () => {
    seedPoll();
    awaitConfirmationResult.mockResolvedValue({ outcome: 'cancelled' });
    const { interaction } = endInteraction(
      vi.fn().mockResolvedValue(pollMessage({ question: 'Lunch?' }))
    );

    await executePollCommand(interaction);

    expect(awaitConfirmationResult).toHaveBeenCalledWith(
      interaction,
      `**Lunch?**\n${t('poll.confirm.body', 'en')}`,
      {
        ephemeral: true,
        title: t('poll.confirm.title', 'en'),
        confirmLabel: t('poll.confirm.confirm', 'en'),
        confirmStyle: ButtonStyle.Danger,
        cancelLabel: t('poll.confirm.cancel', 'en'),
      }
    );
  });

  it('keeps markdown in the question from reshaping the prompt', async () => {
    seedPoll();
    awaitConfirmationResult.mockResolvedValue({ outcome: 'cancelled' });
    const { interaction } = endInteraction(
      vi.fn().mockResolvedValue(pollMessage({ question: '**Lunch** _now_?' }))
    );

    await executePollCommand(interaction);

    const body = awaitConfirmationResult.mock.calls[0][1] as string;
    expect(body.split('\n')[0]).toBe('**\\*\\*Lunch\\*\\* \\_now\\_?**');
  });

  it.each([
    ['empty', ''],
    ['null', null],
  ])('leaves the question out when its text is %s', async (_, question) => {
    seedPoll();
    awaitConfirmationResult.mockResolvedValue({ outcome: 'cancelled' });
    const { interaction } = endInteraction(
      vi.fn().mockResolvedValue(pollMessage({ question }))
    );

    await executePollCommand(interaction);

    expect(awaitConfirmationResult.mock.calls[0][1]).toBe(
      t('poll.confirm.body', 'en')
    );
  });

  it.each(['cancelled', 'timeout'])(
    'leaves the poll running when the prompt is %s',
    async (outcome) => {
      seedPoll();
      awaitConfirmationResult.mockResolvedValue({ outcome });
      const message = pollMessage();
      const { interaction, editReply } = endInteraction(
        vi.fn().mockResolvedValue(message)
      );

      await executePollCommand(interaction);

      expect(message.poll.end).not.toHaveBeenCalled();
      // The prompt already says what happened.
      expect(editReply).not.toHaveBeenCalled();
      expect(storedPolls()).toHaveLength(1);
    }
  );

  it('ends the poll on confirmation and forgets the pointer', async () => {
    seedPoll();
    const update = confirmedPress();
    const message = pollMessage();
    const { interaction, editReply } = endInteraction(
      vi.fn().mockResolvedValue(message)
    );

    await executePollCommand(interaction);

    expect(update).toHaveBeenCalledWith({ components: [] });
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

  it('answers the press without waiting for Discord to end the poll', async () => {
    seedPoll();
    const update = confirmedPress();
    let finishEnd: () => void = () => undefined;
    const message = pollMessage({
      end: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            finishEnd = resolve;
          })
      ),
    });
    const { interaction, editReply } = endInteraction(
      vi.fn().mockResolvedValue(message)
    );

    const pending = executePollCommand(interaction);
    await vi.advanceTimersByTimeAsync(0);

    expect(message.poll.end).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledTimes(1);
    expect(editReply).not.toHaveBeenCalled();

    finishEnd();
    await pending;
    expect(lastEmbed(editReply).title).toBe(t('poll.ended', 'en'));
  });

  it('still ends the poll when the press cannot be answered', async () => {
    seedPoll();
    const update = confirmedPress();
    update.mockRejectedValue(new Error('Unknown interaction'));
    const message = pollMessage();
    const { interaction, editReply } = endInteraction(
      vi.fn().mockResolvedValue(message)
    );

    await executePollCommand(interaction);

    expect(message.poll.end).toHaveBeenCalledTimes(1);
    expect(lastEmbed(editReply).title).toBe(t('poll.ended', 'en'));
    expect(storedPolls()).toEqual([]);
  });

  it('reports a poll Discord says has expired as closed, and forgets it', async () => {
    seedPoll();
    confirmedPress();
    const message = pollMessage({
      end: vi.fn().mockRejectedValue(apiError(RESTJSONErrorCodes.PollExpired)),
    });
    const { interaction, editReply } = endInteraction(
      vi.fn().mockResolvedValue(message)
    );

    await executePollCommand(interaction);

    expect(editReply.mock.calls[0][0]).toMatchObject({ components: [] });
    expect(lastEmbed(editReply)).toMatchObject({
      title: t('poll.errors.pollEnded', 'en'),
      description: t('poll.errors.pollEndedDesc', 'en'),
      color: COLORS.ERROR,
    });
    expect(storedPolls()).toEqual([]);
  });

  it('reports a poll that passed its deadline during the confirmation as closed', async () => {
    seedPoll();
    confirmedPress();
    const message = pollMessage({
      end: vi.fn().mockRejectedValue(pollAlreadyExpired()),
    });
    const { interaction, editReply } = endInteraction(
      vi.fn().mockResolvedValue(message)
    );

    await executePollCommand(interaction);

    expect(lastEmbed(editReply)).toMatchObject({
      title: t('poll.errors.pollEnded', 'en'),
      description: t('poll.errors.pollEndedDesc', 'en'),
    });
    expect(storedPolls()).toEqual([]);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('keeps the pointer when ending fails for another reason', async () => {
    seedPoll();
    confirmedPress();
    const message = pollMessage({
      end: vi.fn().mockRejectedValue(new Error('Service Unavailable')),
    });
    const { interaction, editReply } = endInteraction(
      vi.fn().mockResolvedValue(message)
    );

    await executePollCommand(interaction);

    expect(logger.warn).toHaveBeenCalledWith(
      mentioning(/\[[0-9a-f]{6}\]/, 'poll-msg-1'),
      expect.stringContaining('Service Unavailable')
    );
    expect(lastEmbed(editReply)).toMatchObject({
      title: t('poll.errors.endFailed', 'en'),
      color: COLORS.ERROR,
    });
    expect(storedPolls()).toHaveLength(1);
  });

  it('keeps the poll and its pointer when the confirmation cannot be shown', async () => {
    seedPoll();
    awaitConfirmationResult.mockRejectedValue(new Error('Unknown interaction'));
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
    confirmedPress();
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
    confirmedPress();
    const { interaction, editReply } = endInteraction(
      vi.fn().mockResolvedValue(pollMessage())
    );

    await executePollCommand(interaction);

    expect(awaitConfirmationResult.mock.calls[0][2]).toMatchObject({
      title: t('poll.confirm.title', 'ja'),
      confirmLabel: t('poll.confirm.confirm', 'ja'),
    });
    expect(lastEmbed(editReply).title).toBe(t('poll.ended', 'ja'));
  });
});

describe('/community poll end autocomplete', () => {
  function autocomplete(
    options: {
      focused?: string;
      guildId?: string | null;
      channels?: Record<string, string>;
    } = {}
  ) {
    const respond = vi.fn().mockResolvedValue(undefined);
    const channels = options.channels ?? {
      'chan-1': 'general',
      'chan-2': 'events',
    };
    const interaction = {
      guildId: options.guildId === undefined ? 'guild-1' : options.guildId,
      guild: {
        channels: {
          cache: new Map(
            Object.entries(channels).map(([id, name]) => [id, { name }])
          ),
        },
      },
      user: { id: 'user-1' },
      locale: 'en-US',
      options: { getFocused: () => options.focused ?? '' },
      respond,
    };
    return {
      interaction: interaction as unknown as Parameters<
        typeof autocompletePollToEnd
      >[0],
      respond,
    };
  }

  function choices(respond: ReturnType<typeof vi.fn>) {
    return respond.mock.calls[0][0] as Array<{ name: string; value: string }>;
  }

  it("suggests the caller's open polls here, newest first, by channel and time left", async () => {
    seedPoll({ message_id: 'old', expires_at: NOW + 3 * HOUR });
    vi.advanceTimersByTime(60_000);
    seedPoll({
      message_id: 'new',
      channel_id: 'chan-2',
      expires_at: NOW + 24 * HOUR,
    });
    const { interaction, respond } = autocomplete();

    await autocompletePollToEnd(interaction);

    expect(choices(respond)).toEqual([
      {
        name: t('poll.endChoice', 'en', {
          channel: 'events',
          remaining: '23 hours 59 minutes',
        }),
        value: 'new',
      },
      {
        name: t('poll.endChoice', 'en', {
          channel: 'general',
          remaining: '2 hours 59 minutes',
        }),
        value: 'old',
      },
    ]);
  });

  it('leaves out other users, other servers and expired polls', async () => {
    seedPoll({ message_id: 'mine' });
    seedPoll({ message_id: 'theirs', creator_id: 'user-2' });
    seedPoll({ message_id: 'away', guild_id: 'guild-2' });
    seedPoll({ message_id: 'over', expires_at: NOW });
    const { interaction, respond } = autocomplete();

    await autocompletePollToEnd(interaction);

    expect(choices(respond).map((c) => c.value)).toEqual(['mine']);
  });

  it('narrows the list to what was typed', async () => {
    seedPoll({ message_id: 'a' });
    seedPoll({ message_id: 'b', channel_id: 'chan-2' });
    const { interaction, respond } = autocomplete({ focused: 'EVE' });

    await autocompletePollToEnd(interaction);

    expect(choices(respond).map((c) => c.value)).toEqual(['b']);
  });

  it('finds a poll by typing even when it is older than the first 25', async () => {
    seedPoll({ message_id: 'oldest', channel_id: 'chan-2' });
    for (let i = 0; i < 30; i++) {
      vi.advanceTimersByTime(1_000);
      seedPoll({ message_id: `newer-${i}` });
    }
    const { interaction, respond } = autocomplete({ focused: 'events' });

    await autocompletePollToEnd(interaction);

    expect(choices(respond).map((c) => c.value)).toEqual(['oldest']);
  });

  it('suggests at most 25, the newest', async () => {
    for (let i = 0; i < 30; i++) {
      vi.advanceTimersByTime(1_000);
      seedPoll({ message_id: `poll-${i}` });
    }
    const { interaction, respond } = autocomplete();

    await autocompletePollToEnd(interaction);

    const values = choices(respond).map((c) => c.value);
    expect(values).toHaveLength(25);
    expect(values[0]).toBe('poll-29');
    expect(values.at(-1)).toBe('poll-5');
  });

  it('cuts a long channel name, never the time left or an emoji in half', async () => {
    seedPoll({ channel_id: 'chan-long' });
    const { interaction, respond } = autocomplete({
      channels: { 'chan-long': `${'a'.repeat(83)}${'🎉'.repeat(10)}` },
    });

    await autocompletePollToEnd(interaction);

    const [{ name }] = choices(respond);
    const remaining = formatDuration(HOUR, 'en', { style: 'long' });
    expect(name.length).toBeLessThanOrEqual(100);
    expect(name.endsWith(`… · ${remaining} left`)).toBe(true);
    expect(name).not.toMatch(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/
    );
  });

  it('suggests nothing outside a server', async () => {
    seedPoll();
    const { interaction, respond } = autocomplete({ guildId: null });

    await autocompletePollToEnd(interaction);

    expect(respond).toHaveBeenCalledWith([]);
  });

  it('is what the command answers autocomplete with', async () => {
    seedPoll({ message_id: 'mine' });
    const { interaction, respond } = autocomplete();

    await command.autocomplete?.(interaction);

    expect(choices(respond).map((c) => c.value)).toEqual(['mine']);
  });
});

it('keeps the component types the form relies on', () => {
  // A guard against a discord.js upgrade renumbering the new components.
  expect(ComponentType.Label).toBe(18);
  expect(ComponentType.RadioGroup).toBe(21);
  expect(ComponentType.Checkbox).toBe(23);
});
