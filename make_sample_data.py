#!/usr/bin/env python3
"""Генератор синтетического predictions.xlsx в формате ТЗ (листы predictions и signals).

Нужен для разработки и приёмки виджета, пока нет боевой выгрузки:

    python make_sample_data.py --output data/predictions.xlsx
    python make_sample_data.py --freq weekly --drop-date 2026-07-03 --output data/predictions_weekly.xlsx
    python make_sample_data.py --inject-errors --output data/predictions_broken.xlsx

Свойства данных совпадают с подтверждёнными допущениями ТЗ: total = Σ w·s, веса
неотрицательны и постоянны во времени, порог модели свой на каждую дату, одно и то же
имя фактора имеет одинаковое factor_value во всех моделях на одну дату.
"""
import argparse
from pathlib import Path

import numpy as np
import pandas as pd

MODELS = [f"{d}_{h}" for d in ("up", "down") for h in (10, 20, 30)]

FACTORS = [
    "momentum_3m", "momentum_6m", "momentum_12m", "reversal_1m", "vol_spread", "vol_term_structure",
    "realized_vol_1m", "implied_vol_3m", "skew_25d", "credit_spread", "hy_ig_spread", "cds_index",
    "yield_curve", "yield_curve_2s5s", "real_rates", "breakeven_infl", "term_premium", "policy_rate_gap",
    "pmi_new_orders", "pmi_composite", "pmi_services", "industrial_prod_yoy", "retail_sales_yoy",
    "unemployment_claims", "consumer_confidence", "earnings_rev", "earnings_surprise", "eps_growth_fwd",
    "pe_fwd", "dividend_yield_spread", "buyback_yield", "breadth", "advance_decline", "new_highs_lows",
    "flows_em", "flows_dm_equity", "fund_positioning", "short_interest", "put_call_ratio", "margin_debt_yoy",
    "fx_basis", "dxy_trend", "usd_rub_vol", "carry_index", "oil_mom", "brent_curve", "gas_price_mom",
    "copper_gold", "metals_index_mom", "agri_index_mom", "gold_trend", "bitcoin_mom", "liquidity_index",
    "m2_growth", "credit_impulse", "bank_lending_yoy", "financial_conditions", "repo_spread", "ofz_curve",
    "ofz_auction_cover", "cbr_rate_expect", "inflation_surprise", "wage_growth", "housing_starts",
    "auto_sales_yoy", "freight_index", "baltic_dry", "semis_cycle", "tech_rel_strength", "value_growth_spread",
    "small_large_spread", "sector_dispersion", "correlation_1m", "news_sentiment", "analyst_dispersion",
    "insider_buying", "ipo_activity", "macro_regime", "risk_regime", "seasonality",
]
# Бизнес-описания факторов для примера маппера (--mapper-output).
FACTOR_DESC = {
    "momentum_3m": "Моментум индекса за 3 месяца", "momentum_6m": "Моментум индекса за 6 месяцев",
    "momentum_12m": "Моментум индекса за 12 месяцев", "reversal_1m": "Разворот доходности за 1 месяц",
    "vol_spread": "Спред подразумеваемой и реализованной волатильности",
    "vol_term_structure": "Срочная структура волатильности", "realized_vol_1m": "Реализованная волатильность за 1 месяц",
    "implied_vol_3m": "Подразумеваемая волатильность на 3 месяца", "skew_25d": "Скос волатильности 25-дельта",
    "credit_spread": "Кредитный спред корпоративных облигаций", "hy_ig_spread": "Спред high yield к инвестиционному уровню",
    "cds_index": "Индекс кредитных дефолтных свопов", "yield_curve": "Наклон кривой доходности 10л − 2г",
    "yield_curve_2s5s": "Наклон кривой доходности 5л − 2г", "real_rates": "Реальные процентные ставки",
    "breakeven_infl": "Инфляционные ожидания рынка", "term_premium": "Премия за срок",
    "policy_rate_gap": "Отклонение ключевой ставки от нейтральной", "pmi_new_orders": "PMI: новые заказы",
    "pmi_composite": "Композитный PMI", "pmi_services": "PMI сферы услуг",
    "industrial_prod_yoy": "Промышленное производство, г/г", "retail_sales_yoy": "Розничные продажи, г/г",
    "unemployment_claims": "Заявки на пособие по безработице", "consumer_confidence": "Индекс потребительского доверия",
    "earnings_rev": "Пересмотры прогнозов прибыли", "earnings_surprise": "Сюрпризы отчётности по прибыли",
    "eps_growth_fwd": "Ожидаемый рост прибыли на акцию", "pe_fwd": "Форвардный P/E рынка",
    "dividend_yield_spread": "Спред дивидендной доходности к ставкам", "buyback_yield": "Доходность обратных выкупов",
    "breadth": "Ширина рынка: доля бумаг выше средней", "advance_decline": "Линия роста-падения",
    "new_highs_lows": "Новые максимумы минус минимумы", "flows_em": "Потоки в фонды развивающихся рынков",
    "flows_dm_equity": "Потоки в фонды акций развитых рынков", "fund_positioning": "Позиционирование фондов",
    "short_interest": "Короткие позиции", "put_call_ratio": "Отношение пут/колл",
    "margin_debt_yoy": "Маржинальный долг, г/г", "fx_basis": "Валютный базис",
    "dxy_trend": "Тренд индекса доллара", "usd_rub_vol": "Волатильность USD/RUB", "carry_index": "Индекс керри-трейда",
    "oil_mom": "Моментум цены нефти", "brent_curve": "Наклон фьючерсной кривой Brent",
    "gas_price_mom": "Моментум цены газа", "copper_gold": "Отношение меди к золоту",
    "metals_index_mom": "Моментум индекса металлов", "agri_index_mom": "Моментум индекса агросырья",
    "gold_trend": "Тренд цены золота", "bitcoin_mom": "Моментум биткоина", "liquidity_index": "Индекс ликвидности",
    "m2_growth": "Рост денежной массы M2", "credit_impulse": "Кредитный импульс",
    "bank_lending_yoy": "Банковское кредитование, г/г", "financial_conditions": "Индекс финансовых условий",
    "repo_spread": "Спред ставок РЕПО", "ofz_curve": "Наклон кривой ОФЗ", "ofz_auction_cover": "Переподписка на аукционах ОФЗ",
    "cbr_rate_expect": "Ожидания по ключевой ставке ЦБ", "inflation_surprise": "Инфляционный сюрприз",
    "wage_growth": "Рост заработных плат", "housing_starts": "Начало строительства жилья",
    "auto_sales_yoy": "Продажи автомобилей, г/г", "freight_index": "Индекс грузоперевозок",
    "baltic_dry": "Балтийский сухогрузный индекс", "semis_cycle": "Цикл полупроводников",
    "tech_rel_strength": "Относительная сила техсектора", "value_growth_spread": "Спред стоимость − рост",
    "small_large_spread": "Спред малой и крупной капитализации", "sector_dispersion": "Дисперсия доходностей секторов",
    "correlation_1m": "Средняя корреляция бумаг за 1 месяц", "news_sentiment": "Тональность новостного фона",
    "analyst_dispersion": "Разброс прогнозов аналитиков", "insider_buying": "Покупки инсайдеров",
    "ipo_activity": "Активность IPO", "macro_regime": "Макроэкономический режим", "risk_regime": "Режим аппетита к риску",
    "seasonality": "Сезонность",
}
CATEGORICAL = {
    "macro_regime": ["expansion", "slowdown", "contraction", "recovery"],
    "risk_regime": ["risk_on", "neutral", "risk_off"],
}


def make_dates(freq, start, end, drop):
    rule = {"monthly": "ME", "weekly": "W-FRI"}[freq]
    dates = pd.date_range(start, end, freq=rule)
    if drop:
        drop_ts = {pd.Timestamp(d) for d in drop}
        missing = drop_ts - set(dates)
        if missing:
            raise SystemExit(f"--drop-date: дат нет в сетке: {sorted(str(d.date()) for d in missing)}")
        dates = dates[~dates.isin(list(drop_ts))]
    return dates


def factor_series(rng, n):
    """Числовой ряд: AR(1) около уровня со своим масштабом; категориальный — марковская цепь."""
    out = {}
    for name in FACTORS:
        if name in CATEGORICAL:
            cats = CATEGORICAL[name]
            state = rng.integers(len(cats))
            vals = []
            for _ in range(n):
                if rng.random() < 0.2:
                    state = rng.integers(len(cats))
                vals.append(cats[state])
            out[name] = vals
            continue
        level = rng.choice([0.0, 1.0, 50.0, 400.0, 2.5])
        scale = max(abs(level) * 0.08, rng.choice([0.3, 1.0, 2.0]))
        phi = rng.uniform(0.6, 0.95)
        x = np.empty(n)
        x[0] = rng.normal()
        for i in range(1, n):
            x[i] = phi * x[i - 1] + rng.normal() * np.sqrt(1 - phi ** 2)
        digits = 0 if level >= 50 else 2
        out[name] = list(np.round(level + scale * x, digits))
    return out


def model_specs(rng):
    """Состав, веса и правила фич для каждой модели. Веса — сотые доли."""
    core = FACTORS[:24]
    specs = {}
    for m in MODELS:
        k = int(rng.integers(12, 15))
        n_core = int(rng.integers(6, 9))
        names = list(rng.choice(core, n_core, replace=False))
        rest = [f for f in FACTORS if f not in names]
        names += list(rng.choice(rest, k - n_core, replace=False))
        raw = rng.dirichlet(np.full(k, 1.6))
        total_w = 1.0 if m.startswith("up") else float(rng.choice([0.8, 1.2, 1.5]))
        cents = np.maximum(np.round(raw * total_w * 100), 1).astype(int)
        specs[m] = {"factors": names, "weights": dict(zip(names, cents / 100)), "rules": {}}
        for f in names:
            if f in CATEGORICAL:
                cats = CATEGORICAL[f]
                specs[m]["rules"][f] = ("in", set(rng.choice(cats, int(rng.integers(1, len(cats))), replace=False)))
            else:
                # фича строится из фактора: уровень либо изменение за 1–3 точки, со своим порогом
                specs[m]["rules"][f] = ("num", int(rng.choice([0, 0, 1, 3])), int(rng.choice([1, -1])),
                                        float(rng.uniform(0.3, 0.7)))
    return specs


def feature_signal(rule, series, i):
    if rule[0] == "in":
        return int(series[i] in rule[1])
    _, lag, direction, q = rule
    arr = np.asarray(series, dtype=float)
    feat = arr if lag == 0 else np.concatenate([np.full(lag, np.nan), arr[lag:] - arr[:-lag]])
    if np.isnan(feat[i]):
        return 0
    thr = np.nanquantile(feat, q)
    return int(direction * (feat[i] - thr) > 0)


def generate(freq, start, end, drop, seed, inject_errors):
    rng = np.random.default_rng(seed)
    dates = make_dates(freq, start, end, drop)
    n = len(dates)
    values = factor_series(rng, n)
    specs = model_specs(rng)

    # Смена состава моделей во времени — чтобы в данных были состояния «новый» и «выбыл».
    spare = [f for f in FACTORS if f not in specs["down_20"]["factors"]]
    new_factor = spare[0]
    specs["down_20"]["factors"].append(new_factor)
    specs["down_20"]["weights"][new_factor] = 0.06
    specs["down_20"]["rules"][new_factor] = ("num", 0, 1, 0.4)
    appear_at = n - 5
    gone_factor = specs["up_20"]["factors"][-1]
    gone_after = n - 2

    sig_rows = []
    totals = {m: np.zeros(n) for m in MODELS}
    for m in MODELS:
        sp = specs[m]
        for f in sp["factors"]:
            for i, d in enumerate(dates):
                if m == "down_20" and f == new_factor and i < appear_at:
                    continue
                if m == "up_20" and f == gone_factor and i > gone_after:
                    continue
                s = feature_signal(sp["rules"][f], values[f], i)
                w = sp["weights"][f]
                totals[m][i] += w * s
                sig_rows.append({"DATE": d, "model": f"current_{m}", "factor": f,
                                 "factor_value": values[f][i], "signal": s, "weight": w})

    pred = {"DATE": dates}
    for m in MODELS:
        pred[f"{m}_score"] = totals[m]
    for m in MODELS:
        sum_w = sum(specs[m]["weights"].values())
        base = round(sum_w * float(rng.uniform(0.42, 0.55)), 2)
        drift = np.round(0.02 * sum_w * np.sin(np.arange(n) / 7.0 + rng.uniform(0, 6)), 2)
        pred[f"current_{m}_threshold"] = base + drift
    pred_df = pd.DataFrame(pred)
    sig_df = pd.DataFrame(sig_rows)

    if inject_errors:
        last = dates[-1]
        dup = sig_df[(sig_df.DATE == last) & (sig_df.model == "current_up_10")].iloc[[0]]
        sig_df = pd.concat([sig_df, dup], ignore_index=True)
        idx = sig_df[(sig_df.DATE == last) & (sig_df.model == "current_down_10")].index
        sig_df.loc[idx[0], "signal"] = 2
        sig_df.loc[idx[1], "weight"] = np.nan
        idx = sig_df[(sig_df.model == "current_up_30") & (sig_df.DATE == dates[-2])].index
        sig_df.loc[idx[0], "weight"] = sig_df.loc[idx[0], "weight"] + 0.05
        pred_df.loc[pred_df.index[-1], "up_20_score"] += 0.03
        sig_df.loc[len(sig_df)] = {"DATE": last, "model": "current_side_10", "factor": "momentum_3m",
                                   "factor_value": 1.0, "signal": 1, "weight": 0.1}

    return pred_df, sig_df


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--output", default="data/predictions.xlsx")
    ap.add_argument("--freq", choices=["monthly", "weekly"], default="monthly")
    ap.add_argument("--start", default=None, help="первая дата сетки (по умолчанию: 2023-01-31 / 2024-10-04)")
    ap.add_argument("--end", default=None, help="последняя дата сетки (по умолчанию: 2026-09-30 / 2026-10-09)")
    ap.add_argument("--drop-date", action="append", default=[], help="выкинуть дату из сетки (пропуск)")
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--mapper-output", help="дополнительно записать маппер factor → factor_desc в этот xlsx")
    ap.add_argument("--inject-errors", action="store_true",
                    help="добавить дубликат ключа, signal=2, пустой вес, смену веса, рассинхрон total и чужую модель")
    a = ap.parse_args()
    start = a.start or ("2023-01-31" if a.freq == "monthly" else "2024-10-04")
    end = a.end or ("2026-09-30" if a.freq == "monthly" else "2026-10-09")
    pred_df, sig_df = generate(a.freq, start, end, a.drop_date, a.seed, a.inject_errors)
    out = Path(a.output)
    out.parent.mkdir(parents=True, exist_ok=True)
    with pd.ExcelWriter(out, engine="openpyxl") as xw:
        pred_df.to_excel(xw, sheet_name="predictions", index=False)
        sig_df.to_excel(xw, sheet_name="signals", index=False)
    print(f"{out}: {len(pred_df)} дат, {len(sig_df)} строк signals")
    if a.mapper_output:
        mp = Path(a.mapper_output)
        mp.parent.mkdir(parents=True, exist_ok=True)
        pd.DataFrame({"factor": list(FACTOR_DESC), "factor_desc": list(FACTOR_DESC.values())}).to_excel(mp, index=False)
        print(f"{mp}: {len(FACTOR_DESC)} описаний факторов")


if __name__ == "__main__":
    main()
