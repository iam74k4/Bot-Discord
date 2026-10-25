import type { Database as DatabaseType } from 'better-sqlite3';

/**
 * Schema introspection for migration tests. Everything here reads SQLite's own
 * catalog (`sqlite_master` and `PRAGMA table_info`/`index_info`), so a test
 * asserts on the schema the database actually ended up with rather than on the
 * SQL text a migration happened to issue.
 */

export interface ColumnShape {
  type: string;
  notNull: boolean;
  default: string | null;
  /** Position in the primary key (1-based), or 0 when not part of it. */
  pk: number;
}

export interface TableShape {
  columns: Record<string, ColumnShape>;
  /** Index name to its column list, excluding SQLite's automatic indexes. */
  indexes: Record<string, string[]>;
}

interface TableInfoRow {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

/**
 * Wrap a connection so property access always reaches the connection that
 * `current()` returns at call time. Mirrors the lazy proxy in `connection.ts`,
 * which lets each test swap in a fresh `:memory:` database without re-importing
 * the modules under test.
 */
export function proxyDatabase(current: () => DatabaseType): DatabaseType {
  return new Proxy({} as DatabaseType, {
    get(_target, prop) {
      const instance = current();
      const value: unknown = Reflect.get(instance, prop, instance);
      return typeof value === 'function' ? value.bind(instance) : value;
    },
  });
}

/** User tables, sorted, without SQLite's internal `sqlite_*` bookkeeping. */
export function tableNames(db: DatabaseType): string[] {
  const rows = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    )
    .all() as Array<{ name: string }>;
  return rows.map((row) => row.name);
}

/** Every explicitly created index, sorted. */
export function indexNames(db: DatabaseType): string[] {
  const rows = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_autoindex%' ORDER BY name"
    )
    .all() as Array<{ name: string }>;
  return rows.map((row) => row.name);
}

export function columnsOf(
  db: DatabaseType,
  table: string
): Record<string, ColumnShape> {
  const rows = db.pragma(`table_info(${table})`) as TableInfoRow[];
  return Object.fromEntries(
    rows.map((row) => [
      row.name,
      {
        type: row.type,
        notNull: row.notnull === 1,
        default: row.dflt_value,
        pk: row.pk,
      },
    ])
  );
}

export function indexesOf(
  db: DatabaseType,
  table: string
): Record<string, string[]> {
  const rows = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND name NOT LIKE 'sqlite_autoindex%' ORDER BY name"
    )
    .all(table) as Array<{ name: string }>;

  return Object.fromEntries(
    rows.map((row) => {
      const columns = db.pragma(`index_info(${row.name})`) as Array<{
        seqno: number;
        name: string;
      }>;
      return [
        row.name,
        [...columns]
          .sort((a, b) => a.seqno - b.seqno)
          .map((column) => column.name),
      ];
    })
  );
}

/** The full shape of every user table, for comparing two databases. */
export function describeSchema(db: DatabaseType): Record<string, TableShape> {
  return Object.fromEntries(
    tableNames(db).map((table) => [
      table,
      { columns: columnsOf(db, table), indexes: indexesOf(db, table) },
    ])
  );
}

/** Every row of every user table, ordered by rowid so dumps compare stably. */
export function dumpRows(db: DatabaseType): Record<string, unknown[]> {
  return Object.fromEntries(
    tableNames(db).map((table) => [
      table,
      db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
    ])
  );
}

/** Shorthand for a column definition in an expected schema. */
export function col(
  type: string,
  options: { notNull?: boolean; default?: string; pk?: number } = {}
): ColumnShape {
  return {
    type,
    notNull: options.notNull ?? false,
    default: options.default ?? null,
    pk: options.pk ?? 0,
  };
}
