-- One row per IST calendar day covered by the data, with seasons (IMD) and festival labels.
with bounds as (
    select min(date_ist) as lo, max(date_ist) as hi from {{ ref('stg_air_quality_hourly') }}
),

days as (
    select date_day
    from bounds, unnest(generate_date_array(lo, hi)) as date_day
),

festivals as (
    select
        date,
        string_agg(name, ', ' order by name)   as festival_names,
        logical_or(kind = 'festival')          as is_festival,
        logical_or(kind = 'national')          as is_national_holiday
    from {{ ref('indian_festivals') }}
    group by date
),

diwali as (
    select extract(year from date) as year, date as diwali_date
    from {{ ref('indian_festivals') }}
    where name = 'Diwali'
)

select
    d.date_day,
    extract(year from d.date_day)                       as year,
    extract(month from d.date_day)                      as month,
    format_date('%b', d.date_day)                       as month_name,
    format_date('%A', d.date_day)                       as day_name,
    extract(dayofweek from d.date_day) in (1, 7)        as is_weekend,
    -- India Meteorological Department seasons
    case
        when extract(month from d.date_day) in (1, 2) then 'Winter'
        when extract(month from d.date_day) in (3, 4, 5) then 'Pre-monsoon'
        when extract(month from d.date_day) in (6, 7, 8, 9) then 'Monsoon'
        else 'Post-monsoon'
    end                                                 as season,
    f.festival_names,
    coalesce(f.is_festival, false)                      as is_festival,
    coalesce(f.is_national_holiday, false)              as is_national_holiday,
    dw.diwali_date,
    date_diff(d.date_day, dw.diwali_date, day)          as days_from_diwali
from days as d
left join festivals as f on f.date = d.date_day
left join diwali as dw on dw.year = extract(year from d.date_day)
