-- Source freshness checks when the loader last ran; this checks the newest hour of data itself. The daily run
-- loads up to the end of yesterday (UTC), so the newest hour should be under 2 days old; warn after 3.
{{ config(severity='warn') }}

select city, max(measured_at_utc) as newest_hour
from {{ ref('fct_air_quality_hourly') }}
group by city
having max(measured_at_utc) < timestamp_sub(current_timestamp(), interval 72 hour)
