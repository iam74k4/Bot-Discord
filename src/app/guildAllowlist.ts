import { env } from '../config/index.js';

/**
 * Which servers this deployment serves (`ALLOWED_GUILD_IDS`).
 *
 * The real lock on a staging bot is its own private Discord application:
 * nobody else can invite it. This is the second lock, for the day it is
 * invited somewhere anyway - or a staging token ends up in the wrong
 * environment. An empty list means every server, which is production.
 *
 * Direct messages are always served: there is no server to be outside of,
 * and every server-scoped command already refuses to run in one.
 */
export function isGuildAllowed(
  guildId: string | null,
  allowed: readonly string[] = env.ALLOWED_GUILD_IDS
): boolean {
  if (guildId === null) return true;
  return allowed.length === 0 || allowed.includes(guildId);
}
