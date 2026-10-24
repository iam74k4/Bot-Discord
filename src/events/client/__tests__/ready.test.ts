import { describe, expect, it, beforeEach, vi } from 'vitest';
import type { Client } from 'discord.js';
import type { ExtendedClient } from '../../../client.js';

const registerCommands = vi.fn();
const loggerInfo = vi.fn();
const loggerError = vi.fn();

vi.mock('../../../handlers/commandHandler.js', () => ({
  registerCommands,
}));

vi.mock('../../../shared/utils/logger.js', () => ({
  getErrorMessage: (error: unknown) =>
    error instanceof Error ? error.message : String(error),
  logger: {
    info: loggerInfo,
    error: loggerError,
  },
}));

function createReadyClient(): ExtendedClient {
  return {
    user: {
      tag: 'TestBot#0000',
      setPresence: vi.fn(),
    },
    guilds: {
      cache: {
        size: 2,
      },
    },
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
  });

  it('marks the client ready before registering commands', async () => {
    const { event } = await import('../ready.js');
    const client = createReadyClient();

    registerCommands.mockImplementationOnce(async () => {
      expect(client.isFullyReady).toBe(true);
    });

    await event.execute(client, asReadyClient(client));

    expect(registerCommands).toHaveBeenCalledWith(client);
    expect(client.isFullyReady).toBe(true);
  });

  it('keeps runtime interactions enabled when command registration fails', async () => {
    const { event } = await import('../ready.js');
    const client = createReadyClient();

    registerCommands.mockRejectedValueOnce(new Error('REST unavailable'));

    await expect(
      event.execute(client, asReadyClient(client))
    ).resolves.toBeUndefined();

    expect(client.isFullyReady).toBe(true);
    expect(loggerError).toHaveBeenCalledWith(
      'Slash command registration failed; continuing with loaded command handlers:',
      'REST unavailable'
    );
  });

  it('goes online with no activity and logs the guild count', async () => {
    const { event } = await import('../ready.js');
    const client = createReadyClient();

    await event.execute(client, asReadyClient(client));

    expect(client.user?.setPresence).toHaveBeenCalledWith({
      activities: [],
      status: 'online',
    });
    expect(loggerInfo).toHaveBeenCalledWith('Logged in as TestBot#0000');
    expect(loggerInfo).toHaveBeenCalledWith('Serving 2 guilds');
    expect(loggerInfo).toHaveBeenLastCalledWith('Bot is ready!');
  });

  it('does nothing until the client has a user', async () => {
    const { event } = await import('../ready.js');
    const client = { ...createReadyClient(), user: null } as ExtendedClient;

    await event.execute(client, asReadyClient(client));

    expect(client.isFullyReady).toBe(false);
    expect(registerCommands).not.toHaveBeenCalled();
    expect(loggerInfo).not.toHaveBeenCalled();
  });
});
