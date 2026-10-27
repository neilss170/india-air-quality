"""Measure the dbt staging views (rows, nulls, IST date span, full days) -> reports/staging_latest.json."""
import json
import os
from pathlib import Path

from google.cloud import bigquery

c = bigquery.Client(project=os.environ["GCP_PROJECT"], location=os.environ.get("BQ_LOCATION"))
COLUMNS = {
    "stg_air_quality_hourly": ["pm25_ugm3", "pm10_ugm3", "no2_ugm3", "o3_ugm3", "co_ugm3", "so2_ugm3"],
    "stg_weather_hourly": ["temperature_c", "relative_humidity_pct", "precipitation_mm", "wind_speed_kmh",
                           "wind_direction_deg"],
}
report = {}
for view, cols in COLUMNS.items():
    nulls = ", ".join(f"COUNTIF({col} IS NULL) AS null_{col}" for col in cols)
    sql = f"""
        WITH days AS (SELECT city, date_ist, COUNT(*) AS hours FROM `{c.project}.staging.{view}` GROUP BY 1, 2)
        SELECT (SELECT COUNT(*) FROM `{c.project}.staging.{view}`) AS n_rows,
               (SELECT COUNT(DISTINCT city) FROM days) AS cities,
               (SELECT MIN(measured_at_utc) FROM `{c.project}.staging.{view}`) AS first_utc,
               (SELECT MAX(measured_at_utc) FROM `{c.project}.staging.{view}`) AS last_utc,
               MIN(date_ist) AS first_date_ist, MAX(date_ist) AS last_date_ist,
               COUNT(DISTINCT date_ist) AS dates_ist,
               COUNTIF(hours = 24) AS city_days_full, COUNTIF(hours < 24) AS city_days_partial,
               ARRAY_AGG(DISTINCT IF(hours < 24, FORMAT('%t (%d h)', date_ist, hours), NULL) IGNORE NULLS)
                 AS partial_dates,
               (SELECT AS STRUCT {nulls} FROM `{c.project}.staging.{view}`) AS null_counts
        FROM days"""
    r = dict(next(iter(c.query(sql).result())).items())
    r["first_utc"], r["last_utc"] = str(r["first_utc"]), str(r["last_utc"])
    r["first_date_ist"], r["last_date_ist"] = str(r["first_date_ist"]), str(r["last_date_ist"])
    r["nulls"] = {k.removeprefix("null_"): v for k, v in r.pop("null_counts").items()}
    report[view] = r
    print(view, json.dumps(r, default=str))

out = Path(__file__).resolve().parent.parent / "reports" / "staging_latest.json"
out.write_text(json.dumps(report, indent=2, default=str) + "\n")
