import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Dirent } from 'fs';
import type { AppConfig } from '../../config/index.js';
import type { ExtendedClient } from '../../client.js';
import type { FeatureContext } from '../index.js';

/**
 * The feature registry discovers `features/<name>/index.{js,ts}` modules and
 * starts/stops them with per-feature error isolation. The directory listing
 * is scripted through a mocked `fs`, and each feature module is replaced with
 * a fake via `vi.doMock`, so every test controls exactly which features exist
 * and how they behave. Modules are reset per test because the registry keeps
 * the loaded list in module state.
 */

const fsMock = vi.hoisted(() => ({
  readdirSync: vi.fn(),
  existsSync: vi.fn(),
}));
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return { ...actual, ...fsMock, default: { ...actual, ...fsMock } };
});

const logger = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));
vi.mock('../../shared/utils/logger.js', () => ({
  logger,
  getErrorMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)),
}));

const setServiceStatus = vi.hoisted(() => vi.fn());
vi.mock('../../infrastructure/health/index.js', () => ({
  setServiceStatus,
}));

/** Real feature directory names; fakes are mounted over their index modules. */
type FeatureDir = 'admin' | 'community' | 'general' | 'notification' | 'voice';

interface Entry {
  name: string;
  /** Defaults to true. */
  directory?: boolean;
  /** Which index file exists on disk; omitted means neither. */
  index?: 'ts' | 'js' | 'both';
}

function layout(entries: Entry[]): void {
  fsMock.readdirSync.mockReturnValue(
    entries.map(
      (e) =>
        ({
          name: e.name,
          isDirectory: () => e.directory ?? true,
        }) as Dirent
    )
  );
  fsMock.existsSync.mockImplementation((path: string) => {
    const normalized = String(path).replace(/\\/g, '/');
    return entries.some((e) => {
      if (!e.index) return false;
      const exts = e.index === 'both' ? ['ts', 'js'] : [e.index];
      return exts.some((ext) =>
        normalized.endsWith(`/features/${e.name}/index.${ext}`)
      );
    });
  });
}

function fakeFeature(name: string) {
  return {
    name,
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
  };
}

type Fake = ReturnType<typeof fakeFeature>;

function mountFeature(dir: FeatureDir, module: object): void {
  vi.doMock(`../${dir}/index.js`, () => module);
}

/** Lay out `features`, mount their fakes, and load a fresh registry. */
async function loadRegistry(features: Partial<Record<FeatureDir, object>>) {
  layout(Object.keys(features).map((name) => ({ name, index: 'ts' as const })));
  for (const [dir, module] of Object.entries(features)) {
    mountFeature(dir as FeatureDir, module);
  }
  const registry = await import('../index.js');
  await registry.loadFeatures();
  return registry;
}

const context: FeatureContext = {
  client: {} as ExtendedClient,
  config: {} as AppConfig,
};

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});

describe('loadFeatures', () => {
  it('starts with no features before discovery', async () => {
    const { getFeatureModules } = await import('../index.js');

    expect(getFeatureModules()).toEqual([]);
  });

  it('discovers every feature exporting { name, start, stop }, in directory order', async () => {
    const admin = fakeFeature('admin');
    const voice = fakeFeature('voice');

    const { getFeatureModules } = await loadRegistry({ admin, voice });

    expect(getFeatureModules().map((f) => f.name)).toEqual(['admin', 'voice']);
    expect(fsMock.readdirSync).toHaveBeenCalledWith(
      expect.stringMatching(/[\\/]features$/),
      { withFileTypes: true }
    );
    expect(logger.info).toHaveBeenCalledWith('Loaded 2 features');
  });

  it('skips files, underscore-prefixed folders, and folders without an index', async () => {
    layout([
      { name: 'general', index: 'ts' },
      { name: 'README.md', directory: false, index: 'ts' },
      { name: '_drafts', index: 'ts' },
      { name: 'voice' },
    ]);
    mountFeature('general', fakeFeature('general'));
    const registry = await import('../index.js');

    await registry.loadFeatures();

    expect(registry.getFeatureModules().map((f) => f.name)).toEqual([
      'general',
    ]);
    expect(logger.debug).toHaveBeenCalledWith(
      'Skipping feature directory without index: voice'
    );
    expect(logger.info).toHaveBeenCalledWith('Loaded 1 features');
  });

  it.each(['ts', 'js', 'both'] as const)(
    'loads a feature whose folder has index.%s',
    async (index) => {
      layout([{ name: 'general', index }]);
      mountFeature('general', fakeFeature('general'));
      const registry = await import('../index.js');

      await registry.loadFeatures();

      expect(registry.getFeatureModules().map((f) => f.name)).toEqual([
        'general',
      ]);
    }
  );

  it('prefers the compiled index.js and does not look for index.ts', async () => {
    layout([{ name: 'general', index: 'both' }]);
    mountFeature('general', fakeFeature('general'));
    const registry = await import('../index.js');

    await registry.loadFeatures();

    const checked = fsMock.existsSync.mock.calls.map((c) =>
      String(c[0]).replace(/\\/g, '/')
    );
    expect(checked).toEqual([expect.stringMatching(/general\/index\.js$/)]);
  });

  // Missing exports are spelled out as `undefined`: a vitest mock throws on
  // access to an export its factory did not declare, where a real ES module
  // namespace would simply yield undefined.
  it.each([
    ['no name', { name: undefined, start: vi.fn(), stop: vi.fn() }],
    ['a non-string name', { name: 42, start: vi.fn(), stop: vi.fn() }],
    ['no start', { name: 'general', start: undefined, stop: vi.fn() }],
    ['no stop', { name: 'general', start: vi.fn(), stop: undefined }],
    [
      'start that is not a function',
      { name: 'general', start: true, stop: vi.fn() },
    ],
  ])('rejects a module with %s and loads the others', async (_label, bad) => {
    const { getFeatureModules } = await loadRegistry({
      general: bad,
      voice: fakeFeature('voice'),
    });

    expect(getFeatureModules().map((f) => f.name)).toEqual(['voice']);
    expect(logger.warn).toHaveBeenCalledWith(
      'Feature general/index.ts does not export { name, start, stop }'
    );
  });

  it('logs a feature that fails to import and loads the others', async () => {
    layout([
      { name: 'admin', index: 'ts' },
      { name: 'voice', index: 'ts' },
    ]);
    vi.doMock('../admin/index.js', () => {
      throw new Error('native module missing');
    });
    mountFeature('voice', fakeFeature('voice'));
    const registry = await import('../index.js');

    await registry.loadFeatures();

    expect(registry.getFeatureModules().map((f) => f.name)).toEqual(['voice']);
    expect(logger.error).toHaveBeenCalledWith(
      'Failed to load feature admin:',
      expect.any(String)
    );
  });

  it('replaces the previous list when called again', async () => {
    const registry = await loadRegistry({
      admin: fakeFeature('admin'),
      voice: fakeFeature('voice'),
    });

    layout([{ name: 'admin', index: 'ts' }]);
    await registry.loadFeatures();

    expect(registry.getFeatureModules().map((f) => f.name)).toEqual(['admin']);
  });
});

describe('startAllFeatures', () => {
  it('starts every feature in order with the context and marks it healthy', async () => {
    const order: string[] = [];
    const admin = fakeFeature('admin');
    const voice = fakeFeature('voice');
    admin.start.mockImplementation(async () => void order.push('admin'));
    voice.start.mockImplementation(async () => void order.push('voice'));
    const registry = await loadRegistry({ admin, voice });

    await registry.startAllFeatures(context);

    expect(order).toEqual(['admin', 'voice']);
    expect(admin.start).toHaveBeenCalledWith(context);
    expect(voice.start).toHaveBeenCalledWith(context);
    expect(setServiceStatus.mock.calls).toEqual([
      ['feature:admin', true],
      ['feature:voice', true],
    ]);
  });

  it('waits for each feature to finish starting before starting the next', async () => {
    let finishAdmin!: () => void;
    const admin = fakeFeature('admin');
    const voice = fakeFeature('voice');
    admin.start.mockReturnValue(
      new Promise<void>((resolve) => (finishAdmin = resolve))
    );
    const registry = await loadRegistry({ admin, voice });

    const starting = registry.startAllFeatures(context);
    await Promise.resolve();
    expect(voice.start).not.toHaveBeenCalled();

    finishAdmin();
    await starting;
    expect(voice.start).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      'rejects',
      (f: Fake) => f.start.mockRejectedValue(new Error('token missing')),
    ],
    [
      'throws synchronously',
      (f: Fake) =>
        f.start.mockImplementation(() => {
          throw new Error('token missing');
        }),
    ],
  ])(
    'isolates a feature whose start %s: the rest still start',
    async (_label, breakIt) => {
      const admin = fakeFeature('admin');
      const general = fakeFeature('general');
      const voice = fakeFeature('voice');
      breakIt(general);
      const registry = await loadRegistry({ admin, general, voice });

      await expect(registry.startAllFeatures(context)).resolves.toBeUndefined();

      expect(admin.start).toHaveBeenCalledTimes(1);
      expect(voice.start).toHaveBeenCalledTimes(1);
      expect(setServiceStatus.mock.calls).toEqual([
        ['feature:admin', true],
        ['feature:general', false],
        ['feature:voice', true],
      ]);
      expect(logger.error).toHaveBeenCalledWith(
        'Failed to start feature general:',
        'token missing'
      );
    }
  );

  it('does nothing when no features are loaded', async () => {
    const registry = await loadRegistry({});

    await registry.startAllFeatures(context);

    expect(setServiceStatus).not.toHaveBeenCalled();
  });
});

describe('stopAllFeatures', () => {
  it('stops features in reverse start order and marks them down', async () => {
    const order: string[] = [];
    const admin = fakeFeature('admin');
    const general = fakeFeature('general');
    const voice = fakeFeature('voice');
    for (const f of [admin, general, voice]) {
      f.stop.mockImplementation(async () => void order.push(f.name));
    }
    const registry = await loadRegistry({ admin, general, voice });

    await registry.stopAllFeatures();

    expect(order).toEqual(['voice', 'general', 'admin']);
    expect(setServiceStatus.mock.calls).toEqual([
      ['feature:voice', false],
      ['feature:general', false],
      ['feature:admin', false],
    ]);
  });

  it('keeps stopping the rest when one feature fails to stop', async () => {
    const admin = fakeFeature('admin');
    const general = fakeFeature('general');
    const voice = fakeFeature('voice');
    general.stop.mockRejectedValue(new Error('still connected'));
    const registry = await loadRegistry({ admin, general, voice });

    await expect(registry.stopAllFeatures()).resolves.toBeUndefined();

    expect(voice.stop).toHaveBeenCalledTimes(1);
    expect(admin.stop).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(
      'Failed to stop feature general:',
      'still connected'
    );
    // A feature that failed to stop is not reported as cleanly stopped.
    expect(setServiceStatus).not.toHaveBeenCalledWith('feature:general', false);
  });

  it('does not reorder the registry itself', async () => {
    const registry = await loadRegistry({
      admin: fakeFeature('admin'),
      voice: fakeFeature('voice'),
    });

    await registry.stopAllFeatures();

    expect(registry.getFeatureModules().map((f) => f.name)).toEqual([
      'admin',
      'voice',
    ]);
  });
});
