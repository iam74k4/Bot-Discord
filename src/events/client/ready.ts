import { Events } from 'discord.js';
import type { ExtendedClient } from '../../client.js';
import { Event } from '../../shared/types/index.js';
import { getErrorMessage, logger } from '../../shared/utils/logger.js';
import { registerCommands } from '../../handlers/commandHandler.js';
import { isGuildAllowed } from '../../shared/utils/guildAllowlist.js';

/**
 * Servers the bot is already in but ALLOWED_GUILD_IDS excludes are reported,
 * not left. Leaving cannot be undone without each server's admin inviting the
 * bot again, so a wrong value - a staging list copied into production by
 * "Duplicate Environment" - must cost a config fix, not every server. The
 * interaction router refuses commands there in the meantime.
 */
function reportDisallowedGuilds(client: ExtendedClient): void {
  const outside = client.guilds.cache.filter(
    (guild) => !isGuildAllowed(guild.id)
  );
  if (outside.size === 0) return;

  const names = outside.map((guild) => `${guild.name} (${guild.id})`);
  logger.warn(
    `In ${outside.size} server(s) outside ALLOWED_GUILD_IDS; commands are refused there. ` +
      `Remove the bot from them or add their IDs: ${names.join(', ')}`
  );
}

/**
 * Ready event - fired when the bot is ready
 */
export const event: Event<typeof Events.ClientReady> = {
  name: Events.ClientReady,
  once: true,
  async execute(client) {
    if (!client.user) return;

    logger.info(`Logged in as ${client.user.tag}`);
    logger.info(`Serving ${client.guilds.cache.size} guilds`);
    reportDisallowedGuilds(client);

    // Set bot presence (no activity status)
    client.user.setPresence({
      activities: [],
      status: 'online',
    });

    client.isFullyReady = true;

    try {
      await registerCommands(client);
    } catch (error) {
      logger.error(
        'Slash command registration failed; continuing with loaded command handlers:',
        getErrorMessage(error)
      );
    }

    logger.info('Bot is ready!');
  },
};
