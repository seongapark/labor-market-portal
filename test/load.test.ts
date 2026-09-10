import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, loadJsonl } from '../src/db/load.ts';

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
