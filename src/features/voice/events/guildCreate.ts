import { Events, type Guild } from 'discord.js';
import type { Event } from '../../../shared/types/index.js';
import type { ExtendedClient } from '../../../client.js';
import { welcomeNewGuild } from '../application/onboarding.js';
import { reconcileGuild } from '../application/reconcile.js';
import { getErrorMessage, logger } from '../../../shared/utils/logger.js';
import { isGuildAllowed } from '../../../shared/utils/guildAllowlist.js';

/**
 * A server added the bot. discord.js emits this only for servers joined
 * after startup (a server coming back from an outage is `GuildAvailable`),
 * so the welcome is not repeated on restarts.
 *
 * The welcome goes first, so the server-level explanation arrives before
 * any per-channel notice; then the bot joins a channel people are already
 * talking in, which no voice event would otherwise make it do.
 */
export const event: Event<typeof Events.GuildCreate> = {
  name: Events.GuildCreate,
  once: false,
  async execute(client: ExtendedClient, guild: Guild) {
    if (!client.isFullyReady) return;
    // Outside ALLOWED_GUILD_IDS the core guildCreate listener leaves; no
    // welcome and no voice join for a server this deployment does not serve.
    if (!isGuildAllowed(guild.id)) return;

    logger.info(`Added to guild ${guild.name} (${guild.id})`);
    await welcomeNewGuild(guild);

    try {
      await reconcileGuild(guild);
    } catch (error) {
      logger.error(
        `Voice reconcile failed for new guild ${guild.id}:`,
        getErrorMessage(error)
      );
    }
  },
};
