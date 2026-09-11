"""작업본 통합문서의 **차트 정의**를 뽑는다 → data/charts.json

왜 이것이 필요한가:
    목업 단계에서 나는 표 모양을 보고 차트 종류를 **추론**했고, 그 추론이 결함 5건을
    만들었다(p8 헤더 오인·p144 2단 구조 오판·p42 선을 막대로·p155 범례 중복·p195 도넛).
    그런데 통합문서 안에는 차트가 **선언**돼 있다 — 종류·계열·범위·축이 전부 xml 에 있다.
    실측: 13개 작업본에 barChart 211 · lineChart 124 · radarChart 11 · areaChart 3 ·
    doughnutChart 2 · pieChart 1. `p40` 이 pieChart 라고 엑셀이 직접 말한다.
    추론할 것이 없다. **원본이 명시하는 것만 읽는다.**

안전:
    openpyxl 을 쓰지 않는다. zipfile 로 **읽기만** 한다. 통합문서를 저장하면 차트가
    파손되는데 파일은 정상적으로 열려서 잡히지 않기 때문이다.

경로:
    원천 폴더는 환경변수 BOOKLET_DIR 로 받는다(기본값은 common.booklet_dir()).
"""
import json
import os
import re
import sys
import zipfile
from collections import Counter

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import booklet_dir, work_workbooks  # noqa: E402

if sys.stdout.encoding and sys.stdout.encoding.lower() != 'utf-8':
    sys.stdout.reconfigure(encoding='utf-8')

NS_R = '{http://schemas.openxmlformats.org/officeDocument/2006/relationships}'


def _rels(z, part_path):
    """part 의 .rels 를 {rId: target} 으로 읽는다. 없으면 빈 dict."""
    d = os.path.dirname(part_path)
    base = os.path.basename(part_path)
    rp = '%s/_rels/%s.rels' % (d, base)
    if rp not in z.namelist():
        return {}
    x = z.read(rp).decode('utf-8', 'replace')
    return dict(re.findall(r'Id="([^"]+)"[^>]*Target="([^"]+)"', x))


def _norm(base_dir, target):
    """상대 target 을 zip 내부 절대 경로로."""
    if target.startswith('/'):
        return target.lstrip('/')
    p = os.path.normpath(os.path.join(base_dir, target))
    return p.replace('\\', '/')


def sheet_to_charts(z):
    """{시트명: [chart xml 경로]}. 시트 → drawing → chart 를 rels 로 잇는다."""
    wb = z.read('xl/workbook.xml').decode('utf-8', 'replace')
    wb_rels = _rels(z, 'xl/workbook.xml')
    out = {}
    for m in re.finditer(r'<sheet\b[^>]*>', wb):
        tag = m.group(0)
        name = re.search(r'name="([^"]*)"', tag)
        rid = re.search(r'r:id="([^"]*)"', tag)
        if not name or not rid:
            continue
        target = wb_rels.get(rid.group(1))
        if not target:
            continue
        sheet_path = _norm('xl', target)
        if sheet_path not in z.namelist():
            continue
        sx = z.read(sheet_path).decode('utf-8', 'replace')
        s_rels = _rels(z, sheet_path)
        charts = []
        for dm in re.finditer(r'<drawing\b[^>]*r:id="([^"]+)"', sx):
            dt = s_rels.get(dm.group(1))
            if not dt:
                continue
            dpath = _norm(os.path.dirname(sheet_path), dt)
            if dpath not in z.namelist():
                continue
            d_rels = _rels(z, dpath)
            dx = z.read(dpath).decode('utf-8', 'replace')
            # 그림 안의 차트 참조는 <c:chart r:id="rIdN"/>
            for cm in re.finditer(r'<c:chart\b[^>]*r:id="([^"]+)"', dx):
                ct = d_rels.get(cm.group(1))
                if not ct:
                    continue
                cpath = _norm(os.path.dirname(dpath), ct)
                if cpath in z.namelist():
                    charts.append(cpath)
        if charts:
            out[name.group(1)] = charts
    return out


SER_KINDS = ('barChart', 'lineChart', 'areaChart', 'pieChart', 'doughnutChart',
             'radarChart', 'scatterChart', 'bubbleChart')


def _f(block, tag):
    """block 안의 <c:tag> ... <c:f>범위</c:f> 를 꺼낸다."""
    m = re.search(r'<c:%s>(.*?)</c:%s>' % (tag, tag), block, re.S)
    if not m:
        return None
    fm = re.search(r'<c:f>([^<]+)</c:f>', m.group(1))
    return fm.group(1) if fm else None


def _lit(block, tag):
    """범위가 아니라 문자열 리터럴로 들어온 계열명."""
    m = re.search(r'<c:%s>(.*?)</c:%s>' % (tag, tag), block, re.S)
    if not m:
        return None
    lm = re.search(r'<c:v>([^<]*)</c:v>', m.group(1))
    return lm.group(1) if lm else None


def parse_chart(x):
    """차트 xml → {groups:[{kind, barDir, grouping, axIds, series:[...]}], axes:{...}}"""
    groups = []
    for gm in re.finditer(r'<c:(%s)>(.*?)</c:\1>' % '|'.join(SER_KINDS), x, re.S):
        kind, body = gm.group(1), gm.group(2)
        g = {
            'kind': kind,
            'barDir': (re.search(r'<c:barDir val="([^"]+)"', body) or [None, None])[1]
            if re.search(r'<c:barDir val="([^"]+)"', body) else None,
            'grouping': (re.search(r'<c:grouping val="([^"]+)"', body).group(1)
                         if re.search(r'<c:grouping val="([^"]+)"', body) else None),
            'axIds': re.findall(r'<c:axId val="([^"]+)"', body),
            'series': [],
        }
        for sm in re.finditer(r'<c:ser>(.*?)</c:ser>', body, re.S):
            s = sm.group(1)
            g['series'].append({
                'order': (re.search(r'<c:order val="([^"]+)"', s).group(1)
                          if re.search(r'<c:order val="([^"]+)"', s) else None),
                'nameRef': _f(s, 'tx'),
                'name': _lit(s, 'tx'),
                'cat': _f(s, 'cat'),
                'val': _f(s, 'val'),
                'smooth': '<c:smooth val="1"' in s,
                'noMarker': '<c:marker><c:symbol val="none"' in s.replace(' ', ''),
            })
        groups.append(g)

    axes = {}
    for am in re.finditer(r'<c:(valAx|catAx|dateAx)>(.*?)</c:\1>', x, re.S):
        body = am.group(2)
        aid = re.search(r'<c:axId val="([^"]+)"', body)
        if not aid:
            continue
        axes[aid.group(1)] = {
            'type': am.group(1),
            'pos': (re.search(r'<c:axPos val="([^"]+)"', body).group(1)
                    if re.search(r'<c:axPos val="([^"]+)"', body) else None),
            'delete': '<c:delete val="1"' in body,
            'title': bool(re.search(r'<c:title>', body)),
        }

    tm = re.search(r'<c:title>(.*?)</c:title>', x, re.S)
    title = None
    if tm:
        parts = re.findall(r'<a:t>([^<]*)</a:t>', tm.group(1))
        title = ''.join(parts).strip() or None

    return {'groups': groups, 'axes': axes, 'title': title}


def main():
    root = booklet_dir()
    out_dir = os.path.join(os.path.dirname(os.path.dirname(
        os.path.dirname(os.path.abspath(__file__)))), 'data')
    os.makedirs(out_dir, exist_ok=True)

    result = {}
    kinds = Counter()
    n_charts = 0
    for part, path in work_workbooks(root).items():
        with zipfile.ZipFile(path) as z:   # 읽기만 한다. 저장하지 않는다.
            mapping = sheet_to_charts(z)
            sheets = {}
            for sheet, chart_paths in mapping.items():
                specs = []
                for cp in chart_paths:
                    x = z.read(cp).decode('utf-8', 'replace')
                    spec = parse_chart(x)
                    spec['src'] = cp
                    specs.append(spec)
                    for g in spec['groups']:
                        kinds[g['kind']] += 1
                    n_charts += 1
                if specs:
                    sheets[sheet] = specs
            if sheets:
                result[part] = sheets

    payload = {
        'what': '작업본 통합문서가 **선언한** 차트 정의. 종류·계열·범위·축.',
        'source': '2025년기준집계_part*.xlsx 의 xl/charts/chart*.xml (zip 읽기 전용)',
        'note': '추론이 아니다. 목업 단계의 차트 종류 추론이 결함 5건을 만들었으므로 '
                '이 파일이 유일한 근거다.',
        'counts': {'charts': n_charts, 'kinds': dict(kinds)},
        'parts': result,
    }
    out = os.path.join(out_dir, 'charts.json')
    with open(out, 'w', encoding='utf-8') as fh:
        json.dump(payload, fh, ensure_ascii=False, indent=1)

    print('차트 %d개 · 시트 %d개 · part %d개'
          % (n_charts, sum(len(v) for v in result.values()), len(result)))
    for k, v in kinds.most_common():
        print('  %-16s %d' % (k, v))
    print('→ %s (%.1f KB)' % (out, os.path.getsize(out) / 1024))


if __name__ == '__main__':
    main()
