import { ChatInputCommandInteraction } from 'discord.js';
import { createEmbed } from '../../../shared/utils/embed.js';
import { COLORS } from '../../../shared/utils/constants/index.js';
import { t } from '../../../locales/index.js';
import { resolveLocale } from '../../../locales/guildLocale.js';

export async function executePingCommand(
  interaction: ChatInputCommandInteraction
): Promise<void> {
  const locale = resolveLocale(interaction);
  const response = await interaction.deferReply({ withResponse: true });

  // Fall back to "now" if Discord returned no message: a slightly optimistic
  // figure beats failing the command over a diagnostic.
  const acknowledgedAt =
    response.resource?.message?.createdTimestamp ?? Date.now();
  const roundtripLatency = acknowledgedAt - interaction.createdTimestamp;
  // discord.js reports -1 until the first heartbeat is acknowledged, which
  // is not a measurement.
  const wsLatency = interaction.client.ws.ping;
  const apiLatency =
    wsLatency >= 0 ? `${wsLatency}ms` : t('ping.notMeasured', locale);

  const embed = createEmbed({
    title: t('ping.title', locale),
    color: COLORS.PRIMARY,
    fields: [
      {
        name: t('ping.latency', locale),
        value: `${roundtripLatency}ms`,
        inline: true,
      },
      {
        name: t('ping.apiLatency', locale),
        value: apiLatency,
        inline: true,
      },
    ],
    timestamp: true,
  });

  await interaction.editReply({ embeds: [embed] });
}
