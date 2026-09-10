"""작업본 13개 → data/formulas/<part>.json.
   { extmap: {인덱스: 파일명}, sheets: {시트: {좌표: 수식}} }
   외부링크 인덱스는 파일마다 가리키는 대상이 다르므로 반드시 함께 담는다."""
import argparse
import json
import os
import re
import sys
import zipfile
import openpyxl
from common import booklet_dir, work_workbooks

# Windows 콘솔은 기본 cp949 — em dash(—) 등 출력에서 죽는다. UTF-8 로 강제.
if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')
    sys.stderr.reconfigure(encoding='utf-8')


def ext_map(path: str) -> dict:
    """workbook.xml 의 externalReferences 순서 + rels 로 인덱스 → 파일명."""
    with zipfile.ZipFile(path) as z:
        wbx = z.read('xl/workbook.xml').decode('utf-8', 'replace')
        rels = z.read('xl/_rels/workbook.xml.rels').decode('utf-8', 'replace')
        order = re.findall(r'<externalReference[^>]*r:id="([^"]+)"', wbx)
        rid2t = dict(re.findall(r'Id="([^"]+)"[^>]*Target="([^"]+)"', rels))
        out = {}
        for i, rid in enumerate(order, 1):
            t = rid2t.get(rid, '')
            if 'externalLink' in t:
                rp = 'xl/externalLinks/_rels/%s.rels' % os.path.basename(t)
                if rp in z.namelist():
                    m = re.search(r'Target="([^"]+)"',
                                  z.read(rp).decode('utf-8', 'replace'))
                    if m:
                        t = m.group(1)
            out[str(i)] = os.path.basename(t.replace('%20', ' '))
        return out


def dump(path: str) -> dict:
    wb = openpyxl.load_workbook(path, read_only=True, data_only=False)
    sheets = {}
    for ws in wb.worksheets:
        cells = {}
        for row in ws.iter_rows():
            for c in row:
                v = c.value
                if isinstance(v, str) and v.startswith('='):
                    cells[c.coordinate] = v
        if cells:
            sheets[ws.title] = cells
    wb.close()
    return {'extmap': ext_map(path), 'sheets': sheets}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', default='data')
    a = ap.parse_args()
    d = booklet_dir()
    od = os.path.join(a.out, 'formulas')
    os.makedirs(od, exist_ok=True)
    total = 0
    for part, path in sorted(work_workbooks(d).items()):
        data = dump(path)
        json.dump(data, open(os.path.join(od, part + '.json'), 'w', encoding='utf-8'),
                  ensure_ascii=False)
        n = sum(len(v) for v in data['sheets'].values())
        total += n
        print('  %-20s 수식 %6d · extmap %s' % (part, n, data['extmap']))
    print('수식 합계 %d' % total)


if __name__ == '__main__':
    main()
