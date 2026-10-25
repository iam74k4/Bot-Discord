import type { MiddlewareResult } from '../shared/types/index.js';

/**
 * What the built-in middleware return. A rejection may bring its own
 * `title`, so a cooldown reads "Slow down" and a missing permission reads
 * "Missing permission" instead of one generic heading.
 */
export type MiddlewareOutcome = MiddlewareResult;
