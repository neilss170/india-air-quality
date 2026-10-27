# India Air Quality Warehouse

A daily ELT pipeline for air quality and weather in 15 Indian cities: Open-Meteo APIs → BigQuery → dbt models and
tests → dashboard, scheduled with GitHub Actions and orchestrated with Airflow.

**Status: in progress.** Every number in this README will come from a measured run.

## Plan

| # | Milestone | Status |
|---|---|---|
| M1 | Setup: BigQuery sandbox, service account, Docker | in progress |
| M2 | Loader: hourly PM2.5 / PM10 / NO₂ / O₃ + weather, backfill from July 2022, incremental | |
| M3 | dbt staging models, source freshness | |
| M4 | dbt core models: star schema, Indian AQI (CPCB) | |
| M5 | dbt tests and docs | |
| M6 | Daily schedule on GitHub Actions | |
| M7 | Airflow DAG with backfills | |
| M8 | Dashboard | |
| M9 | Results and limits | |

## Cities

15 cities across North, East, Northeast, West and South India: see [`config/cities.csv`](config/cities.csv).

## Data

Air quality: [Open-Meteo Air Quality API](https://open-meteo.com/en/docs/air-quality-api) (CAMS model data, hourly, from
July 2022). Weather: [Open-Meteo Historical Weather API](https://open-meteo.com/en/docs/historical-weather-api).
These are modelled values on a grid, not ground-station readings.
