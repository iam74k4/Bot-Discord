import { readdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { Event } from '../shared/types/index.js';
import { ExtendedClient } from '../client.js';
import { getErrorMessage, logger } from '../shared/utils/logger.js';
import { isLoadableModuleFile } from '../app/interactions/commandRegistry.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Register a single event module on the client.
 * @returns true if the event was successfully registered
 */
async function registerEvent(
  client: ExtendedClient,
  filePath: string,
  label: string
): Promise<boolean> {
  try {
    const eventModule = await import(pathToFileURL(filePath).href);
    const event: Event = eventModule.default ?? eventModule.event;

    if (event?.name && typeof event.execute === 'function') {
      if (event.once) {
        client.once(event.name, (...args) =>
          (
            event.execute as (
              client: ExtendedClient,
              ...a: unknown[]
            ) => Promise<void>
          )(client, ...args)
        );
      } else {
        client.on(event.name, (...args) =>
          (
            event.execute as (
              client: ExtendedClient,
              ...a: unknown[]
            ) => Promise<void>
          )(client, ...args)
        );
      }

      logger.debug(`Loaded event: ${event.name} (${label})`);
      return true;
    }

    logger.warn(`Invalid event file: ${filePath} - missing name or execute`);
    return false;
  } catch (error) {
    logger.error(
      `Failed to load event from ${filePath}:`,
      getErrorMessage(error)
    );
    return false;
  }
}

/**
 * Load all events from the events directory.
 * Order: core src/events first, then each feature's events/ under src/features (folder name order).
 * Multiple listeners for the same event name are all invoked; do not rely on feature order for InteractionCreate.
 */
export async function loadEvents(client: ExtendedClient): Promise<void> {
  let eventCount = 0;

  // Core events (src/events/*/)
  const eventsPath = join(__dirname, '..', 'events');
  const categoryFolders = readdirSync(eventsPath, { withFileTypes: true })
    .filter((dirent) => dirent.isDirectory())
    .map((dirent) => dirent.name);

  for (const category of categoryFolders) {
    const categoryPath = join(eventsPath, category);
    const eventFiles = readdirSync(categoryPath).filter(isLoadableModuleFile);

    for (const file of eventFiles) {
      const registered = await registerEvent(
        client,
        join(categoryPath, file),
        category
      );
      if (registered) eventCount++;
    }
  }

  // Feature events (src/features/*/events/)
  const featuresPath = join(__dirname, '..', 'features');
  if (existsSync(featuresPath)) {
    const featureFolders = readdirSync(featuresPath, { withFileTypes: true })
      .filter((dirent) => dirent.isDirectory())
      .map((dirent) => dirent.name);

    for (const feature of featureFolders) {
      const featureEventsPath = join(featuresPath, feature, 'events');
      if (!existsSync(featureEventsPath)) continue;

      const eventFiles =
        readdirSync(featureEventsPath).filter(isLoadableModuleFile);

      for (const file of eventFiles) {
        const registered = await registerEvent(
          client,
          join(featureEventsPath, file),
          `features/${feature}`
        );
        if (registered) eventCount++;
      }
    }
  }

  logger.info(`Loaded ${eventCount} events`);
}
