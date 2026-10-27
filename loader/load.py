"""BigQuery writes without DML: each month is a partition, and a load replaces whole partitions.

The free BigQuery sandbox rejects DELETE/UPDATE/MERGE, so idempotency comes from the table layout instead:
raw tables are integer-range partitioned on `month` (YYYYMM) and every load job targets `table$YYYYMM`
with WRITE_TRUNCATE. Re-running any range rewrites exactly those months; nothing can be counted twice.
Integer-range partitions (not time partitions) also sidestep the sandbox's 60-day partition expiry.
"""

from __future__ import annotations

import datetime as dt

import pandas as pd
from google.cloud import bigquery

from loader.fetch import Source

FIRST_MONTH, LAST_MONTH = 202201, 203001
SANDBOX_TABLE_DAYS = 59  # the sandbox caps table lifetime at 60 days; each run pushes the expiry forward


def month_key(ts: pd.Series) -> pd.Series:
    return (ts.dt.year * 100 + ts.dt.month).astype("int64")


def schema(source: Source) -> list[bigquery.SchemaField]:
    return [
        bigquery.SchemaField("city", "STRING", mode="REQUIRED"),
        bigquery.SchemaField("ts", "TIMESTAMP", mode="REQUIRED", description="start of the hour, UTC"),
        *[bigquery.SchemaField(v, "FLOAT64") for v in source.variables],
        bigquery.SchemaField("grid_latitude", "FLOAT64", description="model grid cell the API answered from"),
        bigquery.SchemaField("grid_longitude", "FLOAT64"),
        bigquery.SchemaField("month", "INT64", mode="REQUIRED", description="YYYYMM of ts: the partition key"),
        bigquery.SchemaField("loaded_at", "TIMESTAMP", mode="REQUIRED"),
    ]


def ensure_table(client: bigquery.Client, dataset: str, source: Source) -> bigquery.Table:
    table = bigquery.Table(f"{client.project}.{dataset}.{source.table}", schema=schema(source))
    table.range_partitioning = bigquery.RangePartitioning(
        field="month", range_=bigquery.PartitionRange(start=FIRST_MONTH, end=LAST_MONTH, interval=1))
    table.clustering_fields = ["city"]
    return client.create_table(table, exists_ok=True)


def replace_months(client: bigquery.Client, table: bigquery.Table, df: pd.DataFrame) -> dict[int, int]:
    """Write each month in df over its partition. Returns rows written per month."""
    df = df.assign(month=month_key(df["ts"]), loaded_at=pd.Timestamp.now(tz="UTC"))
    config = bigquery.LoadJobConfig(schema=table.schema, write_disposition="WRITE_TRUNCATE")
    written = {}
    for month, part in df.groupby("month"):
        client.load_table_from_dataframe(part, f"{table.full_table_id.replace(':', '.')}${month}",
                                         job_config=config).result()
        written[int(month)] = len(part)
    return written


def extend_expiry(client: bigquery.Client, table: bigquery.Table) -> dt.datetime | None:
    """Push a sandbox table's expiry forward. Tables without an expiry (billing enabled) are left alone."""
    table = client.get_table(table)
    if table.expires is None:
        return None
    table.expires = dt.datetime.now(dt.timezone.utc) + dt.timedelta(days=SANDBOX_TABLE_DAYS)
    return client.update_table(table, ["expires"]).expires
