/* Интерфейс виджета: управление, четыре блока, подсказка, синхронизация с hash URL. */
(function () {
  'use strict';

  var Core = window.PairCore;
  var DATA = JSON.parse(document.getElementById('payload').textContent);
  var M = new Core.Model(DATA);
  var CFG = DATA.meta.config;
  var DATES = DATA.dates;
  var N = DATES.length;
  var STATES = Core.STATES;

  var COL_H = 600;        // высота столбца, px (6 px на 1% веса)
  var MIN_SHARE = 15 / COL_H; // сегмент ниже строки текста (15 px ≈ 2.5% веса) — подпись скрыта
  var MARK_GAP = 14;      // минимальное расстояние между подписями маркеров, px
  var BAR_X = 8, BAR_W = 80, SVG_W = 190;
  var MINUS = '−';

  var dW = M.weightDecimals;
  var dN = Math.max(dW, thresholdDecimals());

  var state = null;       // {m1, m2, ti, base: 'auto' | индекс даты}
  var ui = { sel: null, showAll: {}, onlyChanged: true, note: '' };
  var view = null;        // последний расчёт {bi, c1, c2}

  // ── Форматирование ──────────────────────────────────────
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  // Подпись фактора: описание из маппера (sans), иначе исходное имя (mono).
  function fLabel(x) {
    return '<span class="' + (x.desc ? 'fd' : 'fc') + '">' + esc(x.label) + '</span>';
  }
  // title подписи: описание и исходное имя factor (отключается factor_code_in_title: false)
  function fTitle(x) { return esc(x.desc && CFG.factor_code_in_title ? x.desc + ' · ' + x.name : x.label); }
  function isNum(x) { return typeof x === 'number' && isFinite(x); }
  function fx(x, d) {
    if (!isNum(x)) return '—';
    d = d === undefined ? dN : d;
    var s = Math.abs(x).toFixed(d);
    return (x < 0 && +s !== 0 ? MINUS : '') + s;
  }
  function fs(x, d) {
    if (!isNum(x)) return '—';
    d = d === undefined ? dN : d;
    var s = Math.abs(x).toFixed(d);
    if (+s === 0) return s;
    return (x > 0 ? '+' : MINUS) + s;
  }
  function fw(x) { return fx(x, dW); }
  function fws(x) { return fs(x, dW); }
  function fpct(r) {
    if (!isNum(r)) return '—';
    var v = r * 100;
    return fs(v, Math.abs(v) < 10 ? 1 : 0) + '%';
  }
  function fval(v) {
    if (v === null || v === undefined) return '—';
    if (!isNum(v)) return String(v);
    if (Number.isInteger(v)) return String(v).replace('-', MINUS);
    var a = Math.abs(v);
    var d = a >= 1000 ? 0 : a >= 100 ? 1 : a >= 1 ? 2 : a >= 0.01 ? 3 : 4;
    return String(Number(v.toFixed(d))).replace('-', MINUS);
  }
  function fvalSigned(v) {
    if (!isNum(v)) return '—';
    var s = fval(Math.abs(v));
    return +Math.abs(v).toFixed(6) === 0 ? '0' : (v > 0 ? '+' : MINUS) + s;
  }
  function fexp(x) {
    if (!isNum(x)) return '—';
    if (x === 0) return '0';
    return x.toExponential(1).replace('-', MINUS).replace('e' + MINUS, 'e−').replace('e+', 'e');
  }
  function cls(x) { return !isNum(x) || Math.abs(x) < 1e-12 ? 'zero' : x > 0 ? 'pos' : 'neg'; }
  function thresholdDecimals() {
    var vals = [];
    DATA.models.forEach(function (m) { vals = vals.concat(DATA.pred[m].thr.filter(isNum)); });
    for (var d = 2; d <= 4; d++) {
      var f = Math.pow(10, d);
      if (vals.every(function (v) { return Math.abs(v * f - Math.round(v * f)) < 1e-6; })) return d;
    }
    return 4;
  }

  // ── Состояние и hash URL (раздел 4) ─────────────────────
  function defaultPair(m1, m2) {
    if (m1 !== m2) return [m1, m2];
    var alt = [CFG.default_model_2, CFG.default_model_1].concat(DATA.models)
      .filter(function (m) { return m !== m1; })[0];
    return [m1, alt];
  }
  function parseHash(hash, notes) {
    var p = new URLSearchParams(String(hash || '').replace(/^#/, ''));
    var s = { m1: CFG.default_model_1, m2: CFG.default_model_2, ti: N - 1, base: 'auto' };
    var m1 = p.get('m1'), m2 = p.get('m2'), d = p.get('d'), b = p.get('b');
    if (m1 && DATA.models.indexOf(m1) >= 0) s.m1 = m1;
    if (m2 && DATA.models.indexOf(m2) >= 0) s.m2 = m2;
    var pair = defaultPair(s.m1, s.m2);
    s.m1 = pair[0]; s.m2 = pair[1];
    if (d) {
      var di = M.dateIndex[d];
      if (di !== undefined && di >= 1) s.ti = di;
      else if (notes) notes.push('Дата ' + d + ' из ссылки недоступна как отчётная — выбрана ' + DATES[s.ti] + '.');
    }
    if (b && b !== 'auto') {
      var bi = M.dateIndex[b];
      if (bi !== undefined && bi < s.ti) s.base = bi;
      else if (notes) notes.push('Базовая дата ' + b + ' из ссылки недоступна — включён режим «авто».');
    }
    return s;
  }
  function stateToHash(s) {
    return 'm1=' + s.m1 + '&m2=' + s.m2 + '&d=' + DATES[s.ti] + '&b=' + (s.base === 'auto' ? 'auto' : DATES[s.base]);
  }
  function baseIndex(s) { return s.base === 'auto' ? M.autoBase(s.ti) : s.base; }

  function setState(patch) {
    var next = Object.assign({}, state, patch);
    ui.note = '';
    if (patch.ti !== undefined && next.base !== 'auto' && next.base >= next.ti) {
      ui.note = 'Базовая дата ' + DATES[next.base] + ' не раньше отчётной ' + DATES[next.ti] +
        ' — сравнение переключено на «предыдущая дата (авто)».';
      next.base = 'auto';
    }
    if (next.m1 === next.m2) return;
    state = next;
    render();
  }

  function compute(s) {
    var bi = baseIndex(s);
    return { bi: bi, c1: M.compare(s.m1, bi, s.ti), c2: M.compare(s.m2, bi, s.ti) };
  }

  // ── Управление ──────────────────────────────────────────
  function buildControls() {
    ['m1', 'm2'].forEach(function (slot) {
      var g = document.querySelector('.seg-group[data-slot="' + slot + '"]');
      g.innerHTML = DATA.models.map(function (m, i) {
        var start = i > 0 && m.split('_')[0] !== DATA.models[i - 1].split('_')[0];
        return '<button type="button" class="seg-btn' + (start ? ' group-start' : '') + '" data-model="' + m + '">' + m + '</button>';
      }).join('');
      g.addEventListener('click', function (e) {
        var b = e.target.closest('button[data-model]');
        if (!b || b.disabled) return;
        var patch = {}; patch[slot] = b.getAttribute('data-model');
        setState(patch);
      });
    });
    document.getElementById('swap').addEventListener('click', function () {
      setState({ m1: state.m2, m2: state.m1 });
    });
    var dateSel = document.getElementById('date');
    var opts = [];
    for (var i = N - 1; i >= 1; i--) opts.push('<option value="' + i + '">' + DATES[i] + '</option>');
    dateSel.innerHTML = opts.join('');
    dateSel.addEventListener('change', function () { setState({ ti: +dateSel.value }); });
    document.getElementById('date-prev').addEventListener('click', function () {
      if (state.ti > 1) setState({ ti: state.ti - 1 });
    });
    document.getElementById('date-next').addEventListener('click', function () {
      if (state.ti < N - 1) setState({ ti: state.ti + 1 });
    });
    document.getElementById('base').addEventListener('change', function (e) {
      var v = e.target.value;
      setState({ base: v === 'auto' ? 'auto' : +v });
    });
    document.getElementById('only-changed').addEventListener('change', function (e) {
      ui.onlyChanged = e.target.checked;
      renderSummary(view);
      applySelection();
    });
  }

  function syncControls() {
    ['m1', 'm2'].forEach(function (slot) {
      var other = slot === 'm1' ? state.m2 : state.m1;
      document.querySelectorAll('.seg-group[data-slot="' + slot + '"] button').forEach(function (b) {
        var m = b.getAttribute('data-model');
        b.setAttribute('aria-pressed', String(m === state[slot]));
        b.disabled = m === other;
        b.title = m === other ? 'Уже выбрана как ' + (slot === 'm1' ? 'модель 2' : 'модель 1') : '';
      });
    });
    document.getElementById('date').value = String(state.ti);
    document.getElementById('date-prev').disabled = state.ti <= 1;
    document.getElementById('date-next').disabled = state.ti >= N - 1;
    var auto = M.autoBase(state.ti);
    var opts = ['<option value="auto">предыдущая · ' + DATES[auto] + ' (авто)</option>'];
    for (var i = state.ti - 1; i >= 0; i--) opts.push('<option value="' + i + '">' + DATES[i] + '</option>');
    var sel = document.getElementById('base');
    sel.innerHTML = opts.join('');
    sel.value = state.base === 'auto' ? 'auto' : String(state.base);
    document.getElementById('base-note').textContent = ui.note;
  }

  // ── Блок 1: итоги моделей на базовой дате и на t ────────
  function renderBlock1(v) {
    document.getElementById('b1-title').textContent = 'Итоги моделей: ' + DATES[v.bi] + ' → ' + DATES[state.ti];
    document.getElementById('b1-grid').innerHTML = modelCard(v.c1, v.bi) + modelCard(v.c2, v.bi);
    var lines = [v.c1, v.c2].map(reconLine);
    lines.push('<span class="hint">Пунктир на спарклайне — порог; пустая точка — базовая дата, заполненная — отчётная.</span>');
    document.getElementById('b1-recon').innerHTML = lines.join('');
  }

  function fired(p) { return isNum(p.total) && isNum(p.thr) ? p.total >= p.thr : null; }

  function modelCard(c, bi) {
    var pp = c.predPrev, pc = c.predCur;
    var fp = fired(pp), fc = fired(pc);
    var crossed = fp !== null && fc !== null && fp !== fc;
    var badge = crossed
      ? (fc ? '<span class="badge cross up">▲ пересекла порог вверх — сработала</span>'
            : '<span class="badge cross down">▼ пересекла порог вниз — перестала срабатывать</span>')
      : '<span class="badge neutral hint">решение не изменилось' + (fc === null ? '' : fc ? ' · сработала' : ' · не сработала') + '</span>';
    var dT = isNum(pp.total) && isNum(pc.total) ? pc.total - pp.total : null;
    var arrow = !isNum(dT) || Math.abs(dT) < 1e-12 ? '→' : dT > 0 ? '↑' : '↓';
    return '<div class="panel model-card' + (crossed ? (fc ? ' crossed-up' : ' crossed-down') : '') + '">' +
      '<div class="card-head"><span class="model-name">' + c.model + '</span>' + badge + '</div>' +
      '<div class="tgrid">' +
        '<span class="h"></span><span class="h">total</span><span class="h">порог</span><span class="h">до порога</span><span class="h">решение</span>' +
        totalRow(bi, pp, false) +
        '<div class="delta-row ' + cls(dT) + '"><span aria-hidden="true">' + arrow + '</span><span>ΔT = ' + fs(dT) + '</span></div>' +
        totalRow(state.ti, pc, true) +
      '</div>' +
      '<div class="card-foot"><span class="muted small hint">total и порог, ' + Core.sparkWindow(state.ti, bi, CFG.total_spark_points).length + ' точек</span>' +
        sparkTotal(c.model, state.ti, bi) + '</div>' +
    '</div>';
  }

  function totalRow(di, p, cur) {
    var f = fired(p);
    var dist = isNum(p.total) && isNum(p.thr) ? p.total - p.thr : null;
    var pct = isNum(dist) && p.thr !== 0 ? dist / Math.abs(p.thr) : null;
    var k = f === null ? 'zero' : f ? 'fired' : 'unfired';
    return '<span class="d' + (cur ? ' cur' : '') + '">' + DATES[di] + '</span>' +
      '<span class="big' + (cur ? ' cur' : '') + '">' + (isNum(p.total) ? fx(p.total) : '<span class="muted small">нет данных</span>') + '</span>' +
      '<span class="mono">' + fx(p.thr) + '</span>' +
      '<span class="mono ' + k + '">' + fs(dist) + (isNum(pct) ? ' <span class="small">(' + fpct(pct) + ')</span>' : '') + '</span>' +
      '<span class="' + k + '">' + (f === null ? '—' : f ? '✓ сработала' : '✕ не сработала') + '</span>';
  }

  function reconLine(c) {
    var r = c.recon;
    if (r.eps === null) {
      return '<span class="bad">⚠ ' + c.model + ': сверка с predictions невозможна — ' + esc(r.reason) + '.</span>';
    }
    var bad = !r.ok || !r.levelsOk;
    var s = c.model + ': ε = ΔT<sub>predictions</sub> − ΔT<sub>signals</sub> = ';
    // шум плавающей точки в пределах допуска показываем как 0, точное значение — в подсказке
    if (r.ok) s += r.eps === 0 ? '0' : '<span title="' + r.eps + '">0</span> <span class="muted">(|ε| ≤ ' + fexp(r.tol) + ')</span>';
    else s += fexp(r.eps) + ' — больше допуска ' + fexp(r.tol);
    if (!r.levelsOk) s += '; total ≠ Σw·s: на базовой ' + fexp(r.levelPrev) + ', на t ' + fexp(r.levelCur);
    // сошедшаяся сверка — пояснение (скрывается show_hints: false), несошедшаяся — всегда видна
    return '<span class="' + (bad ? 'bad">⚠ ' : 'hint">') + s + '</span>';
  }

  function sparkTotal(m, ti, bi) {
    var idx = Core.sparkWindow(ti, bi, CFG.total_spark_points);
    var W = 240, H = 44, P = 4;
    var tot = idx.map(function (i) { return DATA.pred[m].total[i]; });
    var thr = idx.map(function (i) { return DATA.pred[m].thr[i]; });
    var all = tot.concat(thr).filter(isNum);
    if (!all.length) return '';
    var lo = Math.min.apply(null, all), hi = Math.max.apply(null, all);
    if (hi - lo < 1e-12) { lo -= 1; hi += 1; }
    var x = function (k) { return P + (W - 2 * P) * (idx.length > 1 ? k / (idx.length - 1) : 0.5); };
    var y = function (v) { return P + (H - 2 * P) * (1 - (v - lo) / (hi - lo)); };
    var out = '<svg class="spark-total" width="' + W + '" height="' + H + '" role="img" aria-label="Динамика total и порога ' + m + '">';
    out += polylines(thr, x, y, 'thr') + polylines(tot, x, y, 'line');
    idx.forEach(function (di, k) {
      if (!isNum(tot[k])) return;
      var c = di === ti ? 'pt-cur' : di === bi ? 'pt-base' : null;
      if (c) out += '<circle class="' + c + '" cx="' + x(k).toFixed(1) + '" cy="' + y(tot[k]).toFixed(1) + '" r="' + (c === 'pt-cur' ? 3.5 : 3) + '"></circle>';
      out += '<circle class="hit" cx="' + x(k).toFixed(1) + '" cy="' + y(tot[k]).toFixed(1) + '" r="5"><title>' + DATES[di] +
        ': total ' + fx(tot[k]) + ', порог ' + fx(thr[k]) + '</title></circle>';
    });
    return out + '</svg>';
  }

  function polylines(vals, x, y, klass) {
    var out = '', pts = [];
    function flush() {
      if (pts.length > 1) out += '<polyline class="' + klass + '" points="' + pts.join(' ') + '"></polyline>';
      pts = [];
    }
    vals.forEach(function (v, k) {
      if (isNum(v)) pts.push(x(k).toFixed(1) + ',' + y(v).toFixed(1)); else flush();
    });
    flush();
    return out;
  }

  // ── Блок 2: 100%-столбцы переходов ──────────────────────
  function renderBlock2(v) {
    document.getElementById('b2-cols').innerHTML = column(v.c1, v.bi) + column(v.c2, v.bi);
  }

  function missingText(c) {
    var miss = [];
    if (!c.hasPrev) miss.push(DATES[c.bi]);
    if (!c.hasCur) miss.push(DATES[c.ti]);
    return 'Нет строк signals для ' + c.model + ' на ' + miss.join(' и ') +
      ' — столбец не строится. Итоги в блоке выше посчитаны по листу predictions.';
  }

  function column(c) {
    var head = '<div class="col-head" style="padding-right:' + (SVG_W - BAR_X - BAR_W) + 'px"><span class="model-name">' + c.model + '</span>';
    if (!c.hasPrev || !c.hasCur) return '<div class="col">' + head + '</div><div class="col-msg bad">' + esc(missingText(c)) + '</div></div>';
    head += '<span class="stats">Σw ' + fw(c.sumW) + ' · total ' + fx(c.tCurSig) + '</span></div>';
    if (!(c.sumW > 0)) return '<div class="col">' + head + '<div class="col-msg">Σ|w| = 0 — столбец не строится.</div></div>';

    var rows = Core.labelLayout(c.segments, COL_H, MIN_SHARE);
    var labels = '';
    rows.forEach(function (r, k) {
      if (r.kind === 'hidden') return;
      var style = 'top:' + r.top.toFixed(2) + 'px;height:' + r.height.toFixed(2) + 'px';
      if (r.kind === 'merged') {
        labels += '<div class="lbl merged" style="' + style + '" data-m="' + c.model + '" data-merged="' + k + '">' +
          '<span class="nm">прочие ' + STATES[r.state].label + ' (' + r.segs.length + ')</span><span class="w">' + fw(r.w) + '</span></div>';
        return;
      }
      var s = r.seg, st = STATES[s.state];
      labels += '<div class="lbl' + (s.state === 'idle' || s.state === 'gone' ? ' dim' : '') + '" style="' + style +
        '" data-m="' + c.model + '" data-f="' + s.fi + '">' +
        (st.sym ? '<span class="sym ' + s.state + '" aria-hidden="true">' + st.sym + '</span>' : '') +
        '<span class="nm' + (s.desc ? ' fd' : '') + '">' + esc(s.label) + '</span><span class="w">' + fw(s.w) + '</span></div>';
    });

    var svg = '<svg class="bar" width="' + SVG_W + '" height="' + COL_H + '" role="img" aria-label="Доли весов факторов ' + c.model + '">';
    c.segments.forEach(function (s) {
      var y = (1 - s.y1) * COL_H, h = s.share * COL_H;
      var gap = h > 2 ? 1 : 0;
      svg += '<rect class="sg s-' + s.group + '" x="' + BAR_X + '" y="' + (y + gap).toFixed(2) + '" width="' + BAR_W +
        '" height="' + Math.max(h - gap, 0.5).toFixed(2) + '" data-m="' + c.model + '" data-f="' + s.fi + '"></rect>';
    });
    var markersOk = c.recon.ok && c.recon.levelsOk;
    var note = '';
    if (markersOk) {
      var ys = [], texts = [];
      var thr = c.predCur.thr;
      if (isNum(thr)) {
        var rt = thr / c.sumW;
        ys.push(COL_H * (1 - clamp(rt, 0, 1)));
        texts.push({ k: 'thr', t: 'порог ' + fx(thr) + (rt > 1 ? ' ↑' : '') });
      }
      ys.push(COL_H * (1 - clamp(c.tPrevSig / c.sumW, 0, 1)));
      texts.push({ k: 'prev', t: 'было ' + fx(c.tPrevSig) });
      var ly = Core.spreadLabels(ys, MARK_GAP, 6, COL_H - 6);
      ys.forEach(function (y, k) {
        svg += '<line class="' + (texts[k].k === 'thr' ? 'mk-thr' : 'mk-prev') + '" x1="' + (BAR_X - 6) + '" x2="' + (BAR_X + BAR_W + 6) +
          '" y1="' + y.toFixed(2) + '" y2="' + y.toFixed(2) + '"></line>';
        svg += '<text class="mk-txt ' + texts[k].k + '" x="' + (BAR_X + BAR_W + 10) + '" y="' + ly[k].toFixed(2) + '">' + texts[k].t + '</text>';
      });
    } else {
      note = '<div class="col-msg bad">Маркеры порога и прошлого total скрыты: сверка с листом predictions не сошлась (см. блок выше).</div>';
    }
    svg += '</svg>';

    var we = Math.abs(c.weightEffect) > 1e-12
      ? ' <span class="' + cls(c.weightEffect) + '">' + fws(c.weightEffect) + '</span> <span class="muted small">(веса)</span>' : '';
    var decomp = '<div class="decomp"><span class="pos">+' + fw(c.plus) + '</span> <span class="neg">' + MINUS + fw(c.minus) + '</span>' + we +
      ' = <span class="total ' + cls(c.dT) + '">ΔT ' + fs(c.dT) + '</span>' +
      ' <span class="muted small hint">· включилось ' + c.nOn + ', выключилось ' + c.nOff + '</span></div>';

    return '<div class="col">' + head +
      '<div class="chart" style="height:' + COL_H + 'px"><div class="labels" style="right:' + SVG_W + 'px">' + labels + '</div>' + svg + '</div>' +
      note + decomp + '</div>';
  }

  function clamp(x, a, b) { return Math.max(a, Math.min(b, x)); }

  function renderLegend() {
    var items = [
      ['s-on', '▲ 0→1 включился'], ['s-off', '▼ 1→0 выключился'], ['s-keep', '1→1 держится'],
      ['s-idle', '0→0 неактивен'], ['s-new', '+ новый в модели'], ['s-gone', '× выбыл из модели']
    ];
    var html = items.map(function (it) {
      return '<span class="it"><span class="sw ' + it[0] + '"></span>' + it[1] + '</span>';
    }).join('');
    html += '<span class="it"><span class="ln"></span>порог на отчётную дату</span>';
    html += '<span class="it"><span class="ln dash"></span>total на базовой дате</span>';
    html += '<span class="hint">число справа от имени — вес фактора</span>';
    html += '<span class="palette"><span>Палитра</span><span class="seg-group" role="group" aria-label="Палитра">' +
      '<button type="button" class="seg-btn" data-palette="default">зелёный / красный</button>' +
      '<button type="button" class="seg-btn" data-palette="cb">синий / оранжевый</button></span></span>';
    var el = document.getElementById('legend');
    el.innerHTML = html;
    el.addEventListener('click', function (e) {
      var b = e.target.closest('button[data-palette]');
      if (b) setPalette(b.getAttribute('data-palette'));
    });
  }

  function setPalette(p) {
    if (p === 'cb') document.documentElement.setAttribute('data-palette', 'cb');
    else document.documentElement.removeAttribute('data-palette');
    try { localStorage.setItem('pair-dashboard.palette', p); } catch (e) { /* хранилище недоступно */ }
    document.querySelectorAll('button[data-palette]').forEach(function (b) {
      b.setAttribute('aria-pressed', String(b.getAttribute('data-palette') === p));
    });
  }

  // ── Таблицы изменившихся факторов (раздел 7) ────────────
  function renderTables(v) {
    document.getElementById('block3').innerHTML = changeTable(v.c1, v.bi) + changeTable(v.c2, v.bi);
  }

  function stBadge(it) {
    if (!it) return '<span class="dash">—</span>';
    var st = STATES[it.state];
    return '<span class="st s-' + it.state + '" title="' + st.name + '">' + (st.sym ? st.sym + ' ' : '') + st.label + '</span>';
  }

  function changeTable(c, bi) {
    var m = c.model, all = !!ui.showAll[m];
    var head = '<div class="sec-head"><h3><span class="mono">' + m + '</span>: сменили сигнал</h3>' +
      '<label class="check"><input type="checkbox" data-showall="' + m + '"' + (all ? ' checked' : '') + '> показать все</label></div>';
    if (!c.hasPrev || !c.hasCur) {
      return '<div class="panel tcard">' + head + '<div class="col-msg bad">' + esc(missingText(c)) + '</div></div>';
    }
    var nNew = 0, nGone = 0;
    c.items.forEach(function (it) { if (it.state === 'new') nNew++; if (it.state === 'gone') nGone++; });
    var sub = 'включилось ' + c.nOn + ' (+' + fw(c.plus) + ') · выключилось ' + c.nOff + ' (' + MINUS + fw(c.minus) + ')' +
      (nNew ? ' · новых в модели ' + nNew : '') + (nGone ? ' · выбыло из модели ' + nGone : '');
    var items = c.items.filter(function (it) { return all || it.changed; }).sort(function (a, b) {
      return (Math.abs(b.contrib) - Math.abs(a.contrib)) || (Math.abs(b.w) - Math.abs(a.w)) || (a.label < b.label ? -1 : 1);
    });
    var body;
    if (!items.length) {
      body = '<div class="empty">Сигналы факторов не менялись.</div>';
    } else {
      var noDT = Math.abs(c.dT) < 1e-12;
      body = '<div class="table-wrap"><table class="tbl"><thead><tr>' +
        '<th>Фактор</th><th>Переход</th>' +
        '<th class="num" title="Значение на базовой дате ' + DATES[bi] + '">' + shortDate(bi) + '</th>' +
        '<th class="num" title="Значение на отчётной дате ' + DATES[state.ti] + '">' + shortDate(state.ti) + '</th>' +
        '<th class="num" title="Изменение значения: абсолютное и относительное">Δ</th>' +
        '<th title="factor_value за ' + CFG.factor_spark_points + ' точек до отчётной даты">Динамика</th><th class="num">Вес</th>' +
        '<th class="num" title="w·(s_t − s_{t−1})">Вклад в ΔT</th><th class="num" title="Вклад / ΔT">Доля</th></tr></thead><tbody>' +
        items.map(function (it) {
          var d = Core.delta(it.vPrev, it.vCur);
          return '<tr data-f="' + it.fi + '" data-m="' + m + '">' +
            '<td class="fname" title="' + fTitle(it) + '"><div class="fn">' + fLabel(it) + '</div></td>' +
            '<td>' + stBadge(it) + '</td>' +
            '<td class="num">' + (it.inPrev ? esc(fval(it.vPrev)) : '<span class="dash">—</span>') + '</td>' +
            '<td class="num">' + (it.inCur ? esc(fval(it.vCur)) : '<span class="dash">—</span>') + '</td>' +
            '<td class="num">' + (d.abs === null ? '' : '<span class="two"><span>' + fvalSigned(d.abs) + '</span><span class="r">' + fpct(d.rel) + '</span></span>') + '</td>' +
            '<td>' + sparkFactor(m, it.fi, bi, true) + '</td>' +
            '<td class="num">' + fw(it.w) + '</td>' +
            '<td class="num ' + cls(it.contrib) + '">' + fws(it.contrib) + '</td>' +
            '<td class="num">' + (noDT ? '<span class="dash">—</span>' : fpct(it.contrib / c.dT)) + '</td></tr>';
        }).join('') + '</tbody></table></div>' +
        '<div class="tbl-foot hint">Столбцы дат — factor_value на базовой (' + DATES[bi] + ') и отчётной (' + DATES[state.ti] + ') дате. ' +
        'Динамика — ' + CFG.factor_spark_points + ' точек до отчётной даты: ● сигнал = 1, ○ сигнал = 0 в этой модели, вертикальные метки — базовая и отчётная даты. ' +
        'Доля — вклад / ΔT.</div>';
    }
    return '<div class="panel tcard">' + head + '<div class="sub">' + sub + '</div>' + body + '</div>';
  }

  // Короткая подпись даты в заголовке: без года, если он совпадает с годом отчётной даты.
  function shortDate(di) {
    var d = DATES[di];
    return d.slice(0, 4) === DATES[state.ti].slice(0, 4) ? d.slice(5) : d.slice(2);
  }

  // Спарклайн factor_value за N точек до t. withSignal: точки с signal = 1 закрашены.
  function sparkFactor(m, fi, bi, withSignal) {
    var ti = state.ti;
    var idx = Core.sparkWindow(ti, bi, CFG.factor_spark_points);
    var W = withSignal ? 72 : 120, H = 26, P = 4;
    var vals = idx.map(function (di) { return M.factorValue(fi, di, m); });
    var sigs = idx.map(function (di) { return withSignal ? M.factorSignal(m, fi, di) : null; });
    var numeric = vals.filter(isNum);
    var cats = null;
    if (!numeric.length) {
      cats = [];
      vals.forEach(function (v) { if (v !== null && cats.indexOf(v) < 0) cats.push(v); });
      cats.sort();
      if (!cats.length) return '';
    }
    var yv = vals.map(function (v) { return cats ? (v === null ? null : cats.indexOf(v)) : (isNum(v) ? v : null); });
    var present = yv.filter(function (v) { return v !== null; });
    var lo = Math.min.apply(null, present), hi = Math.max.apply(null, present);
    if (hi - lo < 1e-12) { lo -= 1; hi += 1; }
    var x = function (k) { return P + (W - 2 * P) * (idx.length > 1 ? k / (idx.length - 1) : 0.5); };
    var y = function (v) { return P + (H - 2 * P) * (1 - (v - lo) / (hi - lo)); };
    var out = '<svg class="spark" width="' + W + '" height="' + H + '" aria-hidden="true">';
    idx.forEach(function (di, k) {
      if (di === bi || di === ti) out += '<line class="tick" x1="' + x(k).toFixed(1) + '" x2="' + x(k).toFixed(1) + '" y1="0" y2="' + H + '"></line>';
    });
    out += polylines(yv, x, y, 'line');
    idx.forEach(function (di, k) {
      if (yv[k] === null) return;
      var klass, r;
      if (withSignal) {
        klass = sigs[k] === 1 ? 'p1' : 'p0';
        r = di === ti || di === bi ? 3 : 2;
      } else {
        if (di !== ti && di !== bi) return;
        klass = di === ti ? 'pt' : 'pb';
        r = di === ti ? 3 : 2.5;
      }
      out += '<circle class="' + klass + '" cx="' + x(k).toFixed(1) + '" cy="' + y(yv[k]).toFixed(1) + '" r="' + r + '"></circle>';
    });
    return out + '<title>' + idx.map(function (di, k) {
      return DATES[di] + ': ' + fval(vals[k]) + (withSignal && sigs[k] !== null ? ' (s=' + sigs[k] + ')' : '');
    }).map(esc).join('\n') + '</title></svg>';
  }

  // ── Сводная таблица факторов ────────────────────────────
  function renderSummary(v) {
    var wrap = document.getElementById('summary');
    var note = document.getElementById('summary-note');
    var c1 = v.c1, c2 = v.c2;
    if ((!c1.hasPrev || !c1.hasCur) && (!c2.hasPrev || !c2.hasCur)) {
      wrap.innerHTML = '<div class="col-msg bad">Нет строк signals ни для одной из моделей на выбранных датах.</div>';
      note.textContent = '';
      return;
    }
    var rows = M.summary(c1, c2);
    var shown = ui.onlyChanged ? rows.filter(function (r) { return r.changed; }) : rows;
    if (!shown.length) {
      wrap.innerHTML = '<div class="empty">Сигналы факторов не менялись.</div>';
    } else {
      wrap.innerHTML = '<table class="tbl"><thead><tr><th>Фактор</th><th class="num">' + DATES[v.bi] + '</th><th class="num">' + DATES[state.ti] + '</th>' +
        '<th class="num">Δ</th><th class="num">Δ%</th><th>Динамика, ' + CFG.factor_spark_points + ' точек</th>' +
        '<th>' + c1.model + '</th><th>' + c2.model + '</th></tr></thead><tbody>' +
        shown.map(function (r) {
          return '<tr data-f="' + r.fi + '"' + (r.diverged ? ' class="diverged"' : '') + '>' +
            '<td class="sname" title="' + fTitle(r) + '"><div class="fn">' + fLabel(r) +
              (r.diverged ? ' <span class="tag hint">· модели разошлись</span>' : '') + '</div></td>' +
            '<td class="num">' + esc(fval(r.vPrev)) + '</td><td class="num">' + esc(fval(r.vCur)) + '</td>' +
            '<td class="num">' + fvalSigned(r.dAbs) + '</td><td class="num">' + fpct(r.dRel) + '</td>' +
            '<td>' + sparkFactor(c1.byFactor.has(r.fi) ? c1.model : c2.model, r.fi, v.bi, false) + '</td>' +
            '<td>' + stBadge(r.a) + '</td><td>' + stBadge(r.b) + '</td></tr>';
        }).join('') + '</tbody></table>';
    }
    var hidden = rows.length - shown.length;
    var txt = 'Всего факторов в двух моделях: ' + rows.length + '. ';
    if (hidden) {
      var onlyA = 0, onlyB = 0;
      rows.forEach(function (r) {
        if (r.changed) return;
        if (r.a && !r.b) onlyA++;
        if (r.b && !r.a) onlyB++;
      });
      txt += 'Скрыто ' + hidden + ' без смены сигнала (из них ' + onlyA + ' только в ' + c1.model + ', ' + onlyB + ' только в ' + c2.model + '). ';
    }
    txt += 'Сверху — факторы, по которым модели разошлись; «—» — фактор не входит в модель.';
    note.textContent = txt;
  }

  // ── Проблемы данных ─────────────────────────────────────
  function renderIssues() {
    var items = DATA.issues || [];
    var el = document.getElementById('issues');
    if (!items.length) { el.innerHTML = ''; return; }
    var nErr = items.filter(function (i) { return i.level === 'error'; }).length;
    var html = '<details class="issues' + (nErr ? ' has-error' : '') + '"><summary>⚠ Проблемы в данных: ошибок ' + nErr +
      ', предупреждений ' + (items.length - nErr) + '. Расчёты могут быть неверны — подробности</summary>';
    items.forEach(function (it) {
      html += '<div class="issue"><div class="issue-msg"><span class="lvl-' + it.level + '">' +
        (it.level === 'error' ? 'ошибка' : 'предупреждение') + '</span><span>' + esc(it.message) + '</span></div>';
      if (it.rows && it.rows.length) {
        html += '<div class="table-wrap"><table><thead><tr>' + it.columns.map(function (c) { return '<th>' + esc(c) + '</th>'; }).join('') +
          '</tr></thead><tbody>' + it.rows.map(function (r) {
            return '<tr>' + r.map(function (v) { return '<td class="mono">' + esc(v === null ? '' : v) + '</td>'; }).join('') + '</tr>';
          }).join('') + '</tbody></table></div>';
        if (it.count > it.rows.length) html += '<div class="muted small">показаны первые ' + it.rows.length + ' из ' + it.count + '</div>';
      }
      html += '</div>';
    });
    el.innerHTML = html + '</details>';
  }

  // ── Подсказка и подсветка ───────────────────────────────
  var tip = document.getElementById('tooltip');

  function cmpFor(m) { return view && (view.c1.model === m ? view.c1 : view.c2.model === m ? view.c2 : null); }

  function tipFactor(c, it) {
    var st = STATES[it.state];
    var rows = [
      ['состояние', (st.sym ? st.sym + ' ' : '') + st.label + ' · ' + st.name],
      ['вес', fw(it.w)],
      ['доля', (it.share * 100).toFixed(1) + '% от Σw'],
      ['значение ' + DATES[c.bi], it.inPrev ? esc(it.vPrev === null ? '—' : String(it.vPrev)) : '— (нет в модели)'],
      ['значение ' + DATES[c.ti], it.inCur ? esc(it.vCur === null ? '—' : String(it.vCur)) : '— (нет в модели)'],
      ['вклад в ΔT', fws(it.contrib)]
    ];
    return '<div class="tt-name' + (it.desc ? ' fd' : '') + '">' + esc(it.label) + '</div>' +
      (it.desc && CFG.factor_code_in_title ? '<div class="tt-code">' + esc(it.name) + '</div>' : '') + '<div>' + c.model + '</div><table>' +
      rows.map(function (r) { return '<tr><td>' + r[0] + '</td><td class="mono">' + r[1] + '</td></tr>'; }).join('') + '</table>';
  }

  function tipMerged(c, r) {
    return '<div class="tt-name">прочие ' + STATES[r.state].label + ' (' + r.segs.length + ')</div><div>' + c.model + ' · Σw ' + fw(r.w) + '</div><table>' +
      r.segs.map(function (s) { return '<tr><td>' + fLabel(s) + '</td><td class="mono">' + fw(s.w) + '</td></tr>'; }).join('') + '</table>';
  }

  function showTip(html, e) {
    tip.innerHTML = html;
    tip.hidden = false;
    moveTip(e);
  }
  function moveTip(e) {
    if (tip.hidden) return;
    var pad = 14, r = tip.getBoundingClientRect();
    var x = e.clientX + pad, y = e.clientY + pad;
    if (x + r.width > window.innerWidth - 8) x = e.clientX - r.width - pad;
    if (y + r.height > window.innerHeight - 8) y = e.clientY - r.height - pad;
    tip.style.left = Math.max(8, x) + 'px';
    tip.style.top = Math.max(8, y) + 'px';
  }
  function hideTip() { tip.hidden = true; }

  function bindChartEvents() {
    var cols = document.getElementById('b2-cols');
    cols.addEventListener('mouseover', function (e) {
      var t = e.target.closest('[data-m]');
      if (!t) return;
      var c = cmpFor(t.getAttribute('data-m'));
      if (!c) return;
      if (t.hasAttribute('data-merged')) {
        var r = Core.labelLayout(c.segments, COL_H, MIN_SHARE)[+t.getAttribute('data-merged')];
        showTip(tipMerged(c, r), e);
      } else if (t.hasAttribute('data-f')) {
        var it = c.byFactor.get(+t.getAttribute('data-f'));
        if (it) showTip(tipFactor(c, it), e);
      }
    });
    cols.addEventListener('mousemove', moveTip);
    cols.addEventListener('mouseout', function (e) {
      if (!e.relatedTarget || !cols.contains(e.relatedTarget) || !e.relatedTarget.closest('[data-m]')) hideTip();
    });
    document.addEventListener('click', function (e) {
      var sa = e.target.closest('input[data-showall]');
      if (sa) {
        ui.showAll[sa.getAttribute('data-showall')] = sa.checked;
        renderTables(view);
        applySelection();
        return;
      }
      var t = e.target.closest('[data-f]');
      if (!t) return;
      var fi = +t.getAttribute('data-f');
      ui.sel = ui.sel === fi ? null : fi;
      applySelection();
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && ui.sel !== null) { ui.sel = null; applySelection(); }
    });
  }

  function applySelection() {
    document.querySelectorAll('[data-f]').forEach(function (el) {
      el.classList.toggle('is-sel', ui.sel !== null && +el.getAttribute('data-f') === ui.sel);
    });
  }

  // ── Главный цикл ────────────────────────────────────────
  function render() {
    view = compute(state);
    syncControls();
    renderBlock1(view);
    renderBlock2(view);
    renderTables(view);
    renderSummary(view);
    applySelection();
    var h = '#' + stateToHash(state);
    if (location.hash !== h) history.replaceState(null, '', h);
  }

  function init() {
    document.getElementById('meta').textContent = DATA.meta.source + (DATA.meta.mapper ? ' · описания: ' + DATA.meta.mapper : '') +
      ' · ' + N + ' дат · собрано ' + DATA.meta.built_at;
    if (CFG.show_hints === false) document.documentElement.classList.add('no-hints');
    var p = 'default';
    try { p = localStorage.getItem('pair-dashboard.palette') || 'default'; } catch (e) { /* хранилище недоступно */ }
    buildControls();
    renderLegend();
    setPalette(p);
    renderIssues();
    bindChartEvents();
    var notes = [];
    state = parseHash(location.hash, notes);
    ui.note = notes.join(' ');
    render();
    window.addEventListener('hashchange', function () {
      var n = [];
      state = parseHash(location.hash, n);
      ui.note = n.join(' ');
      render();
    });
  }

  window.PairDashboard = {
    data: DATA, model: M, config: CFG, COL_H: COL_H, MIN_SHARE: MIN_SHARE,
    parseHash: parseHash, stateToHash: stateToHash, compute: compute,
    getState: function () { return Object.assign({}, state); },
    setState: setState,
    getView: function () { return view; }
  };

  init();
})();
