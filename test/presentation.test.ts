import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { specOf, buildCellMap, type FormulaDump } from '../src/cellmap/build.ts';
import type { Headers } from '../src/types.ts';

const headers = JSON.parse(readFileSync(join('data', 'raw', 'headers.json'), 'utf8')) as Headers;
const ctx = { extmap: { '1': '별도데이터.xlsx' }, headers };
const kindOf = (formula: string) => specOf(formula, ctx).kind;

// ── 전체 리뷰 F1 ────────────────────────────────────────────────────────────
// `presentation` 은 관문의 분모에서 **빠지는** 범주다(3,364칸). 그래서 그 판정이
// 「던져진 예외 메시지에 INDEX/MATCH/RANK 라는 글자가 있는가」로 갈리면, 전혀 다른
// 이유로 깨진 칸이 조용히 관문을 벗어난다. 판정은 **던진 자리**(표현 거부 표식)와
// **구조적 사실**(외부 통합문서 참조가 없다 — RULING 14)의 AND 여야 한다.

test('F1: 예외 메시지에 함수 이름이 섞여도 presentation 이 아니다 — 세 모양이 unsupported 로 남는다', () => {
  // 1) 수식이 깨져 남은 토큰이 있다 — 사유에 토큰 JSON 덤프(MATCH)가 꼬리로 붙는다
  assert.equal(kindOf('=A1 MATCH(B1,C1:C9,0)'), 'unsupported');
  // 2) 2차원 INDEX — 「구현하지 않았다」고 명시한 것이지 부록 서식이 아니다
  assert.equal(kindOf('=INDEX(A1:A9,MATCH(A1,B1:B9,0),2,3)'), 'unsupported');
  // 3) 근사 조회 MATCH. 같은 성격의 VLOOKUP(…,1) 은 이미 관문을 실패시킨다 —
  //    성격이 같은 두 거부가 정반대 대우를 받는 것이 F1 의 요점이었다.
  assert.equal(kindOf('=MATCH($A6,$A$6:$A$43,1)'), 'unsupported');
  assert.equal(kindOf('=VLOOKUP($A6,$A$6:$B$43,2,1)'), 'unsupported');
});

test('F1: 표현 거부는 두 자리뿐이다 — 시트 한정 INDEX/MATCH 범위와 RANK', () => {
  // OECD 부록의 정렬 로직: 범위가 보조시트·다른 지면을 가리킨다 (실측 3,584건)
  assert.equal(kindOf('=INDEX(_정렬기준!$A$3:$A$41,MATCH(A1,$B$1:$B$9,0))'), 'presentation');
  assert.equal(kindOf("=INDEX('p214'!$B$48:$B$60,MATCH($A48,'p214'!$A$48:$A$60,0))"), 'presentation');
  assert.equal(kindOf('=MATCH($A6,_13개국!$A$6:$A$43,0)'), 'presentation');
  // RANK — 같은 지면 안의 순위 표시 (실측 1,548건)
  assert.equal(kindOf('=RANK(A1,$A$1:$A$9)'), 'presentation');
});

test('F1: RULING 14 — 외부 통합문서를 참조하면 표현 거부라도 presentation 이 아니다', () => {
  // 표식은 붙지만(INDEX 범위가 _정렬기준) 수식이 원천 통합문서를 읽는다 → 부록 서식 칸이
  // 아니므로 관문에서 빼지 않는다. 이 구조 판정을 지우면 이 단정이 빨강이 된다.
  assert.equal(
    kindOf("=INDEX(_정렬기준!$A$3:$A$41,MATCH([1]LP!$A$1,$B$1:$B$9,0))"), 'unsupported');
});

test('F1: 전 수식 37,467개의 판정이 그대로다 — presentation 5,132 · unsupported 0', () => {
  const kinds: Record<string, number> = {};
  for (const f of readdirSync(join('data', 'formulas'))) {
    if (!f.endsWith('.json')) continue;
    const part = basename(f, '.json');
    const dump = JSON.parse(readFileSync(join('data', 'formulas', f), 'utf8')) as FormulaDump;
    for (const cells of Object.values(buildCellMap(part, dump, headers).sheets)) {
      for (const spec of Object.values(cells)) kinds[spec.kind] = (kinds[spec.kind] ?? 0) + 1;
    }
  }
  // 표식 판정으로 바꾸어도 이 숫자는 움직이지 않는다 — 오늘의 5,132건은 전부 위 두
  // 자리에서 나온 것이기 때문이다(실측: INDEX 시트한정 3,584 · RANK 1,548).
  assert.deepEqual(kinds, { expr: 32335, presentation: 5132 });
});
