import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GuildMember, MessageFlags, PermissionsBitField } from 'discord.js';
import { t } from '../../../locales/index.js';

vi.mock('../../../shared/utils/embed.js', () => ({
  createEmbed: vi.fn((opts) => opts),
  createErrorEmbed: vi.fn((title, description) => ({ title, description })),
}));

vi.mock('../../../shared/utils/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
  getErrorMessage: (e: unknown) => String(e),
}));

const roleAdd = vi.fn().mockResolvedValue(undefined);
const roleRemove = vi.fn().mockResolvedValue(undefined);

vi.mock('../../../infrastructure/audit/index.js', () => ({
  audit: {
    roleAdd: (...args: unknown[]) => roleAdd(...args),
    roleRemove: (...args: unknown[]) => roleRemove(...args),
  },
}));

/** Passed through to the audit service, which posts to the audit channel. */
const CLIENT = { id: 'client-stub' };

function memberStub(
  opts: {
    id: string;
    highestPosition: number;
    roleIds?: string[];
    ownerId?: string;
    add?: ReturnType<typeof vi.fn>;
    remove?: ReturnType<typeof vi.fn>;
  },
  guildRoles?: { cache: { get: (id: string) => unknown } }
): GuildMember {
  const roleCache = new Map((opts.roleIds ?? []).map((id) => [id, { id }]));
  const member = {
    id: opts.id,
    roles: {
      highest: { position: opts.highestPosition },
      cache: {
        has: (id: string) => roleCache.has(id),
      },
      add: opts.add ?? vi.fn().mockResolvedValue(undefined),
      remove: opts.remove ?? vi.fn().mockResolvedValue(undefined),
    },
    guild: {
      ownerId: opts.ownerId ?? 'owner-1',
      roles: guildRoles ?? { cache: { get: () => undefined } },
    },
  };
  Object.setPrototypeOf(member, GuildMember.prototype);
  return member as unknown as GuildMember;
}

describe('admin role target hierarchy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects adding a role to a senior member the actor cannot manage', async () => {
    const { executeRoleCommand } = await import('../application/role.js');
    const rolesAdd = vi.fn().mockResolvedValue(undefined);
    const managedRole = { id: 'role-low', name: 'Muted', position: 2 };
    const roles = {
      cache: {
        get: (id: string) =>
          id === managedRole.id
            ? { ...managedRole, position: managedRole.position }
            : undefined,
      },
    };

    const executor = memberStub({ id: 'mod-1', highestPosition: 5 }, roles);
    const target = memberStub(
      {
        id: 'admin-1',
        highestPosition: 10,
        add: rolesAdd,
      },
      roles
    );

    const guild = {
      id: 'guild-1',
      ownerId: 'owner-1',
      members: {
        me: memberStub({ id: 'bot-1', highestPosition: 20 }, roles),
        fetch: vi.fn(async (id: string) => {
          if (id === 'mod-1') return executor;
          if (id === 'admin-1') return target;
          return null;
        }),
      },
      roles,
    };

    const reply = vi.fn();
    const interaction = {
      locale: 'en-US',
      client: CLIENT,
      user: { id: 'mod-1', tag: 'Mod#0001' },
      member: {
        permissions: new PermissionsBitField(
          PermissionsBitField.Flags.ManageRoles
        ),
      },
      guild,
      options: {
        getUser: vi.fn().mockReturnValue({ id: 'admin-1', tag: 'Admin#0001' }),
        getRole: vi.fn().mockReturnValue(managedRole),
        getSubcommand: vi.fn().mockReturnValue('add'),
      },
      reply,
      replied: false,
      deferred: false,
    };

    await executeRoleCommand(interaction as never);

    expect(rolesAdd).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledWith(
      expect.objectContaining({
        flags: MessageFlags.Ephemeral,
        embeds: [
          expect.objectContaining({
            description: t('admin.role.errors.targetMemberHierarchy', 'en'),
          }),
        ],
      })
    );
  });

  it('allows adding a lower role to a junior member', async () => {
    const { executeRoleCommand } = await import('../application/role.js');
    const rolesAdd = vi.fn().mockResolvedValue(undefined);
    const managedRole = { id: 'role-low', name: 'Muted', position: 3 };
    const roles = {
      cache: {
        get: (id: string) =>
          id === managedRole.id
            ? { ...managedRole, position: managedRole.position }
            : undefined,
      },
    };

    const executor = memberStub({ id: 'mod-1', highestPosition: 10 }, roles);
    const target = memberStub(
      {
        id: 'user-1',
        highestPosition: 2,
        add: rolesAdd,
      },
      roles
    );

    const guild = {
      id: 'guild-1',
      ownerId: 'owner-1',
      members: {
        me: memberStub({ id: 'bot-1', highestPosition: 20 }, roles),
        fetch: vi.fn(async (id: string) => {
          if (id === 'mod-1') return executor;
          if (id === 'user-1') return target;
          return null;
        }),
      },
      roles,
    };

    const reply = vi.fn();
    const interaction = {
      locale: 'en-US',
      client: CLIENT,
      user: { id: 'mod-1', tag: 'Mod#0001' },
      member: {
        permissions: new PermissionsBitField(
          PermissionsBitField.Flags.ManageRoles
        ),
      },
      guild,
      options: {
        getUser: vi.fn().mockReturnValue({ id: 'user-1', tag: 'User#0001' }),
        getRole: vi.fn().mockReturnValue(managedRole),
        getSubcommand: vi.fn().mockReturnValue('add'),
      },
      reply,
      replied: false,
      deferred: false,
    };

    await executeRoleCommand(interaction as never);

    expect(rolesAdd).toHaveBeenCalledWith('role-low');
    expect(reply).toHaveBeenCalledWith(
      expect.objectContaining({
        embeds: [
          expect.objectContaining({ title: t('admin.role.add.success', 'en') }),
        ],
      })
    );
    // Role grants are the most privilege-sensitive action the bot performs,
    // so they must reach the audit log.
    expect(roleAdd).toHaveBeenCalledWith(
      CLIENT,
      'guild-1',
      'mod-1',
      'user-1',
      'Role: Muted (role-low)'
    );
  });

  it('rejects managing the guild owner', async () => {
    const { executeRoleCommand } = await import('../application/role.js');
    const rolesRemove = vi.fn().mockResolvedValue(undefined);
    const managedRole = { id: 'role-low', name: 'Muted', position: 2 };
    const roles = {
      cache: {
        get: (id: string) =>
          id === managedRole.id
            ? { ...managedRole, position: managedRole.position }
            : undefined,
      },
    };

    const executor = memberStub({ id: 'mod-1', highestPosition: 50 }, roles);
    const owner = memberStub(
      {
        id: 'owner-1',
        highestPosition: 0,
        roleIds: ['role-low'],
        ownerId: 'owner-1',
        remove: rolesRemove,
      },
      roles
    );

    const guild = {
      id: 'guild-1',
      ownerId: 'owner-1',
      members: {
        me: memberStub({ id: 'bot-1', highestPosition: 20 }, roles),
        fetch: vi.fn(async (id: string) => {
          if (id === 'mod-1') return executor;
          if (id === 'owner-1') return owner;
          return null;
        }),
      },
      roles,
    };

    const reply = vi.fn();
    await executeRoleCommand({
      locale: 'en-US',
      client: CLIENT,
      user: { id: 'mod-1', tag: 'Mod#0001' },
      member: {
        permissions: new PermissionsBitField(
          PermissionsBitField.Flags.ManageRoles
        ),
      },
      guild,
      options: {
        getUser: vi.fn().mockReturnValue({ id: 'owner-1', tag: 'Owner#0001' }),
        getRole: vi.fn().mockReturnValue(managedRole),
        getSubcommand: vi.fn().mockReturnValue('remove'),
      },
      reply,
      replied: false,
      deferred: false,
    } as never);

    expect(rolesRemove).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledWith(
      expect.objectContaining({
        embeds: [
          expect.objectContaining({
            description: t('admin.role.errors.targetMemberHierarchy', 'en'),
          }),
        ],
      })
    );
  });
});
