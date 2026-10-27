"""Open-Meteo clients: one city and date range in, one row per UTC hour out.

The APIs return modelled values on a grid (CAMS for air quality, ERA5 reanalysis for weather), so the
coordinates that come back are the grid cell's, not the city centre's; both are kept.
"""

from __future__ import annotations

import time
from dataclasses import dataclass

import pandas as pd
import requests


@dataclass(frozen=True)
class Source:
    table: str
    url: str
    variables: tuple[str, ...]


AIR_QUALITY = Source(
    table="air_quality_hourly",
    url="https://air-quality-api.open-meteo.com/v1/air-quality",
    variables=("pm2_5", "pm10", "nitrogen_dioxide", "ozone", "carbon_monoxide", "sulphur_dioxide"),
)
WEATHER = Source(
    table="weather_hourly",
    url="https://archive-api.open-meteo.com/v1/archive",
    variables=("temperature_2m", "relative_humidity_2m", "precipitation", "wind_speed_10m", "wind_direction_10m"),
)
SOURCES = (AIR_QUALITY, WEATHER)

RETRIES = 3
PAUSE_S = 0.5  # between calls: the free API allows 600 a minute, so this keeps well clear


def to_frame(payload: dict, city: str, source: Source) -> pd.DataFrame:
    """API JSON (parallel lists under "hourly") -> one row per hour. No network, so it is unit-tested."""
    hourly = payload["hourly"]
    df = pd.DataFrame({"ts": pd.to_datetime(hourly["time"], utc=True)})
    for var in source.variables:
        df[var] = pd.to_numeric(pd.Series(hourly[var], dtype="object"), errors="coerce").astype("float64")
    df.insert(0, "city", city)
    df["grid_latitude"] = float(payload["latitude"])
    df["grid_longitude"] = float(payload["longitude"])
    return df


def fetch(source: Source, city: str, lat: float, lon: float, start: str, end: str,
          session: requests.Session | None = None) -> pd.DataFrame:
    """Hourly rows for [start, end] (inclusive dates, UTC), retrying transient failures with backoff."""
    params = {"latitude": lat, "longitude": lon, "hourly": ",".join(source.variables),
              "start_date": start, "end_date": end, "timezone": "GMT"}
    http = session or requests
    for attempt in range(1, RETRIES + 1):
        try:
            resp = http.get(source.url, params=params, timeout=60)
            if resp.status_code == 429 or resp.status_code >= 500:
                raise requests.HTTPError(f"{resp.status_code}: {resp.text[:200]}", response=resp)
            resp.raise_for_status()
            time.sleep(PAUSE_S)
            return to_frame(resp.json(), city, source)
        except (requests.ConnectionError, requests.Timeout, requests.HTTPError) as err:
            client_error = isinstance(err, requests.HTTPError) and err.response is not None \
                and 400 <= err.response.status_code < 500 and err.response.status_code != 429
            if client_error or attempt == RETRIES:
                raise
            time.sleep(5 * attempt)
    raise AssertionError("unreachable")
