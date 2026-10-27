"""Export the marts to the JSON the dashboard reads -> docs/data/dashboard.json.

Every number on the dashboard comes from this file; the page does no statistics of its own beyond formatting.

    python scripts/export_dashboard.py [--out docs/data/dashboard.json]
"""
import argparse
import datetime as dt
import json
import os
from pathlib import Path

from google.cloud import bigquery

ROOT = Path(__file__).resolve().parent.parent
c = bigquery.Client(project=os.environ["GCP_PROJECT"], location=os.environ.get("BQ_LOCATION"))
M = f"`{c.project}.marts`"


def rows(sql: str) -> list[dict]:
    out = []
    for r in c.query(sql).result():
        d = dict(r.items())
        for k, v in d.items():
            if isinstance(v, (dt.date, dt.datetime)):
                d[k] = v.isoformat()
            elif isinstance(v, float):
                d[k] = round(v, 2)
        out.append(d)
    return out


def one(sql: str) -> dict:
    return rows(sql)[0]


data = {
    "generated_at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
    "freshness": one(f"""
        SELECT MAX(measured_at_utc) AS newest_hour_utc, MAX(date_ist) AS newest_date_ist,
               COUNT(*) AS hourly_rows, COUNT(DISTINCT city) AS cities, MIN(date_ist) AS first_date_ist
        FROM {M}.fct_air_quality_hourly"""),
    "totals": one(f"""
        SELECT COUNT(*) AS city_days, MIN(date_ist) AS first_day, MAX(date_ist) AS last_day,
               COUNTIF(dominant_pollutant = 'o3') AS o3_dominant_days,
               COUNTIF(aqi_pm > 200) AS pm_poor_or_worse_days
        FROM {M}.fct_city_daily"""),
    "cities": rows(f"""
        SELECT f.city, d.region, d.is_coastal,
               AVG(f.aqi_pm) AS mean_aqi_pm, AVG(f.aqi) AS mean_aqi, AVG(f.pm25_24h_ugm3) AS mean_pm25,
               COUNTIF(f.aqi_pm > 200) / COUNT(*) AS share_pm_poor,
               COUNTIF(f.dominant_pollutant = 'o3') / COUNT(*) AS share_o3_dominant
        FROM {M}.fct_city_daily f JOIN {M}.dim_city d USING (city)
        GROUP BY 1, 2, 3 ORDER BY mean_aqi_pm DESC"""),
    "categories": rows(f"""
        SELECT city, aqi_pm_category AS category, COUNT(*) AS days
        FROM {M}.fct_city_daily GROUP BY 1, 2"""),
    # "All cities" rows are the mean over the 15 cities, computed here so the page only formats numbers
    "monthly": rows(f"""
        SELECT IFNULL(f.city, 'All cities') AS city, FORMAT_DATE('%Y-%m', f.date_ist) AS month,
               AVG(f.aqi_pm) AS aqi_pm, AVG(f.aqi) AS aqi, AVG(f.pm25_24h_ugm3) AS pm25, COUNT(*) AS days
        FROM {M}.fct_city_daily f GROUP BY GROUPING SETS ((f.city, month), (month)) ORDER BY 1, 2"""),
    # PM2.5 by day relative to each Diwali inside the data, per city and as the 15-city mean
    "diwali": rows(f"""
        SELECT d.year, d.diwali_date, IFNULL(f.city, 'All cities') AS city, d.days_from_diwali AS day,
               AVG(f.pm25_24h_ugm3) AS pm25
        FROM {M}.fct_city_daily f JOIN {M}.dim_date d ON d.date_day = f.date_ist
        WHERE d.days_from_diwali BETWEEN -10 AND 10
          AND d.diwali_date <= (SELECT MAX(date_ist) FROM {M}.fct_city_daily)
        GROUP BY GROUPING SETS ((d.year, d.diwali_date, f.city, d.days_from_diwali),
                                (d.year, d.diwali_date, d.days_from_diwali))
        ORDER BY 1, 3, 4"""),
    # week before (days -7..-1) vs Diwali day vs the two days after, per year and city
    "diwali_summary": rows(f"""
        SELECT d.year, IFNULL(f.city, 'All cities') AS city,
               AVG(IF(d.days_from_diwali BETWEEN -7 AND -1, f.pm25_24h_ugm3, NULL)) AS week_before,
               AVG(IF(d.days_from_diwali = 0, f.pm25_24h_ugm3, NULL)) AS diwali_day,
               AVG(IF(d.days_from_diwali BETWEEN 1 AND 2, f.pm25_24h_ugm3, NULL)) AS two_days_after
        FROM {M}.fct_city_daily f JOIN {M}.dim_date d ON d.date_day = f.date_ist
        WHERE d.days_from_diwali BETWEEN -7 AND 2
          AND d.diwali_date <= (SELECT MAX(date_ist) FROM {M}.fct_city_daily)
        GROUP BY GROUPING SETS ((d.year, f.city), (d.year)) ORDER BY 2, 1"""),
    "rain": rows(f"""
        WITH b AS (
          SELECT d.season, f.pm25_24h_ugm3 AS pm25,
                 CASE WHEN f.precipitation_mm < 0.1 THEN 0 WHEN f.precipitation_mm < 2.5 THEN 1
                      WHEN f.precipitation_mm < 10 THEN 2 WHEN f.precipitation_mm < 30 THEN 3 ELSE 4 END AS bucket
          FROM {M}.fct_city_daily f JOIN {M}.dim_date d ON d.date_day = f.date_ist)
        SELECT 'all' AS scope, bucket, AVG(pm25) AS mean_pm25, COUNT(*) AS days FROM b GROUP BY bucket
        UNION ALL
        SELECT 'monsoon', bucket, AVG(pm25), COUNT(*) FROM b WHERE season = 'Monsoon' GROUP BY bucket
        ORDER BY scope, bucket"""),
    "hourly_profile": rows(f"""
        SELECT IFNULL(h.city, 'All cities') AS city, h.hour_ist AS hour, AVG(h.pm25_ugm3) AS pm25, AVG(h.o3_ugm3) AS o3
        FROM {M}.fct_air_quality_hourly h GROUP BY GROUPING SETS ((h.city, h.hour_ist), (h.hour_ist)) ORDER BY 1, 2"""),
    "season": rows(f"""
        SELECT f.city, d.month, AVG(f.aqi_pm) AS aqi_pm
        FROM {M}.fct_city_daily f JOIN {M}.dim_date d ON d.date_day = f.date_ist
        GROUP BY 1, 2 ORDER BY 1, 2"""),
}

parser = argparse.ArgumentParser()
parser.add_argument("--out", default=str(ROOT / "docs" / "data" / "dashboard.json"))
out = Path(parser.parse_args().out)
out.parent.mkdir(parents=True, exist_ok=True)
out.write_text(json.dumps(data, separators=(",", ":"), default=str))
print(f"wrote {out} ({out.stat().st_size / 1024:.0f} KiB)")
