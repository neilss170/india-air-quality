"""Measure the marts and re-check the AQI independently -> reports/marts_latest.json.

The check recomputes AQI in pandas for a random sample of city-days, straight from the staging hourly view
and the breakpoint CSV (24 h means, 8 h rolling maxima, CO in mg/m³, band interpolation), and compares
with fct_city_daily.
"""
import json
import math
import os
from pathlib import Path

import pandas as pd
from google.cloud import bigquery

ROOT = Path(__file__).resolve().parent.parent
SAMPLE = 200
c = bigquery.Client(project=os.environ["GCP_PROJECT"], location=os.environ.get("BQ_LOCATION"))
P = c.project


def q(sql: str) -> pd.DataFrame:
    return c.query(sql).to_dataframe()


def sub_index(pollutant: str, conc: float, bp: pd.DataFrame) -> float:
    """CPCB interpolation, written separately from the SQL: bands continue from the previous band's top."""
    rows = bp[bp.pollutant == pollutant].sort_values("aqi_lo")
    lo_c, lo_i = 0.0, 0.0
    for r in rows.itertuples():
        if conc < r.conc_hi or r.Index == rows.index[-1]:
            return min(500.0, lo_i + (r.aqi_hi - lo_i) * (conc - lo_c) / (r.conc_hi - lo_c))
        lo_c, lo_i = r.conc_hi, r.aqi_hi
    raise AssertionError


def recompute(sample: pd.DataFrame, bp: pd.DataFrame) -> pd.DataFrame:
    keys = ", ".join(f"('{r.city}', DATE '{r.date_ist}')" for r in sample.itertuples())
    hourly = q(f"""
        WITH k AS (SELECT * FROM UNNEST([STRUCT<city STRING, d DATE>{keys}]))
        SELECT s.city, k.d, s.date_ist, s.measured_at_utc, s.pm25_ugm3, s.pm10_ugm3, s.no2_ugm3, s.o3_ugm3,
               s.co_ugm3, s.so2_ugm3
        FROM `{P}.staging.stg_air_quality_hourly` s JOIN k ON s.city = k.city
         AND s.date_ist BETWEEN DATE_SUB(k.d, INTERVAL 1 DAY) AND k.d""")
    out = []
    for (city, d), h in hourly.groupby(["city", "d"]):
        h = h.sort_values("measured_at_utc").set_index("measured_at_utc")
        day = h[h.date_ist == d]
        roll = h[["o3_ugm3", "co_ugm3"]].rolling("8h").mean()[h.date_ist == d]
        n8 = h["o3_ugm3"].rolling("8h").count()[h.date_ist == d]
        roll = roll[n8 == 8]
        conc = {"pm25": day.pm25_ugm3.mean(), "pm10": day.pm10_ugm3.mean(), "no2": day.no2_ugm3.mean(),
                "so2": day.so2_ugm3.mean(), "o3": roll.o3_ugm3.max(), "co": roll.co_ugm3.max() / 1000}
        si = {p: sub_index(p, v, bp) for p, v in conc.items()}
        out.append({"city": city, "date_ist": d, "aqi_py": math.floor(round(max(si.values()), 6) + 0.5),  # half up, as BigQuery ROUND
                    "dominant_py": max(si, key=lambda p: (si[p], [-ord(ch) for ch in p]))})
    return pd.DataFrame(out)


bp = pd.read_csv(ROOT / "dbt" / "seeds" / "cpcb_aqi_breakpoints.csv")
daily = q(f"SELECT city, date_ist, aqi, aqi_category, dominant_pollutant, pollutants_indexed, "
          f"aqi_pm, aqi_pm_category "
          f"FROM `{P}.marts.fct_city_daily`")
sample = daily.sample(SAMPLE, random_state=7)
check = sample.merge(recompute(sample, bp), on=["city", "date_ist"])
aqi_match = int((check.aqi == check.aqi_py).sum())
dom_match = int((check.dominant_pollutant == check.dominant_py).sum())
mismatches = check[(check.aqi != check.aqi_py) | (check.dominant_pollutant != check.dominant_py)]

cats = ["Good", "Satisfactory", "Moderate", "Poor", "Very Poor", "Severe"]
by_city = daily.groupby("city").agg(days=("aqi", "size"), mean_aqi=("aqi", "mean"), median_aqi=("aqi", "median"),
                                    max_aqi=("aqi", "max"))
by_city["share_poor_or_worse"] = daily.assign(bad=daily.aqi > 200).groupby("city").bad.mean()
by_city["mean_aqi_pm"] = daily.groupby("city").aqi_pm.mean()
by_city["share_pm_poor_or_worse"] = daily.assign(bad=daily.aqi_pm > 200).groupby("city").bad.mean()
by_city["top_dominant"] = daily.groupby("city").dominant_pollutant.agg(lambda s: s.value_counts().index[0])
by_city = by_city.sort_values("mean_aqi", ascending=False).round(3)

tables = {}
for ds in ("reference", "staging", "marts"):
    for t in c.list_tables(f"{P}.{ds}"):
        full = c.get_table(t.reference)
        tables[f"{ds}.{t.table_id}"] = {"type": full.table_type, "rows": full.num_rows,
                                         "created": str(full.created), "expires": str(full.expires)}

report = {
    "fct_city_daily": {
        "rows": len(daily), "cities": int(daily.city.nunique()),
        "first_date": str(daily.date_ist.min()), "last_date": str(daily.date_ist.max()),
        "pollutants_indexed": {int(k): int(v) for k, v in daily.pollutants_indexed.value_counts().items()},
        "category_days": {k: int((daily.aqi_category == k).sum()) for k in cats},
        "pm_category_days": {k: int((daily.aqi_pm_category == k).sum()) for k in cats},
        "dominant_pollutant_days": {k: int(v) for k, v in daily.dominant_pollutant.value_counts().items()},
    },
    "by_city": by_city.reset_index().to_dict(orient="records"),
    "independent_check": {"sampled_city_days": len(check), "aqi_equal": aqi_match,
                          "dominant_equal": dom_match,
                          "mismatches": mismatches.astype(str).to_dict(orient="records")},
    "tables": tables,
}
(ROOT / "reports" / "marts_latest.json").write_text(json.dumps(report, indent=2, default=str) + "\n")
print(json.dumps({k: v for k, v in report.items() if k != "tables"}, indent=1, default=str))
for name, t in tables.items():
    print(name, t["type"], t["rows"], "expires", t["expires"])
