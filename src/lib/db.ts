// Helper D1 (SQLite) — API mirip PDO: prepared statements dengan ? placeholder,
// pemetaan hasil fetch → object (D1 mengembalikan nilai yang bisa null/undefined).
import type { D1Database, D1Result } from '@cloudflare/workers-types';

export interface CtxDB {
  DB: D1Database;
}

export function num(v: unknown): number {
  if (v === null || v === undefined) return 0;
  const n = Number(v);
  return Number.isNaN(n) ? 0 : n;
}

export function s(v: unknown): string {
  if (v === null || v === undefined) return '';
  return String(v);
}

// Siapkan argumen; D1 strict — null bukan undefined.
export function args(values: unknown[]): (string | number | null)[] {
  return values.map((v) => {
    if (v === undefined || v === null) return null;
    if (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') return v as unknown as string | number;
    return String(v);
  });
}

// Ambil semua baris → array objek (normalisasi nilai null).
export async function all(
  db: D1Database,
  sql: string,
  values: unknown[] = [],
): Promise<Record<string, unknown>[]> {
  const res: D1Result<Record<string, unknown>> = await db
    .prepare(sql)
    .bind(...args(values))
    .all();
  return (res.results ?? []) as Record<string, unknown>[];
}

// Ambil satu baris atau null.
export async function one(
  db: D1Database,
  sql: string,
  values: unknown[] = [],
): Promise<Record<string, unknown> | null> {
  const rows = await all(db, sql, values);
  return rows[0] ?? null;
}

// Eksekusi tanpa hasil (INSERT/UPDATE/DELETE/DDL).
export async function run(db: D1Database, sql: string, values: unknown[] = []): Promise<void> {
  await db.prepare(sql).bind(...args(values)).run();
}

// Eksekusi BANYAK pernyataan DDL (CREATE TABLE IF NOT EXISTS) dalam satu panggilan.
export async function runBatch(db: D1Database, statements: string[]): Promise<{ ok: number; errs: string[] }> {
  let ok = 0;
  const errs: string[] = [];
  for (const sql of statements) {
    try {
      await run(db, sql);
      ok++;
    } catch (e: unknown) {
      errs.push(String(e instanceof Error ? e.message : e));
    }
  }
  return { ok, errs };
}

// INSERT lalu kembalikan last_insert_rowid() (diambil dari meta hasil run INSERT).
export async function insertId(
  db: D1Database,
  sql: string,
  values: unknown[] = [],
): Promise<number> {
  const res: D1Result = await db.prepare(sql).bind(...args(values)).run();
  const meta = res.meta as unknown as { last_row_id?: number };
  return meta?.last_row_id ?? 0;
}
