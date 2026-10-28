"""Load daily PM2.5 and PM10 from ground stations near each city (OpenAQ v3) into BigQuery `raw.station_pm_daily`.

    python -m loader.stations --start 2022-08-01 --end 2026-10-27   # backfill
    python -m loader.stations --days 35                              # weekly run

For each city: the NEAREST reference monitors within 25 km (OpenAQ `monitor=true`, so no low-cost sensors) with
PM data in the window, then each PM sensor's daily means. OpenAQ's days run midnight to midnight local time (IST),
like `date_ist` in the marts. Stations change sensor ids over time (in Delhi, 2016-2018 and again from 2025), so
sensors are picked by their own date ranges. Whole months are replaced, as for the Open-Meteo tables.
Needs OPENAQ_API_KEY. A JSON report goes to reports/stations_latest.json.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import math
import os
import time
from pathlib import Path

import pandas as pd
import requests
from google.cloud import bigquery

from loader import load
from loader.main import date_range

ROOT = Path(__file__).resolve().parent.parent
API = "https://api.openaq.org/v3"
TABLE = "station_pm_daily"
NEAREST = 6           # monitors per city; dbt then uses the 3 nearest with a complete day
RADIUS_M = 25_000     # the API's maximum search radius
PAGE = 1000
PAUSE_S = 1.05        # the free key allows 60 requests a minute
PARAMETERS = ("pm25", "pm10")

SCHEMA = [
    bigquery.SchemaField("city", "STRING", mode="REQUIRED"),
    bigquery.SchemaField("location_id", "INT64", mode="REQUIRED"),
    bigquery.SchemaField("location_name", "STRING"),
    bigquery.SchemaField("provider", "STRING"),
    bigquery.SchemaField("distance_km", "FLOAT64", description="from the city coordinates in the cities seed"),
    bigquery.SchemaField("sensor_id", "INT64", mode="REQUIRED"),
    bigquery.SchemaField("parameter", "STRING", mode="REQUIRED"),
    bigquery.SchemaField("units", "STRING"),
    bigquery.SchemaField("date_local", "DATE", mode="REQUIRED", description="the station's local (IST) day"),
    bigquery.SchemaField("value", "FLOAT64", description="mean of the day's measurements"),
    bigquery.SchemaField("value_min", "FLOAT64"),
    bigquery.SchemaField("value_max", "FLOAT64"),
    bigquery.SchemaField("observed_count", "INT64", description="measurements averaged; can exceed 24"),
    bigquery.SchemaField("first_obs_utc", "TIMESTAMP"),
    bigquery.SchemaField("last_obs_utc", "TIMESTAMP"),
    bigquery.SchemaField("month", "INT64", mode="REQUIRED", description="YYYYMM of date_local: the partition key"),
    bigquery.SchemaField("loaded_at", "TIMESTAMP", mode="REQUIRED"),
]


class OpenAQ:
    def __init__(self, key: str):
        self.session = requests.Session()
        self.session.headers["X-API-Key"] = key
        self.requests = 0
        self.skipped: list[str] = []  # paths that kept failing; reported, not fatal

    def get_or_skip(self, path: str, **params) -> dict | None:
        """Like get(), but a path that still fails after the retries is recorded and skipped: one broken
        station on OpenAQ's side (it happens: a persistent HTTP 500) should not stop the other 89."""
        try:
            return self.get(path, **params)
        except requests.HTTPError as e:
            self.skipped.append(f"{path}: {e.response.status_code}")
            print(f"skipped {path} ({e.response.status_code})", flush=True)
            return None

    def get(self, path: str, **params) -> dict:
        for attempt in range(1, 5):
            resp = self.session.get(API + path, params=params, timeout=60)
            self.requests += 1
            time.sleep(PAUSE_S)
            if resp.status_code == 429 or resp.status_code >= 500:
                time.sleep(int(resp.headers.get("X-Ratelimit-Reset", 30)) + attempt * 5)
                continue
            resp.raise_for_status()
            return resp.json()
        resp.raise_for_status()
        raise RuntimeError(f"{path}: still failing after retries")


def km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    p = math.pi / 180
    a = math.sin((lat2 - lat1) * p / 2) ** 2 + math.cos(lat1 * p) * math.cos(lat2 * p) * math.sin((lon2 - lon1) * p / 2) ** 2
    return 6371 * 2 * math.asin(math.sqrt(a))


def overlaps(span: dict, start: dt.date, end: dt.date) -> bool:
    """True if an OpenAQ object's datetimeFirst..datetimeLast (local) overlaps [start, end]."""
    first = (span.get("datetimeFirst") or {}).get("local", "")[:10]
    last = (span.get("datetimeLast") or {}).get("local", "")[:10]
    return bool(first and last) and first <= str(end) and last >= str(start)


def nearest_sensors(api: OpenAQ, lat: float, lon: float, start: dt.date, end: dt.date) -> list[dict]:
    """PM sensors of the NEAREST monitors that have PM data in [start, end], nearest first."""
    found = api.get("/locations", coordinates=f"{lat},{lon}", radius=RADIUS_M, limit=PAGE, monitor="true")["results"]
    found = [l for l in found if overlaps(l, start, end)]
    found.sort(key=lambda l: km(lat, lon, l["coordinates"]["latitude"], l["coordinates"]["longitude"]))
    picked = []
    for loc in found:
        listed = api.get_or_skip(f"/locations/{loc['id']}/sensors")
        sensors = [s for s in (listed or {"results": []})["results"]
                   if s["parameter"]["name"] in PARAMETERS and overlaps(s, start, end)]
        if not sensors:
            continue
        dist = km(lat, lon, loc["coordinates"]["latitude"], loc["coordinates"]["longitude"])
        picked += [{"location_id": loc["id"], "location_name": loc["name"], "provider": loc["provider"]["name"],
                    "distance_km": round(dist, 2), "sensor_id": s["id"], "parameter": s["parameter"]["name"],
                    "units": s["parameter"]["units"]} for s in sensors]
        if len({p["location_id"] for p in picked}) == NEAREST:
            break
    return picked


def to_frame(results: list[dict], sensor: dict, city: str) -> pd.DataFrame:
    """OpenAQ /sensors/{id}/days results -> one row per local day. No network, so it is unit-tested."""
    rows = [{
        "city": city, **sensor,
        "date_local": dt.date.fromisoformat(r["period"]["datetimeFrom"]["local"][:10]),
        "value": r.get("value"),
        "value_min": (r.get("summary") or {}).get("min"),
        "value_max": (r.get("summary") or {}).get("max"),
        "observed_count": (r.get("coverage") or {}).get("observedCount"),
        "first_obs_utc": ((r.get("coverage") or {}).get("datetimeFrom") or {}).get("utc"),
        "last_obs_utc": ((r.get("coverage") or {}).get("datetimeTo") or {}).get("utc"),
    } for r in results]
    df = pd.DataFrame(rows, columns=[f.name for f in SCHEMA if f.name not in ("month", "loaded_at")])
    for col in ("value", "value_min", "value_max", "distance_km"):
        df[col] = pd.to_numeric(df[col], errors="coerce").astype("float64")
    df["observed_count"] = pd.to_numeric(df["observed_count"], errors="coerce").astype("Int64")
    for col in ("first_obs_utc", "last_obs_utc"):
        df[col] = pd.to_datetime(df[col], utc=True)
    return df


def daily_values(api: OpenAQ, sensor_id: int, start: dt.date, end: dt.date) -> list[dict]:
    out, page = [], 1
    while True:
        got = api.get_or_skip(f"/sensors/{sensor_id}/days", date_from=str(start), date_to=str(end), limit=PAGE, page=page)
        if got is None:
            return []  # a sensor that fails is left out whole, never half-loaded
        res = got["results"]
        out += res
        if len(res) < PAGE:
            return out
        page += 1


def run(start: dt.date, end: dt.date, cities: pd.DataFrame, api: OpenAQ, client: bigquery.Client, dataset: str) -> dict:
    started = time.perf_counter()
    frames, per_city = [], {}
    for c in cities.itertuples():
        sensors = nearest_sensors(api, c.latitude, c.longitude, start, end)
        for s in sensors:
            frames.append(to_frame(daily_values(api, s["sensor_id"], start, end), s, c.city))
        per_city[c.city] = {"stations": len({s["location_id"] for s in sensors}), "sensors": len(sensors)}
        print(f"[{c.city}] {per_city[c.city]['stations']} stations, {len(sensors)} PM sensors, {api.requests} requests so far", flush=True)
    df = pd.concat(frames, ignore_index=True)
    df = df[(df["date_local"] >= start) & (df["date_local"] <= end)]
    dupes = int(df.duplicated(["city", "sensor_id", "date_local"]).sum())
    if dupes:
        raise ValueError(f"{TABLE}: {dupes} duplicate (city, sensor_id, date_local) rows from the API")
    table = load.ensure_partitioned(client, f"{client.project}.{dataset}.{TABLE}", SCHEMA)
    written = load.replace_months(client, table, df, time_col="date_local")
    expires = load.extend_expiry(client, table)
    return {"start": str(start), "end": str(end), "cities": per_city, "rows": len(df), "months_replaced": len(written),
            "api_requests": api.requests, "skipped": api.skipped, "first_day": str(df["date_local"].min()), "last_day": str(df["date_local"].max()),
            "table_expires": str(expires) if expires else None, "seconds": round(time.perf_counter() - started, 1)}


def main() -> None:
    parser = argparse.ArgumentParser(prog="loader.stations")
    parser.add_argument("--start", help="first date, YYYY-MM-DD (rounded down to the month)")
    parser.add_argument("--end", help="last date, YYYY-MM-DD (default: yesterday, UTC)")
    parser.add_argument("--days", type=int, default=35, help="without --start: this many days up to --end")
    parser.add_argument("--dataset", default="raw")
    args = parser.parse_args()

    start, end = date_range(args, dt.datetime.now(dt.timezone.utc).date())
    cities = pd.read_csv(ROOT / "dbt" / "seeds" / "cities.csv")
    client = bigquery.Client(project=os.environ["GCP_PROJECT"], location=os.environ.get("BQ_LOCATION", "asia-south1"))
    report = run(start, end, cities, OpenAQ(os.environ["OPENAQ_API_KEY"]), client, args.dataset)
    print(json.dumps({k: v for k, v in report.items() if k != "cities"}))

    out = ROOT / "reports"
    out.mkdir(exist_ok=True)
    (out / "stations_latest.json").write_text(json.dumps(report, indent=2) + "\n")


if __name__ == "__main__":
    main()
