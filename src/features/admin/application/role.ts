import {
  ChatInputCommandInteraction,
  DiscordAPIError,
  GuildMember,
  MessageFlags,
  PermissionFlagsBits,
  RESTJSONErrorCodes,
  escapeMarkdown,
  type EmbedBuilder,
  type Guild,
} from 'discord.js';
import {
  createEmbed,
  createErrorEmbed,
  createWarningEmbed,
} from '../../../shared/utils/embed.js';
import { COLORS } from '../../../shared/utils/constants/index.js';
import { createPermissionDeniedEmbed } from '../../../shared/utils/discord.js';
import { t, type Locale } from '../../../locales/index.js';
import {
  resolveBackgroundLocale,
  resolveLocale,
} from '../../../locales/guildLocale.js';
import { audit } from '../../../infrastructure/audit/index.js';
import { getErrorMessage, logger } from '../../../shared/utils/logger.js';
import {
  botServerPermissions,
  memberHasServerPermission,
} from './permissions.js';

/** The bot's role as people see it in Server Settings → Roles. */
function botRoleName(interaction: ChatInputCommandInteraction): string {
  const roles = interaction.guild?.members.me?.roles;
  return (
    roles?.botRole?.name ??
    roles?.highest?.name ??
    interaction.client.user?.username ??
    'Bot'
  );
}

function checkBotCanManageRole(guild: Guild, roleId: string): boolean {
  if (!guild.members.me) return false;
  const botHighestRole = guild.members.me.roles.highest;
  const role = guild.roles.cache.get(roleId);
  if (!role) return false;
  return botHighestRole.position > role.position;
}

function checkActorCanManageRole(
  executor: GuildMember,
  roleId: string
): boolean {
  const role = executor.guild.roles.cache.get(roleId);
  if (!role) return false;
  return executor.roles.highest.position > role.position;
}

/**
 * Discord's client blocks Manage Roles on members at or above the actor.
 * The bot API only enforces bot hierarchy, so slash commands must mirror
 * that actor-vs-target check or junior mods can edit senior members.
 */
function checkActorCanManageMember(
  executor: GuildMember,
  target: GuildMember
): boolean {
  if (target.id === target.guild.ownerId && executor.id !== target.id) {
    return false;
  }
  if (executor.id === target.id) {
    return true;
  }
  return executor.roles.highest.position > target.roles.highest.position;
}

function checkBotCanManageMember(guild: Guild, target: GuildMember): boolean {
  const botMember = guild.members.me;
  if (!botMember) return false;
  if (target.id === target.guild.ownerId) return false;
  return botMember.roles.highest.position > target.roles.highest.position;
}

/** Discord's answer when the bot lacks a permission for the request. */
function isMissingPermissions(error: unknown): boolean {
  return (
    error instanceof DiscordAPIError &&
    error.code === RESTJSONErrorCodes.MissingPermissions
  );
}

async function replyPrivately(
  interaction: ChatInputCommandInteraction,
  embed: EmbedBuilder
): Promise<void> {
  await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}

function refusal(locale: Locale, description: string): EmbedBuilder {
  return createErrorEmbed(t('common.error', locale), description);
}

export async function executeRoleCommand(
  interaction: ChatInputCommandInteraction
): Promise<void> {
  const locale = resolveLocale(interaction);
  const guild = interaction.guild;

  if (!guild) {
    await replyPrivately(
      interaction,
      createWarningEmbed(
        t('common.serverOnlyTitle', locale),
        t('common.guildOnly', locale)
      )
    );
    return;
  }

  if (
    !memberHasServerPermission(interaction, PermissionFlagsBits.ManageRoles)
  ) {
    await replyPrivately(
      interaction,
      createPermissionDeniedEmbed(PermissionFlagsBits.ManageRoles, locale)
    );
    return;
  }

  const user = interaction.options.getUser('user', true);
  const role = interaction.options.getRole('role', true);
  const roleName = escapeMarkdown(role.name);

  const member = await guild.members.fetch(user.id).catch(() => null);
  if (!member || !(member instanceof GuildMember)) {
    await replyPrivately(
      interaction,
      refusal(locale, t('admin.role.errors.memberNotFound', locale))
    );
    return;
  }

  // Roles nobody can assign by hand, checked before anything the server
  // could fix, so the moderator is not sent to fix permissions in vain.
  // @everyone (id = guild id) is in every member's role cache, so without
  // this an add would claim the member "already has it".
  if (role.id === guild.id) {
    await replyPrivately(
      interaction,
      refusal(locale, t('admin.role.errors.everyoneRole', locale))
    );
    return;
  }

  if ((guild.roles.cache.get(role.id) ?? role).managed) {
    await replyPrivately(
      interaction,
      refusal(
        locale,
        t('admin.role.errors.managedRole', locale, { role: roleName })
      )
    );
    return;
  }

  const botPermissions = botServerPermissions(guild);
  if (botPermissions && !botPermissions.has(PermissionFlagsBits.ManageRoles)) {
    await replyPrivately(
      interaction,
      refusal(
        locale,
        t('admin.role.errors.botMissingManageRoles', locale, {
          botRole: escapeMarkdown(botRoleName(interaction)),
        })
      )
    );
    return;
  }

  if (!checkBotCanManageRole(guild, role.id)) {
    await replyPrivately(
      interaction,
      refusal(
        locale,
        t('admin.role.errors.botRoleHierarchy', locale, {
          role: roleName,
          botRole: escapeMarkdown(botRoleName(interaction)),
        })
      )
    );
    return;
  }

  const executor = await guild.members
    .fetch(interaction.user.id)
    .catch(() => null);
  // Discord lets the server owner manage every role and member regardless
  // of where their own roles sit; only the bot's limits still apply.
  const isOwner = executor?.id === guild.ownerId;
  if (!executor || (!isOwner && !checkActorCanManageRole(executor, role.id))) {
    await replyPrivately(
      interaction,
      refusal(locale, t('admin.role.errors.actorRoleHierarchy', locale))
    );
    return;
  }

  if (!isOwner && !checkActorCanManageMember(executor, member)) {
    await replyPrivately(
      interaction,
      refusal(locale, t('admin.role.errors.targetMemberHierarchy', locale))
    );
    return;
  }

  if (!checkBotCanManageMember(guild, member)) {
    await replyPrivately(
      interaction,
      refusal(locale, t('admin.role.errors.botTargetMemberHierarchy', locale))
    );
    return;
  }

  const adding = interaction.options.getSubcommand() === 'add';

  if (adding === member.roles.cache.has(role.id)) {
    await replyPrivately(
      interaction,
      createWarningEmbed(
        t('common.warning', locale),
        t(
          adding
            ? 'admin.role.errors.alreadyHasRole'
            : 'admin.role.errors.doesNotHaveRole',
          locale
        )
      )
    );
    return;
  }

  // Only the change itself is guarded here. A lost confirmation below is
  // not a failed change, so it is left to the router's error reply rather
  // than reported as "failed" for a role that was in fact changed.
  try {
    if (adding) {
      await member.roles.add(role.id);
    } else {
      await member.roles.remove(role.id);
    }
  } catch (error) {
    logger.error(
      `Failed to ${adding ? 'add' : 'remove'} role ${role.id} for ${user.id}:`,
      getErrorMessage(error)
    );
    await replyPrivately(
      interaction,
      refusal(
        locale,
        isMissingPermissions(error)
          ? t('admin.role.errors.botMissingManageRoles', locale, {
              botRole: escapeMarkdown(botRoleName(interaction)),
            })
          : t('admin.role.errors.failed', locale)
      )
    );
    return;
  }

  const details = t('audit.details.role', resolveBackgroundLocale(guild), {
    roleId: role.id,
    roleName,
  });
  void (adding ? audit.roleAdd : audit.roleRemove)(
    interaction.client,
    guild.id,
    interaction.user.id,
    member.id,
    details
  );

  await replyPrivately(
    interaction,
    createEmbed({
      title: t(
        adding ? 'admin.role.add.success' : 'admin.role.remove.success',
        locale
      ),
      description: t(
        adding ? 'admin.role.add.successDesc' : 'admin.role.remove.successDesc',
        locale,
        {
          userId: member.id,
          displayName: escapeMarkdown(member.displayName),
          roleId: role.id,
        }
      ),
      color: COLORS.SUCCESS,
      timestamp: true,
    })
  );
}
