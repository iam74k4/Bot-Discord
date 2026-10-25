import Database from 'better-sqlite3';
import { MessageFlags, PermissionFlagsBits } from 'discord.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The "exclude this channel" button on the public buffering notice. The
 * exclusion is stored in the real repository on in-memory SQLite.
 */
const db = new Database(':memory:');

vi.mock('../../../infrastructure/database/connection.js', () => ({
  database: db,
}));

vi.mock('../../../shared/utils/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
  getErrorMessage: (e: unknown) => String(e),
}));

const connections = vi.hoisted(() => new Map<string, object>());
vi.mock('../recording/connectionManager.js', () => ({
  connectionManager: {
    getConnection: vi.fn((id: string) => connections.get(id)),
    disconnect: vi.fn(async (id: string) => {
      connections.delete(id);
    }),
  },
}));

const reconcileGuild = vi.hoisted(() => vi.fn());
vi.mock('../application/reconcile.js', () => ({ reconcileGuild }));

const logAuditAction = vi.hoisted(() => vi.fn());
vi.mock('../../../infrastructure/audit/index.js', () => ({ logAuditAction }));

const { handleOptOutClick } = await import('../application/optOut.js');
const { voiceSettingsRepository } =
  await import('../repositories/voiceSettingsRepository.js');
const { connectionManager } = await import('../recording/connectionManager.js');
const { t } = await import('../../../locales/index.js');
const { up: settingsTables } =
  await import('../../../infrastructure/database/migrations/003_settings.js');
const { up: voiceAutoJoinTables } =
  await import('../../../infrastructure/database/migrations/007_voice_autojoin.js');
const { up: announcementColumn } =
  await import('../../../infrastructure/database/migrations/008_announcement_channel.js');

function click(
  options: { canManage?: boolean; locale?: string; hasGuild?: boolean } = {}
) {
  const guild = { id: 'guild-1', preferredLocale: 'en-US', features: [] };
  return {
    customId: 'voice-optout:voice-1',
    guild: options.hasGuild === false ? null : guild,
    guildId: options.hasGuild === false ? null : 'guild-1',
    locale: options.locale ?? 'en-US',
    user: { id: 'admin-1' },
    client: { id: 'client' },
    memberPermissions: {
      has: (flag: bigint) =>
        flag === PermissionFlagsBits.ManageGuild && options.canManage !== false,
    },
    reply: vi.fn(async () => undefined),
    update: vi.fn(async () => undefined),
  };
}

describe('the opt-out button on the buffering notice', () => {
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
    connections.clear();
    reconcileGuild.mockResolvedValue({ status: 'none' });
  });

  it('turns away members without Manage Server and changes nothing', async () => {
    connections.set('voice-1', {});
    const interaction = click({ canManage: false, locale: 'ja' });

    await handleOptOutClick(interaction as never);

    expect(interaction.reply).toHaveBeenCalledWith({
      content: t('record.notice.optOutNotAllowed', 'ja'),
      flags: MessageFlags.Ephemeral,
    });
    expect(
      voiceSettingsRepository.isChannelExcluded('guild-1', 'voice-1')
    ).toBe(false);
    expect(connectionManager.disconnect).not.toHaveBeenCalled();
    expect(interaction.update).not.toHaveBeenCalled();
  });

  it('excludes the channel, leaves it, and rewrites the notice for everyone', async () => {
    connections.set('voice-1', {});
    const interaction = click();

    await handleOptOutClick(interaction as never);

    expect(
      voiceSettingsRepository.isChannelExcluded('guild-1', 'voice-1')
    ).toBe(true);
    expect(connectionManager.disconnect).toHaveBeenCalledWith('voice-1');
    const [payload] = interaction.update.mock.calls[0] as unknown as [
      {
        embeds: Array<{ toJSON(): { description?: string } }>;
        components: unknown[];
      },
    ];
    expect(payload.components).toEqual([]);
    // No server language set and not a Community server: Japanese.
    const description = payload.embeds[0].toJSON().description ?? '';
    expect(description).toContain(
      t('record.notice.optedOut', 'ja', {
        channel: 'voice-1',
        user: '<@admin-1>',
      })
    );
    expect(description).toContain(t('record.notice.optedOutLeft', 'ja'));
  });

  it('records who excluded the channel in the audit log, in the server language', async () => {
    const interaction = click();

    await handleOptOutClick(interaction as never);

    // The clicker's client is English; the audit channel follows the server.
    expect(logAuditAction).toHaveBeenCalledWith(
      interaction.client,
      'guild-1',
      'admin-1',
      'SETTINGS_CHANGE',
      undefined,
      t('record.audit.channelExcluded', 'ja', {
        channel: 'voice-1',
        via: t('record.audit.viaNoticeButton', 'ja'),
      })
    );
  });

  it('is harmless when pressed again on an old notice', async () => {
    voiceSettingsRepository.addExclusion('guild-1', 'voice-1');
    const interaction = click();

    await handleOptOutClick(interaction as never);

    expect(voiceSettingsRepository.listExclusions('guild-1')).toEqual([
      'voice-1',
    ]);
    expect(connectionManager.disconnect).not.toHaveBeenCalled();
    const [payload] = interaction.update.mock.calls[0] as unknown as [
      { embeds: Array<{ toJSON(): { description?: string } }> },
    ];
    expect(payload.embeds[0].toJSON().description).not.toContain(
      t('record.notice.optedOutLeft', 'ja')
    );
  });

  it('refuses outside a server', async () => {
    const interaction = click({ hasGuild: false });

    await handleOptOutClick(interaction as never);

    expect(interaction.reply).toHaveBeenCalledWith({
      content: t('common.guildOnly', 'en'),
      flags: MessageFlags.Ephemeral,
    });
  });
});
