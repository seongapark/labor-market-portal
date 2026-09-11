/* 차트 렌더러 — 통합문서가 선언한 차트를 SVG 로 그린다.
 *
 * 근거: data/charts.json (엑셀 xl/charts/chart*.xml). 종류·계열·범위·축이 전부 선언돼 있다.
 * 추론하지 않는다. 목업 단계의 차트 종류 추론이 결함 5건을 만들었다.
 *
 * 사용자가 정한 규칙:
 *  - 나이트모드 없음
 *  - 증감은 화살표 표식만(상승 빨강·하강 파랑), 0.0 은 "-"
 *  - 본지표와 증감을 이중축으로, 증감 위치에 화살표
 *  - 그래프 내 최근 시점 레이블은 무조건 표출
 *  - 시도 약자는 2글자 (충청남 → 충남)
 *  - 전국/시도, OECD/개별국가가 같은 축이면 막대 색 구분
 */
(function (global) {
  'use strict';

  var PAL = ['#8ec46b', '#eb6834', '#4a3aa7', '#2f9e8f', '#b58900', '#8a5cb8'];
  var AGG = '#5a8f30';        // 전국·OECD 같은 집계 항목
  var UP = '#c0392b', DOWN = '#0b6bd6';
  var INK = '#1d2229', INK2 = '#49505d', MUTED = '#7b8292', GRID = '#e9e6df';

  /* 시도 약자 2글자 — 사용자 결정 */
  var SIDO = {
    '서울특별시': '서울', '부산광역시': '부산', '대구광역시': '대구', '인천광역시': '인천',
    '광주광역시': '광주', '대전광역시': '대전', '울산광역시': '울산', '세종특별자치시': '세종',
    '경기도': '경기', '강원도': '강원', '강원특별자치도': '강원',
    '충청북도': '충북', '충청남도': '충남',
    '전라북도': '전북', '전북특별자치도': '전북', '전라남도': '전남',
    '경상북도': '경북', '경상남도': '경남',
    '제주도': '제주', '제주특별자치도': '제주'
  };
  var AGG_NAMES = { '전국': 1, '계': 1, '전체': 1, '합계': 1, 'OECD': 1, 'OECD 평균': 1, '한국': 0 };

  function shortCat(v) {
    if (typeof v !== 'string') return v;
    if (SIDO[v]) return SIDO[v];
    var t = v.trim();
    if (SIDO[t]) return SIDO[t];
    return t;
  }
  function isAgg(v) {
    if (typeof v !== 'string') return false;
    return AGG_NAMES[v.trim()] === 1;
  }
  function isDelta(name) {
    return typeof name === 'string' && /증감|증가율|전년|증감률/.test(name);
  }

  function fmt(n) {
    if (typeof n !== 'number' || !isFinite(n)) return '';
    var a = Math.abs(n);
    if (a >= 1000) return Math.round(n).toLocaleString('ko-KR');
    if (a >= 100) return (Math.round(n * 10) / 10).toLocaleString('ko-KR');
    return (Math.round(n * 100) / 100).toLocaleString('ko-KR');
  }
  function el(tag, attrs, text) {
    var e = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (var k in attrs) if (attrs[k] !== null && attrs[k] !== undefined) e.setAttribute(k, attrs[k]);
    if (text !== undefined && text !== null) e.textContent = String(text);
    return e;
  }
  function nice(max, min) {
    if (!isFinite(max)) return { lo: 0, hi: 1, step: 1 };
    var lo = Math.min(0, min), hi = max;
    if (hi === lo) { hi = lo + 1; }
    var span = hi - lo;
    var mag = Math.pow(10, Math.floor(Math.log10(span)));
    var step = mag;
    var steps = span / step;
    if (steps > 8) step = mag * 2;
    if (span / step > 8) step = mag * 5;
    if (span / step > 8) step = mag * 10;
    return { lo: Math.floor(lo / step) * step, hi: Math.ceil(hi / step) * step, step: step };
  }

  /* 계열 전체에서 가장 완전한 범주 배열을 고른다.
     p8 처럼 area 계열의 범주 행이 5년마다만 채워진 경우가 있다 — 그런 희소 배열은
     축 라벨 행이므로, 더 촘촘한 형제 배열을 기준으로 쓰고 라벨만 희소하게 찍는다. */
  function pickCats(groups) {
    var best = null, bestFilled = -1, len = 0;
    groups.forEach(function (g) {
      g.series.forEach(function (s) {
        if (!s.cats) return;
        len = Math.max(len, s.cats.length);
        var filled = s.cats.filter(function (v) { return v !== null && v !== undefined && v !== ''; }).length;
        if (filled > bestFilled) { bestFilled = filled; best = s.cats; }
      });
    });
    if (!best) {
      var n = 0;
      groups.forEach(function (g) { g.series.forEach(function (s) { n = Math.max(n, s.vals.length); }); });
      best = []; for (var i = 0; i < n; i++) best.push(i + 1);
    }
    return best;
  }

  /* ── 원형(파이·도넛) ───────────────────────────────────────────────────── */
  function drawPie(svg, W, H, group, isDonut) {
    var series = group.series;
    var n = series.length;
    var cols = Math.min(n, 2);
    var rows = Math.ceil(n / cols);
    var cw = W / cols, ch = H / rows;

    series.forEach(function (s, si) {
      var cx = (si % cols) * cw + cw / 2;
      var cy = Math.floor(si / cols) * ch + ch / 2 + 6;
      var R = Math.min(cw, ch) / 2 - 34;
      if (R < 20) R = 20;
      var Ri = isDonut ? R * 0.56 : 0;
      var vals = s.vals.map(function (v) { return typeof v === 'number' && v > 0 ? v : 0; });
      var total = vals.reduce(function (a, b) { return a + b; }, 0);
      if (!total) return;

      var ang = -Math.PI / 2;
      vals.forEach(function (v, i) {
        if (!v) return;
        var sweep = (v / total) * Math.PI * 2;
        var a0 = ang, a1 = ang + sweep;
        ang = a1;
        /* 큰호 플래그는 **두 호가 같은 sweep 을 쓴다** — 예전에 안쪽 호에 (끝−시작)을
           다시 계산해 넣어 180°가 넘는 조각의 두께가 무너졌다. */
        var large = sweep > Math.PI ? 1 : 0;
        var x0 = cx + R * Math.cos(a0), y0 = cy + R * Math.sin(a0);
        var x1 = cx + R * Math.cos(a1), y1 = cy + R * Math.sin(a1);
        var d;
        if (isDonut) {
          var ix1 = cx + Ri * Math.cos(a1), iy1 = cy + Ri * Math.sin(a1);
          var ix0 = cx + Ri * Math.cos(a0), iy0 = cy + Ri * Math.sin(a0);
          d = 'M' + x0 + ' ' + y0 + 'A' + R + ' ' + R + ' 0 ' + large + ' 1 ' + x1 + ' ' + y1
            + 'L' + ix1 + ' ' + iy1 + 'A' + Ri + ' ' + Ri + ' 0 ' + large + ' 0 ' + ix0 + ' ' + iy0 + 'Z';
        } else {
          d = 'M' + cx + ' ' + cy + 'L' + x0 + ' ' + y0
            + 'A' + R + ' ' + R + ' 0 ' + large + ' 1 ' + x1 + ' ' + y1 + 'Z';
        }
        svg.appendChild(el('path', {
          d: d, fill: PAL[i % PAL.length], stroke: '#fff', 'stroke-width': 2
        }));
        /* 조각 라벨 — 5% 이상만 */
        if (v / total >= 0.05) {
          var am = (a0 + a1) / 2;
          var lr = isDonut ? (R + Ri) / 2 : R * 0.62;
          var pct = Math.round((v / total) * 1000) / 10;
          var g = el('g', {});
          g.appendChild(el('text', {
            x: cx + lr * Math.cos(am), y: cy + lr * Math.sin(am) - 4,
            'text-anchor': 'middle', 'font-size': 11, 'font-weight': 700, fill: '#fff'
          }, pct + '%'));
          g.appendChild(el('text', {
            x: cx + lr * Math.cos(am), y: cy + lr * Math.sin(am) + 9,
            'text-anchor': 'middle', 'font-size': 9.5, fill: 'rgba(255,255,255,.92)'
          }, fmt(v)));
          svg.appendChild(g);
        }
      });

      if (isDonut) {
        svg.appendChild(el('text', {
          x: cx, y: cy + 4, 'text-anchor': 'middle', 'font-size': 13, 'font-weight': 700, fill: INK
        }, fmt(total)));
      }
      if (s.name) {
        svg.appendChild(el('text', {
          x: cx, y: cy - R - 14, 'text-anchor': 'middle', 'font-size': 11.5,
          'font-weight': 600, fill: INK2
        }, s.name));
      }
    });
    return series[0] ? (series[0].cats || []).map(function (c, i) {
      return { label: shortCat(c), color: PAL[i % PAL.length] };
    }) : [];
  }

  /* ── 방사형 ───────────────────────────────────────────────────────────── */
  function drawRadar(svg, W, H, group, cats) {
    var cx = W / 2, cy = H / 2 + 4;
    var R = Math.min(W, H) / 2 - 46;
    if (R < 24) R = 24;
    var n = cats.length;
    var max = 0;
    group.series.forEach(function (s) {
      s.vals.forEach(function (v) { if (typeof v === 'number' && v > max) max = v; });
    });
    var sc = nice(max, 0);

    for (var ring = 1; ring <= 4; ring++) {
      var rr = (R * ring) / 4;
      var pts = [];
      for (var i = 0; i < n; i++) {
        var a = -Math.PI / 2 + (i / n) * Math.PI * 2;
        pts.push((cx + rr * Math.cos(a)) + ',' + (cy + rr * Math.sin(a)));
      }
      svg.appendChild(el('polygon', {
        points: pts.join(' '), fill: 'none', stroke: GRID, 'stroke-width': 1
      }));
    }
    for (var i2 = 0; i2 < n; i2++) {
      var a2 = -Math.PI / 2 + (i2 / n) * Math.PI * 2;
      svg.appendChild(el('line', {
        x1: cx, y1: cy, x2: cx + R * Math.cos(a2), y2: cy + R * Math.sin(a2),
        stroke: GRID, 'stroke-width': 1
      }));
      var lx = cx + (R + 16) * Math.cos(a2), ly = cy + (R + 16) * Math.sin(a2);
      svg.appendChild(el('text', {
        x: lx, y: ly + 3, 'text-anchor': Math.abs(Math.cos(a2)) < 0.2 ? 'middle' : (Math.cos(a2) > 0 ? 'start' : 'end'),
        'font-size': 10, fill: MUTED
      }, shortCat(cats[i2])));
    }
    group.series.forEach(function (s, si) {
      var pts = [];
      for (var i3 = 0; i3 < n; i3++) {
        var v = s.vals[i3];
        var rr2 = typeof v === 'number' ? (R * (v - sc.lo)) / (sc.hi - sc.lo || 1) : 0;
        var a3 = -Math.PI / 2 + (i3 / n) * Math.PI * 2;
        pts.push((cx + rr2 * Math.cos(a3)) + ',' + (cy + rr2 * Math.sin(a3)));
      }
      var col = PAL[si % PAL.length];
      svg.appendChild(el('polygon', {
        points: pts.join(' '), fill: col, 'fill-opacity': 0.16, stroke: col, 'stroke-width': 2
      }));
    });
    return group.series.map(function (s, i) {
      return { label: s.name || '계열 ' + (i + 1), color: PAL[i % PAL.length] };
    });
  }

  /* ── 직교(막대·선·영역) ───────────────────────────────────────────────── */
  function drawXY(svg, W, H, groups, cats) {
    var PADL = 52, PADR = 52, PADT = 16, PADB = 34;
    var pw = W - PADL - PADR, ph = H - PADT - PADB;
    var n = cats.length;

    /* 증감 계열을 가른다 — 사용자 결정: 증감은 화살표 표식만 */
    var deltas = [], normal = [];
    groups.forEach(function (g) {
      g.series.forEach(function (s) {
        (isDelta(s.name) ? deltas : normal).push({ g: g, s: s });
      });
    });

    /* 축별 범위 */
    function range(items) {
      var mx = -Infinity, mn = Infinity, any = false;
      items.forEach(function (it) {
        it.s.vals.forEach(function (v) {
          if (typeof v === 'number' && isFinite(v)) { any = true; if (v > mx) mx = v; if (v < mn) mn = v; }
        });
      });
      return any ? { mx: mx, mn: mn } : null;
    }
    /* 누적 막대는 합으로 범위를 잡는다 */
    var stacked = normal.filter(function (it) { return it.g.kind === 'barChart' && it.g.grouping === 'stacked'; });
    var stackedArea = normal.filter(function (it) { return it.g.kind === 'areaChart' && it.g.grouping === 'stacked'; });
    var leftItems = normal.filter(function (it) { return it.g.axis !== 'r'; });
    var rightItems = normal.filter(function (it) { return it.g.axis === 'r'; });

    function stackMax(items) {
      var mx = 0;
      for (var i = 0; i < n; i++) {
        var sum = 0;
        items.forEach(function (it) { var v = it.s.vals[i]; if (typeof v === 'number' && v > 0) sum += v; });
        if (sum > mx) mx = sum;
      }
      return mx;
    }
    var lr = range(leftItems) || { mx: 1, mn: 0 };
    if (stacked.length || stackedArea.length) {
      lr.mx = Math.max(lr.mx, stackMax(stacked.concat(stackedArea)));
    }
    var rr = rightItems.length ? range(rightItems) : null;
    var scL = nice(lr.mx, lr.mn);
    var scR = rr ? nice(rr.mx, rr.mn) : null;

    var yL = function (v) { return PADT + ph - ((v - scL.lo) / (scL.hi - scL.lo || 1)) * ph; };
    var yR = function (v) { return PADT + ph - ((v - scR.lo) / (scR.hi - scR.lo || 1)) * ph; };
    var bw = pw / Math.max(n, 1);
    var xc = function (i) { return PADL + bw * i + bw / 2; };

    /* 격자와 왼쪽 축 */
    for (var v = scL.lo; v <= scL.hi + 1e-9; v += scL.step) {
      var y = yL(v);
      svg.appendChild(el('line', { x1: PADL, y1: y, x2: PADL + pw, y2: y, stroke: GRID, 'stroke-width': 1 }));
      svg.appendChild(el('text', { x: PADL - 7, y: y + 3.5, 'text-anchor': 'end', 'font-size': 9.5, fill: MUTED }, fmt(v)));
    }
    if (scR) {
      for (var v2 = scR.lo; v2 <= scR.hi + 1e-9; v2 += scR.step) {
        svg.appendChild(el('text', {
          x: PADL + pw + 7, y: yR(v2) + 3.5, 'text-anchor': 'start', 'font-size': 9.5, fill: MUTED
        }, fmt(v2)));
      }
    }

    /* 범주 라벨 — 희소 배열은 채워진 자리만, 촘촘하면 간격을 둔다.
       최근 시점(마지막)은 **무조건** 찍는다 (사용자 결정) */
    var filledIdx = [];
    for (var i4 = 0; i4 < n; i4++) {
      var c = cats[i4];
      if (c !== null && c !== undefined && c !== '') filledIdx.push(i4);
    }
    var maxLabels = Math.max(2, Math.floor(pw / 46));
    var stride = Math.ceil(filledIdx.length / maxLabels);
    filledIdx.forEach(function (i, k) {
      var isLast = i === filledIdx[filledIdx.length - 1];
      if (!isLast && stride > 1 && k % stride !== 0) return;
      svg.appendChild(el('text', {
        x: xc(i), y: H - PADB + 15, 'text-anchor': 'middle',
        'font-size': 9.5, 'font-weight': isLast ? 700 : 400,
        fill: isLast ? INK : MUTED
      }, shortCat(cats[i])));
    });

    /* 전국/OECD 가 범주에 섞여 있으면 그 막대만 색을 달리한다 (사용자 결정) */
    var hasAgg = cats.some(isAgg);

    var legend = [];
    var colorIdx = 0;

    /* 영역 → 막대 → 선 순서로 겹치게 그린다 */
    function seriesColor(it) {
      var col = PAL[colorIdx % PAL.length];
      colorIdx++;
      return col;
    }

    /* 누적 위치 추적 */
    var stackTop = new Array(n).fill(0);

    // 1) 영역
    normal.filter(function (it) { return it.g.kind === 'areaChart'; }).forEach(function (it) {
      var col = seriesColor(it);
      var isStack = it.g.grouping === 'stacked';
      var pts = [], back = [];
      for (var i = 0; i < n; i++) {
        var v = it.s.vals[i];
        if (typeof v !== 'number') continue;
        var base = isStack ? stackTop[i] : 0;
        var top = base + v;
        pts.push(xc(i) + ',' + yL(top));
        back.push(xc(i) + ',' + yL(base));
        if (isStack) stackTop[i] = top;
      }
      if (!pts.length) return;
      svg.appendChild(el('polygon', {
        points: pts.concat(back.reverse()).join(' '), fill: col, 'fill-opacity': 0.75, stroke: 'none'
      }));
      legend.push({ label: it.s.name || '', color: col });
    });

    // 2) 막대
    var bars = normal.filter(function (it) { return it.g.kind === 'barChart'; });
    var clustered = bars.filter(function (it) { return it.g.grouping !== 'stacked'; });
    var stackBars = bars.filter(function (it) { return it.g.grouping === 'stacked'; });
    var sTop = new Array(n).fill(0);
    var slot = clustered.length || 1;
    var inner = Math.min(bw * 0.72, 26);
    var each = inner / slot;

    clustered.forEach(function (it, bi) {
      var col = seriesColor(it);
      for (var i = 0; i < n; i++) {
        var v = it.s.vals[i];
        if (typeof v !== 'number') continue;
        var ay = it.g.axis === 'r' && scR ? yR : yL;
        var y0 = ay(Math.max(v, 0)), y1 = ay(Math.min(v, 0));
        var x = xc(i) - inner / 2 + bi * each;
        var fill = (hasAgg && isAgg(cats[i])) ? AGG : col;
        svg.appendChild(el('rect', {
          x: x, y: Math.min(y0, y1), width: Math.max(each - 1.5, 1), height: Math.max(Math.abs(y1 - y0), 0.8),
          rx: 2, fill: fill
        }));
      }
      legend.push({ label: it.s.name || '', color: col });
    });
    stackBars.forEach(function (it) {
      var col = seriesColor(it);
      for (var i = 0; i < n; i++) {
        var v = it.s.vals[i];
        if (typeof v !== 'number' || v <= 0) continue;
        var base = sTop[i], top = base + v;
        svg.appendChild(el('rect', {
          x: xc(i) - inner / 2, y: yL(top), width: Math.max(inner, 1),
          height: Math.max(yL(base) - yL(top), 0.8), fill: col
        }));
        sTop[i] = top;
      }
      legend.push({ label: it.s.name || '', color: col });
    });

    // 3) 선
    normal.filter(function (it) { return it.g.kind === 'lineChart'; }).forEach(function (it) {
      var col = seriesColor(it);
      var ay = it.g.axis === 'r' && scR ? yR : yL;
      var d = '', started = false, lastPt = null;
      for (var i = 0; i < n; i++) {
        var v = it.s.vals[i];
        if (typeof v !== 'number') continue;
        var px = xc(i), py = ay(v);
        d += (started ? 'L' : 'M') + px + ' ' + py;
        started = true;
        lastPt = { x: px, y: py, v: v };
      }
      if (!started) return;
      svg.appendChild(el('path', { d: d, fill: 'none', stroke: col, 'stroke-width': 2, 'stroke-linejoin': 'round' }));
      if (lastPt) {
        svg.appendChild(el('circle', { cx: lastPt.x, cy: lastPt.y, r: 3.4, fill: col, stroke: '#fff', 'stroke-width': 1.6 }));
        /* 최근 시점 레이블 무조건 표출 (사용자 결정) */
        svg.appendChild(el('text', {
          x: Math.min(lastPt.x + 6, W - 4), y: lastPt.y - 7, 'text-anchor': 'end',
          'font-size': 10, 'font-weight': 700, fill: col
        }, fmt(lastPt.v)));
      }
      legend.push({ label: it.s.name || '', color: col });
    });

    // 4) 증감 — 화살표 표식만, 0.0 은 "-" (사용자 결정)
    deltas.forEach(function (it) {
      var ay = scR ? yR : yL;
      for (var i = 0; i < n; i++) {
        var v = it.s.vals[i];
        if (typeof v !== 'number') continue;
        var px = xc(i), py = ay(v);
        if (Math.abs(v) < 0.05) {
          svg.appendChild(el('text', {
            x: px, y: py + 4, 'text-anchor': 'middle', 'font-size': 11, fill: MUTED
          }, '-'));
        } else {
          var up = v > 0, col = up ? UP : DOWN;
          var t = up ? (px - 4) + ',' + (py + 4) + ' ' + (px + 4) + ',' + (py + 4) + ' ' + px + ',' + (py - 4)
                     : (px - 4) + ',' + (py - 4) + ' ' + (px + 4) + ',' + (py - 4) + ' ' + px + ',' + (py + 4);
          svg.appendChild(el('polygon', { points: t, fill: col }));
        }
      }
      legend.push({ label: it.s.name || '증감', color: UP, arrow: true });
    });

    if (hasAgg) legend.push({ label: '전국·집계', color: AGG });
    return legend;
  }

  /* ── 공개 API ─────────────────────────────────────────────────────────── */
  function render(container, chart, idx) {
    var W = Math.max(container.clientWidth || 640, 320);
    var H = Math.min(Math.max(Math.round(W * 0.44), 240), 420);
    var svg = el('svg', {
      viewBox: '0 0 ' + W + ' ' + H, width: '100%', height: H,
      role: 'img', 'font-family': "'Noto Sans KR',system-ui,sans-serif"
    });
    var kinds = {};
    chart.groups.forEach(function (g) { kinds[g.kind] = 1; });

    var legend;
    if (kinds.pieChart || kinds.doughnutChart) {
      var g0 = chart.groups[0];
      legend = drawPie(svg, W, H, g0, !!kinds.doughnutChart);
    } else if (kinds.radarChart) {
      legend = drawRadar(svg, W, H, chart.groups[0], pickCats(chart.groups));
    } else {
      legend = drawXY(svg, W, H, chart.groups, pickCats(chart.groups));
    }

    var wrap = document.createElement('div');
    wrap.className = 'chart';
    if (chart.title) {
      var t = document.createElement('div');
      t.className = 'ctitle';
      t.textContent = chart.title;
      wrap.appendChild(t);
    }
    wrap.appendChild(svg);

    /* 범례 — 계열이 2개 이상이면 항상 표출 */
    var uniq = [], seen = {};
    legend.forEach(function (x) {
      if (!x.label) return;
      var k = x.label + '|' + x.color;
      if (seen[k]) return;
      seen[k] = 1;
      uniq.push(x);
    });
    if (uniq.length >= 2) {
      var lg = document.createElement('div');
      lg.className = 'clegend';
      uniq.forEach(function (x) {
        var s = document.createElement('span');
        s.innerHTML = '<i style="background:' + x.color + '"></i>' + x.label;
        lg.appendChild(s);
      });
      wrap.appendChild(lg);
    }
    var ov = chart.groups.filter(function (g) { return g.override; })[0];
    if (ov) {
      var n2 = document.createElement('div');
      n2.className = 'cnote';
      n2.textContent = '※ ' + ov.override;
      wrap.appendChild(n2);
    }
    container.appendChild(wrap);
  }

  global.LMPChart = { render: render };
})(window);
