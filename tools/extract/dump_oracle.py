"""확정본 13개 → data/oracle/<part>.json (좌표 → 값).
   비어있지 않은 모든 셀을 담는다. 정답표이면서 셀 참조를 푸는 격자로도 쓴다.
   read_only=True 로만 열고 save() 하지 않는다."""
import argparse
import json
import os
import sys
import openpyxl
from common import booklet_dir, final_workbooks, cell_text

# Windows 콘솔은 기본 cp949 — em dash(—) 등 출력에서 죽는다. UTF-8 로 강제.
if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')
    sys.stderr.reconfigure(encoding='utf-8')


def dump(path: str) -> dict:
    wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
    out = {}
    for ws in wb.worksheets:
        cells = {}
        for row in ws.iter_rows():
            for c in row:
                v = cell_text(c.value)
                if v is None or v == '':
                    continue
                cells[c.coordinate] = v
        if cells:
            out[ws.title] = cells
    wb.close()
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', default='data')
    a = ap.parse_args()
    d = booklet_dir()
    od = os.path.join(a.out, 'oracle')
    os.makedirs(od, exist_ok=True)
    for part, path in sorted(final_workbooks(d).items()):
        data = dump(path)
        json.dump(data, open(os.path.join(od, part + '.json'), 'w', encoding='utf-8'),
                  ensure_ascii=False)
        n = sum(len(v) for v in data.values())
        print('  %-20s 시트 %2d · 셀 %6d  (%s)' % (part, len(data), n, os.path.basename(path)))


if __name__ == '__main__':
    main()
