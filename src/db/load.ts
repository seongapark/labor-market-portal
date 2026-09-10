import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Src } from '../types.ts';

const HERE = dirname(fileURLToPath(import.meta.url));

/** jsonl 키 → obs 열. 키는 대문자로 맞춰서 본다. */
const COLMAP: Record<string, string> = {
  PRD_DE: 'prd_de', ITM_ID: 'itm_id', ITM_NM: 'itm_nm',
  C1_OBJ_NM: 'c1_obj_nm', C1: 'c1', C1_NM: 'c1_nm',
  C2_OBJ_NM: 'c2_obj_nm', C2: 'c2', C2_NM: 'c2_nm',
  C3_OBJ_NM: 'c3_obj_nm', C3: 'c3', C3_NM: 'c3_nm',
  C4_OBJ_NM: 'c4_obj_nm', C4: 'c4', C4_NM: 'c4_nm',
  UNIT_NM: 'unit_nm', DT: 'dt',
};

const COLS = ['src', 'table_id', ...Object.values(COLMAP)];

export function openDb(file: string): DatabaseSync {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(readFileSync(join(HERE, 'schema.sql'), 'utf8'));
  return db;
}

export function loadJsonl(db: DatabaseSync, src: Src, sheet: string, lines: string[]): number {
  const stmt = db.prepare(
    `INSERT INTO obs (${COLS.join(',')}) VALUES (${COLS.map(() => '?').join(',')})`
  );
  let n = 0;
  db.exec('BEGIN');
  try {
    for (const line of lines) {
      const t = line.trim();
      if (!t) continue;
      const rec = JSON.parse(t) as Record<string, unknown>;
      const vals: (string | number | null)[] = [src, sheet];
      for (const key of Object.keys(COLMAP)) {
        const v = rec[key];
        if (v === undefined || v === null) { vals.push(null); continue; }
        vals.push(key === 'DT' ? Number(v) : String(v));
      }
      // prd_de 가 없는 행은 관측이 아니다 (합계 주석 등)
      if (vals[2] === null) continue;
      stmt.run(...vals);
      n++;
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return n;
}

export function loadAll(db: DatabaseSync, rawDir: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const src of ['kosis', 'oecd', 'etc', 'panel'] as Src[]) {
    const dir = join(rawDir, src);
    if (!existsSync(dir)) continue;
    let n = 0;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.jsonl')) continue;
      const sheet = basename(f, '.jsonl');
      if (sheet.startsWith('0_')) continue;   // 수집현황 시트는 관측이 아니다
      n += loadJsonl(db, src, sheet, readFileSync(join(dir, f), 'utf8').split('\n'));
    }
    out[src] = n;
  }
  return out;
}
