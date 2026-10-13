"""Тесты скрипта сборки: python -m unittest discover -s tests

Проверяют чтение и валидацию xlsx, встраивание данных и независимость от частоты дат.
Расчёты в браузере проверяются отдельно: сборка с --self-test (см. README).
"""
import io
import json
import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import build_dashboard as bd  # noqa: E402
import make_sample_data as gen  # noqa: E402


def write_xlsx(path, pred, sig):
    with pd.ExcelWriter(path, engine="openpyxl") as xw:
        pred.to_excel(xw, sheet_name="predictions", index=False)
        sig.to_excel(xw, sheet_name="signals", index=False)


def payload_of(html):
    m = re.search(r'<script type="application/json" id="payload">(.*?)</script>', html, re.S)
    return json.loads(m.group(1))


class BuildTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.config = bd.load_config(None, {})

    def tearDown(self):
        self.tmp.cleanup()

    def build(self, pred, sig, **kw):
        src = self.dir / "in.xlsx"
        out = self.dir / "out.html"
        write_xlsx(src, pred, sig)
        issues = bd.build(src, out, self.config, stream=io.StringIO(), **kw)
        html = out.read_text(encoding="utf-8")
        return issues, html, payload_of(html)

    def codes(self, issues):
        return {i["code"] for i in issues.items}

    def test_clean_monthly(self):
        pred, sig = gen.generate("monthly", "2023-01-31", "2026-09-30", [], 7, False)
        issues, html, p = self.build(pred, sig)
        self.assertEqual(issues.items, [])
        self.assertEqual(len(p["dates"]), 45)
        self.assertEqual(p["dates"][-1], "2026-09-30")
        self.assertEqual(p["models"], bd.MODELS)
        # total = Σ w·s восстанавливается из встроенных строк
        for m in bd.MODELS:
            rows = p["sig"][m][-1]
            self.assertAlmostEqual(sum(r[1] * r[2] for r in rows), p["pred"][m]["total"][-1], places=9)
        # одиночный офлайн-файл: никаких внешних ресурсов
        self.assertNotRegex(html, r'(src|href)="https?://')
        self.assertNotIn("url(http", html)

    def test_weekly_with_gap(self):
        pred, sig = gen.generate("weekly", "2024-10-04", "2026-10-09", ["2026-07-03"], 7, False)
        issues, _, p = self.build(pred, sig)
        self.assertEqual(issues.items, [])
        self.assertNotIn("2026-07-03", p["dates"])
        i = p["dates"].index("2026-07-10")
        self.assertEqual(p["dates"][i - 1], "2026-06-26")  # базовая «авто» перескакивает пропуск

    def test_injected_errors_detected(self):
        pred, sig = gen.generate("monthly", "2023-01-31", "2026-09-30", [], 7, True)
        issues, _, p = self.build(pred, sig)
        self.assertTrue({
            "signals_unknown_model", "signals_duplicate_key", "signals_bad_signal", "signals_bad_weight",
            "signals_weight_not_constant", "total_mismatch",
        } <= self.codes(issues))
        self.assertEqual(p["issues"], issues.items)  # те же проблемы видны в виджете
        last = p["sig"]["up_10"][-1]
        self.assertEqual(len({r[0] for r in last}), len(last))  # дубликаты не попали в расчёт

    def test_dates_with_time_are_normalized(self):
        pred, sig = gen.generate("monthly", "2025-01-31", "2025-06-30", [], 1, False)
        pred["DATE"] = pred["DATE"] + pd.Timedelta(hours=13)
        sig["DATE"] = sig["DATE"] + pd.Timedelta(hours=9)
        issues, _, p = self.build(pred, sig)
        self.assertEqual(issues.items, [])
        self.assertEqual(p["dates"][0], "2025-01-31")
        self.assertIsNotNone(p["sig"]["up_10"][0])

    def test_unsorted_predictions_are_sorted(self):
        pred, sig = gen.generate("monthly", "2025-01-31", "2025-06-30", [], 1, False)
        _, _, p = self.build(pred.iloc[::-1], sig)
        self.assertEqual(p["dates"], sorted(p["dates"]))

    def test_missing_signals_for_date_is_reported(self):
        pred, sig = gen.generate("monthly", "2025-01-31", "2025-06-30", [], 1, False)
        sig = sig[~((sig.model == "current_up_10") & (sig.DATE == pd.Timestamp("2025-05-31")))]
        issues, _, p = self.build(pred, sig)
        self.assertIn("signals_missing_for_date", self.codes(issues))
        self.assertIsNone(p["sig"]["up_10"][4])

    def test_missing_column_fails(self):
        pred, sig = gen.generate("monthly", "2025-01-31", "2025-06-30", [], 1, False)
        with self.assertRaises(bd.BuildError) as cm:
            self.build(pred.drop(columns=["current_down_30_threshold"]), sig)
        self.assertIn("current_down_30_threshold", str(cm.exception))

    def test_html_injection_in_names_is_escaped_in_json(self):
        pred, sig = gen.generate("monthly", "2025-01-31", "2025-03-31", [], 1, False)
        sig.loc[sig.factor == sig.factor.iloc[0], "factor"] = "</script><b>x"
        _, html, p = self.build(pred, sig)
        self.assertIn("</script><b>x", p["factors"])
        self.assertEqual(html.count("</script>"), 4)  # только собственные теги шаблона

    def test_cli_exit_codes(self):
        pred, sig = gen.generate("monthly", "2025-01-31", "2025-06-30", [], 1, True)
        src = self.dir / "bad.xlsx"
        write_xlsx(src, pred, sig)
        cmd = [sys.executable, str(ROOT / "build_dashboard.py"), "--input", str(src), "--output", str(self.dir / "o.html")]
        self.assertEqual(subprocess.run(cmd, capture_output=True).returncode, 0)
        self.assertEqual(subprocess.run(cmd + ["--strict"], capture_output=True).returncode, 1)
        r = subprocess.run([sys.executable, str(ROOT / "build_dashboard.py"), "--input", str(self.dir / "nope.xlsx")],
                           capture_output=True, text=True)
        self.assertEqual(r.returncode, 2)
        self.assertIn("не найден", r.stderr)

    def test_config_spark_points(self):
        cfg = self.dir / "cfg.json"
        cfg.write_text(json.dumps({"factor_spark_points": 10}), encoding="utf-8")
        self.config = bd.load_config(cfg, {"total_spark_points": 30})
        pred, sig = gen.generate("monthly", "2025-01-31", "2025-06-30", [], 1, False)
        _, _, p = self.build(pred, sig)
        self.assertEqual(p["meta"]["config"]["factor_spark_points"], 10)
        self.assertEqual(p["meta"]["config"]["total_spark_points"], 30)
        with self.assertRaises(bd.BuildError):
            bd.load_config(None, {"factor_spark_points": 1})


if __name__ == "__main__":
    unittest.main()
