import { Events } from 'discord.js';
import { Event } from '../../shared/types/index.js';
import { getErrorMessage, logger } from '../../shared/utils/logger.js';
import { isGuildAllowed } from '../../shared/utils/guildAllowlist.js';

/**
 * GuildCreate - the bot was just added to a server.
 *
 * discord.js emits this only for servers joined while running, never for the
 * servers it reconnects to at startup (those arrive as GuildAvailable), so
 * leaving here costs nothing: the server that invited the bot is the only one
 * affected, and it was never meant to have this deployment. Servers that were
 * already joined are reported by the ready event instead of left - see there.
 */
export const event: Event<typeof Events.GuildCreate> = {
  name: Events.GuildCreate,
  once: false,
  async execute(_client, guild) {
    if (isGuildAllowed(guild.id)) return;

    logger.warn(
      `Joined ${guild.name} (${guild.id}), which is not in ALLOWED_GUILD_IDS; leaving.`
    );
    try {
      await guild.leave();
    } catch (error) {
      logger.error(
        `Failed to leave ${guild.name} (${guild.id}); remove the bot from that server by hand:`,
        getErrorMessage(error)
      );
    }
  },
};
