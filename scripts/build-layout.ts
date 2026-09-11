/** Task 9 단위 11 (물화): 지면 구조 → `data/layout.json`
 *
 * **읽되 믿지 않는다.** 2026-09-11 실측 규약: `A1` 지면 제목 · `A2` 출처 기관(195개 중
 * 177개) · `C2` 출처 통계표명(144개). 그런데 18개 지면은 `A2` 가 없고, 3개는 `A2` 가
 * `기준년도 -1`(출처가 아니다), 일부는 `A2` 에 기관 대신 표명이 들어 있다.
 *
 * 그래서 이 파일은 **「그 칸이 무엇을 담고 있는가」만 적는다** — `a1`·`a2`·`c2` 라는
 * 중립적인 이름으로. 「이것이 출처 기관이다」라고 단정하지 않는다. 없는 칸은 `null` 이고
 * 추정으로 채우지 않는다: 빈칸이 틀린 값보다 낫다(목업 단계에서 어림짐작이 결함 5건을
 * 만들었고, 그때 적어둔 원칙이 「원본이 명시하는 것만 읽는다」다).
 *
 * 원천: `data/oracle/` — 확정본의 **비어 있지 않은 모든 칸**이다. 원본 엑셀은 열지 않는다
 * (금지 사항). 확정본은 곧 인쇄된 지면이므로 제목·출처 문자 칸의 원천으로 맞다.
 */
import { readFileSync, readdirSync, writeFileSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';

type OracleDump = Record<string, Record<string, string | number>>;

/** 문자 칸만 읽는다. 숫자·빈칸·공백만 있는 칸은 `null` 이다 — 추정하지 않는다. */
function textCell(cells: Record<string, string | number>, ref: string): string | null {
  const v = cells[ref];
  return typeof v === 'string' && v.trim() !== '' ? v : null;
}

const dataDir = 'data';
const pages: { part: string; sheet: string; a1: string | null; a2: string | null; c2: string | null }[] = [];

for (const f of readdirSync(join(dataDir, 'oracle'))) {
  if (!f.endsWith('.json')) continue;
  const part = basename(f, '.json');
  const oracle = JSON.parse(readFileSync(join(dataDir, 'oracle', f), 'utf8')) as OracleDump;
  for (const [sheet, cells] of Object.entries(oracle)) {
    if (sheet.startsWith('_')) continue;        // 보조시트는 지면이 아니다
    pages.push({
      part, sheet,
      a1: textCell(cells, 'A1'),
      a2: textCell(cells, 'A2'),
      c2: textCell(cells, 'C2'),
    });
  }
}

const out = {
  convention:
    '실측 규약(2026-09-11): A1=지면 제목 · A2=출처 기관 · C2=출처 통계표명. ' +
    '다만 A2 는 195개 지면 중 177개에만 있고(18개 없음), 3개는 "기준년도 -1" 처럼 출처가 ' +
    '아닌 값이며 일부는 기관 대신 표명이 들어 있다. 그래서 이 파일은 "그 칸이 담은 문자" 만 ' +
    '적고 뜻을 단정하지 않는다. 없는 칸은 null 이고 추정값을 넣지 않았다 — 읽는 쪽이 판단한다.',
  source: 'data/oracle/*.json (확정본의 문자 칸). 원본 엑셀은 열지 않았다.',
  counts: {
    pages: pages.length,
    a1: pages.filter((p) => p.a1 !== null).length,
    a2: pages.filter((p) => p.a2 !== null).length,
    c2: pages.filter((p) => p.c2 !== null).length,
  },
  pages,
};

const file = join(dataDir, 'layout.json');
writeFileSync(file, JSON.stringify(out, null, 1) + '\n');
console.log('지면 %d · A1 %d · A2 %d · C2 %d · %dKB',
  out.counts.pages, out.counts.a1, out.counts.a2, out.counts.c2, Math.round(statSync(file).size / 1024));
console.log('나온 곳:', file);
