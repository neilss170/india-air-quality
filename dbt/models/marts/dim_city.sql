-- One row per city: attributes from the seed plus the model grid cells the APIs answered from.
with aq_grid as (
    select
        city,
        any_value(grid_latitude)  as aq_grid_latitude,
        any_value(grid_longitude) as aq_grid_longitude
    from {{ ref('stg_air_quality_hourly') }}
    group by city
),

weather_grid as (
    select
        city,
        any_value(grid_latitude)  as weather_grid_latitude,
        any_value(grid_longitude) as weather_grid_longitude
    from {{ ref('stg_weather_hourly') }}
    group by city
)

select
    c.city,
    c.state,
    c.region,
    c.coastal                as is_coastal,
    c.latitude,
    c.longitude,
    a.aq_grid_latitude,
    a.aq_grid_longitude,
    w.weather_grid_latitude,
    w.weather_grid_longitude
from {{ ref('cities') }} as c
left join aq_grid as a using (city)
left join weather_grid as w using (city)
