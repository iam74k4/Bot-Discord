import Database from 'better-sqlite3';
import { ButtonStyle, ChannelType, MessageFlags } from 'discord.js';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { COLORS } from '../../../shared/utils/constants/index.js';
import { t } from '../../../locales/index.js';
import {
  GUILD_ID,
  USER_ID,
  clearNotificationTables,
  createCommandInteraction,
  createComponentInteraction,
  createGuild,
  createTextChannel,
  customIdsOf,
  embedOf,
  insertDailyStat,
  lastCallArg,
  migrateNotificationSchema,
  rowsOf,
  type FakeCommandOptions,
} from './notification.helpers.js';

/**
 * `/notification status` and `/notification stats` share one panel: a stats
 * view anyone may open and a settings view for Manage Server holders. The
 * panel reads and writes the real tables (in-memory SQLite) and runs on the
 * real `runComponentPanel`, driven through a fake component collector.
 */
const db = new Database(':memory:');

vi.mock('../../../infrastructure/database/connection.js', () => ({
  database: db,
}));

const loggerWarn = vi.hoisted(() => vi.fn());

vi.mock('../../../shared/utils/logger.js', () => ({
  logger: { error: vi.fn(), warn: loggerWarn, info: vi.fn(), debug: vi.fn() },
  getErrorMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)),
}));

// The audit log posts to Discord. The panel does not import it yet (see the
// "audit trail" block); the mock is here so that test can see the fix land.
const notifySetup = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const notifyRemove = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock('../../../infrastructure/audit/index.js', () => ({
  audit: { notifySetup, notifyRemove },
}));

const { showNotificationPanel } = await import('../application/panel.js');
const { notificationChannelRepository } =
  await import('../repositories/notificationChannelRepository.js');
const { dayKey } = await import('../repositories/voiceSessionRepository.js');

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
// Mid-July: no DST transition in the 31 days before it in any common zone,
// so "N days ago" and "N calendar days ago" agree.
const NOW = new Date(2026, 6, 15, 12, 0, 0).getTime();

const STATS_ROW = ['notification-panel:stats'];
const MANAGER_NAV_ROW = [
  'notification-panel:stats',
  'notification-panel:status',
];
const SETTINGS_ROWS = [
  MANAGER_NAV_ROW,
  ['notification-panel:voice:channel'],
  ['notification-panel:member_join:channel'],
  ['notification-panel:voice:remove', 'notification-panel:member_join:remove'],
];

function field(embed: ReturnType<typeof embedOf>, name: string) {
  return embed.fields?.find((f) => f.name === name)?.value;
}

async function openPanel(
  commandOptions: FakeCommandOptions,
  panelOptions?: Parameters<typeof showNotificationPanel>[2],
  locale: 'en' | 'ja' = 'en'
) {
  const command = createCommandInteraction(commandOptions);
  await showNotificationPanel(command.interaction, locale, panelOptions);
  return command;
}

describe('showNotificationPanel', () => {
  beforeAll(async () => {
    await migrateNotificationSchema();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    clearNotificationTables(db);
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  afterAll(() => {
    db.close();
  });

  it('refuses to open outside a guild', async () => {
    const command = await openPanel({ guild: null });

    expect(command.reply).toHaveBeenCalledTimes(1);
    const payload = lastCallArg(command.reply) as { flags: number };
    expect(payload.flags).toBe(MessageFlags.Ephemeral);
    const embed = embedOf(payload);
    expect(embed.title).toBe(t('common.error', 'en'));
    expect(embed.description).toBe(t('common.guildOnly', 'en'));
    expect(command.createMessageComponentCollector).not.toHaveBeenCalled();
  });

  describe('stats view', () => {
    it('opens on all-time stats by default as an ephemeral panel', async () => {
      const command = await openPanel({});

      const payload = lastCallArg(command.reply) as {
        flags: number;
        withResponse: boolean;
      };
      expect(payload.flags).toBe(MessageFlags.Ephemeral);
      expect(payload.withResponse).toBe(true);

      const embed = embedOf(payload);
      expect(embed.title).toBe(t('notification.stats.title', 'en'));
      expect(field(embed, t('notification.stats.period', 'en'))).toBe(
        t('notification.stats.periods.all', 'en')
      );
      expect(command.createMessageComponentCollector).toHaveBeenCalledWith({
        time: 120_000,
      });
    });

    it('shows an empty state with only the period when there is no data', async () => {
      const command = await openPanel({}, { initialPeriod: 'week' });

      const embed = embedOf(lastCallArg(command.reply));
      expect(embed.description).toBe(t('notification.stats.noData', 'en'));
      expect(embed.color).toBe(COLORS.INFO);
      expect(embed.fields).toEqual([
        {
          name: t('notification.stats.period', 'en'),
          value: t('notification.stats.periods.week', 'en'),
          inline: true,
        },
      ]);
    });

    it('lists channels by time spent and totals them', async () => {
      insertDailyStat(db, {
        day: dayKey(NOW),
        channelId: 'vc-a',
        channelName: 'Lounge',
        durationMs: 45 * MINUTE,
      });
      insertDailyStat(db, {
        day: dayKey(NOW - DAY),
        channelId: 'vc-b',
        channelName: 'Gaming',
        durationMs: 65 * MINUTE,
      });

      const command = await openPanel({});

      const embed = embedOf(lastCallArg(command.reply));
      expect(embed.description?.split('\n')).toEqual([
        '🔊 **Gaming** — 1h 5m',
        '🔊 **Lounge** — 45m',
      ]);
      expect(field(embed, t('notification.stats.total', 'en'))).toBe('1h 50m');
    });

    it('rounds partial minutes down and keeps a zero minute part after hours', async () => {
      insertDailyStat(db, {
        day: dayKey(NOW),
        channelId: 'vc-a',
        channelName: 'Short',
        durationMs: 60 * MINUTE - 1,
      });
      insertDailyStat(db, {
        day: dayKey(NOW),
        channelId: 'vc-b',
        channelName: 'Exact',
        durationMs: 60 * MINUTE,
      });

      const command = await openPanel({});

      const embed = embedOf(lastCallArg(command.reply));
      expect(embed.description?.split('\n')).toEqual([
        '🔊 **Exact** — 1h 0m',
        '🔊 **Short** — 59m',
      ]);
      expect(field(embed, t('notification.stats.total', 'en'))).toBe('1h 59m');
    });

    it("counts only the invoking user's time in this guild", async () => {
      insertDailyStat(db, { day: dayKey(NOW), durationMs: 10 * MINUTE });
      insertDailyStat(db, {
        day: dayKey(NOW),
        userId: 'someone-else',
        durationMs: 99 * MINUTE,
      });
      insertDailyStat(db, {
        day: dayKey(NOW),
        guildId: 'other-guild',
        durationMs: 99 * MINUTE,
      });

      const command = await openPanel({});

      const embed = embedOf(lastCallArg(command.reply));
      expect(field(embed, t('notification.stats.total', 'en'))).toBe('10m');
    });

    describe('period cutoffs', () => {
      beforeEach(() => {
        // Each row lands in a different channel so its presence is visible.
        const rows: Array<[string, number, number]> = [
          ['today', 0, 10],
          ['yesterday', 1, 5],
          ['7-days', 7, 20],
          ['8-days', 8, 40],
          ['30-days', 30, 80],
          ['31-days', 31, 160],
        ];
        for (const [name, daysAgo, minutes] of rows) {
          insertDailyStat(db, {
            day: dayKey(NOW - daysAgo * DAY),
            channelId: name,
            channelName: name,
            durationMs: minutes * MINUTE,
          });
        }
      });

      it.each([
        ['today', '10m', ['today']],
        ['week', '35m', ['7-days', 'today', 'yesterday']],
        [
          'month',
          '2h 35m',
          ['30-days', '8-days', '7-days', 'today', 'yesterday'],
        ],
        [
          'all',
          '5h 15m',
          ['31-days', '30-days', '8-days', '7-days', 'today', 'yesterday'],
        ],
      ] as const)(
        '%s covers only the days inside its window',
        async (period, total, channels) => {
          const command = await openPanel({}, { initialPeriod: period });

          const embed = embedOf(lastCallArg(command.reply));
          expect(field(embed, t('notification.stats.total', 'en'))).toBe(total);
          expect(field(embed, t('notification.stats.period', 'en'))).toBe(
            t(`notification.stats.periods.${period}`, 'en')
          );
          const listed = embed.description
            ?.split('\n')
            .map((line) => /\*\*(.+)\*\*/.exec(line)?.[1]);
          expect(listed).toEqual(channels);
        }
      );

      it('switches period from the select menu and marks it as selected', async () => {
        const command = await openPanel({});
        const select = createComponentInteraction(
          'stringSelect',
          'notification-panel:stats-period',
          { values: ['today'] }
        );

        await command.collect(select.interaction);

        expect(select.update).toHaveBeenCalledTimes(1);
        const payload = lastCallArg(select.update);
        expect(
          field(embedOf(payload), t('notification.stats.total', 'en'))
        ).toBe('10m');
        const periodMenu = rowsOf(payload)[1][0];
        expect(
          periodMenu.options?.filter((o) => o.default).map((o) => o.value)
        ).toEqual(['today']);
      });
    });

    it('offers the four periods in a select menu with the current one marked', async () => {
      const command = await openPanel({}, { initialPeriod: 'month' });

      const periodMenu = rowsOf(lastCallArg(command.reply))[1][0];
      expect(periodMenu.custom_id).toBe('notification-panel:stats-period');
      expect(periodMenu.placeholder).toBe(
        t('notification.panel.periodPlaceholder', 'en')
      );
      expect(periodMenu.options?.map((o) => [o.value, !!o.default])).toEqual([
        ['today', false],
        ['week', false],
        ['month', true],
        ['all', false],
      ]);
    });

    it('renders in the requested locale', async () => {
      const command = await openPanel({}, undefined, 'ja');

      const embed = embedOf(lastCallArg(command.reply));
      expect(embed.title).toBe(t('notification.stats.title', 'ja'));
      expect(rowsOf(lastCallArg(command.reply))[0][0].label).toBe(
        t('notification.panel.statsTab', 'ja')
      );
    });
  });

  describe('for members without Manage Server', () => {
    it('shows only the stats tab and the period menu', async () => {
      const command = await openPanel({ manageGuild: false });

      const payload = lastCallArg(command.reply);
      expect(customIdsOf(payload)).toEqual([
        STATS_ROW,
        ['notification-panel:stats-period'],
      ]);
      expect(rowsOf(payload)[0][0].style).toBe(ButtonStyle.Primary);
    });

    it('falls back to stats when the settings view is requested', async () => {
      notificationChannelRepository.set(GUILD_ID, 'voice', 'vc-log');

      const command = await openPanel(
        { manageGuild: false },
        { initialView: 'status' }
      );

      const embed = embedOf(lastCallArg(command.reply));
      expect(embed.title).toBe(t('notification.stats.title', 'en'));
    });

    it.each([
      ['button', 'notification-panel:status'],
      ['button', 'notification-panel:voice:remove'],
      ['button', 'notification-panel:member_join:remove'],
    ] as const)(
      'ignores a forged %s %s and keeps the configuration',
      async (kind, customId) => {
        notificationChannelRepository.set(GUILD_ID, 'voice', 'vc-log');
        notificationChannelRepository.set(GUILD_ID, 'member_join', 'welcome');
        const command = await openPanel({ manageGuild: false });
        const component = createComponentInteraction(kind, customId);

        await command.collect(component.interaction);

        expect(embedOf(lastCallArg(component.update)).title).toBe(
          t('notification.stats.title', 'en')
        );
        expect(
          notificationChannelRepository.getAllForGuild(GUILD_ID)
        ).toHaveLength(2);
      }
    );

    it('ignores a forged channel select without writing anything', async () => {
      const channel = createTextChannel('new-chan');
      const command = await openPanel({
        manageGuild: false,
        guild: createGuild({ cached: [channel] }),
      });
      const select = createComponentInteraction(
        'channelSelect',
        'notification-panel:voice:channel',
        { values: ['new-chan'] }
      );

      await command.collect(select.interaction);

      expect(notificationChannelRepository.get(GUILD_ID, 'voice')).toBeNull();
      expect(embedOf(lastCallArg(select.update)).title).toBe(
        t('notification.stats.title', 'en')
      );
    });
  });

  describe('settings view', () => {
    it('opens on stats for managers unless the settings view is requested', async () => {
      const command = await openPanel({ manageGuild: true });

      const payload = lastCallArg(command.reply);
      expect(embedOf(payload).title).toBe(t('notification.stats.title', 'en'));
      expect(customIdsOf(payload)).toEqual([
        MANAGER_NAV_ROW,
        ['notification-panel:stats-period'],
      ]);
    });

    it('shows both notification types as not configured on a fresh guild', async () => {
      const command = await openPanel(
        { manageGuild: true },
        { initialView: 'status' }
      );

      const payload = lastCallArg(command.reply);
      const embed = embedOf(payload);
      expect(embed.title).toBe(t('notification.status.title', 'en'));
      expect(embed.description).toBe(
        t('notification.panel.statusDescription', 'en')
      );
      expect(embed.fields).toEqual([
        {
          name: t('notification.status.voiceLabel', 'en'),
          value: t('notification.status.disabled', 'en'),
          inline: true,
        },
        {
          name: t('notification.status.welcomeLabel', 'en'),
          value: t('notification.status.disabled', 'en'),
          inline: true,
        },
      ]);

      expect(customIdsOf(payload)).toEqual(SETTINGS_ROWS);
      const rows = rowsOf(payload);
      expect(rows[0].map((b) => b.style)).toEqual([
        ButtonStyle.Secondary,
        ButtonStyle.Primary,
      ]);
      // Nothing to remove yet.
      expect(rows[3].map((b) => b.disabled)).toEqual([true, true]);
    });

    it('limits both channel pickers to a single text channel', async () => {
      const command = await openPanel(
        { manageGuild: true },
        { initialView: 'status' }
      );

      const rows = rowsOf(lastCallArg(command.reply));
      const [voicePicker] = rows[1];
      const [welcomePicker] = rows[2];
      for (const picker of [voicePicker, welcomePicker]) {
        expect(picker.channel_types).toEqual([ChannelType.GuildText]);
      }
      expect(voicePicker.placeholder).toBe(
        t('notification.panel.voicePlaceholder', 'en')
      );
      expect(welcomePicker.placeholder).toBe(
        t('notification.panel.welcomePlaceholder', 'en')
      );
    });

    it('shows configured channels and enables only the matching remove button', async () => {
      notificationChannelRepository.set(GUILD_ID, 'voice', 'vc-log');

      const command = await openPanel(
        { manageGuild: true },
        { initialView: 'status' }
      );

      const payload = lastCallArg(command.reply);
      expect(embedOf(payload).fields?.map((f) => f.value)).toEqual([
        '<#vc-log>',
        t('notification.status.disabled', 'en'),
      ]);
      expect(rowsOf(payload)[3].map((b) => b.disabled)).toEqual([false, true]);
    });

    it('reports a stored but switched-off configuration as not configured', async () => {
      notificationChannelRepository.set(GUILD_ID, 'member_join', 'welcome');
      db.prepare('UPDATE notification_channels SET enabled = 0').run();

      const command = await openPanel(
        { manageGuild: true },
        { initialView: 'status' }
      );

      expect(embedOf(lastCallArg(command.reply)).fields?.[1].value).toBe(
        t('notification.status.disabled', 'en')
      );
    });

    it('navigates between the stats and settings tabs', async () => {
      const command = await openPanel(
        { manageGuild: true },
        { initialView: 'status' }
      );

      const toStats = createComponentInteraction(
        'button',
        'notification-panel:stats'
      );
      await command.collect(toStats.interaction);
      const statsPayload = lastCallArg(toStats.update);
      expect(embedOf(statsPayload).title).toBe(
        t('notification.stats.title', 'en')
      );
      expect(rowsOf(statsPayload)[0].map((b) => b.style)).toEqual([
        ButtonStyle.Primary,
        ButtonStyle.Secondary,
      ]);

      const toStatus = createComponentInteraction(
        'button',
        'notification-panel:status'
      );
      await command.collect(toStatus.interaction);
      expect(customIdsOf(lastCallArg(toStatus.update))).toEqual(SETTINGS_ROWS);
      expect(embedOf(lastCallArg(toStatus.update)).title).toBe(
        t('notification.status.title', 'en')
      );
    });

    it('returns to stats when a period is picked', async () => {
      const command = await openPanel(
        { manageGuild: true },
        { initialView: 'status' }
      );
      const select = createComponentInteraction(
        'stringSelect',
        'notification-panel:stats-period',
        { values: ['week'] }
      );

      await command.collect(select.interaction);

      const embed = embedOf(lastCallArg(select.update));
      expect(embed.title).toBe(t('notification.stats.title', 'en'));
      expect(field(embed, t('notification.stats.period', 'en'))).toBe(
        t('notification.stats.periods.week', 'en')
      );
    });

    it.each([
      ['voice', 'notification-panel:voice:channel', 0],
      ['member_join', 'notification-panel:member_join:channel', 1],
    ] as const)(
      'saves the %s channel picked from the menu',
      async (type, customId, fieldIndex) => {
        const channel = createTextChannel('new-chan');
        const command = await openPanel(
          { manageGuild: true, guild: createGuild({ cached: [channel] }) },
          { initialView: 'status' }
        );
        const select = createComponentInteraction('channelSelect', customId, {
          values: ['new-chan'],
        });

        await command.collect(select.interaction);

        expect(notificationChannelRepository.getEnabled(GUILD_ID, type)).toBe(
          'new-chan'
        );
        const payload = lastCallArg(select.update);
        expect(embedOf(payload).fields?.[fieldIndex].value).toBe('<#new-chan>');
        expect(customIdsOf(payload)).toEqual(SETTINGS_ROWS);
      }
    );

    it('switches to settings after picking a channel from the stats tab', async () => {
      const channel = createTextChannel('new-chan');
      const command = await openPanel({
        manageGuild: true,
        guild: createGuild({ cached: [channel] }),
      });
      const select = createComponentInteraction(
        'channelSelect',
        'notification-panel:voice:channel',
        { values: ['new-chan'] }
      );

      await command.collect(select.interaction);

      expect(embedOf(lastCallArg(select.update)).title).toBe(
        t('notification.status.title', 'en')
      );
    });

    it.each([
      [
        'the bot cannot send there',
        () => [createTextChannel('new-chan', { canSend: false })],
      ],
      ['the channel is gone', () => []],
    ])(
      'rejects a picked channel when %s and keeps the panel as it was',
      async (_reason, cachedChannels) => {
        notificationChannelRepository.set(GUILD_ID, 'voice', 'vc-log');
        const command = await openPanel(
          {
            manageGuild: true,
            guild: createGuild({ cached: cachedChannels() }),
          },
          { initialView: 'status' }
        );
        const select = createComponentInteraction(
          'channelSelect',
          'notification-panel:voice:channel',
          { values: ['new-chan'] }
        );

        await command.collect(select.interaction);

        expect(select.update).not.toHaveBeenCalled();
        expect(select.reply).toHaveBeenCalledTimes(1);
        const payload = lastCallArg(select.reply) as { flags: number };
        expect(payload.flags).toBe(MessageFlags.Ephemeral);
        expect(embedOf(payload).description).toBe(
          t('notification.errors.channelNotSendable', 'en')
        );
        expect(
          notificationChannelRepository.getEnabled(GUILD_ID, 'voice')
        ).toBe('vc-log');
      }
    );

    it.each([
      ['voice', 'notification-panel:voice:remove', [true, false]],
      ['member_join', 'notification-panel:member_join:remove', [false, true]],
    ] as const)(
      'removes the %s configuration from its button',
      async (type, customId, disabledAfter) => {
        notificationChannelRepository.set(GUILD_ID, 'voice', 'vc-log');
        notificationChannelRepository.set(GUILD_ID, 'member_join', 'welcome');
        const command = await openPanel(
          { manageGuild: true },
          { initialView: 'status' }
        );
        const button = createComponentInteraction('button', customId);

        await command.collect(button.interaction);

        expect(notificationChannelRepository.get(GUILD_ID, type)).toBeNull();
        expect(
          notificationChannelRepository.getAllForGuild(GUILD_ID)
        ).toHaveLength(1);
        const payload = lastCallArg(button.update);
        expect(embedOf(payload).title).toBe(
          t('notification.status.title', 'en')
        );
        expect(rowsOf(payload)[3].map((b) => b.disabled)).toEqual(
          disabledAfter
        );
      }
    );

    it.each([
      ['voice', 'notification-panel:voice:remove', 'member_join', 'welcome'],
      [
        'member_join',
        'notification-panel:member_join:remove',
        'voice',
        'vc-log',
      ],
    ] as const)(
      'just re-renders settings when %s is removed but was never configured',
      async (type, customId, otherType, otherChannel) => {
        // The button is rendered disabled here; a stale or forged click still
        // reaches the collector and must not touch the other configuration.
        notificationChannelRepository.set(GUILD_ID, otherType, otherChannel);
        const command = await openPanel(
          { manageGuild: true },
          { initialView: 'status' }
        );
        const button = createComponentInteraction('button', customId);

        await command.collect(button.interaction);

        expect(button.reply).not.toHaveBeenCalled();
        expect(button.deferUpdate).not.toHaveBeenCalled();
        expect(loggerWarn).not.toHaveBeenCalled();
        expect(button.update).toHaveBeenCalledTimes(1);
        const payload = lastCallArg(button.update);
        expect(embedOf(payload).title).toBe(
          t('notification.status.title', 'en')
        );
        expect(customIdsOf(payload)).toEqual(SETTINGS_ROWS);
        expect(notificationChannelRepository.get(GUILD_ID, type)).toBeNull();
        expect(
          notificationChannelRepository.getEnabled(GUILD_ID, otherType)
        ).toBe(otherChannel);
        // Nothing changed, so nothing belongs in the audit log either.
        expect(notifyRemove).not.toHaveBeenCalled();
      }
    );
  });

  /**
   * KNOWN BUG (panel.ts onComponent): the remove buttons and the channel
   * pickers write to `notification_channels` without calling
   * `audit.notifySetup` / `audit.notifyRemove`, while `/notification voice|
   * welcome set|disable` audit the very same change. A Manage Server holder
   * can therefore retarget or switch off notifications from the panel with no
   * NOTIFY_SETUP / NOTIFY_REMOVE entry. These document the expected behaviour;
   * drop `.fails` once the panel audits (removals only when something was
   * actually removed, matching the slash handlers).
   */
  describe('audit trail', () => {
    it.fails.each([
      ['voice', 'notification-panel:voice:channel', 'Voice'],
      ['member_join', 'notification-panel:member_join:channel', 'Welcome'],
    ] as const)(
      'records who pointed %s notifications at a channel from the picker',
      async (_type, customId, auditKind) => {
        const command = await openPanel(
          {
            manageGuild: true,
            guild: createGuild({ cached: [createTextChannel('new-chan')] }),
          },
          { initialView: 'status' }
        );

        await command.collect(
          createComponentInteraction('channelSelect', customId, {
            values: ['new-chan'],
          }).interaction
        );

        expect(notifySetup).toHaveBeenCalledWith(
          expect.anything(),
          GUILD_ID,
          USER_ID,
          'new-chan',
          auditKind
        );
      }
    );

    it.fails.each([
      ['voice', 'notification-panel:voice:remove', 'Voice'],
      ['member_join', 'notification-panel:member_join:remove', 'Welcome'],
    ] as const)(
      'records who switched off %s notifications from the remove button',
      async (type, customId, auditKind) => {
        notificationChannelRepository.set(GUILD_ID, type, 'configured');
        const command = await openPanel(
          { manageGuild: true },
          { initialView: 'status' }
        );

        await command.collect(
          createComponentInteraction('button', customId).interaction
        );

        expect(notifyRemove).toHaveBeenCalledWith(
          expect.anything(),
          GUILD_ID,
          USER_ID,
          auditKind
        );
      }
    );
  });

  describe('lifecycle', () => {
    it('ignores clicks from anyone but the user who opened it', async () => {
      notificationChannelRepository.set(GUILD_ID, 'voice', 'vc-log');
      const command = await openPanel(
        { manageGuild: true },
        { initialView: 'status' }
      );
      const intruder = createComponentInteraction(
        'button',
        'notification-panel:voice:remove',
        { userId: 'intruder' }
      );

      await command.collect(intruder.interaction);

      expect(intruder.update).not.toHaveBeenCalled();
      expect(intruder.reply).toHaveBeenCalledWith({
        content: t('help.onlyCommandUser', 'en'),
        flags: MessageFlags.Ephemeral,
      });
      expect(notificationChannelRepository.getEnabled(GUILD_ID, 'voice')).toBe(
        'vc-log'
      );
    });

    it('disables every component of the current view when it expires', async () => {
      notificationChannelRepository.set(GUILD_ID, 'voice', 'vc-log');
      const command = await openPanel(
        { manageGuild: true },
        { initialView: 'status' }
      );

      await command.end();

      expect(command.editReply).toHaveBeenCalledTimes(1);
      const payload = lastCallArg(command.editReply);
      expect(customIdsOf(payload)).toEqual(SETTINGS_ROWS);
      expect(
        rowsOf(payload)
          .flat()
          .every((c) => c.disabled === true)
      ).toBe(true);
    });

    it('expires on the view the user last switched to', async () => {
      const command = await openPanel(
        { manageGuild: true },
        { initialView: 'status' }
      );
      const select = createComponentInteraction(
        'stringSelect',
        'notification-panel:stats-period',
        { values: ['today'] }
      );
      await command.collect(select.interaction);

      await command.end();

      const payload = lastCallArg(command.editReply);
      expect(customIdsOf(payload)).toEqual([
        MANAGER_NAV_ROW,
        ['notification-panel:stats-period'],
      ]);
      const periodMenu = rowsOf(payload)[1][0];
      expect(periodMenu.disabled).toBe(true);
      expect(periodMenu.options?.find((o) => o.default)?.value).toBe('today');
    });

    it('acknowledges the click and logs when Discord rejects the update', async () => {
      const command = await openPanel({ manageGuild: true });
      const button = createComponentInteraction(
        'button',
        'notification-panel:status'
      );
      button.update.mockRejectedValueOnce(new Error('Unknown interaction'));

      await command.collect(button.interaction);

      expect(button.deferUpdate).toHaveBeenCalledTimes(1);
      expect(loggerWarn).toHaveBeenCalledWith(
        expect.stringContaining('Unknown interaction')
      );
    });
  });
});
