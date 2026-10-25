import Database from 'better-sqlite3';
import { ChannelType, MessageFlags } from 'discord.js';
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
  voiceChannel,
  voiceMember,
  type VoiceMemberStub,
} from './community.helpers.js';

/**
 * Roulette reads the invoker's voice channel, drops bots, and animates a
 * countdown before revealing a pick or a team split. Timers are faked so the
 * ~3.6s animation runs instantly, and Math.random is pinned wherever the
 * outcome matters.
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

const { executeRouletteCommand } = await import('../application/roulette.js');
const { command } = await import('../commands/roulette.js');
const { MAX_ANSWER_LENGTH } = await import('../poll/application.js');
const { t } = await import('../../../locales/index.js');
const { COLORS } = await import('../../../shared/utils/constants/index.js');
const { logger } = await import('../../../shared/utils/logger.js');

/** Countdown 3-2-1 at 800ms each, then 1200ms on the candidate list. */
const ANIMATION_MS = 3 * 800 + 1200;

async function run(
  interaction: Parameters<typeof executeRouletteCommand>[0]
): Promise<void> {
  const pending = executeRouletteCommand(interaction);
  await vi.runAllTimersAsync();
  await pending;
}

function humans(count: number): VoiceMemberStub[] {
  return Array.from({ length: count }, (_, i) => voiceMember(`u${i + 1}`));
}

/** Deterministic stand-in for Math.random (32-bit LCG). */
function seededRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 2 ** 32;
    return state / 2 ** 32;
  };
}

/** Member ids per team, read back from the final result embed. */
function teamsFrom(editReply: ReturnType<typeof vi.fn>): string[][] {
  return (lastEmbed(editReply).fields ?? []).map((field) =>
    field.value.split('\n').map((mention) => mention.replace(/[<@>]/g, ''))
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  resolveLocale.mockReturnValue('en');
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

afterAll(() => {
  db.close();
});

describe('executeRouletteCommand', () => {
  it('ignores an unknown subcommand without replying', async () => {
    const { interaction, reply, deferReply } = commandInteraction({
      subcommand: 'unknown',
      voice: voiceChannel(humans(3)),
    });

    await run(interaction);

    expect(reply).not.toHaveBeenCalled();
    expect(deferReply).not.toHaveBeenCalled();
  });

  describe.each(['member', 'team'])('/roulette %s guards', (subcommand) => {
    const values = { count: 2 };

    it.each([
      ['guild', { hasGuild: false }],
      ['member', { hasMember: false }],
    ])('refuses ephemerally when the %s is missing', async (_, missing) => {
      const { interaction, reply, deferReply } = commandInteraction({
        subcommand,
        values,
        voice: voiceChannel(humans(3)),
        ...missing,
      });

      await run(interaction);

      expect(reply).toHaveBeenCalledTimes(1);
      expect(flagsAt(reply)).toBe(MessageFlags.Ephemeral);
      expect(embedAt(reply)).toMatchObject({
        title: t('common.error', 'en'),
        description: t('common.guildOnly', 'en'),
        color: COLORS.ERROR,
      });
      expect(deferReply).not.toHaveBeenCalled();
    });

    it('refuses, rather than crashing, for a raw member of an uncached guild', async () => {
      // discord.js only wraps the member as a GuildMember (with .voice) when
      // the guild is cached; otherwise it is the bare API payload.
      const { interaction, reply, deferReply } = commandInteraction({
        subcommand,
        values,
        hasGuild: false,
        rawMember: { user: { id: 'user-1' }, roles: [], permissions: '0' },
      });

      await expect(run(interaction)).resolves.toBeUndefined();

      expect(flagsAt(reply)).toBe(MessageFlags.Ephemeral);
      expect(embedAt(reply).description).toBe(t('common.guildOnly', 'en'));
      expect(deferReply).not.toHaveBeenCalled();
    });

    it('accepts a stage channel as a voice channel', async () => {
      const { interaction, reply, deferReply, editReply } = commandInteraction({
        subcommand,
        values,
        voice: voiceChannel(humans(3), { type: ChannelType.GuildStageVoice }),
      });

      await run(interaction);

      expect(reply).not.toHaveBeenCalled();
      expect(deferReply).toHaveBeenCalledTimes(1);
      expect(lastEmbed(editReply).color).toBe(COLORS.SUCCESS);
    });

    it('tells a member who is not in voice to join one', async () => {
      const { interaction, reply, deferReply } = commandInteraction({
        subcommand,
        values,
        voice: null,
      });

      await run(interaction);

      expect(flagsAt(reply)).toBe(MessageFlags.Ephemeral);
      expect(embedAt(reply)).toMatchObject({
        title: t('roulette.errors.notInVoice', 'en'),
        description: t('roulette.errors.notInVoiceDesc', 'en'),
      });
      expect(deferReply).not.toHaveBeenCalled();
    });

    it('does not treat a non-voice channel as a voice channel', async () => {
      const { interaction, reply, deferReply } = commandInteraction({
        subcommand,
        values,
        voice: voiceChannel(humans(3), { type: ChannelType.GuildText }),
      });

      await run(interaction);

      expect(embedAt(reply).title).toBe(t('roulette.errors.notInVoice', 'en'));
      expect(deferReply).not.toHaveBeenCalled();
    });

    it('answers in the resolved locale', async () => {
      resolveLocale.mockReturnValue('ja');
      const { interaction, reply } = commandInteraction({
        subcommand,
        values,
        voice: null,
      });

      await run(interaction);

      expect(resolveLocale).toHaveBeenCalledWith(interaction);
      expect(embedAt(reply).title).toBe(t('roulette.errors.notInVoice', 'ja'));
    });
  });

  describe('/roulette member', () => {
    it('reports no members when only bots share the channel', async () => {
      const { interaction, reply, deferReply } = commandInteraction({
        subcommand: 'member',
        voice: voiceChannel([
          voiceMember('bot-1', { bot: true }),
          voiceMember('bot-2', { bot: true }),
        ]),
      });

      await run(interaction);

      expect(flagsAt(reply)).toBe(MessageFlags.Ephemeral);
      expect(embedAt(reply)).toMatchObject({
        title: t('roulette.errors.noMembers', 'en'),
        description: t('roulette.errors.noMembersDesc', 'en'),
      });
      expect(deferReply).not.toHaveBeenCalled();
    });

    it('picks the lone human straight away, skipping the animation', async () => {
      const { interaction, reply, deferReply, editReply } = commandInteraction({
        subcommand: 'member',
        voice: voiceChannel([
          voiceMember('bot-1', { bot: true }),
          voiceMember('solo'),
        ]),
      });

      await run(interaction);

      expect(reply).toHaveBeenCalledTimes(1);
      expect(flagsAt(reply)).toBeUndefined();
      expect(embedAt(reply)).toMatchObject({
        title: t('roulette.member.result', 'en'),
        description: t('roulette.member.onlyOne', 'en', { member: '<@solo>' }),
        color: COLORS.SUCCESS,
      });
      expect(deferReply).not.toHaveBeenCalled();
      expect(editReply).not.toHaveBeenCalled();
    });

    it('announces the lone human in the resolved locale', async () => {
      resolveLocale.mockReturnValue('ja');
      const { interaction, reply } = commandInteraction({
        subcommand: 'member',
        voice: voiceChannel([voiceMember('solo')]),
      });

      await run(interaction);

      expect(embedAt(reply)).toMatchObject({
        title: t('roulette.member.result', 'ja'),
        description: t('roulette.member.onlyOne', 'ja', { member: '<@solo>' }),
      });
    });

    it('counts down, lists the humans, then reveals the pick', async () => {
      vi.spyOn(Math, 'random').mockReturnValue(0);
      const members = [
        voiceMember('a', { displayName: 'Alice' }),
        voiceMember('bot', { bot: true, displayName: 'Robo' }),
        voiceMember('b', { displayName: 'Bob' }),
        voiceMember('c', { displayName: 'Carol' }),
      ];
      const { interaction, reply, deferReply, editReply } = commandInteraction({
        subcommand: 'member',
        voice: voiceChannel(members, { name: 'Lounge' }),
      });

      await run(interaction);

      expect(reply).not.toHaveBeenCalled();
      expect(deferReply).toHaveBeenCalledTimes(1);
      expect(editReply).toHaveBeenCalledTimes(5);

      const countdown = [0, 1, 2].map((i) => embedAt(editReply, i));
      expect(countdown.map((e) => e.description)).toEqual(
        [3, 2, 1].map(
          (count) => `**${t('roulette.member.countdown', 'en', { count })}**`
        )
      );
      for (const frame of countdown) {
        expect(frame.title).toBe(t('roulette.member.title', 'en'));
        expect(frame.color).toBe(COLORS.WARNING);
        expect(frame.timestamp).toBeUndefined();
      }

      expect(embedAt(editReply, 3).description).toBe(
        t('roulette.member.selecting', 'en', {
          candidates: 'Alice, Bob, Carol',
        })
      );

      expect(lastEmbed(editReply)).toMatchObject({
        title: t('roulette.member.result', 'en'),
        description: '<@a>',
        color: COLORS.SUCCESS,
        footer: {
          text: t('roulette.member.footer', 'en', {
            count: 3,
            channel: 'Lounge',
          }),
        },
      });
      expect(lastEmbed(editReply).timestamp).toBeDefined();
      expect(logger.info).toHaveBeenCalledWith(
        mentioning('Alice', /\b3\b/, 'user-1#0001')
      );
    });

    it('plays the animation and reveals the pick in the resolved locale', async () => {
      resolveLocale.mockReturnValue('ja');
      vi.spyOn(Math, 'random').mockReturnValue(0.999);
      const { interaction, editReply } = commandInteraction({
        subcommand: 'member',
        voice: voiceChannel(
          [
            voiceMember('a', { displayName: 'Alice' }),
            voiceMember('b', { displayName: 'Bob' }),
          ],
          { name: 'Lounge' }
        ),
      });

      await run(interaction);

      expect([0, 1, 2, 3].map((i) => embedAt(editReply, i).title)).toEqual(
        Array(4).fill(t('roulette.member.title', 'ja'))
      );
      expect(embedAt(editReply, 0).description).toBe(
        `**${t('roulette.member.countdown', 'ja', { count: 3 })}**`
      );
      expect(embedAt(editReply, 3).description).toBe(
        t('roulette.member.selecting', 'ja', { candidates: 'Alice, Bob' })
      );
      expect(lastEmbed(editReply)).toMatchObject({
        title: t('roulette.member.result', 'ja'),
        description: '<@b>',
        footer: {
          text: t('roulette.member.footer', 'ja', {
            count: 2,
            channel: 'Lounge',
          }),
        },
      });
    });

    it.each([
      [0, 'u1'],
      [0.5, 'u3'],
      [0.999, 'u5'],
    ])(
      'maps Math.random() = %s onto the member at that position (%s)',
      async (random, winner) => {
        vi.spyOn(Math, 'random').mockReturnValue(random);
        const { interaction, editReply } = commandInteraction({
          subcommand: 'member',
          voice: voiceChannel(humans(5)),
        });

        await run(interaction);

        expect(lastEmbed(editReply).description).toBe(`<@${winner}>`);
      }
    );

    it('never picks a bot', async () => {
      vi.spyOn(Math, 'random').mockReturnValue(0.999);
      const { interaction, editReply } = commandInteraction({
        subcommand: 'member',
        voice: voiceChannel([
          voiceMember('a'),
          voiceMember('b'),
          voiceMember('bot', { bot: true }),
        ]),
      });

      await run(interaction);

      expect(lastEmbed(editReply).description).toBe('<@b>');
    });

    it('holds the result back until the animation has played', async () => {
      const { interaction, editReply } = commandInteraction({
        subcommand: 'member',
        voice: voiceChannel(humans(2)),
      });

      const pending = executeRouletteCommand(interaction);
      await vi.advanceTimersByTimeAsync(0);
      expect(editReply).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(ANIMATION_MS - 1);
      expect(editReply).toHaveBeenCalledTimes(4);

      await vi.advanceTimersByTimeAsync(1);
      await pending;
      expect(editReply).toHaveBeenCalledTimes(5);
      expect(lastEmbed(editReply).title).toBe(
        t('roulette.member.result', 'en')
      );
    });

    it('lets a Discord API failure reach the command handler', async () => {
      const { interaction, deferReply, editReply } = commandInteraction({
        subcommand: 'member',
        voice: voiceChannel(humans(2)),
      });
      deferReply.mockRejectedValue(new Error('Unknown interaction'));

      await expect(executeRouletteCommand(interaction)).rejects.toThrow(
        'Unknown interaction'
      );
      expect(editReply).not.toHaveBeenCalled();
    });
  });

  describe('/roulette team', () => {
    it('refuses when there are fewer humans than teams', async () => {
      const { interaction, reply, deferReply } = commandInteraction({
        subcommand: 'team',
        values: { count: 3 },
        voice: voiceChannel([
          voiceMember('a'),
          voiceMember('b'),
          voiceMember('bot', { bot: true }),
        ]),
      });

      await run(interaction);

      expect(flagsAt(reply)).toBe(MessageFlags.Ephemeral);
      expect(embedAt(reply)).toMatchObject({
        title: t('roulette.errors.notEnough', 'en'),
        description: t('roulette.errors.notEnoughDesc', 'en', {
          teams: 3,
          required: 3,
          current: 2,
        }),
      });
      expect(deferReply).not.toHaveBeenCalled();
    });

    it('splits evenly with one member per team at the boundary', async () => {
      const { interaction, editReply } = commandInteraction({
        subcommand: 'team',
        values: { count: 3 },
        voice: voiceChannel(humans(3)),
      });

      await run(interaction);

      const teams = teamsFrom(editReply);
      expect(teams).toHaveLength(3);
      expect(teams.map((team) => team.length)).toEqual([1, 1, 1]);
    });

    it('deals members round-robin in shuffled order', async () => {
      // 0.999 makes every Fisher-Yates swap a no-op, so order is preserved.
      vi.spyOn(Math, 'random').mockReturnValue(0.999);
      const { interaction, editReply } = commandInteraction({
        subcommand: 'team',
        values: { count: 2 },
        voice: voiceChannel(humans(4)),
      });

      await run(interaction);

      expect(teamsFrom(editReply)).toEqual([
        ['u1', 'u3'],
        ['u2', 'u4'],
      ]);
    });

    it('shuffles before dealing', async () => {
      // 0 swaps each slot with the first: [1,2,3,4] -> [2,3,4,1].
      vi.spyOn(Math, 'random').mockReturnValue(0);
      const { interaction, editReply } = commandInteraction({
        subcommand: 'team',
        values: { count: 2 },
        voice: voiceChannel(humans(4)),
      });

      await run(interaction);

      expect(teamsFrom(editReply)).toEqual([
        ['u2', 'u4'],
        ['u3', 'u1'],
      ]);
    });

    it('gives the extra members to the first teams on an uneven split', async () => {
      const { interaction, editReply } = commandInteraction({
        subcommand: 'team',
        values: { count: 3 },
        voice: voiceChannel(humans(5)),
      });

      await run(interaction);

      const fields = lastEmbed(editReply).fields ?? [];
      expect(fields.map((f) => f.name)).toEqual([
        t('roulette.team.teamName', 'en', { number: 1, count: 2 }),
        t('roulette.team.teamName', 'en', { number: 2, count: 2 }),
        t('roulette.team.teamName', 'en', { number: 3, count: 1 }),
      ]);
      expect(fields.every((f) => f.inline)).toBe(true);
    });

    it('leaves bots out of every team', async () => {
      const { interaction, editReply } = commandInteraction({
        subcommand: 'team',
        values: { count: 2 },
        voice: voiceChannel([
          ...humans(4),
          voiceMember('bot-1', { bot: true }),
          voiceMember('bot-2', { bot: true }),
        ]),
      });

      await run(interaction);

      expect(teamsFrom(editReply).flat().sort()).toEqual([
        'u1',
        'u2',
        'u3',
        'u4',
      ]);
    });

    it('assigns every member to exactly one team for any team count', async () => {
      vi.spyOn(Math, 'random').mockImplementation(seededRandom(42));

      for (const teamCount of [2, 3, 4, 5, 6]) {
        for (const size of [teamCount, teamCount + 1, 7, 12]) {
          const members = humans(size);
          const { interaction, editReply } = commandInteraction({
            subcommand: 'team',
            values: { count: teamCount },
            voice: voiceChannel(members),
          });

          await run(interaction);

          const teams = teamsFrom(editReply);
          const sizes = teams.map((team) => team.length);
          expect(teams).toHaveLength(teamCount);
          expect(teams.flat().sort()).toEqual(members.map((m) => m.id).sort());
          expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(
            1
          );
        }
      }
    });

    it('animates the shuffle and summarises the result', async () => {
      const members = [
        voiceMember('a', { displayName: 'Alice' }),
        voiceMember('b', { displayName: 'Bob' }),
        voiceMember('bot', { bot: true, displayName: 'Robo' }),
        voiceMember('c', { displayName: 'Carol' }),
        voiceMember('d', { displayName: 'Dave' }),
      ];
      const { interaction, reply, deferReply, editReply } = commandInteraction({
        subcommand: 'team',
        values: { count: 2 },
        voice: voiceChannel(members, { name: 'Arena' }),
      });

      await run(interaction);

      expect(reply).not.toHaveBeenCalled();
      expect(deferReply).toHaveBeenCalledTimes(1);
      expect(editReply).toHaveBeenCalledTimes(5);
      expect([0, 1, 2].map((i) => embedAt(editReply, i).description)).toEqual(
        [3, 2, 1].map(
          (count) => `**${t('roulette.member.countdown', 'en', { count })}**`
        )
      );
      for (const i of [0, 1, 2, 3]) {
        expect(embedAt(editReply, i)).toMatchObject({
          title: t('roulette.team.title', 'en'),
          color: COLORS.WARNING,
        });
        // Animation frames carry no timestamp; only the final result does.
        expect(embedAt(editReply, i).timestamp).toBeUndefined();
      }
      expect(embedAt(editReply, 3).description).toBe(
        t('roulette.team.shuffling', 'en', {
          count: 4,
          teams: 2,
          candidates: 'Alice, Bob, Carol, Dave',
        })
      );
      expect(lastEmbed(editReply)).toMatchObject({
        title: t('roulette.team.result', 'en'),
        description: t('roulette.team.resultDesc', 'en', {
          count: 4,
          teams: 2,
        }),
        color: COLORS.SUCCESS,
        footer: { text: t('roulette.team.footer', 'en', { channel: 'Arena' }) },
      });
      expect(lastEmbed(editReply).timestamp).toBeDefined();
      expect(logger.info).toHaveBeenCalledWith(
        mentioning(/\b4\b/, /\b2\b/, 'user-1#0001')
      );
    });

    it('announces the teams in the resolved locale', async () => {
      resolveLocale.mockReturnValue('ja');
      const { interaction, editReply } = commandInteraction({
        subcommand: 'team',
        values: { count: 2 },
        voice: voiceChannel(humans(3), { name: 'Arena' }),
      });

      await run(interaction);

      expect(embedAt(editReply, 0).title).toBe(t('roulette.team.title', 'ja'));
      expect(embedAt(editReply, 3).description).toBe(
        t('roulette.team.shuffling', 'ja', {
          count: 3,
          teams: 2,
          candidates: 'Name-u1, Name-u2, Name-u3',
        })
      );
      expect(lastEmbed(editReply)).toMatchObject({
        title: t('roulette.team.result', 'ja'),
        description: t('roulette.team.resultDesc', 'ja', {
          count: 3,
          teams: 2,
        }),
        footer: { text: t('roulette.team.footer', 'ja', { channel: 'Arena' }) },
      });
      expect(lastEmbed(editReply).fields?.map((f) => f.name)).toEqual([
        t('roulette.team.teamName', 'ja', { number: 1, count: 2 }),
        t('roulette.team.teamName', 'ja', { number: 2, count: 1 }),
      ]);
    });

    it('holds the teams back until the animation has played', async () => {
      const { interaction, editReply } = commandInteraction({
        subcommand: 'team',
        values: { count: 2 },
        voice: voiceChannel(humans(2)),
      });

      const pending = executeRouletteCommand(interaction);
      await vi.advanceTimersByTimeAsync(ANIMATION_MS - 1);
      expect(editReply).toHaveBeenCalledTimes(4);

      await vi.advanceTimersByTimeAsync(1);
      await pending;
      expect(lastEmbed(editReply).title).toBe(t('roulette.team.result', 'en'));
    });
  });
});

describe('/community command', () => {
  type OptionJSON = {
    name: string;
    type: number;
    required?: boolean;
    max_length?: number;
    choices?: Array<{ name: string; value: number }>;
    options?: OptionJSON[];
  };

  const json = command.data.toJSON() as unknown as {
    name: string;
    options: OptionJSON[];
  };

  function find(options: OptionJSON[] | undefined, name: string): OptionJSON {
    const option = options?.find((o) => o.name === name);
    if (!option) throw new Error(`option ${name} not defined`);
    return option;
  }

  const create = find(find(json.options, 'poll').options, 'create');

  it('groups poll and roulette subcommands under /community', () => {
    expect(json.name).toBe('community');
    expect(
      json.options.map((group) => ({
        group: group.name,
        subcommands: group.options?.map((s) => s.name),
      }))
    ).toEqual([
      { group: 'poll', subcommands: ['create', 'end'] },
      { group: 'roulette', subcommands: ['member', 'team'] },
    ]);
  });

  it('requires a question and two options, and offers up to ten', () => {
    const optionSlots = Array.from({ length: 10 }, (_, i) =>
      find(create.options, `option${i + 1}`)
    );

    expect(find(create.options, 'question')).toMatchObject({
      required: true,
      max_length: 300,
    });
    expect(optionSlots.map((o) => o.required ?? false)).toEqual([
      true,
      true,
      ...Array(8).fill(false),
    ]);
    // The builder must not allow anything collectAnswers would then reject.
    expect(optionSlots.every((o) => o.max_length === MAX_ANSWER_LENGTH)).toBe(
      true
    );
    expect(create.options?.some((o) => o.name === 'option11')).toBe(false);
  });

  it('offers fixed poll durations from one hour to seven days', () => {
    const duration = find(create.options, 'duration');

    expect(duration.required ?? false).toBe(false);
    expect(duration.choices?.map((c) => c.value)).toEqual([
      1, 4, 8, 24, 72, 168,
    ]);
    expect(find(create.options, 'multi').required ?? false).toBe(false);
  });

  it('limits team roulette to two through six teams', () => {
    const team = find(find(json.options, 'roulette').options, 'team');
    const count = find(team.options, 'count');

    expect(count.required).toBe(true);
    expect(count.choices?.map((c) => c.value)).toEqual([2, 3, 4, 5, 6]);
  });

  it('applies a cooldown long enough to cover the animation', () => {
    expect(command.middleware).toEqual(['cooldown']);
    expect(command.options?.cooldown).toBeGreaterThanOrEqual(ANIMATION_MS);
  });

  it('routes the roulette group to the roulette handler', async () => {
    const { interaction, reply } = commandInteraction({
      group: 'roulette',
      subcommand: 'member',
      voice: null,
    });

    await command.execute(interaction);

    expect(interaction.options.getSubcommandGroup).toHaveBeenCalledWith(true);
    expect(embedAt(reply).title).toBe(t('roulette.errors.notInVoice', 'en'));
  });

  it('routes the poll group to the poll handler', async () => {
    const { interaction, reply } = commandInteraction({
      group: 'poll',
      subcommand: 'create',
      values: { question: 'x'.repeat(301), option1: 'A', option2: 'B' },
    });

    await command.execute(interaction);

    expect(embedAt(reply).description).toBe(
      t('poll.errors.questionTooLong', 'en')
    );
  });
});
