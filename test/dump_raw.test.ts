import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
