import { beforeEach, describe, it, expect, vi } from 'vitest';
import {
  ChatInputCommandInteraction,
  GuildMember,
  PermissionFlagsBits,
  PermissionsBitField,
  SlashCommandBuilder,
} from 'discord.js';
import { permissionsMiddleware } from '../permissions.js';
import { Command } from '../../shared/types/index.js';
import { t } from '../../locales/index.js';

const resolveLocale = vi.hoisted(() => vi.fn());
vi.mock('../../locales/guildLocale.js', () => ({ resolveLocale }));

function createMockInteraction(
  permissions?: bigint[],
  inGuild = true,
  options: { memberPermissions?: bigint[] | null } = {}
) {
  const bitField = new PermissionsBitField(permissions ?? []);

  return {
    guild: inGuild ? { id: 'guild-1' } : null,
    member: inGuild ? { permissions: bitField } : null,
    memberPermissions:
      options.memberPermissions === undefined
        ? null
        : options.memberPermissions === null
          ? null
          : new PermissionsBitField(options.memberPermissions),
    guildId: inGuild ? 'guild-1' : null,
    locale: 'en-US',
  } as unknown as ChatInputCommandInteraction;
}

function createMockCommand(permissions?: bigint[]): Command {
  return {
    data: new SlashCommandBuilder().setName('test').setDescription('test'),
    options: permissions ? { permissions } : undefined,
    execute: vi.fn(),
  };
}

beforeEach(() => {
  resolveLocale.mockReturnValue('en');
});

describe('permissionsMiddleware', () => {
  it('should pass when no permissions are required', async () => {
    const result = await permissionsMiddleware(
      createMockInteraction(),
      createMockCommand()
    );
    expect(result.success).toBe(true);
  });

  it('should pass when permissions array is empty', async () => {
    const result = await permissionsMiddleware(
      createMockInteraction(),
      createMockCommand([])
    );
    expect(result.success).toBe(true);
  });

  it('should pass when user has required permissions', async () => {
    const result = await permissionsMiddleware(
      createMockInteraction([PermissionFlagsBits.ManageGuild]),
      createMockCommand([PermissionFlagsBits.ManageGuild])
    );
    expect(result.success).toBe(true);
  });

  it('names the missing permission the way Discord shows it, never the raw flag', async () => {
    const result = await permissionsMiddleware(
      createMockInteraction([]),
      createMockCommand([PermissionFlagsBits.ManageGuild])
    );

    expect(result).toEqual({
      success: false,
      title: t('common.permissionDeniedTitle', 'en'),
      message: t('common.permissionsRequired', 'en', {
        permissions: 'Manage Server',
      }),
    });
    expect(result.message).toContain('permission');
    expect(result.message).not.toContain('ManageGuild');
  });

  it('answers in Japanese with the Japanese client label', async () => {
    resolveLocale.mockReturnValue('ja');

    const result = await permissionsMiddleware(
      createMockInteraction([]),
      createMockCommand([PermissionFlagsBits.ManageGuild])
    );

    expect(result.title).toBe('権限が足りません');
    expect(result.message).toBe(
      t('common.permissionsRequired', 'ja', { permissions: '「サーバー管理」' })
    );
  });

  it('lists only the permissions the member is missing', async () => {
    const result = await permissionsMiddleware(
      createMockInteraction([PermissionFlagsBits.ManageGuild]),
      createMockCommand([
        PermissionFlagsBits.ManageGuild,
        PermissionFlagsBits.ManageRoles,
      ])
    );

    expect(result.success).toBe(false);
    expect(result.message).toContain('Manage Roles');
    expect(result.message).not.toContain('Manage Server');
  });

  it('should fail when not in a guild', async () => {
    const result = await permissionsMiddleware(
      createMockInteraction(undefined, false),
      createMockCommand([PermissionFlagsBits.ManageGuild])
    );

    expect(result).toEqual({
      success: false,
      title: t('common.serverOnlyTitle', 'en'),
      message: t('common.guildOnly', 'en'),
    });
    expect(result.message).toContain('server');
  });

  it('checks the permissions Discord sent before a partial member stand-in', async () => {
    // The member has the role-level permission, but not in this channel.
    const denied = await permissionsMiddleware(
      createMockInteraction([PermissionFlagsBits.ManageGuild], true, {
        memberPermissions: [],
      }),
      createMockCommand([PermissionFlagsBits.ManageGuild])
    );
    expect(denied.success).toBe(false);

    const allowed = await permissionsMiddleware(
      createMockInteraction([], true, {
        memberPermissions: [PermissionFlagsBits.ManageGuild],
      }),
      createMockCommand([PermissionFlagsBits.ManageGuild])
    );
    expect(allowed.success).toBe(true);
  });

  describe('a cached member', () => {
    /** A cached GuildMember whose roles grant `serverWide`. */
    function cachedMember(serverWide: bigint[]): GuildMember {
      const member = Object.create(GuildMember.prototype) as GuildMember;
      Object.defineProperty(member, 'permissions', {
        value: new PermissionsBitField(serverWide),
      });
      return member;
    }

    function interactionWith(member: GuildMember, channel: bigint[]) {
      return {
        guild: { id: 'guild-1' },
        member,
        memberPermissions: new PermissionsBitField(channel),
        guildId: 'guild-1',
        locale: 'en-US',
      } as unknown as ChatInputCommandInteraction;
    }

    it('is not granted a server-wide permission by a channel overwrite', async () => {
      // "Manage Permissions" on one channel is the Manage Roles bit.
      const result = await permissionsMiddleware(
        interactionWith(cachedMember([]), [PermissionFlagsBits.ManageRoles]),
        createMockCommand([PermissionFlagsBits.ManageRoles])
      );

      expect(result.success).toBe(false);
      expect(result.message).toContain('Manage Roles');
    });

    it('passes on the permissions its roles grant', async () => {
      const result = await permissionsMiddleware(
        interactionWith(cachedMember([PermissionFlagsBits.ManageRoles]), []),
        createMockCommand([PermissionFlagsBits.ManageRoles])
      );

      expect(result.success).toBe(true);
    });

    it('falls back to what Discord sent when its roles cannot be read', async () => {
      const member = Object.create(GuildMember.prototype) as GuildMember;
      Object.defineProperty(member, 'permissions', {
        get() {
          throw new Error('roles not cached');
        },
      });

      const result = await permissionsMiddleware(
        interactionWith(member, [PermissionFlagsBits.ManageGuild]),
        createMockCommand([PermissionFlagsBits.ManageGuild])
      );

      expect(result.success).toBe(true);
    });
  });

  it('refuses when no permissions can be read at all', async () => {
    const interaction = {
      guild: { id: 'guild-1' },
      member: { permissions: '8' },
      memberPermissions: null,
      guildId: 'guild-1',
      locale: 'en-US',
    } as unknown as ChatInputCommandInteraction;

    const result = await permissionsMiddleware(
      interaction,
      createMockCommand([PermissionFlagsBits.ManageGuild])
    );

    expect(result.success).toBe(false);
    expect(result.message).toBe(t('common.permissionsUnverifiable', 'en'));
  });

  it('should pass when user has all required permissions', async () => {
    const result = await permissionsMiddleware(
      createMockInteraction([
        PermissionFlagsBits.ManageGuild,
        PermissionFlagsBits.ManageRoles,
      ]),
      createMockCommand([
        PermissionFlagsBits.ManageGuild,
        PermissionFlagsBits.ManageRoles,
      ])
    );
    expect(result.success).toBe(true);
  });
});
