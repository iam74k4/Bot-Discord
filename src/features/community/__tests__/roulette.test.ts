import Database from 'better-sqlite3';
import {
  ButtonStyle,
  ChannelType,
  ComponentType,
  InteractionContextType,
  MessageFlags,
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
  voiceChannel,
  voiceMember,
  type VoiceMemberStub,
} from './community.helpers.js';

/**
 * Roulette reads the invoker's voice channel, drops bots, and animates a
 * countdown before revealing a pick or a team split; the result then keeps
 * re-draw buttons for whoever is in the channel. Timers are faked so the
 * ~3.6s animation runs instantly, Math.random is pinned wherever the outcome
 * matters, and the cooldown store is the real one.
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

const {
  executeRouletteCommand,
  listWithin,
  REROLL_IDLE_MS,
  REROLL_MIN_INTERVAL_MS,
} = await import('../application/roulette.js');
const { command } = await import('../commands/roulette.js');
const { MAX_ANSWER_LENGTH, POLL_DURATION_HOURS } =
  await import('../poll/application.js');
const { cooldownMiddleware, clearCooldown, resolveCooldownMs } =
  await import('../../../middleware/cooldown/index.js');
const { PANEL_MAX_LIFETIME } = await import('../../../shared/utils/panel.js');
const { clearLiveComponents, isLiveComponentMessage, stopLiveComponents } =
  await import('../../../shared/interactions/index.js');
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

/** Member ids per team, read back from a result embed's display names. */
function teamsOf(embed: { fields?: Array<{ value: string }> }): string[][] {
  return (embed.fields ?? []).map((field) =>
    field.value.split('\n').map((name) => name.replace(/^Name-/, ''))
  );
}

function teamsFrom(editReply: ReturnType<typeof vi.fn>): string[][] {
  return teamsOf(lastEmbed(editReply));
}

/** The countdown description for `count`. */
function countdown(count: number, locale: 'en' | 'ja' = 'en'): string {
  return `**${t('roulette.member.countdown', locale, { count })}**`;
}

function winnerText(id: string, name = `Name-${id}`): string {
  return t('roulette.member.winner', 'en', { name, mention: `<@${id}>` });
}

/** Whether the user is still on cooldown for the interaction's path. */
async function onCooldown(
  interaction: Parameters<typeof cooldownMiddleware>[0]
): Promise<boolean> {
  const result = await cooldownMiddleware(interaction, command);
  return !result.success;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  resolveLocale.mockReturnValue('en');
  clearCooldown('community', 'user-1');
  clearLiveComponents();
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
      const { interaction, reply, editReply } = commandInteraction({
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
      expect(editReply).not.toHaveBeenCalled();
    });

    it('refuses, rather than crashing, for a raw member of an uncached guild', async () => {
      // discord.js only wraps the member as a GuildMember (with .voice) when
      // the guild is cached; otherwise it is the bare API payload.
      const { interaction, reply, editReply } = commandInteraction({
        subcommand,
        values,
        hasGuild: false,
        rawMember: { user: { id: 'user-1' }, roles: [], permissions: '0' },
      });

      await expect(run(interaction)).resolves.toBeUndefined();

      expect(flagsAt(reply)).toBe(MessageFlags.Ephemeral);
      expect(embedAt(reply).description).toBe(t('common.guildOnly', 'en'));
      expect(editReply).not.toHaveBeenCalled();
    });

    it('accepts a stage channel as a voice channel', async () => {
      const { interaction, reply, editReply } = commandInteraction({
        subcommand,
        values,
        voice: voiceChannel(humans(3), { type: ChannelType.GuildStageVoice }),
      });

      await run(interaction);

      expect(reply).toHaveBeenCalledTimes(1);
      expect(flagsAt(reply)).toBeUndefined();
      expect(lastEmbed(editReply).color).toBe(COLORS.SUCCESS);
    });

    it('tells a member who is not in voice to join one', async () => {
      const { interaction, reply, editReply } = commandInteraction({
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
      expect(editReply).not.toHaveBeenCalled();
    });

    it('does not treat a non-voice channel as a voice channel', async () => {
      const { interaction, reply, editReply } = commandInteraction({
        subcommand,
        values,
        voice: voiceChannel(humans(3), { type: ChannelType.GuildText }),
      });

      await run(interaction);

      expect(embedAt(reply).title).toBe(t('roulette.errors.notInVoice', 'en'));
      expect(editReply).not.toHaveBeenCalled();
    });

    it('gives the cooldown back, so joining a VC and retrying works at once', async () => {
      const { interaction } = commandInteraction({
        group: 'roulette',
        subcommand,
        values,
        voice: null,
      });
      expect(await onCooldown(interaction)).toBe(false);

      await executeRouletteCommand(interaction);

      expect(await onCooldown(interaction)).toBe(false);
    });

    it('keeps the cooldown once the animation has started', async () => {
      const { interaction } = commandInteraction({
        group: 'roulette',
        subcommand,
        values,
        voice: voiceChannel(humans(3)),
      });
      expect(await onCooldown(interaction)).toBe(false);

      const pending = executeRouletteCommand(interaction);
      await vi.advanceTimersByTimeAsync(ANIMATION_MS);
      await pending;

      expect(await onCooldown(interaction)).toBe(true);
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
    it('reports no members, and gives the cooldown back, when only bots share the channel', async () => {
      const { interaction, reply, editReply } = commandInteraction({
        group: 'roulette',
        subcommand: 'member',
        voice: voiceChannel([
          voiceMember('bot-1', { bot: true }),
          voiceMember('bot-2', { bot: true }),
        ]),
      });
      expect(await onCooldown(interaction)).toBe(false);

      await run(interaction);

      expect(flagsAt(reply)).toBe(MessageFlags.Ephemeral);
      expect(embedAt(reply)).toMatchObject({
        title: t('roulette.errors.noMembers', 'en'),
        description: t('roulette.errors.noMembersDesc', 'en'),
      });
      expect(editReply).not.toHaveBeenCalled();
      expect(await onCooldown(interaction)).toBe(false);
    });

    it('picks the lone human straight away, by name, skipping the animation', async () => {
      const { interaction, reply, deferReply, editReply } = commandInteraction({
        subcommand: 'member',
        voice: voiceChannel([
          voiceMember('bot-1', { bot: true }),
          voiceMember('solo', { displayName: 'Solo' }),
        ]),
      });

      await run(interaction);

      expect(reply).toHaveBeenCalledTimes(1);
      expect(flagsAt(reply)).toBeUndefined();
      expect(embedAt(reply)).toMatchObject({
        title: t('roulette.member.result', 'en'),
        description: t('roulette.member.onlyOne', 'en', {
          name: 'Solo',
          mention: '<@solo>',
        }),
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
        description: t('roulette.member.onlyOne', 'ja', {
          name: 'Name-solo',
          mention: '<@solo>',
        }),
      });
    });

    it('counts down, lists the humans, then reveals the pick by name', async () => {
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

      // The first frame is the reply itself: no "thinking..." round trip.
      expect(deferReply).not.toHaveBeenCalled();
      expect(reply).toHaveBeenCalledTimes(1);
      expect(flagsAt(reply)).toBeUndefined();
      expect(editReply).toHaveBeenCalledTimes(4);

      const frames = [
        embedAt(reply),
        embedAt(editReply, 0),
        embedAt(editReply, 1),
      ];
      expect(frames.map((e) => e.description)).toEqual(
        [3, 2, 1].map((count) => countdown(count))
      );
      for (const frame of frames) {
        expect(frame.title).toBe(t('roulette.member.title', 'en'));
        expect(frame.color).toBe(COLORS.WARNING);
        expect(frame.timestamp).toBeUndefined();
      }

      expect(embedAt(editReply, 2).description).toBe(
        t('roulette.member.selecting', 'en', {
          candidates: 'Alice, Bob, Carol',
        })
      );

      expect(lastEmbed(editReply)).toMatchObject({
        title: t('roulette.member.result', 'en'),
        description: winnerText('a', 'Alice'),
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

    it('escapes markdown in display names', async () => {
      vi.spyOn(Math, 'random').mockReturnValue(0);
      const { interaction, editReply } = commandInteraction({
        subcommand: 'member',
        voice: voiceChannel([
          voiceMember('a', { displayName: '*star*' }),
          voiceMember('b', { displayName: 'Bob' }),
        ]),
      });

      await run(interaction);

      expect(embedAt(editReply, 2).description).toContain('\\*star\\*, Bob');
      expect(lastEmbed(editReply).description).toBe(
        winnerText('a', '\\*star\\*')
      );
    });

    it('plays the animation and reveals the pick in the resolved locale', async () => {
      resolveLocale.mockReturnValue('ja');
      vi.spyOn(Math, 'random').mockReturnValue(0.999);
      const { interaction, reply, editReply } = commandInteraction({
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

      expect(
        [embedAt(reply), ...[0, 1, 2].map((i) => embedAt(editReply, i))].map(
          (e) => e.title
        )
      ).toEqual(Array(4).fill(t('roulette.member.title', 'ja')));
      expect(embedAt(reply).description).toBe(countdown(3, 'ja'));
      expect(embedAt(editReply, 2).description).toBe(
        t('roulette.member.selecting', 'ja', { candidates: 'Alice, Bob' })
      );
      expect(lastEmbed(editReply)).toMatchObject({
        title: t('roulette.member.result', 'ja'),
        description: t('roulette.member.winner', 'ja', {
          name: 'Bob',
          mention: '<@b>',
        }),
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

        expect(lastEmbed(editReply).description).toBe(winnerText(winner));
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

      expect(lastEmbed(editReply).description).toBe(winnerText('b'));
    });

    it('holds the result back until the animation has played', async () => {
      const { interaction, reply, editReply } = commandInteraction({
        subcommand: 'member',
        voice: voiceChannel(humans(2)),
      });

      const pending = executeRouletteCommand(interaction);
      await vi.advanceTimersByTimeAsync(0);
      expect(reply).toHaveBeenCalledTimes(1);
      expect(editReply).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(ANIMATION_MS - 1);
      expect(editReply).toHaveBeenCalledTimes(3);

      await vi.advanceTimersByTimeAsync(1);
      await pending;
      expect(editReply).toHaveBeenCalledTimes(4);
      expect(lastEmbed(editReply).title).toBe(
        t('roulette.member.result', 'en')
      );
    });

    it('lets a Discord API failure reach the command handler', async () => {
      const { interaction, reply, editReply } = commandInteraction({
        subcommand: 'member',
        voice: voiceChannel(humans(2)),
      });
      reply.mockRejectedValue(new Error('Unknown interaction'));

      await expect(executeRouletteCommand(interaction)).rejects.toThrow(
        'Unknown interaction'
      );
      expect(editReply).not.toHaveBeenCalled();
    });

    it('lets a failed frame stop the animation and reach the command handler', async () => {
      const { interaction, editReply } = commandInteraction({
        subcommand: 'member',
        voice: voiceChannel(humans(2)),
      });
      editReply.mockRejectedValueOnce(new Error('Unknown Webhook'));

      const pending = executeRouletteCommand(interaction);
      const outcome = expect(pending).rejects.toThrow('Unknown Webhook');
      await vi.runAllTimersAsync();
      await outcome;
      expect(editReply).toHaveBeenCalledTimes(1);
    });
  });

  describe('/roulette team', () => {
    it('refuses when there are fewer humans than teams, and gives the cooldown back', async () => {
      const { interaction, reply, editReply } = commandInteraction({
        group: 'roulette',
        subcommand: 'team',
        values: { count: 3 },
        voice: voiceChannel([
          voiceMember('a'),
          voiceMember('b'),
          voiceMember('bot', { bot: true }),
        ]),
      });
      expect(await onCooldown(interaction)).toBe(false);

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
      expect(editReply).not.toHaveBeenCalled();
      expect(await onCooldown(interaction)).toBe(false);
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

    it('lists teams by escaped display name', async () => {
      vi.spyOn(Math, 'random').mockReturnValue(0.999);
      const { interaction, editReply } = commandInteraction({
        subcommand: 'team',
        values: { count: 2 },
        voice: voiceChannel([
          voiceMember('a', { displayName: '_Ann_' }),
          voiceMember('b', { displayName: 'Bob' }),
        ]),
      });

      await run(interaction);

      expect(lastEmbed(editReply).fields?.map((f) => f.value)).toEqual([
        '\\_Ann\\_',
        'Bob',
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

      expect(deferReply).not.toHaveBeenCalled();
      expect(reply).toHaveBeenCalledTimes(1);
      expect(editReply).toHaveBeenCalledTimes(4);
      const frames = [
        embedAt(reply),
        ...[0, 1, 2].map((i) => embedAt(editReply, i)),
      ];
      expect(frames.slice(0, 3).map((e) => e.description)).toEqual(
        [3, 2, 1].map((count) => countdown(count))
      );
      for (const frame of frames) {
        expect(frame).toMatchObject({
          title: t('roulette.team.title', 'en'),
          color: COLORS.WARNING,
        });
        // Animation frames carry no timestamp; only the final result does.
        expect(frame.timestamp).toBeUndefined();
      }
      expect(frames[3].description).toBe(
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
      const { interaction, reply, editReply } = commandInteraction({
        subcommand: 'team',
        values: { count: 2 },
        voice: voiceChannel(humans(3), { name: 'Arena' }),
      });

      await run(interaction);

      expect(embedAt(reply).title).toBe(t('roulette.team.title', 'ja'));
      expect(embedAt(editReply, 2).description).toBe(
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
      expect(editReply).toHaveBeenCalledTimes(3);

      await vi.advanceTimersByTimeAsync(1);
      await pending;
      expect(lastEmbed(editReply).title).toBe(t('roulette.team.result', 'en'));
    });
  });

  describe('animation timing', () => {
    /** editReply that takes `latency(call)` ms, recording when each ran. */
    function slowEdits(latency: (call: number) => number) {
      const started: number[] = [];
      let inFlight = 0;
      let maxInFlight = 0;
      const editReply = vi.fn(
        () =>
          new Promise((resolve) => {
            started.push(Date.now());
            inFlight++;
            maxInFlight = Math.max(maxInFlight, inFlight);
            setTimeout(
              () => {
                inFlight--;
                resolve({});
              },
              latency(started.length - 1)
            );
          })
      );
      return { editReply, started, maxInFlight: () => maxInFlight };
    }

    it.each(['member', 'team'])(
      '%s: shows the result on the animation clock, not after it plus every round trip',
      async (subcommand) => {
        const edits = slowEdits(() => 150);
        const { interaction } = commandInteraction({
          subcommand,
          values: { count: 2 },
          voice: voiceChannel(humans(3)),
          editReply: edits.editReply,
        });
        const t0 = Date.now();

        const pending = executeRouletteCommand(interaction);
        await vi.runAllTimersAsync();
        await pending;

        expect(edits.started.map((at) => at - t0)).toEqual([
          800,
          1600,
          2400,
          ANIMATION_MS,
        ]);
      }
    );

    it('starts the next frame right after a slow edit, never two at once', async () => {
      const edits = slowEdits((call) => (call === 0 ? 900 : 100));
      const { interaction } = commandInteraction({
        subcommand: 'member',
        voice: voiceChannel(humans(3)),
        editReply: edits.editReply,
      });
      const t0 = Date.now();

      const pending = executeRouletteCommand(interaction);
      await vi.runAllTimersAsync();
      await pending;

      // The first edit (800 ms) took 900 ms, so the second, due at 1600,
      // goes out the moment it returns at 1700; later frames keep the clock.
      expect(edits.started.map((at) => at - t0)).toEqual([
        800,
        1700,
        2400,
        ANIMATION_MS,
      ]);
      expect(edits.maxInFlight()).toBe(1);
    });
  });
});

describe('long name lists', () => {
  const more = (count: number) => t('roulette.andMore', 'en', { count });

  it('joins names unchanged when they fit, exactly at the limit too', () => {
    expect(listWithin(['Ann', 'Bo'], ', ', 7, 'en')).toBe('Ann, Bo');
  });

  it('cuts at a whole name and says how many are left out', () => {
    const names = ['Ann', 'Bo', 'Cy', 'Di'];
    const max = 'Ann, Bo, Cy, Di'.length - 1;

    const list = listWithin(names, ', ', max, 'en');

    expect(list.length).toBeLessThanOrEqual(max);
    const shown = list.split(', ');
    expect(shown.at(-1)).toBe(more(names.length - (shown.length - 1)));
    expect(shown.slice(0, -1)).toEqual(names.slice(0, shown.length - 1));
  });

  it('shows only the count when not even one name fits', () => {
    expect(listWithin(['Annabelle', 'Bo'], ', ', 12, 'en')).toBe(more(2));
  });

  it('says it in Japanese for Japanese servers', () => {
    expect(listWithin(['あ'.repeat(20), 'い'], '\n', 10, 'ja')).toBe(
      t('roulette.andMore', 'ja', { count: 2 })
    );
  });

  /** Members with long names that need escaping, as in a big Stage. */
  function crowd(count: number): VoiceMemberStub[] {
    return Array.from({ length: count }, (_, i) =>
      voiceMember(`u${i}`, { displayName: `${'x'.repeat(28)}_${i}` })
    );
  }

  /** Every name shown in full, and the shown plus the rest add up. */
  function expectWholeNames(lines: string[], total: number) {
    const rest = /^…and (\d+) more$/.exec(lines.at(-1) ?? '');
    expect(rest).not.toBeNull();
    for (const line of lines.slice(0, -1)) {
      expect(line).toMatch(/^x{28}\\_\d+$/);
    }
    expect(lines.length - 1 + Number(rest![1])).toBe(total);
  }

  it('keeps the candidate list within an embed description', async () => {
    const { interaction, editReply } = commandInteraction({
      subcommand: 'member',
      voice: voiceChannel(crowd(300)),
    });

    await run(interaction);

    const description = embedAt(editReply, 2).description ?? '';
    expect(description.length).toBeLessThanOrEqual(4096);
    const list = /\[(.*)\]$/s.exec(description)?.[1] ?? '';
    expectWholeNames(list.split(', '), 300);
  });

  it('keeps six long team lists within what Discord accepts in one embed', async () => {
    const { interaction, editReply } = commandInteraction({
      subcommand: 'team',
      values: { count: 6 },
      voice: voiceChannel(crowd(300)),
    });

    await run(interaction);

    const result = lastEmbed(editReply);
    const fields = result.fields ?? [];
    expect(fields).toHaveLength(6);
    const total =
      (result.title?.length ?? 0) +
      (result.description?.length ?? 0) +
      (result.footer?.text.length ?? 0) +
      fields.reduce((sum, f) => sum + f.name.length + f.value.length, 0);
    expect(total).toBeLessThanOrEqual(6000);
    for (const field of fields) {
      expect(field.value.length).toBeLessThanOrEqual(1024);
      expectWholeNames(field.value.split('\n'), 50);
    }
  });

  it('lists two teams in full up to the field limit', async () => {
    const { interaction, editReply } = commandInteraction({
      subcommand: 'team',
      values: { count: 2 },
      voice: voiceChannel(crowd(60)),
    });

    await run(interaction);

    // 30 names of 31-32 characters, a line each, fit in 1024.
    for (const field of lastEmbed(editReply).fields ?? []) {
      expect(field.value.split('\n')).toHaveLength(30);
      expect(field.value).not.toContain('…');
    }
  });
});

describe('roulette re-draw buttons', () => {
  /** A component collector driven by the test, like the discord.js one. */
  function fakeCollector() {
    const handlers: Record<string, (...args: unknown[]) => unknown> = {};
    const collector = {
      on: vi.fn((event: string, handler: (...args: unknown[]) => unknown) => {
        handlers[event] = handler;
        return collector;
      }),
      stop: vi.fn((reason = 'user') => handlers.end?.(new Map(), reason)),
      collect: (press: unknown) => handlers.collect(press),
      end: (reason: string) => handlers.end(new Map(), reason),
    };
    return collector;
  }

  function press(customId: string, userId = 'u1') {
    return {
      customId,
      user: { id: userId, tag: `${userId}#0001` },
      replied: false,
      deferred: false,
      update: vi.fn().mockResolvedValue(undefined),
      reply: vi.fn().mockResolvedValue(undefined),
      followUp: vi.fn().mockResolvedValue(undefined),
      deferUpdate: vi.fn().mockResolvedValue(undefined),
    };
  }

  /** A result message whose collector the test drives. */
  function resultMessage() {
    const collector = fakeCollector();
    const message = {
      id: 'result-1',
      createMessageComponentCollector: vi.fn(() => collector),
    };
    return { collector, message };
  }

  /** Run a roulette to its result, with buttons the test can press. */
  async function rolled(
    subcommand: 'member' | 'team',
    members: VoiceMemberStub[],
    values: Record<string, number> = {}
  ) {
    const { collector, message } = resultMessage();
    const channel = voiceChannel(members, { id: 'voice-1', name: 'Lounge' });
    const stub = commandInteraction({
      subcommand,
      values,
      voice: channel,
      editReply: vi.fn().mockResolvedValue(message),
    });
    await run(stub.interaction);
    return { ...stub, collector, message, channel };
  }

  /**
   * Run a member roulette up to the moment its result has been sent but
   * Discord has not answered yet - when clients may already show it.
   */
  async function resultInFlight() {
    const { collector, message } = resultMessage();
    let land!: () => void;
    let fail!: (error: unknown) => void;
    const result = new Promise((resolve, reject) => {
      land = () => resolve(message);
      fail = reject;
    });
    const editReply = vi
      .fn()
      .mockResolvedValueOnce(message)
      .mockResolvedValueOnce(message)
      .mockResolvedValueOnce(message)
      .mockReturnValueOnce(result)
      .mockResolvedValue(message);
    const stub = commandInteraction({
      subcommand: 'member',
      voice: voiceChannel(humans(3), { id: 'voice-1', name: 'Lounge' }),
      editReply,
    });
    const pending = executeRouletteCommand(stub.interaction);
    // Kept from being reported as unhandled before a test awaits it.
    pending.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(ANIMATION_MS);
    expect(editReply).toHaveBeenCalledTimes(4);
    return { ...stub, collector, message, pending, land, fail };
  }

  type Row = { toJSON(): { components: Array<Record<string, unknown>> } };

  function buttonsOf(payload: unknown) {
    const rows = (payload as { components?: Row[] }).components ?? [];
    return rows.flatMap((row) => row.toJSON().components);
  }

  function embedOf(payload: unknown) {
    return (
      payload as { embeds: Array<{ toJSON(): Record<string, unknown> }> }
    ).embeds[0].toJSON() as { description?: string; footer?: { text: string } };
  }

  it('offers "spin again" and "without the winner" under a member result', async () => {
    const { editReply } = await rolled('member', humans(3));

    expect(buttonsOf(editReply.mock.calls.at(-1)![0])).toEqual([
      expect.objectContaining({
        custom_id: 'roulette:again',
        label: t('roulette.buttons.again', 'en'),
        style: ButtonStyle.Secondary,
        disabled: false,
      }),
      expect.objectContaining({
        custom_id: 'roulette:exclude',
        label: t('roulette.buttons.excludeWinner', 'en'),
        disabled: false,
      }),
    ]);
  });

  it('offers "reshuffle" under a team result', async () => {
    const { editReply } = await rolled('team', humans(4), { count: 2 });

    expect(buttonsOf(editReply.mock.calls.at(-1)![0])).toEqual([
      expect.objectContaining({
        custom_id: 'roulette:reshuffle',
        label: t('roulette.buttons.reshuffle', 'en'),
      }),
    ]);
  });

  it('collects presses for a while after each, closing before the token expires', async () => {
    const { message } = await rolled('member', humans(3));

    // Started as the result goes out, it ends PANEL_MAX_LIFETIME after the
    // command - the token's clock - not after the animation.
    expect(message.createMessageComponentCollector).toHaveBeenCalledWith({
      componentType: ComponentType.Button,
      idle: REROLL_IDLE_MS,
      time: PANEL_MAX_LIFETIME - ANIMATION_MS,
    });
    expect(PANEL_MAX_LIFETIME).toBeLessThan(15 * 60_000);
  });

  it("counts the buttons' lifetime from the command, however slow the frames were", async () => {
    const { message } = resultMessage();
    // Rate-limited edits: each frame takes a minute to land.
    const editReply = vi.fn(
      () => new Promise((resolve) => setTimeout(() => resolve(message), 60_000))
    );
    const { interaction } = commandInteraction({
      subcommand: 'member',
      voice: voiceChannel(humans(3)),
      editReply,
    });
    const ranAt = interaction.createdTimestamp;

    await run(interaction);

    const [{ time }] = message.createMessageComponentCollector.mock
      .calls[0] as unknown as [{ time: number }];
    const startedAt = Date.now() - 60_000; // the result's own edit took a minute
    expect(startedAt - ranAt).toBeGreaterThan(3 * 60_000);
    expect(startedAt + time).toBe(ranAt + PANEL_MAX_LIFETIME);
  });

  it('listens for presses before the result with its buttons can be seen', async () => {
    const roll = await resultInFlight();

    expect(buttonsOf(roll.editReply.mock.calls[3][0])).not.toEqual([]);
    expect(roll.message.createMessageComponentCollector).toHaveBeenCalledTimes(
      1
    );
    expect(isLiveComponentMessage('result-1')).toBe(true);
    const early = press('roulette:again');
    await roll.collector.collect(early);
    expect(early.update).toHaveBeenCalledTimes(1);

    roll.land();
    await roll.pending;
  });

  it('removes the buttons only after a result still on its way has landed', async () => {
    const roll = await resultInFlight();

    const stopping = stopLiveComponents({ timeoutMs: 60_000 });
    await vi.advanceTimersByTimeAsync(0);
    expect(roll.collector.stop).toHaveBeenCalledWith('shutdown');
    // Removing them now would let the result bring them back.
    expect(roll.editReply).toHaveBeenCalledTimes(4);

    roll.land();
    await roll.pending;
    await stopping;
    expect(roll.editReply).toHaveBeenCalledTimes(5);
    expect(roll.editReply).toHaveBeenLastCalledWith({ components: [] });
  });

  it('stops listening, with nothing to remove, when the result cannot be shown', async () => {
    const roll = await resultInFlight();

    roll.fail(new Error('Invalid Form Body'));
    await expect(roll.pending).rejects.toThrow('Invalid Form Body');
    await vi.advanceTimersByTimeAsync(0);

    expect(roll.collector.stop).toHaveBeenCalledTimes(1);
    expect(isLiveComponentMessage('result-1')).toBe(false);
    expect(roll.editReply).toHaveBeenCalledTimes(4);
  });

  it('re-draws from whoever is in the VC now, without the animation', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.999);
    const { collector, channel, editReply } = await rolled('member', humans(2));
    const newcomer = voiceMember('u3', { displayName: 'Newcomer' });
    channel.members.set(newcomer.id, newcomer);
    const editsBefore = editReply.mock.calls.length;
    const again = press('roulette:again');

    await collector.collect(again);

    expect(again.update).toHaveBeenCalledTimes(1);
    expect(embedOf(again.update.mock.calls[0][0]).description).toBe(
      winnerText('u3', 'Newcomer')
    );
    expect(editReply).toHaveBeenCalledTimes(editsBefore);
  });

  it('turns away someone who is not in the VC', async () => {
    const { collector } = await rolled('member', humans(2));
    const outsider = press('roulette:again', 'outsider');

    await collector.collect(outsider);

    expect(outsider.update).not.toHaveBeenCalled();
    expect(outsider.reply).toHaveBeenCalledWith({
      content: t('roulette.errors.onlyParticipants', 'en', {
        channel: 'voice-1',
      }),
      flags: MessageFlags.Ephemeral,
    });
  });

  it('leaves winners out one after another, then says nobody is left', async () => {
    // 0 always picks the first remaining candidate.
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const { collector } = await rolled('member', humans(3));

    const first = press('roulette:exclude');
    await collector.collect(first);
    const firstResult = first.update.mock.calls[0][0];
    expect(embedOf(firstResult).description).toBe(winnerText('u2'));
    expect(embedOf(firstResult).footer?.text).toBe(
      t('roulette.member.footerExcluded', 'en', {
        count: 2,
        channel: 'Lounge',
        excluded: 1,
      })
    );

    vi.advanceTimersByTime(REROLL_MIN_INTERVAL_MS);
    const second = press('roulette:exclude');
    await collector.collect(second);
    const secondResult = second.update.mock.calls[0][0];
    expect(embedOf(secondResult).description).toBe(winnerText('u3'));
    // Only u3 is left, so leaving the winner out again has no one to draw.
    expect(buttonsOf(secondResult)[1]).toMatchObject({ disabled: true });

    vi.advanceTimersByTime(REROLL_MIN_INTERVAL_MS);
    const third = press('roulette:exclude');
    await collector.collect(third);
    expect(third.update).not.toHaveBeenCalled();
    expect(third.reply).toHaveBeenCalledWith({
      content: t('roulette.errors.noCandidatesLeft', 'en'),
      flags: MessageFlags.Ephemeral,
    });

    // "Spin again" still draws among those not left out.
    vi.advanceTimersByTime(REROLL_MIN_INTERVAL_MS);
    const again = press('roulette:again');
    await collector.collect(again);
    expect(embedOf(again.update.mock.calls[0][0]).description).toBe(
      winnerText('u3')
    );
  });

  it('acknowledges and ignores presses that come too quickly', async () => {
    const { collector } = await rolled('member', humans(3));
    const first = press('roulette:again');
    const quick = press('roulette:again', 'u2');

    await collector.collect(first);
    vi.advanceTimersByTime(REROLL_MIN_INTERVAL_MS - 1);
    await collector.collect(quick);

    expect(first.update).toHaveBeenCalledTimes(1);
    expect(quick.update).not.toHaveBeenCalled();
    expect(quick.deferUpdate).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1);
    const later = press('roulette:again', 'u2');
    await collector.collect(later);
    expect(later.update).toHaveBeenCalledTimes(1);
  });

  it('reshuffles the teams from the members there now', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.999);
    const { collector, channel } = await rolled('team', humans(4), {
      count: 2,
    });
    channel.members.delete('u4');
    const reshuffle = press('roulette:reshuffle');

    await collector.collect(reshuffle);

    const result = reshuffle.update.mock.calls[0][0] as {
      embeds: Array<{ toJSON(): { fields?: Array<{ value: string }> } }>;
    };
    expect(teamsOf(result.embeds[0].toJSON())).toEqual([['u1', 'u3'], ['u2']]);
  });

  it('will not reshuffle into more teams than there are members', async () => {
    const { collector, channel } = await rolled('team', humans(3), {
      count: 3,
    });
    channel.members.delete('u3');
    const reshuffle = press('roulette:reshuffle');

    await collector.collect(reshuffle);

    expect(reshuffle.update).not.toHaveBeenCalled();
    expect(reshuffle.reply).toHaveBeenCalledWith({
      content: t('roulette.errors.notEnoughDesc', 'en', {
        teams: 3,
        required: 3,
        current: 2,
      }),
      flags: MessageFlags.Ephemeral,
    });
  });

  it('reports a re-draw that could not be shown, with an id that is in the log', async () => {
    const { collector } = await rolled('member', humans(3));
    const failing = press('roulette:again');
    failing.update.mockRejectedValue(new Error('Unknown interaction'));

    await collector.collect(failing);

    const [logged] = vi.mocked(logger.warn).mock.calls[0];
    const id = /\[([0-9a-f]{6})\]/.exec(String(logged))?.[1];
    expect(id).toBeDefined();
    expect(failing.reply).toHaveBeenCalledWith({
      content: t('common.actionFailed', 'en', { id: id! }),
      flags: MessageFlags.Ephemeral,
    });
  });

  it('removes the buttons, keeping the result, once nobody presses them', async () => {
    const { collector, editReply } = await rolled('member', humans(3));
    expect(isLiveComponentMessage('result-1')).toBe(true);

    await collector.end('idle');

    expect(editReply).toHaveBeenLastCalledWith({ components: [] });
    expect(isLiveComponentMessage('result-1')).toBe(false);
  });

  it('leaves a deleted result alone', async () => {
    const { collector, editReply } = await rolled('member', humans(3));
    const edits = editReply.mock.calls.length;

    await collector.end('messageDelete');

    expect(editReply).toHaveBeenCalledTimes(edits);
  });

  it('closes the buttons when the bot shuts down', async () => {
    const { collector, editReply } = await rolled('member', humans(3));

    await stopLiveComponents({ timeoutMs: 1_000 });

    expect(collector.stop).toHaveBeenCalledWith('shutdown');
    expect(editReply).toHaveBeenLastCalledWith({ components: [] });
  });

  it('adds no buttons when the lone human is picked', async () => {
    const { interaction, reply } = commandInteraction({
      subcommand: 'member',
      voice: voiceChannel([voiceMember('solo')]),
    });

    await run(interaction);

    expect(buttonsOf(reply.mock.calls[0][0])).toEqual([]);
  });
});

describe('/community command', () => {
  type OptionJSON = {
    name: string;
    name_localizations?: Record<string, string>;
    type: number;
    required?: boolean;
    autocomplete?: boolean;
    max_length?: number;
    choices?: Array<{ name: string; value: number }>;
    options?: OptionJSON[];
  };

  const json = command.data.toJSON() as unknown as {
    name: string;
    contexts?: number[];
    options: OptionJSON[];
  };

  function find(options: OptionJSON[] | undefined, name: string): OptionJSON {
    const option = options?.find((o) => o.name === name);
    if (!option) throw new Error(`option ${name} not defined`);
    return option;
  }

  const create = find(find(json.options, 'poll').options, 'create');
  const end = find(find(json.options, 'poll').options, 'end');
  const team = find(find(json.options, 'roulette').options, 'team');

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

  it('is offered in servers only, not in DMs', () => {
    expect(json.contexts).toEqual([InteractionContextType.Guild]);
  });

  it('requires a question and leaves the ten option slots optional for the form', () => {
    const optionSlots = Array.from({ length: 10 }, (_, i) =>
      find(create.options, `option${i + 1}`)
    );

    expect(find(create.options, 'question')).toMatchObject({
      required: true,
      max_length: 300,
    });
    expect(optionSlots.every((o) => !o.required)).toBe(true);
    // The builder must not allow anything collectAnswers would then reject.
    expect(optionSlots.every((o) => o.max_length === MAX_ANSWER_LENGTH)).toBe(
      true
    );
    expect(create.options?.some((o) => o.name === 'option11')).toBe(false);
  });

  it('offers the same fixed poll durations as the form', () => {
    const duration = find(create.options, 'duration');

    expect(duration.required ?? false).toBe(false);
    expect(duration.choices?.map((c) => c.value)).toEqual([
      ...POLL_DURATION_HOURS,
    ]);
    expect(find(create.options, 'multi').required ?? false).toBe(false);
  });

  it('lets poll end pick one of your polls, suggested as you type', () => {
    expect(find(end.options, 'poll')).toMatchObject({
      required: false,
      autocomplete: true,
    });
  });

  it('names options in Japanese for Japanese clients', () => {
    const ja = (option: OptionJSON) => option.name_localizations?.ja;

    expect(ja(find(create.options, 'question'))).toBe('質問');
    expect(
      Array.from({ length: 10 }, (_, i) =>
        ja(find(create.options, `option${i + 1}`))
      )
    ).toEqual(Array.from({ length: 10 }, (_, i) => `選択肢${i + 1}`));
    expect(ja(find(create.options, 'duration'))).toBe('期間');
    expect(ja(find(create.options, 'multi'))).toBe('複数選択');
    expect(ja(find(end.options, 'poll'))).toBe('投票');
    expect(ja(find(team.options, 'count'))).toBe('チーム数');
  });

  it('limits team roulette to two through six teams', () => {
    const count = find(team.options, 'count');

    expect(count.required).toBe(true);
    expect(count.choices?.map((c) => c.value)).toEqual([2, 3, 4, 5, 6]);
  });

  it('rate limits roulette long enough to cover the animation, and polls lightly', () => {
    expect(command.middleware).toEqual(['cooldown']);
    for (const path of [
      'community roulette member',
      'community roulette team',
    ]) {
      expect(resolveCooldownMs(command, path)).toBeGreaterThanOrEqual(
        ANIMATION_MS
      );
    }
    expect(resolveCooldownMs(command, 'community poll create')).toBe(3_000);
    expect(resolveCooldownMs(command, 'community poll end')).toBe(3_000);
  });

  it('keeps cooldowns per path, so creating a poll does not block ending it', async () => {
    const created = commandInteraction({ group: 'poll', subcommand: 'create' });
    const ended = commandInteraction({ group: 'poll', subcommand: 'end' });
    const rolledAgain = commandInteraction({
      group: 'roulette',
      subcommand: 'member',
    });

    expect(
      (await cooldownMiddleware(created.interaction, command)).success
    ).toBe(true);
    expect((await cooldownMiddleware(ended.interaction, command)).success).toBe(
      true
    );
    expect(
      (await cooldownMiddleware(rolledAgain.interaction, command)).success
    ).toBe(true);
    expect(
      (await cooldownMiddleware(created.interaction, command)).success
    ).toBe(false);
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
