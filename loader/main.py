"""Load hourly air quality and weather for every city in dbt/seeds/cities.csv into BigQuery `raw`.

    python -m loader.main --start 2022-08-01 --end 2026-10-26   # backfill
    python -m loader.main --days 10                              # daily run: the last 10 days, up to yesterday

Loads replace whole months, so --start is rounded down to the 1st of its month. The daily run reloads
the trailing days so that late or revised hours are picked up. A JSON report goes to reports/load_latest.json.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import time
from pathlib import Path

import pandas as pd
import requests
from google.cloud import bigquery

from loader import fetch as api
from loader import load

ROOT = Path(__file__).resolve().parent.parent
CHUNK_DAYS = 366  # one request per city per year of data


def chunks(start: dt.date, end: dt.date, days: int = CHUNK_DAYS) -> list[tuple[dt.date, dt.date]]:
    out, cur = [], start
    while cur <= end:
        stop = min(cur + dt.timedelta(days=days - 1), end)
        out.append((cur, stop))
        cur = stop + dt.timedelta(days=1)
    return out


def date_range(args: argparse.Namespace, today: dt.date) -> tuple[dt.date, dt.date]:
    end = dt.date.fromisoformat(args.end) if args.end else today - dt.timedelta(days=1)
    start = dt.date.fromisoformat(args.start) if args.start else end - dt.timedelta(days=args.days - 1)
    if start > end:
        raise SystemExit(f"start {start} is after end {end}")
    return start.replace(day=1), end  # a partition is a whole month


def run(start: dt.date, end: dt.date, cities: pd.DataFrame, client: bigquery.Client, dataset: str) -> dict:
    session = requests.Session()
    report = {"start": str(start), "end": str(end), "cities": len(cities), "tables": {}}
    for source in api.SOURCES:
        started, requests_made = time.perf_counter(), 0
        frames = []
        for city in cities.itertuples():
            for a, b in chunks(start, end):
                frames.append(api.fetch(source, city.city, city.latitude, city.longitude, str(a), str(b), session))
                requests_made += 1
        df = pd.concat(frames, ignore_index=True)
        df = df[(df["ts"].dt.date >= start) & (df["ts"].dt.date <= end)]
        dupes = int(df.duplicated(["city", "ts"]).sum())
        if dupes:
            raise ValueError(f"{source.table}: {dupes} duplicate (city, ts) rows from the API")
        table = load.ensure_table(client, dataset, source)
        written = load.replace_months(client, table, df)
        expires = load.extend_expiry(client, table)
        report["tables"][source.table] = {
            "rows": len(df), "months_replaced": len(written), "api_requests": requests_made,
            "null_cells": {v: int(df[v].isna().sum()) for v in source.variables},
            "first_ts": str(df["ts"].min()), "last_ts": str(df["ts"].max()),
            "table_expires": str(expires) if expires else None,
            "seconds": round(time.perf_counter() - started, 1),
        }
        print(f"[{source.table}] {len(df):,} rows, {len(written)} months, {requests_made} requests, "
              f"{report['tables'][source.table]['seconds']}s", flush=True)
    return report


def main() -> None:
    parser = argparse.ArgumentParser(prog="loader")
    parser.add_argument("--start", help="first date, YYYY-MM-DD (rounded down to the month)")
    parser.add_argument("--end", help="last date, YYYY-MM-DD (default: yesterday, UTC)")
    parser.add_argument("--days", type=int, default=10, help="without --start: this many days up to --end")
    parser.add_argument("--dataset", default="raw")
    args = parser.parse_args()

    start, end = date_range(args, dt.datetime.now(dt.timezone.utc).date())
    cities = pd.read_csv(ROOT / "dbt" / "seeds" / "cities.csv")
    client = bigquery.Client(project=os.environ["GCP_PROJECT"], location=os.environ.get("BQ_LOCATION", "asia-south1"))
    report = run(start, end, cities, client, args.dataset)

    out = ROOT / "reports"
    out.mkdir(exist_ok=True)
    (out / "load_latest.json").write_text(json.dumps(report, indent=2) + "\n")


if __name__ == "__main__":
    main()
