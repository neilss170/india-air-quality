# Airflow on top of the pipeline image: the loader, dbt and their pinned packages are reused as they are, and
# Airflow goes into its own virtualenv so its constraint pins never touch dbt's. Build the app image first:
#   docker compose build app && docker compose --profile airflow build airflow
FROM india-air-quality:latest

ARG AIRFLOW_VERSION=3.3.2
RUN python -m venv /opt/airflow-venv \
 && /opt/airflow-venv/bin/pip install --no-cache-dir "apache-airflow==${AIRFLOW_VERSION}" \
      --constraint "https://raw.githubusercontent.com/apache/airflow/constraints-${AIRFLOW_VERSION}/constraints-3.12.txt" \
 && ln -s /opt/airflow-venv/bin/airflow /usr/local/bin/airflow
# only the airflow command goes on PATH: putting the venv's bin first would also replace `python`

ENV AIRFLOW_HOME=/opt/airflow-home \
    AIRFLOW__CORE__DAGS_FOLDER=/app/orchestration/dags \
    AIRFLOW__CORE__LOAD_EXAMPLES=False
EXPOSE 8080
# dbt tasks share dbt/target and rebuild the same tables, so they run through a one-slot pool even when a backfill
# and a scheduled run (or a backfill with --max-active-runs > 1) are active at the same time
CMD ["sh", "-c", "airflow db migrate && airflow pools set dbt 1 'one dbt command at a time' && exec airflow standalone"]
