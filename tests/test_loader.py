import argparse
import datetime as dt

import pandas as pd

from loader import fetch, load, main


def payload(times, **values):
    return {"latitude": 28.6, "longitude": 77.2, "hourly": {"time": times, **values}}


def test_to_frame_one_row_per_hour_in_utc():
    times = ["2024-11-01T00:00", "2024-11-01T01:00"]
    values = {v: [1.0, None] for v in fetch.AIR_QUALITY.variables}
    df = fetch.to_frame(payload(times, **values), "Delhi", fetch.AIR_QUALITY)

    assert list(df.columns[:2]) == ["city", "ts"]
    assert len(df) == 2 and (df["city"] == "Delhi").all()
    assert str(df["ts"].dt.tz) == "UTC"
    assert df["ts"].iloc[1] == pd.Timestamp("2024-11-01 01:00", tz="UTC")
    assert df["pm2_5"].isna().iloc[1]  # gaps stay null, never become 0
    assert df["grid_latitude"].iloc[0] == 28.6


def test_to_frame_all_null_column_is_still_float():
    times = ["2024-11-01T00:00"]
    values = {v: [None] for v in fetch.WEATHER.variables}
    df = fetch.to_frame(payload(times, **values), "Pune", fetch.WEATHER)
    assert df["precipitation"].dtype == "float64"


def test_month_key():
    ts = pd.Series(pd.to_datetime(["2022-08-31T23:00", "2024-12-01T00:00"], utc=True))
    assert load.month_key(ts).tolist() == [202208, 202412]


def test_chunks_cover_the_range_without_gaps_or_overlap():
    parts = main.chunks(dt.date(2022, 8, 1), dt.date(2024, 3, 5), days=366)
    assert parts[0][0] == dt.date(2022, 8, 1) and parts[-1][1] == dt.date(2024, 3, 5)
    for (_, prev_end), (next_start, _) in zip(parts, parts[1:]):
        assert next_start == prev_end + dt.timedelta(days=1)


def test_date_range_rounds_start_to_the_month_and_ends_yesterday():
    args = argparse.Namespace(start=None, end=None, days=10)
    assert main.date_range(args, dt.date(2026, 10, 27)) == (dt.date(2026, 10, 1), dt.date(2026, 10, 26))
    # a window that crosses a month boundary reloads both months
    assert main.date_range(args, dt.date(2026, 11, 3))[0] == dt.date(2026, 10, 1)
