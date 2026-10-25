import Database from 'better-sqlite3';
import {
  ButtonStyle,
  MessageFlags,
  type ChatInputCommandInteraction,
  type Guild,
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
  USER_ID,
  clearAdminTables,
  clientStub,
  componentStub,
  createPanelHarness,
  embedAt,
  guildStub,
  insertAuditLogs,
  migrateAdminSchema,
  payloadOf,
  rowsOf,
} from './admin.helpers.js';

/**
 * The owner's system panel: six read-only views behind tab buttons plus a
 * "run backup" action. Health, metrics and backups are infrastructure with
 * their own tests, so they are stubbed here; the DB view runs against real
 * in-memory SQLite. What is checked is what each tab renders and how the
 * buttons move between them.
 */

const db = new Database(':memory:');

vi.mock('../../../infrastructure/database/connection.js', () => ({
  database: db,
}));

vi.mock('../../../shared/utils/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
  getErrorMessage: (e: unknown) => String(e),
}));

vi.mock('../../../infrastructure/health/index.js', () => ({
  getHealthStatus: vi.fn(),
  formatHealthStatus: vi.fn(() => 'formatted health'),
}));

vi.mock('../../../infrastructure/metrics/index.js', () => ({
  metrics: { formatForDisplay: vi.fn(() => 'formatted metrics') },
}));

vi.mock('../../../infrastructure/backup/index.js', () => ({
  backupService: {
    listBackups: vi.fn(),
    runBackup: vi.fn(),
  },
}));

const { formatUptime, showAdminSystemPanel } =
  await import('../application/systemPanel.js');
const { t } = await import('../../../locales/index.js');
const { env } = await import('../../../config/index.js');
const { COLORS } = await import('../../../shared/utils/constants/index.js');
const { getHealthStatus, formatHealthStatus } =
  await import('../../../infrastructure/health/index.js');
const { backupService } =
  await import('../../../infrastructure/backup/index.js');

/** One stored backup, as `listBackups` reports it, and how the panel lists it. */
const BACKUP = {
  filename: 'backup-1.db',
  size: 12 * 1024,
  createdAt: new Date(1_700_000_000_000),
};
const BACKUP_LIST = '1. `backup-1.db` (12 KB) - <t:1700000000:f>';

function setup(guilds: Guild[] = [], channelCount = 0, commandCount = 0) {
  const harness = createPanelHarness();
  const client = Object.assign(clientStub(guilds), {
    commands: new Map(
      Array.from({ length: commandCount }, (_, i) => [`cmd${i}`, {}])
    ),
  });
  for (let i = 0; i < channelCount; i++) {
    (client.channels.cache as Map<string, unknown>).set(`c${i}`, {});
  }
  const interaction = {
    client,
    user: { id: USER_ID },
    locale: 'en-US',
    reply: harness.reply,
    editReply: harness.editReply,
  } as unknown as ChatInputCommandInteraction;
  return { interaction, harness };
}

type Payload = { embeds: unknown[]; components: unknown[]; flags?: number };

function lastUpdate(component: { update: Mock }) {
  return payloadOf<Payload>(
    component.update,
    component.update.mock.calls.length - 1
  );
}

function activeTab(payload: Payload): string | undefined {
  return rowsOf(payload.components)
    .flat()
    .find((c) => c.style === ButtonStyle.Primary)?.custom_id;
}

describe('showAdminSystemPanel', () => {
  beforeAll(async () => {
    await migrateAdminSchema();
  });

  beforeEach(() => {
    clearAdminTables(db);
    vi.clearAllMocks();
    vi.mocked(backupService.listBackups).mockResolvedValue([BACKUP]);
    vi.mocked(getHealthStatus).mockReturnValue({
      status: 'healthy',
    } as ReturnType<typeof getHealthStatus>);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('replies ephemerally with both button rows', async () => {
    const { interaction, harness } = setup();

    await showAdminSystemPanel(interaction, 'en', 'stats');

    const payload = payloadOf<Payload>(harness.reply);
    expect(payload.flags).toBe(MessageFlags.Ephemeral);
    expect(
      rowsOf(payload.components).map((r) => r.map((c) => c.custom_id))
    ).toEqual([
      [
        'admin-panel:stats',
        'admin-panel:db',
        'admin-panel:guilds',
        'admin-panel:health',
        'admin-panel:metrics',
      ],
      ['admin-panel:backups', 'admin-panel:refresh', 'admin-panel:run-backup'],
    ]);
    expect(activeTab(payload)).toBe('admin-panel:stats');
    expect(
      harness.message.createMessageComponentCollector
    ).toHaveBeenCalledWith({ idle: 120_000, time: 14 * 60_000 });
  });

  it('labels every tab in Japanese for a Japanese owner', async () => {
    const { interaction, harness } = setup();

    await showAdminSystemPanel(interaction, 'ja', 'stats');

    expect(
      rowsOf(payloadOf<Payload>(harness.reply).components)
        .flat()
        .map((c) => c.label)
    ).toEqual([
      '統計',
      'DB',
      'サーバー',
      'ヘルス',
      'メトリクス',
      'バックアップ',
      t('admin.panel.refresh', 'ja'),
      t('admin.panel.runBackup', 'ja'),
    ]);
  });

  describe('views', () => {
    it('stats: totals guilds, members, channels, uptime, memory and the runtime', async () => {
      vi.spyOn(process, 'uptime').mockReturnValue(86_400 + 3_600 * 2 + 60 * 3);
      vi.spyOn(process, 'memoryUsage').mockReturnValue({
        heapUsed: 50 * 1024 * 1024,
      } as NodeJS.MemoryUsage);
      const { interaction, harness } = setup(
        [
          guildStub({ id: 'g1', memberCount: 1_200 }),
          guildStub({ id: 'g2', memberCount: 34 }),
        ],
        3,
        7
      );

      await showAdminSystemPanel(interaction, 'en', 'stats');

      const embed = embedAt(payloadOf<Payload>(harness.reply));
      expect(embed.title).toBe(t('admin.panel.statsTitle', 'en'));
      expect(embed.fields?.map((f) => [f.name, f.value])).toEqual([
        [t('admin.panel.serversLabel', 'en'), (2).toLocaleString()],
        [t('admin.panel.usersLabel', 'en'), (1_234).toLocaleString()],
        [t('admin.panel.channelsLabel', 'en'), (3).toLocaleString()],
        [t('admin.panel.uptimeLabel', 'en'), '1d 2h 3m'],
        [t('admin.panel.memoryLabel', 'en'), '50 MB'],
        [t('admin.panel.nodeLabel', 'en'), process.version],
        // Moved here from /general about: owner diagnostics, not member copy.
        [t('admin.panel.environmentLabel', 'en'), env.NODE_ENV],
        [t('admin.panel.commandsLabel', 'en'), (7).toLocaleString()],
      ]);
    });

    it('stats: reads a client without a command registry as zero commands', async () => {
      const { interaction, harness } = setup();
      delete (interaction.client as { commands?: unknown }).commands;

      await showAdminSystemPanel(interaction, 'en', 'stats');

      const embed = embedAt(payloadOf<Payload>(harness.reply));
      expect(
        embed.fields?.find(
          (f) => f.name === t('admin.panel.commandsLabel', 'en')
        )?.value
      ).toBe('0');
    });

    it('stats: spells the uptime out in Japanese', async () => {
      vi.spyOn(process, 'uptime').mockReturnValue(86_400 + 3_600 * 2 + 60 * 3);
      const { interaction, harness } = setup();

      await showAdminSystemPanel(interaction, 'ja', 'stats');

      const embed = embedAt(payloadOf<Payload>(harness.reply));
      expect(
        embed.fields?.find((f) => f.name === t('admin.panel.uptimeLabel', 'ja'))
          ?.value
      ).toBe('1日2時間3分');
    });

    it('db: lists the row count of each tracked table', async () => {
      insertAuditLogs(db, 3);
      db.prepare(
        'INSERT INTO guild_settings (guild_id, created_at, updated_at) VALUES (?, 0, 0)'
      ).run('g1');
      const { interaction, harness } = setup();

      await showAdminSystemPanel(interaction, 'en', 'db');

      const embed = embedAt(payloadOf<Payload>(harness.reply));
      expect(embed.title).toBe(t('admin.panel.dbTitle', 'en'));
      expect(embed.fields?.[0]?.value).toBe(
        [
          '`guild_settings`: 1',
          '`audit_logs`: 3',
          '`notification_channels`: 0',
          '`voice_sessions`: 0',
        ].join('\n')
      );
    });

    it('db: omits tables that cannot be counted and says so when none can', async () => {
      const spy = vi.spyOn(db, 'prepare').mockImplementation(() => {
        throw new Error('no such table');
      });
      const { interaction, harness } = setup();

      await showAdminSystemPanel(interaction, 'en', 'db');
      spy.mockRestore();

      expect(
        embedAt(payloadOf<Payload>(harness.reply)).fields?.[0]?.value
      ).toBe(t('common.noData', 'en'));
    });

    it('guilds: lists the 20 largest guilds, largest first', async () => {
      const guilds = Array.from({ length: 25 }, (_, i) =>
        guildStub({ id: `g${i}`, name: `Guild ${i}`, memberCount: i * 10 })
      );
      const { interaction, harness } = setup(guilds);

      await showAdminSystemPanel(interaction, 'en', 'guilds');

      const lines = embedAt(
        payloadOf<Payload>(harness.reply)
      ).description?.split('\n');
      expect(lines).toHaveLength(20);
      expect(lines?.[0]).toBe(`1. **Guild 24** (${(240).toLocaleString()})`);
      expect(lines?.[19]).toBe(`20. **Guild 5** (${(50).toLocaleString()})`);
    });

    /**
     * Regression: `Collection#sort` sorts in place (@discordjs/collection
     * clears and re-inserts the entries), and it was called on the live
     * `client.guilds.cache`, so opening the guilds tab permanently reordered
     * the client's guild cache, including the order a later
     * `/owner system broadcast` walks. The view now sorts a copy.
     */
    it('guilds: leaves the client guild cache in its original order', async () => {
      const { interaction } = setup([
        guildStub({ id: 'small', memberCount: 1 }),
        guildStub({ id: 'big', memberCount: 100 }),
        guildStub({ id: 'mid', memberCount: 50 }),
      ]);

      await showAdminSystemPanel(interaction, 'en', 'guilds');

      expect([...interaction.client.guilds.cache.keys()]).toEqual([
        'small',
        'big',
        'mid',
      ]);
    });

    it('guilds: shows an empty state when the bot is in no guild', async () => {
      const { interaction, harness } = setup([]);

      await showAdminSystemPanel(interaction, 'en', 'guilds');

      expect(embedAt(payloadOf<Payload>(harness.reply)).description).toBe(
        t('common.noData', 'en')
      );
    });

    it.each([
      ['healthy', COLORS.SUCCESS],
      ['degraded', COLORS.WARNING],
      ['unhealthy', COLORS.ERROR],
    ] as const)('health: colours a %s status', async (status, color) => {
      vi.mocked(getHealthStatus).mockReturnValue({
        status,
      } as ReturnType<typeof getHealthStatus>);
      const { interaction, harness } = setup();

      await showAdminSystemPanel(interaction, 'en', 'health');

      const embed = embedAt(payloadOf<Payload>(harness.reply));
      expect(embed.title).toBe(t('admin.panel.healthTitle', 'en'));
      expect(embed.description).toBe('formatted health');
      expect(embed.color).toBe(color);
      expect(getHealthStatus).toHaveBeenCalledWith(interaction.client);
      expect(formatHealthStatus).toHaveBeenCalledWith({ status });
    });

    it('metrics: shows the formatted metrics', async () => {
      const { interaction, harness } = setup();

      await showAdminSystemPanel(interaction, 'en', 'metrics');

      const embed = embedAt(payloadOf<Payload>(harness.reply));
      expect(embed.title).toBe(t('admin.panel.metricsTitle', 'en'));
      expect(embed.description).toBe('formatted metrics');
    });

    it('backups: lists backups with a hint about the run button', async () => {
      const { interaction, harness } = setup();

      await showAdminSystemPanel(interaction, 'ja', 'backups');

      const payload = payloadOf<Payload>(harness.reply);
      const embed = embedAt(payload);
      expect(embed.title).toBe(t('admin.panel.backupsTitle', 'ja'));
      expect(embed.description).toBe(BACKUP_LIST);
      expect(embed.footer?.text).toBe(t('admin.panel.backupsFooter', 'ja'));
      expect(activeTab(payload)).toBe('admin-panel:backups');
    });

    it('backups: says so in the viewer language when there are none', async () => {
      vi.mocked(backupService.listBackups).mockResolvedValue([]);
      const { interaction, harness } = setup();

      await showAdminSystemPanel(interaction, 'ja', 'backups');

      expect(embedAt(payloadOf<Payload>(harness.reply)).description).toBe(
        t('admin.panel.noBackups', 'ja')
      );
    });

    it('backups: lists the newest ten and counts the rest', async () => {
      vi.mocked(backupService.listBackups).mockResolvedValue(
        Array.from({ length: 13 }, (_, i) => ({
          filename: `b${i}.db`,
          size: 1_536_000,
          createdAt: new Date(1_700_000_000_000 + i * 1_000),
        }))
      );
      const { interaction, harness } = setup();

      await showAdminSystemPanel(interaction, 'en', 'backups');

      const lines = embedAt(
        payloadOf<Payload>(harness.reply)
      ).description!.split('\n');
      expect(lines).toHaveLength(11);
      expect(lines[0]).toBe('1. `b0.db` (1,500 KB) - <t:1700000000:f>');
      expect(lines[9]).toBe('10. `b9.db` (1,500 KB) - <t:1700000009:f>');
      expect(lines[10]).toBe(t('admin.panel.moreBackups', 'en', { count: 3 }));
    });
  });

  describe('buttons', () => {
    it.each(['stats', 'db', 'guilds', 'health', 'metrics', 'backups'] as const)(
      'switches to the %s tab',
      async (view) => {
        const { interaction, harness } = setup();
        await showAdminSystemPanel(
          interaction,
          'en',
          view === 'stats' ? 'db' : 'stats'
        );

        const button = componentStub('button', `admin-panel:${view}`);
        await harness.collect(button);

        const update = lastUpdate(button);
        expect(embedAt(update).title).toBe(
          t(`admin.panel.${view}Title` as const, 'en')
        );
        expect(activeTab(update)).toBe(`admin-panel:${view}`);
      }
    );

    it('re-renders the current tab for an unknown button', async () => {
      const { interaction, harness } = setup();
      await showAdminSystemPanel(interaction, 'en', 'metrics');

      const button = componentStub('button', 'admin-panel:bogus');
      await harness.collect(button);

      expect(embedAt(lastUpdate(button)).title).toBe(
        t('admin.panel.metricsTitle', 'en')
      );
    });

    it('runs a backup and shows the result above the list', async () => {
      vi.mocked(backupService.runBackup).mockResolvedValue({
        success: true,
        filename: 'backup-2026.db',
        size: 2_560,
        timestamp: new Date(0),
      });
      const { interaction, harness } = setup();
      await showAdminSystemPanel(interaction, 'en', 'stats');

      const run = componentStub('button', 'admin-panel:run-backup');
      await harness.collect(run);

      // Backups are slow: answer the click first with a visible "running"
      // state and every button off, so a second backup cannot be started.
      expect(run.update).toHaveBeenCalledTimes(1);
      expect(run.update.mock.invocationCallOrder[0]).toBeLessThan(
        vi.mocked(backupService.runBackup).mock.invocationCallOrder[0]!
      );
      const running = payloadOf<Payload>(run.update);
      expect(embedAt(running).description).toBe(
        t('owner.backup.running', 'en')
      );
      expect(
        rowsOf(running.components)
          .flat()
          .every((c) => c.disabled === true)
      ).toBe(true);
      // Then the original reply shows the result, buttons back on.
      const edited = payloadOf<Payload>(harness.editReply);
      expect(
        rowsOf(edited.components)
          .flat()
          .some((c) => c.disabled === true)
      ).toBe(false);
      expect(embedAt(edited).description).toBe(
        `${t('admin.panel.backupSuccess', 'en', {
          filename: 'backup-2026.db',
          size: '3',
        })}\n\n${BACKUP_LIST}`
      );
      expect(activeTab(edited)).toBe('admin-panel:backups');
    });

    it.each([
      ['with the reported error', 'disk full', 'disk full'],
      ['with a generic message when none is given', undefined, null],
    ])('reports a failed backup %s', async (_case, error, shown) => {
      vi.mocked(backupService.runBackup).mockResolvedValue({
        success: false,
        filename: '',
        size: 0,
        timestamp: new Date(0),
        error,
      });
      const { interaction, harness } = setup();
      await showAdminSystemPanel(interaction, 'en', 'backups');

      await harness.collect(componentStub('button', 'admin-panel:run-backup'));

      expect(embedAt(payloadOf<Payload>(harness.editReply)).description).toBe(
        `${t('admin.panel.backupFailure', 'en', {
          error: shown ?? t('owner.backup.noReason', 'en'),
        })}\n\n${BACKUP_LIST}`
      );
    });

    it('reports a backup that throws instead of leaving the buttons off', async () => {
      vi.mocked(backupService.runBackup).mockRejectedValue(
        new Error('EACCES: backup dir')
      );
      const { interaction, harness } = setup();
      await showAdminSystemPanel(interaction, 'en', 'backups');

      await harness.collect(componentStub('button', 'admin-panel:run-backup'));

      const edited = payloadOf<Payload>(harness.editReply);
      expect(embedAt(edited).description).toBe(
        `${t('admin.panel.backupFailure', 'en', {
          error: 'Error: EACCES: backup dir',
        })}\n\n${BACKUP_LIST}`
      );
      expect(
        rowsOf(edited.components)
          .flat()
          .every((c) => c.disabled !== true)
      ).toBe(true);
    });

    it('keeps the buttons off when the panel closed while the backup ran', async () => {
      vi.useFakeTimers();
      try {
        const { interaction, harness } = setup();
        vi.mocked(backupService.runBackup).mockImplementation(async () => {
          // Longer than the panel's idle timeout: its collector closes and
          // the panel says so before the backup finishes.
          vi.advanceTimersByTime(121_000);
          await harness.end();
          return {
            success: true,
            filename: 'slow.db',
            size: 1_024,
            timestamp: new Date(0),
          };
        });
        await showAdminSystemPanel(interaction, 'en', 'backups');

        await harness.collect(
          componentStub('button', 'admin-panel:run-backup')
        );

        // First the expiry edit, then the result: shown, but with nothing
        // listening any more, so no button may come back on.
        expect(harness.editReply).toHaveBeenCalledTimes(2);
        const result = payloadOf<Payload & { content?: string }>(
          harness.editReply,
          1
        );
        expect(embedAt(result).description).toContain('slow.db');
        expect(
          rowsOf(result.components)
            .flat()
            .every((c) => c.disabled === true)
        ).toBe(true);
        // The expiry notice stays: the result edit does not replace it.
        expect(result.content).toBeUndefined();
      } finally {
        vi.useRealTimers();
      }
    });

    it('turns the buttons back on for a backup that finishes while the panel is open', async () => {
      vi.useFakeTimers();
      try {
        const { interaction, harness } = setup();
        vi.mocked(backupService.runBackup).mockImplementation(async () => {
          vi.advanceTimersByTime(60_000);
          return {
            success: true,
            filename: 'b.db',
            size: 1_024,
            timestamp: new Date(0),
          };
        });
        await showAdminSystemPanel(interaction, 'en', 'backups');

        await harness.collect(
          componentStub('button', 'admin-panel:run-backup')
        );

        expect(
          rowsOf(payloadOf<Payload>(harness.editReply).components)
            .flat()
            .every((c) => c.disabled !== true)
        ).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it('keeps the last backup result until refresh clears it', async () => {
      vi.mocked(backupService.runBackup).mockResolvedValue({
        success: true,
        filename: 'b.db',
        size: 1_024,
        timestamp: new Date(0),
      });
      const { interaction, harness } = setup();
      await showAdminSystemPanel(interaction, 'en', 'backups');
      await harness.collect(componentStub('button', 'admin-panel:run-backup'));

      await harness.collect(componentStub('button', 'admin-panel:stats'));
      const back = componentStub('button', 'admin-panel:backups');
      await harness.collect(back);
      expect(embedAt(lastUpdate(back)).description).toContain('b.db');

      const refresh = componentStub('button', 'admin-panel:refresh');
      await harness.collect(refresh);
      expect(embedAt(lastUpdate(refresh)).description).toBe(BACKUP_LIST);
      expect(activeTab(lastUpdate(refresh))).toBe('admin-panel:backups');
    });
  });

  describe('formatUptime', () => {
    it.each([
      [0, 'en', '0m'],
      [59, 'ja', '1分未満'],
      [3 * 3_600 + 4 * 60, 'en', '3h 4m'],
      [2 * 86_400, 'en', '2d'],
      [2 * 86_400 + 30, 'ja', '2日'],
      [2 * 86_400 + 5 * 60, 'ja', '2日5分'],
      [30 * 86_400 + 3_600, 'en', '30d 1h'],
    ] as const)('formats %ss in %s as %s', (seconds, locale, expected) => {
      expect(formatUptime(seconds, locale)).toBe(expected);
    });
  });

  it('disables every button when the panel expires', async () => {
    const { interaction, harness } = setup();
    await showAdminSystemPanel(interaction, 'en', 'health');

    await harness.end();

    const rows = rowsOf(payloadOf<Payload>(harness.editReply).components);
    expect(rows.flat()).toHaveLength(8);
    expect(rows.flat().every((c) => c.disabled === true)).toBe(true);
  });
});
