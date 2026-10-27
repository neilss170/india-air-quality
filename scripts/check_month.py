"""Fail unless one month partition holds exactly one row per city per hour in both raw tables.

    python scripts/check_month.py --month 202411
"""
import argparse
import calendar
import json
import os
import sys
from pathlib import Path

import pandas as pd
from google.cloud import bigquery

ROOT = Path(__file__).resolve().parent.parent

parser = argparse.ArgumentParser()
parser.add_argument("--month", type=int, required=True, help="YYYYMM")
month = parser.parse_args().month
cities = len(pd.read_csv(ROOT / "config" / "cities.csv"))
expected = cities * calendar.monthrange(month // 100, month % 100)[1] * 24

c = bigquery.Client(project=os.environ["GCP_PROJECT"], location=os.environ.get("BQ_LOCATION"))
report, ok = {"month": month, "expected_rows": expected, "tables": {}}, True
for table in ("air_quality_hourly", "weather_hourly"):
    r = next(iter(c.query(
        f"SELECT COUNT(*) AS n, COUNT(*) - COUNT(DISTINCT FORMAT('%s|%t', city, ts)) AS dupes, "
        f"COUNT(DISTINCT city) AS cities, MAX(loaded_at) AS loaded_at "
        f"FROM `{c.project}.raw.{table}` WHERE month = {month}").result()))
    report["tables"][table] = {"rows": r.n, "duplicates": r.dupes, "cities": r.cities, "loaded_at": str(r.loaded_at)}
    ok &= r.n == expected and r.dupes == 0 and r.cities == cities

print(json.dumps(report, indent=2))
sys.exit(0 if ok else f"month {month}: expected {expected} rows per table, no duplicates")
