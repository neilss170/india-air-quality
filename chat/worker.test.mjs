// The Worker with Gemini and the data URL stubbed: the lookup loop, the origin check and model fallback.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import worker, { unverified } from "./worker.js";

const DATA = readFileSync(new URL("../docs/data/dashboard.json", import.meta.url), "utf8");
const env = { DATA_URL: "https://example.test/dashboard.json", ALLOWED_ORIGINS: "https://neilss170.github.io",
  MODELS: "model-a,model-b", GEMINI_API_KEY: "test" };
let gemini;  // replies queued per test: [status, body]
let sent;    // request bodies the Worker sent to Gemini, with the model they went to

beforeEach(() => {
  sent = [];
  globalThis.fetch = async (url, init) => {
    if (url === env.DATA_URL) return new Response(DATA);
    sent.push({ model: url.match(/models\/([^:]+)/)[1], body: JSON.parse(init.body) });
    const [status, body] = gemini.shift();
    return new Response(JSON.stringify(body), { status });
  };
});

const ask = (q, origin = "https://neilss170.github.io") => worker.fetch(new Request("https://w.test/chat", {
  method: "POST", headers: { origin, "content-type": "application/json" },
  body: JSON.stringify({ messages: [{ role: "user", text: q }] }) }), env);
const call = (name, args) => [200, { candidates: [{ content: { role: "model", parts: [{ functionCall: { name, args } }] } }] }];
const say = (text) => [200, { candidates: [{ content: { role: "model", parts: [{ text }] } }] }];

test("runs the lookup the model asks for and returns its answer", async () => {
  gemini = [call("worst_days", { city: "Delhi" }), say("Delhi's worst day was ...")];
  const r = await ask("Delhi's worst day?");
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.answer, "Delhi's worst day was ...");
  assert.deepEqual(body.lookups, [{ name: "worst_days", args: { city: "Delhi" } }]);
  const result = sent[1].body.contents.at(-1).parts[0].functionResponse.response.result;
  assert.equal(result.rows.length, 10);
  assert.equal(result.rows[0].city, "Delhi");
});

test("falls back to the next model when one is rate-limited", async () => {
  gemini = [[429, { error: "quota" }], say("ok")];
  const body = await (await ask("hi")).json();
  assert.deepEqual(sent.map((s) => s.model), ["model-a", "model-b"]);
  assert.equal(body.model, "model-b");
});

test("says busy when every model is rate-limited", async () => {
  gemini = [[429, {}], [429, {}]];
  assert.equal((await ask("hi")).status, 429);
});

test("refuses other origins and empty questions", async () => {
  gemini = [];
  assert.equal((await ask("hi", "https://evil.test")).status, 403);
  assert.equal((await ask("   ")).status, 400);
});

test("moves on when a model times out", async () => {
  gemini = [["timeout"], say("ok")];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (url !== env.DATA_URL && gemini[0][0] === "timeout") { gemini.shift(); sent.push({ model: "timed-out" }); throw new DOMException("t", "TimeoutError"); }
    return real(url, init);
  };
  const body = await (await ask("hi")).json();
  assert.equal(body.answer, "ok");
  assert.equal(body.model, "model-b");
});

test("unverified: numbers must match a source at the precision written", () => {
  const src = ['{"mean_pm25":18.69,"days":11587,"date_ist":"2026-10-27"}'];
  assert.deepEqual(unverified("18.7 µg/m³ over 11,587 days on 2026-10-27 (27 October 2026)", src), []);
  assert.deepEqual(unverified("18.6 µg/m³, PM2.5 and PM10 under 49R1", src), ["18.6"]);
  assert.deepEqual(unverified("Delhi's PM index was 252", src), ["252"]);
});

test("an answer with a made-up number gets one retry, then a refusal", async () => {
  gemini = [say("Delhi's PM index was 252."), call("latest_day", { city: "Delhi" }), say("It was 184.")];
  let body = await (await ask("Delhi today?")).json();
  assert.equal(body.answer, "It was 184.");
  assert.equal(body.rechecked, true);
  assert.equal(body.checked, true);
  assert.match(sent[1].body.contents.at(-1).parts[0].text, /252/);

  gemini = [say("It was 252."), say("Still 252.")];
  body = await (await ask("Delhi today?")).json();
  assert.equal(body.checked, false);
  assert.match(body.answer, /couldn't check every number/);
});
