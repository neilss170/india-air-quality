-- fct_city_daily must have a row for every city on every day of dim_date except the two partial edge days.
-- A missing row means an incomplete day was dropped by the 24-hour filter.
with days as (
    select date_day
    from {{ ref('dim_date') }}
    where date_day > (select min(date_day) from {{ ref('dim_date') }})
      and date_day < (select max(date_day) from {{ ref('dim_date') }})
)

select c.city, d.date_day
from {{ ref('dim_city') }} as c
cross join days as d
left join {{ ref('fct_city_daily') }} as f
    on f.city = c.city and f.date_ist = d.date_day
where f.city is null
