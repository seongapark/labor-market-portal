import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarize } from '../scripts/verify-all.ts';
import type { CellResult } from '../src/verify/compare.ts';

const rows: CellResult[] = [
  { part: 'p1', sheet: 'a', ref: 'A1', verdict: 'match', expected: 1, got: 1 },
  { part: 'p1', sheet: 'a', ref: 'A2', verdict: 'match', expected: 2, got: 2 },
  { part: 'p1', sheet: 'a', ref: 'A3', verdict: 'mismatch', expected: 3, got: 9 },
  { part: 'p2', sheet: 'b', ref: 'B1', verdict: 'unsupported', expected: 1, got: null, reason: 'INDEX' },
  { part: 'p2', sheet: 'b', ref: 'B2', verdict: 'no-oracle', expected: null, got: null },
  { part: 'p2', sheet: 'b', ref: 'B3', verdict: 'error', expected: 1, got: null, reason: '실행 불가' },
];

test('summarize: 판정별로 센다', () => {
  const s = summarize(rows);
  assert.equal(s.total, 6);
  assert.equal(s.byVerdict.match, 2);
  assert.equal(s.byVerdict.mismatch, 1);
  assert.equal(s.byVerdict.unsupported, 1);
  assert.equal(s.byVerdict['no-oracle'], 1);
  assert.equal(s.byVerdict.error, 1);
});

test('summarize: 일치율은 대조 가능한 셀(match+mismatch+error) 기준이다', () => {
  const s = summarize(rows);
  // no-oracle 과 unsupported 는 분모에서 뺀다 — 대조를 한 게 아니다.
  // comparable 은 match(2)+mismatch(1)+error(1)=4 — error 를 분모에서 빼는
  // 회귀(= m+mm 만 쓰는 것)라면 3 이 나와 이 값과 어긋난다.
  assert.equal(s.comparable, 4);
  assert.equal(s.rate, 2 / 4);
});

test('summarize: 파트별로도 센다', () => {
  const s = summarize(rows);
  assert.equal(s.byPart['p1'].match, 2);
  assert.equal(s.byPart['p1'].mismatch, 1);
  assert.equal(s.byPart['p2'].unsupported, 1);
  assert.equal(s.byPart['p2'].error, 1);
});

test('summarize: 관문 통과 여부는 mismatch+error+unsupported 가 0 인지다', () => {
  assert.equal(summarize(rows).gatePassed, false);
  // mismatch 도 error 도 unsupported 도 없으면 통과.
  assert.equal(
    summarize(rows.filter((r) =>
      r.verdict !== 'mismatch' && r.verdict !== 'error' && r.verdict !== 'unsupported')).gatePassed,
    true,
  );
  // mismatch 는 0 인데 error 가 하나 남아 있으면: gatePassed 는 여전히 false 여야
  // 한다. `mm === 0` 만 보고 `&& er === 0` 을 빼먹는 회귀를 이 assertion 이 잡는다.
  assert.equal(summarize(rows.filter((r) => r.verdict !== 'mismatch')).gatePassed, false);
  // mismatch 도 error 도 없는데 unsupported 가 하나 남아 있으면: 여전히 false 여야
  // 한다. `&& un === 0` 을 빼먹는 회귀를 잡는다 (Task 9 단위 2 의 핵심).
  assert.equal(
    summarize(rows.filter((r) => r.verdict !== 'mismatch' && r.verdict !== 'error')).gatePassed,
    false,
  );
});

// TASK 9 단위 2 — presentation 판정과 관문 강화.
const presentationRow: CellResult =
  { part: 'p3', sheet: 'c', ref: 'C1', verdict: 'presentation', expected: 1, got: null, reason: 'INDEX' };

test('summarize: presentation 은 comparable 과 일치율 분모에서 빠진다', () => {
  const withPresentation = [...rows, presentationRow];
  const s = summarize(withPresentation);
  // rows 와 comparable·rate 가 동일해야 한다 — presentation 이 분모를 건드리지 않는다.
  assert.equal(s.comparable, 4);
  assert.equal(s.rate, 2 / 4);
  assert.equal(s.byVerdict.presentation, 1);
  assert.equal(s.total, 7);
});

// unsupported 하나가 남으면 관문은 실패해야 하지만, 같은 자리에 presentation 하나가
// 있으면(= "구현하지 않기로 한 결정") 관문은 통과해야 한다. 이 쌍이 단위 2 전체의
// 핵심을 고정한다 — 옛 두-조건 gatePassed(mm===0 && er===0)로 잠깐 되돌리면 두
// 케이스 모두 true 가 나와(=unsupported 를 걸러내지 못해) 이 테스트가 실패한다는
// 것을 로컬에서 직접 확인했다(커밋하지 않음).
test('summarize: mismatch·error 0 에 unsupported 1 이면 gatePassed=false, 그 자리가 presentation 이면 true', () => {
  const cleanRows: CellResult[] = rows.filter((r) => r.verdict === 'match');
  const withUnsupported = [...cleanRows,
    { part: 'p2', sheet: 'b', ref: 'B1', verdict: 'unsupported', expected: 1, got: null, reason: 'X' } as CellResult];
  const withPresentation = [...cleanRows, presentationRow];
  assert.equal(summarize(withUnsupported).gatePassed, false);
  assert.equal(summarize(withPresentation).gatePassed, true);
});
