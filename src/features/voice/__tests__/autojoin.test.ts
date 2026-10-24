import Database from 'better-sqlite3';
import {
  ChannelType,
  type ChatInputCommandInteraction,
  type EmbedBuilder,
  MessageFlags,
} from 'discord.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `/voice autojoin` is the server's consent switch for the bot keeping
 * everyone's audio. These run the real repository against in-memory SQLite so
 * "the setting was saved" is checked against the table, not a mock, while the
 * voice connections themselves are faked.
 */
const db = new Database(':memory:');

vi.mock('../../../infrastructure/database/connection.js', () => ({
  database: db,
}));

vi.mock('../../../shared/utils/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
  getErrorMessage: (e: unknown) => String(e),
}));

const getAllConnections = vi.hoisted(() => vi.fn());
const getConnection = vi.hoisted(() => vi.fn());
const disconnect = vi.hoisted(() => vi.fn());

vi.mock('../recording/connectionManager.js', () => ({
  connectionManager: { getAllConnections, getConnection, disconnect },
}));

const { executeAutoJoinCommand } = await import('../application/autojoin.js');
const { voiceSettingsRepository } =
  await import('../repositories/voiceSettingsRepository.js');
const { guildSettingsRepository } =
  await import('../../../infrastructure/guildSettings/index.js');
const { t } = await import('../../../locales/index.js');
const { env } = await import('../../../config/index.js');
const { COLORS } = await import('../../../shared/utils/constants/index.js');
const { up: settingsTables } =
  await import('../../../infrastructure/database/migrations/003_settings.js');
const { up: voiceAutoJoinTables } =
  await import('../../../infrastructure/database/migrations/007_voice_autojoin.js');
const { up: announcementColumn } =
  await import('../../../infrastructure/database/migrations/008_announcement_channel.js');

const GUILD = 'guild-1';

function voiceChannel(id: string, type: ChannelType = ChannelType.GuildVoice) {
  return { id, type };
}

function connectionInfo(channelId: string, guildId: string) {
  return { channelId, guildId };
}

function createInteraction(
  options: {
    subcommand?: string;
    channel?: { id: string; type: ChannelType };
    guildId?: string | null;
    locale?: string;
  } = {}
) {
  const guildId = options.guildId === undefined ? GUILD : options.guildId;
  return {
    guild: guildId ? { id: guildId } : null,
    guildId,
    locale: options.locale ?? 'en-US',
    options: {
      getSubcommand: vi.fn(() => options.subcommand ?? 'enable'),
      getChannel: vi.fn(() => options.channel ?? null),
    },
    reply: vi.fn().mockResolvedValue(undefined),
  } as unknown as ChatInputCommandInteraction;
}

/** The single ephemeral embed every branch of this command answers with. */
function replyEmbed(interaction: ChatInputCommandInteraction) {
  expect(interaction.reply).toHaveBeenCalledTimes(1);
  const payload = vi.mocked(interaction.reply).mock.calls[0][0] as {
    embeds: EmbedBuilder[];
    flags: number;
  };
  expect(payload.flags).toBe(MessageFlags.Ephemeral);
  expect(payload.embeds).toHaveLength(1);
  return payload.embeds[0].toJSON();
}

const minutes = () => Math.round(env.AUDIO_BUFFER_DURATION / 60);

describe('/voice autojoin', () => {
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

    getAllConnections.mockReturnValue(new Map());
    getConnection.mockReturnValue(undefined);
    disconnect.mockResolvedValue(undefined);
  });

  describe('outside a guild', () => {
    it('refuses in DMs without touching any setting', async () => {
      const interaction = createInteraction({
        guildId: null,
        subcommand: 'disable',
      });

      await executeAutoJoinCommand(interaction);

      const embed = replyEmbed(interaction);
      expect(embed.title).toBe(t('common.error', 'en'));
      expect(embed.description).toBe(t('common.guildOnly', 'en'));
      expect(embed.color).toBe(COLORS.ERROR);
      expect(interaction.options.getSubcommand).not.toHaveBeenCalled();
      expect(disconnect).not.toHaveBeenCalled();
    });
  });

  describe('enable / disable', () => {
    it('persists "disabled" and tells the admin no audio is kept any more', async () => {
      const interaction = createInteraction({ subcommand: 'disable' });

      await executeAutoJoinCommand(interaction);

      expect(voiceSettingsRepository.isAutoJoinEnabled(GUILD)).toBe(false);
      expect(guildSettingsRepository.get(GUILD)?.voice_autojoin_enabled).toBe(
        0
      );

      const embed = replyEmbed(interaction);
      expect(embed.title).toBe(t('record.autojoin.title', 'en'));
      expect(embed.description).toBe(t('record.autojoin.disabled', 'en'));
      expect(embed.color).toBe(COLORS.WARNING);
    });

    it('persists "enabled" again and states the buffer window in minutes', async () => {
      voiceSettingsRepository.setAutoJoinEnabled(GUILD, false);
      const interaction = createInteraction({ subcommand: 'enable' });

      await executeAutoJoinCommand(interaction);

      expect(voiceSettingsRepository.isAutoJoinEnabled(GUILD)).toBe(true);
      const embed = replyEmbed(interaction);
      expect(embed.description).toBe(
        t('record.autojoin.enabled', 'en', { minutes: minutes() })
      );
      expect(embed.color).toBe(COLORS.SUCCESS);
    });

    it('drops every live connection in this guild when disabled, and only this guild', async () => {
      getAllConnections.mockReturnValue(
        new Map([
          ['voice-a', connectionInfo('voice-a', GUILD)],
          ['voice-other', connectionInfo('voice-other', 'guild-2')],
          ['voice-b', connectionInfo('voice-b', GUILD)],
        ])
      );
      const interaction = createInteraction({ subcommand: 'disable' });

      await executeAutoJoinCommand(interaction);

      expect(disconnect).toHaveBeenCalledTimes(2);
      expect(disconnect).toHaveBeenCalledWith('voice-a');
      expect(disconnect).toHaveBeenCalledWith('voice-b');
      expect(disconnect).not.toHaveBeenCalledWith('voice-other');
      // The admin is told it is off only once buffering has actually stopped.
      const lastDisconnect = Math.max(...disconnect.mock.invocationCallOrder);
      expect(
        vi.mocked(interaction.reply).mock.invocationCallOrder[0]
      ).toBeGreaterThan(lastDisconnect);
    });

    it('leaves live connections alone when enabling', async () => {
      getAllConnections.mockReturnValue(
        new Map([['voice-a', connectionInfo('voice-a', GUILD)]])
      );

      await executeAutoJoinCommand(createInteraction({ subcommand: 'enable' }));

      expect(disconnect).not.toHaveBeenCalled();
    });

    it('does not change another guild when one guild opts out', async () => {
      await executeAutoJoinCommand(
        createInteraction({ subcommand: 'disable' })
      );

      expect(voiceSettingsRepository.isAutoJoinEnabled('guild-2')).toBe(true);
    });

    it('answers in the guild language when one is configured', async () => {
      guildSettingsRepository.setLanguage(GUILD, 'ja');
      const interaction = createInteraction({
        subcommand: 'disable',
        locale: 'en-US',
      });

      await executeAutoJoinCommand(interaction);

      const embed = replyEmbed(interaction);
      expect(embed.title).toBe(t('record.autojoin.title', 'ja'));
      expect(embed.description).toBe(t('record.autojoin.disabled', 'ja'));
    });
  });

  describe('exclude', () => {
    it('stores the exclusion and confirms which channel is skipped', async () => {
      const interaction = createInteraction({
        subcommand: 'exclude',
        channel: voiceChannel('voice-9'),
      });

      await executeAutoJoinCommand(interaction);

      expect(voiceSettingsRepository.isChannelExcluded(GUILD, 'voice-9')).toBe(
        true
      );
      expect(voiceSettingsRepository.mayAutoJoin(GUILD, 'voice-9')).toBe(false);
      // Excluding one channel must not switch the whole guild off.
      expect(voiceSettingsRepository.isAutoJoinEnabled(GUILD)).toBe(true);

      const embed = replyEmbed(interaction);
      expect(embed.description).toBe(
        t('record.autojoin.excluded', 'en', { channel: 'voice-9' })
      );
      expect(embed.color).toBe(COLORS.WARNING);
    });

    it('leaves the channel immediately when the bot is already buffering it', async () => {
      getConnection.mockImplementation((id: string) =>
        id === 'voice-9' ? connectionInfo('voice-9', GUILD) : undefined
      );

      await executeAutoJoinCommand(
        createInteraction({
          subcommand: 'exclude',
          channel: voiceChannel('voice-9'),
        })
      );

      expect(disconnect).toHaveBeenCalledTimes(1);
      expect(disconnect).toHaveBeenCalledWith('voice-9');
    });

    it('does not disconnect anything when the bot is not in that channel', async () => {
      await executeAutoJoinCommand(
        createInteraction({
          subcommand: 'exclude',
          channel: voiceChannel('voice-9'),
        })
      );

      expect(getConnection).toHaveBeenCalledWith('voice-9');
      expect(disconnect).not.toHaveBeenCalled();
    });

    it('accepts stage channels', async () => {
      const interaction = createInteraction({
        subcommand: 'exclude',
        channel: voiceChannel('stage-1', ChannelType.GuildStageVoice),
      });

      await executeAutoJoinCommand(interaction);

      expect(voiceSettingsRepository.listExclusions(GUILD)).toEqual([
        'stage-1',
      ]);
      expect(replyEmbed(interaction).color).toBe(COLORS.WARNING);
    });

    it('is idempotent when the same channel is excluded twice', async () => {
      const channel = voiceChannel('voice-9');

      await executeAutoJoinCommand(
        createInteraction({ subcommand: 'exclude', channel })
      );
      const second = createInteraction({ subcommand: 'exclude', channel });
      await executeAutoJoinCommand(second);

      expect(voiceSettingsRepository.listExclusions(GUILD)).toEqual([
        'voice-9',
      ]);
      expect(replyEmbed(second).color).toBe(COLORS.WARNING);
    });

    it('rejects a non-voice channel and stores nothing', async () => {
      const interaction = createInteraction({
        subcommand: 'exclude',
        channel: voiceChannel('text-1', ChannelType.GuildText),
      });

      await executeAutoJoinCommand(interaction);

      const embed = replyEmbed(interaction);
      expect(embed.title).toBe(t('common.error', 'en'));
      expect(embed.description).toBe(t('record.errors.notInVoiceDesc', 'en'));
      expect(embed.color).toBe(COLORS.ERROR);
      expect(voiceSettingsRepository.listExclusions(GUILD)).toEqual([]);
      expect(disconnect).not.toHaveBeenCalled();
    });

    it('reads the channel option as required', async () => {
      const interaction = createInteraction({
        subcommand: 'exclude',
        channel: voiceChannel('voice-9'),
      });

      await executeAutoJoinCommand(interaction);

      expect(interaction.options.getChannel).toHaveBeenCalledWith(
        'channel',
        true
      );
    });
  });

  describe('include', () => {
    it('removes an existing exclusion and confirms the channel is covered again', async () => {
      voiceSettingsRepository.addExclusion(GUILD, 'voice-9');
      const interaction = createInteraction({
        subcommand: 'include',
        channel: voiceChannel('voice-9'),
      });

      await executeAutoJoinCommand(interaction);

      expect(voiceSettingsRepository.isChannelExcluded(GUILD, 'voice-9')).toBe(
        false
      );
      const embed = replyEmbed(interaction);
      expect(embed.title).toBe(t('record.autojoin.title', 'en'));
      expect(embed.description).toBe(
        t('record.autojoin.included', 'en', { channel: 'voice-9' })
      );
      expect(embed.color).toBe(COLORS.SUCCESS);
    });

    it('reports an error when the channel was never excluded', async () => {
      const interaction = createInteraction({
        subcommand: 'include',
        channel: voiceChannel('voice-9'),
      });

      await executeAutoJoinCommand(interaction);

      const embed = replyEmbed(interaction);
      expect(embed.title).toBe(t('common.error', 'en'));
      expect(embed.description).toBe(
        t('record.autojoin.notExcluded', 'en', { channel: 'voice-9' })
      );
      expect(embed.color).toBe(COLORS.ERROR);
    });

    it("does not lift another guild's exclusion of the same channel id", async () => {
      voiceSettingsRepository.addExclusion('guild-2', 'voice-9');

      const interaction = createInteraction({
        subcommand: 'include',
        channel: voiceChannel('voice-9'),
      });
      await executeAutoJoinCommand(interaction);

      expect(replyEmbed(interaction).color).toBe(COLORS.ERROR);
      expect(
        voiceSettingsRepository.isChannelExcluded('guild-2', 'voice-9')
      ).toBe(true);
    });

    it('never joins or leaves a channel by itself', async () => {
      voiceSettingsRepository.addExclusion(GUILD, 'voice-9');

      await executeAutoJoinCommand(
        createInteraction({
          subcommand: 'include',
          channel: voiceChannel('voice-9'),
        })
      );

      expect(disconnect).not.toHaveBeenCalled();
    });

    it('rejects a non-voice channel without touching the exclusion list', async () => {
      voiceSettingsRepository.addExclusion(GUILD, 'voice-9');
      const interaction = createInteraction({
        subcommand: 'include',
        channel: voiceChannel('category-1', ChannelType.GuildCategory),
      });

      await executeAutoJoinCommand(interaction);

      expect(replyEmbed(interaction).description).toBe(
        t('record.errors.notInVoiceDesc', 'en')
      );
      expect(voiceSettingsRepository.listExclusions(GUILD)).toEqual([
        'voice-9',
      ]);
    });
  });
});
