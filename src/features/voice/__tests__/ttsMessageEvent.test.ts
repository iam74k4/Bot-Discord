import { Events } from 'discord.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExtendedClient } from '../../../client.js';

const handleTtsMessage = vi.hoisted(() => vi.fn());

vi.mock('../application/tts.js', () => ({ handleTtsMessage }));

vi.mock('../../../shared/utils/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
  getErrorMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)),
}));

const { event } = await import('../events/ttsMessage.js');
const { logger } = await import('../../../shared/utils/logger.js');

const message = { id: 'm1', content: 'hello' } as unknown as Parameters<
  typeof event.execute
>[1];

function client(isFullyReady: boolean): ExtendedClient {
  return { isFullyReady } as unknown as ExtendedClient;
}

describe('ttsMessage event', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    handleTtsMessage.mockResolvedValue(undefined);
  });

  it('listens to every MessageCreate', () => {
    expect(event.name).toBe(Events.MessageCreate);
    expect(event.once).toBe(false);
  });

  it('ignores messages until the bot is fully ready', async () => {
    await event.execute(client(false), message);
    expect(handleTtsMessage).not.toHaveBeenCalled();
  });

  it('hands messages to text-to-speech once ready', async () => {
    await event.execute(client(true), message);
    expect(handleTtsMessage).toHaveBeenCalledWith(message);
  });

  it('logs a failure instead of letting it escape the event loop', async () => {
    handleTtsMessage.mockRejectedValue(new Error('db locked'));

    await expect(event.execute(client(true), message)).resolves.toBeUndefined();

    expect(logger.error).toHaveBeenCalledWith(
      'TTS message handling failed:',
      'db locked'
    );
  });
});
