import { PermissionFlagsBits, PermissionsBitField } from 'discord.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const showSettingsPanel = vi.fn();

vi.mock('../application/settingsPanel.js', () => ({
  showSettingsPanel,
}));

vi.mock('../../../infrastructure/guildSettings/index.js', () => ({
  guildSettingsRepository: {
    get: vi.fn(),
    setAuditChannel: vi.fn(),
    setLanguage: vi.fn(),
  },
}));

vi.mock('../../../infrastructure/audit/index.js', () => ({
  auditRepository: { getLogs: vi.fn(), getLogsCount: vi.fn() },
  logAuditAction: vi.fn(),
}));

/** A Manage Server holder, as Discord describes them on the interaction. */
const MANAGER = new PermissionsBitField(PermissionFlagsBits.ManageGuild);

describe('admin settings panel routing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('opens the overview panel from settings view', async () => {
    const { executeSettingsCommand } =
      await import('../application/settings.js');

    const interaction = {
      locale: 'en-US',
      guild: { id: 'guild-1' },
      memberPermissions: MANAGER,
      options: {
        getSubcommand: vi.fn().mockReturnValue('view'),
      },
      reply: vi.fn(),
    } as never;

    await executeSettingsCommand(interaction);

    expect(showSettingsPanel).toHaveBeenCalledWith(
      interaction,
      'en',
      'overview'
    );
  });

  it('opens the logs panel from settings logs', async () => {
    const { executeSettingsCommand } =
      await import('../application/settings.js');

    const interaction = {
      locale: 'ja',
      guild: { id: 'guild-1' },
      memberPermissions: MANAGER,
      options: {
        getSubcommand: vi.fn().mockReturnValue('logs'),
      },
      reply: vi.fn(),
    } as never;

    await executeSettingsCommand(interaction);

    expect(showSettingsPanel).toHaveBeenCalledWith(interaction, 'ja', 'logs');
  });
});
