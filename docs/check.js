// Model check tab: the CAMS model's daily PM against ground stations (OpenAQ, mostly CPCB). Uses the helpers and
// data (D) from app.js and tabs.js; every number is computed by scripts/export_dashboard.py.
"use strict";

const PARAM_NAME = { pm25: "PM2.5", pm10: "PM10" };
state.checkParam = "pm25";
state.checkCity = "Delhi";
const signedPct = (v) => (v == null ? "–" : `${v > 0 ? "+" : v < 0 ? "−" : ""}${fmt(Math.abs(v) * 100, 0)}%`);

function renderCheck() {
  const C = D.check;
  if (!C) return;
  const sel = $("#check-city");
  if (!sel.options.length) {
    for (const c of [...new Set(C.summary.map((r) => r.city))].filter((c) => c !== ALL).sort()) sel.appendChild(new Option(c, c));
    sel.addEventListener("change", () => { state.checkCity = sel.value; renderCheckTime(); renderCheckCycles(); });
    document.querySelector('[data-ctl="check-param"]').addEventListener("click", (e) => {
      const b = e.target.closest("button"); if (!b) return;
      document.querySelectorAll('[data-ctl="check-param"] button').forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
      state.checkParam = b.dataset.v;
      renderCheckTime(); renderCheckCities(); renderCheckCycles();
    });
  }
  sel.value = state.checkCity;
  renderCheckKpis(); renderCheckTime(); renderCheckCities(); renderCheckCycles();
}

function renderCheckKpis() {
  const all = (p) => D.check.summary.find((r) => r.city === ALL && r.parameter === p);
  const box = $("#check-kpis");
  box.textContent = "";
  for (const p of ["pm25", "pm10"]) {
    const r = all(p);
    if (!r) continue;
    for (const [label, value, sub] of [
      [`${PARAM_NAME[p]}: model vs stations`, signedPct(r.bias), `model mean ${fmt(r.model, 0)} vs stations ${fmt(r.station, 0)} µg/m³`],
      [`${PARAM_NAME[p]}: do they move together?`, `r = ${fmt(r.r, 2)}`, `daily values, ${fmt(r.days)} city-days compared`],
    ]) {
      const k = el("div", "kpi glass");
      k.append(el("div", "label", label), el("div", "value", value), el("div", "sub", sub));
      box.appendChild(k);
    }
  }
}

function renderCheckTime() {
  const p = state.checkParam, city = state.checkCity;
  const rows = D.check.monthly.filter((r) => r.city === city && r.parameter === p);
  const s = D.check.summary.find((r) => r.city === city && r.parameter === p);
  const find = $("#finding-check-time");
  find.textContent = "";
  if (!rows.length) { find.textContent = `No month in ${city} has 10 or more days with complete station data for ${PARAM_NAME[p]}.`; $("#chart-check-time").textContent = ""; $("#legend-check-time").textContent = ""; return; }
  find.appendChild(el("b", null, `${city}, ${PARAM_NAME[p]}: the model is ${signedPct(s.bias)} ${s.bias > 0 ? "above" : "below"} the stations on average (r = ${fmt(s.r, 2)}). `));
  find.appendChild(document.createTextNode(`${fmt(s.days)} days compared between ${dateIN(s.first_day)} and ${dateIN(s.last_day)}, using ${fmt(s.mean_stations, 1)} stations a day on average. Months with fewer than 10 compared days are left out.`));
  // every month between the first and last compared month, so gaps in the station data show as gaps
  const months = [], [y0, m0] = rows[0].month.split("-").map(Number), [y1, m1] = rows[rows.length - 1].month.split("-").map(Number);
  for (let y = y0, m = m0; y * 12 + m <= y1 * 12 + m1; m === 12 ? (y++, m = 1) : m++) months.push(`${y}-${String(m).padStart(2, "0")}`);
  const by = new Map(rows.map((r) => [r.month, r]));
  const series = [
    { label: "Model", values: months.map((m) => by.get(m)?.model ?? null), color: "var(--s1)" },
    { label: "Stations", values: months.map((m) => by.get(m)?.station ?? null), color: "var(--s2)" },
  ];
  const markers = D.check.cycles.map((c) => ({ i: months.indexOf(c.start_date.slice(0, 7)) + (+c.start_date.slice(8, 10) - 1) / 30, label: `Model ${c.cycle}`, short: c.cycle }))
    .filter((mk) => mk.i >= 0);
  lineChart({
    id: "chart-check-time", xs: months, series, markers, yStep: p === "pm10" ? 50 : 25, height: 300,
    xTicks: months.map((m, i) => (m.endsWith("-01") ? i : -1)).filter((i) => i >= 0), xLabel: (m) => m.slice(0, 4),
    tipTitle: (m) => `${MONTHS[+m.slice(5) - 1]} ${m.slice(0, 4)} · ${PARAM_NAME[p]}${by.get(m) ? ` · ${by.get(m).days} days` : ""}`,
    valueFmt: (v) => (v == null ? "–" : `${fmt(v, 0)} µg/m³`),
  });
  legend("legend-check-time", series.map((se) => [se.label, se.color]), "line");
}

// diverging bars: how far the model's mean is from the stations', per city
function renderCheckCities() {
  const p = state.checkParam;
  const rows = D.check.summary.filter((r) => r.parameter === p && r.city !== ALL).sort((a, b) => b.bias - a.bias);
  const h = 22, m = { l: 92, r: 48, t: 22, b: 8 };
  const { svg, width } = svgFor("chart-check-cities", m.t + m.b + rows.length * h);
  const lim = Math.max(0.5, Math.ceil(Math.max(...rows.map((r) => Math.abs(r.bias))) * 4) / 4);
  const x = (v) => m.l + ((v + lim) / (2 * lim)) * (width - m.l - m.r);
  for (const t of range(-lim, lim, lim > 1 || width < 520 ? 0.5 : 0.25)) {
    s("line", { x1: x(t), x2: x(t), y1: m.t - 4, y2: m.t + rows.length * h, class: t === 0 ? "baseline" : "gridline" }, svg);
    text(svg, x(t), m.t - 8, signedPct(t), { "text-anchor": "middle" });
  }
  rows.forEach((r, i) => {
    const y = m.t + i * h, x0 = x(0), x1 = x(r.bias);
    text(svg, m.l - 8, y + h / 2 + 4, r.city, { "text-anchor": "end", class: "lbl" });
    const bar = s("path", { d: r.bias >= 0 ? hbar(x0, y + 4, Math.max(1, x1 - x0), h - 8) : hbar(x1, y + 4, Math.max(1, x0 - x1), h - 8, 0),
      class: "grow-x pick", style: `fill:${r.bias >= 0 ? "var(--s2)" : "var(--s1)"}` }, svg);
    text(svg, r.bias >= 0 ? x1 + 6 : x1 - 6, y + h / 2 + 4, signedPct(r.bias), { "text-anchor": r.bias >= 0 ? "start" : "end" });
    bar.addEventListener("pointermove", (e) => showTip(e, `${r.city} · ${PARAM_NAME[p]}`, [
      ["Model mean", `${fmt(r.model, 1)} µg/m³`], ["Stations mean", `${fmt(r.station, 1)} µg/m³`], ["Difference", signedPct(r.bias)],
      ["Correlation r", fmt(r.r, 2)], ["Days compared", fmt(r.days)]]));
    bar.addEventListener("pointerleave", hideTip);
    bar.addEventListener("click", () => { hideTip(); state.checkCity = r.city; $("#check-city").value = r.city; renderCheckTime(); renderCheckCycles(); });
  });
  legend("legend-check-cities", [["Model higher than stations", "var(--s2)"], ["Model lower", "var(--s1)"]]);
  animateIn(svg);
  const host = $("#table-check-cities");
  host.textContent = "";
  host.appendChild(buildTable(["City", "Days", "Model µg/m³", "Stations µg/m³", "Difference", "r", "RMSE µg/m³"],
    rows.map((r) => [r.city, fmt(r.days), fmt(r.model, 1), fmt(r.station, 1), signedPct(r.bias), fmt(r.r, 2), fmt(r.rmse, 1)])));
}

function renderCheckCycles() {
  const p = state.checkParam, city = state.checkCity;
  const order = ["before 48R1", ...D.check.cycles.map((c) => c.cycle)];
  const rows = (c) => D.check.by_cycle.filter((r) => r.city === c && r.parameter === p).sort((a, b) => order.indexOf(a.model_cycle) - order.indexOf(b.model_cycle));
  $("#cycles-title").textContent = `${city} and all cities, ${PARAM_NAME[p]}`;
  const host = $("#table-check-cycles");
  host.textContent = "";
  host.appendChild(buildTable(["Where", "Model version", "Days", "Cities", "Stations a day", "Model µg/m³", "Stations µg/m³", "Difference", "r"],
    [...rows(city), ...rows(ALL)].map((r) => [r.city, r.model_cycle, fmt(r.days), fmt(r.cities), fmt(r.mean_stations, 1),
      fmt(r.model, 1), fmt(r.station, 1), signedPct(r.bias), fmt(r.r, 2)])));
  const mine = rows(city), find = $("#finding-check-cycles");
  find.textContent = "";
  if (!mine.length) { find.textContent = `No compared days for ${city} and ${PARAM_NAME[p]}.`; return; }
  find.appendChild(el("b", null, `${city}, ${PARAM_NAME[p]}: ` +
    mine.map((r) => `${r.model_cycle}: model ${signedPct(r.bias)} vs stations over ${fmt(r.days)} days`).join(" · ") + ". "));
  // the station record in OpenAQ is uneven, so say what each version's numbers rest on
  const missing = order.filter((c) => !rows(ALL).some((r) => r.model_cycle === c));
  find.appendChild(document.createTextNode(
    "Read with care: OpenAQ's station record is much thinner before 2025, so each version is compared on different days, " +
    "seasons and stations." + (missing.length ? ` There are no compared ${PARAM_NAME[p]} days at all under ${missing.join(" and ")}.` : "")));
}

TAB_RENDER.check = renderCheck;
