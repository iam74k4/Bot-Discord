import Database from 'better-sqlite3';
import {
  ButtonStyle,
  MessageFlags,
  type ChatInputCommandInteraction,
} from 'discord.js';
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from 'vitest';
import {
  clearAdminTables,
  clientStub,
  embedAt,
  guildStub,
  migrateAdminSchema,
  payloadOf,
  textChannelStub,
} from './admin.helpers.js';

/**
 * `/owner` is the bot operator's console. The read-only views are covered by
 * the system panel tests; here the focus is what only this module decides:
 * who may use it at all, and the two actions with side effects - the
 * announcement broadcast (fan-out, cap, concurrency, per-guild failure
 * accounting) and the manual backup - each behind a confirmation.
 */

const db = new Database(':memory:');

vi.mock('../../../infrastructure/database/connection.js', () => ({
  database: db,
}));

vi.mock('../../../shared/utils/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
  getErrorMessage: (e: unknown) => String(e),
}));

vi.mock('../../../config/env.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../config/env.js')>()),
  isBotOwner: vi.fn((id: string) => id === 'owner-1'),
}));

vi.mock('../application/systemPanel.js', () => ({
  showAdminSystemPanel: vi.fn(),
}));

vi.mock('../../../shared/utils/confirm.js', () => ({
  awaitConfirmationResult: vi.fn(),
}));

vi.mock('../../../infrastructure/backup/index.js', () => ({
  backupService: { runBackup: vi.fn() },
}));

const { executeOwnerCommand, runWithConcurrency } =
  await import('../application/owner.js');
const { t } = await import('../../../locales/index.js');
const { commandMention } =
  await import('../../../shared/utils/commandMentions.js');
const { COLORS } = await import('../../../shared/utils/constants/index.js');
const { showAdminSystemPanel } = await import('../application/systemPanel.js');
const { awaitConfirmationResult } =
  await import('../../../shared/utils/confirm.js');
const { backupService } =
  await import('../../../infrastructure/backup/index.js');
const { guildSettingsRepository } =
  await import('../../../infrastructure/guildSettings/index.js');
const { logger } = await import('../../../shared/utils/logger.js');

const OWNER_ID = 'owner-1';

function setup(
  options: {
    group?: string | null;
    subcommand: string;
    userId?: string;
    message?: string;
    locale?: string;
    guilds?: ReturnType<typeof guildStub>[];
    editReply?: Mock;
  } = { subcommand: 'stats' }
) {
  const reply = vi.fn().mockResolvedValue({});
  const editReply = options.editReply ?? vi.fn().mockResolvedValue({});
  const interaction = {
    user: { id: options.userId ?? OWNER_ID },
    // `/owner` also works in DMs, where only the user's locale applies.
    guildId: null,
    locale: options.locale ?? 'en-US',
    client: clientStub(options.guilds ?? []),
    options: {
      getSubcommandGroup: vi.fn(() => options.group ?? 'system'),
      getSubcommand: vi.fn(() => options.subcommand),
      getString: vi.fn(() => options.message ?? 'Hello servers'),
    },
    reply,
    editReply,
  } as unknown as ChatInputCommandInteraction;
  return { interaction, reply, editReply };
}

/**
 * A guild that opted in to announcements with a channel the bot can post in.
 * `send` controls what posting does.
 */
function optedInGuild(
  id: string,
  options: {
    send?: Mock;
    canSend?: boolean;
    features?: string[];
    preferredLocale?: string;
  } = {}
) {
  const channel = textChannelStub({
    id: `news-${id}`,
    canSend: options.canSend,
    send: options.send,
  });
  guildSettingsRepository.setAnnouncementChannel(id, channel.id);
  return {
    guild: guildStub({
      id,
      name: `Guild ${id}`,
      channels: [channel],
      features: options.features,
      preferredLocale: options.preferredLocale,
    }),
    channel,
  };
}

type Payload = {
  content?: string;
  embeds?: unknown[];
  components?: unknown[];
  flags?: number;
};

function lastEdit(editReply: Mock): Payload {
  return payloadOf<Payload>(editReply, editReply.mock.calls.length - 1);
}

/** The confirm button press `awaitConfirmationResult` hands back. */
let press: { update: Mock };

function confirmWith(outcome: 'confirmed' | 'cancelled' | 'timeout') {
  vi.mocked(awaitConfirmationResult).mockResolvedValue(
    (outcome === 'confirmed'
      ? { outcome, response: press }
      : { outcome }) as Awaited<ReturnType<typeof awaitConfirmationResult>>
  );
}

describe('executeOwnerCommand', () => {
  beforeAll(async () => {
    await migrateAdminSchema();
  });

  beforeEach(() => {
    clearAdminTables(db);
    vi.clearAllMocks();
    press = { update: vi.fn().mockResolvedValue(undefined) };
    confirmWith('confirmed');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('owner gating', () => {
    it.each([
      ['system', 'stats'],
      ['system', 'broadcast'],
      ['backup', 'run'],
      ['backup', 'list'],
    ])(
      'refuses %s %s to anyone but the bot owner',
      async (group, subcommand) => {
        const { guild } = optedInGuild('g1');
        const { interaction, reply } = setup({
          group,
          subcommand,
          userId: 'someone-else',
          guilds: [guild],
        });

        await executeOwnerCommand(interaction);

        const payload = payloadOf<Payload>(reply);
        expect(payload.flags).toBe(MessageFlags.Ephemeral);
        const embed = embedAt(payload);
        expect(embed.title).toBe(t('common.permissionDeniedTitle', 'en'));
        expect(embed.description).toBe(t('owner.errors.ownerOnly', 'en'));
        expect(embed.color).toBe(COLORS.WARNING);
        expect(showAdminSystemPanel).not.toHaveBeenCalled();
        expect(awaitConfirmationResult).not.toHaveBeenCalled();
        expect(backupService.runBackup).not.toHaveBeenCalled();
      }
    );
  });

  describe('panel routing', () => {
    it.each([
      ['system', 'stats', 'stats'],
      ['system', 'db', 'db'],
      ['system', 'guilds', 'guilds'],
      ['system', 'health', 'health'],
      ['system', 'metrics', 'metrics'],
      ['backup', 'list', 'backups'],
    ])('opens %s %s on the %s tab', async (group, subcommand, view) => {
      const { interaction } = setup({ group, subcommand, locale: 'ja' });

      await executeOwnerCommand(interaction);

      expect(showAdminSystemPanel).toHaveBeenCalledWith(
        interaction,
        'ja',
        view
      );
    });

    it.each([
      ['backup', 'bogus'],
      ['system', 'bogus'],
    ])('ignores an unknown %s subcommand', async (group, subcommand) => {
      const { interaction, reply } = setup({ group, subcommand });

      await executeOwnerCommand(interaction);

      expect(reply).not.toHaveBeenCalled();
      expect(showAdminSystemPanel).not.toHaveBeenCalled();
    });
  });

  describe('broadcast', () => {
    it('stops before confirming when no guild opted in', async () => {
      const { interaction, reply } = setup({
        subcommand: 'broadcast',
        guilds: [guildStub({ id: 'g1' }), guildStub({ id: 'g2' })],
      });

      await executeOwnerCommand(interaction);

      expect(awaitConfirmationResult).not.toHaveBeenCalled();
      const payload = payloadOf<Payload>(reply);
      expect(payload.flags).toBe(MessageFlags.Ephemeral);
      const embed = embedAt(payload);
      // Nothing went wrong: a warning, titled as one.
      expect(embed.title).toBe(t('common.warning', 'en'));
      expect(embed.description).toBe(
        t('owner.broadcast.noChannel', 'en', {
          command: commandMention('admin settings announcements'),
        })
      );
      expect(embed.color).toBe(COLORS.WARNING);
    });

    it('asks for confirmation naming how many guilds will receive it', async () => {
      const a = optedInGuild('g1');
      const b = optedInGuild('g2');
      const { interaction } = setup({
        subcommand: 'broadcast',
        message: 'Maintenance at 10:00',
        guilds: [a.guild, guildStub({ id: 'g3' }), b.guild],
      });

      await executeOwnerCommand(interaction);

      expect(awaitConfirmationResult).toHaveBeenCalledWith(
        interaction,
        t('owner.broadcast.confirm', 'en', {
          count: 2,
          total: 3,
          message: 'Maintenance at 10:00',
        }),
        {
          ephemeral: true,
          timeout: 45_000,
          title: t('owner.broadcast.confirmTitle', 'en'),
          confirmLabel: t('owner.broadcast.confirmLabel', 'en'),
        }
      );
    });

    it.each(['cancelled', 'timeout'] as const)(
      'sends nothing and leaves the prompt to the helper when %s',
      async (outcome) => {
        confirmWith(outcome);
        const { guild, channel } = optedInGuild('g1');
        const { interaction, editReply } = setup({
          subcommand: 'broadcast',
          guilds: [guild],
        });

        await executeOwnerCommand(interaction);

        expect(channel.send).not.toHaveBeenCalled();
        // The helper already said "cancelled" / "timed out".
        expect(editReply).not.toHaveBeenCalled();
        expect(press.update).not.toHaveBeenCalled();
      }
    );

    it('answers the press by replacing the prompt with the progress line', async () => {
      const { guild } = optedInGuild('g1');
      const { interaction } = setup({
        subcommand: 'broadcast',
        guilds: [guild],
      });

      await executeOwnerCommand(interaction);

      expect(press.update).toHaveBeenCalledWith({
        content: t('owner.broadcast.progress', 'en', {
          processed: 0,
          total: 1,
          sent: 0,
          failed: 0,
          capNote: '',
        }),
        embeds: [],
        components: [],
      });
    });

    it('sends nothing when the press cannot be answered', async () => {
      const lost = new Error('Unknown interaction');
      press.update.mockRejectedValue(lost);
      const { guild, channel } = optedInGuild('g1');
      const { interaction } = setup({
        subcommand: 'broadcast',
        guilds: [guild],
      });

      await expect(executeOwnerCommand(interaction)).rejects.toBe(lost);

      expect(channel.send).not.toHaveBeenCalled();
    });

    it('posts the message and tells delivered, failed and skipped apart', async () => {
      const delivered = optedInGuild('g1');
      const notSendable = optedInGuild('g2', { canSend: false });
      const rejected = optedInGuild('g4', {
        send: vi.fn().mockRejectedValue(new Error('Missing Access')),
      });
      const { interaction, editReply } = setup({
        subcommand: 'broadcast',
        message: 'New feature!',
        guilds: [
          delivered.guild,
          notSendable.guild,
          guildStub({ id: 'g3' }), // never opted in
          rejected.guild,
        ],
      });

      await executeOwnerCommand(interaction);

      expect(delivered.channel.send).toHaveBeenCalledTimes(1);
      expect(notSendable.channel.send).not.toHaveBeenCalled();
      expect(rejected.channel.send).toHaveBeenCalledTimes(1);

      const result = lastEdit(editReply);
      expect(result.content).toBe('');
      const embed = embedAt(result);
      expect(embed.title).toBe(t('owner.broadcast.completeTitle', 'en'));
      // Each failed server is named with why, in the order they were planned.
      expect(embed.description).toBe(
        t('owner.broadcast.complete', 'en', {
          sent: 1,
          failed: 2,
          skipped: 1,
          capNote: '',
        }) +
          t('owner.broadcast.failures', 'en', {
            list: [
              `• Guild g2 — ${t('owner.broadcast.failureReasons.notSendable', 'en')}`,
              `• Guild g4 — ${t('owner.broadcast.failureReasons.sendFailed', 'en')}`,
            ].join('\n'),
          })
      );
      expect(embed.color).toBe(COLORS.SUCCESS);
      expect(logger.debug).toHaveBeenCalledWith(
        'Failed to send broadcast to guild g2:',
        expect.stringContaining('not sendable')
      );
      expect(logger.debug).toHaveBeenCalledWith(
        'Failed to send broadcast to guild g4:',
        expect.stringContaining('Missing Access')
      );
    });

    it("posts in each server's own language, with how to stop receiving them", async () => {
      const auto = optedInGuild('g1');
      const english = optedInGuild('g2');
      guildSettingsRepository.setLanguage('g2', 'en');
      const community = optedInGuild('g3', {
        features: ['COMMUNITY'],
        preferredLocale: 'en-US',
      });
      const { interaction } = setup({
        subcommand: 'broadcast',
        message: 'New feature!',
        guilds: [auto.guild, english.guild, community.guild],
      });

      await executeOwnerCommand(interaction);

      const posted = (channel: { send: Mock }) =>
        embedAt(payloadOf<Payload>(channel.send));
      // A server on automatic that is not a Community server: Japanese.
      expect(posted(auto.channel)).toMatchObject({
        title: t('owner.broadcast.embedTitle', 'ja'),
        description: 'New feature!',
        footer: { text: t('owner.broadcast.embedFooter', 'ja') },
      });
      expect(posted(english.channel).title).toBe(
        t('owner.broadcast.embedTitle', 'en')
      );
      expect(posted(community.channel).title).toBe(
        t('owner.broadcast.embedTitle', 'en')
      );
    });

    it('refuses to post where the bot could send but not embed', async () => {
      const channel = textChannelStub({
        id: 'news-g1',
        permissions: [1n << 10n, 1n << 11n], // View Channel, Send Messages
      });
      guildSettingsRepository.setAnnouncementChannel('g1', channel.id);
      const guild = guildStub({ id: 'g1', channels: [channel] });
      const { interaction, editReply } = setup({
        subcommand: 'broadcast',
        guilds: [guild],
      });

      await executeOwnerCommand(interaction);

      expect(channel.send).not.toHaveBeenCalled();
      expect(embedAt(lastEdit(editReply)).description).toContain(
        t('owner.broadcast.failureReasons.notSendable', 'en')
      );
    });

    it('reports the result in Japanese for a Japanese client', async () => {
      const { guild } = optedInGuild('g1');
      const { interaction, editReply } = setup({
        subcommand: 'broadcast',
        locale: 'ja',
        guilds: [guild, guildStub({ id: 'g2' })],
      });

      await executeOwnerCommand(interaction);

      expect(awaitConfirmationResult).toHaveBeenCalledWith(
        interaction,
        t('owner.broadcast.confirm', 'ja', {
          count: 1,
          total: 2,
          message: 'Hello servers',
        }),
        expect.objectContaining({
          title: t('owner.broadcast.confirmTitle', 'ja'),
        })
      );
      const result = embedAt(lastEdit(editReply));
      expect(result.title).toBe(t('owner.broadcast.completeTitle', 'ja'));
      expect(result.description).toBe(
        t('owner.broadcast.complete', 'ja', {
          sent: 1,
          failed: 0,
          skipped: 1,
          capNote: '',
        })
      );
    });

    it('does not let a channel that never answers hold up the others', async () => {
      vi.useFakeTimers();
      const hanging = optedInGuild('g1', {
        send: vi.fn(() => new Promise(() => {})),
      });
      const healthy = optedInGuild('g2');
      const { interaction, editReply } = setup({
        subcommand: 'broadcast',
        guilds: [hanging.guild, healthy.guild],
      });

      const run = executeOwnerCommand(interaction);
      await vi.advanceTimersByTimeAsync(0);
      expect(healthy.channel.send).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(4_999);
      expect(editReply).not.toHaveBeenCalledWith(
        expect.objectContaining({ content: '' })
      );
      await vi.advanceTimersByTimeAsync(1);
      await run;

      // Five seconds without an answer counts as failed.
      expect(embedAt(lastEdit(editReply)).description).toBe(
        t('owner.broadcast.complete', 'en', {
          sent: 1,
          failed: 1,
          skipped: 0,
          capNote: '',
        }) +
          t('owner.broadcast.failures', 'en', {
            list: `• Guild g1 — ${t('owner.broadcast.failureReasons.timeout', 'en')}`,
          })
      );
    });

    /**
     * Regression: delivery went to one server at a time, so a broadcast to
     * a few hundred servers took minutes; it now keeps a few sends in
     * flight, and no more.
     */
    it('keeps at most three sends in flight and tries every server once', async () => {
      vi.useFakeTimers();
      let inFlight = 0;
      let peak = 0;
      const slowSend = () =>
        vi.fn(async () => {
          inFlight++;
          peak = Math.max(peak, inFlight);
          await new Promise((resolve) => setTimeout(resolve, 1_000));
          inFlight--;
        });
      const opted = Array.from({ length: 30 }, (_, i) =>
        optedInGuild(`g${i}`, { send: slowSend() })
      );
      const { interaction, editReply } = setup({
        subcommand: 'broadcast',
        guilds: opted.map((o) => o.guild),
      });

      const run = executeOwnerCommand(interaction);
      await vi.advanceTimersByTimeAsync(10_000);
      await run;

      expect(peak).toBe(3);
      expect(opted.every((o) => o.channel.send.mock.calls.length === 1)).toBe(
        true
      );
      expect(embedAt(lastEdit(editReply)).description).toBe(
        t('owner.broadcast.complete', 'en', {
          sent: 30,
          failed: 0,
          skipped: 0,
          capNote: '',
        })
      );
    });

    it('edits progress at most every two seconds, and the summary last', async () => {
      vi.useFakeTimers();
      const opted = Array.from({ length: 30 }, (_, i) =>
        optedInGuild(`g${i}`, {
          send: vi.fn(
            () => new Promise((resolve) => setTimeout(resolve, 1_000))
          ),
        })
      );
      const editTimes: number[] = [];
      const editReply = vi.fn(async () => {
        editTimes.push(Date.now());
        return {};
      });
      const { interaction } = setup({
        subcommand: 'broadcast',
        guilds: opted.map((o) => o.guild),
        editReply,
      });
      const start = Date.now();

      const run = executeOwnerCommand(interaction);
      await vi.advanceTimersByTimeAsync(10_000);
      await run;

      const progressTimes = editTimes.slice(0, -1);
      expect(progressTimes.length).toBeGreaterThan(0);
      expect(progressTimes.length).toBeLessThanOrEqual(5);
      expect(progressTimes[0]! - start).toBeGreaterThanOrEqual(2_000);
      for (let i = 1; i < progressTimes.length; i++) {
        expect(
          progressTimes[i]! - progressTimes[i - 1]!
        ).toBeGreaterThanOrEqual(2_000);
      }
      for (const [payload] of editReply.mock.calls.slice(0, -1) as unknown as [
        Payload,
      ][]) {
        expect(payload.content).toMatch(/^Broadcast in progress\.\.\./);
      }
      expect(lastEdit(editReply).content).toBe('');
      expect(embedAt(lastEdit(editReply)).title).toBe(
        t('owner.broadcast.completeTitle', 'en')
      );
    });

    it('finishes even when a progress update cannot be edited', async () => {
      vi.useFakeTimers();
      const opted = Array.from({ length: 9 }, (_, i) =>
        optedInGuild(`g${i}`, {
          send: vi.fn(
            () => new Promise((resolve) => setTimeout(resolve, 1_000))
          ),
        })
      );
      const editReply = vi
        .fn()
        .mockRejectedValueOnce(new Error('Unknown Message')) // progress
        .mockResolvedValue({});
      const { interaction } = setup({
        subcommand: 'broadcast',
        guilds: opted.map((o) => o.guild),
        editReply,
      });

      const run = executeOwnerCommand(interaction);
      await vi.advanceTimersByTimeAsync(3_000);
      await run;

      expect(embedAt(lastEdit(editReply)).description).toBe(
        t('owner.broadcast.complete', 'en', {
          sent: 9,
          failed: 0,
          skipped: 0,
          capNote: '',
        })
      );
      expect(logger.debug).toHaveBeenCalledWith(
        expect.stringContaining('Failed to edit broadcast progress')
      );
    });

    it('caps the fan-out at 250 guilds and says how many were left out', async () => {
      const opted = Array.from({ length: 260 }, (_, i) =>
        optedInGuild(`g${i}`)
      );
      const { interaction, editReply } = setup({
        subcommand: 'broadcast',
        guilds: opted.map((o) => o.guild),
      });

      await executeOwnerCommand(interaction);

      const sentTo = opted.filter((o) => o.channel.send.mock.calls.length > 0);
      expect(sentTo).toHaveLength(250);
      expect(
        opted.slice(250).every((o) => !o.channel.send.mock.calls.length)
      ).toBe(true);

      expect(awaitConfirmationResult).toHaveBeenCalledWith(
        interaction,
        t('owner.broadcast.confirm', 'en', {
          count: 250,
          total: 260,
          message: 'Hello servers',
        }),
        expect.anything()
      );

      // Progress names the cap, worded the same way every time.
      expect(payloadOf<Payload>(press.update).content).toBe(
        t('owner.broadcast.progress', 'en', {
          processed: 0,
          total: 250,
          sent: 0,
          failed: 0,
          capNote: t('owner.broadcast.progressCap', 'en', {
            limit: 250,
            total: 260,
          }),
        })
      );
      expect(embedAt(lastEdit(editReply)).description).toBe(
        t('owner.broadcast.complete', 'en', {
          sent: 250,
          failed: 0,
          skipped: 0,
          capNote: t('owner.broadcast.capNote', 'en', {
            limit: 250,
            total: 260,
          }),
        })
      );
    });

    it('names the first ten failed servers and counts the rest', async () => {
      const opted = Array.from({ length: 12 }, (_, i) =>
        optedInGuild(`g${i}`, { canSend: false })
      );
      const { interaction, editReply } = setup({
        subcommand: 'broadcast',
        guilds: opted.map((o) => o.guild),
      });

      await executeOwnerCommand(interaction);

      const description = embedAt(lastEdit(editReply)).description!;
      expect(description).toContain('• Guild g0 — ');
      expect(description).toContain('• Guild g9 — ');
      expect(description).not.toContain('• Guild g10 — ');
      expect(
        description.endsWith(
          t('owner.broadcast.moreFailures', 'en', { count: 2 })
        )
      ).toBe(true);
    });
  });

  describe('runWithConcurrency', () => {
    it('runs nothing for an empty list', async () => {
      const worker = vi.fn(async () => undefined);

      await runWithConcurrency([], 3, worker);

      expect(worker).not.toHaveBeenCalled();
    });

    it('hands each item and its index to a worker exactly once', async () => {
      const seen: Array<[string, number]> = [];

      await runWithConcurrency(['a', 'b', 'c', 'd'], 2, async (item, index) => {
        seen.push([item, index]);
      });

      expect(seen.sort()).toEqual([
        ['a', 0],
        ['b', 1],
        ['c', 2],
        ['d', 3],
      ]);
    });
  });

  describe('backup run', () => {
    function runBackup(locale = 'en-US') {
      return setup({ group: 'backup', subcommand: 'run', locale });
    }

    it('asks for confirmation first, with a safe-looking button', async () => {
      vi.mocked(backupService.runBackup).mockResolvedValue({
        success: true,
        filename: 'b.db',
        size: 0,
        timestamp: new Date(0),
      });
      const { interaction } = runBackup();

      await executeOwnerCommand(interaction);

      expect(awaitConfirmationResult).toHaveBeenCalledWith(
        interaction,
        t('owner.backup.confirm', 'en'),
        {
          ephemeral: true,
          title: t('owner.backup.confirmTitle', 'en'),
          confirmLabel: t('owner.backup.confirmLabel', 'en'),
          confirmStyle: ButtonStyle.Success,
        }
      );
    });

    it.each(['cancelled', 'timeout'] as const)(
      'does not back up when %s',
      async (outcome) => {
        confirmWith(outcome);
        const { interaction, editReply } = runBackup();

        await executeOwnerCommand(interaction);

        expect(backupService.runBackup).not.toHaveBeenCalled();
        expect(editReply).not.toHaveBeenCalled();
      }
    );

    it('does not back up when the press cannot be answered', async () => {
      press.update.mockRejectedValue(new Error('Unknown interaction'));
      const { interaction } = runBackup();

      await expect(executeOwnerCommand(interaction)).rejects.toThrow(
        'Unknown interaction'
      );

      expect(backupService.runBackup).not.toHaveBeenCalled();
    });

    it('answers the press with progress, then shows the file name and size in KB', async () => {
      vi.mocked(backupService.runBackup).mockResolvedValue({
        success: true,
        filename: 'backup-2026-10-24.db',
        size: 10 * 1024 + 700,
        timestamp: new Date(0),
      });
      const { interaction, editReply } = runBackup();

      await executeOwnerCommand(interaction);

      expect(press.update).toHaveBeenCalledWith({
        content: t('owner.backup.running', 'en'),
        embeds: [],
        components: [],
      });
      expect(press.update.mock.invocationCallOrder[0]).toBeLessThan(
        vi.mocked(backupService.runBackup).mock.invocationCallOrder[0]!
      );
      expect(editReply).toHaveBeenCalledTimes(1);
      const result = lastEdit(editReply);
      expect(result.content).toBe('');
      expect(embedAt(result).title).toBe(t('owner.backup.completeTitle', 'en'));
      expect(embedAt(result).description).toBe(
        t('owner.backup.complete', 'en', {
          filename: 'backup-2026-10-24.db',
          size: 11,
        })
      );
      expect(embedAt(result).color).toBe(COLORS.SUCCESS);
    });

    it('answers in Japanese for a Japanese client', async () => {
      vi.mocked(backupService.runBackup).mockResolvedValue({
        success: true,
        filename: 'b.db',
        size: 2048,
        timestamp: new Date(0),
      });
      const { interaction, editReply } = runBackup('ja');

      await executeOwnerCommand(interaction);

      expect(payloadOf<Payload>(press.update).content).toBe(
        t('owner.backup.running', 'ja')
      );
      const result = embedAt(lastEdit(editReply));
      expect(result.title).toBe('バックアップ完了');
      expect(result.description).toBe(
        t('owner.backup.complete', 'ja', { filename: 'b.db', size: 2 })
      );
    });

    it.each([
      ['the reported error', 'SQLITE_BUSY', 'SQLITE_BUSY', 'en'],
      [
        'a pointer to the logs when none is given',
        undefined,
        t('owner.backup.noReason', 'en'),
        'en',
      ],
      ['the reported error in Japanese', 'SQLITE_BUSY', 'SQLITE_BUSY', 'ja'],
    ] as const)(
      'reports a failed backup with %s',
      async (_case, error, shown, locale) => {
        vi.mocked(backupService.runBackup).mockResolvedValue({
          success: false,
          filename: '',
          size: 0,
          timestamp: new Date(0),
          error,
        });
        const { interaction, editReply } = runBackup(
          locale === 'ja' ? 'ja' : 'en-US'
        );

        await executeOwnerCommand(interaction);

        const result = lastEdit(editReply);
        expect(result.content).toBe('');
        expect(embedAt(result).title).toBe(
          t('owner.backup.failedTitle', locale)
        );
        expect(embedAt(result).description).toBe(
          t('owner.backup.failed', locale, { error: shown })
        );
        expect(embedAt(result).color).toBe(COLORS.ERROR);
      }
    );

    it('reports a backup that throws instead of leaving "running" behind', async () => {
      vi.mocked(backupService.runBackup).mockRejectedValue(
        new Error('EACCES: backup dir')
      );
      const { interaction, editReply } = runBackup();

      await executeOwnerCommand(interaction);

      expect(editReply).toHaveBeenCalledTimes(1);
      const result = lastEdit(editReply);
      expect(result.content).toBe('');
      expect(embedAt(result).title).toBe(t('owner.backup.failedTitle', 'en'));
      expect(embedAt(result).description).toBe(
        t('owner.backup.failed', 'en', { error: 'Error: EACCES: backup dir' })
      );
    });
  });
});
