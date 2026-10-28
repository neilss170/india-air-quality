// India Air Quality dashboard: vanilla JS, hand-written SVG. Every number is read from data/dashboard.json,
// which scripts/export_dashboard.py writes from the BigQuery marts; this file only formats and draws.
"use strict";

const NS = "http://www.w3.org/2000/svg";
const ALL = "All cities";
const CATS = ["Good", "Satisfactory", "Moderate", "Poor", "Very Poor", "Severe"];
const RAIN_BUCKETS = ["Dry (< 0.1 mm)", "0.1–2.5 mm", "2.5–10 mm", "10–30 mm", "30 mm +"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const INDEX_NAME = { aqi_pm: "PM index", aqi: "Full AQI" };
// CAMS upgrades that changed how dust is modelled: cycle 48R1 on 27 Jun 2023, 49R1 on 12 Nov 2024
const CAMS_UPGRADES = [["2023-06", 27], ["2024-11", 12]];
// no entrance animation for viewers who ask for reduced motion, or with ?motion=off (screenshots, print)
const REDUCED = window.matchMedia("(prefers-reduced-motion: reduce)").matches ||
  new URLSearchParams(location.search).get("motion") === "off";
if (REDUCED) document.documentElement.classList.add("no-motion");

let D = null;
const state = { rankIndex: "aqi_pm", timeIndex: "aqi_pm", timeCity: "Delhi", diwaliCity: ALL, rainScope: "all", hourCity: "Delhi" };
const openTables = new Set();

// ---------- small helpers ----------
const $ = (s) => document.querySelector(s);
const fmt = (v, d = 0) => v == null ? "–" : Number(v).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
const pct = (v, d = 0) => `${fmt(v * 100, d)}%`;
const cssVar = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

function s(tag, attrs = {}, parent) {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) n.setAttribute(k, v);
  if (parent) parent.appendChild(n);
  return n;
}
function text(parent, x, y, str, attrs = {}) {
  const t = s("text", { x, y, ...attrs }, parent);
  t.textContent = str;
  return t;
}
function svgFor(id, height) {
  const box = document.getElementById(id);
  box.textContent = "";
  const width = Math.max(280, box.clientWidth);
  const svg = s("svg", { viewBox: `0 0 ${width} ${height}`, width, height, role: "img" }, box);
  return { box, svg, width, height };
}
function niceMax(v, step) { return Math.ceil((v * 1.06) / step) * step; }
// bar with 4px rounded data end, square at the baseline
function hbar(x, y, w, h, r = 4) {
  r = Math.min(r, w, h / 2);
  return `M${x},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h - r}Q${x + w},${y + h} ${x + w - r},${y + h}H${x}Z`;
}
function vbar(x, y0, w, h, r = 4) {
  r = Math.min(r, h, w / 2);
  const y = y0 - h;
  return `M${x},${y0}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y0}Z`;
}
function animateIn(root) {
  if (REDUCED) { root.classList.add("in"); root.querySelectorAll(".draw").forEach((p) => (p.style.strokeDashoffset = 0)); return; }
  requestAnimationFrame(() => requestAnimationFrame(() => {
    root.classList.add("in");
    root.querySelectorAll(".draw").forEach((p) => (p.style.strokeDashoffset = 0));
  }));
}
function drawable(path) {
  const len = path.getTotalLength();
  path.classList.add("draw");
  path.style.strokeDasharray = `${len} ${len}`;
  path.style.strokeDashoffset = REDUCED ? 0 : len;
}

// ---------- tooltip ----------
const tip = $("#tooltip");
function showTip(evt, title, rows) {
  tip.textContent = "";
  const h = document.createElement("div");
  h.className = "t-title"; h.textContent = title; tip.appendChild(h);
  for (const [label, value, color] of rows) {
    const r = document.createElement("div"); r.className = "t-row";
    const l = document.createElement("span");
    if (color) { const sw = document.createElement("i"); sw.className = "sw"; sw.style.background = color; l.appendChild(sw); }
    l.appendChild(document.createTextNode(label));
    const b = document.createElement("b"); b.textContent = value;
    r.append(l, b); tip.appendChild(r);
  }
  tip.classList.add("on");
  const pad = 14, w = tip.offsetWidth, hgt = tip.offsetHeight;
  let x = evt.clientX + pad, y = evt.clientY + pad;
  if (x + w > window.innerWidth - 8) x = evt.clientX - w - pad;
  if (y + hgt > window.innerHeight - 8) y = evt.clientY - hgt - pad;
  tip.style.left = `${Math.max(8, x)}px`; tip.style.top = `${Math.max(8, y)}px`;
}
function hideTip() { tip.classList.remove("on"); }

// ---------- axes ----------
function yAxis(svg, x0, x1, yScale, ticks, fmtTick = (v) => fmt(v)) {
  for (const t of ticks) {
    const y = yScale(t);
    s("line", { x1: x0, x2: x1, y1: y, y2: y, class: t === 0 ? "baseline" : "gridline" }, svg);
    text(svg, x0 - 6, y + 3.5, fmtTick(t), { "text-anchor": "end" });
  }
}
function range(lo, hi, step) { const out = []; for (let v = lo; v <= hi + 1e-9; v += step) out.push(+v.toFixed(6)); return out; }

// ---------- legends ----------
function legend(id, items, kind = "box") {
  const el = document.getElementById(id);
  el.textContent = "";
  for (const [label, color] of items) {
    const sp = document.createElement("span");
    const i = document.createElement("i"); if (kind === "line") i.className = "line";
    i.style.background = color; sp.append(i, document.createTextNode(label)); el.appendChild(sp);
  }
}

// ---------- line chart (shared by month-by-month, Diwali, daily cycle) ----------
function lineChart({ id, xs, series, xLabel, xTicks, yStep, height = 280, markers = [], refLines = [], tipTitle, valueFmt = (v) => fmt(v, 1) }) {
  const { svg, width } = svgFor(id, height);
  const m = { l: 40, r: 64, t: 14, b: 30 };
  const allY = series.flatMap((se) => se.values.filter((v) => v != null));
  const yMax = niceMax(Math.max(...allY, ...refLines.map((r) => r.v)), yStep);
  const xi = (i) => m.l + (i / (xs.length - 1)) * (width - m.l - m.r);
  const ys = (v) => height - m.b - (v / yMax) * (height - m.t - m.b);
  yAxis(svg, m.l, width - m.r, ys, range(0, yMax, yStep));
  for (const r of refLines) {
    s("line", { x1: m.l, x2: width - m.r, y1: ys(r.v), y2: ys(r.v), class: "refline" }, svg);
    text(svg, m.l + 4, ys(r.v) - 4, r.label, { class: "ref" });
  }
  for (const i of xTicks) text(svg, xi(i), height - m.b + 16, xLabel(xs[i]), { "text-anchor": "middle" });
  markers.forEach((mk, k) => {
    const x = xi(mk.i), next = markers[k + 1];
    s("line", { x1: x, x2: x, y1: m.t, y2: height - m.b, class: "marker-line" }, svg);
    // the short label when the next marker is too close for the full one (narrow screens)
    const label = next && xi(next.i) - x < 100 ? mk.short ?? mk.label : mk.label;
    text(svg, x + 4, m.t + 10, label, { class: "lbl ref" });
  });
  const g = s("g", {}, svg);
  const ends = [];
  for (const se of series) {
    let d = "";
    se.values.forEach((v, i) => { if (v != null) d += `${d && se.values[i - 1] != null ? "L" : "M"}${xi(i).toFixed(1)},${ys(v).toFixed(1)}`; });
    const p = s("path", { d, class: "series", style: `stroke:${se.color}` }, g);
    drawable(p);
    // direct label at the line end (series are few, so every one gets a label)
    const last = se.values.length - 1 - [...se.values].reverse().findIndex((v) => v != null);
    ends.push({ x: xi(last) + 6, y: ys(se.values[last]) + 4, label: se.label });
  }
  ends.sort((a, b) => a.y - b.y);
  for (let k = 1; k < ends.length; k++) ends[k].y = Math.max(ends[k].y, ends[k - 1].y + 13);
  for (const e of ends) text(svg, e.x, e.y, e.label, { class: "lbl" });
  // crosshair + tooltip
  const cross = s("line", { y1: m.t, y2: height - m.b, class: "crosshair" }, svg);
  const dots = series.map((se) => s("circle", { r: 4, class: "dot", style: `fill:${se.color}` }, svg));
  const hit = s("rect", { x: m.l, y: m.t, width: width - m.l - m.r, height: height - m.t - m.b, class: "hit" }, svg);
  const move = (evt) => {
    const pt = svg.getBoundingClientRect();
    const px = (evt.clientX - pt.left) * (width / pt.width);
    const i = Math.max(0, Math.min(xs.length - 1, Math.round(((px - m.l) / (width - m.l - m.r)) * (xs.length - 1))));
    cross.setAttribute("x1", xi(i)); cross.setAttribute("x2", xi(i)); cross.style.opacity = 1;
    series.forEach((se, k) => {
      const v = se.values[i];
      dots[k].style.opacity = v == null ? 0 : 1;
      if (v != null) { dots[k].setAttribute("cx", xi(i)); dots[k].setAttribute("cy", ys(v)); }
    });
    showTip(evt, tipTitle(xs[i]), series.map((se) => [se.label, valueFmt(se.values[i]), se.color]));
  };
  hit.addEventListener("pointermove", move);
  hit.addEventListener("pointerleave", () => { hideTip(); cross.style.opacity = 0; dots.forEach((d) => (d.style.opacity = 0)); });
  animateIn(svg);
}

// ---------- charts ----------
function cityOrder() { return D.cities.map((c) => c.city); } // by mean PM index, worst first (export order)

function renderRank() {
  const key = state.rankIndex === "aqi_pm" ? "mean_aqi_pm" : "mean_aqi";
  const rows = [...D.cities].sort((a, b) => b[key] - a[key]);
  const rowH = 22, m = { l: 92, r: 40, t: 20, b: 24 };
  const height = m.t + m.b + rows.length * rowH;
  const { svg, width } = svgFor("chart-rank", height);
  const xMax = niceMax(Math.max(...rows.map((r) => r[key])), 50);
  const xs = (v) => m.l + (v / xMax) * (width - m.l - m.r);
  for (const t of range(0, xMax, 50)) {
    s("line", { x1: xs(t), x2: xs(t), y1: m.t, y2: height - m.b, class: t === 0 ? "baseline" : "gridline" }, svg);
    text(svg, xs(t), height - m.b + 15, fmt(t), { "text-anchor": "middle" });
  }
  for (const [v, label] of [[100, "Moderate →"], [200, "Poor →"]]) if (v < xMax) {
    s("line", { x1: xs(v), x2: xs(v), y1: m.t - 6, y2: height - m.b, class: "refline" }, svg);
    text(svg, xs(v) + 4, m.t - 8, label);
  }
  const color = state.rankIndex === "aqi_pm" ? "var(--s1)" : "var(--s2)";
  rows.forEach((r, i) => {
    const y = m.t + i * rowH;
    text(svg, m.l - 8, y + rowH / 2 + 4, r.city, { "text-anchor": "end", class: "lbl" });
    s("path", { d: hbar(xs(0), y + 4, xs(r[key]) - xs(0), rowH - 8), class: "grow-x", style: `fill:${color};transition-delay:${i * 35}ms` }, svg);
    if (i === 0 || i === rows.length - 1) text(svg, xs(r[key]) + 6, y + rowH / 2 + 4, fmt(r[key]), { class: "val" });
    const hit = s("rect", { x: 0, y, width, height: rowH, class: "hit" }, svg);
    hit.addEventListener("pointermove", (e) => showTip(e, r.city, [
      ["PM index (mean)", fmt(r.mean_aqi_pm, 1)], ["Full AQI (mean)", fmt(r.mean_aqi, 1)],
      ["PM2.5 (mean µg/m³)", fmt(r.mean_pm25, 1)], ["Days PM index Poor+", pct(r.share_pm_poor, 1)],
      ["Days ozone sets full AQI", pct(r.share_o3_dominant, 0)]]));
    hit.addEventListener("pointerleave", hideTip);
  });
  animateIn(svg);
}

function catColors() { return CATS.map((_, i) => `var(--o${i + 1})`); }
function renderCats() {
  const order = cityOrder();
  const byCity = {};
  for (const r of D.categories) (byCity[r.city] ||= {})[r.category] = r.days;
  const rowH = 22, m = { l: 92, r: 12, t: 6, b: 24 };
  const height = m.t + m.b + order.length * rowH;
  const { svg, width } = svgFor("chart-cats", height);
  const xs = (f) => m.l + f * (width - m.l - m.r);
  for (const t of [0, 0.25, 0.5, 0.75, 1]) text(svg, xs(t), height - m.b + 15, pct(t), { "text-anchor": "middle" });
  const colors = catColors();
  order.forEach((city, i) => {
    const y = m.t + i * rowH, counts = byCity[city] || {};
    const total = CATS.reduce((a, c) => a + (counts[c] || 0), 0);
    text(svg, m.l - 8, y + rowH / 2 + 4, city, { "text-anchor": "end", class: "lbl" });
    let acc = 0;
    const g = s("g", { class: "fade", style: `transition-delay:${i * 35}ms` }, svg);
    CATS.forEach((c, k) => {
      const f = (counts[c] || 0) / total;
      if (f > 0) {
        const x = xs(acc), w = Math.max(0, xs(acc + f) - xs(acc) - 2); // 2px surface gap between segments
        s("rect", { x, y: y + 4, width: w, height: rowH - 8, rx: 2, style: `fill:${colors[k]}` }, g);
      }
      acc += f;
    });
    const hit = s("rect", { x: 0, y, width, height: rowH, class: "hit" }, svg);
    hit.addEventListener("pointermove", (e) => showTip(e, `${city}: ${fmt(total)} days`,
      CATS.map((c, k) => [c, `${pct((counts[c] || 0) / total, 1)} (${fmt(counts[c] || 0)})`, colors[k]])));
    hit.addEventListener("pointerleave", hideTip);
  });
  legend("legend-cats", CATS.map((c, k) => [c, colors[k]]));
  animateIn(svg);
}

function seriesFor(rows, city, key) { return rows.filter((r) => r.city === city).map((r) => r[key]); }

function renderTime() {
  const months = [...new Set(D.monthly.map((r) => r.month))].sort();
  const key = state.timeIndex;
  const byKey = (city) => { const m = new Map(D.monthly.filter((r) => r.city === city).map((r) => [r.month, r[key]])); return months.map((mo) => m.get(mo) ?? null); };
  const series = [];
  if (state.timeCity !== ALL) series.push({ label: state.timeCity, values: byKey(state.timeCity), color: "var(--s1)" });
  series.push({ label: ALL, values: byKey(ALL), color: "var(--neutral-series)" });
  const xTicks = months.map((mo, i) => (mo.endsWith("-01") ? i : -1)).filter((i) => i >= 0);
  // CAMS model upgrades that changed the dust scheme, placed at their day within the month
  const markers = CAMS_UPGRADES.map(([mo, day]) => ({ i: months.indexOf(mo) + (day - 1) / 30, label: "Model upgrade", short: "Upgrade" }))
    .filter((mk) => mk.i >= 0);
  lineChart({
    id: "chart-time", xs: months, series, xTicks, markers, yStep: 50, height: 300,
    xLabel: (mo) => mo.slice(0, 4), refLines: [{ v: 100, label: "Moderate from 101" }, { v: 200, label: "Poor from 201" }].filter((r) => r.v < Math.max(...series.flatMap((x) => x.values.filter((v) => v != null))) * 1.06),
    tipTitle: (mo) => `${MONTHS[+mo.slice(5) - 1]} ${mo.slice(0, 4)} · ${INDEX_NAME[key]}`, valueFmt: (v) => fmt(v, 0),
  });
  legend("legend-time", series.map((se) => [se.label, se.color]), "line");
}

function renderDiwali() {
  const city = state.diwaliCity;
  const years = [...new Set(D.diwali.map((r) => r.year))].sort();
  const days = range(-10, 10, 1);
  const colors = ["var(--s1)", "var(--s2)", "var(--s3)", "var(--s4)"];
  const series = years.map((y, k) => {
    const m = new Map(D.diwali.filter((r) => r.year === y && r.city === city).map((r) => [r.day, r.pm25]));
    const date = D.diwali.find((r) => r.year === y).diwali_date;
    return { label: String(y), date, values: days.map((d) => m.get(d) ?? null), color: colors[k % colors.length] };
  });
  lineChart({
    id: "chart-diwali", xs: days, series, xTicks: [0, 3, 7, 10, 13, 17, 20], yStep: city === ALL ? 20 : 25, height: 300,
    xLabel: (d) => (d === 0 ? "Diwali" : d > 0 ? `+${d}` : String(d)), markers: [{ i: 10, label: "" }],
    tipTitle: (d) => (d === 0 ? "Diwali day" : `${Math.abs(d)} day${Math.abs(d) === 1 ? "" : "s"} ${d < 0 ? "before" : "after"}`) + ` · ${city}`,
    valueFmt: (v) => (v == null ? "–" : `${fmt(v, 1)} µg/m³`),
  });
  legend("legend-diwali", series.map((se) => [`${se.label} (${new Date(se.date + "T00:00:00").toLocaleDateString("en-IN", { day: "numeric", month: "short" })})`, se.color]), "line");
  const sum = D.diwali_summary.filter((r) => r.city === city);
  const higher = sum.filter((r) => r.diwali_day > r.week_before).length;
  const el = $("#finding-diwali");
  el.textContent = "";
  const b = document.createElement("b");
  b.textContent = `${city}: Diwali-day PM2.5 was above the week before in ${higher} of ${sum.length} years. `;
  el.appendChild(b);
  el.appendChild(document.createTextNode(sum.map((r) =>
    `${r.year}: week before ${fmt(r.week_before, 0)} → Diwali ${fmt(r.diwali_day, 0)} → next two days ${fmt(r.two_days_after, 0)}`).join(" · ") +
    ". Modelled values: the CAMS model may not capture a one-night fireworks spike."));
}

function renderRain() {
  const rows = D.rain.filter((r) => r.scope === state.rainScope).sort((a, b) => a.bucket - b.bucket);
  const height = 260, m = { l: 40, r: 10, t: 16, b: 36 };
  const { svg, width } = svgFor("chart-rain", height);
  const yMax = niceMax(Math.max(...rows.map((r) => r.mean_pm25)), 10);
  const ys = (v) => height - m.b - (v / yMax) * (height - m.t - m.b);
  yAxis(svg, m.l, width - m.r, ys, range(0, yMax, 10));
  const slot = (width - m.l - m.r) / rows.length, bw = Math.min(56, slot * 0.6);
  rows.forEach((r, i) => {
    const x = m.l + i * slot + (slot - bw) / 2;
    s("path", { d: vbar(x, ys(0), bw, ys(0) - ys(r.mean_pm25)), class: "grow-y", style: `fill:var(--s1);transition-delay:${i * 60}ms` }, svg);
    if (i === 0 || i === rows.length - 1) text(svg, x + bw / 2, ys(r.mean_pm25) - 6, fmt(r.mean_pm25, 1), { "text-anchor": "middle", class: "val" });
    const lab = RAIN_BUCKETS[r.bucket];
    text(svg, x + bw / 2, height - m.b + 15, lab.split(" (")[0], { "text-anchor": "middle" });
    const hit = s("rect", { x: m.l + i * slot, y: m.t, width: slot, height: height - m.t - m.b, class: "hit" }, svg);
    hit.addEventListener("pointermove", (e) => showTip(e, `Rain: ${lab}`, [["Mean PM2.5", `${fmt(r.mean_pm25, 1)} µg/m³`], ["City-days", fmt(r.days)]]));
    hit.addEventListener("pointerleave", hideTip);
  });
  text(svg, m.l, height - 4, "Rainfall that day (IST)", {});
  const dry = rows[0], wet = rows[rows.length - 1];
  const el = $("#finding-rain"); el.textContent = "";
  const b = document.createElement("b");
  b.textContent = `${fmt(wet.mean_pm25, 1)} µg/m³ on days with 30 mm+ of rain vs ${fmt(dry.mean_pm25, 1)} on dry days (${pct(1 - wet.mean_pm25 / dry.mean_pm25, 0)} lower). `;
  el.appendChild(b);
  el.appendChild(document.createTextNode(state.rainScope === "all"
    ? "Rain falls mostly in the monsoon, when PM is low anyway; switch to “Monsoon only” to compare within the season."
    : "Within the monsoon alone the drop is smaller but still steady, so it is not only a seasonal effect."));
  animateIn(svg);
}

function renderHour() {
  const city = state.hourCity;
  const rows = D.hourly_profile.filter((r) => r.city === city).sort((a, b) => a.hour - b.hour);
  const hours = rows.map((r) => r.hour);
  const series = [
    { label: "PM2.5", values: rows.map((r) => r.pm25), color: "var(--s1)" },
    { label: "Ozone", values: rows.map((r) => r.o3), color: "var(--s2)" },
  ];
  lineChart({ id: "chart-hour", xs: hours, series, xTicks: [0, 6, 12, 18, 23], yStep: 20, height: 260,
    xLabel: (h) => `${String(h).padStart(2, "0")}:00`, tipTitle: (h) => `${String(h).padStart(2, "0")}:00 IST · ${city}`,
    valueFmt: (v) => `${fmt(v, 1)} µg/m³` });
  legend("legend-hour", series.map((se) => [se.label, se.color]), "line");
  const peak = (k, dir) => rows.reduce((a, r) => ((dir > 0 ? r[k] > a[k] : r[k] < a[k]) ? r : a));
  const hh = (r) => `${String(r.hour).padStart(2, "0")}:00`;
  const el = $("#finding-hour"); el.textContent = "";
  const b = document.createElement("b");
  b.textContent = `${city}: PM2.5 peaks at ${hh(peak("pm25", 1))} and is lowest at ${hh(peak("pm25", -1))}; ozone peaks at ${hh(peak("o3", 1))}. `;
  el.appendChild(b);
  const pmPeak = peak("pm25", 1).hour, nightPeak = pmPeak >= 18 || pmPeak <= 6;
  el.appendChild(document.createTextNode("Ozone forms in sunlight, so it peaks around midday. " + (nightPeak
    ? "PM2.5 peaking in the evening fits pollution building up when the air near the ground mixes less."
    : `Here PM2.5 peaks at ${hh(peak("pm25", 1))}, not in the evening as in most of the other cities.`)));
}

function hexToRgb(h) { h = h.replace("#", ""); return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)); }
function mix(a, b, t) { const A = hexToRgb(a), B = hexToRgb(b); return `rgb(${A.map((v, i) => Math.round(v + (B[i] - v) * t)).join(",")})`; }

function renderSeason() {
  const order = cityOrder();
  const val = new Map(D.season.map((r) => [`${r.city}|${r.month}`, r.aqi_pm]));
  const vals = D.season.map((r) => r.aqi_pm), lo = Math.min(...vals), hi = Math.max(...vals);
  const rowH = 20, m = { l: 92, r: 8, t: 20, b: 34 };
  const height = m.t + m.b + order.length * rowH;
  const { svg, width } = svgFor("chart-season", height);
  const cw = (width - m.l - m.r) / 12;
  const seqLo = cssVar("--seq-lo"), seqHi = cssVar("--seq-hi");
  MONTHS.forEach((mo, j) => text(svg, m.l + j * cw + cw / 2, m.t - 7, mo, { "text-anchor": "middle" }));
  order.forEach((city, i) => {
    const y = m.t + i * rowH;
    text(svg, m.l - 8, y + rowH / 2 + 4, city, { "text-anchor": "end", class: "lbl" });
    for (let j = 0; j < 12; j++) {
      const v = val.get(`${city}|${j + 1}`);
      const cell = s("rect", { x: m.l + j * cw + 1, y: y + 1, width: cw - 2, height: rowH - 2, rx: 3,
        class: "fade", style: `fill:${mix(seqLo, seqHi, (v - lo) / (hi - lo))};transition-delay:${(i + j) * 18}ms` }, svg);
      cell.addEventListener("pointermove", (e) => showTip(e, `${city} · ${MONTHS[j]}`, [["Mean PM index", fmt(v, 0)]]));
      cell.addEventListener("pointerleave", hideTip);
    }
  });
  // gradient legend
  const gid = "seq-grad";
  const defs = s("defs", {}, svg), lg = s("linearGradient", { id: gid }, defs);
  s("stop", { offset: "0", "stop-color": seqLo }, lg); s("stop", { offset: "1", "stop-color": seqHi }, lg);
  const ly = height - 18, lw = Math.min(200, width - m.l - 80);
  s("rect", { x: m.l, y: ly, width: lw, height: 8, rx: 4, fill: `url(#${gid})` }, svg);
  text(svg, m.l - 6, ly + 8, fmt(lo), { "text-anchor": "end" });
  text(svg, m.l + lw + 6, ly + 8, `${fmt(hi)} (mean PM index)`);
  animateIn(svg);
}

// ---------- tables (the accessible view of every chart) ----------
const TABLES = {
  rank: () => [["City", "PM index", "Full AQI", "PM2.5 µg/m³", "Days PM Poor+", "Days O₃ sets AQI"],
    D.cities.map((r) => [r.city, fmt(r.mean_aqi_pm, 1), fmt(r.mean_aqi, 1), fmt(r.mean_pm25, 1), pct(r.share_pm_poor, 1), pct(r.share_o3_dominant, 0)])],
  cats: () => {
    const by = {}; for (const r of D.categories) (by[r.city] ||= {})[r.category] = r.days;
    return [["City", ...CATS], cityOrder().map((c) => [c, ...CATS.map((k) => fmt(by[c][k] || 0))])];
  },
  time: () => [["Month", "City", "PM index", "Full AQI", "PM2.5", "Days"],
    D.monthly.filter((r) => r.city === state.timeCity || r.city === ALL).map((r) => [r.month, r.city, fmt(r.aqi_pm, 0), fmt(r.aqi, 0), fmt(r.pm25, 1), r.days])],
  diwali: () => [["Year", "City", "Week before", "Diwali day", "Next two days"],
    D.diwali_summary.filter((r) => r.city === state.diwaliCity).map((r) => [r.year, r.city, fmt(r.week_before, 1), fmt(r.diwali_day, 1), fmt(r.two_days_after, 1)])],
  rain: () => [["Rain that day", "Days", "Mean PM2.5 µg/m³", "Scope"],
    D.rain.filter((r) => r.scope === state.rainScope).map((r) => [RAIN_BUCKETS[r.bucket], fmt(r.days), fmt(r.mean_pm25, 1), r.scope])],
  hour: () => [["Hour (IST)", "PM2.5", "Ozone"],
    D.hourly_profile.filter((r) => r.city === state.hourCity).map((r) => [`${String(r.hour).padStart(2, "0")}:00`, fmt(r.pm25, 1), fmt(r.o3, 1)])],
  season: () => [["City", ...MONTHS], cityOrder().map((c) => [c, ...MONTHS.map((_, j) => fmt(D.season.find((r) => r.city === c && r.month === j + 1)?.aqi_pm, 0))])],
};
function renderTable(key) {
  const host = document.getElementById(`table-${key}`);
  host.textContent = "";
  if (openTables.has(key)) host.appendChild(buildTable(...TABLES[key]()));
}
function buildTable(head, body) {
  const wrap = document.createElement("div"); wrap.className = "table-wrap";
  const t = document.createElement("table"), tr = document.createElement("tr");
  for (const h of head) { const th = document.createElement("th"); th.textContent = h; tr.appendChild(th); }
  const thead = document.createElement("thead"); thead.appendChild(tr); t.appendChild(thead);
  const tb = document.createElement("tbody");
  for (const row of body) { const r = document.createElement("tr"); for (const c of row) { const td = document.createElement("td"); td.textContent = c; r.appendChild(td); } tb.appendChild(r); }
  t.appendChild(tb); wrap.appendChild(t);
  return wrap;
}

// ---------- header, KPIs ----------
function renderHeader() {
  const f = D.freshness, t = D.totals;
  const through = new Date(new Date(f.newest_hour_utc).getTime() + 3600e3);
  const ageH = (Date.now() - through.getTime()) / 3600e3;
  const [cls, label] = ageH <= 48 ? ["good", "Fresh"] : ageH <= 96 ? ["warning", "Late"] : ["critical", "Stale"];
  const icon = { good: "M4 8.5l2.5 2.5L12 5.5", warning: "M8 4.5v4M8 11h.01", critical: "M5 5l6 6M11 5l-6 6" }[cls];
  const pill = $("#freshness");
  pill.innerHTML = `<svg class="status-icon" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="7.5" fill="var(--${cls})"/><path d="${icon}" stroke="#fff" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  const txt = document.createElement("span");
  const when = through.toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  txt.innerHTML = `<b>${label}</b> · data through ${when} IST · ${fmt(Math.max(0, ageH), 0)} h ago`;
  pill.appendChild(txt);
  $("#kpi-hours-sub").textContent = `${f.cities} cities, from ${new Date(f.first_date_ist).toLocaleDateString("en-IN", { month: "short", year: "numeric" })}`;
  $("#kpi-poor-sub").textContent = `${pct(t.pm_poor_or_worse_days / t.city_days, 1)} of city-days`;
  $("#kpi-o3-sub").textContent = `${fmt(t.o3_dominant_days)} of ${fmt(t.city_days)} city-days`;
  $("#generated").textContent = `Data exported ${new Date(D.generated_at).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })} IST by the daily pipeline.`;
}
function countUp() {
  const targets = { ...D.freshness, ...D.totals, o3_share: (D.totals.o3_dominant_days / D.totals.city_days) * 100 };
  document.querySelectorAll("[data-count]").forEach((el) => {
    const end = targets[el.dataset.count], dec = el.dataset.count === "o3_share" ? 1 : 0, suf = el.dataset.suffix || "";
    if (REDUCED) { el.textContent = fmt(end, dec) + suf; return; }
    const t0 = performance.now(), dur = 1300;
    const step = (now) => {
      const p = Math.min(1, (now - t0) / dur), e = 1 - Math.pow(1 - p, 3);
      el.textContent = fmt(end * e, dec) + suf;
      if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
}

// ---------- controls ----------
function fillSelect(id, value, onChange) {
  const sel = document.getElementById(id);
  for (const c of [ALL, ...cityOrder().slice().sort()]) { const o = document.createElement("option"); o.value = o.textContent = c; sel.appendChild(o); }
  sel.value = value;
  sel.addEventListener("change", () => onChange(sel.value));
}
function segmented(name, onChange) {
  const grp = document.querySelector(`[data-ctl="${name}"]`);
  grp.addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    grp.querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    onChange(b.dataset.v);
  });
}

const RENDER = { rank: renderRank, cats: renderCats, time: renderTime, diwali: renderDiwali, rain: renderRain, hour: renderHour, season: renderSeason };
function rerender(key) { RENDER[key](); renderTable(key); }
function renderAll() { for (const k of Object.keys(RENDER)) rerender(k); }

function wire() {
  segmented("rank-index", (v) => { state.rankIndex = v; rerender("rank"); });
  segmented("time-index", (v) => { state.timeIndex = v; rerender("time"); });
  segmented("rain-scope", (v) => { state.rainScope = v; rerender("rain"); });
  fillSelect("time-city", state.timeCity, (v) => { state.timeCity = v; rerender("time"); });
  fillSelect("diwali-city", state.diwaliCity, (v) => { state.diwaliCity = v; rerender("diwali"); });
  fillSelect("hour-city", state.hourCity, (v) => { state.hourCity = v; rerender("hour"); });
  document.querySelectorAll(".table-toggle").forEach((b) => b.addEventListener("click", () => {
    const k = b.dataset.table;
    openTables.has(k) ? openTables.delete(k) : openTables.add(k);
    b.textContent = openTables.has(k) ? "Hide table" : "Show table";
    renderTable(k);
  }));
  let timer;
  window.addEventListener("resize", () => { clearTimeout(timer); timer = setTimeout(() => TAB_RENDER[currentTab](), 150); });
}

// ---------- tabs ----------
// tabs.js registers the City and Pipeline renderers. Charts measure their container, so a tab draws only when shown.
const TAB_RENDER = { overview: renderAll };
let currentTab = "overview";
function showTab(name, focus = false) {
  if (!TAB_RENDER[name]) name = "overview";
  currentTab = name;
  document.querySelectorAll('[role="tab"]').forEach((t) => {
    const on = t.dataset.tab === name;
    t.setAttribute("aria-selected", String(on));
    t.tabIndex = on ? 0 : -1;
    document.getElementById(t.getAttribute("aria-controls")).hidden = !on;
    if (on && focus) t.focus();
  });
  setParam("tab", name === "overview" ? null : name);
  hideTip();
  if (D) TAB_RENDER[name]();
}
function setParam(key, value) {
  const q = new URLSearchParams(location.search);
  value == null ? q.delete(key) : q.set(key, value);
  const qs = q.toString();
  history.replaceState(null, "", `${location.pathname}${qs ? `?${qs}` : ""}${location.hash}`);
}
const tablist = $('[role="tablist"]');
tablist.addEventListener("click", (e) => { const t = e.target.closest('[role="tab"]'); if (t) showTab(t.dataset.tab); });
tablist.addEventListener("keydown", (e) => {
  const tabs = [...tablist.querySelectorAll('[role="tab"]')], i = tabs.findIndex((t) => t.dataset.tab === currentTab);
  const j = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: tabs.length - 1 }[e.key];
  if (j == null) return;
  e.preventDefault();
  showTab(tabs[(j + tabs.length) % tabs.length].dataset.tab, true);
});

// ---------- theme ----------
function currentTheme() {
  const set = document.documentElement.dataset.theme;
  return set || (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
}
function syncThemeButton() { $("#theme-toggle").setAttribute("aria-checked", String(currentTheme() === "dark")); }
$("#theme-toggle").addEventListener("click", () => {
  const next = currentTheme() === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem("theme", next); } catch (e) {}
  syncThemeButton();
  if (D && currentTab === "overview") renderSeason(); // the heatmap interpolates colours in JS; everything else follows CSS variables
});
syncThemeButton();

// ---------- reveal on scroll ----------
const io = "IntersectionObserver" in window ? new IntersectionObserver((entries) => {
  for (const e of entries) if (e.isIntersecting) { e.target.classList.add("shown"); io.unobserve(e.target); }
}, { threshold: 0.08 }) : null;
document.querySelectorAll(".reveal").forEach((el) => (io ? io.observe(el) : el.classList.add("shown")));

// ---------- boot ----------
fetch("data/dashboard.json", { cache: "no-cache" })
  .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
  .then((data) => {
    D = data;
    renderHeader(); countUp(); wire();
    showTab(new URLSearchParams(location.search).get("tab") || "overview");
    document.dispatchEvent(new Event("dashboard:ready"));
  })
  .catch((err) => { $("#freshness").textContent = `Could not load data (${err.message})`; });
