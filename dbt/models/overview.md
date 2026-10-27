{% docs __overview__ %}
# India Air Quality Warehouse

Hourly air quality (CAMS global model) and weather (ERA5) for 15 Indian cities from August 2022, loaded daily from
the Open-Meteo APIs into BigQuery and modelled with dbt.
Source code: [github.com/neilss170/india-air-quality](https://github.com/neilss170/india-air-quality).

**Layers**

- `raw`: written by the Python loader; integer-range partitioned by month, each load replaces whole months.
- `staging`: views. Renamed columns with units, IST time, hours from 2022-08-04 (start of the CAMS history),
  negative model concentrations floored at 0.
- `reference`: seeds. Cities, CPCB AQI breakpoints, festival dates.
- `marts`: tables. `dim_city`, `dim_date`, `fct_air_quality_hourly`, `fct_city_daily` (CPCB National AQI).

**Read before using the numbers.** These are modelled grid values, not ground-station readings, and the AQI is the
CPCB formula applied to them, not the official CPCB figure. Modelled ozone sets the AQI on most days;
`fct_city_daily.aqi_pm` gives the particulate-only index alongside it.

Everything is a view or a full-rebuild table: the BigQuery sandbox has no DML, so there are no incremental models.
{% enddocs %}
