import Database from 'better-sqlite3';
import { ChannelType, Collection } from 'discord.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The auto-join changes, run against the real reconcile and the real
 * settings repository (in-memory SQLite). Only the voice connections and the
 * notice are faked, so "which channel did the bot end up joining" is decided
 * by the same code production runs.
 */
const db = new Database(':memory:');

vi.mock('../../../infrastructure/database/connection.js', () => ({
  database: db,
}));

vi.mock('../../../shared/utils/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
  getErrorMessage: (e: unknown) => String(e),
}));

const fake = vi.hoisted(() => ({
  connections: new Map<string, { channelId: string; guildId: string }>(),
}));

const connect = vi.hoisted(() =>
  vi.fn(async (guild: { id: string }, channel: { id: string }) => {
    fake.connections.set(channel.id, {
      channelId: channel.id,
      guildId: guild.id,
    });
    return { id: `connection-${channel.id}` };
  })
);

vi.mock('../recording/connectionManager.js', () => ({
  connectionManager: {
    connect,
    getConnection: (id: string) => fake.connections.get(id),
    getAllConnections: () => new Map(fake.connections),
    getConnectedChannelInGuild: (guildId: string) => {
      for (const info of fake.connections.values()) {
        if (info.guildId === guildId) return info.channelId;
      }
      return undefined;
    },
    isAtLimit: () => false,
    disconnect: vi.fn(async (id: string) => {
      fake.connections.delete(id);
    }),
  },
}));

const announceBuffering = vi.hoisted(() => vi.fn());
vi.mock('../application/announce.js', () => ({ announceBuffering }));

const { applyExclusionChanges, excludeChannel } =
  await import('../application/policy.js');
const { voiceSettingsRepository } =
  await import('../repositories/voiceSettingsRepository.js');
const { connectionManager } = await import('../recording/connectionManager.js');
const { up: settingsTables } =
  await import('../../../infrastructure/database/migrations/003_settings.js');
const { up: voiceAutoJoinTables } =
  await import('../../../infrastructure/database/migrations/007_voice_autojoin.js');
const { up: announcementColumn } =
  await import('../../../infrastructure/database/migrations/008_announcement_channel.js');

const GUILD = 'guild-1';

function voiceChannel(id: string, people: number) {
  const members = new Collection<string, { user: { bot: boolean } }>();
  for (let i = 0; i < people; i++) {
    members.set(`${id}-member-${i}`, { user: { bot: false } });
  }
  return { id, name: id, type: ChannelType.GuildVoice, members };
}

/** A guild whose channels A (3 people), B (2) and C (1) are all occupied. */
function guild() {
  const channels = [
    voiceChannel('A', 3),
    voiceChannel('B', 2),
    voiceChannel('C', 1),
  ];
  return {
    id: GUILD,
    name: 'Guild',
    channels: { cache: new Collection(channels.map((c) => [c.id, c])) },
  };
}

describe('auto-join policy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.exec(`
      DROP TABLE IF EXISTS voice_autojoin_exclusions;
      DROP TABLE IF EXISTS guild_settings;
    `);
    settingsTables();
    voiceAutoJoinTables();
    announcementColumn();
    fake.connections.clear();
  });

  describe('applyExclusionChanges', () => {
    it("never joins a channel excluded in the same change, even after leaving the bot's channel", async () => {
      fake.connections.set('A', { channelId: 'A', guildId: GUILD });
      const discordGuild = guild();

      const changes = await applyExclusionChanges(
        discordGuild as never,
        ['A', 'B'],
        []
      );

      // Second argument: the connection to drop, which this fake leaves out.
      expect(connectionManager.disconnect).toHaveBeenCalledWith('A', undefined);
      // Not B: it is excluded in this very change. C is the one left.
      expect(connect).toHaveBeenCalledTimes(1);
      expect(connect.mock.calls[0][1]).toMatchObject({ id: 'C' });
      expect(announceBuffering).toHaveBeenCalledTimes(1);
      expect(announceBuffering.mock.calls[0][0]).toMatchObject({ id: 'C' });
      expect(changes).toEqual({
        added: ['A', 'B'],
        removed: [],
        left: true,
        outcome: { status: 'joined', channelId: 'C' },
      });
    });

    it('stays out entirely when every occupied channel is excluded at once', async () => {
      fake.connections.set('A', { channelId: 'A', guildId: GUILD });

      const changes = await applyExclusionChanges(
        guild() as never,
        ['A', 'B', 'C'],
        []
      );

      expect(connect).not.toHaveBeenCalled();
      expect(announceBuffering).not.toHaveBeenCalled();
      expect(changes.outcome).toEqual({ status: 'none' });
    });

    it('swaps one exclusion for another and joins what became eligible', async () => {
      voiceSettingsRepository.addExclusion(GUILD, 'A');
      fake.connections.set('B', { channelId: 'B', guildId: GUILD });

      const changes = await applyExclusionChanges(
        guild() as never,
        ['B'],
        ['A']
      );

      expect(voiceSettingsRepository.listExclusions(GUILD)).toEqual(['B']);
      expect(connect).toHaveBeenCalledTimes(1);
      expect(connect.mock.calls[0][1]).toMatchObject({ id: 'A' });
      expect(changes.outcome).toEqual({ status: 'joined', channelId: 'A' });
    });

    it('lists only what actually changed, and leaves the guild alone otherwise', async () => {
      voiceSettingsRepository.addExclusion(GUILD, 'B');

      const changes = await applyExclusionChanges(
        guild() as never,
        ['B'],
        ['C']
      );

      expect(changes).toEqual({ added: [], removed: [], left: false });
      expect(connect).not.toHaveBeenCalled();
    });

    it('does not join anything while auto-join is off', async () => {
      voiceSettingsRepository.setAutoJoinEnabled(GUILD, false);
      voiceSettingsRepository.addExclusion(GUILD, 'A');

      const changes = await applyExclusionChanges(guild() as never, [], ['A']);

      expect(connect).not.toHaveBeenCalled();
      expect(changes.outcome).toEqual({ status: 'disabled' });
    });
  });

  describe('excludeChannel', () => {
    it("leaves the bot's channel and moves on to the busiest one still allowed", async () => {
      fake.connections.set('A', { channelId: 'A', guildId: GUILD });

      const result = await excludeChannel(guild() as never, 'A');

      expect(result).toEqual({
        added: true,
        left: true,
        readingStopped: false,
      });
      expect(connect.mock.calls[0][1]).toMatchObject({ id: 'B' });
    });

    it('reports an exclusion that was already there', async () => {
      voiceSettingsRepository.addExclusion(GUILD, 'C');

      await expect(excludeChannel(guild() as never, 'C')).resolves.toEqual({
        added: false,
        left: false,
        readingStopped: false,
      });
      expect(connect).not.toHaveBeenCalled();
    });
  });
});
