-- One row per city per hour from the first real CAMS reading on. Pollutants stay in µg/m³ as delivered;
-- CPCB's mg/m³ for CO is applied in the AQI model, not here.
with source as (
    select * from {{ source('raw', 'air_quality_hourly') }}
    where ts >= timestamp('{{ var("first_aq_hour_utc") }}')
)

select
    city,
    ts                                       as measured_at_utc,
    datetime(ts, 'Asia/Kolkata')             as measured_at_ist,
    date(ts, 'Asia/Kolkata')                 as date_ist,
    extract(hour from datetime(ts, 'Asia/Kolkata')) as hour_ist,
    cast(pm2_5 as float64)                   as pm25_ugm3,
    cast(pm10 as float64)                    as pm10_ugm3,
    cast(nitrogen_dioxide as float64)        as no2_ugm3,
    cast(ozone as float64)                   as o3_ugm3,
    cast(carbon_monoxide as float64)         as co_ugm3,
    cast(sulphur_dioxide as float64)         as so2_ugm3,
    grid_latitude,
    grid_longitude,
    loaded_at
from source
