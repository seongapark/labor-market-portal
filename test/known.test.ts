import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { applyKnownDivergences, type CellResult, type KnownDivergence } from '../src/verify/compare.ts';
import { summarize } from '../scripts/verify-all.ts';

/** 세종 3칸을 흉내낸 최소 집합 — 하나는 면제 대상, 하나는 그냥 일치 */
function rows(): CellResult[] {
  return [
    { part: 'part1_1', sheet: 'p18', ref: 'B13', verdict: 'mismatch', expected: 5616, got: 2808 },
    { part: 'part1_1', sheet: 'p18', ref: 'C6', verdict: 'match', expected: -26769, got: -26769 },
  ];
}
const entry = (over: Partial<KnownDivergence> = {}): KnownDivergence => ({
  part: 'part1_1', sheet: 'p18', ref: 'B13', oracle: 5616, computed: 2808,
  reason: '원자료 개정', decided_by: '사용자', decided_on: '2026-09-11', ...over,
});

// ── 1. 차이가 그대로면 면제하고, 관문이 통과한다 ─────────────────────────────

test('면제: 확정본 값과 계산값이 둘 다 같으면 known-divergence 가 된다', () => {
  const { rows: out, stale } = applyKnownDivergences(rows(), [entry()]);
  assert.equal(out[0].verdict, 'known-divergence');
  assert.equal(out[0].reason, '원자료 개정');
  assert.deepEqual(stale, []);
  // 면제된 셀은 관문을 막지 않는다 (presentation 과 같은 취급)
  const s = summarize(out, stale.length);
  assert.equal(s.byVerdict['known-divergence'], 1);
  assert.equal(s.byVerdict.mismatch, undefined);
  assert.equal(s.gatePassed, true);
});

// ── 2·3. 값이 하나라도 다르면 면제하지 않는다 ────────────────────────────────

test('면제하지 않는다: 확정본 값이 적힌 값과 다르면 mismatch 로 남는다', () => {
  const { rows: out, stale } = applyKnownDivergences(rows(), [entry({ oracle: 9999 })]);
  assert.equal(out[0].verdict, 'mismatch');
  assert.equal(stale.length, 1);
  assert.match(stale[0].why, /확정본/);
  assert.equal(summarize(out, stale.length).gatePassed, false);
});

test('면제하지 않는다: 계산값이 적힌 값과 다르면 mismatch 로 남는다 (자료가 또 개정된 상황)', () => {
  const { rows: out, stale } = applyKnownDivergences(rows(), [entry({ computed: 1404 })]);
  assert.equal(out[0].verdict, 'mismatch');
  assert.equal(stale.length, 1);
  assert.match(stale[0].why, /계산값/);
  assert.equal(summarize(out, stale.length).gatePassed, false);
});

// ── 4. 묵은 면제는 관문을 실패시킨다 — 이 단위의 핵심 시험 ──────────────────

test('묵은 면제: 이제 일치하는 칸이 목록에 있으면 경고가 나오고 관문이 실패한다', () => {
  // 면제 항목이 가리키는 칸이 이제 match 다 — 목록이 묵었다는 뜻이다.
  const now = rows();
  now[0] = { part: 'part1_1', sheet: 'p18', ref: 'B13', verdict: 'match', expected: 2808, got: 2808 };
  const { rows: out, stale } = applyKnownDivergences(now, [entry()]);
  assert.equal(out[0].verdict, 'match');            // 판정을 되돌리지 않는다
  assert.equal(stale.length, 1);
  assert.match(stale[0].why, /match|일치/);
  // **관문이 실패해야 한다** — 면제가 조용히 쌓이는 것을 막는 장치다
  const s = summarize(out, stale.length);
  assert.equal(s.byVerdict.mismatch, undefined);
  assert.equal(s.byVerdict.error, undefined);
  assert.equal(s.byVerdict.unsupported, undefined);
  assert.equal(s.gatePassed, false, '묵은 면제가 관문을 실패시키지 않았다');
});

test('묵은 면제: 좌표 자체가 사라져도 관문이 실패한다', () => {
  const { stale } = applyKnownDivergences(rows(), [entry({ ref: 'Z99' })]);
  assert.equal(stale.length, 1);
  assert.match(stale[0].why, /없다/);
  assert.equal(summarize(rows(), stale.length).gatePassed, false);
});

// ── 5. 목록에 없는 불일치는 그대로 불일치다 ──────────────────────────────────

test('목록에 없는 mismatch 는 그대로 mismatch 이고 관문을 막는다', () => {
  const { rows: out, stale } = applyKnownDivergences(rows(), []);
  assert.equal(out[0].verdict, 'mismatch');
  assert.deepEqual(stale, []);
  assert.equal(summarize(out, 0).gatePassed, false);
});

test('면제는 mismatch 에만 적용된다 — error·unsupported 는 건드리지 않는다', () => {
  const bad: CellResult[] = [
    { part: 'part1_1', sheet: 'p18', ref: 'B13', verdict: 'error', expected: 5616, got: null, reason: 'x' },
  ];
  const { rows: out, stale } = applyKnownDivergences(bad, [entry()]);
  assert.equal(out[0].verdict, 'error');
  assert.equal(stale.length, 1);                    // 면제가 놀고 있다 → 묵은 것으로 본다
  assert.equal(summarize(out, stale.length).gatePassed, false);
});

// ── 6. 실제 면제 목록 파일 ───────────────────────────────────────────────────

test('data/known-divergences.json 은 세종 3칸을 담고, 값을 둘 다 적어 둔다', () => {
  const list = JSON.parse(
    readFileSync(join('data', 'known-divergences.json'), 'utf8')) as KnownDivergence[];
  assert.equal(list.length, 3);
  const key = (e: { part: string; sheet: string; ref: string }) => `${e.part}!${e.sheet}!${e.ref}`;
  assert.deepEqual(list.map(key).sort(),
    ['part1_1!p18!B13', 'part1_1!p18!C13', 'part1_9!p140!C14']);
  for (const e of list) {
    // 좌표만으로 면제하지 않는다 — 두 값이 반드시 있어야 한다
    assert.equal(typeof e.oracle, 'number', key(e));
    assert.equal(typeof e.computed, 'number', key(e));
    assert.equal(e.oracle, (e.computed as number) * 2, `${key(e)}: 인쇄본이 정확히 2배여야 한다`);
    assert.ok(e.reason && e.reason.length > 10, key(e));
    assert.equal(e.decided_by, '사용자', key(e));
    assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(e.decided_on), key(e));
  }
});

// 관문은 면제를 part 별로 먼저 적용한 뒤(진행 표시를 최종 판정과 맞추려고) 전체에
// 대해 묵음 검사를 한 번 더 돌린다. 그래서 적용이 **멱등**이어야 한다.
test('면제 적용은 멱등이다 — 두 번 돌려도 묵은 것으로 오판하지 않는다', () => {
  const first = applyKnownDivergences(rows(), [entry()]);
  assert.equal(first.rows[0].verdict, 'known-divergence');
  const second = applyKnownDivergences(first.rows, [entry()]);
  assert.equal(second.rows[0].verdict, 'known-divergence');
  assert.deepEqual(second.stale, []);
  assert.equal(summarize(second.rows, second.stale.length).gatePassed, true);
  // 값이 달라지면 두 번째에도 잡힌다
  const third = applyKnownDivergences(first.rows, [entry({ computed: 999 })]);
  assert.equal(third.stale.length, 1);
});
