"""엑셀 읽기 공통. 절대 save() 하지 않는다 — 저장만 해도 차트가 파손된다."""
import os
import re
import glob

def booklet_dir() -> str:
    d = os.environ.get('BOOKLET_DIR')
    if not d:
        d = r'C:\Users\seong\Desktop\exe\연간책자'
    if not os.path.isdir(d):
        raise SystemExit('원천 폴더가 없다: %s (BOOKLET_DIR 로 지정한다)' % d)
    return d

# 원천 4종. 값은 booklet_dir 기준 상대경로.
SOURCES = {
    'kosis': 'KOSIS_원데이터.xlsx',
    'oecd': 'OECD_원데이터.xlsx',
    'etc': '별도데이터.xlsx',
    'panel': os.path.join('수기갱신데이터',
                          '2026년 발간 예정 책자_패널데이터_한고원_20260728_f.xlsx'),
}

def final_workbooks(d: str) -> dict:
    """확정본 13개의 '정본'(같은 파트에서 가장 나중 동결본)."""
    groups = {}
    for f in glob.glob(os.path.join(d, '2025년기준집계_part*확정.xlsx')):
        key = re.sub(r'_\d{8}_\d{4}확정\.xlsx$', '', os.path.basename(f))
        groups.setdefault(key, []).append(f)
    return {k.replace('2025년기준집계_', ''): sorted(v)[-1] for k, v in groups.items()}

def work_workbooks(d: str) -> dict:
    """작업본 13개(수식이 살아 있는 쪽)."""
    out = {}
    for f in sorted(glob.glob(os.path.join(d, '2025년기준집계_part*.xlsx'))):
        b = os.path.basename(f)
        if '확정' in b:
            continue
        out[re.sub(r'^2025년기준집계_|\.xlsx$', '', b)] = f
    return out

def cell_text(v):
    """엑셀 값을 JSON 에 실을 형태로. 정수를 str() 로 바꾸면 증감 계산이 조용히 죽는다."""
    if v is None:
        return None
    if isinstance(v, bool):
        return str(v)
    if isinstance(v, float):
        return v
    if isinstance(v, int):
        return v
    return str(v).strip()
