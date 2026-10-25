import Database from 'better-sqlite3';
import { EventEmitter } from 'events';
import {
  ComponentType,
  type ChatInputCommandInteraction,
  type EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits,
} from 'discord.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `/voice status` answers "is my channel being kept, and if not, why", shows
 * the guild's auto-join settings, and lets an admin change them in place.
 * Settings come from the real repository on in-memory SQLite; connection
 * state is faked.
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
  connections: new Map<
    string,
    { channelId: string; guildId: string; receiving?: boolean }
  >(),
  atLimit: false,
  buffered: new Map<string, number>(),
}));

vi.mock('../recording/connectionManager.js', () => ({
  connectionManager: {
    getConnection: vi.fn((id: string) => fake.connections.get(id)),
    getAllConnections: vi.fn(() => new Map(fake.connections)),
    getConnectedChannelInGuild: vi.fn((guildId: string) => {
      for (const info of fake.connections.values()) {
        if (info.guildId === guildId) return info.channelId;
      }
      return undefined;
    }),
    isAtLimit: vi.fn(() => fake.atLimit),
    disconnect: vi.fn(async (id: string) => {
      fake.connections.delete(id);
    }),
  },
}));

vi.mock('../recording/channelMixRing.js', () => ({
  channelMixRingManager: {
    getBufferedSeconds: (id: string) => fake.buffered.get(id) ?? 0,
  },
}));

const reconcileGuild = vi.hoisted(() => vi.fn());
vi.mock('../application/reconcile.js', () => ({ reconcileGuild }));

const getAnnouncementProblem = vi.hoisted(() => vi.fn());
vi.mock('../application/announce.js', () => ({ getAnnouncementProblem }));

const logAuditAction = vi.hoisted(() => vi.fn());
vi.mock('../../../infrastructure/audit/index.js', () => ({ logAuditAction }));

const { executeStatusCommand } = await import('../application/status.js');
const { voiceSettingsRepository } =
  await import('../repositories/voiceSettingsRepository.js');
const { connectionManager } = await import('../recording/connectionManager.js');
const { t } = await import('../../../locales/index.js');
const { commandMention } =
  await import('../../../shared/utils/commandMentions.js');
const { COLORS } = await import('../../../shared/utils/constants/index.js');
const { up: settingsTables } =
  await import('../../../infrastructure/database/migrations/003_settings.js');
const { up: voiceAutoJoinTables } =
  await import('../../../infrastructure/database/migrations/007_voice_autojoin.js');
const { up: announcementColumn } =
  await import('../../../infrastructure/database/migrations/008_announcement_channel.js');

const GUILD = 'guild-1';
const MiB = 1024 * 1024;

type Embed = ReturnType<EmbedBuilder['toJSON']>;

/**
 * A voice channel in the guild cache, with the bot's permissions there.
 * `hiddenFrom` cannot view it (an admin without Administrator, say).
 */
function voiceChannel(id: string, botCanJoin = true, hiddenFrom?: object) {
  return {
    id,
    permissionsFor: (who: unknown) => ({
      has: (flag: bigint) =>
        who === hiddenFrom && hiddenFrom !== undefined
          ? flag !== PermissionFlagsBits.ViewChannel
          : botCanJoin,
    }),
  };
}

function createPanel(
  options: {
    memberChannelId?: string | null;
    member?: object | null;
    locale?: string;
    channels?: string[];
    attachmentSizeLimit?: number;
    hasGuild?: boolean;
    /** Channels the caller cannot view. */
    hiddenFromCaller?: string[];
  } = {}
) {
  const collector = Object.assign(new EventEmitter(), { stop: vi.fn() });
  const message = {
    id: 'panel-1',
    createMessageComponentCollector: vi.fn(() => collector),
  };
  const channelIds = options.channels ?? ['voice-1', 'voice-2', 'voice-3'];
  const member =
    options.member !== undefined
      ? options.member
      : { voice: { channelId: options.memberChannelId ?? null } };
  const hidden = new Set(options.hiddenFromCaller ?? []);
  const guild = {
    id: GUILD,
    members: { me: { id: 'bot-1' } },
    channels: {
      cache: new Map(
        channelIds.map((id) => [
          id,
          voiceChannel(
            id,
            true,
            hidden.has(id) ? (member ?? undefined) : undefined
          ),
        ])
      ),
    },
  };
  const interaction = {
    guildId: options.hasGuild === false ? null : GUILD,
    guild: options.hasGuild === false ? null : guild,
    locale: options.locale ?? 'en-US',
    commandName: 'voice',
    options: {
      getSubcommandGroup: () => null,
      getSubcommand: () => 'status',
    },
    user: { id: 'admin-1' },
    client: {},
    attachmentSizeLimit: options.attachmentSizeLimit,
    member,
    reply: vi.fn(async () => ({ resource: { message } })),
    editReply: vi.fn(async () => ({})),
  };

  return {
    interaction,
    guild,
    run: () =>
      executeStatusCommand(
        interaction as unknown as ChatInputCommandInteraction
      ),
    /** The panel as first sent. */
    first() {
      expect(interaction.reply).toHaveBeenCalledTimes(1);
      const payload = (
        interaction.reply.mock.calls[0] as unknown as [
          { embeds: EmbedBuilder[]; components: unknown[]; flags: number },
        ]
      )[0];
      // Status may reveal which channels are excluded; it is for the caller only.
      expect(payload.flags).toBe(MessageFlags.Ephemeral);
      return payload;
    },
    /** Click something; returns what the panel re-rendered to. */
    async click(customId: string, values?: string[]) {
      const component = {
        customId,
        values: values ?? [],
        user: { id: 'admin-1' },
        client: {},
        replied: false,
        deferred: false,
        isChannelSelectMenu: () => values !== undefined,
        update: vi.fn(async () => ({})),
        reply: vi.fn(async () => ({})),
        followUp: vi.fn(async () => ({})),
      };
      const done = new Promise<void>((resolve) => {
        component.update.mockImplementation(async () => {
          resolve();
          return {};
        });
        component.reply.mockImplementation(async () => {
          resolve();
          return {};
        });
      });
      collector.emit('collect', component);
      await done;
      const update = component.update.mock.calls[0] as unknown as
        [{ embeds: EmbedBuilder[]; components: unknown[] }] | undefined;
      return { component, payload: update?.[0] };
    },
  };
}

function embedOf(payload: { embeds: EmbedBuilder[] }): Embed {
  expect(payload.embeds).toHaveLength(1);
  return payload.embeds[0].toJSON();
}

function fieldValue(embed: Embed, name: string): string | undefined {
  return embed.fields?.find((field) => field.name === name)?.value;
}

/** The line under the hint that answers "is my channel being kept?". */
function currentChannelLine(embed: Embed, locale: 'en' | 'ja' = 'en') {
  const [hint, line] = (embed.description ?? '').split('\n\n');
  expect(hint).toBe(t('record.statusHint', locale));
  return line;
}

type ComponentJSON = {
  type: ComponentType;
  custom_id?: string;
  disabled?: boolean;
  default_values?: Array<{ id: string; type: string }>;
  max_values?: number;
  min_values?: number;
};

function componentsOf(payload: { components: unknown[] }): ComponentJSON[] {
  return payload.components.flatMap(
    (row) =>
      (row as { toJSON(): { components: ComponentJSON[] } }).toJSON().components
  );
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

    fake.connections.clear();
    fake.buffered.clear();
    fake.atLimit = false;
    reconcileGuild.mockResolvedValue({ status: 'none' });
    getAnnouncementProblem.mockReturnValue(undefined);
  });

  describe("caller's current channel", () => {
    it('says how much can be saved when the bot is keeping the channel', async () => {
      fake.connections.set('voice-1', { channelId: 'voice-1', guildId: GUILD });
      fake.buffered.set('voice-1', 125.7);
      const panel = createPanel({ memberChannelId: 'voice-1' });

      await panel.run();

      expect(currentChannelLine(embedOf(panel.first()))).toBe(
        t('record.autojoin.currentChannelBuffered', 'en', {
          channel: 'voice-1',
          available: '2 minutes 5 seconds',
        })
      );
    });

    it('says the bot is listening but has heard nobody yet', async () => {
      fake.connections.set('voice-1', { channelId: 'voice-1', guildId: GUILD });
      const panel = createPanel({ memberChannelId: 'voice-1' });

      await panel.run();

      expect(currentChannelLine(embedOf(panel.first()))).toBe(
        t('record.autojoin.currentChannelListening', 'en', {
          channel: 'voice-1',
        })
      );
    });

    it('says the channel is excluded, even while a connection still exists', async () => {
      voiceSettingsRepository.addExclusion(GUILD, 'voice-1');
      fake.connections.set('voice-1', { channelId: 'voice-1', guildId: GUILD });
      const panel = createPanel({ memberChannelId: 'voice-1' });

      await panel.run();

      expect(currentChannelLine(embedOf(panel.first()))).toBe(
        t('record.autojoin.currentChannelExcluded', 'en', {
          channel: 'voice-1',
        })
      );
    });

    it('tells someone in a voice channel why it is not kept, not that they are not in one', async () => {
      fake.connections.set('voice-2', { channelId: 'voice-2', guildId: GUILD });
      const panel = createPanel({ memberChannelId: 'voice-1' });

      await panel.run();

      expect(currentChannelLine(embedOf(panel.first()))).toBe(
        t('record.autojoin.currentChannelNotBuffered', 'en', {
          channel: 'voice-1',
          reason: t('record.notBuffered.busyElsewhere', 'en', {
            other: 'voice-2',
          }),
        })
      );
    });

    it('explains that auto-join is off', async () => {
      voiceSettingsRepository.setAutoJoinEnabled(GUILD, false);
      const panel = createPanel({ memberChannelId: 'voice-1' });

      await panel.run();

      expect(currentChannelLine(embedOf(panel.first()))).toContain(
        t('record.notBuffered.autoJoinOff', 'en', {
          command: '`/voice autojoin enable`',
        })
      );
    });

    it('does not count a text-to-speech-only connection as keeping audio', async () => {
      fake.connections.set('voice-1', {
        channelId: 'voice-1',
        guildId: GUILD,
        receiving: false,
      });
      const panel = createPanel({ memberChannelId: 'voice-1' });

      await panel.run();

      expect(currentChannelLine(embedOf(panel.first()))).toContain(
        t('record.notBuffered.readOnly', 'en', { channel: 'voice-1' })
      );
    });

    it('says the bot has not joined yet when nothing stands in the way', async () => {
      const panel = createPanel({ memberChannelId: 'voice-1' });

      await panel.run();

      expect(currentChannelLine(embedOf(panel.first()))).toContain(
        t('record.notBuffered.notYetJoined', 'en')
      );
    });

    it('says the caller is not in voice only when they are not', async () => {
      const panel = createPanel({ memberChannelId: null });

      await panel.run();

      expect(currentChannelLine(embedOf(panel.first()))).toBe(
        t('record.autojoin.currentChannelNone', 'en')
      );
      expect(connectionManager.getConnection).not.toHaveBeenCalled();
    });

    it('treats an uncached API member (no voice state) as not in voice', async () => {
      const panel = createPanel({ member: { user: {} } });

      await panel.run();

      expect(currentChannelLine(embedOf(panel.first()))).toBe(
        t('record.autojoin.currentChannelNone', 'en')
      );
    });

    it('warns when the notice could not be posted in the caller channel', async () => {
      fake.connections.set('voice-1', { channelId: 'voice-1', guildId: GUILD });
      getAnnouncementProblem.mockImplementation((id: string) =>
        id === 'voice-1' ? 'noPermission' : undefined
      );
      const panel = createPanel({ memberChannelId: 'voice-1' });

      await panel.run();

      expect(embedOf(panel.first()).description).toContain(
        t('record.status.noticeNoPermission', 'en', { channel: 'voice-1' })
      );
    });

    it('drops the notice warning once the bot is no longer in that channel', async () => {
      getAnnouncementProblem.mockReturnValue('sendFailed');
      const panel = createPanel({ memberChannelId: 'voice-1' });

      await panel.run();

      expect(embedOf(panel.first()).description).not.toContain(
        t('record.status.noticeSendFailed', 'en', { channel: 'voice-1' })
      );
    });
  });

  describe('fields', () => {
    it('shows auto-join, the bot channel, capacity, the longest save and the exclusions', async () => {
      voiceSettingsRepository.addExclusion(GUILD, 'voice-2');
      voiceSettingsRepository.addExclusion(GUILD, 'voice-3');
      // Another guild's exclusions are not this guild's business.
      voiceSettingsRepository.addExclusion('guild-2', 'voice-9');
      fake.connections.set('voice-1', { channelId: 'voice-1', guildId: GUILD });
      const panel = createPanel({ attachmentSizeLimit: 25 * MiB });

      await panel.run();

      const embed = embedOf(panel.first());
      expect(embed.title).toBe(t('record.status.title', 'en'));
      expect(embed.color).toBe(COLORS.INFO);
      expect(fieldValue(embed, t('record.autojoin.title', 'en'))).toBe(
        t('record.autojoin.statusEnabled', 'en')
      );
      expect(fieldValue(embed, t('record.status.botChannel', 'en'))).toBe(
        '<#voice-1>'
      );
      expect(fieldValue(embed, t('record.status.capacity', 'en'))).toBe(
        t('record.status.capacityAvailable', 'en')
      );
      expect(fieldValue(embed, t('record.status.saveLimit', 'en'))).toBe(
        t('record.status.saveLimitValue', 'en', { max: '5 minutes', limit: 25 })
      );
      expect(fieldValue(embed, t('record.autojoin.exclusions', 'en'))).toBe(
        '<#voice-2> <#voice-3>'
      );
    });

    it('shows auto-join off, no bot channel, a full bot and no exclusions', async () => {
      voiceSettingsRepository.setAutoJoinEnabled(GUILD, false);
      fake.atLimit = true;
      const panel = createPanel();

      await panel.run();

      const embed = embedOf(panel.first());
      expect(fieldValue(embed, t('record.autojoin.title', 'en'))).toBe(
        t('record.autojoin.statusDisabled', 'en')
      );
      expect(fieldValue(embed, t('record.status.botChannel', 'en'))).toBe(
        t('record.autojoin.exclusionsNone', 'en')
      );
      expect(fieldValue(embed, t('record.status.capacity', 'en'))).toBe(
        t('record.status.capacityFull', 'en')
      );
      expect(fieldValue(embed, t('record.autojoin.exclusions', 'en'))).toBe(
        t('record.autojoin.exclusionsNone', 'en')
      );
    });

    it('cuts a long exclusion list to fit a field and says how many are left', async () => {
      const ids = Array.from(
        { length: 80 },
        (_, i) => `1${String(i).padStart(18, '0')}`
      );
      ids.forEach((id) => voiceSettingsRepository.addExclusion(GUILD, id));
      const panel = createPanel();

      await panel.run();

      const value = fieldValue(
        embedOf(panel.first()),
        t('record.autojoin.exclusions', 'en')
      )!;
      expect(value.length).toBeLessThanOrEqual(1024);
      const shown = value.match(/<#\d+>/g)!.length;
      expect(shown).toBeLessThan(80);
      expect(value).toContain(
        t('record.autojoin.exclusionsMore', 'en', { count: 80 - shown })
      );
    });

    it('renders every label in Japanese for a Japanese client', async () => {
      const panel = createPanel({ locale: 'ja' });

      await panel.run();

      const embed = embedOf(panel.first());
      expect(embed.title).toBe('ボイス機能の状態');
      expect(embed.fields?.map((field) => field.name)).toEqual([
        t('record.autojoin.title', 'ja'),
        t('record.status.botChannel', 'ja'),
        t('record.status.capacity', 'ja'),
        t('record.status.saveLimit', 'ja'),
        t('record.autojoin.exclusions', 'ja'),
      ]);
      expect(fieldValue(embed, t('record.status.saveLimit', 'ja'))).toBe(
        '最大5分（10MBを超える録音は分割して送信します）'
      );
      expect(currentChannelLine(embed, 'ja')).toBe(
        t('record.autojoin.currentChannelNone', 'ja')
      );
    });

    it('refuses outside a guild', async () => {
      const panel = createPanel({ hasGuild: false });

      await panel.run();

      expect(embedOf(panel.first()).description).toBe(
        t('common.guildOnly', 'en')
      );
    });
  });

  describe('settings panel', () => {
    it('offers to turn auto-join off, and preselects the excluded channels', async () => {
      voiceSettingsRepository.addExclusion(GUILD, 'voice-2');
      const panel = createPanel();

      await panel.run();

      const [toggle, menu] = componentsOf(panel.first());
      expect(toggle.custom_id).toBe('voice-panel:autojoin-off');
      expect(menu.type).toBe(ComponentType.ChannelSelect);
      expect(menu.min_values).toBe(0);
      expect(menu.max_values).toBe(25);
      expect(menu.default_values).toEqual([{ id: 'voice-2', type: 'channel' }]);
    });

    it('turns auto-join on and joins an occupied channel right away', async () => {
      voiceSettingsRepository.setAutoJoinEnabled(GUILD, false);
      reconcileGuild.mockResolvedValue({
        status: 'joined',
        channelId: 'voice-3',
      });
      const panel = createPanel();
      await panel.run();
      expect(componentsOf(panel.first())[0].custom_id).toBe(
        'voice-panel:autojoin-on'
      );

      const { payload } = await panel.click('voice-panel:autojoin-on');

      expect(voiceSettingsRepository.isAutoJoinEnabled(GUILD)).toBe(true);
      expect(reconcileGuild).toHaveBeenCalledWith(panel.guild);
      expect(embedOf(payload!).description).toContain(
        t('record.autojoin.joinedNow', 'en', { channel: 'voice-3' })
      );
      expect(componentsOf(payload!)[0].custom_id).toBe(
        'voice-panel:autojoin-off'
      );
      // Written in the server's language (Japanese by default), not the
      // admin's English client.
      expect(logAuditAction).toHaveBeenCalledWith(
        {},
        GUILD,
        'admin-1',
        'SETTINGS_CHANGE',
        undefined,
        t('record.audit.autoJoinEnabled', 'ja', {
          via: t('record.audit.viaPanel', 'ja', { command: '/voice status' }),
        })
      );
    });

    it('asks before turning auto-join off, and changes nothing until confirmed', async () => {
      fake.connections.set('voice-1', { channelId: 'voice-1', guildId: GUILD });
      const panel = createPanel();
      await panel.run();

      const { payload } = await panel.click('voice-panel:autojoin-off');

      expect(voiceSettingsRepository.isAutoJoinEnabled(GUILD)).toBe(true);
      expect(connectionManager.disconnect).not.toHaveBeenCalled();
      expect(embedOf(payload!).description).toContain(
        t('record.panel.confirmDisablePrompt', 'en')
      );
      expect(componentsOf(payload!).map((c) => c.custom_id)).toEqual([
        'voice-panel:autojoin-off-confirm',
        'voice-panel:autojoin-off-cancel',
        'voice-panel:exclusions',
      ]);
    });

    it('turns auto-join off and leaves the channel once confirmed', async () => {
      fake.connections.set('voice-1', { channelId: 'voice-1', guildId: GUILD });
      fake.connections.set('other', { channelId: 'other', guildId: 'guild-2' });
      const panel = createPanel();
      await panel.run();
      await panel.click('voice-panel:autojoin-off');

      const { payload } = await panel.click('voice-panel:autojoin-off-confirm');

      expect(voiceSettingsRepository.isAutoJoinEnabled(GUILD)).toBe(false);
      // Second argument: the connection to drop, which this fake leaves out.
      expect(connectionManager.disconnect).toHaveBeenCalledWith(
        'voice-1',
        undefined
      );
      expect(connectionManager.disconnect).not.toHaveBeenCalledWith('other');
      expect(embedOf(payload!).description).toContain(
        t('record.autojoin.disabledDropped', 'en')
      );
      expect(componentsOf(payload!)[0].custom_id).toBe(
        'voice-panel:autojoin-on'
      );
    });

    it('keeps auto-join on when the confirmation is cancelled', async () => {
      const panel = createPanel();
      await panel.run();
      await panel.click('voice-panel:autojoin-off');

      const { payload } = await panel.click('voice-panel:autojoin-off-cancel');

      expect(voiceSettingsRepository.isAutoJoinEnabled(GUILD)).toBe(true);
      expect(componentsOf(payload!)[0].custom_id).toBe(
        'voice-panel:autojoin-off'
      );
    });

    it('applies the menu as a diff: excludes and leaves added channels, re-includes removed ones', async () => {
      voiceSettingsRepository.addExclusion(GUILD, 'voice-2');
      fake.connections.set('voice-1', { channelId: 'voice-1', guildId: GUILD });
      const panel = createPanel();
      await panel.run();

      const { payload } = await panel.click('voice-panel:exclusions', [
        'voice-1',
      ]);

      expect(voiceSettingsRepository.listExclusions(GUILD)).toEqual([
        'voice-1',
      ]);
      expect(connectionManager.disconnect).toHaveBeenCalledWith(
        'voice-1',
        undefined
      );
      expect(reconcileGuild).toHaveBeenCalled();
      expect(embedOf(payload!).description).toContain(
        t('record.panel.exclusionsUpdated', 'en', {
          added: '<#voice-1>',
          removed: '<#voice-2>',
        })
      );
    });

    it('says nothing changed when the same channels are submitted again', async () => {
      voiceSettingsRepository.addExclusion(GUILD, 'voice-2');
      const panel = createPanel();
      await panel.run();

      const { payload } = await panel.click('voice-panel:exclusions', [
        'voice-2',
      ]);

      expect(voiceSettingsRepository.listExclusions(GUILD)).toEqual([
        'voice-2',
      ]);
      expect(embedOf(payload!).description).toContain(
        t('record.panel.nothingChanged', 'en')
      );
      expect(logAuditAction).not.toHaveBeenCalled();
    });

    it('leaves the exclusion of a deleted channel alone instead of lifting it', async () => {
      voiceSettingsRepository.addExclusion(GUILD, 'deleted-channel');
      voiceSettingsRepository.addExclusion(GUILD, 'voice-2');
      const panel = createPanel();
      await panel.run();
      expect(componentsOf(panel.first())[1].default_values).toEqual([
        { id: 'voice-2', type: 'channel' },
      ]);

      await panel.click('voice-panel:exclusions', []);

      expect(voiceSettingsRepository.listExclusions(GUILD)).toEqual([
        'deleted-channel',
      ]);
    });

    it('stores the whole new list before moving, so it never joins a channel the same submission excludes', async () => {
      fake.connections.set('voice-1', { channelId: 'voice-1', guildId: GUILD });
      let excludedWhenReconciling: string[] | undefined;
      reconcileGuild.mockImplementation(async () => {
        excludedWhenReconciling = voiceSettingsRepository.listExclusions(GUILD);
        return { status: 'none' };
      });
      const panel = createPanel();
      await panel.run();

      const { payload } = await panel.click('voice-panel:exclusions', [
        'voice-1',
        'voice-3',
      ]);

      expect(connectionManager.disconnect).toHaveBeenCalledWith(
        'voice-1',
        undefined
      );
      expect(reconcileGuild).toHaveBeenCalledTimes(1);
      expect([...(excludedWhenReconciling ?? [])].sort()).toEqual([
        'voice-1',
        'voice-3',
      ]);
      expect(embedOf(payload!).description).toContain(
        t('record.autojoin.waitingForMembers', 'en')
      );
      expect(logAuditAction).toHaveBeenCalledWith(
        {},
        GUILD,
        'admin-1',
        'SETTINGS_CHANGE',
        undefined,
        t('record.audit.exclusionsChanged', 'ja', {
          added: '<#voice-1>、<#voice-3>',
          removed: t('record.autojoin.exclusionsNone', 'ja'),
          via: t('record.audit.viaPanel', 'ja', { command: '/voice status' }),
        })
      );
    });

    it('does not reconcile when nothing left and nothing became eligible', async () => {
      const panel = createPanel();
      await panel.run();

      await panel.click('voice-panel:exclusions', ['voice-3']);

      expect(voiceSettingsRepository.listExclusions(GUILD)).toEqual([
        'voice-3',
      ]);
      expect(connectionManager.disconnect).not.toHaveBeenCalled();
      expect(reconcileGuild).not.toHaveBeenCalled();
    });

    it('never preselects, or lifts, an exclusion the caller cannot see', async () => {
      voiceSettingsRepository.addExclusion(GUILD, 'voice-2');
      voiceSettingsRepository.addExclusion(GUILD, 'voice-3');
      const panel = createPanel({ hiddenFromCaller: ['voice-3'] });
      await panel.run();

      const first = panel.first();
      expect(componentsOf(first)[1].default_values).toEqual([
        { id: 'voice-2', type: 'channel' },
      ]);
      expect(embedOf(first).description).toContain(
        t('record.panel.hiddenExclusions', 'en', { count: 1 })
      );
      // Discord leaves out what the caller cannot see; the diff must not
      // read that as "removed".
      await panel.click('voice-panel:exclusions', []);

      expect(voiceSettingsRepository.listExclusions(GUILD)).toEqual([
        'voice-3',
      ]);
    });

    it('drops the menu when more channels are excluded than it can show', async () => {
      const ids = Array.from({ length: 26 }, (_, i) => `vc-${i}`);
      ids.forEach((id) => voiceSettingsRepository.addExclusion(GUILD, id));
      const panel = createPanel({ channels: ids });

      await panel.run();

      const payload = panel.first();
      expect(componentsOf(payload).map((c) => c.custom_id)).toEqual([
        'voice-panel:autojoin-off',
      ]);
      // Names the commands that still work, as runnable mentions.
      expect(embedOf(payload).description).toContain(
        t('record.panel.tooManyExclusions', 'en', {
          exclude: commandMention('voice autojoin exclude'),
          include: commandMention('voice autojoin include'),
        })
      );
    });
  });
});
