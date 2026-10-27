-- One row per city per hour from the first real CAMS reading on. Pollutants stay in µg/m³ as delivered;
-- CPCB's mg/m³ for CO is applied in the AQI model, not here. The model occasionally returns small negative
-- concentrations (54 hourly values in the backfill, down to -7 µg/m³ of ozone); a concentration cannot be
-- negative, so they are floored at 0 here. The raw source keeps them, and a warn-level test counts them.
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
    greatest(cast(pm2_5 as float64), 0) as pm25_ugm3,
    greatest(cast(pm10 as float64), 0) as pm10_ugm3,
    greatest(cast(nitrogen_dioxide as float64), 0) as no2_ugm3,
    greatest(cast(ozone as float64), 0) as o3_ugm3,
    greatest(cast(carbon_monoxide as float64), 0) as co_ugm3,
    greatest(cast(sulphur_dioxide as float64), 0) as so2_ugm3,
    grid_latitude,
    grid_longitude,
    loaded_at
from source
