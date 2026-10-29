// cd chat && npm test  (needs docs/data/dashboard.json, written by scripts/export_dashboard.py)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DECLARATIONS, runTool } from "./tools.js";

const D = JSON.parse(readFileSync(new URL("../docs/data/dashboard.json", import.meta.url), "utf8"));
const { start, cities } = D.daily_pm;

test("city names: aliases and case, unknown cities listed", () => {
  assert.equal(runTool(D, "worst_days", { city: "bangalore" }).city, "Bengaluru");
  assert.equal(runTool(D, "worst_days", { city: "DELHI" }).city, "Delhi");
  assert.match(runTool(D, "worst_days", { city: "Atlantis" }).error, /Cities in the data: .*Delhi/);
  assert.ok(runTool(D, "worst_days", { city: "All cities" }).error, "worst_days has no 15-city row");
});

test("daily_pm_index matches the daily series", () => {
  const r = runTool(D, "daily_pm_index", { city: "Delhi", date_from: start, date_to: start });
  assert.equal(r.days[0].pm_index, cities.Delhi[0]);
  const wide = runTool(D, "daily_pm_index", { city: "Delhi", date_from: "2000-01-01", date_to: "2099-01-01" });
  assert.equal(wide.date_from, start);
  assert.equal(wide.days, undefined, "long ranges give stats only");
  assert.equal(wide.highest.pm_index, Math.max(...cities.Delhi.filter((v) => v != null)));
  assert.match(wide.note, /Clipped/);
});

test("day_all_cities ranks worst first", () => {
  const date = D.latest_day[0].date_ist;
  const rows = runTool(D, "day_all_cities", { date }).rows;
  assert.equal(rows.length, 15);
  assert.ok(rows.every((r, i) => i === 0 || rows[i - 1].pm_index >= r.pm_index));
  assert.equal(rows[0].city, D.latest_day.find((r) => r.rank_that_day === 1).city);
});

test("bad input returns an error, not a throw", () => {
  assert.ok(runTool(D, "daily_pm_index", { city: "Delhi", date_from: "yesterday", date_to: "today" }).error);
  assert.ok(runTool(D, "no_such_tool").error);
  assert.ok(runTool(D, "day_all_cities", { date: "1999-01-01" }).error);
});

test("every lookup runs with typical arguments", () => {
  for (const { name } of DECLARATIONS) {
    const out = runTool(D, name, { city: "Delhi", year: 2024, parameter: "pm10" });
    assert.equal(typeof out, "object", name);
  }
  assert.equal(runTool(D, "model_vs_stations", { city: "All cities", parameter: "pm25" }).summary.length, 1);
});

test("numbers arrive ready to quote", () => {
  const rain = runTool(D, "rain_effect").rows.find((r) => r.scope === "all" && r.bucket.startsWith("very heavy"));
  assert.equal(rain.mean_pm25, Math.round(D.rain.find((r) => r.scope === "all" && r.bucket === 4).mean_pm25 * 10) / 10);
  const k = runTool(D, "model_vs_stations", { city: "Kanpur", parameter: "pm10" }).summary[0];
  assert.equal(k.model_vs_stations_pct, Math.round(D.check.summary.find((r) => r.city === "Kanpur" && r.parameter === "pm10").bias * 100));
  assert.equal(k.bias, undefined);
  assert.ok(Number.isInteger(runTool(D, "overview").cities_ranked_by_mean_pm_index[0].pct_pm_poor));
});
