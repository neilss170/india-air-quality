// Guided tour: a spotlight on one part of the page at a time, with a popover that explains it.
// Start with the header button, or open the page with ?tour (or ?tour=N to start at step N).
// The page stays interactive during the tour, so the controls each step mentions can be tried.
"use strict";

(() => {
  const STEPS = [
    { sel: "#freshness", title: "How fresh is the data?",
      body: "Green means the newest hour is less than 48 hours old. The pipeline loads, tests and republishes everything every morning, around 08:15 IST." },
    { sel: ".tabs", title: "Three views",
      body: "This tour covers Overview. City shows one city's latest day, every day since 2022 and its worst days. Pipeline shows how the daily job runs: recent runs, the dbt tests and the warehouse tables." },
    { sel: "#panel-overview .kpis", title: "Headline numbers",
      body: "Counted in the warehouse on every run: hours of data, complete city-days, how many were “Poor” or worse, and how often ozone sets the full AQI." },
    { sel: ".note", title: "Why two indices",
      body: "Modelled ozone sets the official-formula AQI on most days, even in clean coastal cities. So the charts lead with the PM index: the same CPCB formula on PM2.5 and PM10 only." },
    { sel: "#card-rank", title: "Which cities are worst",
      body: "Cities ranked by their average daily index. Switch between the PM index and the full AQI with the toggle; hover a bar for the details." },
    { sel: "#card-cats", title: "How often the air is bad",
      body: "The share of days each city spends in each CPCB category, from Good to Severe." },
    { sel: "#card-time", title: "Month by month",
      body: "Pick any city to compare it with the 15-city average over time. Hover the chart to read off a month. The dashed lines are upgrades to the source model, so compare years across them with care." },
    { sel: "#card-diwali", title: "Does Diwali show up?",
      body: "PM2.5 for the ten days either side of each Diwali. The sentence above the chart is written from the data, including when there is no spike." },
    { sel: "#card-rain", title: "Rain and PM2.5",
      body: "Average PM2.5 by how much it rained that day. Switch to “Monsoon only” to compare days within the rainy season." },
    { sel: "#card-hour", title: "The daily cycle",
      body: "Average concentration for each hour of the day (IST). Ozone peaks in daylight; in most cities PM2.5 peaks in the evening." },
    { sel: "#card-season", title: "The seasons",
      body: "The average PM index for every city and calendar month. Hover a cell for its value." },
    { sel: "footer", title: "Tables, sources and method",
      body: "Every chart has a “Show table” button. The data sources, the AQI method and the dbt documentation are linked here." },
  ];
  const PAD = 8;
  const reduced = () => document.documentElement.classList.contains("no-motion") ||
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  let i = -1, spot, pop, lastFocus;

  function build() {
    spot = document.createElement("div");
    spot.className = "tour-spot";
    spot.setAttribute("aria-hidden", "true");
    pop = document.createElement("div");
    pop.className = "tour-pop";
    pop.setAttribute("role", "dialog");
    pop.setAttribute("aria-labelledby", "tour-title");
    pop.innerHTML = `
      <div class="tour-count" id="tour-count"></div>
      <h3 id="tour-title"></h3>
      <p id="tour-body"></p>
      <div class="tour-actions">
        <button class="btn" type="button" data-act="close">Close</button>
        <span class="tour-gap"></span>
        <button class="btn" type="button" data-act="back">Back</button>
        <button class="btn tour-next" type="button" data-act="next">Next</button>
      </div>`;
    pop.addEventListener("click", (e) => {
      const act = e.target.closest("button")?.dataset.act;
      if (act === "close") end();
      if (act === "back") go(i - 1);
      if (act === "next") (i === STEPS.length - 1 ? end() : go(i + 1));
    });
    document.body.append(spot, pop);
  }

  function place() {
    if (i < 0) return;
    const target = document.querySelector(STEPS[i].sel);
    if (!target) return;
    const r = target.getBoundingClientRect(), vw = window.innerWidth, vh = window.innerHeight;
    Object.assign(spot.style, { left: `${r.left - PAD}px`, top: `${r.top - PAD}px`,
      width: `${r.width + 2 * PAD}px`, height: `${r.height + 2 * PAD}px` });
    const pw = Math.min(360, vw - 32), gap = 14;
    pop.style.width = `${pw}px`;
    const ph = pop.offsetHeight;
    let top;
    if (r.bottom + gap + ph < vh - 8) top = r.bottom + gap;          // below the target
    else if (r.top - gap - ph > 8) top = r.top - gap - ph;            // above it
    else top = vh - ph - 16;                                          // target fills the screen: pin to the bottom
    const left = Math.max(16, Math.min(vw - pw - 16, r.left + r.width / 2 - pw / 2));
    Object.assign(pop.style, { left: `${left}px`, top: `${Math.max(8, top)}px` });
  }

  function go(n) {
    if (n < 0 || n >= STEPS.length) return;
    i = n;
    const step = STEPS[i], target = document.querySelector(step.sel);
    pop.querySelector("#tour-count").textContent = `${i + 1} of ${STEPS.length}`;
    pop.querySelector("#tour-title").textContent = step.title;
    pop.querySelector("#tour-body").textContent = step.body;
    pop.querySelector('[data-act="back"]').disabled = i === 0;
    pop.querySelector('[data-act="next"]').textContent = i === STEPS.length - 1 ? "Done" : "Next";
    // tall targets scroll to their top so the popover can sit below the fold line
    const tall = target.getBoundingClientRect().height > window.innerHeight * 0.6;
    target.scrollIntoView({ block: tall ? "start" : "center", behavior: reduced() ? "auto" : "smooth" });
    place();
    pop.querySelector(".tour-next").focus({ preventScroll: true });
  }

  function onKey(e) {
    if (e.key === "Escape") end();
    else if (e.key === "ArrowRight") (i === STEPS.length - 1 ? end() : go(i + 1));
    else if (e.key === "ArrowLeft") go(i - 1);
  }

  function start(n = 0) {
    if (!spot) build();
    if (currentTab !== "overview") showTab("overview"); // every step is on the Overview tab
    lastFocus = document.activeElement;
    document.documentElement.classList.add("touring");
    spot.classList.add("on"); pop.classList.add("on");
    window.addEventListener("scroll", place, { passive: true });
    window.addEventListener("resize", place);
    document.addEventListener("keydown", onKey);
    go(Math.max(0, Math.min(STEPS.length - 1, n)));
  }

  function end() {
    i = -1;
    document.documentElement.classList.remove("touring");
    spot.classList.remove("on"); pop.classList.remove("on");
    window.removeEventListener("scroll", place);
    window.removeEventListener("resize", place);
    document.removeEventListener("keydown", onKey);
    const back = lastFocus && lastFocus !== document.body ? lastFocus : document.getElementById("tour-start");
    back.focus({ preventScroll: true });
  }

  document.getElementById("tour-start").addEventListener("click", () => start(0));

  // ?tour or ?tour=N opens the tour once the charts are drawn
  const q = new URLSearchParams(location.search);
  if (q.has("tour")) {
    const n = (parseInt(q.get("tour"), 10) || 1) - 1;
    document.addEventListener("dashboard:ready", () => requestAnimationFrame(() => start(n)), { once: true });
  }
})();
