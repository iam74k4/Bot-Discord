import * as nodeModule from 'node:module';
import { join } from 'node:path';
import { getErrorMessage, logger } from '../shared/utils/logger.js';

/**
 * V8's compile cache for faster restarts.
 *
 * With a warm cache, loading the bot's modules before login takes ~18% less
 * time (about 50-80 ms on a restart). Node only writes the cache at a normal
 * exit, and the host may end the process with SIGKILL, so it is flushed
 * explicitly once startup has loaded everything.
 *
 * `NODE_COMPILE_CACHE=<dir>` in the environment covers every module from
 * the first import. Without it, production enables the cache here, which
 * still covers what loads afterwards: every feature, command and event
 * module is imported dynamically during startup.
 */

/** The `node:module` functions used here, injectable for tests. */
export interface CompileCacheApi {
  enableCompileCache?: typeof nodeModule.enableCompileCache;
  flushCompileCache?: typeof nodeModule.flushCompileCache;
  getCompileCacheDir?: typeof nodeModule.getCompileCacheDir;
}

/** Cache directory inside DATA_DIR, which lives on the persistent volume. */
export const COMPILE_CACHE_DIR = '.node-compile-cache';

/**
 * Turn the cache on under `dataDir` unless it is already on.
 * @returns the directory in use, or undefined when it could not be enabled
 */
export function enableCompileCache(
  dataDir: string,
  api: CompileCacheApi = nodeModule
): string | undefined {
  try {
    const active = api.getCompileCacheDir?.();
    if (active) return active;

    const result = api.enableCompileCache?.(join(dataDir, COMPILE_CACHE_DIR));
    return result?.directory;
  } catch (error) {
    logger.debug(`Compile cache unavailable: ${getErrorMessage(error)}`);
    return undefined;
  }
}

/**
 * Write what has been compiled so far to the cache. Safe to call whether or
 * not the cache is on; never throws.
 */
export function flushCompileCache(api: CompileCacheApi = nodeModule): void {
  try {
    if (!api.getCompileCacheDir?.()) return;
    api.flushCompileCache?.();
  } catch (error) {
    logger.debug(
      `Could not flush the compile cache: ${getErrorMessage(error)}`
    );
  }
}
