import datetime as dt

from loader import stations

SENSOR = {"location_id": 17, "location_name": "R K Puram", "provider": "CPCB", "distance_km": 7.1,
          "sensor_id": 12234786, "parameter": "pm10", "units": "µg/m³"}


def day(local, value, count=24, first="2025-05-14T18:30:00Z", last="2025-05-15T18:15:00Z"):
    return {"period": {"datetimeFrom": {"local": local, "utc": "ignored"}}, "value": value,
            "summary": {"min": None if value is None else value - 1, "max": None if value is None else value + 1},
            "coverage": {"observedCount": count, "datetimeFrom": {"utc": first}, "datetimeTo": {"utc": last}}}


def test_to_frame_one_row_per_local_day():
    df = stations.to_frame([day("2025-05-15T00:00:00+05:30", 337.6), day("2025-05-16T00:00:00+05:30", None)], SENSOR, "Delhi")
    assert len(df) == 2 and (df["city"] == "Delhi").all() and (df["sensor_id"] == 12234786).all()
    assert df["date_local"].tolist() == [dt.date(2025, 5, 15), dt.date(2025, 5, 16)]  # the IST day, not the UTC one
    assert df["value"].iloc[0] == 337.6 and df["value"].isna().iloc[1]
    assert str(df["first_obs_utc"].dt.tz) == "UTC"
    assert list(df.columns) == [f.name for f in stations.SCHEMA if f.name not in ("month", "loaded_at")]


def test_to_frame_empty_keeps_the_columns():
    df = stations.to_frame([], SENSOR, "Delhi")
    assert df.empty and "date_local" in df.columns and df["value"].dtype == "float64"


def test_overlaps_uses_each_sensors_own_dates():
    old = {"datetimeFirst": {"local": "2016-02-05T20:25:00+05:30"}, "datetimeLast": {"local": "2018-02-22T02:45:00+05:30"}}
    new = {"datetimeFirst": {"local": "2025-02-19T02:00:00+05:30"}, "datetimeLast": {"local": "2026-10-28T14:00:00+05:30"}}
    window = (dt.date(2022, 8, 1), dt.date(2024, 12, 31))
    assert not stations.overlaps(old, *window) and not stations.overlaps(new, *window)
    assert stations.overlaps(new, dt.date(2025, 1, 1), dt.date(2025, 3, 1))
    assert not stations.overlaps({}, *window)


def test_km():
    assert abs(stations.km(28.6139, 77.2090, 28.6139, 77.2090)) < 1e-9
    assert 1100 < stations.km(28.6139, 77.2090, 19.0760, 72.8777) < 1200  # Delhi to Mumbai
