"""The pipeline as an Airflow DAG, one run per calendar month: load -> check -> freshness -> dbt build.

GitHub Actions is the always-on daily scheduler (.github/workflows/daily.yml). This DAG is for orchestration
and backfills: each run's data interval is one month, and the loader replaces exactly that month's partition,
so re-running or backfilling a month is safe. Loads for different months may run in parallel; the dbt steps
go through a one-slot pool because each is a full rebuild.

    airflow backfill create --dag-id india_air_quality_monthly --from-date 2024-11-01 --to-date 2024-11-01

Tasks call the pipeline's own Python and dbt (/usr/local/bin), not Airflow's virtualenv.
"""

import pendulum
from airflow.providers.standard.operators.bash import BashOperator
from airflow.sdk import DAG
from airflow.timetables.interval import CronDataIntervalTimetable

PYTHON = "/usr/local/bin/python"
DBT = "/usr/local/bin/dbt"
FIRST_DAY = "{{ data_interval_start | ds }}"
LAST_DAY = "{{ macros.ds_add(data_interval_end | ds, -1) }}"
MONTH = "{{ data_interval_start.strftime('%Y%m') }}"

with DAG(
    dag_id="india_air_quality_monthly",
    description="Load one month of air quality and weather, check it, rebuild and test the dbt models",
    # Airflow 3 reads a plain "@monthly" as a trigger with a zero-length data interval (start == end), which
    # made the first runs ask the loader for 1 Nov -> 31 Oct. This timetable gives each run its whole month.
    schedule=CronDataIntervalTimetable("@monthly", timezone="UTC"),
    start_date=pendulum.datetime(2022, 8, 1, tz="UTC"),
    catchup=False,
    max_active_runs=1,
    default_args={"retries": 1, "retry_delay": pendulum.duration(minutes=2), "cwd": "/app"},
    tags=["india-air-quality"],
) as dag:
    load = BashOperator(
        task_id="load_month",
        bash_command=f"{PYTHON} -m loader.main --start {FIRST_DAY} --end {LAST_DAY}",
    )
    check = BashOperator(
        task_id="check_month",
        bash_command=f"{PYTHON} scripts/check_month.py --month {MONTH}",
    )
    # one-slot pool (created at container start): runs can overlap, dbt commands cannot
    freshness = BashOperator(task_id="source_freshness", bash_command=f"{DBT} source freshness", pool="dbt")
    build = BashOperator(task_id="dbt_build", bash_command=f"{DBT} build", pool="dbt")

    load >> check >> freshness >> build
