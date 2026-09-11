import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { buildCellMap } from '../src/cellmap/build.ts';
import { verifyPart, verifyCellMap, applyKnownDivergences,
         type CellResult, type FormulaDump, type OracleDump, type KnownDivergence } from '../src/verify/compare.ts';
import { summarize } from '../scripts/verify-all.ts';
import type { CellMap, Headers } from '../src/types.ts';

const headers = JSON.parse(readFileSync(join('data', 'raw', 'headers.json'), 'utf8')) as Headers;
const db = new DatabaseSync(join('data', 'obs.sqlite'), { readOnly: true });
const parts = readdirSync(join('data', 'formulas')).filter((f) => f.endsWith('.json'))
  .map((f) => basename(f, '.json'));
const F = (p: string) => JSON.parse(readFileSync(join('data', 'formulas', `${p}.json`), 'utf8')) as FormulaDump;
const O = (p: string) => JSON.parse(readFileSync(join('data', 'oracle', `${p}.json`), 'utf8')) as OracleDump;
const M = (p: string) => JSON.parse(readFileSync(join('data', 'cellmap', `${p}.json`), 'utf8')) as CellMap;
const known = JSON.parse(
  readFileSync(join('data', 'known-divergences.json'), 'utf8')) as KnownDivergence[];

// ── 1. cellmap 이 수식 전부를 담는다 ─────────────────────────────────────────

test('cellmap: 37,467개 수식 좌표를 전부 담는다 (unsupported·presentation 포함)', () => {
  let specs = 0, formulas = 0;
  const kinds: Record<string, number> = {};
  for (const p of parts) {
    const f = F(p), m = M(p);
    for (const [sheet, cells] of Object.entries(f.sheets)) {
      formulas += Object.keys(cells).length;
      for (const ref of Object.keys(cells)) {
        const spec = m.sheets[sheet]?.[ref];
        assert.ok(spec, `cellmap 에 ${p}!${sheet}!${ref} 가 없다`);
        specs++;
        kinds[spec.kind] = (kinds[spec.kind] ?? 0) + 1;
      }
    }
  }
  assert.equal(formulas, 37467);
  assert.equal(specs, 37467);
  // 사유를 지닌 셀도 담긴다 — 빠뜨리면 다음 회차가 「왜 없나」를 다시 조사한다.
  // 실측: expr 32,335 · presentation 5,132 · unsupported 0. 단위 8b 이후 파싱 실패는
  // 전부 「같은통합문서 INDEX/MATCH/RANK 정렬」이라 presentation 으로 갈린다
  // (관문에서 세는 3,364 는 그 중 **대조 지면**의 것이고, 나머지는 보조시트·값없음 칸이다).
  assert.deepEqual(kinds, { expr: 32335, presentation: 5132 });
  // 모든 비-expr 명세에 사유가 남아 있다
  for (const p of parts) {
    for (const [sheet, cells] of Object.entries(M(p).sheets)) {
      for (const [ref, spec] of Object.entries(cells)) {
        if (spec.kind === 'expr') continue;
        assert.ok(spec.reason && spec.reason.length > 3, `${p}!${sheet}!${ref} 에 사유가 없다`);
      }
    }
  }
});

test('cellmap: 수식 문자열도 열 문자도 남기지 않는다 (캐시가 아니라 대체물이다)', () => {
  for (const p of parts) {
    const raw = readFileSync(join('data', 'cellmap', `${p}.json`), 'utf8');
    assert.equal(/"formula"/.test(raw), false, `${p}: 수식 문자열이 남아 있다`);
    // SUMIFS 명세의 조건 열은 **이름**으로 해석돼 있어야 한다 ($C:$C 같은 열 문자 금지)
    const m = M(p);
    for (const cells of Object.values(m.sheets)) {
      for (const spec of Object.values(cells)) {
        if (spec.kind !== 'expr') continue;
        const s = JSON.stringify(spec.e);
        assert.equal(/\$[A-Z]{1,3}:\$?[A-Z]{1,3}/.test(s), false, `${p}: 열 문자 범위가 남아 있다: ${s.slice(0, 120)}`);
      }
    }
  }
});

test('cellmap: 파일이 최신이다 — 수식에서 다시 만든 것과 같다', () => {
  for (const p of parts) {
    assert.deepEqual(M(p), buildCellMap(p, F(p), headers), `${p}: cellmap 이 낡았다 (npm run build:cellmap)`);
  }
});

// ── 2. 왕복: cellmap 경로 == 수식 경로 (셀 단위) ────────────────────────────

test('왕복: cellmap 으로 돌린 대조 결과가 수식으로 돌린 것과 셀 단위로 같다', () => {
  for (const p of parts) {
    const oracle = O(p);
    const viaFormula = verifyPart(p, F(p), oracle, db, headers, '2025');
    const viaCellmap = verifyCellMap(p, M(p), oracle, db, 2025);
    assert.deepEqual(viaCellmap, viaFormula, `${p}: 두 경로의 결과가 다르다`);
  }
});

// ── 3. 수식 파일 없이 관문이 통과한다 ───────────────────────────────────────

test('cellmap 만으로 관문이 통과한다 — data/formulas 도 headers 도 읽지 않는다', () => {
  const rows: CellResult[] = [];
  for (const p of parts) {
    // 오직 cellmap + 확정본 + DB 만 쓴다
    rows.push(...applyKnownDivergences(
      verifyCellMap(p, M(p), O(p), db, 2025), known.filter((k) => k.part === p)).rows);
  }
  const stale = applyKnownDivergences(rows, known).stale;
  const s = summarize(rows, stale.length);
  assert.equal(s.byVerdict.mismatch ?? 0, 0);
  assert.equal(s.byVerdict.error ?? 0, 0);
  assert.equal(s.byVerdict.unsupported ?? 0, 0);
  assert.equal(s.byVerdict.presentation, 3364);
  assert.equal(s.byVerdict['known-divergence'], 3);
  assert.equal(s.byVerdict.match, 29558);
  assert.equal(s.comparable, 29561);
  assert.equal(stale.length, 0);
  assert.equal(s.gatePassed, true, 'cellmap 만으로는 관문이 통과하지 않는다');
});

test('cellmap 이 앵커 사슬도 담는다 — 2026 으로 돌리면 연도가 따라 움직인다', () => {
  // 물화가 값만 얼려 담은 것이면 앵커를 옮겨도 꿈쩍하지 않는다. 명세여야 움직인다.
  const p = 'part1_1';
  const a25 = verifyCellMap(p, M(p), O(p), db, 2025);
  const a26 = verifyCellMap(p, M(p), O(p), db, 2026);
  const diff = a25.filter((r, i) => JSON.stringify(r.got) !== JSON.stringify(a26[i].got));
  assert.ok(diff.length > 100, `앵커를 옮겨도 바뀌는 칸이 ${diff.length}개뿐이다 — 값을 얼려담은 것이다`);
});

// ── 4. layout.json — 읽히는 것만 담고, 추정하지 않는다 ─────────────────────

test('layout: A1 195 · A2 177 · C2 144 이고, 없는 칸은 빈칸으로 남는다', () => {
  const layout = JSON.parse(readFileSync(join('data', 'layout.json'), 'utf8')) as {
    convention: string;
    pages: { part: string; sheet: string; a1: string | null; a2: string | null; c2: string | null }[];
  };
  assert.equal(layout.pages.length, 195);
  const count = (k: 'a1' | 'a2' | 'c2') => layout.pages.filter((p) => p[k] !== null).length;
  assert.equal(count('a1'), 195);
  assert.equal(count('a2'), 177);
  assert.equal(count('c2'), 144);
  // 없는 칸은 null 이다 — 빈 문자열이나 추정값이 들어가면 안 된다
  for (const p of layout.pages) {
    for (const k of ['a1', 'a2', 'c2'] as const) {
      const v = p[k];
      assert.ok(v === null || (typeof v === 'string' && v.trim() !== ''),
        `${p.part}!${p.sheet}.${k} 가 빈 문자열이다 — null 이어야 한다`);
    }
  }
  // 확정본에 있는 값과 한 글자도 다르지 않다 (추정이 섞이지 않았다는 확인)
  for (const p of layout.pages) {
    const cells = O(p.part)[p.sheet];
    for (const [k, ref] of [['a1', 'A1'], ['a2', 'A2'], ['c2', 'C2']] as const) {
      const raw = cells[ref];
      const want = typeof raw === 'string' && raw.trim() !== '' ? raw : null;
      assert.equal(p[k], want, `${p.part}!${p.sheet}.${k}`);
    }
  }
  assert.match(layout.convention, /A1|A2|C2/);
});

// ── 5. gate-snapshot.json ───────────────────────────────────────────────────

test('gate-snapshot: 앵커·커밋·시각과 대조 대상 전부의 계산값을 담는다', () => {
  const snap = JSON.parse(readFileSync(join('data', 'gate-snapshot.json'), 'utf8')) as {
    anchor: number; commit: string; generated_at: string;
    counts: Record<string, number>;
    values: Record<string, number | string | null>;
  };
  assert.equal(snap.anchor, 2025);
  assert.match(snap.commit, /^[0-9a-f]{7,40}$/);
  assert.match(snap.generated_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(Object.keys(snap.values).length, 29561);   // 관문의 대조 대상 수
  assert.equal(snap.counts.match, 29558);
  assert.equal(snap.counts['known-divergence'], 3);
  // 세종 3칸이 「그때 우리가 계산한 값」과 함께 남아 있어야 한다 —
  // 나중에 값이 달라지면 번역 회귀인지 자료 개정인지 이것으로 가린다.
  assert.equal(snap.values['part1_1!p18!B13'], 2808);
  assert.equal(snap.values['part1_9!p140!C14'], -47);
});

// 전체 리뷰 F11: 스냅샷이 **자료 쪽 지문**도 담는다. obs.sqlite 와 data/raw 는 추적되지
// 않으므로, 이것이 없으면 값이 달라졌을 때 「번역 회귀」와 「자료 개정」을 구별할 수 없다.
// (지금 DB 와 같은지 단정하지 않는다 — 재수집으로 달라지는 것이 **정보**이고, 값이
// 달라졌는지는 바로 위 드리프트 시험이 잡는다. 여기서는 지문이 실제로 담겨 있고
// 자기 자신과 앞뒤가 맞는지를 본다.)
test('gate-snapshot: 자료 판본 지문(표별 행 수·최대 시점)을 담는다', () => {
  const snap = JSON.parse(readFileSync(join('data', 'gate-snapshot.json'), 'utf8')) as {
    data?: {
      rows: { obs: number; oecd_obs: number; grid: number };
      kosis: Record<string, { rows: number; max_period: string | null }>;
      oecd: Record<string, { rows: number; max_period: string | null }>;
      grid: Record<string, { rows: number; sheets: number }>;
    };
  };
  const d = snap.data;
  assert.ok(d, '스냅샷에 자료 지문(data)이 없다 — npm run build:snapshot');
  // 세 테이블 전부 비어 있지 않다
  assert.ok(d.rows.obs > 0 && d.rows.oecd_obs > 0 && d.rows.grid > 0, JSON.stringify(d.rows));
  // 표별 행 수의 합이 테이블 행 수와 같다 — 지문이 일부만 담기면 어긋난다
  const sum = (o: Record<string, { rows: number }>) =>
    Object.values(o).reduce((a, b) => a + b.rows, 0);
  assert.equal(sum(d.kosis), d.rows.obs);
  assert.equal(sum(d.oecd), d.rows.oecd_obs);
  assert.equal(sum(d.grid), d.rows.grid);
  // 최대 시점이 표마다 적혀 있다(연도 4자리 또는 연월 6자리)
  for (const [t, v] of [...Object.entries(d.kosis), ...Object.entries(d.oecd)]) {
    assert.match(String(v.max_period), /^\d{4}(\d{2})?$/, `${t} 의 최대 시점이 없다`);
  }
});

test('gate-snapshot 은 지금 계산값과 같다 — 다르면 회귀이거나 자료가 개정된 것이다', () => {
  const snap = JSON.parse(readFileSync(join('data', 'gate-snapshot.json'), 'utf8')) as {
    values: Record<string, number | string | null>;
  };
  const drift: string[] = [];
  for (const p of parts) {
    for (const r of verifyCellMap(p, M(p), O(p), db, 2025)) {
      const key = `${r.part}!${r.sheet}!${r.ref}`;
      if (!(key in snap.values)) continue;
      if (JSON.stringify(snap.values[key]) !== JSON.stringify(r.got)) {
        drift.push(`${key}: 스냅샷 ${JSON.stringify(snap.values[key])} / 지금 ${JSON.stringify(r.got)}`);
      }
    }
  }
  assert.deepEqual(drift.slice(0, 10), []);
});

test('물화 산출물 3개가 저장소에 있다', () => {
  assert.ok(existsSync(join('data', 'layout.json')));
  assert.ok(existsSync(join('data', 'gate-snapshot.json')));
  for (const p of parts) assert.ok(existsSync(join('data', 'cellmap', `${p}.json`)), p);
});
