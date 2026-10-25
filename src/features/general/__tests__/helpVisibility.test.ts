import { PermissionsBitField } from 'discord.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CommandInfo } from '../../../shared/help/catalog.js';

const originalEnv = { ...process.env };

vi.mock('../../../shared/utils/logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
  getErrorMessage: (error: unknown) =>
    error instanceof Error ? error.message : String(error),
}));

vi.mock('../../../locales/index.js', () => ({
  t: (key: string) => key,
  mapDiscordLocale: () => 'en',
}));

function restoreEnv(): void {
  for (const key of Object.keys(process.env)) {
    delete process.env[key];
  }
  Object.assign(process.env, originalEnv);
}

async function loadHelpModule(
  overrides: Record<string, string | undefined> = {}
): Promise<typeof import('../application/help.js')> {
  restoreEnv();
  Object.assign(process.env, {
    DISCORD_TOKEN: 'test-token',
    DISCORD_CLIENT_ID: '123456789012345678',
    BOT_OWNER_IDS: 'owner-1',
    NODE_ENV: 'development',
  });

  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete process.env[key];
      continue;
    }
    process.env[key] = value;
  }

  vi.resetModules();
  return import('../application/help.js');
}

afterEach(() => {
  restoreEnv();
  vi.resetModules();
});

describe('canUserSeeCommandWithContext', () => {
  const adminCommand: CommandInfo = {
    name: 'admin',
    description: { en: 'Admin', ja: '管理' },
    requiredPermission: ['manageGuild', 'owner'],
  };

  const memberWithManageGuild = {
    permissions: new PermissionsBitField(PermissionsBitField.Flags.ManageGuild),
  };

  it('shows commands to members with required guild permissions', async () => {
    const { canUserSeeCommandWithContext } = await loadHelpModule();

    expect(
      canUserSeeCommandWithContext(adminCommand, {
        userId: 'member-1',
        guild: { id: 'guild-1' },
        member: memberWithManageGuild,
      })
    ).toBe(true);
  });

  it('hides commands from members without required permissions', async () => {
    const { canUserSeeCommandWithContext } = await loadHelpModule();

    expect(
      canUserSeeCommandWithContext(adminCommand, {
        userId: 'member-1',
        guild: { id: 'guild-1' },
        member: {
          permissions: new PermissionsBitField(),
        },
      })
    ).toBe(false);
  });

  it('always shows owner-visible commands to bot owners', async () => {
    const { canUserSeeCommandWithContext } = await loadHelpModule();

    expect(
      canUserSeeCommandWithContext(adminCommand, {
        userId: 'owner-1',
        guild: null,
        member: null,
      })
    ).toBe(true);
  });
});

describe('canUserSeeCommandWithContext permission matrix', () => {
  const inGuild = { id: 'guild-1' };
  const memberWith = (...bits: bigint[]) => ({
    permissions: new PermissionsBitField(bits),
  });
  const command = (
    requiredPermission: CommandInfo['requiredPermission']
  ): CommandInfo => ({
    name: 'demo',
    description: { en: 'Demo', ja: 'デモ' },
    requiredPermission,
  });

  it.each<{
    title: string;
    requiredPermission: CommandInfo['requiredPermission'];
    userId?: string;
    guild?: { id: string } | null;
    member?: { permissions: PermissionsBitField } | null;
    visible: boolean;
  }>([
    {
      title: 'no requirement is visible even in DMs',
      requiredPermission: undefined,
      guild: null,
      member: null,
      visible: true,
    },
    {
      title: '"everyone" is visible in DMs',
      requiredPermission: 'everyone',
      guild: null,
      member: null,
      visible: true,
    },
    {
      title: 'a list containing "everyone" is visible to anyone',
      requiredPermission: ['owner', 'everyone'],
      guild: null,
      member: null,
      visible: true,
    },
    {
      title: 'owner-only is hidden from other users',
      requiredPermission: 'owner',
      member: memberWith(PermissionsBitField.Flags.Administrator),
      visible: false,
    },
    {
      title: 'owner-only is visible to the owner',
      requiredPermission: 'owner',
      userId: 'owner-1',
      visible: true,
    },
    {
      title: 'Manage Roles unlocks manageRoles',
      requiredPermission: 'manageRoles',
      member: memberWith(PermissionsBitField.Flags.ManageRoles),
      visible: true,
    },
    {
      title: 'Manage Roles does not unlock manageGuild',
      requiredPermission: 'manageGuild',
      member: memberWith(PermissionsBitField.Flags.ManageRoles),
      visible: false,
    },
    {
      title: 'Administrator unlocks manageGuild',
      requiredPermission: 'manageGuild',
      member: memberWith(PermissionsBitField.Flags.Administrator),
      visible: true,
    },
    {
      title: 'guild permissions do not count outside a guild',
      requiredPermission: 'manageGuild',
      guild: null,
      member: memberWith(PermissionsBitField.Flags.ManageGuild),
      visible: false,
    },
    {
      title: 'a missing member cannot hold guild permissions',
      requiredPermission: ['manageGuild', 'manageRoles'],
      member: null,
      visible: false,
    },
    {
      title: 'Administrator unlocks administrator',
      requiredPermission: 'administrator',
      member: memberWith(PermissionsBitField.Flags.Administrator),
      visible: true,
    },
    {
      title: 'Manage Server does not unlock administrator',
      requiredPermission: 'administrator',
      member: memberWith(
        PermissionsBitField.Flags.ManageGuild,
        PermissionsBitField.Flags.ManageRoles
      ),
      visible: false,
    },
    {
      title: 'administrator does not count outside a guild',
      requiredPermission: 'administrator',
      guild: null,
      member: memberWith(PermissionsBitField.Flags.Administrator),
      visible: false,
    },
    {
      title: 'raw API permission strings are not trusted',
      requiredPermission: 'manageGuild',
      member: {
        permissions: String(
          PermissionsBitField.Flags.ManageGuild
        ) as unknown as PermissionsBitField,
      },
      visible: false,
    },
  ])('$title', async ({ requiredPermission, visible, ...ctx }) => {
    const { canUserSeeCommandWithContext } = await loadHelpModule();

    expect(
      canUserSeeCommandWithContext(command(requiredPermission), {
        userId: ctx.userId ?? 'member-1',
        guild: ctx.guild === undefined ? inGuild : ctx.guild,
        member: ctx.member === undefined ? memberWith() : ctx.member,
      })
    ).toBe(visible);
  });

  it('reads the owner list from the configuration', async () => {
    const { canUserSeeCommandWithContext } = await loadHelpModule({
      BOT_OWNER_IDS: 'someone-else',
    });

    expect(
      canUserSeeCommandWithContext(command('owner'), {
        userId: 'owner-1',
        guild: null,
        member: null,
      })
    ).toBe(false);
  });
});
