/* Прогон критериев приёмки (раздел 8) прямо в браузере. Встраивается флагом --self-test. */
(function () {
  'use strict';
  var D = window.PairDashboard, Core = window.PairCore;
  var M = D.model, DATA = D.data, N = DATA.dates.length, DATES = DATA.dates;
  var fails = [], checks = 0;
  function check(ok, msg) { checks++; if (!ok && fails.length < 200) fails.push(msg); }
  function rawTotal(m, di) {
    var rows = DATA.sig[m][di];
    return rows ? rows.reduce(function (a, r) { return a + r[1] * r[2]; }, 0) : null;
  }
  var INCL = { keep: 1, on: 1, new_on: 1 };
  var rank = {};
  Core.GROUP_ORDER.forEach(function (g, i) { rank[g] = i; });
  var saved = D.getState();
  var savedHash = location.hash;

  // К1: при открытии — максимальная дата, базовая «авто» = предыдущая доступная.
  var s0 = D.parseHash('', []);
  check(s0.ti === N - 1 && s0.base === 'auto' && M.autoBase(s0.ti) === N - 2, 'К1: начальное состояние ' + JSON.stringify(s0));

  // К2–К5 на уровне данных: все модели × все t × все базовые даты.
  var nCmp = 0, epsBad = 0, skipped = 0;
  DATA.models.forEach(function (m) {
    for (var ti = 1; ti < N; ti++) {
      for (var bi = 0; bi < ti; bi++) {
        var c = M.compare(m, bi, ti);
        nCmp++;
        if (!c.hasPrev || !c.hasCur) { skipped++; continue; }
        var tag = m + ' ' + DATES[bi] + '→' + DATES[ti];
        var dRaw = rawTotal(m, ti) - rawTotal(m, bi);
        // К2: Σw(0→1) − Σw(1→0) + эффект весов = ΔT из signals (новые/выбывшие — как включение/выключение)
        var on = 0, off = 0;
        c.items.forEach(function (it) {
          if (it.sPrev === 0 && it.sCur === 1) on += it.wCur;
          if (it.sPrev === 1 && it.sCur === 0) off += it.wCur;
        });
        check(Math.abs(on - off + c.weightEffect - dRaw) < 1e-9, 'К2: ' + tag + ' разложение ' + (on - off + c.weightEffect) + ' ≠ ' + dRaw);
        check(Math.abs(c.dT - dRaw) < 1e-9, 'К2: ' + tag + ' ΔT ' + c.dT + ' ≠ ' + dRaw);
        // К3: сверка
        if (!c.recon.ok || !c.recon.levelsOk) epsBad++;
        // К4: 100%, порядок снизу вверх, верх закрашенной части = T_t / Σw
        if (c.sumW > 0) {
          var sum = c.segments.reduce(function (a, s) { return a + s.share; }, 0);
          check(Math.abs(sum - 1) < 1e-9, 'К4: ' + tag + ' сумма долей ' + sum);
          for (var k = 1; k < c.segments.length; k++) {
            var a = c.segments[k - 1], b = c.segments[k];
            check(rank[a.group] < rank[b.group] || (rank[a.group] === rank[b.group] && Math.abs(a.w) >= Math.abs(b.w)),
              'К4: ' + tag + ' порядок ' + a.name + '(' + a.group + ') → ' + b.name + '(' + b.group + ')');
          }
          var nIncl = 0;
          c.segments.forEach(function (s, i) { if (INCL[s.group]) { check(i === nIncl, 'К4: ' + tag + ' включённые не сплошные'); nIncl++; } });
          var top = nIncl ? c.segments[nIncl - 1].y1 : 0;
          check(Math.abs(top - c.tCurSig / c.sumW) < 1e-9, 'К4: ' + tag + ' верх ' + top + ' ≠ T_t/Σw ' + c.tCurSig / c.sumW);
        }
      }
    }
  });
  var consistent = !DATA.issues.some(function (i) {
    return i.level === 'error' || i.code === 'total_mismatch' || i.code === 'signals_weight_not_constant';
  });
  if (consistent) check(epsBad === 0, 'К3: данные согласованы, но сверка не сошлась в ' + epsBad + ' сравнениях');
  else check(epsBad > 0, 'К3: данные несогласованы, а сверка сошлась везде');

  // DOM-проверки на выборке состояний.
  var models = DATA.models, states = [];
  models.forEach(function (m, i) {
    [N - 1, Math.floor(N / 2), 1].forEach(function (ti) {
      states.push({ m1: m, m2: models[(i + 1) % models.length], ti: ti, base: 'auto' });
      if (ti > 1) states.push({ m1: models[(i + 2) % models.length], m2: m, ti: ti, base: 0 });
    });
  });
  var domStates = 0;
  states.forEach(function (s) {
    D.setState(s);
    var st = D.getState(), v = D.getView();
    var tag = st.m1 + '/' + st.m2 + ' ' + DATES[st.ti] + ' b=' + st.base;
    domStates++;
    // К6: состояние, включая базовую дату, восстанавливается из URL
    var back = D.parseHash(location.hash, []);
    check(back.m1 === st.m1 && back.m2 === st.m2 && back.ti === st.ti && back.base === st.base,
      'К6: ' + tag + ' hash ' + location.hash + ' → ' + JSON.stringify(back));
    var cols = document.querySelectorAll('#b2-cols .col');
    [v.c1, v.c2].forEach(function (c, ci) {
      var col = cols[ci];
      if (!c.hasPrev || !c.hasCur || !(c.sumW > 0)) return;
      // К4: подпись слева на уровне своего сегмента
      var svg = col.querySelector('svg.bar');
      var svgLeft = svg.getBoundingClientRect().left;
      col.querySelectorAll('.lbl[data-f]').forEach(function (l) {
        var rect = col.querySelector('rect[data-f="' + l.getAttribute('data-f') + '"]');
        var mid = parseFloat(l.style.top) + parseFloat(l.style.height) / 2;
        var y = +rect.getAttribute('y'), h = +rect.getAttribute('height');
        check(mid >= y - 1 && mid <= y + h + 1, 'К4: ' + tag + ' подпись ' + l.textContent + ' не на уровне сегмента');
        check(l.getBoundingClientRect().right <= svgLeft + 1, 'К4: ' + tag + ' подпись ' + l.textContent + ' не слева от столбца');
      });
      check(col.querySelectorAll('rect.sg').length === c.items.length, 'К4: ' + tag + ' число сегментов ' + c.model);
      // К5: в таблице изменений все и только 1→0, 0→1, новый, выбыл
      var card = document.querySelectorAll('#block3 .tcard')[ci];
      var got = Array.prototype.map.call(card.querySelectorAll('tbody tr[data-f]'), function (r) { return +r.getAttribute('data-f'); }).sort();
      var want = c.items.filter(function (it) { return ['on', 'off', 'new', 'gone'].indexOf(it.state) >= 0; })
        .map(function (it) { return it.fi; }).sort();
      check(JSON.stringify(got) === JSON.stringify(want), 'К5: ' + tag + ' ' + c.model + ' строки ' + got + ' ≠ ' + want);
      if (!want.length) check(/не менялись/.test(card.textContent), 'К5: ' + tag + ' нет текста «сигналы факторов не менялись»');
      // К3: при расхождении — предупреждение под блоком 1
      if (!c.recon.ok || !c.recon.levelsOk) {
        check(document.querySelector('#b1-recon .bad') !== null, 'К3: ' + tag + ' нет предупреждения о сверке');
      }
    });
  });

  // Ручная базовая дата не раньше новой t → возврат в «авто».
  if (N >= 4) {
    D.setState({ m1: models[0], m2: models[3], ti: N - 1, base: N - 3 });
    D.setState({ ti: N - 3 });
    check(D.getState().base === 'auto', 'Раздел 4: ручная базовая не сбросилась в «авто»');
    check(/авто/.test(document.getElementById('base-note').textContent), 'Раздел 4: нет сообщения о сбросе базовой даты');
  }

  D.setState(saved);
  history.replaceState(null, '', savedHash || ('#' + D.stateToHash(saved)));

  var res = { checks: checks, fails: fails, comparisons: nCmp, skipped: skipped, domStates: domStates, epsBad: epsBad };
  window.__selftest = res;
  var el = document.getElementById('selftest');
  el.innerHTML = '<div class="selftest ' + (fails.length ? 'fail' : 'ok') + '"><b>Самопроверка критериев приёмки:</b> ' +
    checks + ' проверок, ошибок ' + fails.length + '. Сравнений (модель × t × базовая) ' + nCmp +
    (skipped ? ', без signals ' + skipped : '') + ', состояний интерфейса ' + domStates + ', несошедшихся сверок ' + epsBad + '.' +
    (fails.length ? '<pre>' + fails.join('\n').replace(/</g, '&lt;') + '</pre>' : '') + '</div>';
  (fails.length ? console.error : console.log)('[selftest]', res);
})();
