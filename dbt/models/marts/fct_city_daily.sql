-- One row per city per complete IST day (24 hours) with the CPCB National AQI.
-- Concentrations per CPCB: 24-hour means for PM2.5, PM10, NO2, SO2; the day's highest 8-hour mean for
-- O3 and CO (CO converted to mg/m³). Sub-index = linear interpolation within the pollutant's band;
-- AQI = the highest sub-index (CPCB needs 3+ pollutants incl. PM2.5 or PM10: all 6 are always present).
-- aqi_pm uses only PM2.5 and PM10: the modelled (CAMS) ozone sets the full AQI on most days, so the
-- particulate-only index is kept alongside it for comparison.
{{ config(cluster_by=['city']) }}

with daily as (
    select
        city,
        date_ist,
        count(*)                        as hours,
        avg(pm25_ugm3)                  as pm25_24h_ugm3,
        avg(pm10_ugm3)                  as pm10_24h_ugm3,
        avg(no2_ugm3)                   as no2_24h_ugm3,
        avg(so2_ugm3)                   as so2_24h_ugm3,
        max(o3_8h_ugm3)                 as o3_8h_max_ugm3,
        max(co_8h_ugm3) / 1000          as co_8h_max_mgm3,
        avg(temperature_c)              as temperature_mean_c,
        min(temperature_c)              as temperature_min_c,
        max(temperature_c)              as temperature_max_c,
        avg(relative_humidity_pct)      as relative_humidity_mean_pct,
        sum(precipitation_mm)           as precipitation_mm,
        avg(wind_speed_kmh)             as wind_speed_mean_kmh
    from {{ ref('fct_air_quality_hourly') }}
    group by city, date_ist
    having count(*) = 24
),

concentrations as (
    select city, date_ist, pollutant, concentration
    from daily
    unpivot (concentration for pollutant in (
        pm25_24h_ugm3 as 'pm25', pm10_24h_ugm3 as 'pm10', no2_24h_ugm3 as 'no2',
        o3_8h_max_ugm3 as 'o3', co_8h_max_mgm3 as 'co', so2_24h_ugm3 as 'so2'))
),

sub_indices as (
    select
        c.city,
        c.date_ist,
        c.pollutant,
        -- rounded to 6 places: AVG's summation order varies between runs, and without this a sub-index of
        -- exactly x.5 (common, as the inputs have one decimal) rounds up on some runs and down on others
        round(least(500, b.band_aqi_lo + (b.band_aqi_hi - b.band_aqi_lo)
            * (c.concentration - b.band_conc_lo) / (b.band_conc_hi - b.band_conc_lo)), 6) as sub_index
    from concentrations as c
    inner join {{ ref('int_aqi_bands') }} as b
        on b.pollutant = c.pollutant
        and c.concentration >= b.band_conc_lo
        and (c.concentration < b.band_conc_hi or b.is_top_band)
),

aqi as (
    select
        city,
        date_ist,
        count(*)                                            as pollutants_indexed,
        max(if(pollutant = 'pm25', sub_index, null))        as pm25_sub_index,
        max(if(pollutant = 'pm10', sub_index, null))        as pm10_sub_index,
        max(if(pollutant = 'no2', sub_index, null))         as no2_sub_index,
        max(if(pollutant = 'o3', sub_index, null))          as o3_sub_index,
        max(if(pollutant = 'co', sub_index, null))          as co_sub_index,
        max(if(pollutant = 'so2', sub_index, null))         as so2_sub_index,
        cast(round(max(sub_index)) as int64)                as aqi,
        array_agg(pollutant order by sub_index desc, pollutant limit 1)[offset(0)] as dominant_pollutant,
        cast(round(max(if(pollutant in ('pm25', 'pm10'), sub_index, null))) as int64) as aqi_pm
    from sub_indices
    group by city, date_ist
)

select
    d.city,
    d.date_ist,
    a.aqi,
    {{ aqi_category('a.aqi') }}     as aqi_category,
    a.dominant_pollutant,
    a.aqi_pm,
    {{ aqi_category('a.aqi_pm') }}  as aqi_pm_category,
    a.pollutants_indexed,
    a.pm25_sub_index,
    a.pm10_sub_index,
    a.no2_sub_index,
    a.o3_sub_index,
    a.co_sub_index,
    a.so2_sub_index,
    d.* except (city, date_ist)
from daily as d
inner join aqi as a using (city, date_ist)
