import { Collection } from 'discord.js';
import { readdirSync, existsSync } from 'fs';
import { join } from 'path';
import { pathToFileURL } from 'url';
import type { Command } from '../../shared/types/index.js';
import { getErrorMessage, logger } from '../../shared/utils/logger.js';

export interface DiscoveredCommand {
  feature: string;
  filePath: string;
  command: Command;
}

/**
 * Whether a directory entry is a module to import: `.ts` in development,
 * `.js` once built. Declaration files (`.d.ts`, emitted by `npm run build`
 * next to every module) and `index.*` barrels are not.
 */
export function isLoadableModuleFile(file: string): boolean {
  if (file.startsWith('index.')) return false;
  if (file.endsWith('.d.ts')) return false;
  return file.endsWith('.ts') || file.endsWith('.js');
}

function isValidCommand(command: unknown): command is Command {
  if (!command || typeof command !== 'object') return false;
  const c = command as Partial<Command>;
  return !!c.data?.name && typeof c.execute === 'function';
}

export async function discoverFeatureCommands(
  featuresPath: string
): Promise<DiscoveredCommand[]> {
  if (!existsSync(featuresPath)) return [];

  const discovered: DiscoveredCommand[] = [];
  const featureFolders = readdirSync(featuresPath, { withFileTypes: true })
    .filter((dirent) => dirent.isDirectory())
    .map((dirent) => dirent.name);

  for (const feature of featureFolders) {
    const featureCommandsPath = join(featuresPath, feature, 'commands');
    if (!existsSync(featureCommandsPath)) continue;

    const commandFiles =
      readdirSync(featureCommandsPath).filter(isLoadableModuleFile);

    for (const file of commandFiles) {
      const filePath = join(featureCommandsPath, file);
      try {
        const mod = await import(pathToFileURL(filePath).href);
        const maybeCommand = mod.default ?? mod.command;
        if (!isValidCommand(maybeCommand)) {
          logger.warn(
            `Invalid command file: ${filePath} - missing data.name or execute`
          );
          continue;
        }
        discovered.push({
          feature,
          filePath,
          command: maybeCommand,
        });
      } catch (error) {
        logger.error(
          `Failed to load command from ${filePath}:`,
          getErrorMessage(error)
        );
      }
    }
  }

  return discovered;
}

export function buildCommandCollection(
  commands: DiscoveredCommand[]
): Collection<string, Command> {
  const collection = new Collection<string, Command>();
  for (const item of commands) {
    collection.set(item.command.data.name, item.command);
  }
  return collection;
}

export function toDeploymentPayload(commands: Collection<string, Command>) {
  return commands.map((command) => command.data.toJSON());
}
