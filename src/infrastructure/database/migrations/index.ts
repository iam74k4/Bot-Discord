import { readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { logger } from '../../../shared/utils/logger.js';
import { runTransaction } from '../transaction.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let isInitialized = false;

/**
 * Fail when two migration files share a number.
 *
 * Files run in name order, so two `011_*` files - easy to get when two
 * branches each add "the next" migration - would both run, in an order
 * decided by the rest of their names. Refusing to boot makes the clash
 * visible before either touches the database.
 */
function assertUniqueNumbers(files: string[]): void {
  const byNumber = new Map<string, string[]>();
  for (const file of files) {
    const number = file.slice(0, 3);
    byNumber.set(number, [...(byNumber.get(number) ?? []), file]);
  }
  for (const [number, sharing] of byNumber) {
    if (sharing.length > 1) {
      throw new Error(
        `Migration number ${number} is used by more than one file: ${sharing.join(', ')}. Renumber one of them.`
      );
    }
  }
}

/**
 * Discover migration files by convention (NNN_name.ts/.js), sorted by prefix.
 */
async function loadMigrations(): Promise<Array<() => void>> {
  const migrationDir = __dirname;
  const files = readdirSync(migrationDir)
    .filter((f) => !f.endsWith('.d.ts') && /^\d{3}_.*\.(ts|js)$/.test(f))
    .sort();
  assertUniqueNumbers(files);

  const fns: Array<() => void> = [];
  for (const file of files) {
    const filePath = join(migrationDir, file);
    const mod = await import(pathToFileURL(filePath).href);
    if (typeof mod.up === 'function') {
      fns.push(mod.up);
    } else {
      logger.warn(`Migration ${file} does not export an \`up\` function`);
    }
  }
  return fns;
}

/**
 * Run all database migrations inside a single transaction.
 * Safe to call multiple times — only executes once.
 */
export async function initializeDatabase(): Promise<void> {
  if (isInitialized) {
    logger.warn('Database already initialized, skipping');
    return;
  }

  const migrations = await loadMigrations();

  runTransaction(() => {
    for (const migration of migrations) {
      migration();
    }
  });

  isInitialized = true;
  logger.info(`Database initialized (${migrations.length} migrations)`);
}
