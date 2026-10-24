import Database from 'better-sqlite3';
import { Events, type GuildMember } from 'discord.js';
import {
  afterAll,
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
  clearNotificationTables,
  createGuild,
  createTextChannel,
  embedOf,
  migrateNotificationSchema,
  type FakeGuildOptions,
} from './notification.helpers.js';

/**
 * The welcome message is configured through `notification_channels` and read
 * back on every join, so the repository and guild-language lookup run on real
 * SQLite. The channel checks go through the real `getSendableTextChannel`
 * against a faked guild, which keeps "missing channel" and "no permission"
 * distinct cases rather than one mocked `null`.
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

const { event } = await import('../events/memberJoinNotification.js');
const { notificationChannelRepository } =
  await import('../repositories/notificationChannelRepository.js');
const { guildSettingsRepository } =
  await import('../../../infrastructure/guildSettings/index.js');

const WELCOME_CHANNEL = 'welcome-1';

function readyClient(isFullyReady = true) {
  return { isFullyReady } as never;
}

function createMember(
  guildOptions: FakeGuildOptions,
  overrides: { bot?: boolean; displayName?: string } = {}
) {
  const displayAvatarURL = vi.fn(() => 'https://cdn.example/avatar.png');
  const member = {
    displayName: overrides.displayName ?? 'Newcomer',
    user: { bot: overrides.bot ?? false, displayAvatarURL },
    guild: createGuild(guildOptions),
  } as unknown as GuildMember;
  return { member, displayAvatarURL };
}

describe('memberJoinNotification event', () => {
  beforeAll(async () => {
    await migrateNotificationSchema();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    clearNotificationTables(db);
  });

  afterAll(() => {
    db.close();
  });

  it('listens for every guild member join', () => {
    expect(event.name).toBe(Events.GuildMemberAdd);
    expect(event.once).toBe(false);
  });

  describe('when the welcome message is enabled', () => {
    beforeEach(() => {
      notificationChannelRepository.set(
        GUILD_ID,
        'member_join',
        WELCOME_CHANNEL
      );
    });

    it('posts a welcome embed with the member name, avatar and member count', async () => {
      const channel = createTextChannel(WELCOME_CHANNEL);
      const { member, displayAvatarURL } = createMember(
        { cached: [channel], memberCount: 42 },
        { displayName: 'Alice' }
      );

      await event.execute(readyClient(), member);

      expect(channel.send).toHaveBeenCalledTimes(1);
      const embed = embedOf(vi.mocked(channel.send).mock.calls[0][0]);
      expect(embed.title).toBe(t('notification.events.memberJoinTitle', 'en'));
      expect(embed.description).toBe(
        t('notification.events.memberJoin', 'en', { name: 'Alice' })
      );
      expect(embed.color).toBe(COLORS.SUCCESS);
      expect(embed.thumbnail?.url).toBe('https://cdn.example/avatar.png');
      expect(displayAvatarURL).toHaveBeenCalledWith({ size: 128 });
      expect(embed.fields).toEqual([
        {
          name: t('notification.events.memberCount', 'en'),
          value: '42',
          inline: true,
        },
      ]);
      expect(embed.timestamp).toBeDefined();
    });

    it('fetches the channel when it is not cached yet', async () => {
      const channel = createTextChannel(WELCOME_CHANNEL);
      const { member } = createMember({ fetchable: [channel] });

      await event.execute(readyClient(), member);

      expect(member.guild.channels.fetch).toHaveBeenCalledWith(WELCOME_CHANNEL);
      expect(channel.send).toHaveBeenCalledTimes(1);
    });

    it('writes in the guild preferred locale when no language is configured', async () => {
      const channel = createTextChannel(WELCOME_CHANNEL);
      const { member } = createMember({
        cached: [channel],
        preferredLocale: 'ja',
      });

      await event.execute(readyClient(), member);

      const embed = embedOf(vi.mocked(channel.send).mock.calls[0][0]);
      expect(embed.title).toBe(t('notification.events.memberJoinTitle', 'ja'));
    });

    it('lets the configured guild language override the preferred locale', async () => {
      guildSettingsRepository.setLanguage(GUILD_ID, 'en');
      const channel = createTextChannel(WELCOME_CHANNEL);
      const { member } = createMember({
        cached: [channel],
        preferredLocale: 'ja',
      });

      await event.execute(readyClient(), member);

      const embed = embedOf(vi.mocked(channel.send).mock.calls[0][0]);
      expect(embed.title).toBe(t('notification.events.memberJoinTitle', 'en'));
    });

    it('stays silent when the configured channel no longer exists', async () => {
      const { member } = createMember({ cached: [] });

      await expect(event.execute(readyClient(), member)).resolves.toBe(
        undefined
      );

      expect(member.guild.channels.fetch).toHaveBeenCalledWith(WELCOME_CHANNEL);
      expect(loggerWarn).not.toHaveBeenCalled();
    });

    it('stays silent when the bot cannot send messages in the channel', async () => {
      const channel = createTextChannel(WELCOME_CHANNEL, { canSend: false });
      const { member } = createMember({ cached: [channel] });

      await event.execute(readyClient(), member);

      expect(channel.send).not.toHaveBeenCalled();
    });

    it('stays silent when the bot member is not available to check permissions', async () => {
      const channel = createTextChannel(WELCOME_CHANNEL);
      const { member } = createMember({ cached: [channel], me: null });

      await event.execute(readyClient(), member);

      expect(channel.send).not.toHaveBeenCalled();
    });

    it('logs a warning instead of throwing when Discord rejects the send', async () => {
      const channel = createTextChannel(WELCOME_CHANNEL);
      vi.mocked(channel.send).mockRejectedValueOnce(
        new Error('Missing Access')
      );
      const { member } = createMember({ cached: [channel] });

      await expect(event.execute(readyClient(), member)).resolves.toBe(
        undefined
      );

      expect(loggerWarn).toHaveBeenCalledWith(
        expect.stringContaining('Missing Access')
      );
    });

    it('ignores bots joining the server', async () => {
      const channel = createTextChannel(WELCOME_CHANNEL);
      const { member } = createMember({ cached: [channel] }, { bot: true });

      await event.execute(readyClient(), member);

      expect(channel.send).not.toHaveBeenCalled();
    });

    it('does nothing until the client has finished starting up', async () => {
      const channel = createTextChannel(WELCOME_CHANNEL);
      const { member } = createMember({ cached: [channel] });

      await event.execute(readyClient(false), member);

      expect(channel.send).not.toHaveBeenCalled();
    });

    it('stops posting once the welcome message is disabled', async () => {
      notificationChannelRepository.remove(GUILD_ID, 'member_join');
      const channel = createTextChannel(WELCOME_CHANNEL);
      const { member } = createMember({ cached: [channel] });

      await event.execute(readyClient(), member);

      expect(channel.send).not.toHaveBeenCalled();
    });
  });

  it('does not look up any channel when the guild has no welcome configuration', async () => {
    const channel = createTextChannel(WELCOME_CHANNEL);
    const { member } = createMember({ cached: [channel] });
    const cacheGet = vi.spyOn(member.guild.channels.cache, 'get');

    await event.execute(readyClient(), member);

    expect(cacheGet).not.toHaveBeenCalled();
    expect(channel.send).not.toHaveBeenCalled();
  });

  it('does not post when only VC notifications are configured', async () => {
    notificationChannelRepository.set(GUILD_ID, 'voice', WELCOME_CHANNEL);
    const channel = createTextChannel(WELCOME_CHANNEL);
    const { member } = createMember({ cached: [channel] });

    await event.execute(readyClient(), member);

    expect(channel.send).not.toHaveBeenCalled();
  });

  it('does not post when the stored configuration is switched off', async () => {
    notificationChannelRepository.set(GUILD_ID, 'member_join', WELCOME_CHANNEL);
    db.prepare('UPDATE notification_channels SET enabled = 0').run();
    const channel = createTextChannel(WELCOME_CHANNEL);
    const { member } = createMember({ cached: [channel] });

    await event.execute(readyClient(), member);

    expect(channel.send).not.toHaveBeenCalled();
  });
});
