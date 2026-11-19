import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ShareStore, makeRedactor, publicTarget, maskSecret, exportSessionMarkdown } from "../lib/share-core.mjs";

test("maskSecret keeps prefix/suffix only", () => {
  assert.equal(maskSecret("sk-ant-api03-abcdefgh"), "sk***************efgh");
  assert.equal(maskSecret("short"), "****");
});

test("publicTarget masks password fields but keeps normal ones", () => {
  const provider = { metaFields: [{ key: "token", type: "password" }, { key: "title", type: "text" }] };
  const out = publicTarget({ id: "x", values: { token: "supersecretvalue", title: "Hello" } }, provider);
  assert.notEqual(out.values.token, "supersecretvalue");
  assert.equal(out.values.title, "Hello");
  assert.ok(out.secretKeys.includes("token"));
});

test("makeRedactor: replaces detected secrets with stable placeholders", async () => {
  const engine = await import("@aiti-ai/secret-mask-core");
  const redactor = makeRedactor(engine);
  const input = "export ANTHROPIC_API_KEY=sk-ant-api03-" + "A1b2C3d4E5f6G7h8I9j0K1l2";
  const out = redactor(input);
  assert.match(out.text, /\[REDACTED:[A-Za-z0-9_-]+#[0-9a-f]{8}\]/);
  assert.equal(out.hits.length, 1);
});

test("ShareStore targets file is 0600 and history wraps", () => {
  const dir = mkdtempSync(join(tmpdir(), "share-store-"));
  const store = new ShareStore(join(dir, "config"), join(dir, "state"));
  store.upsertTarget({ id: "gitee", provider: "gitee-gist", values: { token: "secret" } });
  assert.equal(statSync(store.targetsFile).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(readFileSync(store.targetsFile, "utf8"))[0].id, "gitee");
  for (let i = 0; i < 205; i++) store.appendHistory({ url: `u${i}` });
  const h = store.readHistory();
  assert.equal(h.length, 200);
  assert.equal(h[0].url, "u204");
});

test("exportSessionMarkdown: role headers + folded tool output", () => {
  const md = exportSessionMarkdown({ messages: [
    { role: "user", content: "hello" },
    { role: "assistant", content: "x".repeat(3000) },
  ] }, { title: "T", tags: ["a", "b"] });
  assert.ok(md.startsWith("---\ntitle: T\ntags: [a, b]"));
  assert.ok(md.includes("## User\n\nhello"));
  assert.ok(md.includes("folded"));
});

test("classifyFile: image / text / binary by extension", async () => {
  const { classifyFile } = await import("../lib/share-core.mjs");
  assert.deepEqual(classifyFile("shot.png"), { kind: "image", mime: "image/png" });
  assert.deepEqual(classifyFile("photo.JPG"), { kind: "image", mime: "image/jpeg" });
  assert.deepEqual(classifyFile("notes.md"), { kind: "text", mime: "text/plain" });
  assert.deepEqual(classifyFile("data.json"), { kind: "text", mime: "text/plain" });
  assert.deepEqual(classifyFile("report.pdf"), { kind: "binary", mime: "application/octet-stream" });
  assert.deepEqual(classifyFile("archive.tar.gz"), { kind: "binary", mime: "application/octet-stream" });
  assert.deepEqual(classifyFile("noext"), { kind: "binary", mime: "application/octet-stream" });
});
