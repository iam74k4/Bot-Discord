import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Guild } from 'discord.js';
import type { ExtendedClient } from '../../../client.js';
import { event } from '../guildCreate.js';

const { allowlist, logger } = vi.hoisted(() => ({
  allowlist: { ids: [] as string[] },
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../../shared/utils/guildAllowlist.js', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('../../../shared/utils/guildAllowlist.js')
    >();
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

const client = {} as ExtendedClient;

function guild(id: string, leave = vi.fn().mockResolvedValue(undefined)) {
  return { id, name: `Server ${id}`, leave } as unknown as Guild & {
    leave: ReturnType<typeof vi.fn>;
  };
}

describe('guildCreate event', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    allowlist.ids = [];
  });

  it('listens for every join, not just the first', () => {
    expect(event.name).toBe('guildCreate');
    expect(event.once).toBe(false);
  });

  it('stays in any server when no list is set', async () => {
    const joined = guild('111111111111111111');

    await event.execute(client, joined);

    expect(joined.leave).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('stays in a listed server', async () => {
    allowlist.ids = ['111111111111111111'];
    const joined = guild('111111111111111111');

    await event.execute(client, joined);

    expect(joined.leave).not.toHaveBeenCalled();
  });

  it('leaves a server outside the list and says why', async () => {
    allowlist.ids = ['111111111111111111'];
    const joined = guild('222222222222222222');

    await event.execute(client, joined);

    expect(joined.leave).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      'Joined Server 222222222222222222 (222222222222222222), which is not in ALLOWED_GUILD_IDS; leaving.'
    );
  });

  it('logs instead of throwing when leaving fails', async () => {
    allowlist.ids = ['111111111111111111'];
    const joined = guild(
      '222222222222222222',
      vi.fn().mockRejectedValue(new Error('Missing Access'))
    );

    await expect(event.execute(client, joined)).resolves.toBeUndefined();

    expect(logger.error).toHaveBeenCalledWith(
      'Failed to leave Server 222222222222222222 (222222222222222222); remove the bot from that server by hand:',
      'Missing Access'
    );
  });
});
