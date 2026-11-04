/**
 * token tests — aiti-onlyoffice HMAC 一次性 token + documentType（回归钉行为）。
 *
 * Run: node --test pi-web-ext/aiti-onlyoffice/token.test.mjs
 * （node 24 原生 TS strip-types，直接 import 邻近 .ts）
 *
 * 背景：E2E 曾发现签发侧对 encodeURIComponent 后的路径签名、校验侧却拿解码后
 * token 验签 → 恒 403「下载失败」。本测试钉死「对原始路径签名」契约。
 */
import assert from "node:assert/strict";
import test from "node:test";

const { hmacToken, verifyToken, documentTypeOf } = await import("./token.ts");

const SECRET = "test-secret";

test("签发→校验往返：原始路径（含点号/中文/多级目录）", () => {
  for (const fp of [
    "/home/pi/workspace/aiti-ai/demos/demo-doc.docx",
    "/home/pi/文档/名.字.带.点.docx",
    "/home/pi/x/y/z/empty.pptx",
  ]) {
    const t = hmacToken(SECRET, fp, 60_000);
    assert.equal(t.includes("%2F"), false, "token 内不得含百分号编码（对原始路径签名的回归钉）");
    assert.deepEqual(verifyToken(SECRET, t), { filePath: fp });
  }
});

test("URL 编码往返：encodeURIComponent 包裹后 searchParams 解码仍可校验", () => {
  const fp = "/home/a b/文 档.docx"; // 含空格等需编码字符
  const t = hmacToken(SECRET, fp, 60_000);
  const url = new URL("https://x/y?" + new URLSearchParams({ t }));
  assert.deepEqual(verifyToken(SECRET, url.searchParams.get("t")), { filePath: fp });
});

test("过期 token 拒绝", () => {
  const t = hmacToken(SECRET, "/a/b.docx", -1000); // 已过期
  assert.equal(verifyToken(SECRET, t), null);
});

test("篡改路径 / 篡改签名 / 错误密钥 均拒绝", () => {
  const t = hmacToken(SECRET, "/a/b.docx", 60_000);
  // 换路径（保持三段结构）
  const parts = t.split(".");
  const exp = parts[parts.length - 2];
  const forged = "/a/EVIL.docx." + exp + "." + parts[parts.length - 1];
  assert.equal(verifyToken(SECRET, forged), null);
  // 篡改签名末位
  assert.equal(verifyToken(SECRET, t.slice(0, -1) + (t.endsWith("A") ? "B" : "A")), null);
  // 错误密钥
  assert.equal(verifyToken("other-secret", t), null);
  // 缺段
  assert.equal(verifyToken(SECRET, "/a/b.docx"), null);
});

test("documentTypeOf：word/cell/slide/未知", () => {
  assert.equal(documentTypeOf("/x/a.docx"), "word");
  assert.equal(documentTypeOf("/x/a.doc"), "word");
  assert.equal(documentTypeOf("/x/a.xlsx"), "cell");
  assert.equal(documentTypeOf("/x/a.XLSM"), "cell");
  assert.equal(documentTypeOf("/x/a.xls"), "cell");
  assert.equal(documentTypeOf("/x/a.ods"), "cell");
  assert.equal(documentTypeOf("/x/a.pptx"), "slide");
  assert.equal(documentTypeOf("/x/a.ppt"), "slide");
  assert.equal(documentTypeOf("/x/a.odp"), "slide");
  assert.equal(documentTypeOf("/x/a.odt"), "word");
  assert.equal(documentTypeOf("/x/a.txt"), null);
  assert.equal(documentTypeOf("/x/noext"), null);
});
