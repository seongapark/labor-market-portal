"""원천 4종 → data/raw/<src>/<sheet>.jsonl + data/raw/headers.json.
   헤더 이름으로 열을 해석한다. 열 문자를 위치로 고정하면 표마다 어긋난다."""
import argparse
import itertools
import json
import os
import sys
import openpyxl
from common import booklet_dir, SOURCES, cell_text

# Windows 콘솔은 기본 cp949 — em dash(—) 등 출력에서 죽는다. UTF-8 로 강제.
if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')
    sys.stderr.reconfigure(encoding='utf-8')

# PRD_DE 는 반드시 문자열로 남긴다 (반기 6자리 · 연간인데 6자리인 표가 있다)
FORCE_TEXT = {'PRD_DE', 'ITM_ID', 'C1', 'C2', 'C3', 'C4'}

MAX_HEADER_SCAN = 10  # 헤더 행을 찾기 위해 훑는 최대 행 수


def _non_empty(cell) -> bool:
    if cell is None:
        return False
    if isinstance(cell, str):
        return cell.strip() != ''
    return True


def find_header(rows):
    """처음 MAX_HEADER_SCAN 행 중, 비어있지 않은 셀이 2개 이상인 첫 행을 헤더로 본다.
       (셀이 1개뿐인 행은 제목행이지 헤더가 아니다 — 그래서 걸러진다.)
       반환: (header 목록|None, 1-based 헤더 행 번호|None, 헤더 다음부터 이어지는 이터레이터)."""
    buffered = []
    header_idx = None
    for i in range(MAX_HEADER_SCAN):
        try:
            row = next(rows)
        except StopIteration:
            break
        buffered.append(row)
        if sum(1 for c in row if _non_empty(c)) >= 2:
            header_idx = i
            break
    if header_idx is None:
        return None, None, itertools.chain(buffered, rows)
    raw = buffered[header_idx]
    header = [(str(c).strip() if c is not None else '') for c in raw]
    while header and header[-1] == '':
        header.pop()
    rest = itertools.chain(buffered[header_idx + 1:], rows)
    return header, header_idx + 1, rest


def dump_grid(src: str, path: str, out_root: str) -> None:
    """시트를 헤더 해석 없이 좌표 그대로 덤프한다. 별도데이터·패널처럼 헤더 자체가
       표 헤더가 아닌 시트(블록 여러 개, 검색조건 안내문, 값 레이블 등)를 위한 경로다.
       비어있지 않은 셀마다 {r, c, v} 한 줄(1-based). 제목행도 포함해 그대로 남긴다."""
    wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
    outdir = os.path.join(out_root, 'raw', 'grid', src)
    os.makedirs(outdir, exist_ok=True)
    for ws in wb.worksheets:
        n = 0
        with open(os.path.join(outdir, ws.title + '.jsonl'), 'w', encoding='utf-8') as fh:
            for r, row in enumerate(ws.iter_rows(values_only=True), start=1):
                for c, cell in enumerate(row, start=1):
                    v = cell_text(cell)
                    if v is None:
                        continue
                    fh.write(json.dumps({'r': r, 'c': c, 'v': v}, ensure_ascii=False) + '\n')
                    n += 1
        print('  grid %-8s %-28s %d셀' % (src, ws.title, n), flush=True)
    wb.close()


def dump_source(src: str, path: str, out_root: str) -> dict:
    wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
    heads = {}
    header_rows = {}
    skipped = []
    outdir = os.path.join(out_root, 'raw', src)
    os.makedirs(outdir, exist_ok=True)
    for ws in wb.worksheets:
        rows = ws.iter_rows(values_only=True)
        header, header_no, data_rows = find_header(rows)
        if header is None:
            skipped.append(ws.title)
            print('SKIP %s/%s — 헤더 행 없음' % (src, ws.title), flush=True)
            continue
        heads[ws.title] = header
        header_rows[ws.title] = header_no
        with open(os.path.join(outdir, ws.title + '.jsonl'), 'w', encoding='utf-8') as fh:
            for row in data_rows:
                if row is None or all(c is None for c in row):
                    continue
                rec = {}
                for i, name in enumerate(header):
                    if not name:
                        continue
                    v = cell_text(row[i] if i < len(row) else None)
                    if v is not None and name in FORCE_TEXT:
                        v = str(v)
                    rec[name] = v
                fh.write(json.dumps(rec, ensure_ascii=False) + '\n')
        print('  %-8s %-28s %d열 (헤더 %d행)' % (src, ws.title, len(header), header_no), flush=True)
    wb.close()
    heads['_header_row'] = header_rows
    heads['_skipped'] = skipped
    return heads


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--only', action='append', choices=list(SOURCES),
                    help='이 원천만 덤프한다 (여러 번 줄 수 있다)')
    ap.add_argument('--out', default='data', help='산출 루트 (기본 data)')
    ap.add_argument('--grid', choices=list(SOURCES),
                    help='그리드 모드: 헤더 해석 없이 좌표 그대로 이 원천 하나를 덤프한다'
                         ' (data/raw/grid/<src>/<sheet>.jsonl)')
    a = ap.parse_args()

    d = booklet_dir()

    if a.grid:
        p = os.path.join(d, SOURCES[a.grid])
        if not os.path.exists(p):
            raise SystemExit('건너뜀 — 파일 없음: %s' % p)
        dump_grid(a.grid, p, a.out)
        return

    want = a.only or list(SOURCES)
    all_heads = {}
    for src in want:
        p = os.path.join(d, SOURCES[src])
        if not os.path.exists(p):
            print('건너뜀 — 파일 없음: %s' % p)
            continue
        all_heads[src] = dump_source(src, p, a.out)

    os.makedirs(os.path.join(a.out, 'raw'), exist_ok=True)
    hp = os.path.join(a.out, 'raw', 'headers.json')
    prev = {}
    if os.path.exists(hp):
        prev = json.load(open(hp, encoding='utf-8'))
    prev.update(all_heads)
    json.dump(prev, open(hp, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    print('headers.json 기록 — 원천 %d종' % len(prev))


if __name__ == '__main__':
    main()
