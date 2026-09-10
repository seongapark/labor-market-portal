-- 관측 하나가 한 행. KOSIS API 응답 스키마를 그대로 받는다.
-- prd_de 는 TEXT 다: 반기 6자리(202401), 연간인데 6자리인 표(202508)가 있다.
-- obs 는 KOSIS 전용이다. OECD 는 차원 이름 체계가 달라(SDMX) 이 스키마에 맞지
-- 않는다 — oecd_obs 로 따로 둔다 (스펙 §4.1 이 이미 그렇게 적어 두었는데 2단계
-- 계획이 이를 놓쳤다; 회차1 판정으로 바로잡는다).
CREATE TABLE IF NOT EXISTS obs (
  src        TEXT NOT NULL,
  table_id   TEXT NOT NULL,
  prd_de     TEXT NOT NULL,
  itm_id     TEXT,
  itm_nm     TEXT,
  c1_obj_nm  TEXT, c1 TEXT, c1_nm TEXT,
  c2_obj_nm  TEXT, c2 TEXT, c2_nm TEXT,
  c3_obj_nm  TEXT, c3 TEXT, c3_nm TEXT,
  c4_obj_nm  TEXT, c4 TEXT, c4_nm TEXT,
  unit_nm    TEXT,
  dt         REAL
);
-- PRIMARY KEY 를 두지 않는다. 스펙 §4.1 은 PK 를 적었지만 itm_id·c1~c3 가 nullable 이라
-- SQLite 가 NULL 을 서로 다르게 보아 중복을 막지 못하고, 적재는 매번 전량 재적재라
-- 중복 방지가 필요 없다. 중복이 들어가면 SUM 이 두 배가 되어 대조가 즉시 잡는다.

CREATE INDEX IF NOT EXISTS obs_main ON obs (src, table_id, prd_de);
CREATE INDEX IF NOT EXISTS obs_itm  ON obs (src, table_id, itm_nm);

-- OECD 14개 시트(0_수집현황 제외) 헤더의 합집합은 정확히 이 12열이다. KOSIS 처럼
-- 시트마다 열이 들쭉날쭉하지 않고 깨끗한 long 표라, 동적 DDL 없이 그대로 고정한다.
-- REF_AREA·국가명·TIME_PERIOD·value 는 14개 시트 전부에 있고 나머지 8열은
-- 시트별 선택 차원이라 없으면 NULL. 열 이름에 한글·소문자(value)가 섞여 있어
-- DDL 과 적재 SQL 모두에서 큰따옴표로 인용한다.
CREATE TABLE IF NOT EXISTS oecd_obs (
  "table_id"               TEXT NOT NULL,
  "REF_AREA"               TEXT,
  "국가명"                  TEXT,
  "SEX"                     TEXT,
  "AGE"                     TEXT,
  "LABOUR_FORCE_STATUS"     TEXT,
  "TIME_PERIOD"             TEXT,
  "value"                   REAL,
  "WORKER_STATUS"           TEXT,
  "AGGREGATION_OPERATION"   TEXT,
  "MEASURE"                 TEXT,
  "UNIT_MEASURE"            TEXT,
  "PRICE_BASE"              TEXT
);

CREATE INDEX IF NOT EXISTS oecd_obs_time ON oecd_obs ("table_id", "TIME_PERIOD");
CREATE INDEX IF NOT EXISTS oecd_obs_area ON oecd_obs ("table_id", "REF_AREA");

-- 별도데이터·패널은 wide 시트가 섞여 있고, 헤더 자체가 표 헤더가 아닌 경우가
-- 많다(가로로 늘어선 여러 블록, 검색조건 안내문, 값 레이블 등) — 열 합집합을
-- 만들면 정크 열이 100개 넘게 생긴다. long 으로 바꾸려 하지 않고
-- 좌표 그대로 보관해 두고 변환표(9단계)로 읽는다.
CREATE TABLE IF NOT EXISTS grid (
  src    TEXT NOT NULL,
  sheet  TEXT NOT NULL,
  r      INTEGER NOT NULL,
  c      INTEGER NOT NULL,
  v_num  REAL,
  v_txt  TEXT,
  PRIMARY KEY (src, sheet, r, c)
) WITHOUT ROWID;
