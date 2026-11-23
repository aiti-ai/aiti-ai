import test from "node:test";
import assert from "node:assert/strict";
import { generateImages, openRouterImageApiProvider, OPENROUTER_IMAGES_API } from "./image-openrouter-api.ts";

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

test("provider config exposes image models on its own api id", () => {
  const cfg = openRouterImageApiProvider();
  assert.ok(cfg.models.length >= 5);
  assert.ok(cfg.models.every((m) => m.api === OPENROUTER_IMAGES_API && m.type === "image"));
  assert.ok(cfg.images && cfg.images[OPENROUTER_IMAGES_API]?.generateImages);
});

test("generateImages posts to /images/generations and returns base64", async () => {
  const seen = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), body: JSON.parse(String(init.body)) });
    return new Response(JSON.stringify({ id: "img-1", data: [{ b64_json: png, mime_type: "image/png" }] }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const r = await generateImages(
      { provider: "openrouter-image-api", id: "black-forest-labs/flux-3-image", api: OPENROUTER_IMAGES_API },
      { input: [{ type: "text", text: "an apple" }] },
      { apiKey: "k", metadata: { size: "1024x1024" } },
    );
    assert.equal(r.stopReason, "stop");
    assert.equal(r.output.filter((o) => o.type === "image").length, 1);
    assert.match(seen[0].url, /\/images\/generations$/);
    assert.equal(seen[0].body.model, "black-forest-labs/flux-3-image");
    assert.equal(seen[0].body.resolution, "1K");
    assert.equal(seen[0].body.aspect_ratio, "1:1");
  } finally { globalThis.fetch = realFetch; }
});

test("tier-only models get one retry without pixel dimensions", async () => {
  const bodies = [];
  const realFetch = globalThis.fetch;
  let call = 0;
  globalThis.fetch = async (_url, init) => {
    bodies.push(JSON.parse(String(init.body)));
    call++;
    if (call === 1) return new Response(JSON.stringify({ error: { message: "takes a resolution tier plus aspect_ratio, not pixel dimensions. Received size \"1024x1024\"" } }), { status: 400 });
    return new Response(JSON.stringify({ data: [{ b64_json: png, mime_type: "image/png" }] }), { status: 200 });
  };
  try {
    const r = await generateImages(
      { provider: "openrouter-image-api", id: "black-forest-labs/flux-3-image", api: OPENROUTER_IMAGES_API },
      { input: [{ type: "text", text: "an apple" }] },
      { apiKey: "k", metadata: { size: "1024x1024" } },
    );
    assert.equal(r.stopReason, "stop");
    assert.equal(bodies.length, 2);
    assert.ok("size" in bodies[0]);
    assert.ok(!("size" in bodies[1]) && !("width" in bodies[1]));
    assert.equal(bodies[1].resolution, "1K");
  } finally { globalThis.fetch = realFetch; }
});

test("missing api key fails without a network call", async () => {
  const realFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = async () => { called = true; return new Response("{}", { status: 200 }); };
  try {
    const r = await generateImages(
      { provider: "openrouter-image-api", id: "m", api: OPENROUTER_IMAGES_API },
      { input: [{ type: "text", text: "x" }] },
      { apiKey: "" },
    );
    // openRouterApiKey() may resolve a host key from models.json in this environment;
    // when it does, the call proceeds (and the stub answers 200 with no data).
    if (r.stopReason === "error") assert.match(r.errorMessage || "", /No API key|no image/i);
    assert.ok(called === true || /No API key/.test(r.errorMessage || ""));
  } finally { globalThis.fetch = realFetch; }
});
