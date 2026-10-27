{#- Use the custom schema as the dataset name (`staging`, `marts`) instead of dbt's default
    `<target_dataset>_<custom>`, so the warehouse reads raw -> staging -> marts. -#}
{% macro generate_schema_name(custom_schema_name, node) -%}
    {{ custom_schema_name | trim if custom_schema_name else target.schema }}
{%- endmacro %}
