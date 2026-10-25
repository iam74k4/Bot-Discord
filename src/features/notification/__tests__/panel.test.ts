import Database from 'better-sqlite3';
import {
  ButtonStyle,
  ChannelType,
  MessageFlags,
  PermissionFlagsBits,
} from 'discord.js';
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
import { commandMention } from '../../../shared/utils/commandMentions.js';
import { formatPermissionNames } from '../../../shared/utils/discord.js';
import {
  GUILD_ID,
  POSTING_PERMISSIONS,
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

// The audit log posts to Discord; the panel's writes must reach it.
const notifySetup = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const notifyRemove = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock('../../../infrastructure/audit/index.js', () => ({
  audit: { notifySetup, notifyRemove },
}));

const { showNotificationPanel } = await import('../application/panel.js');
const { notificationChannelRepository } =
  await import('../repositories/notificationChannelRepository.js');
const { dayKey } = await import('../repositories/voiceSessionRepository.js');
const { voiceTracker } = await import('../tracking/voiceTracker.js');
const { setStatsTimeZone, DEFAULT_STATS_TIME_ZONE } =
  await import('../stats/calendar.js');

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
// 12:00 in Japan (the stats zone), whatever zone the test process runs in.
const NOW = Date.UTC(2026, 6, 15, 3, 0, 0);
// 00:00 on 2026-07-15 in Japan.
const JST_MIDNIGHT = Date.UTC(2026, 6, 14, 15, 0, 0);

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

/** Channel names in the order the stats view lists them. */
function listedChannels(embed: ReturnType<typeof embedOf>) {
  return embed.description
    ?.split('\n')
    .map((line) => /\*\*(.+)\*\*/.exec(line)?.[1])
    .filter((name) => name !== undefined);
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
    // Forget any visit a previous test left open, without rolling it up.
    voiceTracker.closeAllStaleSessions();
    setStatsTimeZone(DEFAULT_STATS_TIME_ZONE);
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  afterAll(() => {
    setStatsTimeZone(DEFAULT_STATS_TIME_ZONE);
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
        idle: 120_000,
        time: 14 * 60_000,
      });
    });

    it('shows an empty state naming the period when there is no data', async () => {
      const command = await openPanel({}, { initialPeriod: 'week' });

      const embed = embedOf(lastCallArg(command.reply));
      expect(embed.description).toBe(
        t('notification.stats.noData', 'en', {
          period: t('notification.stats.periods.week', 'en'),
        })
      );
      expect(embed.color).toBe(COLORS.INFO);
      expect(embed.fields).toEqual([
        {
          name: t('notification.stats.period', 'en'),
          value: t('notification.stats.periods.week', 'en'),
          inline: true,
        },
      ]);
    });

    it('points at all time when only older history exists', async () => {
      insertDailyStat(db, { day: dayKey(NOW - 40 * DAY), durationMs: HOUR });

      const command = await openPanel({}, { initialPeriod: 'month' });

      const embed = embedOf(lastCallArg(command.reply));
      expect(embed.description).toBe(
        `${t('notification.stats.noData', 'en', {
          period: t('notification.stats.periods.month', 'en'),
        })}\n\n${t('notification.stats.noDataInPeriodHint', 'en', {
          all: t('notification.stats.periods.all', 'en'),
        })}`
      );
    });

    it('lists channels by time spent with visit counts and totals them', async () => {
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
        sessions: 3,
      });

      const command = await openPanel({});

      const embed = embedOf(lastCallArg(command.reply));
      expect(embed.description?.split('\n')).toEqual([
        '🥇 **Gaming** — 1h 5m (3x)',
        '🥈 **Lounge** — 45m (1x)',
      ]);
      expect(field(embed, t('notification.stats.total', 'en'))).toBe('1h 50m');
    });

    it('writes durations in Japanese for a Japanese reader', async () => {
      insertDailyStat(db, {
        day: dayKey(NOW),
        channelName: 'ざつだん',
        durationMs: 65 * MINUTE,
        sessions: 2,
      });

      const command = await openPanel({}, undefined, 'ja');

      const embed = embedOf(lastCallArg(command.reply));
      expect(embed.description).toBe('🥇 **ざつだん** — 1時間5分（2回）');
      expect(field(embed, t('notification.stats.total', 'ja'))).toBe(
        '1時間5分'
      );
    });

    it('rounds partial minutes down and drops a zero minute part', async () => {
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
      insertDailyStat(db, {
        day: dayKey(NOW),
        channelId: 'vc-c',
        channelName: 'Blip',
        durationMs: 40_000,
      });

      const command = await openPanel({});

      const embed = embedOf(lastCallArg(command.reply));
      expect(embed.description?.split('\n')).toEqual([
        '🥇 **Exact** — 1h (1x)',
        '🥈 **Short** — 59m (1x)',
        // A visit under a minute is not "0m".
        '🥉 **Blip** — <1m (1x)',
      ]);
      expect(field(embed, t('notification.stats.total', 'en'))).toBe('2h');
    });

    it('lists ten channels and sums up the rest in one line', async () => {
      for (let i = 1; i <= 12; i++) {
        insertDailyStat(db, {
          day: dayKey(NOW),
          channelId: `vc-${i}`,
          channelName: `ch${i}`,
          durationMs: i * MINUTE,
        });
      }

      const command = await openPanel({});

      const embed = embedOf(lastCallArg(command.reply));
      const lines = embed.description!.split('\n');
      expect(lines).toHaveLength(11);
      expect(lines[3]).toBe('4. **ch9** — 9m (1x)');
      expect(lines[10]).toBe(t('notification.stats.more', 'en', { count: 2 }));
      // The total still counts the channels that were not listed.
      expect(field(embed, t('notification.stats.total', 'en'))).toBe('1h 18m');
    });

    it('escapes markdown in channel names', async () => {
      insertDailyStat(db, {
        day: dayKey(NOW),
        channelName: '*vip*_room',
        durationMs: 5 * MINUTE,
      });

      const command = await openPanel({});

      expect(embedOf(lastCallArg(command.reply)).description).toBe(
        '🥇 **\\*vip\\*\\_room** — 5m (1x)'
      );
    });

    it('shows the name a channel has now when the bot can see it', async () => {
      insertDailyStat(db, {
        day: dayKey(NOW),
        channelId: 'vc-a',
        channelName: 'Old name',
        durationMs: 5 * MINUTE,
      });
      const renamed = createTextChannel('vc-a', { name: 'New name' });

      const command = await openPanel({
        guild: createGuild({ cached: [renamed] }),
      });

      expect(listedChannels(embedOf(lastCallArg(command.reply)))).toEqual([
        'New name',
      ]);
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
          ['6-days', 6, 1],
          ['7-days', 7, 20],
          ['29-days', 29, 2],
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
        // Today and the six days before it: exactly seven calendar days.
        ['week', '16m', ['today', 'yesterday', '6-days']],
        ['month', '38m', ['7-days', 'today', 'yesterday', '29-days', '6-days']],
        [
          'all',
          '4h 38m',
          [
            '31-days',
            '30-days',
            '7-days',
            'today',
            'yesterday',
            '29-days',
            '6-days',
          ],
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
          expect(listedChannels(embed)).toEqual(channels);
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

      it('ignores a forged period value and keeps the current one', async () => {
        const command = await openPanel({}, { initialPeriod: 'today' });
        const select = createComponentInteraction(
          'stringSelect',
          'notification-panel:stats-period',
          { values: ['decade'] }
        );

        await command.collect(select.interaction);

        expect(
          field(
            embedOf(lastCallArg(select.update)),
            t('notification.stats.period', 'en')
          )
        ).toBe(t('notification.stats.periods.today', 'en'));
      });
    });

    describe('day boundary', () => {
      it('starts "today" at midnight in Japan, not in UTC', async () => {
        // 00:30 in Japan is still the previous day in UTC.
        vi.setSystemTime(JST_MIDNIGHT + 30 * MINUTE);
        insertDailyStat(db, {
          day: '2026-07-15',
          channelName: 'late-night',
          durationMs: 20 * MINUTE,
        });
        insertDailyStat(db, {
          day: '2026-07-14',
          channelName: 'yesterday',
          channelId: 'vc-2',
          durationMs: 99 * MINUTE,
        });

        const command = await openPanel({}, { initialPeriod: 'today' });

        const embed = embedOf(lastCallArg(command.reply));
        expect(listedChannels(embed)).toEqual(['late-night']);
        expect(embed.footer?.text).toBe(
          t('notification.stats.dayBoundaryJapan', 'en')
        );
      });

      it('names a configured zone other than Japan time', async () => {
        setStatsTimeZone('Europe/London');

        const command = await openPanel({}, { initialPeriod: 'week' });

        expect(embedOf(lastCallArg(command.reply)).footer?.text).toBe(
          t('notification.stats.dayBoundary', 'en', { zone: 'Europe/London' })
        );
      });

      it('has no day-boundary footer for all time', async () => {
        const command = await openPanel({}, { initialPeriod: 'all' });

        expect(embedOf(lastCallArg(command.reply)).footer).toBeUndefined();
      });
    });

    describe('while the user is in VC', () => {
      function joinVoice(at: number, channelId = 'vc-live', name = 'Live') {
        vi.setSystemTime(at);
        voiceTracker.startSession(GUILD_ID, USER_ID, channelId, name);
        vi.setSystemTime(NOW);
      }

      it('shows the visit in progress instead of "no data"', async () => {
        joinVoice(NOW - 2 * HOUR);

        const command = await openPanel({});

        const embed = embedOf(lastCallArg(command.reply));
        expect(embed.description?.split('\n')).toEqual([
          t('notification.stats.liveSession', 'en', {
            channel: 'vc-live',
            duration: '2h',
          }),
          '',
          `🥇 **Live**${t('notification.stats.live', 'en')} — 2h (1x)`,
        ]);
        expect(field(embed, t('notification.stats.total', 'en'))).toBe('2h');
      });

      it('adds the live time to a channel that already has history', async () => {
        insertDailyStat(db, {
          day: dayKey(NOW),
          channelId: 'vc-live',
          channelName: 'Live',
          durationMs: 30 * MINUTE,
        });
        insertDailyStat(db, {
          day: dayKey(NOW),
          channelId: 'vc-other',
          channelName: 'Other',
          durationMs: 40 * MINUTE,
        });
        joinVoice(NOW - 20 * MINUTE);

        const command = await openPanel({}, { initialPeriod: 'today' });

        const embed = embedOf(lastCallArg(command.reply));
        // 30m stored + 20m live overtakes Other's 40m.
        expect(listedChannels(embed)).toEqual(['Live', 'Other']);
        expect(embed.description).toContain(
          `🥇 **Live**${t('notification.stats.live', 'en')} — 50m (2x)`
        );
        expect(field(embed, t('notification.stats.total', 'en'))).toBe(
          '1h 30m'
        );
      });

      it('counts only the part of the visit inside the period', async () => {
        // Joined at 23:00 yesterday (Japan time); it is now 12:00.
        joinVoice(JST_MIDNIGHT - HOUR);

        const command = await openPanel({}, { initialPeriod: 'today' });

        const embed = embedOf(lastCallArg(command.reply));
        expect(field(embed, t('notification.stats.total', 'en'))).toBe('12h');
        // The visit started yesterday, so today has no new visit to count.
        expect(embed.description?.split('\n')[2]).toBe(
          `🥇 **Live**${t('notification.stats.live', 'en')} — 12h`
        );
        // The live line still says how long the whole visit has been.
        expect(embed.description?.split('\n')[0]).toBe(
          t('notification.stats.liveSession', 'en', {
            channel: 'vc-live',
            duration: '13h',
          })
        );
      });

      it('matches what the rollup stores once the user leaves', async () => {
        joinVoice(JST_MIDNIGHT - HOUR);
        const live = embedOf(
          lastCallArg((await openPanel({}, { initialPeriod: 'today' })).reply)
        );

        voiceTracker.endSession(GUILD_ID, USER_ID);
        const stored = embedOf(
          lastCallArg((await openPanel({}, { initialPeriod: 'today' })).reply)
        );

        expect(field(stored, t('notification.stats.total', 'en'))).toBe(
          field(live, t('notification.stats.total', 'en'))
        );
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
      expect(periodMenu.options?.map((o) => o.label)).toEqual([
        'Today',
        'Last 7 days',
        'Last 30 days',
        'All time',
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

    it('can still switch the stats period', async () => {
      const command = await openPanel({ manageGuild: false });
      const select = createComponentInteraction(
        'stringSelect',
        'notification-panel:stats-period',
        { values: ['week'] }
      );

      await command.collect(select.interaction);

      expect(
        field(
          embedOf(lastCallArg(select.update)),
          t('notification.stats.period', 'en')
        )
      ).toBe(t('notification.stats.periods.week', 'en'));
    });

    it.each([
      ['button', 'notification-panel:status'],
      ['button', 'notification-panel:voice:remove'],
      ['button', 'notification-panel:member_join:remove'],
      ['button', 'notification-panel:voice:remove-confirm'],
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
      expect(notifySetup).not.toHaveBeenCalled();
      expect(embedOf(lastCallArg(select.update)).title).toBe(
        t('notification.stats.title', 'en')
      );
    });
  });

  describe('settings view', () => {
    const autoLanguageField = {
      name: t('notification.status.postLanguage', 'en'),
      value: `日本語\n${t('notification.language.autoHint', 'en', {
        language: '日本語',
        command: commandMention('admin settings language'),
      })}`,
      inline: false,
    };

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
        // A non-Community server on "auto" posts in Japanese; an English
        // reader is told why and where to change it.
        autoLanguageField,
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

    it.each([
      ['a Japanese reader on a non-Community server', 'ja', {}, '日本語'],
      [
        'a Community server whose language is English',
        'en',
        { features: ['COMMUNITY'], preferredLocale: 'en-US' },
        'English',
      ],
    ] as const)(
      'shows the post language without a hint for %s',
      async (_case, locale, guildOptions, language) => {
        const command = await openPanel(
          { manageGuild: true, guild: createGuild({ ...guildOptions }) },
          { initialView: 'status' },
          locale
        );

        expect(embedOf(lastCallArg(command.reply)).fields?.[2]).toEqual({
          name: t('notification.status.postLanguage', locale),
          value: language,
          inline: false,
        });
      }
    );

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
        expect(picker.default_values).toBeUndefined();
      }
      expect(voicePicker.placeholder).toBe(
        t('notification.panel.voicePlaceholder', 'en')
      );
      expect(welcomePicker.placeholder).toBe(
        t('notification.panel.welcomePlaceholder', 'en')
      );
    });

    it('preselects the current channel in its picker while it still exists', async () => {
      notificationChannelRepository.set(GUILD_ID, 'voice', 'vc-log');
      notificationChannelRepository.set(GUILD_ID, 'member_join', 'gone');

      const command = await openPanel(
        {
          manageGuild: true,
          guild: createGuild({ cached: [createTextChannel('vc-log')] }),
        },
        { initialView: 'status' }
      );

      const rows = rowsOf(lastCallArg(command.reply));
      expect(rows[1][0].default_values).toEqual([
        { id: 'vc-log', type: 'channel' },
      ]);
      // A deleted channel would be an invalid default.
      expect(rows[2][0].default_values).toBeUndefined();
    });

    it('shows configured channels and enables only the matching remove button', async () => {
      notificationChannelRepository.set(GUILD_ID, 'voice', 'vc-log');

      const command = await openPanel(
        { manageGuild: true },
        { initialView: 'status' }
      );

      const payload = lastCallArg(command.reply);
      expect(
        embedOf(payload)
          .fields?.slice(0, 2)
          .map((f) => f.value)
      ).toEqual(['<#vc-log>', t('notification.status.disabled', 'en')]);
      expect(rowsOf(payload)[3].map((b) => b.disabled)).toEqual([false, true]);
    });

    it('reports a stored but switched-off configuration as not configured', async () => {
      notificationChannelRepository.set(GUILD_ID, 'member_join', 'welcome');
      db.prepare('UPDATE notification_channels SET enabled = 0').run();

      const command = await openPanel(
        { manageGuild: true },
        { initialView: 'status' }
      );

      const payload = lastCallArg(command.reply);
      expect(embedOf(payload).fields?.[1].value).toBe(
        t('notification.status.disabled', 'en')
      );
      // Nothing to switch off: its remove button is disabled too.
      expect(rowsOf(payload)[3].map((b) => b.disabled)).toEqual([true, true]);

      // A stale click on it asks nothing and keeps the settings rows.
      const remove = createComponentInteraction(
        'button',
        'notification-panel:member_join:remove'
      );
      await command.collect(remove.interaction);
      const after = lastCallArg(remove.update);
      expect(embedOf(after).color).not.toBe(COLORS.WARNING);
      expect(customIdsOf(after)).toEqual(SETTINGS_ROWS);
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

    it('shows the result line only until the next click', async () => {
      const channel = createTextChannel('new-chan');
      const command = await openPanel(
        { manageGuild: true, guild: createGuild({ cached: [channel] }) },
        { initialView: 'status' }
      );
      await command.collect(
        createComponentInteraction(
          'channelSelect',
          'notification-panel:voice:channel',
          { values: ['new-chan'] }
        ).interaction
      );

      const next = createComponentInteraction(
        'button',
        'notification-panel:status'
      );
      await command.collect(next.interaction);

      expect(embedOf(lastCallArg(next.update)).description).toBe(
        t('notification.panel.statusDescription', 'en')
      );
    });

    it.each([
      ['voice', 'notification-panel:voice:channel', 0, 'VC Join/Leave'],
      [
        'member_join',
        'notification-panel:member_join:channel',
        1,
        'Member Join',
      ],
    ] as const)(
      'saves the %s channel picked from the menu and says so',
      async (type, customId, fieldIndex, label) => {
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
        const embed = embedOf(payload);
        expect(embed.fields?.[fieldIndex].value).toBe('<#new-chan>');
        expect(embed.description).toBe(
          t('notification.panel.changed', 'en', {
            type: label,
            channel: 'new-chan',
          })
        );
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
        'the bot has no permissions there',
        () => [createTextChannel('new-chan', { canSend: false })],
        t('notification.errors.channelMissingPermissions', 'en', {
          channel: 'new-chan',
          permissions: formatPermissionNames(
            [
              PermissionFlagsBits.ViewChannel,
              PermissionFlagsBits.SendMessages,
              PermissionFlagsBits.EmbedLinks,
            ],
            'en'
          ),
        }),
      ],
      [
        'the bot can send but not embed links',
        () => [
          createTextChannel('new-chan', {
            permissions: POSTING_PERMISSIONS & ~PermissionFlagsBits.EmbedLinks,
          }),
        ],
        t('notification.errors.channelMissingPermissions', 'en', {
          channel: 'new-chan',
          permissions: 'Embed Links',
        }),
      ],
      [
        'the channel is gone',
        () => [],
        t('notification.errors.channelNotSendable', 'en'),
      ],
    ])(
      'rejects a picked channel when %s and keeps the panel as it was',
      async (_reason, cachedChannels, message) => {
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
        expect(embedOf(payload).description).toBe(message);
        expect(
          notificationChannelRepository.getEnabled(GUILD_ID, 'voice')
        ).toBe('vc-log');
        expect(notifySetup).not.toHaveBeenCalled();
      }
    );

    describe('removing a configuration', () => {
      it.each([
        ['voice', 'VC Join/Leave', 'vc-log', [true, false]],
        ['member_join', 'Member Join', 'welcome', [false, true]],
      ] as const)(
        'asks before switching %s notifications off, then removes them',
        async (type, label, channel, disabledAfter) => {
          notificationChannelRepository.set(GUILD_ID, 'voice', 'vc-log');
          notificationChannelRepository.set(GUILD_ID, 'member_join', 'welcome');
          const command = await openPanel(
            { manageGuild: true },
            { initialView: 'status' }
          );

          const remove = createComponentInteraction(
            'button',
            `notification-panel:${type}:remove`
          );
          await command.collect(remove.interaction);

          // One tap only asks.
          expect(notificationChannelRepository.getEnabled(GUILD_ID, type)).toBe(
            channel
          );
          const prompt = lastCallArg(remove.update);
          expect(embedOf(prompt).description).toBe(
            t('notification.panel.confirmRemove', 'en', {
              type: label,
              channel,
            })
          );
          expect(embedOf(prompt).color).toBe(COLORS.WARNING);
          expect(customIdsOf(prompt)[3]).toEqual([
            `notification-panel:${type}:remove-confirm`,
            'notification-panel:remove-cancel',
          ]);
          expect(rowsOf(prompt)[3].map((b) => b.style)).toEqual([
            ButtonStyle.Danger,
            ButtonStyle.Secondary,
          ]);

          const confirm = createComponentInteraction(
            'button',
            `notification-panel:${type}:remove-confirm`
          );
          await command.collect(confirm.interaction);

          expect(notificationChannelRepository.get(GUILD_ID, type)).toBeNull();
          expect(
            notificationChannelRepository.getAllForGuild(GUILD_ID)
          ).toHaveLength(1);
          const payload = lastCallArg(confirm.update);
          expect(embedOf(payload).description).toBe(
            t('notification.panel.removed', 'en', { type: label, channel })
          );
          expect(customIdsOf(payload)).toEqual(SETTINGS_ROWS);
          expect(rowsOf(payload)[3].map((b) => b.disabled)).toEqual(
            disabledAfter
          );
        }
      );

      it('keeps the configuration when the user goes back', async () => {
        notificationChannelRepository.set(GUILD_ID, 'voice', 'vc-log');
        const command = await openPanel(
          { manageGuild: true },
          { initialView: 'status' }
        );
        await command.collect(
          createComponentInteraction(
            'button',
            'notification-panel:voice:remove'
          ).interaction
        );

        const cancel = createComponentInteraction(
          'button',
          'notification-panel:remove-cancel'
        );
        await command.collect(cancel.interaction);

        expect(
          notificationChannelRepository.getEnabled(GUILD_ID, 'voice')
        ).toBe('vc-log');
        const payload = lastCallArg(cancel.update);
        expect(customIdsOf(payload)).toEqual(SETTINGS_ROWS);
        expect(embedOf(payload).description).toBe(
          t('notification.panel.statusDescription', 'en')
        );
        expect(notifyRemove).not.toHaveBeenCalled();
      });

      it('drops a pending removal when the user clicks anything else', async () => {
        notificationChannelRepository.set(GUILD_ID, 'voice', 'vc-log');
        const command = await openPanel(
          { manageGuild: true },
          { initialView: 'status' }
        );
        await command.collect(
          createComponentInteraction(
            'button',
            'notification-panel:voice:remove'
          ).interaction
        );
        await command.collect(
          createComponentInteraction('button', 'notification-panel:status')
            .interaction
        );

        // The confirm button from the abandoned prompt no longer works.
        const lateConfirm = createComponentInteraction(
          'button',
          'notification-panel:voice:remove-confirm'
        );
        await command.collect(lateConfirm.interaction);

        expect(
          notificationChannelRepository.getEnabled(GUILD_ID, 'voice')
        ).toBe('vc-log');
        expect(customIdsOf(lastCallArg(lateConfirm.update))).toEqual(
          SETTINGS_ROWS
        );
      });

      it('removes nothing on a confirm that was never asked for', async () => {
        notificationChannelRepository.set(GUILD_ID, 'voice', 'vc-log');
        notificationChannelRepository.set(GUILD_ID, 'member_join', 'welcome');
        const command = await openPanel(
          { manageGuild: true },
          { initialView: 'status' }
        );
        // Asked about welcome, confirm forged for voice.
        await command.collect(
          createComponentInteraction(
            'button',
            'notification-panel:member_join:remove'
          ).interaction
        );
        await command.collect(
          createComponentInteraction(
            'button',
            'notification-panel:voice:remove-confirm'
          ).interaction
        );

        expect(
          notificationChannelRepository.getAllForGuild(GUILD_ID)
        ).toHaveLength(2);
        expect(notifyRemove).not.toHaveBeenCalled();
      });

      it('keeps a pending removal when a picked channel is rejected', async () => {
        notificationChannelRepository.set(GUILD_ID, 'voice', 'vc-log');
        const command = await openPanel(
          { manageGuild: true, guild: createGuild({ cached: [] }) },
          { initialView: 'status' }
        );
        await command.collect(
          createComponentInteraction(
            'button',
            'notification-panel:voice:remove'
          ).interaction
        );
        await command.collect(
          createComponentInteraction(
            'channelSelect',
            'notification-panel:voice:channel',
            { values: ['gone'] }
          ).interaction
        );

        await command.collect(
          createComponentInteraction(
            'button',
            'notification-panel:voice:remove-confirm'
          ).interaction
        );

        expect(notificationChannelRepository.get(GUILD_ID, 'voice')).toBeNull();
      });

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
          // No confirm prompt for something that is not there.
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
  });

  /**
   * Regression: the remove buttons and the channel pickers used to write to
   * `notification_channels` without calling `audit.notifySetup` /
   * `audit.notifyRemove`, while `/notification voice|welcome set|disable`
   * audited the very same change, so a Manage Server holder could retarget
   * or switch off notifications from the panel with no NOTIFY_SETUP /
   * NOTIFY_REMOVE entry. Removals are audited only when something was
   * actually removed, matching the slash handlers.
   */
  describe('audit trail', () => {
    it.each([
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

        expect(notifySetup).toHaveBeenCalledTimes(1);
        expect(notifySetup).toHaveBeenCalledWith(
          expect.anything(),
          GUILD_ID,
          USER_ID,
          'new-chan',
          auditKind
        );
      }
    );

    it.each([
      ['voice', 'Voice'],
      ['member_join', 'Welcome'],
    ] as const)(
      'records who switched off %s notifications from the panel',
      async (type, auditKind) => {
        notificationChannelRepository.set(GUILD_ID, type, 'configured');
        const command = await openPanel(
          { manageGuild: true },
          { initialView: 'status' }
        );

        await command.collect(
          createComponentInteraction(
            'button',
            `notification-panel:${type}:remove`
          ).interaction
        );
        // Asking is not a change.
        expect(notifyRemove).not.toHaveBeenCalled();

        await command.collect(
          createComponentInteraction(
            'button',
            `notification-panel:${type}:remove-confirm`
          ).interaction
        );

        expect(notifyRemove).toHaveBeenCalledTimes(1);
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
    it('turns away clicks from anyone but the user who opened it', async () => {
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
      expect(intruder.reply).toHaveBeenCalledWith(
        expect.objectContaining({
          content: t('common.onlyCommandUser', 'en', {
            user: `<@${USER_ID}>`,
            command: commandMention('notification'),
          }),
          flags: MessageFlags.Ephemeral,
        })
      );
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

    it('expires a pending removal with its confirm button disabled', async () => {
      notificationChannelRepository.set(GUILD_ID, 'voice', 'vc-log');
      const command = await openPanel(
        { manageGuild: true },
        { initialView: 'status' }
      );
      await command.collect(
        createComponentInteraction('button', 'notification-panel:voice:remove')
          .interaction
      );

      await command.end();

      const rows = rowsOf(lastCallArg(command.editReply));
      expect(rows[3].map((b) => [b.custom_id, b.disabled])).toEqual([
        ['notification-panel:voice:remove-confirm', true],
        ['notification-panel:remove-cancel', true],
      ]);
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

    it('tells the user and logs when Discord rejects the update', async () => {
      const command = await openPanel({ manageGuild: true });
      const button = createComponentInteraction(
        'button',
        'notification-panel:status'
      );
      button.update.mockRejectedValueOnce(new Error('Unknown interaction'));

      await command.collect(button.interaction);

      expect(button.reply).toHaveBeenCalledTimes(1);
      const { content, flags } = lastCallArg(button.reply) as {
        content: string;
        flags: number;
      };
      expect(flags).toBe(MessageFlags.Ephemeral);
      const id = /`([0-9a-f]{6})`/.exec(content)?.[1];
      expect(content).toBe(t('common.actionFailed', 'en', { id: id! }));
      expect(loggerWarn).toHaveBeenCalledWith(
        expect.stringContaining(`[${id}] Failed to update notification panel`),
        expect.anything()
      );
    });
  });
});
