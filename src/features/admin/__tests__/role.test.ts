import Database from 'better-sqlite3';
import {
  Collection,
  GuildMember,
  MessageFlags,
  PermissionFlagsBits,
  PermissionsBitField,
  type ChatInputCommandInteraction,
} from 'discord.js';
import {
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from 'vitest';
import {
  GUILD_ID,
  auditRows,
  clearAdminTables,
  clientStub,
  embedAt,
  migrateAdminSchema,
  payloadOf,
} from './admin.helpers.js';

/**
 * `/admin role add|remove` is the most privilege-sensitive thing the bot does
 * on a moderator's behalf. Discord only enforces the *bot's* hierarchy on API
 * calls, so the command has to re-check the *actor's* hierarchy itself. Each
 * guard is exercised on its own here, with the role change and its audit row
 * observed through the real audit service on in-memory SQLite.
 */

const db = new Database(':memory:');

vi.mock('../../../infrastructure/database/connection.js', () => ({
  database: db,
}));

vi.mock('../../../shared/utils/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
  getErrorMessage: (e: unknown) => String(e),
}));

const { executeRoleCommand } = await import('../application/role.js');
const { t } = await import('../../../locales/index.js');
const { logger } = await import('../../../shared/utils/logger.js');

const ACTOR_ID = 'mod-1';
const TARGET_ID = 'member-1';
const OWNER_ID = 'owner-1';
const ROLE = { id: 'role-helper', name: 'Helper', position: 5 };

interface Scenario {
  subcommand?: 'add' | 'remove';
  /** Positions of each party's highest role. `bot: null` = bot not cached. */
  bot?: number | null;
  actor?: number;
  target?: number;
  role?: { id: string; name: string; position: number; managed?: boolean };
  /** Whether the role is in the guild's role cache. */
  roleCached?: boolean;
  targetId?: string;
  targetHasRole?: boolean;
  /** How fetching each member resolves. */
  fetchTarget?: 'member' | 'missing' | 'plain-object';
  fetchActor?: 'member' | 'missing';
  permissions?: PermissionsBitField | string;
  /** `null` = the interaction carries no member object. */
  member?: null;
  ownerId?: string;
  inGuild?: boolean;
  rolesAdd?: Mock;
  rolesRemove?: Mock;
  reply?: Mock;
  replied?: boolean;
}

function memberStub(
  id: string,
  highest: number,
  guild: unknown,
  extra: { roleIds?: string[]; add?: Mock; remove?: Mock } = {}
): GuildMember {
  const roleIds = new Set(extra.roleIds ?? []);
  const member = {
    id,
    guild,
    roles: {
      highest: { position: highest },
      cache: { has: (roleId: string) => roleIds.has(roleId) },
      add: extra.add ?? vi.fn().mockResolvedValue(undefined),
      remove: extra.remove ?? vi.fn().mockResolvedValue(undefined),
    },
  };
  Object.setPrototypeOf(member, GuildMember.prototype);
  return member as unknown as GuildMember;
}

function setup(s: Scenario = {}) {
  const role = s.role ?? ROLE;
  const targetId = s.targetId ?? TARGET_ID;
  const rolesAdd = s.rolesAdd ?? vi.fn().mockResolvedValue(undefined);
  const rolesRemove = s.rolesRemove ?? vi.fn().mockResolvedValue(undefined);
  const reply = s.reply ?? vi.fn().mockResolvedValue({});
  const editReply = vi.fn().mockResolvedValue({});

  const guild: Record<string, unknown> = {
    id: GUILD_ID,
    ownerId: s.ownerId ?? OWNER_ID,
    roles: {
      cache: new Collection(
        s.roleCached === false ? [] : [[role.id, { ...role }]]
      ),
    },
  };
  const actor = memberStub(ACTOR_ID, s.actor ?? 10, guild);
  const target =
    targetId === ACTOR_ID
      ? actor
      : memberStub(targetId, s.target ?? 1, guild, {
          roleIds: s.targetHasRole ? [role.id] : [],
          add: rolesAdd,
          remove: rolesRemove,
        });
  if (targetId === ACTOR_ID) {
    Object.assign(target.roles, {
      cache: { has: () => s.targetHasRole ?? false },
      add: rolesAdd,
      remove: rolesRemove,
    });
  }

  const fetch = vi.fn(async (id: string) => {
    if (id === ACTOR_ID && targetId !== ACTOR_ID) {
      if (s.fetchActor === 'missing') throw new Error('Unknown Member');
      return actor;
    }
    if (id === targetId) {
      if (s.fetchTarget === 'missing') throw new Error('Unknown Member');
      if (s.fetchTarget === 'plain-object') return { id };
      return target;
    }
    throw new Error('Unknown Member');
  });
  guild.members = {
    me: s.bot === null ? null : memberStub('bot', s.bot ?? 20, guild),
    fetch,
  };

  const interaction = {
    guild: s.inGuild === false ? null : guild,
    guildId: s.inGuild === false ? null : GUILD_ID,
    locale: 'en-US',
    user: { id: ACTOR_ID, tag: 'Mod#0001' },
    member:
      s.member === null
        ? null
        : {
            permissions:
              s.permissions ??
              new PermissionsBitField(PermissionFlagsBits.ManageRoles),
          },
    client: clientStub(),
    options: {
      getUser: vi.fn(() => ({ id: targetId, tag: 'Member#0001' })),
      getRole: vi.fn(() => role),
      getSubcommand: vi.fn(() => s.subcommand ?? 'add'),
    },
    reply,
    editReply,
    replied: s.replied ?? false,
    deferred: false,
  } as unknown as ChatInputCommandInteraction;

  return { interaction, reply, editReply, rolesAdd, rolesRemove, fetch };
}

/** The ephemeral error/success embed of the only reply. */
function replyEmbed(reply: Mock) {
  expect(reply).toHaveBeenCalledTimes(1);
  const payload = payloadOf<{ embeds: unknown[]; flags?: number }>(reply);
  expect(payload.flags).toBe(MessageFlags.Ephemeral);
  return embedAt(payload);
}

describe('executeRoleCommand', () => {
  beforeAll(async () => {
    await migrateAdminSchema();
  });

  beforeEach(() => {
    clearAdminTables(db);
    vi.clearAllMocks();
  });

  describe('guards before any hierarchy check', () => {
    it('refuses outside a guild', async () => {
      const { interaction, reply, rolesAdd } = setup({ inGuild: false });

      await executeRoleCommand(interaction);

      expect(replyEmbed(reply).description).toBe(t('common.guildOnly', 'en'));
      expect(rolesAdd).not.toHaveBeenCalled();
    });

    it('requires Manage Roles', async () => {
      const { interaction, reply, rolesAdd, fetch } = setup({
        permissions: new PermissionsBitField(PermissionFlagsBits.ManageGuild),
      });

      await executeRoleCommand(interaction);

      expect(replyEmbed(reply).description).toBe(
        t('admin.role.errors.noPermission', 'en')
      );
      expect(fetch).not.toHaveBeenCalled();
      expect(rolesAdd).not.toHaveBeenCalled();
    });

    it('denies when the interaction carries no member', async () => {
      const { interaction, reply } = setup({ member: null });

      await executeRoleCommand(interaction);

      expect(replyEmbed(reply).description).toBe(
        t('admin.role.errors.noPermission', 'en')
      );
    });

    it('denies when member permissions arrive unresolved', async () => {
      const { interaction, reply } = setup({ permissions: '268435456' });

      await executeRoleCommand(interaction);

      expect(replyEmbed(reply).description).toBe(
        t('admin.role.errors.noPermission', 'en')
      );
    });

    it.each([
      ['is not in the guild', 'missing'],
      ['resolves to something other than a member', 'plain-object'],
    ] as const)('reports a target that %s', async (_case, fetchTarget) => {
      const { interaction, reply, rolesAdd } = setup({ fetchTarget });

      await executeRoleCommand(interaction);

      expect(replyEmbed(reply).description).toBe(
        t('admin.role.errors.memberNotFound', 'en')
      );
      expect(rolesAdd).not.toHaveBeenCalled();
    });
  });

  describe('bot vs role hierarchy', () => {
    it.each([
      ['below', 4],
      ['level with', 5],
    ])(
      "rejects a role when the bot's highest role is %s it",
      async (_case, bot) => {
        const { interaction, reply, rolesAdd } = setup({ bot });

        await executeRoleCommand(interaction);

        expect(replyEmbed(reply).description).toBe(
          t('admin.role.errors.botRoleHierarchy', 'en')
        );
        expect(rolesAdd).not.toHaveBeenCalled();
      }
    );

    it('rejects when the bot member is not cached', async () => {
      const { interaction, reply } = setup({ bot: null });

      await executeRoleCommand(interaction);

      expect(replyEmbed(reply).description).toBe(
        t('admin.role.errors.botRoleHierarchy', 'en')
      );
    });

    it('rejects a role that is not in the guild role cache', async () => {
      const { interaction, reply } = setup({ roleCached: false });

      await executeRoleCommand(interaction);

      expect(replyEmbed(reply).description).toBe(
        t('admin.role.errors.botRoleHierarchy', 'en')
      );
    });
  });

  describe('actor vs role hierarchy', () => {
    it.each([
      ['below', 4],
      ['level with', 5],
    ])(
      "rejects a role when the actor's highest role is %s it",
      async (_case, actor) => {
        const { interaction, reply, rolesAdd } = setup({ actor });

        await executeRoleCommand(interaction);

        expect(replyEmbed(reply).description).toBe(
          t('admin.role.errors.actorRoleHierarchy', 'en')
        );
        expect(rolesAdd).not.toHaveBeenCalled();
      }
    );

    it('rejects when the actor cannot be fetched', async () => {
      const { interaction, reply } = setup({ fetchActor: 'missing' });

      await executeRoleCommand(interaction);

      expect(replyEmbed(reply).description).toBe(
        t('admin.role.errors.actorRoleHierarchy', 'en')
      );
    });
  });

  describe('actor vs target member hierarchy', () => {
    it.each([
      ['above', 11],
      ['level with', 10],
    ])(
      'rejects a target whose highest role is %s the actor',
      async (_case, target) => {
        const { interaction, reply, rolesAdd } = setup({ actor: 10, target });

        await executeRoleCommand(interaction);

        expect(replyEmbed(reply).description).toBe(
          t('admin.role.errors.targetMemberHierarchy', 'en')
        );
        expect(rolesAdd).not.toHaveBeenCalled();
      }
    );

    it('rejects the guild owner even when their roles are lower', async () => {
      const { interaction, reply, rolesAdd } = setup({
        targetId: OWNER_ID,
        target: 0,
      });

      await executeRoleCommand(interaction);

      expect(replyEmbed(reply).description).toBe(
        t('admin.role.errors.targetMemberHierarchy', 'en')
      );
      expect(rolesAdd).not.toHaveBeenCalled();
    });

    it('lets a moderator manage their own roles below their highest', async () => {
      const { interaction, reply, rolesAdd } = setup({
        targetId: ACTOR_ID,
        actor: 10,
      });

      await executeRoleCommand(interaction);

      expect(rolesAdd).toHaveBeenCalledWith(ROLE.id);
      expect(replyEmbed(reply).title).toBe(t('admin.role.add.success', 'en'));
    });
  });

  describe('bot vs target member hierarchy', () => {
    it.each([
      ['above', 21],
      ['level with', 20],
    ])(
      'rejects a target whose highest role is %s the bot',
      async (_case, target) => {
        const { interaction, reply, rolesAdd } = setup({
          bot: 20,
          actor: 30,
          target,
        });

        await executeRoleCommand(interaction);

        expect(replyEmbed(reply).description).toBe(
          t('admin.role.errors.botTargetMemberHierarchy', 'en')
        );
        expect(rolesAdd).not.toHaveBeenCalled();
      }
    );
  });

  describe('guild owner as target', () => {
    it('is refused by the bot even when the owner targets themselves', async () => {
      // Nobody, the bot included, can edit the owner's roles via the API.
      const { interaction, reply, rolesAdd } = setup({
        ownerId: ACTOR_ID,
        targetId: ACTOR_ID,
        actor: 10,
      });

      await executeRoleCommand(interaction);

      expect(replyEmbed(reply).description).toBe(
        t('admin.role.errors.botTargetMemberHierarchy', 'en')
      );
      expect(rolesAdd).not.toHaveBeenCalled();
    });
  });

  /**
   * KNOWN BUG (role.ts checkActorCanManageRole / checkActorCanManageMember):
   * the guild owner passes the Manage Roles check (Discord resolves the owner
   * as having every permission) but is then held to the actor hierarchy
   * checks, which compare role positions with no `executor.id ===
   * guild.ownerId` shortcut. An owner whose highest role is low gets refused
   * for roles and members Discord itself lets them manage. Over-restrictive,
   * not a privilege escalation. `it.fails` keeps the suite green until the
   * fix lands; then these start failing and should become a plain `it`.
   */
  describe('guild owner as actor', () => {
    it.fails.each([
      ['a role above their own highest role', { actor: 0, target: 0 }],
      ['a role to a member ranked above them', { actor: 10, target: 15 }],
    ])('may grant %s', async (_case, positions) => {
      const { interaction, rolesAdd } = setup({
        ownerId: ACTOR_ID,
        ...positions,
      });

      await executeRoleCommand(interaction);

      expect(rolesAdd).toHaveBeenCalledWith(ROLE.id);
    });
  });

  /**
   * KNOWN BUG (role.ts executeRoleCommand): nothing checks `role.managed`
   * (bot/integration/booster roles Discord never lets anyone assign) or stops
   * removing @everyone (id = guild id, which discord.js always reports as
   * held). Both reach `member.roles.add/remove`, Discord rejects them, and the
   * moderator gets the generic "failed" reply plus an error log instead of a
   * clear refusal. `it.fails` keeps the suite green until the fix lands; then
   * these start failing and should become a plain `it`.
   */
  describe('roles Discord never lets anyone assign', () => {
    it.fails.each(['add', 'remove'] as const)(
      'refuses to %s a managed role before calling Discord',
      async (subcommand) => {
        const { interaction, rolesAdd, rolesRemove } = setup({
          subcommand,
          role: { ...ROLE, managed: true },
          targetHasRole: subcommand === 'remove',
        });

        await executeRoleCommand(interaction);

        expect(rolesAdd).not.toHaveBeenCalled();
        expect(rolesRemove).not.toHaveBeenCalled();
      }
    );

    it.fails('refuses to remove @everyone before calling Discord', async () => {
      const everyone = { id: GUILD_ID, name: '@everyone', position: 0 };
      const { interaction, rolesRemove } = setup({
        subcommand: 'remove',
        role: everyone,
        targetHasRole: true,
      });

      await executeRoleCommand(interaction);

      expect(rolesRemove).not.toHaveBeenCalled();
    });
  });

  describe('add', () => {
    it('adds the role, confirms, and audit-logs the grant', async () => {
      const { interaction, reply, rolesAdd } = setup({ subcommand: 'add' });

      await executeRoleCommand(interaction);

      expect(rolesAdd).toHaveBeenCalledWith(ROLE.id);
      const embed = replyEmbed(reply);
      expect(embed.title).toBe(t('admin.role.add.success', 'en'));
      expect(embed.description).toBe(
        t('admin.role.add.successDesc', 'en', {
          user: 'Member#0001',
          role: 'Helper',
        })
      );
      expect(auditRows(db)).toEqual([
        {
          action: 'ROLE_ADD',
          user_id: ACTOR_ID,
          target_id: TARGET_ID,
          details: 'Role: Helper (role-helper)',
        },
      ]);
    });

    // KNOWN BUG (reported, role.ts): the confirmation reply sits in the same
    // `try` as the role change, so when Discord rejects the confirmation after
    // the role was granted, the moderator is told "Failed to modify role."
    // and a retry then says the member already has it. `it.fails` until the
    // reply is outside that `try`; then change it to `it`.
    it.fails(
      'does not report a granted role as failed when only the confirmation is lost',
      async () => {
        const reply = vi
          .fn()
          .mockRejectedValueOnce(new Error('Unknown interaction'))
          .mockResolvedValue({});
        const { interaction, editReply, rolesAdd } = setup({
          subcommand: 'add',
          reply,
        });

        await executeRoleCommand(interaction).catch(() => undefined);

        expect(rolesAdd).toHaveBeenCalledWith(ROLE.id);
        const failed = t('admin.role.errors.failed', 'en');
        const described = [...reply.mock.calls, ...editReply.mock.calls].map(
          ([payload]) =>
            (payload as { embeds?: Array<{ data?: { description?: string } }> })
              .embeds?.[0]?.data?.description
        );
        expect(described).not.toContain(failed);
      }
    );

    it('warns instead of calling Discord when the member already has it', async () => {
      const { interaction, reply, rolesAdd } = setup({
        subcommand: 'add',
        targetHasRole: true,
      });

      await executeRoleCommand(interaction);

      expect(rolesAdd).not.toHaveBeenCalled();
      const embed = replyEmbed(reply);
      expect(embed.title).toBe(t('common.warning', 'en'));
      expect(embed.description).toBe(
        t('admin.role.errors.alreadyHasRole', 'en')
      );
      expect(auditRows(db)).toEqual([]);
    });

    it('never asks Discord to grant @everyone', async () => {
      // discord.js keeps the @everyone role (id = guild id) in every member's
      // role cache, so it always reads as already held.
      const everyone = { id: GUILD_ID, name: '@everyone', position: 0 };
      const { interaction, reply, rolesAdd } = setup({
        subcommand: 'add',
        role: everyone,
        targetHasRole: true,
      });

      await executeRoleCommand(interaction);

      expect(rolesAdd).not.toHaveBeenCalled();
      expect(replyEmbed(reply).description).toBe(
        t('admin.role.errors.alreadyHasRole', 'en')
      );
    });
  });

  describe('remove', () => {
    it('removes the role, confirms, and audit-logs the removal', async () => {
      const { interaction, reply, rolesRemove } = setup({
        subcommand: 'remove',
        targetHasRole: true,
      });

      await executeRoleCommand(interaction);

      expect(rolesRemove).toHaveBeenCalledWith(ROLE.id);
      const embed = replyEmbed(reply);
      expect(embed.title).toBe(t('admin.role.remove.success', 'en'));
      expect(embed.description).toBe(
        t('admin.role.remove.successDesc', 'en', {
          user: 'Member#0001',
          role: 'Helper',
        })
      );
      expect(auditRows(db)).toEqual([
        {
          action: 'ROLE_REMOVE',
          user_id: ACTOR_ID,
          target_id: TARGET_ID,
          details: 'Role: Helper (role-helper)',
        },
      ]);
    });

    it('warns instead of calling Discord when the member lacks it', async () => {
      const { interaction, reply, rolesRemove } = setup({
        subcommand: 'remove',
        targetHasRole: false,
      });

      await executeRoleCommand(interaction);

      expect(rolesRemove).not.toHaveBeenCalled();
      expect(replyEmbed(reply).description).toBe(
        t('admin.role.errors.doesNotHaveRole', 'en')
      );
    });
  });

  describe('when Discord rejects the change', () => {
    const apiError = new Error('Missing Permissions');

    it.each([
      ['add', false],
      ['remove', true],
    ] as const)(
      'reports a failed %s and records nothing',
      async (subcommand, targetHasRole) => {
        const { interaction, reply } = setup({
          subcommand,
          targetHasRole,
          rolesAdd: vi.fn().mockRejectedValue(apiError),
          rolesRemove: vi.fn().mockRejectedValue(apiError),
        });

        await executeRoleCommand(interaction);

        expect(replyEmbed(reply).description).toBe(
          t('admin.role.errors.failed', 'en')
        );
        expect(auditRows(db)).toEqual([]);
        expect(logger.error).toHaveBeenCalledWith(
          `Failed to ${subcommand} role ${ROLE.id} for ${TARGET_ID}:`,
          String(apiError)
        );
      }
    );

    it('edits the reply when the interaction was already answered', async () => {
      const { interaction, reply, editReply } = setup({
        rolesAdd: vi.fn().mockRejectedValue(apiError),
        replied: true,
      });

      await executeRoleCommand(interaction);

      expect(reply).not.toHaveBeenCalled();
      expect(
        embedAt(payloadOf<{ embeds: unknown[] }>(editReply)).description
      ).toBe(t('admin.role.errors.failed', 'en'));
    });

    it('does not throw when editing the error into an answered reply fails', async () => {
      const { interaction, editReply } = setup({
        rolesAdd: vi.fn().mockRejectedValue(apiError),
        replied: true,
      });
      editReply.mockRejectedValue(new Error('Unknown Message'));

      await expect(executeRoleCommand(interaction)).resolves.toBeUndefined();

      expect(editReply).toHaveBeenCalledTimes(1);
    });

    it('does not throw when the success reply itself fails', async () => {
      // The role was changed; a failed confirmation falls into the error path,
      // whose own reply failing must be swallowed rather than crash the handler.
      const reply = vi.fn().mockRejectedValue(new Error('Unknown interaction'));
      const { interaction, rolesAdd } = setup({ reply });

      await expect(executeRoleCommand(interaction)).resolves.toBeUndefined();

      expect(rolesAdd).toHaveBeenCalledTimes(1);
      expect(reply).toHaveBeenCalledTimes(2);
    });
  });
});
