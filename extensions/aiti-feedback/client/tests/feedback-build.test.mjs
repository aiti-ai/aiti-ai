import test from "node:test";
import assert from "node:assert/strict";
import { redact, buildMarkdown, buildIssueUrl, envInfo, BODY_SAFE } from "../src/feedback-build.ts";

test("redact: private-network domains, hosts and ports", () => {
  const out = redact("open https://dev.internal:57442/app/ and https://docs.home.arpa/x");
  assert.equal(out, "open https://<redacted-domain>/app/ and https://<redacted-domain>/x");
  assert.equal(redact("open https://corp.example/x"), "open https://corp.example/x");
});

test("redact: injected internal hosts", () => {
  const attrs = { "data-aiti-feedback-internal-hosts": "corp.example, ops.example" };
  globalThis.document = { documentElement: { getAttribute: (n) => attrs[n] ?? null } };
  try {
    assert.equal(redact("open https://corp.example:8443/x"), "open https://<redacted-domain>/x");
    assert.equal(redact("see ops.example/y"), "see <redacted-domain>/y");
  } finally {
    delete globalThis.document;
  }
});

test("redact: private IPv4 ranges only", () => {
  assert.equal(redact("a 10.203.10.24 b"), "a <redacted-ip> b");
  assert.equal(redact("a 10.7.0.23 b"), "a <redacted-ip> b");
  assert.equal(redact("a 172.20.1.5 b"), "a <redacted-ip> b");
  // public IP stays
  assert.equal(redact("a 8.8.8.8 b"), "a 8.8.8.8 b");
});

test("redact: home paths drop the user segment", () => {
  assert.equal(redact("/home/alice/.pi/web"), "/home/<redacted>/.pi/web");
  assert.equal(redact("/Users/alice/.pi/web"), "/Users/<redacted>/.pi/web");
  assert.equal(redact(String.raw`C:\Users\alice\app`), String.raw`<redacted-path>\app`);
});

test("redact: token shapes", () => {
  assert.ok(redact("key sk-abc123def456677").includes("<redacted-key>"));
  assert.ok(redact("ghp_ABCDEFGHIJKLMNOPQRSTUVWX").includes("<redacted-token>"));
  assert.ok(redact("AKIAIOSFODNN7EXAMPLE").includes("<redacted-aws-key>"));
  assert.ok(redact("hex deadbeefdeadbeefdeadbeefdeadbeef").includes("<redacted-hex>"));
  assert.ok(redact("b64 ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrst").includes("<redacted-b64>"));
});

test("redact: normal text untouched", () => {
  const s = "The build fails on step 2 with exit code 1.";
  assert.equal(redact(s), s);
});

test("buildMarkdown: sections and redaction", () => {
  const md = buildMarkdown({
    kind: "bug", title: "t", desc: "crash at dev.internal", steps: "1. open\n2. click",
    contact: "", context: "", includeEnv: false,
  });
  assert.ok(md.includes("### Type\nbug"));
  assert.ok(md.includes("<redacted-domain>"));
  assert.ok(md.includes("### Steps to reproduce"));
  assert.ok(!md.includes("### Environment"));
  // empty optional sections are omitted entirely
  const md2 = buildMarkdown({ kind: "bug", title: "t", desc: "d", steps: "", contact: "", context: "", includeEnv: false });
  assert.ok(!md2.includes("### Steps"));
  assert.ok(!md2.includes("### Contact"));
});

test("buildMarkdown: env section only when enabled", () => {
  const env = envInfo({ userAgent: "UA/1", platform: "Linux", language: "zh" }, "https://x.test/?session=abc");
  const md = buildMarkdown({ kind: "bug", title: "t", desc: "d", steps: "", contact: "", context: "", includeEnv: true }, env);
  assert.ok(md.includes("- UA: UA/1"));
  assert.ok(md.includes("https://x.test/")); // query stripped
  assert.ok(!md.includes("session=abc"));
});

test("buildIssueUrl: encodes and stays under budget", () => {
  const r = buildIssueUrl("标题 bug", "body line\nwith spaces");
  assert.ok(r.url.startsWith("https://github.com/aiti-ai/aiti-ai/issues/new?title="));
  assert.ok(r.url.includes(encodeURIComponent("标题 bug")));
  assert.ok(!r.truncated);
  assert.ok(r.url.length < 8000);
});

test("buildIssueUrl: truncation with clipboard fallback note", () => {
  const r = buildIssueUrl("big", "x".repeat(BODY_SAFE + 500));
  assert.ok(r.truncated);
  assert.ok(r.fullBody.length === BODY_SAFE + 500); // caller copies full text
  assert.ok(r.url.length < 12000);
  assert.ok(r.url.includes(encodeURIComponent("(truncated — full text in clipboard")));
});
