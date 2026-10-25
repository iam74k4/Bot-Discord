import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MessageFlags } from 'discord.js';
import { createMockInteraction } from '../../helpers/discord.js';
import { t } from '../../../locales/index.js';

vi.mock('../../../infrastructure/database/connection.js', () => ({
  database: {
    prepare: vi.fn().mockReturnValue({
      get: vi.fn().mockReturnValue({ count: 5 }),
      all: vi.fn().mockReturnValue([]),
      run: vi.fn().mockReturnValue({ changes: 0 }),
    }),
  },
}));

vi.mock('../../../infrastructure/health/index.js', () => ({
  getHealthStatus: vi.fn().mockReturnValue({
    status: 'healthy',
    uptime: 3600,
    memory: { used: 100, total: 200, percentage: 50 },
    database: { connected: true, tables: 5 },
    discord: { connected: true, ping: 50 },
    services: { scheduler: true, notifications: true, memoryMonitor: true },
    timestamp: Date.now(),
  }),
  formatHealthStatus: vi.fn().mockReturnValue('Health status formatted'),
}));

vi.mock('../../../infrastructure/backup/index.js', () => ({
  backupService: {
    runBackup: vi.fn().mockResolvedValue({
      success: true,
      filename: 'backup-2024-01-01T00-00-00.db',
      size: 1024,
      timestamp: new Date(),
    }),
    listBackups: vi.fn().mockReturnValue([]),
    formatBackupList: vi.fn().mockReturnValue('No backups found.'),
  },
}));

vi.mock('../../../infrastructure/metrics/index.js', () => ({
  metrics: {
    formatForDisplay: vi.fn().mockReturnValue('Metrics formatted'),
    getSnapshot: vi.fn().mockReturnValue({
      commands: { executed: 100, errors: 5, byName: {} },
      voice: { recordings: 10, totalSeconds: 600 },
      startTime: Date.now() - 3600000,
      uptimeSeconds: 3600,
    }),
  },
}));

vi.mock('../../../config/env.js', () => ({
  isBotOwner: vi.fn((id: string) => id === '987654321098765432'),
}));

vi.mock('../../../shared/utils/confirm.js', () => ({
  awaitConfirmation: vi.fn().mockResolvedValue(true),
}));

describe('Owner Command', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Permission Check', () => {
    it('should reject non-owner users', async () => {
      const interaction = createMockInteraction({
        commandName: 'owner',
        subcommandGroup: 'system',
        subcommand: 'stats',
        user: { id: 'not-owner-id' },
      });

      const { command } =
        await import('../../../features/admin/commands/owner.js');
      await command.execute(interaction);

      expect(interaction.reply).toHaveBeenCalledWith(
        expect.objectContaining({
          flags: MessageFlags.Ephemeral,
          embeds: [
            expect.objectContaining({
              data: expect.objectContaining({
                description: t('owner.errors.ownerOnly', 'en'),
              }),
            }),
          ],
        })
      );
    });

    it('should allow bot owner', async () => {
      const interaction = createMockInteraction({
        commandName: 'owner',
        subcommandGroup: 'system',
        subcommand: 'stats',
        user: { id: '987654321098765432' },
      });

      const { command } =
        await import('../../../features/admin/commands/owner.js');
      await command.execute(interaction);

      expect(interaction.reply).toHaveBeenCalledWith(
        expect.objectContaining({
          embeds: [
            expect.objectContaining({
              data: expect.objectContaining({
                title: t('admin.panel.statsTitle', 'en'),
              }),
            }),
          ],
        })
      );
    });
  });

  describe('DB Subcommand', () => {
    it('should list row counts of the tracked tables', async () => {
      const interaction = createMockInteraction({
        commandName: 'owner',
        subcommandGroup: 'system',
        subcommand: 'db',
        user: { id: '987654321098765432' },
      });

      const { command } =
        await import('../../../features/admin/commands/owner.js');
      await command.execute(interaction);

      const [[payload]] = vi.mocked(interaction.reply).mock
        .calls as unknown as [
        [{ embeds: Array<{ data: { fields: Array<{ value: string }> } }> }],
      ];
      expect(payload.embeds[0]!.data.fields[0]!.value).toBe(
        [
          '`guild_settings`: 5',
          '`audit_logs`: 5',
          '`notification_channels`: 5',
          '`voice_sessions`: 5',
        ].join('\n')
      );
    });
  });

  describe('Guilds Subcommand', () => {
    it('should show an empty state when the bot is in no server', async () => {
      const interaction = createMockInteraction({
        commandName: 'owner',
        subcommandGroup: 'system',
        subcommand: 'guilds',
        user: { id: '987654321098765432' },
      });

      const { command } =
        await import('../../../features/admin/commands/owner.js');
      await command.execute(interaction);

      expect(interaction.reply).toHaveBeenCalledWith(
        expect.objectContaining({
          embeds: [
            expect.objectContaining({
              data: expect.objectContaining({
                title: t('admin.panel.guildsTitle', 'en'),
                description: t('common.noData', 'en'),
              }),
            }),
          ],
        })
      );
    });
  });

  describe('Broadcast Subcommand', () => {
    it('should refuse to broadcast when no server opted in', async () => {
      const interaction = createMockInteraction({
        commandName: 'owner',
        subcommandGroup: 'system',
        subcommand: 'broadcast',
        options: { message: 'Hello' },
        user: { id: '987654321098765432' },
      });

      const { command } =
        await import('../../../features/admin/commands/owner.js');
      const { awaitConfirmation } =
        await import('../../../shared/utils/confirm.js');
      await command.execute(interaction);

      expect(awaitConfirmation).not.toHaveBeenCalled();
      expect(interaction.reply).toHaveBeenCalledWith(
        expect.objectContaining({
          flags: MessageFlags.Ephemeral,
          embeds: [
            expect.objectContaining({
              data: expect.objectContaining({
                description: t('owner.broadcast.noChannel', 'en'),
              }),
            }),
          ],
        })
      );
    });
  });

  describe('Health Subcommand', () => {
    it('should display health status', async () => {
      const interaction = createMockInteraction({
        commandName: 'owner',
        subcommandGroup: 'system',
        subcommand: 'health',
        user: { id: '987654321098765432' },
      });

      const { command } =
        await import('../../../features/admin/commands/owner.js');
      await command.execute(interaction);

      expect(interaction.reply).toHaveBeenCalledWith(
        expect.objectContaining({
          embeds: expect.arrayContaining([
            expect.objectContaining({
              data: expect.objectContaining({
                title: t('admin.panel.healthTitle', 'en'),
              }),
            }),
          ]),
        })
      );
    });
  });

  describe('Backup Subcommands', () => {
    it('should list backups', async () => {
      const interaction = createMockInteraction({
        commandName: 'owner',
        subcommandGroup: 'backup',
        subcommand: 'list',
        user: { id: '987654321098765432' },
      });

      const { command } =
        await import('../../../features/admin/commands/owner.js');
      await command.execute(interaction);

      expect(interaction.reply).toHaveBeenCalledWith(
        expect.objectContaining({
          flags: MessageFlags.Ephemeral,
          embeds: expect.arrayContaining([
            expect.objectContaining({
              data: expect.objectContaining({
                title: t('admin.panel.backupsTitle', 'en'),
              }),
            }),
          ]),
        })
      );
    });

    it('should run manual backup', async () => {
      const interaction = createMockInteraction({
        commandName: 'owner',
        subcommandGroup: 'backup',
        subcommand: 'run',
        user: { id: '987654321098765432' },
      });

      const { command } =
        await import('../../../features/admin/commands/owner.js');
      await command.execute(interaction);

      expect(interaction.editReply).toHaveBeenCalledWith(
        expect.objectContaining({
          content: '',
          embeds: expect.arrayContaining([
            expect.objectContaining({
              data: expect.objectContaining({
                // owner.ts hard-codes this title per locale (no locale key).
                title: 'Backup Complete',
              }),
            }),
          ]),
        })
      );
    });
  });

  describe('Metrics Subcommand', () => {
    it('should display metrics', async () => {
      const interaction = createMockInteraction({
        commandName: 'owner',
        subcommandGroup: 'system',
        subcommand: 'metrics',
        user: { id: '987654321098765432' },
      });

      const { command } =
        await import('../../../features/admin/commands/owner.js');
      await command.execute(interaction);

      expect(interaction.reply).toHaveBeenCalledWith(
        expect.objectContaining({
          embeds: expect.arrayContaining([
            expect.objectContaining({
              data: expect.objectContaining({
                title: t('admin.panel.metricsTitle', 'en'),
              }),
            }),
          ]),
        })
      );
    });
  });
});
