import { Events, GuildMember, escapeMarkdown } from 'discord.js';
import { Event } from '../../../shared/types/index.js';
import { ExtendedClient } from '../../../client.js';
import { createEmbed } from '../../../shared/utils/embed.js';
import { COLORS } from '../../../shared/utils/constants/index.js';
import { getErrorMessage, logger } from '../../../shared/utils/logger.js';
import { isGuildAllowed } from '../../../shared/utils/guildAllowlist.js';
import { t, type Locale } from '../../../locales/index.js';
import { formatNumber } from '../../../locales/format.js';
import { resolveBackgroundLocale } from '../../../locales/guildLocale.js';
import { notificationChannelRepository } from '../repositories/notificationChannelRepository.js';
import { getSendableTextChannel } from '../../../shared/utils/discord.js';

/**
 * The welcome text: who joined (escaped, so a name like `*star*` stays a
 * name), their member number, and the rules channel when the server has one.
 */
function welcomeDescription(member: GuildMember, locale: Locale): string {
  const lines = [
    t('notification.events.memberJoin', locale, {
      name: escapeMarkdown(member.displayName),
      count: formatNumber(member.guild.memberCount, locale),
    }),
  ];

  // Only Community servers have a rules channel.
  if (member.guild.rulesChannelId) {
    lines.push(
      t('notification.events.memberJoinRules', locale, {
        channel: member.guild.rulesChannelId,
      })
    );
  }

  return lines.join('\n');
}

export const event: Event<typeof Events.GuildMemberAdd> = {
  name: Events.GuildMemberAdd,
  once: false,
  async execute(client: ExtendedClient, member: GuildMember) {
    if (!client.isFullyReady) return;
    if (member.user.bot) return;
    if (!isGuildAllowed(member.guild.id)) return;

    const guildId = member.guild.id;
    const notifyChannelId = notificationChannelRepository.getEnabled(
      guildId,
      'member_join'
    );
    if (!notifyChannelId) return;

    try {
      const textChannel = await getSendableTextChannel(
        member.guild,
        notifyChannelId
      );
      if (!textChannel) return;

      const locale = resolveBackgroundLocale(member.guild);
      const embed = createEmbed({
        title: t('notification.events.memberJoinTitle', locale),
        description: welcomeDescription(member, locale),
        color: COLORS.SUCCESS,
        thumbnail: member.user.displayAvatarURL({ size: 128 }),
        timestamp: true,
      });

      // The mention makes the name tappable and pings the newcomer - only
      // them, whatever the display name contains.
      await textChannel.send({
        content: `<@${member.id}>`,
        allowedMentions: { users: [member.id] },
        embeds: [embed],
      });
    } catch (error) {
      logger.warn(
        `Failed to send member join notification: ${getErrorMessage(error)}`
      );
    }
  },
};
