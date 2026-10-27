# India Air Quality Warehouse

A daily ELT pipeline for air quality and weather in 15 Indian cities: Open-Meteo APIs → BigQuery → dbt models and
tests → dashboard, scheduled with GitHub Actions and orchestrated with Airflow.

**Status: in progress.** Every number in this README comes from a measured run (`reports/`).

## Plan

| # | Milestone | Status |
|---|---|---|
| M1 | Setup: BigQuery sandbox, service account, Docker | done |
| M2 | Loader: hourly pollutants + weather, backfill from August 2022, idempotent monthly loads | done |
| M3 | dbt staging models, source freshness | done |
| M4 | dbt core models: star schema, Indian AQI (CPCB) | |
| M5 | dbt tests and docs | |
| M6 | Daily schedule on GitHub Actions | |
| M7 | Airflow DAG with backfills | |
| M8 | Dashboard | |
| M9 | Results and limits | |

## Loader (M2)

`loader/` pulls hourly data for every city in [`config/cities.csv`](config/cities.csv) from two APIs and loads it
into BigQuery `raw`:

| Table | Variables | Rows (backfill) | Empty hours |
|---|---|---|---|
| `raw.air_quality_hourly` | PM2.5, PM10, NO₂, O₃, CO, SO₂ | 557,280 | 1,080 (1–3 Aug 2022: the model's history starts on 4 Aug) |
| `raw.weather_hourly` | temperature, humidity, precipitation, wind speed and direction | 557,280 | 0 |

Backfill: 1 Aug 2022 – 26 Oct 2026, 15 cities × 37,152 hours, 150 API requests, about 8 minutes.

**Idempotent without DML.** The free BigQuery sandbox rejects `DELETE`, `UPDATE` and `MERGE`, so the usual
delete-then-insert or merge is unavailable. Instead the raw tables are integer-range partitioned on `month` (YYYYMM),
and every load job overwrites whole partitions (`table$202411`, `WRITE_TRUNCATE`). Re-running any range rewrites
exactly those months. Loading November 2024 twice gave 10,800 rows both times, and the backfill has 0 duplicate
(city, hour) rows. Integer-range partitions also avoid the sandbox's 60-day expiry of time partitions, and each run
pushes the table expiry forward 59 days.

**Daily run.** `--days 10` reloads the current month up to yesterday, so late or revised hours are picked up by
the next run.

```bash
docker compose run --rm app python -m loader.main --start 2022-08-01   # backfill to yesterday
docker compose run --rm app python -m loader.main --days 10            # daily
docker compose run --rm app python -m pytest
```

## dbt staging (M3)

`dbt/` builds on `raw` into the `staging` dataset (views). The profile reads the service-account keyfile and project
from environment variables, so the same project runs in Docker locally and later in CI.

- **Sources** `raw.air_quality_hourly` and `raw.weather_hourly`, with a freshness check on `loaded_at` (warn after
  30 h, error after 54 h; the loader runs daily and always rewrites the current month), plus `not_null` and a custom
  `unique_combination(city, ts)` test.
- **Staging views** `stg_air_quality_hourly` and `stg_weather_hourly`: renamed columns with units
  (`pm25_ugm3`, `temperature_c`, ...), IST timestamp, IST date and hour (UTC+05:30), and only hours from
  2022-08-04 00:00 UTC, where the CAMS history starts.
- **No incremental models.** The sandbox rejects `MERGE`, so every model is a view or a `CREATE OR REPLACE` table.

Measured ([`reports/staging_latest.json`](reports/staging_latest.json)): both views have 556,200 rows (15 cities),
0 nulls in every measure, 23,160 complete city-days. `dbt build`: 2 views and 15 tests, all passing, in 19 s;
`dbt source freshness`: both sources pass. In IST the first and last days are partial (2022-08-04 has 19 hours,
the latest day 5 hours), so daily models will keep complete days only.

```bash
docker compose run --rm app dbt build
docker compose run --rm app dbt source freshness
docker compose run --rm app python scripts/staging_report.py
```

## Data

Air quality: [Open-Meteo Air Quality API](https://open-meteo.com/en/docs/air-quality-api) (CAMS global model, hourly,
from 4 August 2022). Weather: [Open-Meteo Historical Weather API](https://open-meteo.com/en/docs/historical-weather-api)
(ERA5 reanalysis). These are modelled values on a grid, not ground-station readings: the API answers from the nearest
grid cell (Delhi's request at 28.6139, 77.2090 comes back as 28.6, 77.2), and both coordinates are stored.
