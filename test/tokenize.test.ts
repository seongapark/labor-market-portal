import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tokenize } from '../src/cellmap/tokenize.ts';

test('외부참조를 인덱스·시트·범위로 쪼갠다', () => {
  const t = tokenize('=[1]DT_1DA7012S!$C:$C');
  assert.deepEqual(t, [{ t: 'ref', ext: 1, sheet: 'DT_1DA7012S', a1: '$C:$C' }]);
});

test('작은따옴표로 감싼 외부참조도 읽는다', () => {
  const t = tokenize("='[2]p78_81_국기'!$B:$B");
  assert.deepEqual(t, [{ t: 'ref', ext: 2, sheet: 'p78_81_국기', a1: '$B:$B' }]);
});

test('같은 시트 셀 참조는 ext·sheet 가 null 이다', () => {
  assert.deepEqual(tokenize('=$A14'), [{ t: 'ref', ext: null, sheet: null, a1: '$A14' }]);
  assert.deepEqual(tokenize('=C$6'), [{ t: 'ref', ext: null, sheet: null, a1: 'C$6' }]);
});

test('보조시트 참조는 sheet 만 채운다', () => {
  assert.deepEqual(tokenize('=_정렬기준!$A$3'),
    [{ t: 'ref', ext: null, sheet: '_정렬기준', a1: '$A$3' }]);
});

test('SUMIFS 전체를 토큰으로 쪼갠다', () => {
  const t = tokenize('=SUMIFS([1]A!$C:$C,[1]A!$H:$H,TEXT(C$6,"0"),[1]A!$I:$I,"계")');
  assert.equal(t[0].t, 'fn');
  assert.equal((t[0] as { v: string }).v, 'SUMIFS');
  assert.equal(t[1].t, 'lp');
  assert.ok(t.some((x) => x.t === 'str' && x.v === '계'));
  assert.ok(t.some((x) => x.t === 'fn' && x.v === 'TEXT'));
  // 실제로는 콤마가 5개다: SUMIFS 인자 사이 4개 + TEXT(C$6,"0") 내부 1개.
  // 토크나이저는 괄호 깊이를 모르는 평면 렉서이므로 전부 comma 토큰이 된다.
  assert.equal(t.filter((x) => x.t === 'comma').length, 5);
});

test('숫자·연산자·퍼센트를 구분한다', () => {
  const t = tokenize('=M8/(1+2)%');
  assert.deepEqual(t.map((x) => x.t), ['ref', 'op', 'lp', 'num', 'op', 'num', 'rp', 'op']);
  assert.equal((t[7] as { v: string }).v, '%');
});

test('_xlfn 접두사를 벗긴다', () => {
  const t = tokenize('=_xlfn.NUMBERVALUE(1)');
  assert.equal((t[0] as { v: string }).v, 'NUMBERVALUE');
});

test('문자열 안의 쉼표·괄호는 토큰이 되지 않는다', () => {
  const t = tokenize('=SUMIFS(A!$B:$B,A!$C:$C,"30 - 39세, (계)")');
  assert.equal(t.filter((x) => x.t === 'comma').length, 2);
  assert.ok(t.some((x) => x.t === 'str' && x.v === '30 - 39세, (계)'));
});

// Step 5 전건 대조에서 발견: 소문자로 시작하는 시트명의 같은 통합문서 참조.
// 예: data/formulas/part1_7.json 의 p116_117!C30 =
// SUMIFS([1]p116_117!C:C,[1]p116_117!$P:$P,p116_117!$B30,[1]p116_117!$A:$A,$A30)
test('소문자로 시작하는 시트명도 같은 통합문서 참조로 읽는다', () => {
  assert.deepEqual(tokenize('=p116_117!$B30'),
    [{ t: 'ref', ext: null, sheet: 'p116_117', a1: '$B30' }]);
  assert.deepEqual(tokenize('=p122_123!$B$25:$H$42'),
    [{ t: 'ref', ext: null, sheet: 'p122_123', a1: '$B$25:$H$42' }]);
});
