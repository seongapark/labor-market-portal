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

/** OECD 14개 시트(0_수집현황 제외) 헤더의 합집합. oecd_obs 열과 순서까지 일치한다. */
const OECD_COLS = [
  'REF_AREA', '국가명', 'SEX', 'AGE', 'LABOUR_FORCE_STATUS', 'TIME_PERIOD', 'value',
  'WORKER_STATUS', 'AGGREGATION_OPERATION', 'MEASURE', 'UNIT_MEASURE', 'PRICE_BASE',
];
const OECD_COL_SET = new Set(OECD_COLS);
const OECD_INSERT_COLS = ['"table_id"', ...OECD_COLS.map((c) => `"${c}"`)];

function isEmpty(v: unknown): boolean {
  return v === null || v === undefined || (typeof v === 'string' && v.trim() === '');
}

/** oecd_obs 에 적재한다. 12열에 없는 키가 비어있지 않은 값으로 나오면 조용히 묻지 않고 던진다. */
export function loadOecdJsonl(db: DatabaseSync, sheet: string, lines: string[]): number {
  const stmt = db.prepare(
    `INSERT INTO oecd_obs (${OECD_INSERT_COLS.join(',')}) VALUES (${OECD_INSERT_COLS.map(() => '?').join(',')})`
  );
  let n = 0;
  db.exec('BEGIN');
  try {
    for (const line of lines) {
      const t = line.trim();
      if (!t) continue;
      const rec = JSON.parse(t) as Record<string, unknown>;
      for (const key of Object.keys(rec)) {
        if (OECD_COL_SET.has(key)) continue;
        if (!isEmpty(rec[key])) {
          throw new Error(`loadOecdJsonl: 시트 "${sheet}" 에 알 수 없는 열 "${key}" 이 있다`);
        }
      }
      const vals: (string | number | null)[] = [sheet];
      for (const col of OECD_COLS) {
        const v = rec[col];
        if (v === undefined || v === null) { vals.push(null); continue; }
        vals.push(col === 'value' ? Number(v) : String(v));
      }
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

/** grid 에 좌표 그대로 적재한다. jsonl 은 {r, c, v} — v 의 JS 타입이 숫자면 v_num, 아니면 v_txt.
    (엑셀 셀 값 타입을 그대로 옮긴 것이라, "202508" 같은 숫자처럼 보이는 문자열도 v_txt 로 남는다.) */
export function loadGridJsonl(db: DatabaseSync, src: Src, sheet: string, lines: string[]): number {
  const stmt = db.prepare(
    `INSERT OR REPLACE INTO grid (src, sheet, r, c, v_num, v_txt) VALUES (?,?,?,?,?,?)`
  );
  let n = 0;
  db.exec('BEGIN');
  try {
    for (const line of lines) {
      const t = line.trim();
      if (!t) continue;
      const rec = JSON.parse(t) as { r: number; c: number; v: unknown };
      let vNum: number | null = null;
      let vTxt: string | null = null;
      if (typeof rec.v === 'number') {
        vNum = rec.v;
      } else if (!isEmpty(rec.v)) {
        vTxt = String(rec.v);
      } else {
        continue;   // 빈 셀은 적재하지 않는다
      }
      stmt.run(src, sheet, Number(rec.r), Number(rec.c), vNum, vTxt);
      n++;
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return n;
}

export type LoadResult = { table: string; rows: number };

export function loadAll(db: DatabaseSync, rawDir: string): Record<string, LoadResult> {
  const out: Record<string, LoadResult> = {};

  // kosis → obs
  {
    const dir = join(rawDir, 'kosis');
    if (existsSync(dir)) {
      let n = 0;
      for (const f of readdirSync(dir)) {
        if (!f.endsWith('.jsonl')) continue;
        const sheet = basename(f, '.jsonl');
        if (sheet.startsWith('0_')) continue;   // 수집현황 시트는 관측이 아니다
        n += loadJsonl(db, 'kosis', sheet, readFileSync(join(dir, f), 'utf8').split('\n'));
      }
      out.kosis = { table: 'obs', rows: n };
    }
  }

  // oecd → oecd_obs (KOSIS 와 열 이름 체계가 달라 별도 테이블)
  {
    const dir = join(rawDir, 'oecd');
    if (existsSync(dir)) {
      let n = 0;
      for (const f of readdirSync(dir)) {
        if (!f.endsWith('.jsonl')) continue;
        const sheet = basename(f, '.jsonl');
        if (sheet.startsWith('0_')) continue;
        n += loadOecdJsonl(db, sheet, readFileSync(join(dir, f), 'utf8').split('\n'));
      }
      out.oecd = { table: 'oecd_obs', rows: n };
    }
  }

  // etc·panel → grid. jsonl 은 data/raw/<src>/ 가 아니라 data/raw/grid/<src>/ 에서 읽는다 —
  // 좌표를 담은 별도 덤프(dump_raw.py --grid)의 산출물이다.
  for (const src of ['etc', 'panel'] as Src[]) {
    const dir = join(rawDir, 'grid', src);
    if (!existsSync(dir)) continue;
    let n = 0;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.jsonl')) continue;
      const sheet = basename(f, '.jsonl');
      if (sheet.startsWith('0_')) continue;
      n += loadGridJsonl(db, src, sheet, readFileSync(join(dir, f), 'utf8').split('\n'));
    }
    out[src] = { table: 'grid', rows: n };
  }

  return out;
}
