/** 잎 247개를 분류한다. 관심사는 하나: **통계값인 잎이 있는가.**
 *  있으면 매 회차 사람이 그 수치를 입력해야 하고, 없으면 자동 갱신에 걸림돌이 없다. */
import { readFileSync } from 'node:fs';
const S = '';
const L = JSON.parse(readFileSync(process.env.IN ?? 'reports/literal-deps.json', 'utf8'));

const all = [];
for (const sh of L.sheets) for (const c of sh.cells) all.push({ page: sh.page, ...c });

const bucket = (x) => {
  const v = x.v;
  if (typeof v === 'string') return '문자 라벨 (SUMIFS 조건·범주명)';
  if (typeof v !== 'number') return '기타';
  if (Number.isInteger(v) && v >= 1960 && v <= 2100) return '연도 상수 (축 시작·앵커)';
  if (Number.isInteger(v) && Math.abs(v) <= 100) return '작은 정수 (열 간격·구간 폭)';
  return '**수치 — 통계값 후보**';
};

const groups = {};
for (const x of all) (groups[bucket(x)] = groups[bucket(x)] || []).push(x);

console.log('=== 잎 ' + all.length + '개 분류 ===');
for (const [k, v] of Object.entries(groups).sort((a, b) => b[1].length - a[1].length)) {
  const users = v.reduce((a, b) => a + b.users, 0);
  console.log('  ' + String(v.length).padStart(4) + '개  의존칸 ' + String(users).padStart(5) + '   ' + k);
}

const sus = groups['**수치 — 통계값 후보**'] || [];
console.log('');
console.log('=== 통계값 후보 ' + sus.length + '개 — 전수 ===');
for (const x of sus.sort((a, b) => b.users - a.users)) {
  console.log('  ' + (x.page + '!' + x.ref).padEnd(32) + String(x.users).padStart(5) + '칸  = ' + JSON.stringify(x.v));
}

// 연도 상수의 실제 값 분포 — 1970 이 축 시작인지 확인
console.log('');
console.log('=== 연도 상수의 값 분포 ===');
const yr = {};
for (const x of (groups['연도 상수 (축 시작·앵커)'] || [])) yr[x.v] = (yr[x.v] || 0) + 1;
for (const [v, n] of Object.entries(yr).sort((a, b) => +a[0] - +b[0])) console.log('  ' + v + ' : 잎 ' + n + '개');

// 작은 정수
console.log('');
console.log('=== 작은 정수 전수 ===');
for (const x of (groups['작은 정수 (열 간격·구간 폭)'] || []).sort((a, b) => b.users - a.users))
  console.log('  ' + (x.page + '!' + x.ref).padEnd(32) + String(x.users).padStart(5) + '칸  = ' + x.v);

// 문자 라벨 표본
console.log('');
console.log('=== 문자 라벨 표본 12개 ===');
for (const x of (groups['문자 라벨 (SUMIFS 조건·범주명)'] || []).sort((a, b) => b.users - a.users).slice(0, 12))
  console.log('  ' + (x.page + '!' + x.ref).padEnd(32) + String(x.users).padStart(5) + '칸  = ' + JSON.stringify(x.v).slice(0, 50));
