import Database from 'better-sqlite3';
import { ChannelType, Collection, Events } from 'discord.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Join / leave / move decisions for the auto-join that feeds `/voice record`.
 *
 * The connection manager is replaced by a small in-memory fake that really
 * tracks which channels are connected, so multi-step flows (leave A, then
 * join B) see the state the previous step left behind. The settings gate is
 * the real repository on in-memory SQLite, so "disabled guild" and "excluded
 * channel" mean exactly what `/voice autojoin` stores.
 */
const db = new Database(':memory:');

vi.mock('../../../infrastructure/database/connection.js', () => ({
  database: db,
}));

vi.mock('../../../shared/utils/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
  getErrorMessage: (e: unknown) => String(e),
}));

const fake = vi.hoisted(() => {
  const connections = new Map<string, { channelId: string; guildId: string }>();
  const limit = { value: Number.POSITIVE_INFINITY };
  const connectionManager = {
    connect: vi.fn(),
    disconnect: vi.fn(),
    getConnection: vi.fn(),
    getAllConnections: vi.fn(),
    getConnectedChannelInGuild: vi.fn(),
    isAtLimit: vi.fn(),
    updateActivity: vi.fn(),
  };
  return { connections, limit, connectionManager };
});

vi.mock('../recording/connectionManager.js', () => ({
  connectionManager: fake.connectionManager,
}));

const announceBuffering = vi.hoisted(() => vi.fn());
const forgetAnnouncement = vi.hoisted(() => vi.fn());

vi.mock('../application/announce.js', () => ({
  announceBuffering,
  forgetAnnouncement,
}));

const reconcileGuild = vi.hoisted(() => vi.fn());
vi.mock('../application/reconcile.js', () => ({ reconcileGuild }));

const { event } = await import('../events/voiceStateUpdate.js');
const { voiceSettingsRepository } =
  await import('../repositories/voiceSettingsRepository.js');
const { up: settingsTables } =
  await import('../../../infrastructure/database/migrations/003_settings.js');
const { up: voiceAutoJoinTables } =
  await import('../../../infrastructure/database/migrations/007_voice_autojoin.js');
const { up: announcementColumn } =
  await import('../../../infrastructure/database/migrations/008_announcement_channel.js');

const cm = fake.connectionManager;
const BOT_ID = 'bot-1';
const guild = { id: 'guild-1', name: 'Guild' };
const otherGuild = { id: 'guild-2', name: 'Other' };

interface FakeMember {
  id: string;
  user: { id: string; bot: boolean };
}

function human(id: string): FakeMember {
  return { id, user: { id, bot: false } };
}

function botUser(id: string): FakeMember {
  return { id, user: { id, bot: true } };
}

const me = botUser(BOT_ID);

function voiceChannel(id: string, members: FakeMember[] = []) {
  return {
    id,
    name: `#${id}`,
    type: ChannelType.GuildVoice,
    members: new Collection(members.map((m) => [m.id, m] as const)),
  };
}

type Channel = ReturnType<typeof voiceChannel>;

function voiceState(
  channel: Channel | null,
  member: FakeMember | null = human('alice'),
  stateGuild: typeof guild | null = guild
) {
  return { channel, guild: stateGuild, member };
}

const readyClient = { isFullyReady: true, user: { id: BOT_ID } };

async function fire(
  oldState: ReturnType<typeof voiceState>,
  newState: ReturnType<typeof voiceState>,
  client: object = readyClient
) {
  await event.execute(client as never, oldState as never, newState as never);
}

/** Pretend the bot is already in a channel (as tracked by the manager). */
function alreadyConnected(channelId: string, guildId = guild.id) {
  fake.connections.set(channelId, { channelId, guildId });
}

describe('voiceStateUpdate', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    db.exec(`
      DROP TABLE IF EXISTS voice_autojoin_exclusions;
      DROP TABLE IF EXISTS guild_settings;
      DROP TABLE IF EXISTS audit_logs;
    `);
    settingsTables();
    voiceAutoJoinTables();
    announcementColumn();

    fake.connections.clear();
    fake.limit.value = Number.POSITIVE_INFINITY;
    cm.connect.mockImplementation(
      async (g: { id: string }, channel: { id: string }) => {
        fake.connections.set(channel.id, {
          channelId: channel.id,
          guildId: g.id,
        });
        return { joinedChannel: channel.id };
      }
    );
    cm.disconnect.mockImplementation(async (channelId: string) => {
      fake.connections.delete(channelId);
    });
    cm.getConnection.mockImplementation((channelId: string) =>
      fake.connections.get(channelId)
    );
    cm.getAllConnections.mockImplementation(() => new Map(fake.connections));
    cm.getConnectedChannelInGuild.mockImplementation((guildId: string) => {
      for (const info of fake.connections.values()) {
        if (info.guildId === guildId) return info.channelId;
      }
      return undefined;
    });
    reconcileGuild.mockResolvedValue({ status: 'none' });
    cm.isAtLimit.mockImplementation(
      () => fake.connections.size >= fake.limit.value
    );
    announceBuffering.mockResolvedValue(undefined);
  });

  it('is registered as a recurring VoiceStateUpdate handler', () => {
    expect(event.name).toBe(Events.VoiceStateUpdate);
    expect(event.once).toBe(false);
  });

  it('ignores every update until the client is fully ready', async () => {
    const general = voiceChannel('general', [human('alice')]);

    await fire(voiceState(null), voiceState(general), {
      isFullyReady: false,
      user: { id: BOT_ID },
    });

    expect(cm.getConnection).not.toHaveBeenCalled();
    expect(cm.connect).not.toHaveBeenCalled();
  });

  describe('a user joins', () => {
    it('joins the channel and discloses the buffering', async () => {
      const general = voiceChannel('general', [human('alice')]);

      await fire(voiceState(null), voiceState(general));

      expect(cm.connect).toHaveBeenCalledWith(guild, general);
      expect(announceBuffering).toHaveBeenCalledWith(general);
      expect(fake.connections.has('general')).toBe(true);
    });

    it('only refreshes activity when the bot is already in that channel', async () => {
      alreadyConnected('general');
      const general = voiceChannel('general', [human('alice'), me]);

      await fire(voiceState(null), voiceState(general));

      expect(cm.updateActivity).toHaveBeenCalledWith('general');
      expect(cm.connect).not.toHaveBeenCalled();
      expect(announceBuffering).not.toHaveBeenCalled();
    });

    it('stays out of every channel in a guild that disabled auto-join', async () => {
      voiceSettingsRepository.setAutoJoinEnabled(guild.id, false);
      const general = voiceChannel('general', [human('alice')]);

      await fire(voiceState(null), voiceState(general));

      expect(cm.connect).not.toHaveBeenCalled();
      expect(announceBuffering).not.toHaveBeenCalled();
    });

    it('stays out of an excluded channel but still joins others in the guild', async () => {
      voiceSettingsRepository.addExclusion(guild.id, 'private');
      const privateRoom = voiceChannel('private', [human('alice')]);
      const general = voiceChannel('general', [human('bob')]);

      await fire(voiceState(null), voiceState(privateRoom));
      expect(cm.connect).not.toHaveBeenCalled();

      await fire(
        voiceState(null, human('bob')),
        voiceState(general, human('bob'))
      );
      expect(cm.connect).toHaveBeenCalledWith(guild, general);
    });

    it('does not hop channels when the guild already has a connection', async () => {
      // Discord allows one voice connection per guild.
      alreadyConnected('general');
      const lounge = voiceChannel('lounge', [human('alice')]);

      await fire(voiceState(null), voiceState(lounge));

      expect(cm.connect).not.toHaveBeenCalled();
      expect(fake.connections.has('general')).toBe(true);
    });

    it("is not blocked by another guild's connection", async () => {
      alreadyConnected('elsewhere', otherGuild.id);
      const general = voiceChannel('general', [human('alice')]);

      await fire(voiceState(null), voiceState(general));

      expect(cm.connect).toHaveBeenCalledWith(guild, general);
    });

    it('does not join when the connection limit is reached', async () => {
      fake.limit.value = 1;
      alreadyConnected('elsewhere', otherGuild.id);
      const general = voiceChannel('general', [human('alice')]);

      await fire(voiceState(null), voiceState(general));

      expect(cm.connect).not.toHaveBeenCalled();
    });

    it('does not disclose buffering when the join itself failed', async () => {
      cm.connect.mockResolvedValueOnce(null);
      const general = voiceChannel('general', [human('alice')]);

      await fire(voiceState(null), voiceState(general));

      expect(announceBuffering).not.toHaveBeenCalled();
      expect(cm.disconnect).not.toHaveBeenCalled();
    });

    it('leaves again when everyone left while the connect was in flight', async () => {
      const general = voiceChannel('general', [human('alice')]);
      cm.connect.mockImplementationOnce(
        async (g: { id: string }, channel: Channel) => {
          fake.connections.set(channel.id, {
            channelId: channel.id,
            guildId: g.id,
          });
          channel.members.delete('alice');
          channel.members.set(BOT_ID, me);
          return {};
        }
      );

      await fire(voiceState(null), voiceState(general));

      expect(cm.disconnect).toHaveBeenCalledWith('general');
      expect(announceBuffering).not.toHaveBeenCalled();
      expect(fake.connections.size).toBe(0);
    });

    it('does not end up staying in a channel that only another bot joined', async () => {
      const music = botUser('music-bot');
      const general = voiceChannel('general', [music]);

      await fire(voiceState(null, music), voiceState(general, music));

      expect(fake.connections.has('general')).toBe(false);
      expect(announceBuffering).not.toHaveBeenCalled();
    });

    // Regression: another bot joining used to make this bot connect and then
    // immediately leave again, and that in-flight connect could block a
    // human's join elsewhere in the guild. Humans are now counted first.
    it('does not even try to connect when only another bot joined', async () => {
      const music = botUser('music-bot');
      const general = voiceChannel('general', [music]);

      await fire(voiceState(null, music), voiceState(general, music));

      expect(cm.connect).not.toHaveBeenCalled();
      expect(cm.disconnect).not.toHaveBeenCalled();
    });

    it('still joins when a bot joins a channel people are already in', async () => {
      const music = botUser('music-bot');
      const general = voiceChannel('general', [human('alice'), music]);

      await fire(voiceState(null, music), voiceState(general, music));

      expect(cm.connect).toHaveBeenCalledWith(guild, general);
    });

    it('ignores a state with no guild attached', async () => {
      const general = voiceChannel('general', [human('alice')]);

      await fire(
        voiceState(null, human('alice'), null),
        voiceState(general, human('alice'), null)
      );

      expect(cm.connect).not.toHaveBeenCalled();
    });
  });

  describe('a user leaves', () => {
    it('disconnects and forgets the disclosure once no humans remain', async () => {
      alreadyConnected('general');
      const general = voiceChannel('general', [me]);

      await fire(voiceState(general), voiceState(null));

      expect(cm.disconnect).toHaveBeenCalledWith('general');
      expect(forgetAnnouncement).toHaveBeenCalledWith('general');
      expect(fake.connections.size).toBe(0);
    });

    it('moves on to a channel people are still talking in after leaving the empty one', async () => {
      alreadyConnected('general');
      const general = voiceChannel('general', [me]);
      reconcileGuild.mockImplementation(async () => {
        // Only after the emptied channel was left.
        expect(fake.connections.has('general')).toBe(false);
        return { status: 'joined', channelId: 'lounge' };
      });

      await fire(voiceState(general), voiceState(null));

      expect(reconcileGuild).toHaveBeenCalledWith(guild);
    });

    it('does not look elsewhere while it stays in its channel', async () => {
      alreadyConnected('general');
      const general = voiceChannel('general', [me, human('bob')]);

      await fire(voiceState(general), voiceState(null));

      expect(reconcileGuild).not.toHaveBeenCalled();
    });

    it('treats other bots as nobody when deciding the channel is empty', async () => {
      alreadyConnected('general');
      const general = voiceChannel('general', [me, botUser('music-bot')]);

      await fire(voiceState(general), voiceState(null));

      expect(cm.disconnect).toHaveBeenCalledWith('general');
    });

    it('stays while at least one human is still there', async () => {
      alreadyConnected('general');
      const general = voiceChannel('general', [me, human('bob')]);

      await fire(voiceState(general), voiceState(null));

      expect(cm.disconnect).not.toHaveBeenCalled();
      expect(forgetAnnouncement).not.toHaveBeenCalled();
    });

    it('does nothing for a channel the bot is not in', async () => {
      const general = voiceChannel('general', []);

      await fire(voiceState(general), voiceState(null));

      expect(cm.disconnect).not.toHaveBeenCalled();
      expect(forgetAnnouncement).not.toHaveBeenCalled();
      expect(reconcileGuild).not.toHaveBeenCalled();
    });

    it('ignores a state with no guild attached', async () => {
      alreadyConnected('general');
      const general = voiceChannel('general', [me]);

      await fire(
        voiceState(general, human('alice'), null),
        voiceState(null, human('alice'), null)
      );

      expect(cm.disconnect).not.toHaveBeenCalled();
    });
  });

  describe('a user moves', () => {
    it('follows the user when they leave the bot alone in the old channel', async () => {
      alreadyConnected('general');
      const general = voiceChannel('general', [me]);
      const lounge = voiceChannel('lounge', [human('alice')]);

      await fire(voiceState(general), voiceState(lounge));

      expect(cm.disconnect).toHaveBeenCalledWith('general');
      expect(cm.connect).toHaveBeenCalledWith(guild, lounge);
      expect(announceBuffering).toHaveBeenCalledWith(lounge);
      expect([...fake.connections.keys()]).toEqual(['lounge']);
      // It followed, so there is nothing else to look for.
      expect(reconcileGuild).not.toHaveBeenCalled();
    });

    it('stays with the people left behind instead of following', async () => {
      alreadyConnected('general');
      const general = voiceChannel('general', [me, human('bob')]);
      const lounge = voiceChannel('lounge', [human('alice')]);

      await fire(voiceState(general), voiceState(lounge));

      expect(cm.disconnect).not.toHaveBeenCalled();
      expect(cm.connect).not.toHaveBeenCalled();
      expect([...fake.connections.keys()]).toEqual(['general']);
    });

    it('leaves the emptied channel but does not follow into an excluded one', async () => {
      voiceSettingsRepository.addExclusion(guild.id, 'private');
      alreadyConnected('general');
      const general = voiceChannel('general', [me]);
      const privateRoom = voiceChannel('private', [human('alice')]);

      await fire(voiceState(general), voiceState(privateRoom));

      expect(cm.disconnect).toHaveBeenCalledWith('general');
      expect(cm.connect).not.toHaveBeenCalled();
      expect(fake.connections.size).toBe(0);
      // It could not follow: pick up whichever channel is still occupied.
      expect(reconcileGuild).toHaveBeenCalledWith(guild);
    });

    it('only refreshes activity when moving into the channel the bot is in', async () => {
      alreadyConnected('lounge');
      const general = voiceChannel('general', []);
      const lounge = voiceChannel('lounge', [me, human('bob'), human('alice')]);

      await fire(voiceState(general), voiceState(lounge));

      expect(cm.updateActivity).toHaveBeenCalledWith('lounge');
      expect(cm.connect).not.toHaveBeenCalled();
      expect(cm.disconnect).not.toHaveBeenCalled();
      expect(announceBuffering).not.toHaveBeenCalled();
      expect([...fake.connections.keys()]).toEqual(['lounge']);
    });

    it('joins the destination when the bot was not connected anywhere', async () => {
      const general = voiceChannel('general', []);
      const lounge = voiceChannel('lounge', [human('alice')]);

      await fire(voiceState(general), voiceState(lounge));

      expect(cm.disconnect).not.toHaveBeenCalled();
      expect(cm.connect).toHaveBeenCalledWith(guild, lounge);
    });

    it('treats mute/deafen updates in the same channel as no movement', async () => {
      const general = voiceChannel('general', [human('alice')]);

      await fire(voiceState(general), voiceState(general));

      expect(cm.getConnection).not.toHaveBeenCalled();
      expect(cm.connect).not.toHaveBeenCalled();
      expect(cm.disconnect).not.toHaveBeenCalled();
    });
  });

  describe("the bot's own voice state", () => {
    it('re-tracks the bot on the new channel when an admin drags it there', async () => {
      alreadyConnected('general');
      const general = voiceChannel('general', [human('bob')]);
      const lounge = voiceChannel('lounge', [me, human('alice')]);

      await fire(voiceState(general, me), voiceState(lounge, me));

      expect(cm.disconnect).toHaveBeenCalledWith('general');
      expect(forgetAnnouncement).toHaveBeenCalledWith('general');
      expect(cm.connect).toHaveBeenCalledWith(guild, lounge);
      expect(announceBuffering).toHaveBeenCalledWith(lounge);
      expect([...fake.connections.keys()]).toEqual(['lounge']);
    });

    it('only cleans up when the bot is kicked from voice', async () => {
      alreadyConnected('general');
      const general = voiceChannel('general', [human('bob')]);

      await fire(voiceState(general, me), voiceState(null, me));

      expect(cm.disconnect).toHaveBeenCalledWith('general');
      expect(forgetAnnouncement).toHaveBeenCalledWith('general');
      expect(cm.connect).not.toHaveBeenCalled();
      // An admin removed it on purpose; it must not hop to another channel.
      expect(reconcileGuild).not.toHaveBeenCalled();
    });

    it('does not reconnect into a channel with no humans', async () => {
      alreadyConnected('general');
      const general = voiceChannel('general', [human('bob')]);
      const empty = voiceChannel('empty', [me, botUser('music-bot')]);

      await fire(voiceState(general, me), voiceState(empty, me));

      expect(cm.disconnect).toHaveBeenCalledWith('general');
      expect(cm.connect).not.toHaveBeenCalled();
    });

    it('does not reconnect into an excluded channel', async () => {
      voiceSettingsRepository.addExclusion(guild.id, 'private');
      alreadyConnected('general');
      const general = voiceChannel('general', [human('bob')]);
      const privateRoom = voiceChannel('private', [me, human('alice')]);

      await fire(voiceState(general, me), voiceState(privateRoom, me));

      expect(cm.connect).not.toHaveBeenCalled();
    });

    it('does not reconnect when the guild has auto-join disabled', async () => {
      voiceSettingsRepository.setAutoJoinEnabled(guild.id, false);
      alreadyConnected('general');
      const general = voiceChannel('general', [human('bob')]);
      const lounge = voiceChannel('lounge', [me, human('alice')]);

      await fire(voiceState(general, me), voiceState(lounge, me));

      expect(cm.disconnect).toHaveBeenCalledWith('general');
      expect(cm.connect).not.toHaveBeenCalled();
    });

    it('does not reconnect when at the connection limit', async () => {
      fake.limit.value = 1;
      alreadyConnected('general');
      alreadyConnected('elsewhere', otherGuild.id);
      const general = voiceChannel('general', [human('bob')]);
      const lounge = voiceChannel('lounge', [me, human('alice')]);

      await fire(voiceState(general, me), voiceState(lounge, me));

      expect(cm.connect).not.toHaveBeenCalled();
    });

    it('does not reconnect into a channel that is already tracked', async () => {
      alreadyConnected('general');
      alreadyConnected('lounge');
      const general = voiceChannel('general', [human('bob')]);
      const lounge = voiceChannel('lounge', [me, human('alice')]);

      await fire(voiceState(general, me), voiceState(lounge, me));

      expect(cm.connect).not.toHaveBeenCalled();
    });

    it('does not announce when the reconnect fails', async () => {
      cm.connect.mockResolvedValueOnce(null);
      alreadyConnected('general');
      const general = voiceChannel('general', [human('bob')]);
      const lounge = voiceChannel('lounge', [me, human('alice')]);

      await fire(voiceState(general, me), voiceState(lounge, me));

      expect(cm.connect).toHaveBeenCalled();
      expect(announceBuffering).not.toHaveBeenCalled();
    });

    it('still forgets the disclosure for an untracked old channel', async () => {
      const general = voiceChannel('general', [human('bob')]);

      await fire(voiceState(general, me), voiceState(null, me));

      expect(cm.disconnect).not.toHaveBeenCalled();
      expect(forgetAnnouncement).toHaveBeenCalledWith('general');
    });

    it('ignores the bot joining voice (the connect call handles that)', async () => {
      const general = voiceChannel('general', [me, human('alice')]);

      await fire(voiceState(null, me), voiceState(general, me));

      expect(cm.connect).not.toHaveBeenCalled();
      expect(cm.disconnect).not.toHaveBeenCalled();
      expect(forgetAnnouncement).not.toHaveBeenCalled();
    });

    it('ignores the bot being muted or deafened in place', async () => {
      alreadyConnected('general');
      const general = voiceChannel('general', [me, human('alice')]);

      await fire(voiceState(general, me), voiceState(general, me));

      expect(cm.disconnect).not.toHaveBeenCalled();
      expect(forgetAnnouncement).not.toHaveBeenCalled();
      expect(fake.connections.has('general')).toBe(true);
    });
  });
});
