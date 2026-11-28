// Real-module tests for server/tts-local.ts: WAV container handling, format negotiation,
// error mapping and the single-flight limiter.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { transformSync } from "esbuild";

const src = readFileSync(new URL("../server/tts-local.ts", import.meta.url), "utf8");
const js = transformSync(src, { loader: "ts", format: "esm", target: "node20" }).code;
const mod = await import("data:text/javascript;base64," + Buffer.from(js).toString("base64"));

test("pcmToWav writes a canonical 44-byte mono/16-bit RIFF header", () => {
  const pcm = Buffer.alloc(200, 1);
  const wav = mod.pcmToWav(pcm, 24000);
  assert.equal(wav.length, 244);
  assert.equal(wav.toString("ascii", 0, 4), "RIFF");
  assert.equal(wav.readUInt32LE(4), 236);
  assert.equal(wav.toString("ascii", 8, 12), "WAVE");
  assert.equal(wav.readUInt16LE(20), 1);       // PCM
  assert.equal(wav.readUInt16LE(22), 1);       // mono
  assert.equal(wav.readUInt32LE(24), 24000);
  assert.equal(wav.readUInt32LE(28), 48000);   // byte rate
  assert.equal(wav.readUInt16LE(32), 2);       // block align
  assert.equal(wav.readUInt16LE(34), 16);      // bits
  assert.equal(wav.toString("ascii", 36, 40), "data");
  assert.equal(wav.readUInt32LE(40), 200);
});

test("fixWavHeader repairs placeholder sizes and ignores non-wav buffers", () => {
  const pcm = Buffer.alloc(100, 2);
  const wav = mod.pcmToWav(pcm, 24000);
  wav.writeUInt32LE(0xffffffff, 4);
  wav.writeUInt32LE(0, 40);
  const fixed = mod.fixWavHeader(wav);
  assert.equal(fixed.readUInt32LE(4), fixed.length - 8);
  assert.equal(fixed.readUInt32LE(40), 100);
  const mp3 = Buffer.from([0x49, 0x44, 0x33, 0, 0, 0]);
  assert.deepEqual(mod.fixWavHeader(mp3), mp3);
});

test("normalizeBaseUrl trims slashes and defaults to loopback:8768", () => {
  assert.equal(mod.normalizeBaseUrl(""), "http://127.0.0.1:8768");
  assert.equal(mod.normalizeBaseUrl("http://host:9000///"), "http://host:9000");
});

function stubFetch(handler) {
  const prev = globalThis.fetch;
  globalThis.fetch = async (url, init) => handler(String(url), init);
  return () => { globalThis.fetch = prev; };
}
const pcmBody = Buffer.alloc(96, 3);

test("synthesizeLocal wraps raw PCM into WAV", async () => {
  const restore = stubFetch(async () => new Response(pcmBody, { status: 200, headers: { "content-type": "audio/pcm" } }));
  try {
    const r = await mod.synthesizeLocal({ baseUrl: "http://127.0.0.1:8768", text: "你好", voice: "v1" });
    assert.equal(r.ext, ".wav");
    assert.equal(r.format, "wav");
    assert.equal(r.buf.toString("ascii", 0, 4), "RIFF");
    assert.equal(r.buf.length, pcmBody.length + 44);
  } finally { restore(); }
});

test("synthesizeLocal downgrades pcm -> wav when the service refuses the format", async () => {
  const seen = [];
  const restore = stubFetch(async (_url, init) => {
    const body = JSON.parse(init.body);
    seen.push(body.response_format);
    if (body.response_format === "pcm") {
      return new Response(JSON.stringify({ error: { message: "unsupported" } }), { status: 415, headers: { "content-type": "application/json" } });
    }
    const wav = mod.pcmToWav(Buffer.alloc(64, 4), 24000);
    return new Response(wav, { status: 200, headers: { "content-type": "audio/wav" } });
  });
  try {
    const r = await mod.synthesizeLocal({ baseUrl: "http://x", text: "hi", format: "pcm" });
    assert.deepEqual(seen, ["pcm", "wav"]);
    assert.equal(r.ext, ".wav");
    assert.equal(r.buf.readUInt32LE(40), 64);
  } finally { restore(); }
});

test("synthesizeLocal maps 503 to a retryable not-ready error", async () => {
  const restore = stubFetch(async () => new Response("{\"status\":\"loading\"}", { status: 503 }));
  try {
    await assert.rejects(
      () => mod.synthesizeLocal({ baseUrl: "http://x", text: "hi" }),
      (e) => e instanceof mod.LocalTtsError && e.code === "not-ready" && e.retryable === true && e.status === 503,
    );
  } finally { restore(); }
});

test("synthesizeLocal reports unknown voice (400) without retrying other formats", async () => {
  let calls = 0;
  const restore = stubFetch(async () => { calls++; return new Response("{\"error\":{\"message\":\"bad voice\"}}", { status: 400 }); });
  try {
    await assert.rejects(
      () => mod.synthesizeLocal({ baseUrl: "http://x", text: "hi", voice: "nope" }),
      (e) => e instanceof mod.LocalTtsError && e.code === "unknown-voice",
    );
    assert.equal(calls, 1);
  } finally { restore(); }
});

test("synthesizeLocal passes mp3 through untouched", async () => {
  const mp3 = Buffer.from([0x49, 0x44, 0x33, 0x04, 0x00]);
  const restore = stubFetch(async () => new Response(mp3, { status: 200, headers: { "content-type": "audio/mpeg" } }));
  try {
    const r = await mod.synthesizeLocal({ baseUrl: "http://x", text: "hi", format: "mp3" });
    assert.equal(r.ext, ".mp3");
    assert.deepEqual(r.buf, mp3);
  } finally { restore(); }
});

test("local requests are serialized (queue depth never exceeds one in flight)", async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const restore = stubFetch(async () => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight--;
    const wav = mod.pcmToWav(Buffer.alloc(32, 9), 24000);
    return new Response(wav, { status: 200, headers: { "content-type": "audio/wav" } });
  });
  try {
    await Promise.all(Array.from({ length: 5 }, (_, i) => mod.synthesizeLocal({ baseUrl: "http://x", text: "s" + i })));
    assert.equal(maxInFlight, 1);
    assert.equal(mod.localQueueDepth(), 0);
  } finally { restore(); }
});

test("probeLocal returns null when the service is down", async () => {
  const restore = stubFetch(async () => { throw new Error("ECONNREFUSED"); });
  try {
    assert.equal(await mod.probeLocal("http://127.0.0.1:1"), null);
  } finally { restore(); }
});
