import { describe, expect, it, beforeEach, vi } from 'vitest';
import { type Client, Collection } from 'discord.js';
import type { ExtendedClient } from '../../../client.js';
import { event } from '../ready.js';

// Hoisted so the vi.mock factories (which run before any import) can see
// them; the logger mock has every level so a new log call cannot crash a test.
const { registerCommands, logger, allowlist } = vi.hoisted(() => ({
  registerCommands: vi.fn(),
  allowlist: { ids: [] as string[] },
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../../../handlers/commandHandler.js', () => ({
  registerCommands,
}));

vi.mock('../../../app/guildAllowlist.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../app/guildAllowlist.js')>();
  return {
    isGuildAllowed: (guildId: string | null) =>
      actual.isGuildAllowed(guildId, allowlist.ids),
  };
});

vi.mock('../../../shared/utils/logger.js', () => ({
  getErrorMessage: (error: unknown) =>
    error instanceof Error ? error.message : String(error),
  logger,
}));

function createReadyClient(): ExtendedClient {
  const leave = vi.fn();
  const cache = new Collection(
    ['111111111111111111', '222222222222222222'].map((id) => [
      id,
      { id, name: `Server ${id}`, leave },
    ])
  );
  return {
    user: {
      tag: 'TestBot#0000',
      setPresence: vi.fn(),
    },
    guilds: { cache },
    isFullyReady: false,
  } as unknown as ExtendedClient;
}

/** discord.js emits `clientReady` with the (now ready) client itself. */
function asReadyClient(client: ExtendedClient): Client<true> {
  return client as unknown as Client<true>;
}

describe('ready event', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    allowlist.ids = [];
  });

  it('marks the client ready before registering commands', async () => {
    const client = createReadyClient();

    registerCommands.mockImplementationOnce(async () => {
      expect(client.isFullyReady).toBe(true);
    });

    await event.execute(client, asReadyClient(client));

    expect(registerCommands).toHaveBeenCalledWith(client);
    expect(client.isFullyReady).toBe(true);
  });

  it('keeps runtime interactions enabled when command registration fails', async () => {
    const client = createReadyClient();

    registerCommands.mockRejectedValueOnce(new Error('REST unavailable'));

    await expect(
      event.execute(client, asReadyClient(client))
    ).resolves.toBeUndefined();

    expect(client.isFullyReady).toBe(true);
    expect(logger.error).toHaveBeenCalledWith(
      'Slash command registration failed; continuing with loaded command handlers:',
      'REST unavailable'
    );
  });

  it('goes online with no activity and logs the guild count', async () => {
    const client = createReadyClient();

    await event.execute(client, asReadyClient(client));

    expect(client.user?.setPresence).toHaveBeenCalledWith({
      activities: [],
      status: 'online',
    });
    expect(logger.info).toHaveBeenCalledWith('Logged in as TestBot#0000');
    expect(logger.info).toHaveBeenCalledWith('Serving 2 guilds');
    expect(logger.info).toHaveBeenLastCalledWith('Bot is ready!');
  });

  it('does nothing until the client has a user', async () => {
    const client = { ...createReadyClient(), user: null } as ExtendedClient;

    await event.execute(client, asReadyClient(client));

    expect(client.isFullyReady).toBe(false);
    expect(registerCommands).not.toHaveBeenCalled();
    expect(logger.info).not.toHaveBeenCalled();
  });

  describe('ALLOWED_GUILD_IDS', () => {
    it('warns about nothing when every server is allowed', async () => {
      const client = createReadyClient();

      await event.execute(client, asReadyClient(client));

      expect(logger.warn).not.toHaveBeenCalled();
    });

    it('names the servers outside the list but does not leave them', async () => {
      allowlist.ids = ['111111111111111111'];
      const client = createReadyClient();

      await event.execute(client, asReadyClient(client));

      expect(logger.warn).toHaveBeenCalledWith(
        'In 1 server(s) outside ALLOWED_GUILD_IDS; commands are refused there. ' +
          'Remove the bot from them or add their IDs: Server 222222222222222222 (222222222222222222)'
      );
      // Leaving is irreversible: a mistyped or copied list must cost a
      // config fix, not every server the bot was in.
      for (const guild of client.guilds.cache.values()) {
        expect(guild.leave).not.toHaveBeenCalled();
      }
      expect(client.isFullyReady).toBe(true);
      expect(registerCommands).toHaveBeenCalledWith(client);
    });
  });
});
