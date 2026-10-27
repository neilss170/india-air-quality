"""Rows per raw table, plus (city, ts) duplicates: the idempotency check."""
import os
from google.cloud import bigquery
c = bigquery.Client(project=os.environ["GCP_PROJECT"], location=os.environ.get("BQ_LOCATION"))
for t in ("air_quality_hourly", "weather_hourly"):
    r = next(iter(c.query(f"SELECT COUNT(*) n, COUNT(*) - COUNT(DISTINCT FORMAT('%s|%t', city, ts)) dupes, "
                          f"COUNT(DISTINCT city) cities, MIN(ts) lo, MAX(ts) hi FROM `{c.project}.raw.{t}`").result()))
    print(f"{t}: rows={r.n:,} duplicates={r.dupes} cities={r.cities} {r.lo:%Y-%m-%d %H:%M} .. {r.hi:%Y-%m-%d %H:%M}")
