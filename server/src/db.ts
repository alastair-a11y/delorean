import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { seed } from './seed.ts';

const here = dirname(fileURLToPath(import.meta.url));

export type Row = Record<string, unknown>;

let db: DatabaseSync | null = null;

export function openDb(path = process.env.DB_PATH ?? join(here, '..', 'data', 'refinery.db')): DatabaseSync {
  if (db) return db;
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  db = new DatabaseSync(path);
  db.exec(readFileSync(join(here, 'schema.sql'), 'utf8'));
  seed(db);
  return db;
}

export function getDb(): DatabaseSync {
  if (!db) return openDb();
  return db;
}

/** Reset the module-level handle (tests). */
export function closeDb() {
  db?.close();
  db = null;
}

export function all<T = Row>(sql: string, ...params: unknown[]): T[] {
  return getDb().prepare(sql).all(...(params as any)) as T[];
}
export function get<T = Row>(sql: string, ...params: unknown[]): T | undefined {
  return getDb().prepare(sql).get(...(params as any)) as T | undefined;
}
export function run(sql: string, ...params: unknown[]) {
  return getDb().prepare(sql).run(...(params as any));
}
export function transaction<T>(fn: () => T): T {
  const d = getDb();
  d.exec('BEGIN');
  try {
    const out = fn();
    d.exec('COMMIT');
    return out;
  } catch (e) {
    d.exec('ROLLBACK');
    throw e;
  }
}

export function setting(key: string): string | undefined {
  return get<{ value: string }>('SELECT value FROM settings WHERE key = ?', key)?.value;
}
export function setSetting(key: string, value: string) {
  run('INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, value);
}

export function logActivity(entity: string, entityId: number | null, action: string, detail?: unknown) {
  run('INSERT INTO activity(entity, entity_id, action, detail) VALUES (?, ?, ?, ?)',
    entity, entityId, action, detail === undefined ? null : JSON.stringify(detail));
}

/** Build "UPDATE t SET a = ?, b = ? WHERE id = ?" from an object of allowed keys. */
export function updateRow(table: string, id: number, patch: Record<string, unknown>, allowed: string[]) {
  const keys = Object.keys(patch).filter(k => allowed.includes(k));
  if (keys.length === 0) return;
  const sets = keys.map(k => `${k} = ?`).join(', ');
  const hasUpdatedAt = ['jobs', 'bookings', 'quotes', 'invoices'].includes(table);
  run(`UPDATE ${table} SET ${sets}${hasUpdatedAt ? ", updated_at = datetime('now')" : ''} WHERE id = ?`,
    ...keys.map(k => patch[k] ?? null), id);
}
