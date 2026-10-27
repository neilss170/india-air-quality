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
| M4 | dbt core models: star schema, Indian AQI (CPCB) | done |
| M5 | dbt tests and docs | done |
| M6 | Daily schedule on GitHub Actions | done |
| M7 | Airflow DAG with backfills | done |
| M8 | Dashboard | done |
| M9 | Results and limits | |

## Loader (M2)

`loader/` pulls hourly data for every city in [`config/cities.csv`](config/cities.csv) from two APIs and loads it
into BigQuery `raw`:

| Table | Variables | Rows (backfill) | Empty hours |
|---|---|---|---|
| `raw.air_quality_hourly` | PM2.5, PM10, NO₂, O₃, CO, SO₂ | 557,280 | 1,080 (1–3 Aug 2022: the model's history starts on 4 Aug) |
| `raw.weather_hourly` | temperature, humidity, precipitation, wind speed and direction | 557,280 | 0 |

Backfill: 1 Aug 2022 – 26 Oct 2026, 15 cities × 37,152 hours, 150 API requests, about 8 minutes
([`reports/load_backfill_2022-08_2026-10.json`](reports/load_backfill_2022-08_2026-10.json); `reports/load_latest.json` is
overwritten by every load).

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

## Star schema and Indian AQI (M4)

```
reference (seeds)            marts (tables, rebuilt daily)
  cities ------------------>  dim_city   (15)
  indian_festivals -------->  dim_date   (1,546 IST days: IMD season, festivals, days from Diwali)
  cpcb_aqi_breakpoints --+    fct_air_quality_hourly (556,200: pollutants + weather, 8 h rolling O3/CO)
                         +->  fct_city_daily         (23,160 complete city-days: CPCB AQI, category, dominant pollutant)
```

**AQI method (CPCB National AQI, 2014).** 24-hour means for PM2.5, PM10, NO2 and SO2; the day's highest 8-hour mean
for O3 and CO (CO converted to mg/m³). Each pollutant's sub-index is interpolated linearly inside its band, and the
AQI is the highest sub-index. Two choices CPCB leaves open: its integer breakpoints have gaps (PM2.5 Good ends at 30,
Satisfactory starts at 31), so each band here starts where the previous one ends; and the Severe band is open-ended, so
its upper concentration repeats the Very Poor band's width and the AQI is capped at 500. The 8-hour window is a time
range, not a row count, and is only used when all 8 hours exist. Days with fewer than 24 IST hours are excluded.
Festival dates come from the central government (DoPT) holiday lists; 2022 and 2026 Diwali were not checked against
one, and the seed says so.

**Verified independently.** [`scripts/marts_report.py`](scripts/marts_report.py) recomputes the AQI in pandas from
the hourly staging view and the breakpoint CSV for 200 random city-days: 200/200 equal AQI and dominant pollutant.
The first run gave 197/200; the 3 differences were sub-indices of exactly x.5, which BigQuery rounds up and
Python's `round` rounds to even, so the check now rounds half up. `dbt build`: 3 seeds, 2 views, 4 tables,
42 tests, all passing.

**Finding: modelled ozone sets the AQI.** Ozone is the dominant pollutant on 20,622 of 23,160 city-days (89%); PM2.5
on 1,815, PM10 on 686. The median daily 8-hour ozone maximum is 103-154 µg/m³ in every city, including coastal Kochi
and Chennai, and anything over 100 is already "Moderate". Global chemistry models have been reported to simulate
higher ozone than observed at Indian sites, partly because coarse grids miss the urban NOx that removes ozone
([Hakim et al., 2019](https://acp.copernicus.org/articles/19/6437/2019/); not a CAMS-specific study). So this AQI is
the CPCB formula applied to model output, not the official CPCB figure from ground stations. To show the particulate
picture, `fct_city_daily` also has `aqi_pm`, the higher of the PM2.5 and PM10 sub-indices (not a CPCB index):

| City | Mean AQI (all 6) | Days Poor or worse | Mean PM-only AQI | Days Poor or worse (PM) |
|---|---|---|---|---|
| Delhi | 236 | 56.9% | 182 | 36.1% |
| Kanpur | 194 | 34.1% | 137 | 22.7% |
| Lucknow | 187 | 31.7% | 122 | 17.9% |
| Patna | 200 | 41.7% | 122 | 19.9% |
| Kolkata | 183 | 39.0% | 117 | 21.7% |
| Mumbai | 184 | 41.8% | 80 | 6.3% |
| Bengaluru | 113 | 4.8% | 35 | 0.0% |

All 15 cities: [`reports/marts_latest.json`](reports/marts_latest.json) (5 Aug 2022 - 26 Oct 2026). Across all
city-days, the full AQI is Severe on 127 days and the PM-only index is also Severe on 127.

```bash
docker compose run --rm app python scripts/marts_report.py
```

## Tests and docs (M5)

`dbt build` runs 72 data tests and 1 unit test: 80 pass, 2 warn by design, 0 fail (43 s for the whole build).

| Kind | What it checks |
|---|---|
| Keys | `unique`/`not_null` on dimensions; custom `unique_combination` on (city, hour) and (city, day) |
| Relationships | every fact row's city is in `dim_city` and its IST date in `dim_date` |
| Accepted values | AQI category, dominant pollutant, region, season; `hours` = 24 and 6 pollutants indexed on every day |
| Value ranges | custom `accepted_range`: pollutants ≥ 0 with physical upper limits, humidity 0-100, AQI and sub-indices 0-500 |
| Completeness | custom `complete_hours_per_day`: every city has exactly 24 hours on every interior IST day; a singular test checks `fct_city_daily` has every city × day |
| Recency | warns if a city's newest hour is over 72 h old (source freshness covers the loader's run time) |
| Unit test | `fct_city_daily` on fixed inputs with hand-computed answers: band interpolation (PM2.5 45 → 75), Severe (300 → 438), the 500 cap, a value on a breakpoint, alternating hours averaged, a 23-hour day excluded. Changing one expected value to a wrong number makes it fail. |

**The 2 warnings are real data.** The model returned 54 negative hourly concentrations (53 ozone, down to
-7 µg/m³; 1 NO₂), all in August and September 2022. Raw keeps them and a warn-level test counts them on every run;
staging floors them at 0. The same checks found that the 122 hours of ozone above 500 µg/m³ all fall on Mumbai
(peak 930 on 13 March 2023), which is why Mumbai's full AQI is high while its PM-only index is not.

**Deterministic AQI.** Re-running the build changed a few daily AQIs by 1 point with no change in the data. BigQuery's
`AVG` does not add floats in a fixed order, and with one-decimal inputs many sub-indices land on exactly x.5, so the
last bit decided the rounding. Sub-indices are now rounded to 6 decimals before the AQI is rounded; two rebuilds
then gave identical reports, and the independent check stayed at 200/200.

**Docs:** [neilss170.github.io/india-air-quality/dbt](https://neilss170.github.io/india-air-quality/dbt/): model and
column descriptions, tests and the lineage graph (`dbt docs generate --static`, built and deployed by the daily workflow).

```bash
docker compose run --rm app dbt build
docker compose run --rm app dbt docs generate --static   # writes dbt/target/static_index.html
```

## Daily schedule (M6)

Two GitHub Actions workflows:

- [`daily.yml`](.github/workflows/daily.yml), every day at 02:30 UTC (08:00 IST) and on demand:
  loader `--days 10` → `dbt source freshness` → `dbt build` → `dbt docs generate` → deploy the site to GitHub Pages.
  The loader and dbt reports are kept as a run artifact, and a summary (rows per table, dbt pass/warn/fail) is
  written to the run page. Any failed test stops the run before anything is published.
- [`ci.yml`](.github/workflows/ci.yml), on every push and pull request: the loader's unit tests and `dbt parse`.
  It needs no credentials.

The service-account key is a repository secret (`GCP_SA_KEY`), written to disk only for the length of the run and
deleted at the end; the project ID and location are repository variables.

Measured on the first run (27 Oct 2026, started by hand): the job took 3 min 14 s plus 9 s to deploy. The loader
replaced October 2026 in both tables (9,360 rows each, 15 cities × 624 hours, 0 empty cells) in 46 s, and the raw
tables stayed at 557,280 rows, so the daily reload adds no duplicates. `dbt build`: 80 pass, 2 warn (the known negative
model values), 0 fail, in 77 s. CI took 47 s.

**Limits.** GitHub may start scheduled runs late when it is busy, and it turns off scheduled workflows in a public
repository after 60 days without activity. The BigQuery sandbox also expires tables 60 days after they are created,
so if the schedule stops for 60 days the `raw` tables expire and need a fresh backfill (`--start 2022-08-01`).

## Airflow for backfills (M7)

GitHub Actions is the always-on scheduler. Airflow runs locally in Docker for orchestration and backfills: free,
always-on Airflow hosting does not exist, and the daily job does not need it.
[`orchestration/dags/india_air_quality.py`](orchestration/dags/india_air_quality.py) is the same pipeline with one
run per calendar month:

```
load_month -> check_month -> source_freshness -> dbt_build
```

`check_month` ([`scripts/check_month.py`](scripts/check_month.py)) fails the run unless the month holds exactly one
row per city per hour in both raw tables. Airflow 3.3.2 is installed in its own virtualenv on top of the pipeline
image, so its dependency pins never touch dbt's; the image adds about 350 MB to the 1.4 GB pipeline image.

```bash
docker compose build app && docker compose --profile airflow up -d airflow      # UI on localhost:8080
docker compose --profile airflow exec airflow airflow dags unpause india_air_quality_monthly
docker compose --profile airflow exec airflow airflow backfill create     --dag-id india_air_quality_monthly --from-date 2024-11-01 --to-date 2024-11-01
```

**Backfill of November 2024 (measured).** One run, 93 s: load 30 s, check 3 s, freshness 9 s, `dbt build` 48 s
(80 pass, 2 warn, 0 fail). The month's `loaded_at` moved from 10:45 to 12:12 UTC, so it was really rewritten; it
still holds 10,800 rows per table with 0 duplicates, and the raw tables still hold 557,280 rows each. December 2024
to February 2025 were then backfilled the same way, all successful.

**What went wrong first, and the fixes.**
- Airflow 3 reads a plain `@monthly` schedule as a trigger with a zero-length data interval. The first runs asked
  the loader for 1 Nov to 31 Oct; the loader's own check rejected the range, so nothing was written. The DAG now
  uses `CronDataIntervalTimetable`, which gives each run its whole month. Runs created before the fix keep their
  old interval even when re-run, so they were deleted from Airflow's database and created again.
- A paused DAG's backfill runs stay queued. The DAG has to be unpaused, which also schedules the latest complete
  month (September 2026, a harmless reload); it was paused again afterwards.
- The first backfill and that scheduled run ran at the same time, including two `dbt build`s against the same
  tables. Both passed, but that was luck. The dbt tasks now go through a one-slot pool. In two later tests Airflow
  started the second run only after the first had finished, so the pool has not yet been exercised by a real
  overlap; it is a safeguard.
- A manual trigger ignores `--logical-date` for the data interval: a trigger dated 2025-03-01 loaded September
  2026, the latest complete month. Specific months go through `airflow backfill create`.

## Dashboard (M8)

**[neilss170.github.io/india-air-quality](https://neilss170.github.io/india-air-quality/)**: a single static page in
vanilla JavaScript with hand-written SVG charts, glass cards over drifting gradient blobs, light and dark themes,
count-up numbers and growing bars and lines (turned off for reduced-motion users, or with `?motion=off`). Every chart
has a hover tooltip and a table view. The daily workflow runs
[`scripts/export_dashboard.py`](scripts/export_dashboard.py) after `dbt build`, which writes one JSON file from the
marts (city averages included, so the page does no statistics of its own) and deploys it with the page. A freshness
pill shows how old the newest hour is (green within 48 h).

What the data shows (15 cities, 5 Aug 2022 - 26 Oct 2026, modelled values):

- **Rain.** Mean daily PM2.5 is 53.0 µg/m³ on dry days and 18.7 on days with 30 mm+ of
  rain. Rain falls mostly in the monsoon, when PM is low anyway; within the monsoon alone it is still
  36.1 vs 18.4.
- **Diwali does not show a clear spike in this data.** Averaged over the 15 cities, Diwali-day PM2.5 was above the
  week before in 2 of 4 years, and in Delhi in 1 of 4 (2023: 90 the week before,
  36 on Diwali). A likely reason is that a global model driven by emission inventories does not capture
  a one-night fireworks spike; ground stations would be the right source for this question.
- **Daily cycle.** PM2.5 peaks between 19:00 and 23:00 IST in 12 of 15 cities; the exceptions are Pune
  (07:00), Jaipur (08:00) and Mumbai (14:00). Ozone peaks around 13:00.
- **Seasons and cities.** The northern plains (Delhi, Kanpur, Lucknow, Patna) and Kolkata are worst on the PM index.
  Kanpur, Lucknow, Patna and Kolkata have their three worst months in November-January; Delhi's are January, May
  and November. On the PM index Bengaluru, Chennai and Kochi are Good or Satisfactory on over 99% of days; Mumbai
  on 78.7%.

## Data

Air quality: [Open-Meteo Air Quality API](https://open-meteo.com/en/docs/air-quality-api) (CAMS global model, hourly,
from 4 August 2022). Weather: [Open-Meteo Historical Weather API](https://open-meteo.com/en/docs/historical-weather-api)
(ERA5 reanalysis). These are modelled values on a grid, not ground-station readings: the API answers from the nearest
grid cell (Delhi's request at 28.6139, 77.2090 comes back as 28.6, 77.2), and both coordinates are stored.
