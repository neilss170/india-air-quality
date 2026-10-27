-- CPCB publishes integer breakpoints with gaps (PM2.5 Good is 0-30, Satisfactory 31-60), but model
-- concentrations are continuous: 30.4 would fall in neither band. Each band here starts where the previous
-- one ends, [previous conc_hi, conc_hi), and its AQI starts at the previous aqi_hi, so the sub-index is a
-- continuous piecewise-linear function that agrees with CPCB at every band's upper breakpoint.
select
    pollutant,
    category,
    averaging,
    unit,
    coalesce(lag(conc_hi) over w, 0)      as band_conc_lo,
    conc_hi                               as band_conc_hi,
    coalesce(lag(aqi_hi) over w, 0)       as band_aqi_lo,
    aqi_hi                                as band_aqi_hi,
    lead(conc_hi) over w is null          as is_top_band
from {{ ref('cpcb_aqi_breakpoints') }}
window w as (partition by pollutant order by aqi_lo)
