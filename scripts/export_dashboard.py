"""Export the marts to the JSON the dashboard reads -> docs/data/dashboard.json.

Every number on the dashboard comes from this file; the page does no statistics of its own beyond formatting.
The Pipeline tab also reads the run's reports (loader, dbt build, source freshness), BigQuery table metadata and
the workflow's run history from the GitHub API; each part is left out when its source is missing (e.g. locally).

    python scripts/export_dashboard.py [--out docs/data/dashboard.json]
"""
import argparse
import datetime as dt
import json
import os
import urllib.request
from collections import Counter
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

# ---------- City tab ----------
# every complete day's PM index per city, as one array per city aligned to consecutive dates from `start`
daily = rows(f"SELECT city, date_ist, aqi_pm FROM {M}.fct_city_daily ORDER BY city, date_ist")
start = min(dt.date.fromisoformat(r["date_ist"]) for r in daily)
end = max(dt.date.fromisoformat(r["date_ist"]) for r in daily)
series = {}
for r in daily:
    s = series.setdefault(r["city"], [None] * ((end - start).days + 1))
    s[(dt.date.fromisoformat(r["date_ist"]) - start).days] = r["aqi_pm"]
data["daily_pm"] = {"start": start.isoformat(), "cities": series}

CITY_DAY = """f.city, f.date_ist, f.aqi_pm, f.aqi_pm_category, f.aqi, f.aqi_category, f.dominant_pollutant,
              IF(f.pm25_sub_index >= f.pm10_sub_index, 'pm25', 'pm10') AS pm_driver,
              f.pm25_24h_ugm3 AS pm25, f.pm10_24h_ugm3 AS pm10, f.temperature_mean_c AS temp_c,
              f.precipitation_mm AS rain_mm, f.wind_speed_mean_kmh AS wind_kmh"""
data["latest_day"] = rows(f"""
    SELECT {CITY_DAY}, RANK() OVER (PARTITION BY f.date_ist ORDER BY f.aqi_pm DESC) AS rank_that_day
    FROM {M}.fct_city_daily f
    QUALIFY f.date_ist = MAX(f.date_ist) OVER () ORDER BY f.aqi_pm DESC""")
data["worst_days"] = rows(f"""
    SELECT {CITY_DAY} FROM {M}.fct_city_daily f
    QUALIFY ROW_NUMBER() OVER (PARTITION BY f.city ORDER BY f.aqi_pm DESC, f.date_ist) <= 10
    ORDER BY f.city, f.aqi_pm DESC, f.date_ist""")


# ---------- Model check tab ----------
# bias = model mean / station mean - 1 over the same city-days; r = Pearson correlation of the daily values
SV = f"{M}.fct_station_vs_model_daily"
COMPARE = """COUNT(*) AS days, COUNT(DISTINCT v.city) AS cities, AVG(v.stations) AS mean_stations,
             AVG(v.model_ugm3) AS model, AVG(v.station_ugm3) AS station,
             SAFE_DIVIDE(AVG(v.model_ugm3), AVG(v.station_ugm3)) - 1 AS bias, CORR(v.model_ugm3, v.station_ugm3) AS r,
             SQRT(AVG(POW(v.model_minus_station_ugm3, 2))) AS rmse"""
# "All cities" rows pool every compared city-day; columns are table-qualified so GROUPING SETS leaves v.city null there
data["check"] = {
    "summary": rows(f"""
        SELECT IFNULL(v.city, 'All cities') AS city, v.parameter, {COMPARE},
               MIN(v.date_ist) AS first_day, MAX(v.date_ist) AS last_day
        FROM {SV} v GROUP BY GROUPING SETS ((v.city, v.parameter), (v.parameter)) ORDER BY 1, 2"""),
    "by_cycle": rows(f"""
        SELECT IFNULL(v.city, 'All cities') AS city, v.parameter, v.model_cycle, {COMPARE}
        FROM {SV} v GROUP BY GROUPING SETS ((v.city, v.parameter, v.model_cycle), (v.parameter, v.model_cycle))
        ORDER BY 1, 2, 3"""),
    # months with at least 10 compared days, so a month is never one or two odd days
    "monthly": rows(f"""
        SELECT city, parameter, FORMAT_DATE('%Y-%m', date_ist) AS month,
               AVG(model_ugm3) AS model, AVG(station_ugm3) AS station, COUNT(*) AS days
        FROM {SV} GROUP BY 1, 2, 3 HAVING COUNT(*) >= 10 ORDER BY 1, 2, 3"""),
    "cycles": rows(f"SELECT cycle, start_date, dust_change FROM `{c.project}.reference.cams_model_cycles` ORDER BY start_date"),
}


# ---------- Pipeline tab ----------
def read_json(path: Path):
    return json.loads(path.read_text()) if path.exists() else None


def node_name(unique_id: str) -> str:
    # model.<project>.<name>, test.<project>.<name>.<hash>, unit_test.<project>.<model>.<name>
    parts = unique_id.split(".")
    return ".".join(parts[2:4]) if parts[0] == "unit_test" else parts[2]


def github_runs(limit: int = 30) -> list[dict] | None:
    """Recent completed runs of the daily workflow (the run that is exporting is still in progress, so not listed)."""
    repo = os.environ.get("GITHUB_REPOSITORY", "neilss170/india-air-quality")
    req = urllib.request.Request(
        f"https://api.github.com/repos/{repo}/actions/workflows/daily.yml/runs?status=completed&per_page={limit}",
        headers={"Accept": "application/vnd.github+json"})
    if os.environ.get("GITHUB_TOKEN"):
        req.add_header("Authorization", f"Bearer {os.environ['GITHUB_TOKEN']}")
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            runs = json.load(resp)["workflow_runs"]
    except OSError as e:
        print(f"GitHub run history unavailable: {e}")
        return None
    ts = lambda s: dt.datetime.fromisoformat(s.replace("Z", "+00:00"))
    return [{"started_at": r["run_started_at"], "event": r["event"], "conclusion": r["conclusion"],
             "seconds": round((ts(r["updated_at"]) - ts(r["run_started_at"])).total_seconds()),
             "sha": r["head_sha"][:7], "url": r["html_url"]} for r in runs]


runs = github_runs()
pipeline = {"runs": runs, "load": read_json(ROOT / "reports" / "load_latest.json")}
if runs:
    secs = sorted(r["seconds"] for r in runs if r["conclusion"] == "success")
    pipeline["runs_summary"] = {
        "completed": len(runs), "succeeded": sum(r["conclusion"] == "success" for r in runs),
        "scheduled": sum(r["event"] == "schedule" for r in runs),
        "scheduled_succeeded": sum(r["event"] == "schedule" and r["conclusion"] == "success" for r in runs),
        "median_success_s": secs[len(secs) // 2] if secs else None}

build = read_json(ROOT / "reports" / "dbt_build_results.json")
if build:
    nodes = [{"name": node_name(r["unique_id"]), "type": r["unique_id"].split(".")[0], "status": r["status"],
              "seconds": round(r["execution_time"], 1), "message": r.get("message"), "failures": r.get("failures")}
             for r in build["results"]]
    pipeline["dbt"] = {
        "generated_at": build["metadata"]["generated_at"], "elapsed_s": round(build["elapsed_time"], 1),
        "counts": [{"type": t, "status": s, "n": n}
                   for (t, s), n in sorted(Counter((n["type"], n["status"]) for n in nodes).items())],
        "checks": sum(n["type"] in ("test", "unit_test") for n in nodes),
        "checks_passed": sum(n["type"] in ("test", "unit_test") and n["status"] == "pass" for n in nodes),
        "not_passing": [n for n in nodes if n["status"] not in ("pass", "success")],
        "slowest_models": sorted((n for n in nodes if n["type"] == "model"), key=lambda n: -n["seconds"])[:5],
    }

fresh = read_json(ROOT / "dbt" / "target" / "sources.json")
if fresh:
    pipeline["freshness"] = [{"source": r["unique_id"].split(".")[-1], "status": r["status"],
                              "max_loaded_at": r["max_loaded_at"], "checked_at": r["snapshotted_at"]}
                             for r in fresh["results"]]

pipeline["tables"] = []
for ds in ("raw", "marts", "reference"):
    for item in c.list_tables(f"{c.project}.{ds}"):
        t = c.get_table(item.reference)
        pipeline["tables"].append({"table": f"{ds}.{t.table_id}", "rows": t.num_rows, "mib": round(t.num_bytes / 2**20, 1),
                                   "expires": t.expires.isoformat() if t.expires else None})
data["pipeline"] = pipeline

parser = argparse.ArgumentParser()
parser.add_argument("--out", default=str(ROOT / "docs" / "data" / "dashboard.json"))
out = Path(parser.parse_args().out)
out.parent.mkdir(parents=True, exist_ok=True)
out.write_text(json.dumps(data, separators=(",", ":"), default=str))
print(f"wrote {out} ({out.stat().st_size / 1024:.0f} KiB)")
