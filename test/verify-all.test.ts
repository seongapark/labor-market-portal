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

test('summarize: 관문 통과 여부는 mismatch+error 가 0 인지다', () => {
  assert.equal(summarize(rows).gatePassed, false);
  // mismatch 도 error 도 없으면 통과.
  assert.equal(
    summarize(rows.filter((r) => r.verdict !== 'mismatch' && r.verdict !== 'error')).gatePassed,
    true,
  );
  // mismatch 는 0 인데 error 가 하나 남아 있으면: gatePassed 는 여전히 false 여야
  // 한다. `mm === 0` 만 보고 `&& er === 0` 을 빼먹는 회귀를 이 assertion 이 잡는다.
  assert.equal(summarize(rows.filter((r) => r.verdict !== 'mismatch')).gatePassed, false);
});
