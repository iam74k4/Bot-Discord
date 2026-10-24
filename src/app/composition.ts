import { once } from 'node:events';
import { Events } from 'discord.js';
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

export function defaultDependencies(): AppDependencies {
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
      await client.login(token);
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

    await deps.login(client, config.DISCORD_TOKEN);
    await deps.awaitReady(client);

    // Features start only once the gateway is ready, so their `start` may rely
    // on warmed guild caches.
    await deps.startAllFeatures({ client, config });

    deps.backup.start();
    deps.startAuditRetention();
  }

  function shutdownSteps(): ShutdownStep[] {
    const steps: ShutdownStep[] = [];

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

    // The final backup runs first because it needs the database still open;
    // the client is destroyed last so nothing tries to talk to a dead gateway.
    steps.push(
      { name: 'Backup service', run: () => deps.backup.stop() },
      { name: 'Audit retention', run: () => deps.stopAuditRetention() },
      { name: 'Features', run: () => deps.stopAllFeatures() },
      { name: 'Cooldown store', run: () => deps.clearCooldowns() },
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
