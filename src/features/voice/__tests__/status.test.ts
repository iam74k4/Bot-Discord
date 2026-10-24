import Database from 'better-sqlite3';
import {
  type ChatInputCommandInteraction,
  type EmbedBuilder,
  MessageFlags,
} from 'discord.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `/voice status` answers "is my channel being kept, and how full is the
 * recorder". Settings come from the real repository on in-memory SQLite;
 * connection state is faked.
 */
const db = new Database(':memory:');

vi.mock('../../../infrastructure/database/connection.js', () => ({
  database: db,
}));

vi.mock('../../../shared/utils/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
  getErrorMessage: (e: unknown) => String(e),
}));

const getConnectionCount = vi.hoisted(() => vi.fn());
const getConnection = vi.hoisted(() => vi.fn());

vi.mock('../recording/connectionManager.js', () => ({
  connectionManager: { getConnectionCount, getConnection },
}));

const { executeStatusCommand } = await import('../application/status.js');
const { voiceSettingsRepository } =
  await import('../repositories/voiceSettingsRepository.js');
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

type Member = { voice: { channelId: string | null } } | { user: object } | null;

function createInteraction(
  options: {
    guildId?: string | null;
    member?: Member;
    locale?: string;
  } = {}
) {
  return {
    guildId: options.guildId === undefined ? GUILD : options.guildId,
    locale: options.locale ?? 'en-US',
    member:
      options.member === undefined
        ? { voice: { channelId: null } }
        : options.member,
    reply: vi.fn().mockResolvedValue(undefined),
  } as unknown as ChatInputCommandInteraction;
}

function inVoice(channelId: string | null): Member {
  return { voice: { channelId } };
}

function statusEmbed(interaction: ChatInputCommandInteraction) {
  expect(interaction.reply).toHaveBeenCalledTimes(1);
  const payload = vi.mocked(interaction.reply).mock.calls[0][0] as {
    embeds: EmbedBuilder[];
    flags: number;
  };
  // Status may reveal which channels are excluded; it is for the caller only.
  expect(payload.flags).toBe(MessageFlags.Ephemeral);
  expect(payload.embeds).toHaveLength(1);
  return payload.embeds[0].toJSON();
}

function fieldValue(
  embed: ReturnType<EmbedBuilder['toJSON']>,
  name: string
): string | undefined {
  return embed.fields?.find((field) => field.name === name)?.value;
}

/** The line under the hint that answers "is my channel being kept?". */
function currentChannelLine(
  embed: ReturnType<EmbedBuilder['toJSON']>,
  locale: 'en' | 'ja' = 'en'
): string | undefined {
  const prefix = `${t('record.statusHint', locale)}\n\n`;
  expect(embed.description?.startsWith(prefix)).toBe(true);
  return embed.description?.slice(prefix.length);
}

describe('/voice status', () => {
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

    getConnectionCount.mockReturnValue(0);
    getConnection.mockReturnValue(undefined);
  });

  describe('capacity fields', () => {
    it('reports active connections against the configured limit and buffer window', async () => {
      getConnectionCount.mockReturnValue(3);
      const interaction = createInteraction();

      await executeStatusCommand(interaction);

      const embed = statusEmbed(interaction);
      expect(embed.color).toBe(COLORS.INFO);
      expect(embed.fields).toHaveLength(5);
      const [active, limit, buffer] = embed.fields ?? [];
      expect(active.value).toBe('3');
      expect(limit.value).toBe(String(env.MAX_CONCURRENT_VC_CONNECTIONS));
      expect(buffer.name).toBe(t('record.bufferWindow', 'en'));
      expect(buffer.value).toBe(
        `${Math.round(env.AUDIO_BUFFER_DURATION / 60)} min`
      );
      expect(embed.fields?.every((field) => field.inline)).toBe(true);
    });

    it('shows auto-join as on for a guild that never opted out', async () => {
      const interaction = createInteraction();

      await executeStatusCommand(interaction);

      const embed = statusEmbed(interaction);
      expect(fieldValue(embed, t('record.autojoin.title', 'en'))).toBe(
        t('record.autojoin.statusEnabled', 'en')
      );
      expect(fieldValue(embed, t('record.autojoin.exclusionCount', 'en'))).toBe(
        '0'
      );
    });

    it('shows auto-join as off and counts exclusions from the database', async () => {
      voiceSettingsRepository.setAutoJoinEnabled(GUILD, false);
      voiceSettingsRepository.addExclusion(GUILD, 'voice-1');
      voiceSettingsRepository.addExclusion(GUILD, 'voice-2');
      // Another guild's exclusions are not this guild's business.
      voiceSettingsRepository.addExclusion('guild-2', 'voice-3');
      const interaction = createInteraction();

      await executeStatusCommand(interaction);

      const embed = statusEmbed(interaction);
      expect(fieldValue(embed, t('record.autojoin.title', 'en'))).toBe(
        t('record.autojoin.statusDisabled', 'en')
      );
      expect(fieldValue(embed, t('record.autojoin.exclusionCount', 'en'))).toBe(
        '2'
      );
    });
  });

  describe("caller's current channel", () => {
    it('says the channel is being kept when the bot is connected to it', async () => {
      getConnection.mockImplementation((id: string) =>
        id === 'voice-1' ? { channelId: 'voice-1' } : undefined
      );
      const interaction = createInteraction({ member: inVoice('voice-1') });

      await executeStatusCommand(interaction);

      expect(currentChannelLine(statusEmbed(interaction))).toBe(
        t('record.autojoin.currentChannelBuffered', 'en')
      );
    });

    it('says the channel is excluded, even while a connection still exists', async () => {
      voiceSettingsRepository.addExclusion(GUILD, 'voice-1');
      getConnection.mockReturnValue({ channelId: 'voice-1' });
      const interaction = createInteraction({ member: inVoice('voice-1') });

      await executeStatusCommand(interaction);

      expect(currentChannelLine(statusEmbed(interaction))).toBe(
        t('record.autojoin.currentChannelExcluded', 'en')
      );
    });

    it('says nothing is kept when the bot is not in the caller channel', async () => {
      const interaction = createInteraction({ member: inVoice('voice-1') });

      await executeStatusCommand(interaction);

      expect(getConnection).toHaveBeenCalledWith('voice-1');
      expect(currentChannelLine(statusEmbed(interaction))).toBe(
        t('record.autojoin.currentChannelNone', 'en')
      );
    });

    it('says the caller is not in voice when they are not', async () => {
      const interaction = createInteraction({ member: inVoice(null) });

      await executeStatusCommand(interaction);

      expect(getConnection).not.toHaveBeenCalled();
      expect(currentChannelLine(statusEmbed(interaction))).toBe(
        t('record.autojoin.currentChannelNone', 'en')
      );
    });

    it('treats an uncached API member (no voice state) as not in voice', async () => {
      const interaction = createInteraction({ member: { user: {} } });

      await executeStatusCommand(interaction);

      expect(getConnection).not.toHaveBeenCalled();
      expect(currentChannelLine(statusEmbed(interaction))).toBe(
        t('record.autojoin.currentChannelNone', 'en')
      );
    });
  });

  describe('outside a guild', () => {
    it('still answers, with auto-join off and no exclusions', async () => {
      getConnectionCount.mockReturnValue(2);
      const interaction = createInteraction({ guildId: null, member: null });

      await executeStatusCommand(interaction);

      const embed = statusEmbed(interaction);
      expect(embed.fields?.[0].value).toBe('2');
      expect(fieldValue(embed, t('record.autojoin.title', 'en'))).toBe(
        t('record.autojoin.statusDisabled', 'en')
      );
      expect(fieldValue(embed, t('record.autojoin.exclusionCount', 'en'))).toBe(
        '0'
      );
      expect(currentChannelLine(embed)).toBe(
        t('record.autojoin.currentChannelNone', 'en')
      );
    });

    it('does not look up a voice channel without a guild to scope it', async () => {
      const interaction = createInteraction({
        guildId: null,
        member: inVoice('voice-1'),
      });

      await executeStatusCommand(interaction);

      expect(getConnection).not.toHaveBeenCalled();
      expect(currentChannelLine(statusEmbed(interaction))).toBe(
        t('record.autojoin.currentChannelNone', 'en')
      );
    });
  });

  describe('localisation', () => {
    it('renders every translated label in Japanese for a Japanese client', async () => {
      const en = createInteraction({ locale: 'en-US' });
      const ja = createInteraction({ locale: 'ja' });

      await executeStatusCommand(en);
      await executeStatusCommand(ja);

      const enEmbed = statusEmbed(en);
      const jaEmbed = statusEmbed(ja);
      // These three labels are inlined in status.ts rather than kept in the
      // locale files, so their exact wording is pinned here.
      expect(enEmbed.title).toBe('Voice subsystem status');
      expect(jaEmbed.title).toBe('ボイス機能の状態');
      expect(enEmbed.fields?.slice(0, 2).map((field) => field.name)).toEqual([
        'Active connections',
        'Connection limit',
      ]);
      expect(jaEmbed.fields?.slice(0, 2).map((field) => field.name)).toEqual([
        'アクティブ接続数',
        '接続上限',
      ]);
      expect(jaEmbed.fields?.slice(2).map((field) => field.name)).toEqual([
        t('record.bufferWindow', 'ja'),
        t('record.autojoin.title', 'ja'),
        t('record.autojoin.exclusionCount', 'ja'),
      ]);
      expect(fieldValue(jaEmbed, t('record.bufferWindow', 'ja'))).toBeDefined();
      expect(fieldValue(jaEmbed, t('record.autojoin.title', 'ja'))).toBe(
        t('record.autojoin.statusEnabled', 'ja')
      );
      expect(currentChannelLine(jaEmbed, 'ja')).toBe(
        t('record.autojoin.currentChannelNone', 'ja')
      );
    });
  });
});
