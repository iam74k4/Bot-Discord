import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Dependencies must point one way: features may use infrastructure and
 * shared code, never the reverse, and never each other. These rules were
 * documented but not enforced, and three inversions had crept in.
 */

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');

interface SourceFile {
  path: string;
  imports: string[];
}

function collectSourceFiles(dir: string): SourceFile[] {
  const files: SourceFile[] = [];

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);

    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
      files.push(...collectSourceFiles(full));
      continue;
    }

    if (!entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) {
      continue;
    }

    const source = readFileSync(full, 'utf-8');
    const imports = [...source.matchAll(/from\s+'([^']+)'|import\('([^']+)'/g)]
      .map((match) => match[1] ?? match[2])
      .filter(Boolean);

    files.push({ path: relative(SRC, full).replace(/\\/g, '/'), imports });
  }

  return files;
}

/** Resolve a relative specifier to a src-relative path for matching. */
function resolveImport(fromFile: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null;
  return join(dirname(fromFile), specifier).replace(/\\/g, '/');
}

function importsFrom(dir: string): SourceFile[] {
  return collectSourceFiles(join(SRC, dir));
}

function violations(
  files: SourceFile[],
  isForbidden: (resolved: string, file: SourceFile) => boolean
): string[] {
  const found: string[] = [];

  for (const file of files) {
    for (const specifier of file.imports) {
      const resolved = resolveImport(file.path, specifier);
      if (resolved && isForbidden(resolved, file)) {
        found.push(`${file.path} → ${specifier}`);
      }
    }
  }

  return found;
}

describe('dependency direction', () => {
  const LOWER_LAYERS = [
    'infrastructure',
    'shared',
    'locales',
    'middleware',
    'config',
    'handlers',
  ];

  it.each(LOWER_LAYERS)('src/%s does not import features', (layer) => {
    const found = violations(importsFrom(layer), (resolved) =>
      resolved.startsWith('features/')
    );

    expect(found).toEqual([]);
  });

  it('src/app depends on the feature registry, not on individual features', () => {
    const found = violations(
      importsFrom('app'),
      (resolved) =>
        resolved.startsWith('features/') && resolved !== 'features/index.js'
    );

    expect(found).toEqual([]);
  });

  it('features do not import each other', () => {
    const files = importsFrom('features');

    const found = violations(files, (resolved, file) => {
      if (!resolved.startsWith('features/')) return false;

      const owner = file.path.split('/')[1];
      const target = resolved.split('/')[1];
      // features/index.js is the registry, not another feature.
      return target !== owner && target !== 'index.js';
    });

    expect(found).toEqual([]);
  });
});

describe('composition root', () => {
  it('is the only place the entry point gets the bot from', () => {
    const entry = collectSourceFiles(SRC).filter(
      (file) => file.path === 'index.ts'
    );

    expect(entry).toHaveLength(1);

    // src/index.ts owns the process - config, signals, crash reporting - and
    // nothing else. Assembling the bot belongs to app/composition.ts, which is
    // where the order is stated and tested.
    const found = violations(
      entry,
      (resolved) =>
        resolved.startsWith('features/') ||
        resolved.startsWith('infrastructure/') ||
        resolved.startsWith('middleware/') ||
        resolved.startsWith('handlers/')
    );

    expect(found).toEqual([]);
  });
});

describe('layer discipline inside a feature', () => {
  it('commands delegate instead of reaching for persistence', () => {
    const commandFiles = importsFrom('features').filter((file) =>
      file.path.includes('/commands/')
    );

    expect(commandFiles.length).toBeGreaterThan(0);

    const found = violations(
      commandFiles,
      (resolved) =>
        resolved.includes('/repositories/') ||
        resolved.startsWith('infrastructure/')
    );

    expect(found).toEqual([]);
  });

  it('only the database layer and its owners write raw SQL for guild_settings', () => {
    const owners = ['infrastructure/guildSettings/index.ts'];
    const offenders = collectSourceFiles(SRC)
      .filter((file) => !file.path.startsWith('infrastructure/database/'))
      .filter((file) => !owners.includes(file.path))
      .filter((file) => {
        const source = readFileSync(join(SRC, file.path), 'utf-8');
        return /(SELECT|INSERT|UPDATE|DELETE)[^;]*guild_settings/i.test(source);
      })
      .map((file) => file.path);

    expect(offenders).toEqual([]);
  });
});

describe('test layout', () => {
  /**
   * Tests live in `__tests__/` directories. One that sat next to its module
   * was compiled into `dist/` and shipped with the bot; the build now
   * excludes `*.test.ts` anywhere, and this keeps the layout uniform.
   */
  it('keeps every test file in a __tests__ directory', () => {
    const stray = readdirSync(SRC, { recursive: true, encoding: 'utf-8' })
      .map((path) => path.replace(/\\/g, '/'))
      .filter((path) => path.endsWith('.test.ts'))
      .filter((path) => !path.split('/').includes('__tests__'));

    expect(stray).toEqual([]);
  });
});
