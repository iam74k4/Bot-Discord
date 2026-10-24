import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Events, GatewayIntentBits } from 'discord.js';
import type { AppConfig } from '../../config/index.js';
import type { ExtendedClient } from '../../client.js';
import {
  createApp,
  defaultDependencies,
  type AppDependencies,
} from '../composition.js';
import { loadCommands } from '../../handlers/commandHandler.js';
import { loadEvents } from '../../handlers/eventHandler.js';
import {
  loadFeatures,
  startAllFeatures,
  stopAllFeatures,
} from '../../features/index.js';
import {
  closeDatabase,
  initializeDatabase,
} from '../../infrastructure/database/index.js';
import { backupService } from '../../infrastructure/backup/index.js';
import {
  startAuditRetention,
  stopAuditRetention,
} from '../../infrastructure/audit/index.js';
import { cooldownStore } from '../../middleware/cooldown/cooldownStore.js';

const logger = vi.hoisted(() => ({
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
}));
vi.mock('../../shared/utils/logger.js', () => ({
  logger,
  getErrorMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

/**
 * The bootstrap is only correct if things happen in the right order: the
 * database before anything queries it, features after the gateway is ready,
 * the final backup before the connection closes. That order used to live in a
 * script nothing could execute; here it is driven end to end with fakes.
 */
function harness(overrides: Partial<AppDependencies> = {}) {
  const order: string[] = [];
  const record =
    <T>(name: string, result?: T) =>
    () => {
      order.push(name);
      return result as T;
    };

  const client = {
    destroy: vi.fn(() => order.push('client.destroy')),
    on: vi.fn(),
  };

  const deps: AppDependencies = {
    createClient: () => client as never,
    initializeDatabase: async () => void order.push('initializeDatabase'),
    closeDatabase: record('closeDatabase'),
    loadFeatures: async () => void order.push('loadFeatures'),
    loadCommands: async () => void order.push('loadCommands'),
    loadEvents: async () => void order.push('loadEvents'),
    startAllFeatures: async () => void order.push('startAllFeatures'),
    stopAllFeatures: async () => void order.push('stopAllFeatures'),
    login: async () => void order.push('login'),
    awaitReady: async () => void order.push('awaitReady'),
    backup: {
      start: record('backup.start'),
      stop: record('backup.stop'),
      runBackup: async () => {
        order.push('backup.runBackup');
        return { success: true };
      },
    },
    startAuditRetention: record('startAuditRetention'),
    stopAuditRetention: record('stopAuditRetention'),
    clearCooldowns: record('clearCooldowns'),
    ...overrides,
  };

  return { order, client, deps };
}

function config(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    DISCORD_TOKEN: 'token',
    SHUTDOWN_FINAL_BACKUP: true,
    ...overrides,
  } as AppConfig;
}

describe('composition root', () => {
  it('assembles the bot in dependency order', async () => {
    const { order, deps } = harness();

    await createApp(config(), deps).start();

    expect(order).toEqual([
      'initializeDatabase',
      'loadFeatures',
      'loadCommands',
      'loadEvents',
      'login',
      'awaitReady',
      'startAllFeatures',
      'backup.start',
      'startAuditRetention',
    ]);
  });

  it('hands features the client and the configuration it was built with', async () => {
    const startAllFeatures = vi.fn().mockResolvedValue(undefined);
    const { client, deps } = harness({ startAllFeatures });
    const appConfig = config();

    await createApp(appConfig, deps).start();

    expect(startAllFeatures).toHaveBeenCalledWith({
      client,
      config: appConfig,
    });
  });

  it('takes the final backup before closing the database', async () => {
    const { order, deps } = harness();

    await createApp(config(), deps).stop();

    expect(order).toEqual([
      'backup.runBackup',
      'backup.stop',
      'stopAuditRetention',
      'stopAllFeatures',
      'clearCooldowns',
      'closeDatabase',
      'client.destroy',
    ]);
  });

  it('skips the final backup when it is turned off', async () => {
    const { order, deps } = harness();

    await createApp(config({ SHUTDOWN_FINAL_BACKUP: false }), deps).stop();

    expect(order).not.toContain('backup.runBackup');
    expect(order[0]).toBe('backup.stop');
  });

  it('still closes the database when an earlier step throws', async () => {
    const { order, deps } = harness({
      stopAllFeatures: vi.fn().mockRejectedValue(new Error('feature hung')),
    });

    await expect(createApp(config(), deps).stop()).resolves.toBeUndefined();

    expect(order).toContain('closeDatabase');
    expect(order).toContain('client.destroy');
  });

  it('logs in with the token it was configured with', async () => {
    const login = vi.fn().mockResolvedValue(undefined);
    const { client, deps } = harness({ login });

    await createApp(config({ DISCORD_TOKEN: 'secret-token' }), deps).start();

    expect(login).toHaveBeenCalledWith(client, 'secret-token');
  });

  it('builds the client once, when the app is created', () => {
    const createClientSpy = vi.fn(() => ({ destroy: vi.fn() }) as never);
    const { deps } = harness({ createClient: createClientSpy });

    const app = createApp(config(), deps);

    expect(createClientSpy).toHaveBeenCalledTimes(1);
    expect(app.client).toBe(createClientSpy.mock.results[0].value);
  });

  it.each<[keyof AppDependencies, string[]]>([
    ['initializeDatabase', []],
    ['loadCommands', ['initializeDatabase', 'loadFeatures']],
    [
      'login',
      ['initializeDatabase', 'loadFeatures', 'loadCommands', 'loadEvents'],
    ],
    [
      'awaitReady',
      [
        'initializeDatabase',
        'loadFeatures',
        'loadCommands',
        'loadEvents',
        'login',
      ],
    ],
  ])(
    'aborts startup when %s fails, running nothing after it',
    async (failing, before) => {
      const failure = new Error(`${failing} failed`);
      const { order, deps } = harness({
        [failing]: vi.fn().mockRejectedValue(failure),
      });

      await expect(createApp(config(), deps).start()).rejects.toBe(failure);

      expect(order).toEqual(before);
    }
  );

  describe('final backup', () => {
    it('warns with the reason when the final backup fails, then keeps shutting down', async () => {
      const { order, deps } = harness();
      deps.backup.runBackup = async () => ({
        success: false,
        error: 'disk full',
      });

      await createApp(config(), deps).stop();

      expect(logger.warn).toHaveBeenCalledWith(
        'Final backup failed: disk full'
      );
      expect(order).toEqual([
        'backup.stop',
        'stopAuditRetention',
        'stopAllFeatures',
        'clearCooldowns',
        'closeDatabase',
        'client.destroy',
      ]);
    });

    it('reports an unknown reason when the failed backup gives none', async () => {
      const { deps } = harness();
      deps.backup.runBackup = async () => ({ success: false });

      await createApp(config(), deps).stop();

      expect(logger.warn).toHaveBeenCalledWith('Final backup failed: Unknown');
    });

    it('does not warn when the final backup succeeds', async () => {
      const { deps } = harness();

      await createApp(config(), deps).stop();

      expect(logger.warn).not.toHaveBeenCalled();
      expect(logger.error).not.toHaveBeenCalled();
    });

    it('logs a crashing final backup by name and still closes the database', async () => {
      const { order, deps } = harness();
      deps.backup.runBackup = vi.fn().mockRejectedValue(new Error('EACCES'));

      await createApp(config(), deps).stop();

      expect(logger.error).toHaveBeenCalledWith(
        'Failed to stop Final backup:',
        'EACCES'
      );
      expect(order).toContain('closeDatabase');
    });
  });

  it('names every step that fails to stop and runs the rest', async () => {
    const { order, client, deps } = harness({
      closeDatabase: vi.fn(() => {
        throw new Error('database is locked');
      }),
    });
    client.destroy.mockImplementation(() => {
      throw new Error('already destroyed');
    });

    await expect(createApp(config(), deps).stop()).resolves.toBeUndefined();

    expect(logger.error).toHaveBeenCalledWith(
      'Failed to stop Database:',
      'database is locked'
    );
    expect(logger.error).toHaveBeenCalledWith(
      'Failed to stop Discord client:',
      'already destroyed'
    );
    expect(order).toEqual([
      'backup.runBackup',
      'backup.stop',
      'stopAuditRetention',
      'stopAllFeatures',
      'clearCooldowns',
    ]);
  });
});

describe('defaultDependencies', () => {
  /** A client stand-in that can emit gateway events. */
  function emitterClient(ready: boolean) {
    const emitter = new EventEmitter();
    return Object.assign(emitter, {
      isReady: vi.fn(() => ready),
      login: vi.fn().mockResolvedValue('token-echo'),
    }) as unknown as ExtendedClient & EventEmitter;
  }

  it('wires the production collaborators', () => {
    const deps = defaultDependencies();

    expect(deps.initializeDatabase).toBe(initializeDatabase);
    expect(deps.closeDatabase).toBe(closeDatabase);
    expect(deps.loadFeatures).toBe(loadFeatures);
    expect(deps.loadCommands).toBe(loadCommands);
    expect(deps.loadEvents).toBe(loadEvents);
    expect(deps.startAllFeatures).toBe(startAllFeatures);
    expect(deps.stopAllFeatures).toBe(stopAllFeatures);
    expect(deps.backup).toBe(backupService);
    expect(deps.startAuditRetention).toBe(startAuditRetention);
    expect(deps.stopAuditRetention).toBe(stopAuditRetention);
  });

  it.each([
    ['', false],
    ['http://voicevox.railway.internal:50021', true],
  ])(
    'asks for the Message Content intent only when VOICEVOX_URL is set (%j)',
    (voicevoxUrl, expected) => {
      const client = defaultDependencies().createClient({
        VOICEVOX_URL: voicevoxUrl,
      } as AppConfig);

      expect(client.options.intents.has(GatewayIntentBits.MessageContent)).toBe(
        expected
      );
      expect(client.options.intents.has(GatewayIntentBits.GuildMessages)).toBe(
        expected
      );
      // The intents every feature relies on are always there.
      expect(
        client.options.intents.has([
          GatewayIntentBits.Guilds,
          GatewayIntentBits.GuildMembers,
          GatewayIntentBits.GuildVoiceStates,
        ])
      ).toBe(true);
    }
  );

  it('logs the client in with the token', async () => {
    const client = emitterClient(false);

    await expect(
      defaultDependencies().login(client, 'secret-token')
    ).resolves.toBeUndefined();

    expect(client.login).toHaveBeenCalledWith('secret-token');
  });

  it('propagates a failed login', async () => {
    const client = emitterClient(false);
    vi.mocked(client.login).mockRejectedValue(new Error('TokenInvalid'));

    await expect(defaultDependencies().login(client, 'bad')).rejects.toThrow(
      'TokenInvalid'
    );
  });

  it('does not wait when the client is already ready', async () => {
    const client = emitterClient(true);

    await expect(
      defaultDependencies().awaitReady(client)
    ).resolves.toBeUndefined();
    expect(client.listenerCount(Events.ClientReady)).toBe(0);
  });

  it('waits for the ready event when the client is not ready yet', async () => {
    const client = emitterClient(false);
    let ready = false;

    const waiting = defaultDependencies()
      .awaitReady(client)
      .then(() => {
        ready = true;
      });
    await Promise.resolve();
    expect(ready).toBe(false);
    expect(client.listenerCount(Events.ClientReady)).toBe(1);

    client.emit(Events.ClientReady, client);
    await waiting;

    expect(ready).toBe(true);
  });

  it('clears the shared cooldown store', () => {
    cooldownStore.setCooldown('ping', 'user-1', 60_000);
    expect(cooldownStore.isOnCooldown('ping', 'user-1')).toBe(true);

    defaultDependencies().clearCooldowns();

    expect(cooldownStore.isOnCooldown('ping', 'user-1')).toBe(false);
  });
});
