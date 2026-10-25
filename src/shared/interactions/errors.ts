import { randomBytes } from 'node:crypto';

/**
 * A short reference for one failure (`3f9a1c`). It is shown to the user and
 * written to the log next to the error, so a report ("it said 3f9a1c") can be
 * matched to its stack trace.
 */
export function createErrorId(): string {
  return randomBytes(3).toString('hex');
}

/** The stack when there is one (for the log), otherwise the message. */
export function describeError(error: unknown): string {
  if (error instanceof Error) return error.stack || error.message;
  return String(error);
}
