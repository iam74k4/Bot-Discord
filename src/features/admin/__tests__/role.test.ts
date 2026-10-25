import Database from 'better-sqlite3';
import {
  Collection,
  DiscordAPIError,
  GuildMember,
  MessageFlags,
  PermissionFlagsBits,
  PermissionsBitField,
  RESTJSONErrorCodes,
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
const { COLORS } = await import('../../../shared/utils/constants/index.js');
const { formatPermissionNames } =
  await import('../../../shared/utils/discord.js');

const ACTOR_ID = 'mod-1';
const TARGET_ID = 'member-1';
const OWNER_ID = 'owner-1';
const ROLE = { id: 'role-helper', name: 'Helper', position: 5 };
/** The name the bot's role goes by in Server Settings → Roles. */
const BOT_ROLE = 'Helper Bot';

/** What the members-without-Manage-Roles refusal says. */
const MISSING_MANAGE_ROLES = t('common.permissionsRequired', 'en', {
  permissions: formatPermissionNames(PermissionFlagsBits.ManageRoles, 'en'),
});

/** Audit details are written once, in the server's language (ja here). */
function roleDetails(role: { id: string; name: string } = ROLE): string {
  return t('audit.details.role', 'ja', {
    roleId: role.id,
    roleName: role.name,
  });
}

interface Scenario {
  subcommand?: 'add' | 'remove';
  /** Positions of each party's highest role. `bot: null` = bot not cached. */
  bot?: number | null;
  /** The bot's server-wide permissions; unset = unknown (left to Discord). */
  botPermissions?: bigint[];
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
  extra: {
    roleIds?: string[];
    add?: Mock;
    remove?: Mock;
    displayName?: string;
    highestName?: string;
    permissions?: bigint[];
  } = {}
): GuildMember {
  const roleIds = new Set(extra.roleIds ?? []);
  const member: Record<string, unknown> = {
    id,
    guild,
    displayName: extra.displayName ?? id,
    roles: {
      highest: { position: highest, name: extra.highestName ?? 'Top' },
      cache: { has: (roleId: string) => roleIds.has(roleId) },
      add: extra.add ?? vi.fn().mockResolvedValue(undefined),
      remove: extra.remove ?? vi.fn().mockResolvedValue(undefined),
    },
  };
  // Own properties shadow GuildMember's getters, which need a full client.
  if (extra.permissions) {
    member.permissions = new PermissionsBitField(extra.permissions);
  }
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
          displayName: 'Member *One*',
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
    me:
      s.bot === null
        ? null
        : memberStub('bot', s.bot ?? 20, guild, {
            highestName: BOT_ROLE,
            permissions: s.botPermissions,
          }),
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

      const embed = replyEmbed(reply);
      expect(embed.title).toBe(t('common.serverOnlyTitle', 'en'));
      expect(embed.description).toBe(t('common.guildOnly', 'en'));
      expect(rolesAdd).not.toHaveBeenCalled();
    });

    it('requires Manage Roles, named the way Discord names it', async () => {
      const { interaction, reply, rolesAdd, fetch } = setup({
        permissions: new PermissionsBitField(PermissionFlagsBits.ManageGuild),
      });

      await executeRoleCommand(interaction);

      const embed = replyEmbed(reply);
      expect(embed.title).toBe(t('common.permissionDeniedTitle', 'en'));
      expect(embed.description).toBe(MISSING_MANAGE_ROLES);
      expect(embed.description).toContain('Manage Roles');
      // Not something that went wrong: a warning, not an error.
      expect(embed.color).toBe(COLORS.WARNING);
      expect(fetch).not.toHaveBeenCalled();
      expect(rolesAdd).not.toHaveBeenCalled();
    });

    it('denies when the interaction carries no member', async () => {
      const { interaction, reply } = setup({ member: null });

      await executeRoleCommand(interaction);

      expect(replyEmbed(reply).description).toBe(MISSING_MANAGE_ROLES);
    });

    it('denies when member permissions arrive unresolved', async () => {
      const { interaction, reply } = setup({ permissions: '268435456' });

      await executeRoleCommand(interaction);

      expect(replyEmbed(reply).description).toBe(MISSING_MANAGE_ROLES);
    });

    it('accepts the permissions Discord sent with the interaction', async () => {
      const { interaction, rolesAdd } = setup({ member: null });
      Object.assign(interaction, {
        memberPermissions: new PermissionsBitField(
          PermissionFlagsBits.ManageRoles
        ),
      });

      await executeRoleCommand(interaction);

      expect(rolesAdd).toHaveBeenCalledWith(ROLE.id);
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
      "rejects a role when the bot's highest role is %s it, saying what to drag where",
      async (_case, bot) => {
        const { interaction, reply, rolesAdd } = setup({ bot });

        await executeRoleCommand(interaction);

        expect(replyEmbed(reply).description).toBe(
          t('admin.role.errors.botRoleHierarchy', 'en', {
            role: ROLE.name,
            botRole: BOT_ROLE,
          })
        );
        expect(rolesAdd).not.toHaveBeenCalled();
      }
    );

    it("names the bot's own managed role when Discord reports one", async () => {
      const { interaction, reply } = setup({ bot: 4 });
      const me = interaction.guild!.members.me!;
      Object.assign(me.roles, { botRole: { name: 'Helper Bot (managed)' } });

      await executeRoleCommand(interaction);

      expect(replyEmbed(reply).description).toBe(
        t('admin.role.errors.botRoleHierarchy', 'en', {
          role: ROLE.name,
          botRole: 'Helper Bot (managed)',
        })
      );
    });

    it('rejects when the bot member is not cached', async () => {
      const { interaction, reply, rolesAdd } = setup({ bot: null });

      await executeRoleCommand(interaction);

      expect(replyEmbed(reply).description).toBe(
        t('admin.role.errors.botRoleHierarchy', 'en', {
          role: ROLE.name,
          botRole: 'Bot',
        })
      );
      expect(rolesAdd).not.toHaveBeenCalled();
    });

    it('rejects a role that is not in the guild role cache', async () => {
      const { interaction, reply } = setup({ roleCached: false });

      await executeRoleCommand(interaction);

      expect(replyEmbed(reply).description).toBe(
        t('admin.role.errors.botRoleHierarchy', 'en', {
          role: ROLE.name,
          botRole: BOT_ROLE,
        })
      );
    });
  });

  describe('bot permission', () => {
    it('says the bot lacks Manage Roles before Discord is asked', async () => {
      const { interaction, reply, rolesAdd } = setup({
        botPermissions: [PermissionFlagsBits.SendMessages],
      });

      await executeRoleCommand(interaction);

      expect(replyEmbed(reply).description).toBe(
        t('admin.role.errors.botMissingManageRoles', 'en', {
          botRole: BOT_ROLE,
        })
      );
      expect(rolesAdd).not.toHaveBeenCalled();
    });

    it('goes ahead when the bot holds Manage Roles', async () => {
      const { interaction, rolesAdd } = setup({
        botPermissions: [PermissionFlagsBits.ManageRoles],
      });

      await executeRoleCommand(interaction);

      expect(rolesAdd).toHaveBeenCalledWith(ROLE.id);
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
   * Regression: the guild owner passes the Manage Roles check (Discord
   * resolves the owner as having every permission) but used to be held to
   * the actor hierarchy checks too, so an owner whose own highest role is low
   * was refused roles and members Discord itself lets them manage. Only the
   * bot's limits apply to the owner.
   */
  describe('guild owner as actor', () => {
    it.each([
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

    it('still cannot reach past the bot', async () => {
      const { interaction, reply, rolesAdd } = setup({
        ownerId: ACTOR_ID,
        actor: 0,
        bot: 20,
        target: 25,
      });

      await executeRoleCommand(interaction);

      expect(replyEmbed(reply).description).toBe(
        t('admin.role.errors.botTargetMemberHierarchy', 'en')
      );
      expect(rolesAdd).not.toHaveBeenCalled();
    });
  });

  /**
   * Regression: nothing used to check `role.managed` (bot/integration/booster
   * roles Discord never lets anyone assign) or stop removing @everyone (id =
   * guild id, which discord.js always reports as held). Both reached
   * `member.roles.add/remove`, Discord rejected them, and the moderator got
   * the generic "failed" reply plus an error log instead of a clear refusal.
   */
  describe('roles Discord never lets anyone assign', () => {
    it.each(['add', 'remove'] as const)(
      'refuses to %s a managed role before calling Discord',
      async (subcommand) => {
        const { interaction, reply, rolesAdd, rolesRemove } = setup({
          subcommand,
          role: { ...ROLE, managed: true },
          targetHasRole: subcommand === 'remove',
        });

        await executeRoleCommand(interaction);

        expect(rolesAdd).not.toHaveBeenCalled();
        expect(rolesRemove).not.toHaveBeenCalled();
        expect(replyEmbed(reply).description).toBe(
          t('admin.role.errors.managedRole', 'en', { role: ROLE.name })
        );
        expect(logger.error).not.toHaveBeenCalled();
      }
    );

    it.each(['add', 'remove'] as const)(
      'refuses to %s @everyone before calling Discord',
      async (subcommand) => {
        const everyone = { id: GUILD_ID, name: '@everyone', position: 0 };
        const { interaction, reply, rolesAdd, rolesRemove } = setup({
          subcommand,
          role: everyone,
          targetHasRole: true,
        });

        await executeRoleCommand(interaction);

        expect(rolesAdd).not.toHaveBeenCalled();
        expect(rolesRemove).not.toHaveBeenCalled();
        expect(replyEmbed(reply).description).toBe(
          t('admin.role.errors.everyoneRole', 'en')
        );
      }
    );

    it('refuses a managed role even before the bot permission is checked', async () => {
      const { interaction, reply } = setup({
        role: { ...ROLE, managed: true },
        botPermissions: [],
      });

      await executeRoleCommand(interaction);

      expect(replyEmbed(reply).description).toBe(
        t('admin.role.errors.managedRole', 'en', { role: ROLE.name })
      );
    });
  });

  describe('add', () => {
    it('adds the role, confirms, and audit-logs the grant', async () => {
      const { interaction, reply, rolesAdd } = setup({ subcommand: 'add' });

      await executeRoleCommand(interaction);

      expect(rolesAdd).toHaveBeenCalledWith(ROLE.id);
      const embed = replyEmbed(reply);
      expect(embed.title).toBe(t('admin.role.add.success', 'en'));
      // Mentions plus the server display name, not the account tag; the
      // name is escaped so markdown in it cannot restyle the reply.
      expect(embed.description).toBe(
        t('admin.role.add.successDesc', 'en', {
          userId: TARGET_ID,
          displayName: 'Member \\*One\\*',
          roleId: ROLE.id,
        })
      );
      expect(embed.description).toContain(`<@&${ROLE.id}>`);
      expect(auditRows(db)).toEqual([
        {
          action: 'ROLE_ADD',
          user_id: ACTOR_ID,
          target_id: TARGET_ID,
          details: roleDetails(),
        },
      ]);
    });

    it('warns instead of calling Discord when the member already has it', async () => {
      const { interaction, reply, rolesAdd } = setup({
        subcommand: 'add',
        targetHasRole: true,
      });

      await executeRoleCommand(interaction);

      expect(rolesAdd).not.toHaveBeenCalled();
      const embed = replyEmbed(reply);
      expect(embed.title).toBe(t('common.warning', 'en'));
      expect(embed.color).toBe(COLORS.WARNING);
      expect(embed.description).toBe(
        t('admin.role.errors.alreadyHasRole', 'en')
      );
      expect(auditRows(db)).toEqual([]);
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
          userId: TARGET_ID,
          displayName: 'Member \\*One\\*',
          roleId: ROLE.id,
        })
      );
      expect(auditRows(db)).toEqual([
        {
          action: 'ROLE_REMOVE',
          user_id: ACTOR_ID,
          target_id: TARGET_ID,
          details: roleDetails(),
        },
      ]);
    });

    it('writes the audit details in English on a server set to English', async () => {
      db.prepare(
        "INSERT INTO guild_settings (guild_id, language, created_at, updated_at) VALUES (?, 'en', 0, 0)"
      ).run(GUILD_ID);
      const { interaction } = setup({
        subcommand: 'remove',
        targetHasRole: true,
      });

      await executeRoleCommand(interaction);

      expect(auditRows(db)[0]?.details).toBe(
        t('audit.details.role', 'en', { roleId: ROLE.id, roleName: 'Helper' })
      );
    });

    it('warns instead of calling Discord when the member lacks it', async () => {
      const { interaction, reply, rolesRemove } = setup({
        subcommand: 'remove',
        targetHasRole: false,
      });

      await executeRoleCommand(interaction);

      expect(rolesRemove).not.toHaveBeenCalled();
      const embed = replyEmbed(reply);
      expect(embed.color).toBe(COLORS.WARNING);
      expect(embed.description).toBe(
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

    it('names the missing bot permission when Discord says so', async () => {
      const missingPermissions = new DiscordAPIError(
        {
          code: RESTJSONErrorCodes.MissingPermissions,
          message: 'Missing Permissions',
        },
        RESTJSONErrorCodes.MissingPermissions,
        403,
        'PUT',
        '/guilds/guild-1/members/member-1/roles/role-helper',
        {}
      );
      const { interaction, reply } = setup({
        rolesAdd: vi.fn().mockRejectedValue(missingPermissions),
      });

      await executeRoleCommand(interaction);

      expect(replyEmbed(reply).description).toBe(
        t('admin.role.errors.botMissingManageRoles', 'en', {
          botRole: BOT_ROLE,
        })
      );
      expect(auditRows(db)).toEqual([]);
    });

    /**
     * Regression: the confirmation reply used to sit in the same `try` as the
     * role change, so a lost confirmation was reported as "Failed to modify
     * role." although the change went through (and was audited), and a retry
     * then said the member already had the role. Now only the change is
     * guarded; a failed confirmation reaches the router like any other
     * command's.
     */
    it('lets a lost confirmation reach the router instead of reporting a failed change', async () => {
      const lost = new Error('Unknown interaction');
      const reply = vi.fn().mockRejectedValue(lost);
      const { interaction, rolesAdd } = setup({ reply });

      await expect(executeRoleCommand(interaction)).rejects.toBe(lost);

      expect(rolesAdd).toHaveBeenCalledTimes(1);
      // One attempt only: nothing claims the change failed.
      expect(reply).toHaveBeenCalledTimes(1);
      expect(embedAt(payloadOf<{ embeds: unknown[] }>(reply)).title).toBe(
        t('admin.role.add.success', 'en')
      );
      expect(auditRows(db).map((row) => row.action)).toEqual(['ROLE_ADD']);
      expect(logger.error).not.toHaveBeenCalled();
    });
  });
});
