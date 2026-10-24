import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const logger = vi.hoisted(() => ({
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
}));
vi.mock('../../shared/utils/logger.js', () => ({
  logger,
  getErrorMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)),
}));

const sendAlert = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('../../shared/utils/alert.js', () => ({ sendAlert }));

const { installProcessHandlers } = await import('../processHandlers.js');

/**
 * The exit code is the contract here: the host restarts the bot only on a
 * non-zero exit, so a crash that exits 0 leaves it down until someone
 * redeploys by hand.
 */
function setup({ stop = vi.fn().mockResolvedValue(undefined) } = {}) {
  const listeners = new Map<string, (...args: unknown[]) => void>();
  const hooks = {
    on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
      listeners.set(event, listener);
    }),
    exit: vi.fn(),
  };
  const client = new EventEmitter();
  const app = { client, start: vi.fn(), stop } as never;
  const handlers = installProcessHandlers(app, 10_000, hooks);
  const emit = (event: string, ...args: unknown[]) =>
    listeners.get(event)?.(...args);
  return { hooks, emit, stop, handlers, client };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

describe('installProcessHandlers', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each(['SIGINT', 'SIGTERM', 'SIGHUP'])(
    'shuts down gracefully and exits 0 on %s',
    async (signal) => {
      const { emit, hooks, stop } = setup();

      emit(signal);
      await settle();

      expect(stop).toHaveBeenCalledTimes(1);
      expect(hooks.exit).toHaveBeenCalledWith(0);
    }
  );

  it('exits 1 after an uncaught exception so the host restarts the bot', async () => {
    const { emit, hooks, stop } = setup();

    emit('uncaughtException', new Error('database is locked'));
    await settle();

    expect(stop).toHaveBeenCalledTimes(1);
    expect(hooks.exit).toHaveBeenCalledTimes(1);
    expect(hooks.exit).toHaveBeenCalledWith(1);
    expect(sendAlert).toHaveBeenCalledWith(
      'Uncaught Exception',
      'database is locked',
      expect.any(Array)
    );
  });

  it('exits 1 when shutting down after an uncaught exception fails', async () => {
    const { emit, hooks } = setup({
      stop: vi.fn().mockRejectedValue(new Error('stop failed')),
    });

    emit('uncaughtException', new Error('boom'));
    await settle();

    expect(hooks.exit).toHaveBeenCalledWith(1);
  });

  it('forces exit 1 when shutdown outlives the timeout', async () => {
    const { emit, hooks } = setup({
      stop: vi.fn(() => new Promise<void>(() => undefined)),
    });

    emit('SIGTERM');
    await settle();
    expect(hooks.exit).not.toHaveBeenCalled();

    vi.advanceTimersByTime(10_000);

    expect(hooks.exit).toHaveBeenCalledWith(1);
  });

  it('ignores further signals while a shutdown is running', async () => {
    const { emit, stop } = setup({
      stop: vi.fn(() => new Promise<void>(() => undefined)),
    });

    emit('SIGTERM');
    emit('SIGINT');
    await settle();

    expect(stop).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      'Shutdown already in progress, ignoring SIGINT'
    );
  });

  it('reports unhandled rejections without exiting', async () => {
    const { emit, hooks } = setup();

    emit('unhandledRejection', new Error('late'), Promise.resolve());
    await settle();

    expect(sendAlert).toHaveBeenCalledWith(
      'Unhandled Promise Rejection',
      'late',
      expect.any(Array)
    );
    expect(hooks.exit).not.toHaveBeenCalled();
  });

  it('reports Discord client errors', () => {
    const { client } = setup();

    client.emit('error', new Error('gateway hiccup'));

    expect(sendAlert).toHaveBeenCalledWith(
      'Discord Client Error',
      'gateway hiccup',
      undefined
    );
  });
});
