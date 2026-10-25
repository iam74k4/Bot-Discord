import { ChatInputCommandInteraction } from 'discord.js';
import { executeHelpCommand } from './help.js';
import { executePingCommand } from './ping.js';
import { executeAboutCommand } from './about.js';

export async function executeGeneralCommand(
  interaction: ChatInputCommandInteraction
): Promise<void> {
  const subcommand = interaction.options.getSubcommand();

  switch (subcommand) {
    case 'help':
      await executeHelpCommand(interaction);
      break;
    case 'ping':
      await executePingCommand(interaction);
      break;
    case 'about':
      await executeAboutCommand(interaction);
      break;
  }
}
