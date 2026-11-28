// Unit tests for target URL normalization (esbuild-bundles src/targets.ts, then imports it).
// Run: node --test test/targets.test.mjs
// 2026-11-14 regression pin: for scheme-less input (localhost:5199) new URL yields the origin
// string "null" -> the next new URL("null") throws Invalid URL -> proxy startup fails.
import { test } from "node:test";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import path from "node:path";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const esbuild = require("esbuild");
const PKG = dirname(fileURLToPath(import.meta.url)) + "/..";
esbuild.buildSync({
  entryPoints: [path.join(PKG, "src/targets.ts")],
  outdir: path.join(PKG, "dist-test"),
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node18",
  logLevel: "silent",
});

const { normalizeTargetInput, originOf, isProxyableOrigin } = await import(path.join(PKG, "dist-test/targets.js"));

test("originOf: scheme-less localhost:port (old implementation returned 'null' regression pin)", () => {
  assert.equal(originOf("localhost:5199"), "http://localhost:5199");
  assert.equal(originOf("localhost:5199/"), "http://localhost:5199");
});

test("originOf: bare port / :port / IP:port / IPv6", () => {
  assert.equal(originOf("5173"), "http://localhost:5173");
  assert.equal(originOf(":3000"), "http://localhost:3000");
  assert.equal(originOf("127.0.0.1:5173"), "http://127.0.0.1:5173");
  assert.equal(originOf("[::1]:3000"), "http://[::1]:3000");
});

test("originOf: valid http(s) URLs behave unchanged", () => {
  assert.equal(originOf("http://localhost:5173/"), "http://localhost:5173");
  assert.equal(originOf("http://127.0.0.1:5173"), "http://127.0.0.1:5173");
  assert.equal(originOf("https://x.example.com/a/b?c=1"), "https://x.example.com");
});

test("normalizeTargetInput: keeps existing scheme", () => {
  assert.equal(normalizeTargetInput("https://a.com"), "https://a.com");
  assert.equal(normalizeTargetInput("HTTP://A.com"), "HTTP://A.com");
  assert.equal(normalizeTargetInput("ftp://x/"), "ftp://x/");
});

test("normalizeTargetInput: empty input passes through", () => {
  assert.equal(normalizeTargetInput(""), "");
  assert.equal(normalizeTargetInput("  "), "");
});

test("isProxyableOrigin: valid/invalid classification", () => {
  assert.equal(isProxyableOrigin("http://localhost:5173"), true);
  assert.equal(isProxyableOrigin("localhost:5199"), true); // proxyable after normalization
  assert.equal(isProxyableOrigin("5173"), true);
  assert.equal(isProxyableOrigin("不是地址"), false);
  assert.equal(isProxyableOrigin(""), false);
});
