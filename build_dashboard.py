#!/usr/bin/env python3
"""Сборка виджета попарного сравнения моделей.

    python build_dashboard.py --input path/to/predictions.xlsx --output dashboard.html \
        [--mapper path/to/factor_mapper.xlsx]

Скрипт читает листы predictions и signals, валидирует их, печатает найденные проблемы
в консоль и встраивает данные в HTML как JSON. Все расчёты переходов и разложения ΔT
выполняются в браузере (widget/core.js), поэтому смена моделей и дат не требует
пересборки. Частота дат нигде не предполагается: порядок задаётся самими данными.

С --mapper подписи факторов везде заменяются бизнес-описаниями из таблицы со столбцами
factor и factor_desc; исходное имя остаётся в подсказках.

Код возврата: 0 — собрано; 1 — собрано, но найдены проблемы и указан --strict;
2 — собрать нельзя (нет файла, листа или обязательных столбцов).
"""
import argparse
import datetime as dt
import json
from html import escape as html_escape
import math
import sys
from pathlib import Path

import pandas as pd

DIRS = ("up", "down")
HORIZONS = (10, 20, 30)
MODELS = [f"{d}_{h}" for d in DIRS for h in HORIZONS]

# Конфиг сборки по умолчанию; переопределяется файлом --config (JSON) и флагами CLI.
DEFAULT_CONFIG = {
    "factor_spark_points": 6,   # окно спарклайна factor_value в таблицах, в точках данных
    "total_spark_points": 24,   # окно спарклайна total в блоке 1, в точках данных
    "eps_tolerance": 1e-6,      # допуск сверки ε относительно масштаба total
    "default_model_1": "up_10",
    "default_model_2": "down_10",
    "title": "Сравнение моделей",
    "factor_code_in_title": True,  # исходное имя factor во всплывающей подписи рядом с описанием из маппера
    "show_hints": True,            # пояснительные тексты; false — только данные, легенда и предупреждения
}
BOOL_KEYS = ("factor_code_in_title", "show_hints")

SIGNAL_COLUMNS = ["DATE", "model", "factor", "factor_value", "signal", "weight"]
MAPPER_COLUMNS = ["factor", "factor_desc"]
MAX_ISSUE_ROWS = 50  # сколько проблемных строк на одну проблему класть в виджет

WIDGET_DIR = Path(__file__).resolve().parent / "widget"


def score_col(m):
    return f"{m}_score"


def threshold_col(m):
    return f"current_{m}_threshold"


def signals_name(m):
    return f"current_{m}"


SIGNALS_TO_KEY = {signals_name(m): m for m in MODELS}


class BuildError(Exception):
    pass


class Issues:
    """Проблемы данных: печатаются в консоль и встраиваются в виджет."""

    def __init__(self):
        self.items = []

    def add(self, level, code, message, rows=None, columns=None):
        rows = rows if rows is not None else []
        self.items.append({
            "level": level,
            "code": code,
            "message": message,
            "count": len(rows),
            "columns": columns or [],
            "rows": [[_json_value(v) for v in r] for r in rows[:MAX_ISSUE_ROWS]],
        })

    def print(self, stream=sys.stderr):
        if not self.items:
            print("Проблем в данных не найдено.", file=stream)
            return
        print(f"Найдено проблем: {len(self.items)}", file=stream)
        for it in self.items:
            tag = "ОШИБКА" if it["level"] == "error" else "ПРЕДУПРЕЖДЕНИЕ"
            print(f"  [{tag}] {it['message']}", file=stream)
            if it["rows"]:
                print("      " + " | ".join(it["columns"]), file=stream)
                for r in it["rows"][:10]:
                    print("      " + " | ".join("" if v is None else str(v) for v in r), file=stream)
                if it["count"] > 10:
                    print(f"      … ещё {it['count'] - 10}", file=stream)


def _json_value(v):
    if v is None:
        return None
    if isinstance(v, (pd.Timestamp, dt.datetime, dt.date)):
        return pd.Timestamp(v).date().isoformat()
    if isinstance(v, bool):
        return v
    if hasattr(v, "item"):  # numpy scalar
        v = v.item()
    if isinstance(v, float):
        return None if math.isnan(v) or math.isinf(v) else v
    if isinstance(v, (int, str)):
        return v
    try:
        if pd.isna(v):
            return None
    except (TypeError, ValueError):
        pass
    return str(v)


def _to_date(series, sheet, issues):
    """DATE → календарная дата без времени (допущение 5)."""
    parsed = pd.to_datetime(series, errors="coerce")
    bad = series[parsed.isna()]
    if len(bad):
        issues.add("error", f"{sheet}_bad_date", f"{sheet}: не удалось разобрать DATE в {len(bad)} строках — строки пропущены",
                   [[int(i) + 2, v] for i, v in bad.items()], ["строка Excel", "DATE"])
    return parsed.dt.normalize()


def read_workbook(path):
    path = Path(path)
    if not path.exists():
        raise BuildError(f"Файл не найден: {path}")
    try:
        sheets = pd.read_excel(path, sheet_name=None, engine="openpyxl")
    except Exception as e:  # noqa: BLE001 — показываем пользователю как есть
        raise BuildError(f"Не удалось прочитать {path}: {e}") from e
    missing = [s for s in ("predictions", "signals") if s not in sheets]
    if missing:
        raise BuildError(f"В файле нет листов: {', '.join(missing)} (есть: {', '.join(sheets)})")
    return sheets["predictions"], sheets["signals"]


def validate_predictions(pred, issues):
    required = ["DATE"] + [score_col(m) for m in MODELS] + [threshold_col(m) for m in MODELS]
    missing = [c for c in required if c not in pred.columns]
    if missing:
        raise BuildError("Лист predictions: нет обязательных столбцов: " + ", ".join(missing))
    pred = pred[required].copy()
    pred["DATE"] = _to_date(pred["DATE"], "predictions", issues)
    pred = pred[pred["DATE"].notna()]
    dup = pred[pred["DATE"].duplicated(keep="first")]
    if len(dup):
        issues.add("error", "predictions_duplicate_date",
                   f"predictions: повторяющиеся даты ({len(dup)}) — оставлена первая строка каждой даты",
                   [[d] for d in dup["DATE"]], ["DATE"])
        pred = pred.drop_duplicates("DATE", keep="first")
    for c in required[1:]:
        num = pd.to_numeric(pred[c], errors="coerce")
        bad = pred.loc[num.isna() & pred[c].notna(), ["DATE", c]]
        if len(bad):
            issues.add("error", "predictions_not_numeric", f"predictions: нечисловые значения в {c} ({len(bad)})",
                       bad.values.tolist(), ["DATE", c])
        empty = pred.loc[pred[c].isna(), "DATE"]
        if len(empty):
            issues.add("warning", "predictions_empty", f"predictions: пустые значения в {c} ({len(empty)})",
                       [[d] for d in empty], ["DATE"])
        pred[c] = num
    return pred.sort_values("DATE").reset_index(drop=True)


def validate_signals(sig, pred_dates, issues):
    missing = [c for c in SIGNAL_COLUMNS if c not in sig.columns]
    if missing:
        raise BuildError("Лист signals: нет обязательных столбцов: " + ", ".join(missing))
    sig = sig[SIGNAL_COLUMNS].copy()
    sig["_row"] = sig.index + 2  # номер строки в Excel для сообщений
    sig["DATE"] = _to_date(sig["DATE"], "signals", issues)
    sig = sig[sig["DATE"].notna()]
    sig["factor"] = sig["factor"].astype(str).str.strip()

    # Соответствие имён моделей разделу 2.
    sig["key"] = sig["model"].map(SIGNALS_TO_KEY)
    unknown = sig[sig["key"].isna()]
    if len(unknown):
        names = sorted(unknown["model"].astype(str).unique())
        issues.add("error", "signals_unknown_model",
                   f"signals: имена моделей вне списка раздела 2 ({', '.join(names)}) — {len(unknown)} строк пропущено",
                   unknown[["_row", "DATE", "model", "factor"]].values.tolist(), ["строка", "DATE", "model", "factor"])
        sig = sig[sig["key"].notna()]

    # Даты, которых нет в predictions, не могут быть ни t, ни базовой.
    extra = sig[~sig["DATE"].isin(pred_dates)]
    if len(extra):
        ds = sorted({d.date().isoformat() for d in extra["DATE"]})
        issues.add("warning", "signals_date_not_in_predictions",
                   f"signals: {len(extra)} строк с датами, которых нет в predictions ({', '.join(ds[:5])}{'…' if len(ds) > 5 else ''}) — пропущены",
                   [[d] for d in ds], ["DATE"])
        sig = sig[sig["DATE"].isin(pred_dates)]

    # Допущение 1: ключ (DATE, model, factor) уникален. Дубликаты не агрегируются.
    dup_mask = sig.duplicated(["DATE", "key", "factor"], keep=False)
    if dup_mask.any():
        d = sig[dup_mask].sort_values(["DATE", "key", "factor", "_row"])
        issues.add("error", "signals_duplicate_key",
                   f"signals: ключ (DATE, model, factor) не уникален — {int(dup_mask.sum())} строк; "
                   "в расчёт взята первая строка каждого ключа, высоты сегментов могут быть неверны",
                   d[["_row", "DATE", "model", "factor", "signal", "weight"]].values.tolist(),
                   ["строка", "DATE", "model", "factor", "signal", "weight"])
        sig = sig.drop_duplicates(["DATE", "key", "factor"], keep="first")

    # Допущение 2: signal ∈ {0, 1}, weight — неотрицательное число.
    s_num = pd.to_numeric(sig["signal"], errors="coerce")
    bad_s = sig[~s_num.isin([0, 1])]
    if len(bad_s):
        issues.add("error", "signals_bad_signal",
                   f"signals: signal вне {{0, 1}} в {len(bad_s)} строках — строки исключены из расчёта",
                   bad_s[["_row", "DATE", "model", "factor", "signal"]].values.tolist(),
                   ["строка", "DATE", "model", "factor", "signal"])
    w_num = pd.to_numeric(sig["weight"], errors="coerce")
    bad_w = sig[w_num.isna()]
    if len(bad_w):
        issues.add("error", "signals_bad_weight",
                   f"signals: пустой или нечисловой weight в {len(bad_w)} строках — строки исключены из расчёта",
                   bad_w[["_row", "DATE", "model", "factor", "weight"]].values.tolist(),
                   ["строка", "DATE", "model", "factor", "weight"])
    neg_w = sig[w_num < 0]
    if len(neg_w):
        issues.add("warning", "signals_negative_weight",
                   f"signals: отрицательный weight в {len(neg_w)} строках (в долях столбца берётся |w|)",
                   neg_w[["_row", "DATE", "model", "factor", "weight"]].values.tolist(),
                   ["строка", "DATE", "model", "factor", "weight"])
    sig["signal"] = s_num
    sig["weight"] = w_num
    sig = sig[s_num.isin([0, 1]) & w_num.notna()]
    sig["signal"] = sig["signal"].astype(int)

    # Веса постоянны во времени — проверяем, а не принимаем на веру.
    spread = sig.groupby(["key", "factor"])["weight"].agg(["min", "max", "nunique"])
    varying = spread[spread["nunique"] > 1]
    if len(varying):
        rows = [[k, f, r["min"], r["max"], int(r["nunique"])] for (k, f), r in varying.iterrows()]
        issues.add("warning", "signals_weight_not_constant",
                   f"signals: вес меняется во времени у {len(varying)} пар (model, factor) — "
                   "в разложении ΔT появится слагаемое изменения весов",
                   rows, ["model", "factor", "min w", "max w", "различных значений"])

    # Допущение 4: одинаковое factor_value у одноимённых факторов разных моделей на одну дату.
    fv = sig[["DATE", "factor", "key", "factor_value"]].copy()
    fv["_v"] = fv["factor_value"].map(lambda v: json.dumps(_json_value(v)))
    nv = fv.groupby(["DATE", "factor"])["_v"].nunique()
    incons = nv[nv > 1]
    if len(incons):
        rows = []
        for (d, f) in incons.index[:MAX_ISSUE_ROWS]:
            sub = fv[(fv["DATE"] == d) & (fv["factor"] == f)]
            rows.append([d, f, "; ".join(f"{k}={json.loads(v)}" for k, v in zip(sub["key"], sub["_v"]))])
        issues.add("warning", "signals_factor_value_mismatch",
                   f"signals: у одноимённых факторов разные factor_value на одну дату ({len(incons)} случаев) — "
                   "в сводной таблице показано значение модели 1",
                   rows, ["DATE", "factor", "значения по моделям"])
    return sig


def read_mapper(path, issues):
    """Маппер: первый лист xlsx со столбцами factor и factor_desc → {имя фактора: описание}."""
    path = Path(path)
    if not path.exists():
        raise BuildError(f"Файл маппера не найден: {path}")
    try:
        df = pd.read_excel(path, sheet_name=0, engine="openpyxl")
    except Exception as e:  # noqa: BLE001 — показываем пользователю как есть
        raise BuildError(f"Не удалось прочитать маппер {path}: {e}") from e
    df.columns = [str(c).strip() for c in df.columns]
    missing = [c for c in MAPPER_COLUMNS if c not in df.columns]
    if missing:
        raise BuildError(f"Маппер {path.name}: нет столбцов {', '.join(missing)} (есть: {', '.join(df.columns)})")
    df = df[MAPPER_COLUMNS].copy()
    df["_row"] = df.index + 2
    df = df[df["factor"].notna()]
    df["factor"] = df["factor"].astype(str).str.strip()
    df["factor_desc"] = df["factor_desc"].map(lambda v: None if pd.isna(v) else (str(v).strip() or None))

    empty = df[df["factor_desc"].isna()]
    if len(empty):
        issues.add("warning", "mapper_empty_desc",
                   f"маппер: пустое factor_desc у {len(empty)} факторов — для них показано исходное имя",
                   empty[["_row", "factor"]].values.tolist(), ["строка", "factor"])
    df = df[df["factor_desc"].notna()]

    conflicts = df.groupby("factor")["factor_desc"].nunique()
    conflicts = conflicts[conflicts > 1]
    if len(conflicts):
        d = df[df["factor"].isin(conflicts.index)].sort_values(["factor", "_row"])
        issues.add("warning", "mapper_conflicting_desc",
                   f"маппер: у {len(conflicts)} факторов несколько разных описаний — взято первое по порядку строк",
                   d[["_row", "factor", "factor_desc"]].values.tolist(), ["строка", "factor", "factor_desc"])
    return dict(df.drop_duplicates("factor", keep="first")[["factor", "factor_desc"]].values.tolist())


def check_mapper_coverage(factors, mapper, issues):
    unmapped = [f for f in factors if f not in mapper]
    if unmapped:
        issues.add("warning", "mapper_missing_factor",
                   f"маппер: нет описания у {len(unmapped)} из {len(factors)} факторов — для них показано исходное имя",
                   [[f] for f in unmapped], ["factor"])


def check_totals(pred, sig, issues, tol):
    """Допущение 3: total = Σ w·s. Виджет показывает ε на выбранной паре дат, здесь — сводка по всем."""
    ws = (sig["weight"] * sig["signal"]).groupby([sig["DATE"], sig["key"]]).sum()
    rows = []
    for m in MODELS:
        for d, total in zip(pred["DATE"], pred[score_col(m)]):
            if (d, m) not in ws.index or pd.isna(total):
                continue
            diff = total - ws[(d, m)]
            if abs(diff) > tol * max(1.0, abs(total)):
                rows.append([d, m, total, ws[(d, m)], diff])
    if rows:
        issues.add("warning", "total_mismatch",
                   f"total из predictions не равен Σ w·s из signals в {len(rows)} случаях (дата, модель)",
                   rows, ["DATE", "model", "total", "Σ w·s", "разность"])

    no_rows = []
    have = set(ws.index)
    for m in MODELS:
        for d in pred["DATE"]:
            if (d, m) not in have:
                no_rows.append([d, m])
    if no_rows:
        issues.add("warning", "signals_missing_for_date",
                   f"нет строк signals для {len(no_rows)} пар (дата, модель) — для них столбцы не строятся",
                   no_rows, ["DATE", "model"])


def build_payload(pred, sig, issues, config, source_name, mapper=None, mapper_name=None):
    dates = [d.date().isoformat() for d in pred["DATE"]]
    date_idx = {d: i for i, d in enumerate(dates)}
    factors = sorted(sig["factor"].unique())
    factor_idx = {f: i for i, f in enumerate(factors)}

    pred_out = {}
    for m in MODELS:
        pred_out[m] = {
            "total": [_json_value(v) for v in pred[score_col(m)]],
            "thr": [_json_value(v) for v in pred[threshold_col(m)]],
        }

    # signals: модель → массив по датам → строки [factor_idx, signal, weight, factor_value]
    sig_out = {m: [None] * len(dates) for m in MODELS}
    sig = sig.sort_values(["key", "DATE", "factor"])
    for (m, d), g in sig.groupby(["key", "DATE"], sort=False):
        di = date_idx[d.date().isoformat()]
        sig_out[m][di] = [
            [factor_idx[f], int(s), _json_value(w), _json_value(v)]
            for f, s, w, v in zip(g["factor"], g["signal"], g["weight"], g["factor_value"])
        ]

    return {
        "meta": {
            "source": source_name,
            "mapper": mapper_name,
            "built_at": dt.datetime.now().strftime("%Y-%m-%d %H:%M"),
            "config": config,
        },
        "models": MODELS,
        "dates": dates,
        "factors": factors,
        # бизнес-описания по индексу фактора; None — описания нет, показывается имя
        "factor_desc": [mapper.get(f) for f in factors] if mapper is not None else None,
        "pred": pred_out,
        "sig": sig_out,
        "issues": issues.items,
    }


def render_html(payload, self_test=False):
    def read(name):
        return (WIDGET_DIR / name).read_text(encoding="utf-8")

    data_json = json.dumps(payload, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
    # Защита от преждевременного закрытия <script>: внутри JSON '<' допустим только в строках.
    data_json = data_json.replace("<", "\\u003c")
    html = read("template.html")
    parts = {
        "/*__FONTS__*/": read("fonts.css"),
        "/*__STYLES__*/": read("styles.css"),
        "__TITLE__": html_escape(payload["meta"]["config"]["title"]),
        "/*__DATA__*/": data_json,
        "/*__CORE__*/": read("core.js"),
        "/*__APP__*/": read("app.js"),
        "/*__SELFTEST__*/": read("selftest.js") if self_test else "",
    }
    for marker, content in parts.items():
        if marker not in html:
            raise BuildError(f"В шаблоне нет маркера {marker}")
        html = html.replace(marker, content)
    return html


def load_config(path, overrides):
    config = dict(DEFAULT_CONFIG)
    if path:
        with open(path, encoding="utf-8") as fh:
            user = json.load(fh)
        unknown = set(user) - set(DEFAULT_CONFIG)
        if unknown:
            raise BuildError(f"Неизвестные ключи конфига: {', '.join(sorted(unknown))}")
        config.update(user)
    config.update({k: v for k, v in overrides.items() if v is not None})
    for k in ("default_model_1", "default_model_2"):
        if config[k] not in MODELS:
            raise BuildError(f"{k}: модель {config[k]!r} не из списка {', '.join(MODELS)}")
    if config["default_model_1"] == config["default_model_2"]:
        raise BuildError("default_model_1 и default_model_2 должны различаться")
    for k in ("factor_spark_points", "total_spark_points"):
        if int(config[k]) < 2:
            raise BuildError(f"{k} должно быть не меньше 2")
        config[k] = int(config[k])
    for k in BOOL_KEYS:
        if not isinstance(config[k], bool):
            raise BuildError(f"{k} должно быть true или false, а не {config[k]!r}")
    return config


def build(input_path, output_path, config, self_test=False, stream=sys.stderr, mapper_path=None):
    issues = Issues()
    pred_raw, sig_raw = read_workbook(input_path)
    mapper = read_mapper(mapper_path, issues) if mapper_path else None
    pred = validate_predictions(pred_raw, issues)
    if len(pred) < 2:
        raise BuildError("В листе predictions меньше двух дат — сравнивать не с чем")
    sig = validate_signals(sig_raw, set(pred["DATE"]), issues)
    check_totals(pred, sig, issues, config["eps_tolerance"])
    if mapper is not None:
        check_mapper_coverage(sorted(sig["factor"].unique()), mapper, issues)
    payload = build_payload(pred, sig, issues, config, Path(input_path).name,
                            mapper, Path(mapper_path).name if mapper_path else None)
    html = render_html(payload, self_test=self_test)
    Path(output_path).parent.mkdir(parents=True, exist_ok=True)
    Path(output_path).write_text(html, encoding="utf-8")
    print(f"Прочитано: {len(pred)} дат ({payload['dates'][0]} … {payload['dates'][-1]}), "
          f"{len(sig)} строк signals, {len(payload['factors'])} факторов.", file=stream)
    if mapper is not None:
        n = sum(d is not None for d in payload["factor_desc"])
        print(f"Описания факторов: {n} из {len(payload['factors'])} ({Path(mapper_path).name}).", file=stream)
    issues.print(stream)
    print(f"Записано: {output_path} ({len(html) / 1024:.0f} КБ)", file=stream)
    return issues


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--input", required=True, help="путь к predictions.xlsx")
    ap.add_argument("--output", default="dashboard.html", help="куда записать HTML (по умолчанию dashboard.html)")
    ap.add_argument("--mapper", help="xlsx со столбцами factor и factor_desc: бизнес-описания факторов вместо имён")
    ap.add_argument("--config", help="JSON с ключами конфига: " + ", ".join(DEFAULT_CONFIG))
    ap.add_argument("--spark-points", type=int, dest="factor_spark_points",
                    help=f"окно спарклайна факторов, точек (по умолчанию {DEFAULT_CONFIG['factor_spark_points']})")
    ap.add_argument("--total-spark-points", type=int, dest="total_spark_points",
                    help=f"окно спарклайна total, точек (по умолчанию {DEFAULT_CONFIG['total_spark_points']})")
    ap.add_argument("--strict", action="store_true", help="код возврата 1, если найдены проблемы в данных")
    ap.add_argument("--self-test", action="store_true",
                    help="встроить в HTML прогон критериев приёмки (результат — в консоли браузера и на странице)")
    a = ap.parse_args(argv)
    try:
        config = load_config(a.config, {"factor_spark_points": a.factor_spark_points,
                                        "total_spark_points": a.total_spark_points})
        issues = build(a.input, a.output, config, self_test=a.self_test, mapper_path=a.mapper)
    except BuildError as e:
        print(f"Ошибка: {e}", file=sys.stderr)
        return 2
    return 1 if (a.strict and issues.items) else 0


if __name__ == "__main__":
    sys.exit(main())
