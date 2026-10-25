import {
  type MessageComponentInteraction,
  MessageFlags,
  PermissionFlagsBits,
} from 'discord.js';
import { t } from '../../../locales/index.js';
import {
  resolveBackgroundLocale,
  resolveLocale,
} from '../../../locales/guildLocale.js';
import { logger } from '../../../shared/utils/logger.js';
import { buildOptedOutNoticeEmbed, OPT_OUT_PREFIX } from './announce.js';
import { excludeChannel } from './policy.js';
import { auditVoiceSettingChange } from './settingsAudit.js';

/**
 * The "exclude this channel" button on the buffering notice.
 *
 * Registered as a persistent component route, so notices posted before a
 * restart keep working; it is stateless (the channel id is in the customId)
 * and checks the clicker's permission on every click, because the notice is
 * public and anyone in the channel can press it. Clicking twice is harmless:
 * excluding is idempotent.
 */
export async function handleOptOutClick(
  interaction: MessageComponentInteraction
): Promise<void> {
  const locale = resolveLocale(interaction);
  const channelId = interaction.customId.slice(OPT_OUT_PREFIX.length);
  const guild = interaction.guild;

  if (!guild || !channelId) {
    await interaction.reply({
      content: t('common.guildOnly', locale),
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    await interaction.reply({
      content: t('record.notice.optOutNotAllowed', locale),
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const { left } = await excludeChannel(guild, channelId);

  // The notice is public, so it is rewritten in the server's language.
  await interaction.update({
    embeds: [
      buildOptedOutNoticeEmbed(resolveBackgroundLocale(guild), {
        channelId,
        userId: interaction.user.id,
        left,
      }),
    ],
    components: [],
  });

  logger.info(
    `Voice channel ${channelId} excluded from auto-join by ${interaction.user.id} via the notice button`
  );
  auditVoiceSettingChange(
    interaction.client,
    guild,
    interaction.user.id,
    { kind: 'channelExcluded', channelId },
    'noticeButton'
  );
}
