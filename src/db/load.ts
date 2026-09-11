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

export function loadAll(db: DatabaseSync, rawDir: string): Partial<Record<Src, LoadResult>> {
  const out: Partial<Record<Src, LoadResult>> = {};

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

/** 전체 리뷰 F11: **관문의 자료 쪽을 못박는 지문.**
    `data/obs.sqlite` 와 `data/raw/**` 는 gitignore 라, 저장소 어디에도 입력 자료의
    규모·시점이 적혀 있지 않았다. 그래서 다른 시점의 DB 로 관문을 다시 돌렸을 때
    「번역 회귀」와 「자료 개정」을 구별할 수 없었는데, 그 모호함을 없애려고 만든 것이
    `gate-snapshot.json` 이다(세종 3칸의 면제 사유도 추적되지 않는 DB 에 대한 진술이다).

    **파일 해시는 쓸모없다** — 재수집마다 달라지고, 무엇이 달라졌는지는 말해 주지 않는다.
    내용 지문이어야 한다: 표별 행 수와 시점의 최대값(`prd_de`·`TIME_PERIOD`). 싸다
    (한 표당 한 행씩 집계 세 번). */
export type TableFingerprint = { rows: number; max_period: string | null };
export type DataFingerprint = {
  rows: { obs: number; oecd_obs: number; grid: number };
  /** KOSIS 표ID → 행 수 · 최대 prd_de */
  kosis: Record<string, TableFingerprint>;
  /** OECD 데이터셋 → 행 수 · 최대 TIME_PERIOD */
  oecd: Record<string, TableFingerprint>;
  /** 격자 원천 → 행 수 · 시트 수 */
  grid: Record<string, { rows: number; sheets: number }>;
};

export function dataFingerprint(db: DatabaseSync): DataFingerprint {
  const one = (sql: string) => (db.prepare(sql).get() as { n: number } | undefined)?.n ?? 0;
  const kosis: Record<string, TableFingerprint> = {};
  for (const r of db.prepare(
    `SELECT table_id AS t, COUNT(*) AS n, MAX(prd_de) AS m FROM obs
      WHERE src = 'kosis' GROUP BY table_id ORDER BY table_id`,
  ).all() as { t: string; n: number; m: string | null }[]) {
    kosis[r.t] = { rows: r.n, max_period: r.m };
  }
  const oecd: Record<string, TableFingerprint> = {};
  for (const r of db.prepare(
    `SELECT "table_id" AS t, COUNT(*) AS n, MAX("TIME_PERIOD") AS m FROM oecd_obs
      GROUP BY "table_id" ORDER BY "table_id"`,
  ).all() as { t: string; n: number; m: string | null }[]) {
    oecd[r.t] = { rows: r.n, max_period: r.m };
  }
  const grid: Record<string, { rows: number; sheets: number }> = {};
  for (const r of db.prepare(
    `SELECT src AS s, COUNT(*) AS n, COUNT(DISTINCT sheet) AS sh FROM grid
      GROUP BY src ORDER BY src`,
  ).all() as { s: string; n: number; sh: number }[]) {
    grid[r.s] = { rows: r.n, sheets: r.sh };
  }
  return {
    rows: {
      obs: one('SELECT COUNT(*) AS n FROM obs'),
      oecd_obs: one('SELECT COUNT(*) AS n FROM oecd_obs'),
      grid: one('SELECT COUNT(*) AS n FROM grid'),
    },
    kosis, oecd, grid,
  };
}
