import { once } from 'node:events';
import { Events, GatewayIntentBits, RESTEvents } from 'discord.js';
import { createClient, type ExtendedClient } from '../client.js';
import type { AppConfig } from '../config/index.js';
import { loadCommands } from '../handlers/commandHandler.js';
import { loadEvents } from '../handlers/eventHandler.js';
import { getErrorMessage, logger } from '../shared/utils/logger.js';
import {
  loadFeatures,
  startAllFeatures,
  stopAllFeatures,
} from '../features/index.js';
import {
  closeDatabase,
  initializeDatabase,
} from '../infrastructure/database/index.js';
import { backupService } from '../infrastructure/backup/index.js';
import {
  startAuditRetention,
  stopAuditRetention,
} from '../infrastructure/audit/index.js';
import { cooldownStore } from '../middleware/cooldown/cooldownStore.js';
import { metrics } from '../infrastructure/metrics/index.js';
import {
  setComponentRoutingReady,
  stopLiveComponents,
} from '../shared/interactions/index.js';

/** The longest shutdown waits for open panels to show they have closed. */
const LIVE_COMPONENT_SHUTDOWN_MS = 3_000;

/**
 * How long shutdown may spend closing open panels and prompts: at most 3 s
 * and at most a fifth of the whole shutdown budget, so the final backup and
 * stopping the features (closing VC sessions, flushing recordings) are never
 * cut off by the forced exit.
 */
export function liveComponentShutdownBudget(shutdownTimeoutMs: number): number {
  if (!Number.isFinite(shutdownTimeoutMs) || shutdownTimeoutMs <= 0) {
    return LIVE_COMPONENT_SHUTDOWN_MS;
  }
  return Math.min(
    LIVE_COMPONENT_SHUTDOWN_MS,
    Math.floor(shutdownTimeoutMs / 5)
  );
}

/**
 * The composition root.
 *
 * Everything the process owns is assembled here, in one place, in a stated
 * order - and torn down in the reverse. Startup used to be a script in
 * `src/index.ts` that reached for module singletons as it went, which made the
 * order implicit and the whole bootstrap untestable. `createApp` takes its
 * collaborators as an argument so a test can drive the real sequence with
 * fakes instead of mocking module paths.
 *
 * What is deliberately *not* injected: `config` and the database connection.
 * Both are process-wide resources with their own explicit lifecycle
 * (`loadConfig`, `closeDatabase`), and every consumer of them is reached
 * through a Discord interaction handler whose signature the library fixes -
 * so threading them down would mean a context holder, which is the same global
 * with extra steps. See `docs/architecture.md`.
 */
export interface AppDependencies {
  createClient(config: AppConfig): ExtendedClient;
  initializeDatabase(): Promise<void>;
  closeDatabase(): void;
  loadFeatures(): Promise<void>;
  loadCommands(client: ExtendedClient): Promise<void>;
  loadEvents(client: ExtendedClient): Promise<void>;
  startAllFeatures(context: {
    client: ExtendedClient;
    config: AppConfig;
  }): Promise<void>;
  stopAllFeatures(): Promise<void>;
  login(client: ExtendedClient, token: string): Promise<void>;
  awaitReady(client: ExtendedClient): Promise<void>;
  backup: {
    start(): void;
    stop(): void;
    runBackup(): Promise<{ success: boolean; error?: string }>;
  };
  startAuditRetention(): void;
  stopAuditRetention(): void;
  clearCooldowns(): void;
  /**
   * Event-loop monitoring and time-to-acknowledge measurement. Started
   * before login so the first interaction is already measured.
   */
  startRuntimeMetrics(client: ExtendedClient): void;
  stopRuntimeMetrics(client: ExtendedClient): void;
  /**
   * Close every open panel and confirmation, so none stays clickable on a
   * message no process will answer after the restart. Waits at most
   * `timeoutMs` for them to show they have closed.
   */
  stopLiveComponents(timeoutMs: number): Promise<void>;
  /**
   * Whether every feature has registered its persistent component handlers.
   * Until it is set (and again from the start of shutdown), the interaction
   * router never greys out a click it cannot place; it only asks the user to
   * try again, because the button may belong to a handler that is not
   * registered yet or any more.
   */
  setComponentRoutingReady(ready: boolean): void;
}

export interface App {
  readonly client: ExtendedClient;
  start(): Promise<void>;
  stop(): Promise<void>;
}

/** A named teardown step. Named so a failure says what did not stop. */
interface ShutdownStep {
  name: string;
  run(): void | Promise<void>;
}

/**
 * Discord closes the gateway with 4014 ("Used disallowed intents") when the
 * bot asks for a privileged intent the Developer Portal has not enabled. The
 * error names neither the intent nor the setting, and Message Content is
 * only asked for because VOICEVOX_URL is set - so spell that out.
 */
export function disallowedIntentsHint(
  error: unknown,
  client: ExtendedClient
): string | null {
  if (!(error instanceof Error) || !/disallowed intents/i.test(error.message)) {
    return null;
  }
  const readsChat = client.options.intents.has(
    GatewayIntentBits.MessageContent
  );
  return readsChat
    ? 'Discord refused a privileged intent. In the Developer Portal, open Bot > Privileged Gateway Intents and enable SERVER MEMBERS INTENT and MESSAGE CONTENT INTENT. Message Content is requested because VOICEVOX_URL is set (text-to-speech); unset VOICEVOX_URL to run without /tts.'
    : 'Discord refused a privileged intent. In the Developer Portal, open Bot > Privileged Gateway Intents and enable SERVER MEMBERS INTENT.';
}

export function defaultDependencies(): AppDependencies {
  const acknowledgementListener = metrics.createAcknowledgementListener();

  return {
    // Text-to-speech is the only reader of chat, so the privileged intent is
    // requested only when an engine is configured.
    createClient: (config) =>
      createClient({ messageContent: Boolean(config.VOICEVOX_URL) }),
    initializeDatabase,
    closeDatabase,
    loadFeatures,
    loadCommands,
    loadEvents,
    startAllFeatures,
    stopAllFeatures,
    login: async (client, token) => {
      try {
        await client.login(token);
      } catch (error) {
        const hint = disallowedIntentsHint(error, client);
        if (hint) logger.error(hint);
        throw error;
      }
    },
    awaitReady: async (client) => {
      if (!client.isReady()) {
        await once(client, Events.ClientReady);
      }
    },
    backup: backupService,
    startAuditRetention,
    stopAuditRetention,
    clearCooldowns: () => cooldownStore.clearAll(),
    startRuntimeMetrics: (client) => {
      metrics.startEventLoopMonitor();
      client.rest.on(RESTEvents.Response, acknowledgementListener);
    },
    stopRuntimeMetrics: (client) => {
      client.rest.off(RESTEvents.Response, acknowledgementListener);
      metrics.stopEventLoopMonitor();
    },
    stopLiveComponents: (timeoutMs) => stopLiveComponents({ timeoutMs }),
    setComponentRoutingReady,
  };
}

export function createApp(
  config: AppConfig,
  deps: AppDependencies = defaultDependencies()
): App {
  const client = deps.createClient(config);

  async function start(): Promise<void> {
    await deps.initializeDatabase();

    await deps.loadFeatures();
    await deps.loadCommands(client);
    await deps.loadEvents(client);

    deps.startRuntimeMetrics(client);
    await deps.login(client, config.DISCORD_TOKEN);
    await deps.awaitReady(client);

    // Features start only once the gateway is ready, so their `start` may rely
    // on warmed guild caches.
    await deps.startAllFeatures({ client, config });
    // Every persistent button now has its handler; clicks nothing claims can
    // be treated as expired from here on.
    deps.setComponentRoutingReady(true);

    deps.backup.start();
    deps.startAuditRetention();
  }

  function shutdownSteps(): ShutdownStep[] {
    // Features unregister their persistent buttons below while clicks still
    // arrive, so the router stops treating unclaimed clicks as expired first.
    // Then open panels close, while the gateway and REST still work, so users
    // see them close instead of failing after the restart.
    const steps: ShutdownStep[] = [
      {
        name: 'Component routing',
        run: () => deps.setComponentRoutingReady(false),
      },
      {
        name: 'Live components',
        run: () =>
          deps.stopLiveComponents(
            liveComponentShutdownBudget(config.SHUTDOWN_TIMEOUT_MS)
          ),
      },
      // The schedule stops first so no cron backup starts during shutdown.
      { name: 'Backup service', run: () => deps.backup.stop() },
      { name: 'Audit retention', run: () => deps.stopAuditRetention() },
      { name: 'Features', run: () => deps.stopAllFeatures() },
    ];

    // The final backup runs after features stop, so what they write on the
    // way out (the VC sessions closed by the notification feature) is in it,
    // and before the database closes. The client is destroyed last so
    // nothing tries to talk to a dead gateway.
    if (config.SHUTDOWN_FINAL_BACKUP) {
      steps.push({
        name: 'Final backup',
        run: async () => {
          const result = await deps.backup.runBackup();
          if (!result.success) {
            logger.warn(`Final backup failed: ${result.error ?? 'Unknown'}`);
          }
        },
      });
    }

    steps.push(
      { name: 'Cooldown store', run: () => deps.clearCooldowns() },
      { name: 'Runtime metrics', run: () => deps.stopRuntimeMetrics(client) },
      { name: 'Database', run: () => deps.closeDatabase() },
      { name: 'Discord client', run: () => client.destroy() }
    );

    return steps;
  }

  async function stop(): Promise<void> {
    // Every step runs even if an earlier one throws: a failure to stop one
    // thing must not leave the database open or the process hanging.
    for (const step of shutdownSteps()) {
      try {
        logger.debug(`Stopping ${step.name}...`);
        await step.run();
      } catch (error) {
        logger.error(`Failed to stop ${step.name}:`, getErrorMessage(error));
      }
    }
  }

  return { client, start, stop };
}
