import { Client, GatewayIntentBits, Collection } from 'discord.js';
import { Command } from './shared/types/index.js';

export interface ClientOptions {
  /**
   * Request the privileged Message Content intent (and guild messages) so
   * text-to-speech can read chat. Off unless TTS is configured: asking for a
   * privileged intent the Developer Portal has not enabled makes the gateway
   * refuse the login outright (close code 4014).
   */
  messageContent?: boolean;
}

/**
 * Extended Discord client with custom properties
 */
export class ExtendedClient extends Client {
  /** Collection of loaded commands */
  public commands: Collection<string, Command> = new Collection();
  /** Whether the bot has fully initialised (ready event + commands registered) */
  public isFullyReady = false;

  constructor(options: ClientOptions = {}) {
    super({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildVoiceStates,
        ...(options.messageContent
          ? [GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
          : []),
      ],
    });
  }
}

/**
 * Create and configure the Discord client
 */
export function createClient(options: ClientOptions = {}): ExtendedClient {
  return new ExtendedClient(options);
}
