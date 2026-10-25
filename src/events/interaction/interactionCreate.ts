import { Events } from 'discord.js';
import { Event } from '../../shared/types/index.js';
import { ExtendedClient } from '../../client.js';
import { routeInteraction } from '../../app/interactions/interactionRouter.js';

/**
 * InteractionCreate event: hands every interaction to the router - slash
 * commands, autocomplete, buttons and select menus (live collectors,
 * persistent handlers, expired ones), and submitted forms nobody is waiting
 * for.
 */
export const event: Event<typeof Events.InteractionCreate> = {
  name: Events.InteractionCreate,
  once: false,
  async execute(client, interaction) {
    if (!(client as ExtendedClient).isFullyReady) return;
    await routeInteraction(client as ExtendedClient, interaction);
  },
};
