import {
  Client,
  GatewayIntentBits,
  Collection,
  Options,
  type ClientOptions as DiscordClientOptions,
} from 'discord.js';
import { Agent } from 'undici';
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
 * How long an idle connection to Discord's API stays open. undici's default
 * is 4 s, so the first request after a short lull - often the reply to a
 * command - paid for a fresh TCP and TLS handshake. 30 s stays well under
 * the edge's own idle timeout.
 */
export const REST_KEEP_ALIVE_MS = 30_000;
const REST_KEEP_ALIVE_MAX_MS = 60_000;

/**
 * Cache settings. With the guild-message intents on (text-to-speech), every
 * chat message would otherwise be kept, 200 per channel - about 2 KB each -
 * although nothing reads them back: TTS works from the gateway payload, and
 * nothing in `src` reads a message cache. Member, user, role, channel and
 * voice-state caches keep their defaults; TTS resolves mentions from them.
 */
function cacheOptions(
  messageContent: boolean
): Pick<DiscordClientOptions, 'makeCache'> {
  if (!messageContent) return {};
  return {
    makeCache: Options.cacheWithLimits({
      ...Options.DefaultMakeCacheSettings,
      MessageManager: 0,
    }),
  };
}

/**
 * Extended Discord client with custom properties
 */
export class ExtendedClient extends Client {
  /** Collection of loaded commands */
  public commands: Collection<string, Command> = new Collection();
  /** Whether the bot has fully initialised (ready event + commands registered) */
  public isFullyReady = false;
  /** Connection pool for REST calls; closed with the client. */
  public readonly restAgent: Agent;

  constructor(options: ClientOptions = {}) {
    const restAgent = new Agent({
      keepAliveTimeout: REST_KEEP_ALIVE_MS,
      keepAliveMaxTimeout: REST_KEEP_ALIVE_MAX_MS,
    });

    super({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildVoiceStates,
        ...(options.messageContent
          ? [GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
          : []),
      ],
      ...cacheOptions(Boolean(options.messageContent)),
      rest: { agent: restAgent },
    });

    this.restAgent = restAgent;
  }

  /** Destroy the gateway connection, then release the REST connection pool. */
  override async destroy(): Promise<void> {
    try {
      await super.destroy();
    } finally {
      await this.restAgent.close().catch(() => undefined);
    }
  }
}

/**
 * Create and configure the Discord client
 */
export function createClient(options: ClientOptions = {}): ExtendedClient {
  return new ExtendedClient(options);
}
