{#- Every group (city) has exactly `expected` rows on every day strictly between the first and last day in the
    model, and no interior day is missing. The edge days are partial by construction: the data starts at 05:30 IST
    and ends at the last UTC hour loaded. Fails with one row per bad (group, day). -#}
{% test complete_hours_per_day(model, group_column, date_column, expected=24) %}
with bounds as (
    select min({{ date_column }}) as first_day, max({{ date_column }}) as last_day from {{ model }}
),

expected_days as (
    select g.{{ group_column }}, d as day
    from (select distinct {{ group_column }} from {{ model }}) as g
    cross join bounds
    cross join unnest(generate_date_array(date_add(first_day, interval 1 day), date_sub(last_day, interval 1 day))) as d
),

actual as (
    select {{ group_column }}, {{ date_column }} as day, count(*) as n
    from {{ model }}
    group by 1, 2
)

select e.{{ group_column }}, e.day, coalesce(a.n, 0) as n
from expected_days as e
left join actual as a using ({{ group_column }}, day)
where coalesce(a.n, 0) != {{ expected }}
{% endtest %}
