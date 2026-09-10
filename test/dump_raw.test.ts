import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, loadGridJsonl } from '../src/db/load.ts';

/** 합성 원천 xlsx 를 만드는 파이썬 한 줄짜리 */
function makeFixture(dir: string) {
  const py = `
import openpyxl, os
wb = openpyxl.Workbook()
ws = wb.active; ws.title = '0_수집현황'; ws['A1'] = '2025'
s = wb.create_sheet('DT_TEST01')
s.append(['C1_OBJ_NM', 'DT', 'C1', 'ITM_ID', 'ITM_NM', 'PRD_DE', 'C1_NM'])
s.append(['성별', 39775.4, '0', 'T10', '15세이상인구', '2008', '계'])
s.append(['성별', 40301.3, '0', 'T10', '15세이상인구', '2009', '계'])
s2 = wb.create_sheet('DT_TEST02')
s2.append(['ITM_ID', 'ITM_NM', 'PRD_DE', 'DT'])
s2.append(['T20', '취업자', '202508', 123.5])
s3 = wb.create_sheet('DT_TEST03')
s3.append([None, None, None])
s3.append(['제목행'])
s3.append(['A_NM', 'B_NM', 'DT'])
s3.append(['가', '나', 1.5])
s3.append(['다', '라', 2.5])
s4 = wb.create_sheet('DT_TEST04')
s4.append([100])
s4.append([200])
s4.append([300])
wb.save(os.path.join(${JSON.stringify(dir)}, 'KOSIS_원데이터.xlsx'))
`;
  execFileSync('python', ['-c', py], { stdio: 'pipe' });
}

test('dump_raw: 시트당 jsonl 과 headers.json 을 낸다', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lmp-'));
  makeFixture(dir);
  const out = join(dir, 'out');
  execFileSync('python', ['tools/extract/dump_raw.py', '--only', 'kosis', '--out', out], {
    env: { ...process.env, BOOKLET_DIR: dir },
    stdio: 'pipe',
  });

  const p = join(out, 'raw', 'kosis', 'DT_TEST01.jsonl');
  assert.ok(existsSync(p), 'jsonl 이 있어야 한다');
  const rows = readFileSync(p, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(rows.length, 2);
  assert.equal(rows[0].DT, 39775.4);
  assert.equal(rows[0].PRD_DE, '2008');
  assert.equal(rows[0].C1_NM, '계');

  const heads = JSON.parse(readFileSync(join(out, 'raw', 'headers.json'), 'utf8'));
  assert.deepEqual(heads.kosis.DT_TEST01, [
    'C1_OBJ_NM', 'DT', 'C1', 'ITM_ID', 'ITM_NM', 'PRD_DE', 'C1_NM',
  ]);
  assert.deepEqual(heads.kosis.DT_TEST02, ['ITM_ID', 'ITM_NM', 'PRD_DE', 'DT']);
});

test('dump_raw: PRD_DE 는 문자열로 남는다 (6자리 연간 표 때문)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lmp-'));
  makeFixture(dir);
  const out = join(dir, 'out');
  execFileSync('python', ['tools/extract/dump_raw.py', '--only', 'kosis', '--out', out], {
    env: { ...process.env, BOOKLET_DIR: dir },
    stdio: 'pipe',
  });
  const rows = readFileSync(join(out, 'raw', 'kosis', 'DT_TEST02.jsonl'), 'utf8')
    .trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(rows[0].PRD_DE, '202508');
  assert.equal(typeof rows[0].PRD_DE, 'string');
});

test('dump_raw: 헤더가 1행에 없으면 최초 10행 안에서 찾고, 없으면 _skipped 에 기록한다', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lmp-'));
  makeFixture(dir);
  const out = join(dir, 'out');
  execFileSync('python', ['tools/extract/dump_raw.py', '--only', 'kosis', '--out', out], {
    env: { ...process.env, BOOKLET_DIR: dir },
    stdio: 'pipe',
  });

  // DT_TEST03: 1행 공백, 2행 제목(단일 셀), 3행이 진짜 헤더(3열) — 3행부터 데이터 2건.
  const p3 = join(out, 'raw', 'kosis', 'DT_TEST03.jsonl');
  assert.ok(existsSync(p3), 'DT_TEST03 jsonl 이 있어야 한다');
  const rows3 = readFileSync(p3, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(rows3.length, 2);
  assert.deepEqual(rows3[0], { A_NM: '가', B_NM: '나', DT: 1.5 });
  assert.deepEqual(rows3[1], { A_NM: '다', B_NM: '라', DT: 2.5 });

  const heads = JSON.parse(readFileSync(join(out, 'raw', 'headers.json'), 'utf8'));
  assert.deepEqual(heads.kosis.DT_TEST03, ['A_NM', 'B_NM', 'DT']);
  assert.equal(heads.kosis._header_row.DT_TEST03, 3);

  // DT_TEST04: 모든 행이 1열짜리라 최초 10행 안에 헤더 후보가 없다 — 통째로 건너뛴다.
  const p4 = join(out, 'raw', 'kosis', 'DT_TEST04.jsonl');
  assert.ok(!existsSync(p4), 'DT_TEST04 는 jsonl 을 내면 안 된다');
  assert.ok(heads.kosis._skipped.includes('DT_TEST04'));
});

/** --grid 용 합성 원천 — 별도데이터.xlsx (src='etc') 한 시트, 좌표를 손으로 고정한다.
    1행: 헤더 탐지였다면 걸러졌을 제목행. 2행: '헤더처럼 보이는' 행(그리드 모드는 무시한다).
    3행: 진짜 숫자(2007)와 실수(3.5). 4행: 한글 텍스트 + 진짜 빈 칸. 5행: 공백만 있는 셀. */
function makeGridFixture(dir: string) {
  const py = `
import openpyxl, os
wb = openpyxl.Workbook()
ws = wb.active; ws.title = 'GRIDTEST'
ws.cell(row=1, column=1, value='표 제목')       # 헤더 위 제목행 — 그리드 모드는 이것도 남겨야 한다
ws.cell(row=2, column=1, value='YEAR')
ws.cell(row=2, column=2, value='202508')        # 숫자처럼 보이는 문자열 — 텍스트로 남아야 한다
ws.cell(row=3, column=1, value=2007)            # 진짜 숫자
ws.cell(row=3, column=2, value=3.5)             # 실수
ws.cell(row=4, column=1, value='가나다')
# row=4, column=2 는 값을 아예 안 써서 진짜 빈 칸
ws.cell(row=5, column=1, value='   ')           # 공백만 — 빈 칸으로 쳐야 한다
wb.save(os.path.join(${JSON.stringify(dir)}, '별도데이터.xlsx'))
`;
  execFileSync('python', ['-c', py], { stdio: 'pipe' });
}

test('dump_raw --grid: 좌표 그대로 낸다 — 숫자문자열은 문자열로, 진짜 숫자는 숫자로, 빈칸은 안 낸다', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lmp-grid-'));
  makeGridFixture(dir);
  const out = join(dir, 'out');
  execFileSync('python', ['tools/extract/dump_raw.py', '--grid', 'etc', '--out', out], {
    env: { ...process.env, BOOKLET_DIR: dir },
    stdio: 'pipe',
  });

  const p = join(out, 'raw', 'grid', 'etc', 'GRIDTEST.jsonl');
  assert.ok(existsSync(p), '그리드 jsonl 이 있어야 한다');
  const rows = readFileSync(p, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const at = (r: number, c: number) => rows.find((x) => x.r === r && x.c === c);

  // 헤더 탐지가 있었다면 걸러졌을 제목행(1행)도 그대로 남는다 — 1-based 좌표.
  const title = at(1, 1);
  assert.ok(title, '1행(제목행)도 남아야 한다');
  assert.equal(title.v, '표 제목');

  // 숫자처럼 보이는 문자열은 문자열로 남는다 — prd_de 류 오염을 막는 핵심 단언.
  const numLike = at(2, 2);
  assert.ok(numLike);
  assert.equal(numLike.v, '202508');
  assert.equal(typeof numLike.v, 'string');

  // 진짜 숫자는 숫자로 남는다.
  const realNum = at(3, 1);
  assert.ok(realNum);
  assert.equal(realNum.v, 2007);
  assert.equal(typeof realNum.v, 'number');

  const realFloat = at(3, 2);
  assert.ok(realFloat);
  assert.equal(realFloat.v, 3.5);
  assert.equal(typeof realFloat.v, 'number');

  const korean = at(4, 1);
  assert.ok(korean);
  assert.equal(korean.v, '가나다');

  // 진짜 빈 칸(4,2)과 공백만 있는 칸(5,1)은 레코드 자체가 없어야 한다.
  assert.equal(at(4, 2), undefined, '빈 칸은 레코드를 내면 안 된다');
  assert.equal(at(5, 1), undefined, '공백만 있는 칸은 레코드를 내면 안 된다');

  // xlsx → jsonl → grid 테이블까지 끝까지 왕복 확인.
  const db = openDb(':memory:');
  const n = loadGridJsonl(db, 'etc', 'GRIDTEST', readFileSync(p, 'utf8').split('\n'));
  assert.equal(n, rows.length);

  const dbNumLike = db.prepare(
    `SELECT v_num, v_txt FROM grid WHERE src='etc' AND sheet='GRIDTEST' AND r=2 AND c=2`
  ).get() as { v_num: number | null; v_txt: string | null };
  assert.equal(dbNumLike.v_txt, '202508');
  assert.equal(dbNumLike.v_num, null);

  const dbRealNum = db.prepare(
    `SELECT v_num, v_txt FROM grid WHERE src='etc' AND sheet='GRIDTEST' AND r=3 AND c=1`
  ).get() as { v_num: number | null; v_txt: string | null };
  assert.equal(dbRealNum.v_num, 2007);
  assert.equal(dbRealNum.v_txt, null);
});
