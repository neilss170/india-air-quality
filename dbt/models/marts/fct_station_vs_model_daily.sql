-- One row per city, IST day and pollutant (PM2.5, PM10) where ground stations have a complete day: the mean of the
-- 3 nearest stations with a complete day, next to the model's 24-hour mean for the same city and day, labelled with
-- the CAMS model cycle that produced it.
{{ config(cluster_by=['city']) }}

with station_days as (
    -- a station can report one pollutant through two sensors at once; average them first
    select city, location_id, parameter, date_ist,
           any_value(distance_km)  as distance_km,
           avg(concentration_ugm3) as concentration_ugm3
    from {{ ref('stg_station_pm_daily') }}
    where is_complete
    group by city, location_id, parameter, date_ist
),

nearest as (
    select *,
           row_number() over (partition by city, parameter, date_ist order by distance_km, location_id) as nearness
    from station_days
),

stations as (
    select city, parameter, date_ist,
           avg(concentration_ugm3) as station_ugm3,
           count(*)                as stations,
           max(distance_km)        as farthest_km
    from nearest
    where nearness <= 3
    group by city, parameter, date_ist
),

model as (
    select city, date_ist, 'pm25' as parameter, pm25_24h_ugm3 as model_ugm3 from {{ ref('fct_city_daily') }}
    union all
    select city, date_ist, 'pm10' as parameter, pm10_24h_ugm3 as model_ugm3 from {{ ref('fct_city_daily') }}
),

cycles as (
    select cycle, start_date,
           lead(start_date) over (order by start_date) as next_start
    from {{ ref('cams_model_cycles') }}
)

select
    s.city,
    s.date_ist,
    s.parameter,
    m.model_ugm3,
    s.station_ugm3,
    m.model_ugm3 - s.station_ugm3                 as model_minus_station_ugm3,
    s.stations,
    s.farthest_km,
    coalesce(c.cycle, 'before 48R1')              as model_cycle
from stations as s
inner join model as m using (city, date_ist, parameter)
left join cycles as c
    on s.date_ist >= c.start_date and (c.next_start is null or s.date_ist < c.next_start)
