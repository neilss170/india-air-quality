{#- CPCB category for an integer AQI. -#}
{% macro aqi_category(aqi) -%}
    case
        when {{ aqi }} <= 50 then 'Good'
        when {{ aqi }} <= 100 then 'Satisfactory'
        when {{ aqi }} <= 200 then 'Moderate'
        when {{ aqi }} <= 300 then 'Poor'
        when {{ aqi }} <= 400 then 'Very Poor'
        else 'Severe'
    end
{%- endmacro %}
