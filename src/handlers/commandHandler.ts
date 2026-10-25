import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import {
  Routes,
  type RESTGetAPIApplicationCommandsResult,
  type RESTPutAPIApplicationCommandsResult,
} from 'discord.js';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { env } from '../config/index.js';
import { getErrorMessage, logger } from '../shared/utils/logger.js';
import { setCommandIds } from '../shared/utils/commandMentions.js';
import { ExtendedClient } from '../client.js';
import {
  buildCommandCollection,
  discoverFeatureCommands,
  toDeploymentPayload,
} from '../app/interactions/commandRegistry.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** File in DATA_DIR recording what was last pushed to Discord. */
export const COMMAND_SYNC_STATE_FILE = 'command-sync.json';

interface CommandSyncState {
  hash: string;
  syncedAt: string;
}

/** Where the last registered payload's hash is kept. */
export function commandSyncStatePath(dataDir: string = env.DATA_DIR): string {
  return join(dataDir, COMMAND_SYNC_STATE_FILE);
}

function readSyncState(path: string): CommandSyncState | null {
  try {
    const state = JSON.parse(readFileSync(path, 'utf-8')) as unknown;
    return state &&
      typeof state === 'object' &&
      typeof (state as CommandSyncState).hash === 'string'
      ? (state as CommandSyncState)
      : null;
  } catch {
    return null;
  }
}

function writeSyncState(path: string, hash: string): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const state: CommandSyncState = {
      hash,
      syncedAt: new Date().toISOString(),
    };
    writeFileSync(path, `${JSON.stringify(state)}\n`);
  } catch (error) {
    // Only costs a redundant registration on the next boot.
    logger.warn(
      `Could not record the command sync state: ${getErrorMessage(error)}`
    );
  }
}

/**
 * Load all commands from feature modules
 * @param client The Discord client to load commands into
 */
export async function loadCommands(client: ExtendedClient): Promise<void> {
  const featuresPath = join(__dirname, '..', 'features');
  const discovered = await discoverFeatureCommands(featuresPath);
  client.commands = buildCommandCollection(discovered);
  for (const item of discovered) {
    logger.debug(
      `Loaded command: ${item.command.data.name} (features/${item.feature})`
    );
  }

  logger.info(`Loaded ${client.commands.size} commands`);
}

export interface RegisterCommandsOptions {
  /**
   * Push the command set even when it has not changed since the last sync.
   * Defaults to `FORCE_COMMAND_SYNC=true` in the environment: use it after
   * commands were edited outside the bot (Developer Portal, another script).
   */
  force?: boolean;
  /** Override the sync state file (tests). */
  statePath?: string;
}

/**
 * Register slash commands with Discord API.
 *
 * The full command set used to be PUT on every READY, which a crash loop
 * turns into a stream of rate-limited writes. The payload's hash is now kept
 * in DATA_DIR; when it matches, the commands are only fetched - to learn
 * their ids for clickable mentions - and the PUT is skipped. Either way the
 * ids end up in `setCommandIds`, so `commandMention()` renders
 * `</voice record:ID>`.
 *
 * @param client The Discord client with loaded commands (logged in, so its
 * REST client carries the token and shares rate-limit state)
 */
export async function registerCommands(
  client: ExtendedClient,
  options: RegisterCommandsOptions = {}
): Promise<void> {
  const commandData = toDeploymentPayload(client.commands);
  const clientId = env.DISCORD_CLIENT_ID;
  const guildId = env.DISCORD_GUILD_ID;
  // Guild-specific registration is instant (development); global
  // registration takes up to an hour to propagate.
  const route = guildId
    ? Routes.applicationGuildCommands(clientId, guildId)
    : Routes.applicationCommands(clientId);
  const scope = guildId ? `guild ${guildId}` : 'global';

  const hash = createHash('sha256')
    .update(JSON.stringify({ clientId, scope, commands: commandData }))
    .digest('hex');
  const statePath = options.statePath ?? commandSyncStatePath();
  const force = options.force ?? process.env.FORCE_COMMAND_SYNC === 'true';

  if (!force && readSyncState(statePath)?.hash === hash) {
    try {
      const registered = (await client.rest.get(
        route
      )) as RESTGetAPIApplicationCommandsResult;
      const names = new Set(registered.map((command) => command.name));
      if (commandData.every((command) => names.has(command.name))) {
        setCommandIds(registered);
        logger.info(
          `Slash commands unchanged (${scope}); skipped registration`
        );
        return;
      }
      logger.warn(
        `Registered ${scope} commands no longer match the last sync; registering again`
      );
    } catch (error) {
      logger.warn(
        `Could not fetch registered commands, registering instead: ${getErrorMessage(error)}`
      );
    }
  }

  try {
    logger.info('Registering slash commands...');

    const registered = (await client.rest.put(route, {
      body: commandData,
    })) as RESTPutAPIApplicationCommandsResult;
    if (Array.isArray(registered)) setCommandIds(registered);
    writeSyncState(statePath, hash);

    logger.info(
      guildId
        ? `Registered ${commandData.length} commands to guild ${guildId}`
        : `Registered ${commandData.length} global commands`
    );
  } catch (error) {
    logger.error('Failed to register commands:', getErrorMessage(error));
    throw error;
  }
}
