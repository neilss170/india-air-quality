-- One row per city per hour: pollutants joined to weather, plus the trailing 8-hour means that CPCB uses
-- for ozone and CO. The window is a time range (not a row count), so a missing hour cannot stretch it;
-- the mean is only reported when all 8 hours are present.
{{ config(cluster_by=['city']) }}

with joined as (
    select
        aq.city,
        aq.measured_at_utc,
        aq.measured_at_ist,
        aq.date_ist,
        aq.hour_ist,
        aq.pm25_ugm3,
        aq.pm10_ugm3,
        aq.no2_ugm3,
        aq.o3_ugm3,
        aq.co_ugm3,
        aq.so2_ugm3,
        w.temperature_c,
        w.relative_humidity_pct,
        w.precipitation_mm,
        w.wind_speed_kmh,
        w.wind_direction_deg
    from {{ ref('stg_air_quality_hourly') }} as aq
    inner join {{ ref('stg_weather_hourly') }} as w
        on w.city = aq.city and w.measured_at_utc = aq.measured_at_utc
)

select
    *,
    if(count(*) over w8 = 8, avg(o3_ugm3) over w8, null) as o3_8h_ugm3,
    if(count(*) over w8 = 8, avg(co_ugm3) over w8, null) as co_8h_ugm3
from joined
window w8 as (
    partition by city order by unix_seconds(measured_at_utc) range between 25200 preceding and current row
)
