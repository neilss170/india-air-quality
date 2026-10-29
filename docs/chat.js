// "Ask the data": a chat panel that sends questions to the Cloudflare Worker in chat/, which answers with Gemini
// using lookups over this page's own dashboard.json. Shown only when an endpoint is configured.
"use strict";

(() => {
  const params = new URLSearchParams(location.search);
  const endpoint = params.get("chat") || document.querySelector('meta[name="chat-endpoint"]')?.content;
  if (!endpoint) return;

  const SUGGESTIONS = [
    "Which city had the worst air on the latest day?",
    "What were Delhi's worst days?",
    "Does rain clean the air?",
    "How far off is the model in Kanpur?",
    "Did the pipeline run today?",
  ];
  // how each lookup is described under an answer
  const LOOKUP = {
    overview: "city averages", latest_day: "latest day", daily_pm_index: "daily PM index", day_all_cities: "all cities on a day",
    monthly: "monthly means", worst_days: "worst days", category_mix: "category mix", seasonal_pattern: "seasons",
    daily_cycle: "daily cycle", diwali: "Diwali", rain_effect: "rain", model_vs_stations: "model vs stations",
    pipeline_status: "pipeline",
  };
  const history = [];
  let busy = false, session = 0;  // session changes on Clear, so a reply still on its way is dropped

  const make = (tag, cls, txt) => { const n = document.createElement(tag); if (cls) n.className = cls; if (txt != null) n.textContent = txt; return n; };

  const fab = make("button", "chat-fab glass");
  fab.type = "button";
  fab.setAttribute("aria-expanded", "false");
  fab.setAttribute("aria-controls", "chat-panel");
  fab.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16v11H9l-5 4z"/></svg><span>Ask the data</span>';

  const panel = make("section", "chat-panel glass");
  panel.id = "chat-panel";
  panel.hidden = true;
  panel.setAttribute("aria-label", "Ask the data");
  panel.innerHTML = `
    <div class="chat-head">
      <div><b>Ask the data</b><p>Answers by Gemini from this dashboard's data. It can still make mistakes, so check the charts.</p></div>
      <button class="btn chat-clear" type="button" hidden>Clear</button>
      <button class="chat-close" type="button" aria-label="Close chat">×</button>
    </div>
    <div class="chat-log" role="log" aria-live="polite"></div>
    <form class="chat-form">
      <input type="text" name="q" maxlength="500" autocomplete="off" placeholder="e.g. Delhi in November 2025" aria-label="Your question">
      <button class="btn chat-send" type="submit">Ask</button>
    </form>`;
  document.body.append(fab, panel);

  const log = panel.querySelector(".chat-log"), form = panel.querySelector("form"), input = form.q, send = form.querySelector("button");
  const clear = panel.querySelector(".chat-clear");

  const chips = make("div", "chat-chips");
  for (const q of SUGGESTIONS) {
    const b = make("button", "chip", q);
    b.type = "button";
    b.addEventListener("click", () => ask(q));
    chips.appendChild(b);
  }
  log.appendChild(chips);

  // the model's answer as text: **bold** and "- " lists, nothing else is interpreted
  function render(text) {
    const box = make("div", "chat-text");
    let list = null;
    for (const line of text.split("\n")) {
      const item = line.match(/^\s*[-*•]\s+(.*)/);
      if (!line.trim()) { list = null; continue; }
      const target = item ? (list ??= box.appendChild(make("ul"))).appendChild(make("li")) : (list = null, box.appendChild(make("p")));
      (item ? item[1] : line).split(/(\*\*[^*]+\*\*)/).forEach((bit) => {
        if (!bit) return;
        target.appendChild(bit.startsWith("**") && bit.endsWith("**") ? make("b", null, bit.slice(2, -2)) : document.createTextNode(bit));
      });
    }
    return box;
  }

  function bubble(role, text, lookups, checked) {
    const m = make("div", `chat-msg ${role}`);
    m.appendChild(role === "user" ? make("p", null, text) : render(text));
    if (lookups?.length) {
      const seen = [...new Set(lookups.map((l) => LOOKUP[l.name] + (l.args?.city ? ` (${l.args.city})` : "")))];
      // the Worker checked every number in the answer against these lookups' results
      m.appendChild(make("div", "chat-src", `Looked up: ${seen.join(" · ")}${checked ? " · numbers checked against the data" : ""}`));
    }
    log.appendChild(m);
    log.scrollTop = log.scrollHeight;
    return m;
  }

  async function ask(q) {
    q = q.trim();
    if (!q || busy) return;
    busy = true; send.disabled = true; chips.remove(); clear.hidden = false;
    const mine = session;
    bubble("user", q);
    history.push({ role: "user", text: q });
    const wait = bubble("bot thinking", "Looking it up…");
    let reply;
    try {
      const r = await fetch(endpoint.replace(/\/$/, "") + "/chat", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ messages: history.slice(-8) }),
      });
      const body = await r.json().catch(() => ({}));
      reply = r.ok ? body : { error: r.status === 429 ? "busy" : "down" };
    } catch (e) {
      reply = { error: "down" };
    }
    if (mine !== session) return;  // cleared while waiting
    wait.remove();
    if (reply.answer) {
      bubble("bot", reply.answer, reply.lookups, reply.checked);
      history.push({ role: "model", text: reply.answer });
    } else {
      history.pop();
      bubble("bot error", reply.error === "busy"
        ? "Too many questions right now (the free AI tier has a rate limit). Please try again in a minute."
        : "The assistant couldn't answer just now. Please try again later; the charts have everything it would look up.");
    }
    busy = false; send.disabled = false; input.focus();
  }

  function toggle(open) {
    panel.hidden = !open;
    fab.setAttribute("aria-expanded", String(open));
    fab.classList.toggle("open", open);
    if (open) input.focus(); else fab.focus();
  }

  // start over: forget the conversation and show the suggestions again
  clear.addEventListener("click", () => {
    session++;
    history.length = 0;
    log.textContent = "";
    log.appendChild(chips);
    busy = false; send.disabled = false; clear.hidden = true;
    input.value = "";
    input.focus();
  });

  fab.addEventListener("click", () => toggle(panel.hidden));
  panel.querySelector(".chat-close").addEventListener("click", () => toggle(false));
  panel.addEventListener("keydown", (e) => { if (e.key === "Escape") toggle(false); });
  form.addEventListener("submit", (e) => { e.preventDefault(); const q = input.value; input.value = ""; ask(q); });
})();
