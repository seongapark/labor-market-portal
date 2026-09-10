import type { DatabaseSync } from 'node:sqlite';
import { parseFormula } from '../cellmap/parse.ts';
import { execute } from '../query/execute.ts';
import type { Grid, Headers } from '../types.ts';

export type Verdict = 'match' | 'mismatch' | 'unsupported' | 'no-oracle' | 'error';

export type CellResult = {
  part: string; sheet: string; ref: string;
  verdict: Verdict;
  expected: number | string | null;
  got: number | string | null;
  reason?: string;
};

export type FormulaDump = {
  extmap: Record<string, string>;
  sheets: Record<string, Record<string, string>>;
};
export type OracleDump = Record<string, Record<string, string | number>>;

const REL = 1e-9;

export function sameValue(a: unknown, b: unknown): boolean {
  if (typeof a === 'string' || typeof b === 'string') return String(a) === String(b);
  if (a === null || b === null || a === undefined || b === undefined) return a === b;
  const x = Number(a), y = Number(b);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  const scale = Math.max(Math.abs(x), Math.abs(y), 1);
  return Math.abs(x - y) <= REL * scale;
}

export function verifyPart(
  part: string,
  formulas: FormulaDump,
  oracle: OracleDump,
  db: DatabaseSync,
  headers: Headers,
  year: string,
): CellResult[] {
  const out: CellResult[] = [];
  const ctx = { extmap: formulas.extmap, headers };

  // RULING 8: 실행기에는 파트 전체의 격자(시트명 → Grid)를 넘긴다. booklet 페이지 간
  // 셀 참조('p68'!$F$5, 2,616건)와 보조시트(_시계열, 2,092건) 참조가 실측으로 나와,
  // 단일 시트의 grid 로는 풀 수 없다. oracle 자체가 이미 { 시트명 → { 셀 → 값 } } 모양이라
  // 그대로 grids 로 넘긴다 — 보조시트도 참조 대상으로는 남기고, 대조 지면으로만 건너뛴다.
  const grids: Record<string, Grid> = oracle;

  for (const [sheet, cells] of Object.entries(formulas.sheets)) {
    if (sheet.startsWith('_')) continue;        // 보조시트는 지면이 아니다
    const grid: Grid = (oracle[sheet] ?? {}) as Grid;

    for (const [ref, formula] of Object.entries(cells)) {
      const expected = Object.prototype.hasOwnProperty.call(grid, ref)
        ? (grid[ref] as number | string) : null;
      if (expected === null) {
        out.push({ part, sheet, ref, verdict: 'no-oracle', expected: null, got: null });
        continue;
      }
      const e = parseFormula(formula, ctx);
      if (e.op === 'unsupported') {
        out.push({ part, sheet, ref, verdict: 'unsupported', expected, got: null, reason: e.reason });
        continue;
      }
      let got: number | string | null = null;
      try {
        got = execute(e, { db, grids, sheet, year });
      } catch (err) {
        out.push({ part, sheet, ref, verdict: 'error', expected, got: null,
                   reason: (err as Error).message });
        continue;
      }
      out.push({ part, sheet, ref, expected, got,
                 verdict: sameValue(expected, got) ? 'match' : 'mismatch' });
    }
  }
  return out;
}
