// City and Pipeline tabs. Uses the helpers and data (D) from app.js and registers its renderers in TAB_RENDER;
// like app.js it only formats and draws what scripts/export_dashboard.py exported.
"use strict";

const POLLUTANT = { pm25: "PM2.5", pm10: "PM10", no2: "NO₂", o3: "O₃", co: "CO", so2: "SO₂" };
const catIndex = (v) => (v <= 50 ? 0 : v <= 100 ? 1 : v <= 200 ? 2 : v <= 300 ? 3 : v <= 400 ? 4 : 5); // CPCB bands
const catColor = (v) => `var(--o${catIndex(v) + 1})`;
const dateIN = (iso, opts = { day: "numeric", month: "short", year: "numeric" }) =>
  new Date(`${iso.slice(0, 10)}T00:00:00Z`).toLocaleDateString("en-IN", { timeZone: "UTC", ...opts });
const timeIST = (iso) => new Date(iso).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const minSec = (s) => `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, "0")} s`;
const ordinal = (n) => n + (n % 10 === 1 && n !== 11 ? "st" : n % 10 === 2 && n !== 12 ? "nd" : n % 10 === 3 && n !== 13 ? "rd" : "th");
function el(tag, cls, txt) { const n = document.createElement(tag); if (cls) n.className = cls; if (txt != null) n.textContent = txt; return n; }

// ---------- City ----------
state.city = new URLSearchParams(location.search).get("city") || "Delhi";

function pickCity(city) {
  state.city = city;
  $("#city-pick").value = city;
  setParam("city", city);
  renderCity();
}

function renderCity() {
  if (!D.daily_pm.cities[state.city]) state.city = "Delhi";
  const sel = $("#city-pick");
  if (!sel.options.length) {
    for (const c of Object.keys(D.daily_pm.cities).sort()) sel.appendChild(new Option(c, c));
    sel.addEventListener("change", () => pickCity(sel.value));
  }
  sel.value = state.city;
  renderToday(); renderCalendar(); renderWorst();
}

function renderToday() {
  const r = D.latest_day.find((x) => x.city === state.city);
  $("#today-title").textContent = `${state.city} on ${dateIN(r.date_ist, { weekday: "long", day: "numeric", month: "long", year: "numeric" })}`;
  $("#today-sub").textContent = `The latest complete IST day in the warehouse. ${ordinal(r.rank_that_day)} worst of ${D.latest_day.length} cities that day.`;
  const box = $("#today-stats");
  box.textContent = "";
  const big = el("div", "big");
  big.append(el("b", null, fmt(r.aqi_pm)), el("span", "big-label", "PM index"));
  const badge = el("span", "badge"); const sw = el("i"); sw.style.background = catColor(r.aqi_pm);
  badge.append(sw, document.createTextNode(r.aqi_pm_category));
  big.appendChild(badge);
  const dl = el("dl");
  for (const [k, v] of [
    ["Set by", POLLUTANT[r.pm_driver]],
    ["Full AQI", `${fmt(r.aqi)} · ${r.aqi_category}, set by ${POLLUTANT[r.dominant_pollutant]}`],
    ["PM2.5, 24 h mean", `${fmt(r.pm25, 1)} µg/m³`],
    ["PM10, 24 h mean", `${fmt(r.pm10, 1)} µg/m³`],
    ["Temperature, mean", `${fmt(r.temp_c, 1)} °C`],
    ["Rain", `${fmt(r.rain_mm, 1)} mm`],
    ["Wind, mean", `${fmt(r.wind_kmh, 1)} km/h`],
  ]) dl.append(el("dt", null, k), el("dd", null, v));
  box.append(big, dl);

  // every city on that day, the picked one highlighted; click a bar to switch city
  const rows = D.latest_day, h = 19, m = { l: 84, r: 34, t: 2, b: 2 };
  const { svg, width } = svgFor("chart-today", m.t + m.b + rows.length * h);
  const max = Math.max(...rows.map((x) => x.aqi_pm)), xs = (v) => (v / max) * (width - m.l - m.r);
  rows.forEach((x, i) => {
    const y = m.t + i * h, on = x.city === state.city;
    text(svg, m.l - 8, y + h / 2 + 4, x.city, { "text-anchor": "end", class: on ? "val" : "lbl" });
    const bar = s("path", { d: hbar(m.l, y + 3, Math.max(2, xs(x.aqi_pm)), h - 6), class: "grow-x pick",
      style: `fill:${on ? "var(--s1)" : "var(--neutral-series)"}` }, svg);
    text(svg, m.l + xs(x.aqi_pm) + 6, y + h / 2 + 4, fmt(x.aqi_pm), { class: on ? "val" : null });
    bar.addEventListener("pointermove", (e) => showTip(e, x.city, [["PM index", fmt(x.aqi_pm)], ["Category", x.aqi_pm_category]]));
    bar.addEventListener("pointerleave", hideTip);
    bar.addEventListener("click", () => { hideTip(); pickCity(x.city); });
  });
  animateIn(svg);
}

function renderCalendar() {
  const vals = D.daily_pm.cities[state.city], t0 = Date.parse(`${D.daily_pm.start}T00:00:00Z`);
  const dayAt = (i) => new Date(t0 + i * 864e5);
  const first = dayAt(0), last = dayAt(vals.length - 1), months = [];
  for (let y = first.getUTCFullYear(), mo = first.getUTCMonth(); y * 12 + mo <= last.getUTCFullYear() * 12 + last.getUTCMonth(); mo === 11 ? (y++, mo = 0) : mo++) months.push([y, mo]);
  const narrow = $("#chart-calendar").clientWidth < 600;
  const rowH = narrow ? 10 : 12, m = { l: 62, r: 2, t: 18, b: 2 };
  const { svg, width } = svgFor("chart-calendar", m.t + m.b + months.length * rowH);
  const cw = (width - m.l - m.r) / 31, row = new Map(months.map(([y, mo], k) => [y * 12 + mo, k]));
  for (const d of [1, 5, 10, 15, 20, 25, 31]) text(svg, m.l + (d - 0.5) * cw, m.t - 6, d, { "text-anchor": "middle" });
  months.forEach(([y, mo], k) => { if (k === 0 || mo % 3 === 0) text(svg, m.l - 8, m.t + (k + 1) * rowH - 2, `${MONTHS[mo]} ${y}`, { "text-anchor": "end" }); });
  const g = s("g", { class: "fade" }, svg);
  vals.forEach((v, i) => {
    if (v == null) return;
    const d = dayAt(i);
    s("rect", { x: m.l + (d.getUTCDate() - 1) * cw + 0.5, y: m.t + row.get(d.getUTCFullYear() * 12 + d.getUTCMonth()) * rowH + 0.5,
      width: Math.max(1, cw - 1), height: rowH - 1, rx: 1.5, "data-i": i, style: `fill:${catColor(v)}` }, g);
  });
  g.addEventListener("pointermove", (e) => {
    const i = e.target.dataset.i;
    if (i == null) return hideTip();
    showTip(e, dateIN(dayAt(+i).toISOString(), { weekday: "short", day: "numeric", month: "short", year: "numeric" }),
      [["PM index", fmt(vals[i])], ["Category", CATS[catIndex(vals[i])]]]);
  });
  g.addEventListener("pointerleave", hideTip);
  legend("legend-calendar", CATS.map((c, i) => [c, `var(--o${i + 1})`]));
  animateIn(svg);
}

function renderWorst() {
  $("#worst-title").textContent = `The 10 worst days in ${state.city}`;
  const host = $("#table-worst");
  host.textContent = "";
  host.appendChild(buildTable(["Date", "PM index", "Category", "Set by", "PM2.5 µg/m³", "PM10 µg/m³", "Rain mm", "Wind km/h", "Temp °C"],
    D.worst_days.filter((r) => r.city === state.city).map((r) => [dateIN(r.date_ist), fmt(r.aqi_pm), r.aqi_pm_category,
      POLLUTANT[r.pm_driver], fmt(r.pm25, 1), fmt(r.pm10, 1), fmt(r.rain_mm, 1), fmt(r.wind_kmh, 1), fmt(r.temp_c, 1)])));
}

// ---------- Pipeline ----------
const NODE_TYPE = { model: "Models", seed: "Seeds", test: "Data tests", unit_test: "Unit tests" };

function renderPipeline() {
  const p = D.pipeline || {};
  const rs = p.runs_summary, b = p.dbt;
  const kpis = $("#pipe-kpis");
  kpis.textContent = "";
  for (const [label, value, sub] of [
    ["Recent runs that succeeded", rs ? `${rs.succeeded} of ${rs.completed}` : "–", rs ? "completed runs of the daily workflow" : "run history unavailable"],
    ["Started by the schedule", rs ? fmt(rs.scheduled) : "–", rs ? (rs.scheduled ? `${rs.scheduled_succeeded} of them succeeded` : "every run so far was started by hand") : ""],
    ["Median run time", rs?.median_success_s ? minSec(rs.median_success_s) : "–", "successful runs, start to deploy"],
    ["dbt checks passed", b ? `${b.checks_passed} of ${b.checks}` : "–", b ? "data and unit tests in this build" : "build results unavailable"],
  ]) {
    const k = el("div", "kpi glass");
    k.append(el("div", "label", label), el("div", "value", value), el("div", "sub", sub));
    kpis.appendChild(k);
  }
  renderFlow(p); renderRuns(p); renderTests(b); renderTables(p.tables || []);
}

function renderFlow(p) {
  const flow = $("#flow");
  flow.textContent = "";
  const load = p.load && Object.values(p.load.tables);
  const count = (t) => (p.dbt?.counts || []).filter((c) => c.type === t).reduce((a, c) => a + c.n, 0);
  const fresh = p.freshness || [];
  for (const [title, what, metric] of [
    ["Load", "Open-Meteo APIs → BigQuery raw tables. Whole month partitions are replaced, so reruns never duplicate.",
      load ? `${fmt(load.reduce((a, t) => a + t.rows, 0))} rows written in ${fmt(load.reduce((a, t) => a + t.seconds, 0), 0)} s (${p.load.start} to ${p.load.end})` : "report unavailable"],
    ["Check freshness", "dbt source freshness: warn after 30 h, fail after 54 h without a load.",
      fresh.length ? `${fresh.filter((f) => f.status === "pass").length} of ${fresh.length} sources pass` : "report unavailable"],
    ["Build and test", "dbt build: staging views, marts tables, then the tests on each model.",
      p.dbt ? `${count("model")} models, ${count("test") + count("unit_test")} tests, ${count("seed")} seeds in ${fmt(p.dbt.elapsed_s, 0)} s` : "report unavailable"],
    ["Publish", "Export the marts to JSON, build the dbt docs, deploy to GitHub Pages.",
      `This page: ${timeIST(D.generated_at)} IST`],
  ]) {
    const li = el("li");
    li.append(el("b", null, title), el("span", null, what), el("div", "metric", metric));
    flow.appendChild(li);
  }
}

function renderRuns(p) {
  const runs = (p.runs || []).slice().reverse(), rs = p.runs_summary; // the API lists newest first
  const find = $("#finding-runs");
  if (!runs.length) { find.textContent = "Run history was not available when this page was built."; $("#chart-runs").textContent = ""; return; }
  find.textContent = `${rs.succeeded} of ${rs.completed} runs succeeded. ` + (rs.scheduled
    ? `${rs.scheduled_succeeded} of ${rs.scheduled} were started by the schedule.`
    : "None was started by the schedule yet: every run so far was started by hand, so the daily schedule is not proven yet.");
  const height = 220, m = { l: 48, r: 6, t: 10, b: 24 };
  const { svg, width } = svgFor("chart-runs", height);
  const yMax = niceMax(Math.max(...runs.map((r) => r.seconds / 60)), 1);
  const ys = (v) => height - m.b - (v / yMax) * (height - m.t - m.b);
  yAxis(svg, m.l, width - m.r, ys, range(0, yMax, yMax > 8 ? 2 : 1), (v) => `${v} min`);
  const bw = (width - m.l - m.r) / runs.length;
  runs.forEach((r, i) => {
    const color = r.conclusion !== "success" ? "var(--critical)" : r.event === "schedule" ? "var(--s1)" : "var(--o1)";
    const a = s("a", { href: r.url, target: "_blank", rel: "noopener", "aria-label": `Run ${r.sha}, ${r.conclusion}` }, svg);
    const w = Math.min(28, bw * 0.7), x = m.l + i * bw + (bw - w) / 2;
    s("path", { d: vbar(x, ys(0), w, Math.max(1, ys(0) - ys(r.seconds / 60)), 3), class: "grow-y", style: `fill:${color}` }, a);
    a.addEventListener("pointermove", (e) => showTip(e, `${timeIST(r.started_at)} IST`, [
      ["Started", r.event === "schedule" ? "by the schedule" : "by hand"], ["Result", r.conclusion], ["Time", minSec(r.seconds)], ["Commit", r.sha]]));
    a.addEventListener("pointerleave", hideTip);
  });
  const ticks = runs.length > 1 ? [0, runs.length - 1] : [0];
  for (const i of ticks) text(svg, m.l + i * bw + bw / 2, height - 6, dateIN(runs[i].started_at, { day: "numeric", month: "short" }), { "text-anchor": i ? "end" : "start" });
  legend("legend-runs", [["Started by the schedule", "var(--s1)"], ["Started by hand", "var(--o1)"], ["Failed or cancelled", "var(--critical)"]]);
  animateIn(svg);
}

function renderTests(b) {
  const host = $("#table-tests"), slow = $("#table-slow"), find = $("#finding-tests");
  host.textContent = slow.textContent = "";
  if (!b) { $("#tests-sub").textContent = "Build results were not available when this page was built."; find.textContent = ""; return; }
  $("#tests-sub").textContent = `Finished ${timeIST(b.generated_at)} IST, ${fmt(b.elapsed_s, 1)} s in total`;
  const by = {};
  for (const c of b.counts) (by[c.type] ||= {})[c.status] = c.n;
  host.appendChild(buildTable(["", "OK", "Warn", "Error"], Object.keys(NODE_TYPE).filter((t) => by[t]).map((t) =>
    [NODE_TYPE[t], fmt((by[t].pass || 0) + (by[t].success || 0)), fmt(by[t].warn || 0), fmt((by[t].fail || 0) + (by[t].error || 0))])));
  find.textContent = "";
  if (!b.not_passing.length) find.textContent = "Every model built and every test passed.";
  else {
    find.appendChild(el("b", null, `${b.not_passing.length} not passing: `));
    b.not_passing.forEach((n, i) => {
      if (i) find.appendChild(document.createTextNode("; "));
      find.append(el("code", null, n.name), document.createTextNode(` (${n.status}${n.failures ? `, ${fmt(n.failures)} rows` : ""})`));
    });
    // the known warnings: negative model values kept in raw and floored at 0 in staging
    if (b.not_passing.every((n) => n.status === "warn" && n.name.startsWith("source_accepted_range_raw_")))
      find.appendChild(document.createTextNode(". These are negative concentrations returned by the model; raw keeps them and staging floors them at 0."));
  }
  slow.appendChild(buildTable(["Model", "Seconds", "Result"], b.slowest_models.map((n) => [n.name, fmt(n.seconds, 1), n.message])));
}

function renderTables(tables) {
  const host = $("#table-tables");
  host.textContent = "";
  host.appendChild(buildTable(["Table", "Rows", "MiB", "Expires"],
    tables.map((t) => [t.table, fmt(t.rows), fmt(t.mib, 1), t.expires ? dateIN(t.expires) : "never"])));
}

TAB_RENDER.city = renderCity;
TAB_RENDER.pipeline = renderPipeline;
