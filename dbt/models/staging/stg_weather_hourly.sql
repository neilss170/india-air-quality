-- Same hour range as air quality, so the two join one-to-one.
with source as (
    select * from {{ source('raw', 'weather_hourly') }}
    where ts >= timestamp('{{ var("first_aq_hour_utc") }}')
)

select
    city,
    ts                                       as measured_at_utc,
    datetime(ts, 'Asia/Kolkata')             as measured_at_ist,
    date(ts, 'Asia/Kolkata')                 as date_ist,
    extract(hour from datetime(ts, 'Asia/Kolkata')) as hour_ist,
    cast(temperature_2m as float64)          as temperature_c,
    cast(relative_humidity_2m as float64)    as relative_humidity_pct,
    cast(precipitation as float64)           as precipitation_mm,
    cast(wind_speed_10m as float64)          as wind_speed_kmh,
    cast(wind_direction_10m as float64)      as wind_direction_deg,
    grid_latitude,
    grid_longitude,
    loaded_at
from source
