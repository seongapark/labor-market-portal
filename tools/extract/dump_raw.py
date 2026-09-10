"""원천 4종 → data/raw/<src>/<sheet>.jsonl + data/raw/headers.json.
   헤더 이름으로 열을 해석한다. 열 문자를 위치로 고정하면 표마다 어긋난다."""
import argparse
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


def dump_source(src: str, path: str, out_root: str) -> dict:
    wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
    heads = {}
    outdir = os.path.join(out_root, 'raw', src)
    os.makedirs(outdir, exist_ok=True)
    for ws in wb.worksheets:
        rows = ws.iter_rows(values_only=True)
        try:
            first = next(rows)
        except StopIteration:
            continue
        header = [(str(c).strip() if c is not None else '') for c in first]
        while header and header[-1] == '':
            header.pop()
        if not header:
            continue
        heads[ws.title] = header
        with open(os.path.join(outdir, ws.title + '.jsonl'), 'w', encoding='utf-8') as fh:
            for row in rows:
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
        print('  %-8s %-28s %d열' % (src, ws.title, len(header)), flush=True)
    wb.close()
    return heads


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--only', action='append', choices=list(SOURCES),
                    help='이 원천만 덤프한다 (여러 번 줄 수 있다)')
    ap.add_argument('--out', default='data', help='산출 루트 (기본 data)')
    a = ap.parse_args()

    d = booklet_dir()
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
