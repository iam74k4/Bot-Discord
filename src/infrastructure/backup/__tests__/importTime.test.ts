import { describe, expect, it, vi } from 'vitest';

/**
 * Regression: importing the backup service used to read `BACKUP_DIR` while
 * building its storage, and reading any setting loads and validates the whole
 * configuration. Every module that merely imported the service - the admin
 * panel, `/owner`, the command loader - validated the environment as a side
 * effect, and its warnings surfaced in the middle of command discovery.
 */
const configReads = vi.hoisted(() => [] as string[]);

vi.mock('../../../config/index.js', () => ({
  env: new Proxy(
    {},
    {
      get(_target, property) {
        configReads.push(String(property));
        throw new Error(`config read: ${String(property)}`);
      },
    }
  ),
}));

describe('backup service at import time', () => {
  it('reads no configuration until it is used', async () => {
    const { backupService } = await import('../index.js');
    const { LocalStorage } = await import('../storage/localStorage.js');

    expect(backupService.isRunning()).toBe(false);
    expect(new LocalStorage()).toBeInstanceOf(LocalStorage);

    expect(configReads).toEqual([]);
  });
});
