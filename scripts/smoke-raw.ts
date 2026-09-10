/** 실물 덤프에 알려진 값이 있는지 본다. 합성 픽스처 테스트가 못 잡는 것을 잡는다. */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const RAW = join('data', 'raw');

function rows(src: string, sheet: string): Record<string, unknown>[] {
  const p = join(RAW, src, sheet + '.jsonl');
  if (!existsSync(p)) throw new Error('덤프가 없다: ' + p);
  return readFileSync(p, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
}

const checks: [string, () => boolean, string][] = [
  ['KOSIS DT_1DA7012S 2008 15세이상인구 계/계 = 39775.4',
    () => rows('kosis', 'DT_1DA7012S').some(
      (r) => r.PRD_DE === '2008' && r.ITM_NM === '15세이상인구' &&
             r.C1_NM === '계' && r.C2_NM === '계' && r.DT === 39775.4),
    'p40·p42 의 기준점이다'],
  ['KOSIS 시트 수 107 (0_수집현황 제외)',
    () => {
      const h = JSON.parse(readFileSync(join(RAW, 'headers.json'), 'utf8'));
      return Object.keys(h.kosis).filter((k) => !k.startsWith('0_')).length === 107;
    },
    '표가 빠지면 지면이 통째로 0 이 된다'],
  ['헤더에 C4_NM 을 쓰는 시트가 1개 있다',
    () => {
      const h = JSON.parse(readFileSync(join(RAW, 'headers.json'), 'utf8'));
      return Object.values(h.kosis as Record<string, string[]>)
        .filter((cols) => cols.includes('C4_NM')).length === 1;
    },
    '스키마가 c4 까지 필요한 근거'],
  ['OECD LFS 행 수가 30000 이상',
    () => rows('oecd', 'LFS').length >= 30000, 'part3 부록 27쪽의 원천이다'],
  ['별도데이터 p239_240 이 있다',
    () => rows('etc', 'p239_240').length > 0, '노동생산성 2쪽의 원천이다'],
];

let bad = 0;
for (const [name, fn, why] of checks) {
  let ok = false;
  try { ok = fn(); } catch (e) { ok = false; }
  if (!ok) bad++;
  console.log('%s %s%s', ok ? 'OK  ' : 'FAIL', name, ok ? '' : '  ← ' + why);
}
console.log(bad ? `\n실패 ${bad}건` : '\n전부 통과');
process.exit(bad ? 1 : 0);
