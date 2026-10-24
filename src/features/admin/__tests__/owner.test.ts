import Database from 'better-sqlite3';
import { MessageFlags, type ChatInputCommandInteraction } from 'discord.js';
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
 * announcement broadcast (fan-out, cap, per-guild failure accounting) and the
 * manual backup - each behind a confirmation.
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
  awaitConfirmation: vi.fn(),
}));

vi.mock('../../../infrastructure/backup/index.js', () => ({
  backupService: { runBackup: vi.fn() },
}));

const { executeOwnerCommand } = await import('../application/owner.js');
const { t } = await import('../../../locales/index.js');
const { COLORS } = await import('../../../shared/utils/constants/index.js');
const { showAdminSystemPanel } = await import('../application/systemPanel.js');
const { awaitConfirmation } = await import('../../../shared/utils/confirm.js');
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
  options: { send?: Mock; canSend?: boolean } = {}
) {
  const channel = textChannelStub({
    id: `news-${id}`,
    canSend: options.canSend,
    send: options.send,
  });
  guildSettingsRepository.setAnnouncementChannel(id, channel.id);
  return { guild: guildStub({ id, channels: [channel] }), channel };
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

describe('executeOwnerCommand', () => {
  beforeAll(async () => {
    await migrateAdminSchema();
  });

  beforeEach(() => {
    clearAdminTables(db);
    vi.clearAllMocks();
    vi.mocked(awaitConfirmation).mockResolvedValue(true);
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
        expect(embedAt(payload).description).toBe(
          t('owner.errors.ownerOnly', 'en')
        );
        expect(showAdminSystemPanel).not.toHaveBeenCalled();
        expect(awaitConfirmation).not.toHaveBeenCalled();
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

      expect(awaitConfirmation).not.toHaveBeenCalled();
      const payload = payloadOf<Payload>(reply);
      expect(payload.flags).toBe(MessageFlags.Ephemeral);
      const embed = embedAt(payload);
      expect(embed.description).toBe(t('owner.broadcast.noChannel', 'en'));
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

      expect(awaitConfirmation).toHaveBeenCalledWith(
        interaction,
        t('owner.broadcast.confirm', 'en', {
          count: 2,
          total: 3,
          message: 'Maintenance at 10:00',
        }),
        { ephemeral: true, timeout: 45_000 }
      );
    });

    it('sends nothing when the owner cancels', async () => {
      vi.mocked(awaitConfirmation).mockResolvedValue(false);
      const { guild, channel } = optedInGuild('g1');
      const { interaction, editReply } = setup({
        subcommand: 'broadcast',
        guilds: [guild],
      });

      await executeOwnerCommand(interaction);

      expect(channel.send).not.toHaveBeenCalled();
      expect(editReply).toHaveBeenCalledTimes(1);
      const payload = payloadOf<Payload>(editReply);
      expect(embedAt(payload).title).toBe(t('common.cancelled', 'en'));
      expect(payload.components).toEqual([]);
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
      const posted = embedAt(
        payloadOf<Payload>(delivered.channel.send as Mock)
      );
      expect(posted.title).toBe('Announcement from Bot Owner');
      expect(posted.description).toBe('New feature!');
      expect(notSendable.channel.send).not.toHaveBeenCalled();

      const result = lastEdit(editReply);
      expect(result.content).toBe('');
      expect(embedAt(result).description).toBe(
        t('owner.broadcast.complete', 'en', {
          sent: 1,
          failed: 2,
          skipped: 1,
          capNote: '',
        })
      );
      expect(embedAt(result).color).toBe(COLORS.SUCCESS);
      expect(logger.debug).toHaveBeenCalledWith(
        'Failed to send broadcast to guild g2:',
        expect.stringContaining('not sendable')
      );
      expect(logger.debug).toHaveBeenCalledWith(
        'Failed to send broadcast to guild g4:',
        expect.stringContaining('Missing Access')
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

      expect(awaitConfirmation).toHaveBeenCalledWith(
        interaction,
        t('owner.broadcast.confirm', 'ja', {
          count: 1,
          total: 2,
          message: 'Hello servers',
        }),
        expect.anything()
      );
      expect(embedAt(lastEdit(editReply)).description).toBe(
        t('owner.broadcast.complete', 'ja', {
          sent: 1,
          failed: 0,
          skipped: 1,
          capNote: '',
        })
      );
    });

    it('counts a channel that never answers as failed after five seconds', async () => {
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
      await vi.advanceTimersByTimeAsync(4_999);
      expect(healthy.channel.send).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await run;

      expect(healthy.channel.send).toHaveBeenCalledTimes(1);
      expect(embedAt(lastEdit(editReply)).description).toBe(
        t('owner.broadcast.complete', 'en', {
          sent: 1,
          failed: 1,
          skipped: 0,
          capNote: '',
        })
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

      expect(awaitConfirmation).toHaveBeenCalledWith(
        interaction,
        t('owner.broadcast.confirm', 'en', {
          count: 250,
          total: 260,
          message: 'Hello servers',
        }),
        expect.anything()
      );

      // Initial progress, one every 12 guilds (20), the final guild, result.
      expect(editReply).toHaveBeenCalledTimes(23);
      expect(payloadOf<Payload>(editReply, 0).content).toBe(
        t('owner.broadcast.progress', 'en', {
          processed: 0,
          total: 250,
          sent: 0,
          failed: 0,
          capNote: ' [250/260]',
        })
      );
      expect(payloadOf<Payload>(editReply, 1).content).toBe(
        t('owner.broadcast.progress', 'en', {
          processed: 12,
          total: 250,
          sent: 12,
          failed: 0,
          capNote: ' (cap 250/260 guilds)',
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

    it('finishes even when a progress update cannot be edited', async () => {
      const { guild, channel } = optedInGuild('g1');
      const editReply = vi
        .fn()
        .mockResolvedValueOnce({}) // initial progress
        .mockRejectedValueOnce(new Error('Unknown Message')) // progress 1/1
        .mockResolvedValue({}); // result
      const { interaction } = setup({
        subcommand: 'broadcast',
        guilds: [guild],
        editReply,
      });

      await executeOwnerCommand(interaction);

      expect(channel.send).toHaveBeenCalledTimes(1);
      expect(editReply).toHaveBeenCalledTimes(3);
      expect(embedAt(lastEdit(editReply)).description).toBe(
        t('owner.broadcast.complete', 'en', {
          sent: 1,
          failed: 0,
          skipped: 0,
          capNote: '',
        })
      );
      expect(logger.debug).toHaveBeenCalledWith(
        expect.stringContaining('Failed to edit broadcast progress')
      );
    });
  });

  describe('backup run', () => {
    function runBackup(locale = 'en-US') {
      return setup({ group: 'backup', subcommand: 'run', locale });
    }

    it('asks for confirmation first', async () => {
      vi.mocked(backupService.runBackup).mockResolvedValue({
        success: true,
        filename: 'b.db',
        size: 0,
        timestamp: new Date(0),
      });
      const { interaction } = runBackup();

      await executeOwnerCommand(interaction);

      expect(awaitConfirmation).toHaveBeenCalledWith(
        interaction,
        t('owner.backup.confirm', 'en'),
        { ephemeral: true }
      );
    });

    it('does not back up when the owner cancels', async () => {
      vi.mocked(awaitConfirmation).mockResolvedValue(false);
      const { interaction, editReply } = runBackup();

      await executeOwnerCommand(interaction);

      expect(backupService.runBackup).not.toHaveBeenCalled();
      const payload = payloadOf<Payload>(editReply);
      expect(embedAt(payload).title).toBe(t('common.cancelled', 'en'));
      expect(payload.components).toEqual([]);
    });

    it('shows progress, then the file name and size in KB', async () => {
      vi.mocked(backupService.runBackup).mockResolvedValue({
        success: true,
        filename: 'backup-2026-10-24.db',
        size: 10 * 1024 + 700,
        timestamp: new Date(0),
      });
      const { interaction, editReply } = runBackup();

      await executeOwnerCommand(interaction);

      expect(editReply).toHaveBeenCalledTimes(2);
      expect(payloadOf<Payload>(editReply, 0)).toMatchObject({
        embeds: [],
        components: [],
        content: expect.any(String),
      });
      const result = lastEdit(editReply);
      expect(result.content).toBe('');
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

      expect(embedAt(lastEdit(editReply)).description).toBe(
        t('owner.backup.complete', 'ja', { filename: 'b.db', size: 2 })
      );
    });

    it.each([
      ['the reported error', 'SQLITE_BUSY', 'SQLITE_BUSY', 'en'],
      [
        'a fallback when none is given',
        undefined,
        'Unknown error occurred',
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
        expect(embedAt(result).description).toBe(
          t('owner.backup.failed', locale, { error: shown })
        );
        expect(embedAt(result).color).toBe(COLORS.ERROR);
      }
    );
  });
});
