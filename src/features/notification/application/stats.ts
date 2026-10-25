import { ChatInputCommandInteraction } from 'discord.js';
import { resolveLocale } from '../../../locales/guildLocale.js';
import { showNotificationPanel } from './panel.js';
import { isStatsPeriod } from '../stats/periods.js';

export async function handleStats(
  interaction: ChatInputCommandInteraction
): Promise<void> {
  const locale = resolveLocale(interaction);
  const period = interaction.options.getString('period');
  await showNotificationPanel(interaction, locale, {
    initialView: 'stats',
    initialPeriod: isStatsPeriod(period) ? period : 'all',
  });
}
