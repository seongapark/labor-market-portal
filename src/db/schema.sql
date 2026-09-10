-- 관측 하나가 한 행. KOSIS API 응답 스키마를 그대로 받는다.
-- prd_de 는 TEXT 다: 반기 6자리(202401), 연간인데 6자리인 표(202508)가 있다.
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

-- 별도데이터·패널은 wide 시트가 섞여 있다. long 으로 안 떨어지는 시트는
-- 좌표 그대로 보관해 두고 변환표로 읽는다.
CREATE TABLE IF NOT EXISTS grid (
  src    TEXT NOT NULL,
  sheet  TEXT NOT NULL,
  r      INTEGER NOT NULL,
  c      INTEGER NOT NULL,
  v_num  REAL,
  v_txt  TEXT,
  PRIMARY KEY (src, sheet, r, c)
) WITHOUT ROWID;
