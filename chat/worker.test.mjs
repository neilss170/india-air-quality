// The Worker with Gemini and the data URL stubbed: the lookup loop, the origin check and model fallback.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import worker from "./worker.js";

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
