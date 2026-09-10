import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, loadJsonl, loadOecdJsonl, loadGridJsonl, loadAll } from '../src/db/load.ts';

test('loadJsonl: 헤더 이름을 obs 열로 옮긴다', () => {
  const db = openDb(':memory:');
  const n = loadJsonl(db, 'kosis', 'DT_X', [
    JSON.stringify({ C1_OBJ_NM: '성별', C1_NM: '계', DT: 39775.4, PRD_DE: '2008', ITM_NM: '15세이상인구' }),
    JSON.stringify({ C1_OBJ_NM: '성별', C1_NM: '남자', DT: 19000.1, PRD_DE: '2008', ITM_NM: '15세이상인구' }),
  ]);
  assert.equal(n, 2);
  const row = db.prepare(
    `SELECT dt, prd_de, c1_nm FROM obs WHERE src=? AND table_id=? AND c1_nm=?`
  ).get('kosis', 'DT_X', '계') as { dt: number; prd_de: string; c1_nm: string };
  assert.equal(row.dt, 39775.4);
  assert.equal(row.prd_de, '2008');
});

test('loadJsonl: prd_de 를 TEXT 로 유지한다', () => {
  const db = openDb(':memory:');
  loadJsonl(db, 'kosis', 'DT_Y', [JSON.stringify({ PRD_DE: '202508', DT: 1, ITM_NM: 'x' })]);
  const r = db.prepare(`SELECT prd_de FROM obs WHERE table_id='DT_Y'`).get() as { prd_de: string };
  assert.equal(r.prd_de, '202508');
  assert.equal(typeof r.prd_de, 'string');
});

test('loadJsonl: C4 까지 받는다', () => {
  const db = openDb(':memory:');
  loadJsonl(db, 'kosis', 'DT_Z', [
    JSON.stringify({ PRD_DE: '2024', DT: 5, C4_NM: '넷째차원', C4: '04', C4_OBJ_NM: '분류4' }),
  ]);
  const r = db.prepare(`SELECT c4_nm FROM obs WHERE table_id='DT_Z'`).get() as { c4_nm: string };
  assert.equal(r.c4_nm, '넷째차원');
});

test('loadJsonl: UNIT_NM 이 없는 시트도 적재된다', () => {
  const db = openDb(':memory:');
  const n = loadJsonl(db, 'kosis', 'DT_NOUNIT', [
    JSON.stringify({ PRD_DE: '2024', DT: 3, ITM_NM: 'x', C1_NM: '계' }),
  ]);
  assert.equal(n, 1);
  const r = db.prepare(`SELECT unit_nm FROM obs WHERE table_id='DT_NOUNIT'`).get() as { unit_nm: null };
  assert.equal(r.unit_nm, null);
});

test('loadOecdJsonl: 12개 열을 다 채운 레코드와 4개 필수 열만 있는 레코드를 함께 받는다', () => {
  const db = openDb(':memory:');
  const n = loadOecdJsonl(db, 'LFS', [
    JSON.stringify({
      REF_AREA: 'KOR', 국가명: '한국', SEX: '_T', AGE: 'Y15T64',
      LABOUR_FORCE_STATUS: 'POP', TIME_PERIOD: 2025, value: 35250.42,
      WORKER_STATUS: 'EMP', AGGREGATION_OPERATION: 'SUM', MEASURE: 'M1',
      UNIT_MEASURE: 'PS', PRICE_BASE: 'N',
    }),
    JSON.stringify({ REF_AREA: 'JPN', 국가명: '일본', TIME_PERIOD: 2020, value: 100 }),
  ]);
  assert.equal(n, 2);
  const full = db.prepare(`SELECT * FROM oecd_obs WHERE "REF_AREA"='KOR'`).get() as Record<string, unknown>;
  assert.equal(full.SEX, '_T');
  assert.equal(full.AGE, 'Y15T64');
  assert.equal(full.value, 35250.42);
  const sparse = db.prepare(`SELECT * FROM oecd_obs WHERE "REF_AREA"='JPN'`).get() as Record<string, unknown>;
  assert.equal(sparse.value, 100);
  assert.equal(sparse.SEX, null);
  assert.equal(sparse.WORKER_STATUS, null);
  assert.equal(sparse.PRICE_BASE, null);
});

test('loadOecdJsonl: 모르는 열이 비어있지 않은 값으로 있으면 시트명과 열이름을 담아 던진다', () => {
  const db = openDb(':memory:');
  assert.throws(
    () => loadOecdJsonl(db, 'LFS', [JSON.stringify({ REF_AREA: 'KOR', UNKNOWN_COL: '???' })]),
    (err: unknown) => {
      const msg = (err as Error).message;
      assert.match(msg, /LFS/);
      assert.match(msg, /UNKNOWN_COL/);
      return true;
    }
  );
});

test('loadGridJsonl: 좌표를 왕복한다 — 숫자문자열은 v_num 이 아니라 v_txt 로 남는다', () => {
  const db = openDb(':memory:');
  const n = loadGridJsonl(db, 'etc', 'SHEET1', [
    JSON.stringify({ r: 3, c: 2, v: 42.5 }),
    JSON.stringify({ r: 4, c: 2, v: '202508' }),
  ]);
  assert.equal(n, 2);
  const num = db.prepare(
    `SELECT v_num, v_txt FROM grid WHERE src='etc' AND sheet='SHEET1' AND r=3 AND c=2`
  ).get() as { v_num: number | null; v_txt: string | null };
  assert.equal(num.v_num, 42.5);
  assert.equal(num.v_txt, null);
  const txt = db.prepare(
    `SELECT v_num, v_txt FROM grid WHERE src='etc' AND sheet='SHEET1' AND r=4 AND c=2`
  ).get() as { v_num: number | null; v_txt: string | null };
  assert.equal(txt.v_txt, '202508');
  assert.equal(txt.v_num, null);
});

test('loadAll: 소스마다 어느 테이블로 갔는지와 행수를 함께 돌려준다', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lmp-loadall-'));
  mkdirSync(join(dir, 'kosis'), { recursive: true });
  writeFileSync(
    join(dir, 'kosis', 'DT_A.jsonl'),
    JSON.stringify({ PRD_DE: '2024', DT: 1, ITM_NM: 'x' }) + '\n'
  );
  mkdirSync(join(dir, 'oecd'), { recursive: true });
  writeFileSync(
    join(dir, 'oecd', 'LFS.jsonl'),
    JSON.stringify({ REF_AREA: 'KOR', TIME_PERIOD: 2024, value: 1 }) + '\n'
  );
  mkdirSync(join(dir, 'grid', 'etc'), { recursive: true });
  writeFileSync(join(dir, 'grid', 'etc', 'S1.jsonl'), JSON.stringify({ r: 1, c: 1, v: '표' }) + '\n');
  mkdirSync(join(dir, 'grid', 'panel'), { recursive: true });
  writeFileSync(join(dir, 'grid', 'panel', 'P1.jsonl'), JSON.stringify({ r: 1, c: 1, v: 1 }) + '\n');

  const db = openDb(':memory:');
  const out = loadAll(db, dir);
  assert.deepEqual(out, {
    kosis: { table: 'obs', rows: 1 },
    oecd: { table: 'oecd_obs', rows: 1 },
    etc: { table: 'grid', rows: 1 },
    panel: { table: 'grid', rows: 1 },
  });
});
