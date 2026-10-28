-- Daily PM means per ground-station sensor. OpenAQ's coverage percentage can exceed 100% (repeated measurements),
-- so completeness is judged here: at least 18 measurements spread over at least 18 hours of the day.
with source as (
    select * from {{ source('raw', 'station_pm_daily') }}
)

select
    city,
    location_id,
    location_name,
    provider,
    distance_km,
    sensor_id,
    parameter,
    date_local                                                    as date_ist,
    value                                                         as concentration_ugm3,
    observed_count,
    timestamp_diff(last_obs_utc, first_obs_utc, minute) / 60      as span_hours,
    coalesce(
        units = 'µg/m³'
        and value between 0 and 2000
        and observed_count >= 18
        and timestamp_diff(last_obs_utc, first_obs_utc, minute) >= 18 * 60,
        false)                                                    as is_complete,
    loaded_at
from source
