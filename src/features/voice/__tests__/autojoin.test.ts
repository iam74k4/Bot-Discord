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

const reconcileGuild = vi.hoisted(() => vi.fn());
vi.mock('../application/reconcile.js', () => ({ reconcileGuild }));

const releaseCooldown = vi.hoisted(() => vi.fn());
vi.mock('../../../middleware/index.js', () => ({ releaseCooldown }));

const logAuditAction = vi.hoisted(() => vi.fn());
vi.mock('../../../infrastructure/audit/index.js', () => ({ logAuditAction }));

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
      // Like discord.js: a missing option is null, or throws when required.
      getChannel: vi.fn((name: string, required?: boolean) => {
        if (!options.channel && required) {
          throw new TypeError(`Required option "${name}" not found.`);
        }
        return options.channel ?? null;
      }),
    },
    user: { id: 'admin-1' },
    client: { id: 'client' },
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
const enableCommand = '`/voice autojoin enable`';

/**
 * Make each disconnect settle a few microtasks after it is called and record
 * when it does, so "replied after the disconnect finished" can be told apart
 * from "replied after the disconnect was merely started".
 */
function trackDisconnectCompletion(): string[] {
  const finished: string[] = [];
  disconnect.mockImplementation(async (channelId: string) => {
    await Promise.resolve();
    await Promise.resolve();
    finished.push(channelId);
  });
  return finished;
}

/** Capture which disconnects had finished at the moment the reply went out. */
function snapshotAtReply(
  interaction: ChatInputCommandInteraction,
  finished: string[]
): () => string[] | undefined {
  let seen: string[] | undefined;
  vi.mocked(interaction.reply).mockImplementation(async () => {
    seen = [...finished];
    return undefined as never;
  });
  return () => seen;
}

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
    reconcileGuild.mockResolvedValue({ status: 'none' });
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
      // Nothing was connected, so nothing was discarded.
      expect(embed.description).toBe(
        t('record.autojoin.disabled', 'en', { command: enableCommand })
      );
      expect(embed.color).toBe(COLORS.SUCCESS);
    });

    it('says the kept audio was discarded when disabling dropped a connection', async () => {
      getAllConnections.mockReturnValue(
        new Map([['voice-a', connectionInfo('voice-a', GUILD)]])
      );
      const interaction = createInteraction({ subcommand: 'disable' });

      await executeAutoJoinCommand(interaction);

      expect(replyEmbed(interaction).description).toBe(
        `${t('record.autojoin.disabled', 'en', { command: enableCommand })}\n\n${t(
          'record.autojoin.disabledDropped',
          'en'
        )}`
      );
    });

    it('persists "enabled" again, states the buffer window and says it waits for people', async () => {
      voiceSettingsRepository.setAutoJoinEnabled(GUILD, false);
      const interaction = createInteraction({ subcommand: 'enable' });

      await executeAutoJoinCommand(interaction);

      expect(voiceSettingsRepository.isAutoJoinEnabled(GUILD)).toBe(true);
      const embed = replyEmbed(interaction);
      expect(embed.description).toBe(
        `${t('record.autojoin.enabled', 'en', { minutes: minutes() })}\n\n${t(
          'record.autojoin.waitingForMembers',
          'en'
        )}`
      );
      expect(embed.color).toBe(COLORS.SUCCESS);
    });

    it('joins an occupied channel as soon as auto-join is turned on', async () => {
      voiceSettingsRepository.setAutoJoinEnabled(GUILD, false);
      reconcileGuild.mockImplementation(async () => {
        // The setting is saved before the bot looks for a channel.
        expect(voiceSettingsRepository.isAutoJoinEnabled(GUILD)).toBe(true);
        return { status: 'joined', channelId: 'voice-3' };
      });
      const interaction = createInteraction({ subcommand: 'enable' });

      await executeAutoJoinCommand(interaction);

      expect(reconcileGuild).toHaveBeenCalledWith(interaction.guild);
      expect(replyEmbed(interaction).description).toContain(
        t('record.autojoin.joinedNow', 'en', { channel: 'voice-3' })
      );
    });

    it('says nothing is kept yet when the bot holds the slot only for reading aloud', async () => {
      reconcileGuild.mockResolvedValue({ status: 'already', channelId: 'v' });
      getConnection.mockImplementation((id: string) =>
        id === 'v'
          ? { channelId: 'v', guildId: GUILD, receiving: false }
          : undefined
      );
      const interaction = createInteraction({ subcommand: 'enable' });

      await executeAutoJoinCommand(interaction);

      expect(replyEmbed(interaction).description).toBe(
        `${t('record.autojoin.enabled', 'en', { minutes: minutes() })}\n\n${t(
          'record.autojoin.alreadyReadOnly',
          'en',
          { channel: 'v' }
        )}`
      );
    });

    it('records who turned it on or off in the audit trail, in the server language', async () => {
      const enable = createInteraction({ subcommand: 'enable' });
      await executeAutoJoinCommand(enable);
      const disable = createInteraction({ subcommand: 'disable' });
      await executeAutoJoinCommand(disable);

      // No language configured and not a Community server: Japanese.
      expect(logAuditAction.mock.calls).toEqual([
        [
          enable.client,
          GUILD,
          'admin-1',
          'SETTINGS_CHANGE',
          undefined,
          t('record.audit.autoJoinEnabled', 'ja', {
            via: t('record.audit.viaCommand', 'ja', {
              command: '/voice autojoin enable',
            }),
          }),
        ],
        [
          disable.client,
          GUILD,
          'admin-1',
          'SETTINGS_CHANGE',
          undefined,
          t('record.audit.autoJoinDisabled', 'ja', {
            via: t('record.audit.viaCommand', 'ja', {
              command: '/voice autojoin disable',
            }),
          }),
        ],
      ]);
    });

    it('says nothing more when the bot is already in a channel of the server', async () => {
      reconcileGuild.mockResolvedValue({ status: 'already', channelId: 'v' });
      const interaction = createInteraction({ subcommand: 'enable' });

      await executeAutoJoinCommand(interaction);

      expect(replyEmbed(interaction).description).toBe(
        t('record.autojoin.enabled', 'en', { minutes: minutes() })
      );
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
    });

    it('tells the admin it is off only after every disconnect has finished', async () => {
      getAllConnections.mockReturnValue(
        new Map([
          ['voice-a', connectionInfo('voice-a', GUILD)],
          ['voice-b', connectionInfo('voice-b', GUILD)],
        ])
      );
      const finished = trackDisconnectCompletion();
      const interaction = createInteraction({ subcommand: 'disable' });
      const seenAtReply = snapshotAtReply(interaction, finished);

      await executeAutoJoinCommand(interaction);

      // Started-but-unfinished disconnects would still be buffering audio.
      expect(seenAtReply()).toEqual(['voice-a', 'voice-b']);
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
      expect(embed.description).toBe(
        t('record.autojoin.disabled', 'ja', { command: enableCommand })
      );
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
      expect(embed.color).toBe(COLORS.SUCCESS);
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

    it('says the bot left and moves on to another occupied channel', async () => {
      getConnection.mockImplementation((id: string) =>
        id === 'voice-9' ? connectionInfo('voice-9', GUILD) : undefined
      );
      const interaction = createInteraction({
        subcommand: 'exclude',
        channel: voiceChannel('voice-9'),
      });

      await executeAutoJoinCommand(interaction);

      expect(reconcileGuild).toHaveBeenCalledWith(interaction.guild);
      expect(replyEmbed(interaction).description).toBe(
        `${t('record.autojoin.excluded', 'en', { channel: 'voice-9' })}\n\n${t(
          'record.autojoin.excludedLeft',
          'en',
          { channel: 'voice-9' }
        )}`
      );
    });

    it('confirms the exclusion only after the bot has actually left', async () => {
      getConnection.mockReturnValue(connectionInfo('voice-9', GUILD));
      const finished = trackDisconnectCompletion();
      const interaction = createInteraction({
        subcommand: 'exclude',
        channel: voiceChannel('voice-9'),
      });
      const seenAtReply = snapshotAtReply(interaction, finished);

      await executeAutoJoinCommand(interaction);

      expect(seenAtReply()).toEqual(['voice-9']);
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
      expect(reconcileGuild).not.toHaveBeenCalled();
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
      expect(replyEmbed(interaction).color).toBe(COLORS.SUCCESS);
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
      const embed = replyEmbed(second);
      expect(embed.description).toBe(
        t('record.autojoin.alreadyExcluded', 'en', { channel: 'voice-9' })
      );
      expect(embed.color).toBe(COLORS.INFO);
      // Only the change that changed something is on the audit trail.
      expect(logAuditAction).toHaveBeenCalledTimes(1);
      expect(logAuditAction.mock.calls[0][5]).toBe(
        t('record.audit.channelExcluded', 'ja', {
          channel: 'voice-9',
          via: t('record.audit.viaCommand', 'ja', {
            command: '/voice autojoin exclude',
          }),
        })
      );
    });

    it('rejects a non-voice channel and stores nothing', async () => {
      const interaction = createInteraction({
        subcommand: 'exclude',
        channel: voiceChannel('text-1', ChannelType.GuildText),
      });

      await executeAutoJoinCommand(interaction);

      const embed = replyEmbed(interaction);
      expect(embed.title).toBe(t('common.error', 'en'));
      expect(embed.description).toBe(t('record.errors.notVoiceChannel', 'en'));
      expect(embed.color).toBe(COLORS.ERROR);
      expect(voiceSettingsRepository.listExclusions(GUILD)).toEqual([]);
      expect(disconnect).not.toHaveBeenCalled();
      expect(releaseCooldown).toHaveBeenCalledWith(interaction);
    });

    it('fails loudly instead of excluding nothing when the channel option is missing', async () => {
      const interaction = createInteraction({ subcommand: 'exclude' });

      await expect(executeAutoJoinCommand(interaction)).rejects.toThrow();

      // Nothing was stored and nothing claimed success; the command router
      // answers the admin with its generic error instead.
      expect(voiceSettingsRepository.listExclusions(GUILD)).toEqual([]);
      expect(interaction.reply).not.toHaveBeenCalled();
      expect(disconnect).not.toHaveBeenCalled();
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
        `${t('record.autojoin.included', 'en', { channel: 'voice-9' })}\n\n${t(
          'record.autojoin.waitingForMembers',
          'en'
        )}`
      );
      expect(embed.color).toBe(COLORS.SUCCESS);
    });

    it('says plainly, not as an error, when the channel was never excluded', async () => {
      const interaction = createInteraction({
        subcommand: 'include',
        channel: voiceChannel('voice-9'),
      });

      await executeAutoJoinCommand(interaction);

      const embed = replyEmbed(interaction);
      expect(embed.title).toBe(t('record.autojoin.title', 'en'));
      expect(embed.description).toBe(
        t('record.autojoin.notExcluded', 'en', { channel: 'voice-9' })
      );
      expect(embed.color).toBe(COLORS.INFO);
      expect(reconcileGuild).not.toHaveBeenCalled();
    });

    it('warns that auto-join is still off for the whole server', async () => {
      voiceSettingsRepository.setAutoJoinEnabled(GUILD, false);
      voiceSettingsRepository.addExclusion(GUILD, 'voice-9');
      const interaction = createInteraction({
        subcommand: 'include',
        channel: voiceChannel('voice-9'),
      });

      await executeAutoJoinCommand(interaction);

      const embed = replyEmbed(interaction);
      expect(embed.description).toBe(
        `${t('record.autojoin.included', 'en', { channel: 'voice-9' })}\n\n${t(
          'record.autojoin.includedWhileOff',
          'en',
          { command: enableCommand }
        )}`
      );
      expect(embed.color).toBe(COLORS.WARNING);
      expect(reconcileGuild).not.toHaveBeenCalled();
    });

    it("does not lift another guild's exclusion of the same channel id", async () => {
      voiceSettingsRepository.addExclusion('guild-2', 'voice-9');

      const interaction = createInteraction({
        subcommand: 'include',
        channel: voiceChannel('voice-9'),
      });
      await executeAutoJoinCommand(interaction);

      expect(replyEmbed(interaction).description).toBe(
        t('record.autojoin.notExcluded', 'en', { channel: 'voice-9' })
      );
      expect(
        voiceSettingsRepository.isChannelExcluded('guild-2', 'voice-9')
      ).toBe(true);
    });

    it('joins the re-included channel right away when people are in it', async () => {
      voiceSettingsRepository.addExclusion(GUILD, 'voice-9');
      reconcileGuild.mockResolvedValue({
        status: 'joined',
        channelId: 'voice-9',
      });
      const interaction = createInteraction({
        subcommand: 'include',
        channel: voiceChannel('voice-9'),
      });

      await executeAutoJoinCommand(interaction);

      expect(reconcileGuild).toHaveBeenCalledWith(interaction.guild);
      expect(disconnect).not.toHaveBeenCalled();
      expect(replyEmbed(interaction).description).toContain(
        t('record.autojoin.joinedNow', 'en', { channel: 'voice-9' })
      );
    });

    it('rejects a non-voice channel without touching the exclusion list', async () => {
      voiceSettingsRepository.addExclusion(GUILD, 'voice-9');
      const interaction = createInteraction({
        subcommand: 'include',
        channel: voiceChannel('category-1', ChannelType.GuildCategory),
      });

      await executeAutoJoinCommand(interaction);

      expect(replyEmbed(interaction).description).toBe(
        t('record.errors.notVoiceChannel', 'en')
      );
      expect(voiceSettingsRepository.listExclusions(GUILD)).toEqual([
        'voice-9',
      ]);
    });
  });

  /**
   * A failed write must never be reported as saved. The error is left to
   * propagate without a reply so the command router can still `reply` with
   * its generic "unexpected error" embed.
   */
  describe('when the setting cannot be saved', () => {
    it.each(['enable', 'disable'])(
      'does not confirm "%s" and leaves the reply to the error handler',
      async (subcommand) => {
        db.exec('DROP TABLE guild_settings');
        const interaction = createInteraction({ subcommand });

        await expect(executeAutoJoinCommand(interaction)).rejects.toThrow(
          /guild_settings/
        );

        expect(interaction.reply).not.toHaveBeenCalled();
      }
    );

    it('does not confirm an exclusion it could not store, and does not leave', async () => {
      db.exec('DROP TABLE voice_autojoin_exclusions');
      getConnection.mockReturnValue(connectionInfo('voice-9', GUILD));
      const interaction = createInteraction({
        subcommand: 'exclude',
        channel: voiceChannel('voice-9'),
      });

      await expect(executeAutoJoinCommand(interaction)).rejects.toThrow(
        /voice_autojoin_exclusions/
      );

      expect(interaction.reply).not.toHaveBeenCalled();
      // Leaving without a stored exclusion would just rejoin on the next
      // voice event while looking like the exclusion worked.
      expect(disconnect).not.toHaveBeenCalled();
    });

    it('does not report "not excluded" when the lookup itself failed', async () => {
      db.exec('DROP TABLE voice_autojoin_exclusions');
      const interaction = createInteraction({
        subcommand: 'include',
        channel: voiceChannel('voice-9'),
      });

      await expect(executeAutoJoinCommand(interaction)).rejects.toThrow(
        /voice_autojoin_exclusions/
      );

      expect(interaction.reply).not.toHaveBeenCalled();
    });
  });
});
