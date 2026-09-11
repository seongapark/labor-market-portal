/** Task 9 단위 11 (물화): 작업본 수식 덤프 → `data/cellmap/<part>.json`
 *
 * 사용자 요구의 마지막 조각이다 — 「수식 한번 따가고 나면 로컬에 참고파일 없이도 수치
 * 관리가 되도록」. 이 스크립트를 한 번 돌려 저장소에 넣으면, 그 다음부터 관문
 * (`npm run verify`)은 `data/formulas/` 도 `headers.json` 도 읽지 않는다.
 *
 * 전체 리뷰 F4 (2026-09-11): **이 서술은 단위 11 시점에 거짓이었다.** 물화물을 읽는 곳은
 * 시험과 `build-snapshot.ts` 뿐이었고, 출하 진입점인 `verify-all.ts` 는 계속 수식과
 * 헤더를 읽어 cellmap 을 매번 다시 만들었다. 지금은 관문의 **기본 경로가 cellmap** 이고
 * (`test/verify-all.test.ts` 가 열린 파일 목록으로 그것을 증명한다), 수식 경로는
 * `node scripts/verify-all.ts --from-formulas` 로 남아 두 경로를 계속 대조한다.
 *
 * 담는 것: 셀별 **질의 명세**(열 이름이 해석된 Expr). 다룰 수 없는 셀은 **사유와 함께**.
 * 담지 않는 것: 수식 문자열, 열 문자. 그것이 남으면 엑셀의 캐시일 뿐 대체물이 아니다.
 */
import { readFileSync, readdirSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { buildCellMap, type FormulaDump } from '../src/cellmap/build.ts';
import type { Headers } from '../src/types.ts';

const dataDir = 'data';
const outDir = join(dataDir, 'cellmap');
mkdirSync(outDir, { recursive: true });

const headers = JSON.parse(readFileSync(join(dataDir, 'raw', 'headers.json'), 'utf8')) as Headers;

let cells = 0;
const kinds: Record<string, number> = {};
let bytes = 0;
for (const f of readdirSync(join(dataDir, 'formulas'))) {
  if (!f.endsWith('.json')) continue;
  const part = basename(f, '.json');
  const formulas = JSON.parse(readFileSync(join(dataDir, 'formulas', f), 'utf8')) as FormulaDump;
  const map = buildCellMap(part, formulas, headers);
  for (const sheet of Object.values(map.sheets)) {
    for (const spec of Object.values(sheet)) {
      cells++;
      kinds[spec.kind] = (kinds[spec.kind] ?? 0) + 1;
    }
  }
  const out = join(outDir, f);
  // 들여쓰기 없이 쓴다 — 생성 산출물이고, 들여쓰기 1칸만 넣어도 21MB(두 배)가 된다.
  // 사람이 읽는 것은 layout.json 과 리포트이고, 이 파일은 실행기가 읽는다.
  writeFileSync(out, JSON.stringify(map) + '\n');
  const size = statSync(out).size;
  bytes += size;
  console.log(`  ${part.padEnd(20)} 시트 ${String(Object.keys(map.sheets).length).padStart(3)} · ` +
    `앵커수식 ${map.hasAnchor ? 'O' : 'X'} · ${(size / 1024).toFixed(0)}KB`);
}
console.log(`\n셀 ${cells}개 · ${JSON.stringify(kinds)} · 합계 ${(bytes / 1024 / 1024).toFixed(2)}MB`);
console.log('나온 곳: data/cellmap/<part>.json');
