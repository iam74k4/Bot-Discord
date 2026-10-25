import { vi } from 'vitest';

/**
 * Tests never read the developer's `.env`: loadConfig() calls dotenv, and a
 * tuning value there (AUDIO_BUFFER_DURATION, MAX_RECORDING_DURATION, ...)
 * would change command behaviour locally but not in CI, where there is no
 * `.env`.
 */
vi.mock('dotenv', () => ({ config: () => ({ parsed: {} }) }));

/**
 * Required before any test file imports modules that load `src/config` (which
 * calls `validateEnv()` at module load). CI and fresh clones have no `.env`.
 */
if (!process.env.DISCORD_TOKEN) {
  process.env.DISCORD_TOKEN = 'vitest-placeholder-discord-token';
}
if (!process.env.DISCORD_CLIENT_ID) {
  process.env.DISCORD_CLIENT_ID = '1234567890123456789';
}
if (!process.env.BOT_OWNER_IDS) {
  process.env.BOT_OWNER_IDS = '1234567890123456789';
}

/**
 * Keep tests off the developer's real database. Repositories open the
 * connection lazily, so any unmocked repository call would otherwise read
 * (and create) `data/bot.db` and make results depend on local state.
 */
if (!process.env.DATABASE_PATH) {
  process.env.DATABASE_PATH = 'data/vitest.db';
}
