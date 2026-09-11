"""발간 편집본 PDF → data/pdf-pages.json  (인쇄된 표·헤드라인·자료·단위)

왜 이것이 필요한가:
    포털이 「엑셀에서 비어 있지 않은 모든 칸」을 표로 그리고 있었다. 그런데 엑셀에는
    참고용·작업용 값이 많아서 인쇄본 표에는 들어가지 않는다. 사용자:
      「PDF 에 최종적으로 들어간 표를 기준으로 다시 다듬어야 할듯. 엑셀에 값이 있는 셀
       중에는 참고를 위해서 넣은 값도 많아서 ... 굳이 책자 표에 넣지 않아도 되는 값이 많음」

    실측으로 확인한 것:
      · 책자 17·18쪽에는 **표가 없다.** 내가 표로 그린 숫자는 전부 차트의 데이터 라벨이었다.
      · OECD 부록(216·217쪽)에는 표가 있고 **13개국 × 6개 연도(’20~’25)** 다.
        엑셀 시트는 38개국에 열이 훨씬 많다.
    따라서 「무엇이 인쇄되었나」는 PDF 만이 답한다.

편집본은 **2면 펼침**이다(121쪽 = 202쪽). 좌우를 x 좌표로 가르고, 쪽번호는 바닥글에
인쇄된 것을 읽는다 — 산술로 추정하지 않는다.

안전: 읽기만 한다. 원본 폴더에 쓰지 않는다.
"""
import json
import os
import re
import sys

import pdfplumber

if sys.stdout.encoding and sys.stdout.encoding.lower() != 'utf-8':
    sys.stdout.reconfigure(encoding='utf-8')

DEFAULT_PDF = os.path.join(
    'C:/Users/seong/Desktop/exe/연간책자', '신성기획_편집', '0907_편집본',
    '통계로보는 노동시장 9.7.pdf')

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def side_of(x0, x1, width):
    """펼침면의 좌/우 판정. 가운데를 걸치면 None(펼침 공용 요소)."""
    mid = width / 2
    if x1 <= mid + 4:
        return 'L'
    if x0 >= mid - 4:
        return 'R'
    return None


def page_no(words, width, height, side):
    """바닥글에서 쪽번호를 읽는다.

    실물: 바닥글이 `216 | Ministry of Employment and Labor  www.moel.go.kr | 217` 이다.
    쪽번호는 **지면 바깥쪽 끝**에 찍힌다 — 좌면은 왼쪽 끝, 우면은 오른쪽 끝.

    앞 판에서 이 함수를 잘못 써서 쪽번호가 1~422 로 튀었다(차트 데이터 라벨을 주워왔다).
    이제 **바닥 영역으로 먼저 좁히고**, 그 안에서 가장 바깥쪽 숫자를 고른다.
    """
    foot_top = height * 0.93          # 아래 7% 만 본다
    cands = []
    for w in words:
        t = w['text'].strip()
        if not re.fullmatch(r'[0-9]{1,3}', t):
            continue
        if w['top'] < foot_top:
            continue
        if side_of(w['x0'], w['x1'], width) != side:
            continue
        cands.append((w['x0'], int(t)))
    if not cands:
        return None
    cands.sort(key=lambda c: c[0] if side == 'L' else -c[0])
    return cands[0][1]


def clean_cell(v):
    if v is None:
        return ''
    return re.sub(r'\s+', ' ', str(v)).strip()


def grab_tables(page, width, side):
    """그 반쪽에 들어가는 표만. 괘선 기반 → 실패 시 텍스트 정렬 기반."""
    out = []
    settings = [
        {'vertical_strategy': 'lines', 'horizontal_strategy': 'lines'},
        {'vertical_strategy': 'lines', 'horizontal_strategy': 'text'},
    ]
    seen = set()
    for st in settings:
        try:
            found = page.find_tables(table_settings=st)
        except Exception:
            continue
        for t in found:
            x0, top, x1, bottom = t.bbox
            if side_of(x0, x1, width) != side:
                continue
            try:
                rows = t.extract()
            except Exception:
                continue
            rows = [[clean_cell(c) for c in r] for r in rows]
            rows = [r for r in rows if any(c for c in r)]
            if len(rows) < 2:
                continue
            key = json.dumps(rows, ensure_ascii=False)
            if key in seen:
                continue
            seen.add(key)
            out.append({
                'bbox': [round(v, 1) for v in (x0, top, x1, bottom)],
                'rows': rows,
                'strategy': st['horizontal_strategy'],
            })
        if out:
            break          # 괘선으로 잡혔으면 텍스트 전략은 쓰지 않는다
    return out


LINE_TOL = 2.6


def lines_of(words, width, side):
    """같은 y 에 있는 단어를 한 줄로 묶는다. 글자 크기를 함께 들고 온다."""
    ws = [w for w in words if side_of(w['x0'], w['x1'], width) == side]
    ws.sort(key=lambda w: (round(w['top'], 1), w['x0']))
    lines, cur, cur_top = [], [], None
    for w in ws:
        if cur_top is None or abs(w['top'] - cur_top) <= LINE_TOL:
            cur.append(w)
            cur_top = w['top'] if cur_top is None else cur_top
        else:
            lines.append(cur)
            cur, cur_top = [w], w['top']
    if cur:
        lines.append(cur)
    out = []
    for ln in lines:
        text = re.sub(r'\s+', ' ', ' '.join(w['text'] for w in ln)).strip()
        if not text:
            continue
        size = max((w.get('size') or 0) for w in ln)
        out.append({'text': text, 'top': round(ln[0]['top'], 1), 'size': round(size, 1)})
    return out


def classify(lines):
    """헤드라인·불릿·자료·단위·참고를 가른다. 크기와 표지 문자로만 판정한다."""
    if not lines:
        return {}
    sizes = sorted({ln['size'] for ln in lines}, reverse=True)
    big = sizes[0] if sizes else 0
    head, bullets, src, unit, note = [], [], [], [], []
    for ln in lines:
        t = ln['text']
        if re.match(r'^자료\s*[:：]', t):
            src.append(t)
        elif re.search(r'\(단위\s*[:：][^)]*\)', t):
            m = re.search(r'\(단위\s*[:：]([^)]*)\)', t)
            unit.append(m.group(1).strip())
        elif re.match(r'^\s*[●○▪·]', t) or re.match(r'^\s*주\s*\)', t):
            note.append(t)
        elif ln['size'] >= big - 0.6 and len(t) > 6:
            head.append(t)
        elif len(t) > 12 and ln['size'] >= big - 3.5:
            bullets.append(t)
    return {
        'headline': head[:4],
        'bullets': bullets[:8],
        'source': src[:4],
        'unit': sorted(set(unit))[:3],
        'notes': note[:8],
    }


def main():
    pdf_path = os.environ.get('BOOKLET_PDF', DEFAULT_PDF)
    if not os.path.exists(pdf_path):
        raise SystemExit('PDF 가 없다: %s (BOOKLET_PDF 로 지정한다)' % pdf_path)

    pages = {}
    n_tables = 0
    with pdfplumber.open(pdf_path) as pdf:
        total = len(pdf.pages)
        for i, page in enumerate(pdf.pages, 1):
            width, height = page.width, page.height
            try:
                words = page.extract_words(extra_attrs=['size'])
            except Exception:
                words = page.extract_words()
            for side in ('L', 'R'):
                no = page_no(words, width, height, side)
                if no is None:
                    continue
                tables = grab_tables(page, width, side)
                n_tables += len(tables)
                info = classify(lines_of(words, width, side))
                info['page'] = no
                info['pdf_page'] = i
                info['side'] = side
                info['tables'] = tables
                # 같은 쪽번호가 두 번 나오면 표가 더 많은 쪽을 남긴다
                old = pages.get(no)
                if old is None or len(tables) > len(old['tables']):
                    pages[no] = info
            if i % 20 == 0:
                print('  … %d/%d쪽' % (i, total))

    out = {
        'what': '발간 편집본 PDF 에서 읽은 **인쇄된** 표·헤드라인·자료·단위. '
                '엑셀의 참고용 칸과 인쇄본을 가르는 기준이다.',
        'source': os.path.basename(pdf_path),
        'note': '편집본은 2면 펼침이라 좌우를 x 좌표로 갈랐고, 쪽번호는 바닥글에 '
                '인쇄된 것을 읽었다(산술 추정 아님).',
        'counts': {'booklet_pages': len(pages), 'tables': n_tables},
        'pages': [pages[k] for k in sorted(pages)],
    }
    dest = os.path.join(REPO, 'data', 'pdf-pages.json')
    with open(dest, 'w', encoding='utf-8') as fh:
        json.dump(out, fh, ensure_ascii=False, indent=1)

    with_t = sum(1 for p in out['pages'] if p['tables'])
    print('쪽 %d개 · 표 %d개 · 표 있는 쪽 %d개' % (len(pages), n_tables, with_t))
    print('쪽번호 범위: %s ~ %s' % (min(pages), max(pages)))
    print('→ %s (%.1f KB)' % (dest, os.path.getsize(dest) / 1024))


if __name__ == '__main__':
    main()
