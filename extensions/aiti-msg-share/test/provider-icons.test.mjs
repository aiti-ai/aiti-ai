/**
 * provider-icons — curated glyph rules for the share picker (pure, no DOM).
 * Run: node --test extensions/aiti-msg-share/test/provider-icons.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { resolveProviderIcon } from "../lib/provider-icons.mjs";

test("exact curated ids win", () => {
  assert.equal(resolveProviderIcon("aliyun-oss"), "☁️");
  assert.equal(resolveProviderIcon("gitee-gist"), "🟠");
  assert.equal(resolveProviderIcon("local-link"), "🔗");
  assert.equal(resolveProviderIcon("custom"), "⚙️");
});

test("domain-shaped catalog ids map to families", () => {
  assert.equal(resolveProviderIcon("imgur.com"), "🖼️");
  assert.equal(resolveProviderIcon("imgbb.com"), "🖼️");
  assert.equal(resolveProviderIcon("catbox.moe"), "🐱");
  assert.equal(resolveProviderIcon("paste.rs"), "📋");
  assert.equal(resolveProviderIcon("ix.io"), "📋");
  assert.equal(resolveProviderIcon("Discord post"), "💬");
  assert.equal(resolveProviderIcon("joplin"), "📓");
  assert.equal(resolveProviderIcon("ipfs.io"), "🌐");
  assert.equal(resolveProviderIcon("file.io"), "📦");
  assert.equal(resolveProviderIcon("github-gist"), "💻");
});

test("multi-variant ids resolve by their variant, not the base host", () => {
  assert.equal(resolveProviderIcon("0x0.st (URL shortener)"), "✂️");
  assert.equal(resolveProviderIcon("0x0.st (Image uploader)"), "🖼️");
});

test("unknown ids return null so the client keeps its category glyph", () => {
  assert.equal(resolveProviderIcon("example"), null);
  assert.equal(resolveProviderIcon(""), null);
  assert.equal(resolveProviderIcon(undefined), null);
  assert.equal(resolveProviderIcon(null), null);
});

test("future provider metadata wins; invalid metadata falls through", () => {
  assert.equal(resolveProviderIcon("imgur.com", { icon: "🔒" }), "🔒");
  assert.equal(resolveProviderIcon("imgur.com", { icon: { emoji: "🅰️" } }), "🅰️");
  assert.equal(resolveProviderIcon("imgur.com", { icon: {} }), "🖼️");
  assert.equal(resolveProviderIcon("imgur.com", { icon: 42 }), "🖼️");
  assert.equal(resolveProviderIcon("unknown-id", { icon: "  " }), null);
});
