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
    formatBackupList: vi.fn(),
    runBackup: vi.fn(),
  },
}));

const { showAdminSystemPanel } = await import('../application/systemPanel.js');
const { t } = await import('../../../locales/index.js');
const { COLORS } = await import('../../../shared/utils/constants/index.js');
const { getHealthStatus, formatHealthStatus } =
  await import('../../../infrastructure/health/index.js');
const { backupService } =
  await import('../../../infrastructure/backup/index.js');

const BACKUP_LIST = '`backup-1.db` 12 KB';

function setup(guilds: Guild[] = [], channelCount = 0) {
  const harness = createPanelHarness();
  const client = clientStub(guilds);
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
    vi.mocked(backupService.formatBackupList).mockResolvedValue(BACKUP_LIST);
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
    ).toHaveBeenCalledWith({ time: 120_000 });
  });

  describe('views', () => {
    it('stats: totals guilds, members, channels, uptime and memory', async () => {
      vi.spyOn(process, 'uptime').mockReturnValue(86_400 + 3_600 * 2 + 60 * 3);
      vi.spyOn(process, 'memoryUsage').mockReturnValue({
        heapUsed: 50 * 1024 * 1024,
      } as NodeJS.MemoryUsage);
      const { interaction, harness } = setup(
        [
          guildStub({ id: 'g1', memberCount: 1_200 }),
          guildStub({ id: 'g2', memberCount: 34 }),
        ],
        3
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
      ]);
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

      // Backups are slow: acknowledge first, then edit the original reply.
      expect(run.deferUpdate).toHaveBeenCalledTimes(1);
      expect(run.deferUpdate.mock.invocationCallOrder[0]).toBeLessThan(
        vi.mocked(backupService.runBackup).mock.invocationCallOrder[0]!
      );
      expect(run.update).not.toHaveBeenCalled();
      const edited = payloadOf<Payload>(harness.editReply);
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
          error: shown ?? t('common.unexpectedError', 'en'),
        })}\n\n${BACKUP_LIST}`
      );
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

  it('disables every button when the panel expires', async () => {
    const { interaction, harness } = setup();
    await showAdminSystemPanel(interaction, 'en', 'health');

    await harness.end();

    const rows = rowsOf(payloadOf<Payload>(harness.editReply).components);
    expect(rows.flat()).toHaveLength(8);
    expect(rows.flat().every((c) => c.disabled === true)).toBe(true);
  });
});
