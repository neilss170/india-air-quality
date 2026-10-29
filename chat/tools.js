// Lookups the chatbot can call. Each one reads the dashboard's own data file (docs/data/dashboard.json, built by
// scripts/export_dashboard.py), so every number the bot quotes is a number the dashboard already shows.

const ALL = "All cities";
const ALIASES = {
  "new delhi": "Delhi", bangalore: "Bengaluru", bombay: "Mumbai", cochin: "Kochi", calcutta: "Kolkata",
  madras: "Chennai", poona: "Pune", gauhati: "Guwahati", all: ALL, india: ALL, "all cities": ALL,
};
const RAIN_BUCKETS = ["no rain (<0.1 mm)", "light (0.1-2.5 mm)", "moderate (2.5-10 mm)", "heavy (10-30 mm)", "very heavy (30 mm+)"];
const MAX_DAYS_LISTED = 62;

const round = (v, d = 1) => (v == null ? null : Math.round(v * 10 ** d) / 10 ** d);
const addDays = (iso, n) => new Date(Date.parse(iso + "T00:00:00Z") + n * 864e5).toISOString().slice(0, 10);
const dayIndex = (start, iso) => Math.round((Date.parse(iso + "T00:00:00Z") - Date.parse(start + "T00:00:00Z")) / 864e5);
const validDate = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));

function cityName(D, raw, allowAll = false) {
  if (raw == null || raw === "") return allowAll ? ALL : null;
  const key = String(raw).trim().toLowerCase();
  const hit = ALIASES[key] ?? D.cities.map((c) => c.city).find((c) => c.toLowerCase() === key);
  if (!hit || (hit === ALL && !allowAll)) return null;
  return hit;
}
const unknownCity = (D, raw) => ({ error: `No data for "${raw}". Cities in the data: ${D.cities.map((c) => c.city).join(", ")}.` });
const roundRow = (r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === "number" ? round(v, 2) : v]));

export const TOOLS = {
  overview: {
    description: "Coverage of the data (dates, cities, newest hour), headline totals, and each city's long-run means " +
      "(PM index, full AQI, PM2.5, share of days Poor or worse). Use for rankings of cities overall.",
    parameters: { type: "object", properties: {} },
    run: (D) => ({
      data_built_at_utc: D.generated_at, freshness: D.freshness, totals: D.totals,
      cities_ranked_by_mean_pm_index: D.cities.map(roundRow),
    }),
  },

  latest_day: {
    description: "The newest complete day (IST) for every city, or one city: PM index and category, full AQI, " +
      "dominant pollutant, PM2.5, PM10, temperature, rain, wind, and the city's rank that day (1 = worst).",
    parameters: { type: "object", properties: { city: { type: "string", description: "Optional city name" } } },
    run: (D, { city }) => {
      if (!city) return { rows: D.latest_day.map(roundRow) };
      const c = cityName(D, city);
      if (!c) return unknownCity(D, city);
      return { rows: D.latest_day.filter((r) => r.city === c).map(roundRow) };
    },
  },

  daily_pm_index: {
    description: "One city's daily PM index between two dates (inclusive, YYYY-MM-DD), with the mean, highest and " +
      `lowest day. Daily values are listed for ranges up to ${MAX_DAYS_LISTED} days.`,
    parameters: { type: "object", required: ["city", "date_from", "date_to"], properties: {
      city: { type: "string" }, date_from: { type: "string" }, date_to: { type: "string" } } },
    run: (D, { city, date_from, date_to }) => {
      const c = cityName(D, city);
      if (!c) return unknownCity(D, city);
      if (!validDate(date_from) || !validDate(date_to)) return { error: "Dates must be YYYY-MM-DD." };
      const { start, cities } = D.daily_pm, series = cities[c], last = addDays(start, series.length - 1);
      const from = date_from < start ? start : date_from, to = date_to > last ? last : date_to;
      if (from > to) return { error: `Daily data runs from ${start} to ${last}.` };
      const days = [];
      for (let i = dayIndex(start, from); i <= dayIndex(start, to); i++) days.push({ date: addDays(start, i), pm_index: series[i] });
      const have = days.filter((d) => d.pm_index != null);
      const out = { city: c, date_from: from, date_to: to, days_with_data: have.length };
      if (have.length) {
        out.mean = round(have.reduce((a, d) => a + d.pm_index, 0) / have.length);
        out.highest = have.reduce((a, d) => (d.pm_index > a.pm_index ? d : a));
        out.lowest = have.reduce((a, d) => (d.pm_index < a.pm_index ? d : a));
      }
      if (days.length <= MAX_DAYS_LISTED) out.days = days;
      if (from !== date_from || to !== date_to) out.note = `Clipped to the data, which runs from ${start} to ${last}.`;
      return out;
    },
  },

  day_all_cities: {
    description: "Every city's PM index on one date (YYYY-MM-DD), ranked from worst to best.",
    parameters: { type: "object", required: ["date"], properties: { date: { type: "string" } } },
    run: (D, { date }) => {
      if (!validDate(date)) return { error: "Date must be YYYY-MM-DD." };
      const i = dayIndex(D.daily_pm.start, date);
      const rows = Object.entries(D.daily_pm.cities).map(([city, s]) => ({ city, pm_index: s[i] ?? null }))
        .filter((r) => r.pm_index != null).sort((a, b) => b.pm_index - a.pm_index);
      return rows.length ? { date, rows } : { error: `No data for ${date}.` };
    },
  },

  monthly: {
    description: "Monthly means for one city or 'All cities' (the 15-city mean): PM index, full AQI, PM2.5 µg/m³ " +
      "and days. Months are YYYY-MM; both bounds optional.",
    parameters: { type: "object", required: ["city"], properties: {
      city: { type: "string" }, month_from: { type: "string" }, month_to: { type: "string" } } },
    run: (D, { city, month_from, month_to }) => {
      const c = cityName(D, city, true);
      if (!c) return unknownCity(D, city);
      const rows = D.monthly.filter((r) => r.city === c && (!month_from || r.month >= month_from) && (!month_to || r.month <= month_to));
      return { city: c, rows: rows.slice(-60).map(roundRow), ...(rows.length > 60 ? { note: "Only the last 60 months are shown." } : {}) };
    },
  },

  worst_days: {
    description: "One city's 10 worst days by PM index since August 2022, with PM2.5, PM10 and the weather.",
    parameters: { type: "object", required: ["city"], properties: { city: { type: "string" } } },
    run: (D, { city }) => {
      const c = cityName(D, city);
      return c ? { city: c, rows: D.worst_days.filter((r) => r.city === c).map(roundRow) } : unknownCity(D, city);
    },
  },

  category_mix: {
    description: "How many days each city spent in each CPCB category (Good to Severe) on the PM index.",
    parameters: { type: "object", properties: { city: { type: "string", description: "Optional city name" } } },
    run: (D, { city }) => {
      const c = city ? cityName(D, city) : null;
      if (city && !c) return unknownCity(D, city);
      return { rows: D.categories.filter((r) => !c || r.city === c) };
    },
  },

  seasonal_pattern: {
    description: "Mean PM index by calendar month (1 = January) across all years, for one city or every city.",
    parameters: { type: "object", properties: { city: { type: "string", description: "Optional city name" } } },
    run: (D, { city }) => {
      const c = city ? cityName(D, city) : null;
      if (city && !c) return unknownCity(D, city);
      return { rows: D.season.filter((r) => !c || r.city === c).map(roundRow) };
    },
  },

  daily_cycle: {
    description: "Average PM2.5 and ozone (µg/m³) by hour of day (IST) for one city or 'All cities'.",
    parameters: { type: "object", required: ["city"], properties: { city: { type: "string" } } },
    run: (D, { city }) => {
      const c = cityName(D, city, true);
      return c ? { city: c, rows: D.hourly_profile.filter((r) => r.city === c).map(roundRow) } : unknownCity(D, city);
    },
  },

  diwali: {
    description: "PM2.5 (µg/m³) around each Diwali in the data: mean of the week before, Diwali day, and the two " +
      "days after, per year, for one city or 'All cities'. Give a year to also get each day from 10 before to 10 after.",
    parameters: { type: "object", required: ["city"], properties: { city: { type: "string" }, year: { type: "integer" } } },
    run: (D, { city, year }) => {
      const c = cityName(D, city, true);
      if (!c) return unknownCity(D, city);
      const out = { city: c, summary: D.diwali_summary.filter((r) => r.city === c && (!year || r.year === year)).map(roundRow) };
      if (year) out.days = D.diwali.filter((r) => r.city === c && r.year === year).map(roundRow);
      return out;
    },
  },

  rain_effect: {
    description: "Mean daily PM2.5 (µg/m³) by how much it rained that day, over all city-days and monsoon days only.",
    parameters: { type: "object", properties: {} },
    run: (D) => ({ rows: D.rain.map((r) => ({ ...roundRow(r), bucket: RAIN_BUCKETS[r.bucket] })) }),
  },

  model_vs_stations: {
    description: "How the modelled PM2.5/PM10 compares with the nearest ground stations (OpenAQ): mean of each, " +
      "bias (model/stations - 1), correlation r, RMSE and days compared, overall and per CAMS model version. " +
      "Give a city to also get its month-by-month comparison.",
    parameters: { type: "object", properties: {
      city: { type: "string", description: "Optional city name, or 'All cities'" },
      parameter: { type: "string", enum: ["pm25", "pm10"] } } },
    run: (D, { city, parameter }) => {
      const c = city ? cityName(D, city, true) : null;
      if (city && !c) return unknownCity(D, city);
      const keep = (r) => (!c || r.city === c) && (!parameter || r.parameter === parameter);
      const out = { model_versions: D.check.cycles, summary: D.check.summary.filter(keep).map(roundRow),
        by_model_version: D.check.by_cycle.filter(keep).map(roundRow) };
      if (c && c !== ALL) out.monthly = D.check.monthly.filter(keep).map(roundRow);
      return out;
    },
  },

  pipeline_status: {
    description: "How the data pipeline is doing: recent GitHub Actions runs, rows loaded in the last run, dbt " +
      "build results and warnings, source freshness and BigQuery table sizes.",
    parameters: { type: "object", properties: {} },
    run: (D) => {
      const P = D.pipeline;
      return { runs_summary: P.runs_summary, recent_runs: (P.runs || []).slice(0, 5), load: P.load,
        dbt: { counts: P.dbt?.counts, checks: P.dbt?.checks, checks_passed: P.dbt?.checks_passed, not_passing: P.dbt?.not_passing },
        freshness: P.freshness, tables: P.tables };
    },
  },
};

// Gemini function declarations; a lookup with no arguments leaves out parameters
export const DECLARATIONS = Object.entries(TOOLS).map(([name, t]) => ({ name, description: t.description,
  ...(Object.keys(t.parameters.properties).length ? { parameters: t.parameters } : {}) }));

export function runTool(D, name, args = {}) {
  const t = TOOLS[name];
  if (!t) return { error: `Unknown tool ${name}.` };
  try { return t.run(D, args || {}); } catch (e) { return { error: `Lookup failed: ${e.message}` }; }
}
