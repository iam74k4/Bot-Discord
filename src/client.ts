import { Client, GatewayIntentBits, Collection, Options } from 'discord.js';
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
      // With guild messages flowing in, discord.js would keep the last 200 of
      // every channel in memory - content included, in servers that never use
      // /tts - and the voice memory monitor would shed recordings to pay for
      // it. Text-to-speech reads each message from its event and nothing
      // reads the cache (poll lookups fetch by id), so keep none.
      ...(options.messageContent && {
        makeCache: Options.cacheWithLimits({
          ...Options.DefaultMakeCacheSettings,
          MessageManager: 0,
        }),
      }),
    });
  }
}

/**
 * Create and configure the Discord client
 */
export function createClient(options: ClientOptions = {}): ExtendedClient {
  return new ExtendedClient(options);
}
