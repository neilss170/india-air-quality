"""M1 check: can we reach BigQuery with the service-account key, and is the `raw` dataset there?

Run: docker compose run --rm app python scripts/check_connection.py
"""

import os

from google.cloud import bigquery

project = os.environ["GCP_PROJECT"]
location = os.environ.get("BQ_LOCATION", "asia-south1")

client = bigquery.Client(project=project, location=location)
print(f"authenticated as: {client._credentials.service_account_email}")

row = next(iter(client.query("SELECT 1 AS ok, CURRENT_TIMESTAMP() AS now").result()))
print(f"query works: ok={row.ok}, server time {row.now:%Y-%m-%d %H:%M} UTC")

dataset = bigquery.Dataset(f"{project}.raw")
dataset.location = location
client.create_dataset(dataset, exists_ok=True)
print(f"dataset ready: {project}.raw ({location})")
