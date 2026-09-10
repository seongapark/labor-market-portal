import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ORACLE = join('data', 'oracle');
const FORM = join('data', 'formulas');

function need(p: string) {
  if (!existsSync(p)) throw new Error(`먼저 덤프를 돌린다: ${p}`);
  return JSON.parse(readFileSync(p, 'utf8'));
}

test('oracle: p42 경활인구 2025년 값이 29598.9 다', () => {
  const o = need(join(ORACLE, 'part1_3.json'));
  const p42 = o['p42'];
  // 6행이 연도 헤더, 7행이 경활인구. 2025 는 마지막 연도 열이다.
  const yearCell = Object.keys(p42).find((k) => /^[A-Z]+6$/.test(k) && String(p42[k]) === '2025');
  assert.ok(yearCell, '2025 연도 헤더 칸을 찾아야 한다');
  const col = yearCell!.replace(/\d+$/, '');
  assert.equal(p42[col + '7'], 29598.9);
  assert.equal(p42['A7'], '경활인구');
});

test('oracle: 13개 파트가 모두 있다', () => {
  const parts = ['part1_1', 'part1_2', 'part1_3', 'part1_4(1)', 'part1_4(2)',
    'part1_5', 'part1_6', 'part1_7', 'part1_8', 'part1_9',
    'part2_1청년여성', 'part2_2장년비정규직', 'part3'];
  for (const p of parts) assert.ok(existsSync(join(ORACLE, p + '.json')), p + ' 없음');
});

test('formulas: extmap 이 파일마다 다른 것을 그대로 담는다', () => {
  // 실측: part1_7 은 1=별도데이터·2=KOSIS 로 역순이다
  const f7 = need(join(FORM, 'part1_7.json'));
  assert.equal(f7.extmap['1'], '별도데이터.xlsx');
  assert.equal(f7.extmap['2'], 'KOSIS_원데이터.xlsx');
  // part3 은 1=OECD
  const f3 = need(join(FORM, 'part3.json'));
  assert.equal(f3.extmap['1'], 'OECD_원데이터.xlsx');
  // part2_1 의 1번은 패널데이터다 (원천이 4개인 근거)
  const f21 = need(join(FORM, 'part2_1청년여성.json'));
  assert.match(f21.extmap['1'], /패널데이터/);
});

test('formulas: p42 의 경활인구 셀이 SUMIFS 다', () => {
  const f = need(join(FORM, 'part1_3.json'));
  const p42 = f.sheets['p42'];
  const cells = Object.keys(p42).filter((k) => /^B7$|^[C-Z]7$/.test(k));
  assert.ok(cells.length > 0, '7행에 수식이 있어야 한다');
  assert.match(p42[cells[0]], /SUMIFS/);
});
