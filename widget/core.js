/* Расчётное ядро виджета: без DOM, только данные → числа. Разделы ТЗ указаны в комментариях. */
(function (root) {
  'use strict';

  // Состояния перехода (раздел 3). order — порядок сегментов снизу вверх (раздел 6).
  var STATES = {
    keep: { label: '1→1', name: 'держится' },
    on:   { label: '0→1', name: 'включился', sym: '▲' },
    off:  { label: '1→0', name: 'выключился', sym: '▼' },
    idle: { label: '0→0', name: 'неактивен' },
    'new':  { label: 'новый', name: 'новый фактор', sym: '+' },
    gone: { label: 'выбыл', name: 'выбыл из модели', sym: '×' }
  };
  // Порядок групп снизу вверх. «Новый» с s_t = 1 стоит сразу за 0→1, чтобы закрашенная
  // часть оставалась сплошной и её верх совпадал с T_t / Σw (критерий приёмки 4);
  // «новый» с s_t = 0 и «выбыл» — в самом верху, как в разделе 6.
  var GROUP_ORDER = ['keep', 'on', 'new_on', 'off', 'idle', 'new_off', 'gone'];
  var CHANGED = { on: 1, off: 1, 'new': 1, gone: 1 };

  function Model(data) {
    this.data = data;
    this.dates = data.dates;
    this.factors = data.factors;
    this.models = data.models;
    this.dateIndex = {};
    for (var i = 0; i < data.dates.length; i++) this.dateIndex[data.dates[i]] = i;
    this._maps = {};
    this.weightDecimals = detectDecimals(data);
  }

  // Map factorIdx → строка [fi, s, w, v] для модели на дату; null, если строк нет.
  Model.prototype.rows = function (m, di) {
    var key = m + '@' + di;
    if (key in this._maps) return this._maps[key];
    var arr = this.data.sig[m] && this.data.sig[m][di];
    var map = null;
    if (arr && arr.length) {
      map = new Map();
      for (var i = 0; i < arr.length; i++) map.set(arr[i][0], arr[i]);
    }
    this._maps[key] = map;
    return map;
  };

  // Базовая дата по умолчанию: максимальная дата строго меньше t (раздел 3).
  Model.prototype.autoBase = function (ti) {
    return ti > 0 ? ti - 1 : -1;
  };

  Model.prototype.pred = function (m, di) {
    var p = this.data.pred[m];
    return { total: num(p.total[di]), thr: num(p.thr[di]) };
  };

  // Полное внешнее соединение строк signals на базовой дате и на t по factor.
  Model.prototype.compare = function (m, bi, ti) {
    var prev = this.rows(m, bi), cur = this.rows(m, ti);
    var res = {
      model: m, bi: bi, ti: ti,
      hasPrev: !!prev, hasCur: !!cur,
      items: [], byFactor: new Map()
    };
    if (!prev || !cur) return finish(this, res);
    var keys = new Set();
    prev.forEach(function (_, k) { keys.add(k); });
    cur.forEach(function (_, k) { keys.add(k); });
    var self = this;
    keys.forEach(function (fi) {
      var p = prev.get(fi), c = cur.get(fi);
      var it = {
        fi: fi,
        name: self.factors[fi],
        inPrev: !!p, inCur: !!c,
        sPrev: p ? p[1] : 0, sCur: c ? c[1] : 0,
        // отсутствующий сигнал = 0; вес отсутствующей стороны берётся с другой даты,
        // чтобы выбывание/появление не попадало в «изменение весов»
        wPrev: p ? p[2] : c[2], wCur: c ? c[2] : p[2],
        vPrev: p ? p[3] : null, vCur: c ? c[3] : null
      };
      it.state = !p ? 'new' : !c ? 'gone'
        : (it.sPrev === 1 ? (it.sCur === 1 ? 'keep' : 'off') : (it.sCur === 1 ? 'on' : 'idle'));
      it.group = it.state === 'new' ? (it.sCur === 1 ? 'new_on' : 'new_off') : it.state;
      it.w = it.inCur ? it.wCur : it.wPrev;            // вес для доли в столбце
      it.switchEffect = it.wCur * (it.sCur - it.sPrev); // w_t·(s_t − s_{t−1})
      it.weightEffect = (it.wCur - it.wPrev) * it.sPrev; // (w_t − w_{t−1})·s_{t−1}
      it.contrib = it.switchEffect + it.weightEffect;    // = w_t·s_t − w_{t−1}·s_{t−1}
      it.changed = !!CHANGED[it.state];
      res.items.push(it);
      res.byFactor.set(fi, it);
    });
    return finish(this, res);
  };

  function finish(model, res) {
    var items = res.items;
    var sumAbsW = 0, tPrev = 0, tCur = 0, sw = 0, we = 0, plus = 0, minus = 0, nOn = 0, nOff = 0;
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      sumAbsW += Math.abs(it.w);
      tPrev += it.wPrev * it.sPrev;
      tCur += it.wCur * it.sCur;
      sw += it.switchEffect;
      we += it.weightEffect;
      if (it.switchEffect > 0) { plus += it.switchEffect; nOn++; }
      if (it.switchEffect < 0) { minus -= it.switchEffect; nOff++; }
    }
    for (i = 0; i < items.length; i++) items[i].share = sumAbsW > 0 ? Math.abs(items[i].w) / sumAbsW : 0;
    res.sumW = sumAbsW;
    res.tPrevSig = tPrev;
    res.tCurSig = tCur;
    res.dT = tCur - tPrev;
    res.switchEffect = sw;
    res.weightEffect = we;
    res.plus = plus; res.minus = minus; res.nOn = nOn; res.nOff = nOff;
    res.predPrev = model.pred(res.model, res.bi);
    res.predCur = model.pred(res.model, res.ti);
    res.recon = reconcile(res, model.data.meta.config.eps_tolerance);
    res.segments = orderSegments(items);
    return res;
  }

  // Сверка (раздел 3): ε = ΔT_predictions − ΔT_signals, допуск относительно масштаба total.
  function reconcile(res, tol) {
    var pp = res.predPrev.total, pc = res.predCur.total;
    var out = { eps: null, ok: false, tol: null, levelPrev: null, levelCur: null, reason: null };
    if (!res.hasPrev || !res.hasCur) { out.reason = 'нет строк signals'; return out; }
    if (pp === null || pc === null) { out.reason = 'нет total в predictions'; return out; }
    var scale = Math.max(Math.abs(pp), Math.abs(pc), res.sumW, 1e-12);
    out.tol = tol * scale;
    out.eps = (pc - pp) - res.dT;
    out.levelPrev = pp - res.tPrevSig;
    out.levelCur = pc - res.tCurSig;
    out.ok = Math.abs(out.eps) <= out.tol;
    // уровни тоже должны сходиться: на них опираются маркеры столбца
    out.levelsOk = Math.abs(out.levelPrev) <= out.tol && Math.abs(out.levelCur) <= out.tol;
    if (!out.ok) out.reason = 'ΔT не сходится';
    else if (!out.levelsOk) out.reason = 'total ≠ Σw·s';
    return out;
  }

  function orderSegments(items) {
    var rank = {};
    GROUP_ORDER.forEach(function (g, i) { rank[g] = i; });
    var segs = items.slice().sort(function (a, b) {
      return (rank[a.group] - rank[b.group]) || (Math.abs(b.w) - Math.abs(a.w)) || cmpStr(a.name, b.name);
    });
    var acc = 0;
    for (var i = 0; i < segs.length; i++) {
      segs[i].y0 = acc;               // нижняя граница, доля от Σw
      acc += segs[i].share;
      segs[i].y1 = acc;
    }
    return segs;
  }

  // Раскладка подписей столбца (раздел 6): мелкие сегменты без подписи,
  // серии из > 3 подряд таких сегментов одного состояния — одна строка «прочие … (k)».
  function labelLayout(segments, heightPx, minShare) {
    var rows = [], i = 0;
    while (i < segments.length) {
      var s = segments[i];
      if (s.share >= minShare) { rows.push({ kind: 'one', seg: s, y0: s.y0, y1: s.y1 }); i++; continue; }
      var j = i;
      while (j < segments.length && segments[j].share < minShare && segments[j].state === s.state) j++;
      var run = segments.slice(i, j);
      if (run.length > 3) {
        rows.push({
          kind: 'merged', segs: run, state: s.state, y0: run[0].y0, y1: run[run.length - 1].y1,
          w: run.reduce(function (a, r) { return a + r.w; }, 0)
        });
      } else {
        run.forEach(function (r) { rows.push({ kind: 'hidden', seg: r, y0: r.y0, y1: r.y1 }); });
      }
      i = j;
    }
    rows.forEach(function (r) {
      r.top = (1 - r.y1) * heightPx;
      r.height = (r.y1 - r.y0) * heightPx;
    });
    return rows;
  }

  // Две подписи маркеров справа: если ближе minGap px — вторая сдвигается.
  function spreadLabels(ys, minGap, lo, hi) {
    var idx = ys.map(function (y, i) { return i; }).sort(function (a, b) { return ys[a] - ys[b]; });
    var out = ys.slice();
    for (var k = 1; k < idx.length; k++) {
      var a = idx[k - 1], b = idx[k];
      if (out[b] - out[a] < minGap) out[b] = out[a] + minGap;
    }
    // если упёрлись в низ — сдвигаем всю пачку вверх
    var over = out[idx[idx.length - 1]] - hi;
    if (over > 0) for (k = 0; k < idx.length; k++) out[idx[k]] -= over;
    for (k = 0; k < out.length; k++) out[k] = Math.max(lo, out[k]);
    return out;
  }

  // Сводная таблица (раздел 7): строка = фактор из объединения двух моделей.
  Model.prototype.summary = function (cmpA, cmpB) {
    var names = new Map();
    [cmpA, cmpB].forEach(function (c) { c.items.forEach(function (it) { names.set(it.fi, true); }); });
    var rows = [];
    var self = this;
    names.forEach(function (_, fi) {
      var a = cmpA.byFactor.get(fi), b = cmpB.byFactor.get(fi);
      var src = a || b;
      var vPrev = a && a.inPrev ? a.vPrev : (b && b.inPrev ? b.vPrev : src.vPrev);
      var vCur = a && a.inCur ? a.vCur : (b && b.inCur ? b.vCur : src.vCur);
      var d = delta(vPrev, vCur);
      var diverged = !!(a && b && a.state !== b.state);
      var changed = !!((a && a.changed) || (b && b.changed));
      rows.push({
        fi: fi, name: self.factors[fi], a: a || null, b: b || null,
        vPrev: vPrev, vCur: vCur, dAbs: d.abs, dRel: d.rel,
        diverged: diverged, changed: changed,
        group: diverged ? 0 : changed ? 1 : 2,
        weight: Math.max(a ? Math.abs(a.contrib) : 0, b ? Math.abs(b.contrib) : 0)
      });
    });
    rows.sort(function (x, y) {
      if (x.group !== y.group) return x.group - y.group;
      if (x.group === 0 && x.changed !== y.changed) return x.changed ? -1 : 1;
      if (x.group < 2 && x.weight !== y.weight) return y.weight - x.weight;
      var rx = x.dRel === null ? -1 : Math.abs(x.dRel), ry = y.dRel === null ? -1 : Math.abs(y.dRel);
      return (ry - rx) || cmpStr(x.name, y.name);
    });
    return rows;
  };

  // Окно спарклайна: N точек данных, заканчивающихся на t; расширяется, чтобы включить базовую дату.
  function sparkWindow(ti, bi, n) {
    var start = Math.max(0, ti - n + 1);
    if (bi >= 0 && bi < start) start = bi;
    var out = [];
    for (var i = start; i <= ti; i++) out.push(i);
    return out;
  }

  // Значение фактора на дату: из строки модели m, иначе из любой другой модели (допущение 4).
  Model.prototype.factorValue = function (fi, di, prefer) {
    var order = prefer ? [prefer].concat(this.models) : this.models;
    for (var k = 0; k < order.length; k++) {
      var map = this.rows(order[k], di);
      if (map && map.has(fi)) return map.get(fi)[3];
    }
    return null;
  };

  Model.prototype.factorSignal = function (m, fi, di) {
    var map = this.rows(m, di);
    return map && map.has(fi) ? map.get(fi)[1] : null;
  };

  function delta(a, b) {
    if (typeof a !== 'number' || typeof b !== 'number') return { abs: null, rel: null };
    return { abs: b - a, rel: a !== 0 ? (b - a) / Math.abs(a) : null };
  }

  // Сколько знаков после запятой нужно, чтобы показать все веса точно (от 2 до 4).
  function detectDecimals(data) {
    var ws = [];
    Object.keys(data.sig).forEach(function (m) {
      (data.sig[m] || []).forEach(function (rows) {
        if (rows) for (var i = 0; i < rows.length && ws.length < 5000; i++) ws.push(rows[i][2]);
      });
    });
    for (var d = 2; d <= 4; d++) {
      var f = Math.pow(10, d), ok = true;
      for (var i = 0; i < ws.length; i++) {
        if (Math.abs(ws[i] * f - Math.round(ws[i] * f)) > 1e-6) { ok = false; break; }
      }
      if (ok) return d;
    }
    return 4;
  }

  function num(v) { return typeof v === 'number' && isFinite(v) ? v : null; }
  function cmpStr(a, b) { return a < b ? -1 : a > b ? 1 : 0; }

  var api = {
    Model: Model, STATES: STATES, GROUP_ORDER: GROUP_ORDER,
    labelLayout: labelLayout, spreadLabels: spreadLabels, sparkWindow: sparkWindow, delta: delta
  };
  root.PairCore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : this);
