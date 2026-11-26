/**
 * aiti-qoder-agent — user message images in the transcript mirror.
 *
 * The host renders a sent prompt from its optimistic bubble and then replaces it with
 * what `getMessages()` returns; it matches the two through `userMessageKey()`, which
 * hashes every image block. A text-only mirror therefore lost the picture: the loaded
 * copy differed from the bubble and won, leaving the message image-less.
 *
 * Pinned here:
 *   1. `prompt` / `steer` still send ACP `{type:"image", data, mimeType}` blocks (wire
 *      shape unchanged) AND mirror the pi-native `{source:{type:"base64"…}}` form;
 *   2. an image-only prompt keeps its image in the mirror;
 *   3. `session/load` replay folds an image chunk into the user entry before it instead
 *      of appending an image-only twin bubble.
 *
 * Run: node --experimental-strip-types --test pi-web-ext/aiti-qoder-agent/qoder-images.test.mjs
 */
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Sandbox the state files (session/new rewrites the model-state store).
const sandbox = mkdtempSync(join(tmpdir(), "qoder-images-"));
process.env.EXT_MODEL_STATE_DIR = join(sandbox, "ext-agents");
process.env.PI_MODELS_CONFIG_PATH = join(sandbox, "models.json");

const { QoderHandle, applySteerProbeBook } = await import("./index.ts");
const { makeReadyHandle, flush } = await import("./qoder-acp-stub.mjs");

const CLI = "/nonexistent-for-test/qoderclicn-9.9.9";
const PROBE_ON = { [CLI]: { verdict: "pass", driver: "acp", cliVersion: "1.1.87" } };
const IMG = { type: "image", data: "QUJD", mimeType: "image/png" };
const MIRRORED = { type: "image", source: { type: "base64", media_type: "image/png", data: "QUJD" } };

test.after(() => { rmSync(sandbox, { recursive: true, force: true }); });
afterEach(() => applySteerProbeBook({}));

const prompts = (stub) => stub.sent.filter((f) => f.method === "session/prompt");
const lastUser = (h) => h.getMessages().filter((m) => m?.role === "user").at(-1);

test("prompt 带图：出站仍是 ACP 帧，镜像落宿主同形 base64 块", async () => {
  const { h, stub } = await makeReadyHandle(QoderHandle);
  await h.prompt("这个按钮错位了", { images: [IMG] });
  await flush();
  assert.deepEqual(prompts(stub).at(-1).params.prompt, [
    { type: "text", text: "这个按钮错位了" },
    { type: "image", data: "QUJD", mimeType: "image/png" },
  ], "ACP 出站形状不变");
  assert.deepEqual(lastUser(h).content, [
    { type: "text", text: "这个按钮错位了" },
    MIRRORED,
  ], "镜像与宿主乐观气泡同形（否则 userMessageKey 不一致，气泡被纯文本顶替）");
  await h.dispose();
});

test("只有图没有文字：镜像只带图块，文字块不占位", async () => {
  const { h } = await makeReadyHandle(QoderHandle);
  await h.prompt("", { images: [IMG] });
  await flush();
  assert.deepEqual(lastUser(h).content, [MIRRORED]);
  await h.dispose();
});

test("无图时镜像保持字符串 content（老形状不变）", async () => {
  const { h } = await makeReadyHandle(QoderHandle);
  await h.prompt("纯文字");
  await flush();
  assert.equal(lastUser(h).content, "纯文字");
  await h.dispose();
});

test("运行中带图输入（streamingBehavior=steer）：注入请求与镜像都带图", async () => {
  applySteerProbeBook(PROBE_ON);
  const { h, stub } = await makeReadyHandle(QoderHandle, {
    stubOpts: { autoAnswerPrompt: false, cliVersion: "1.1.87" },
    handleOpts: { cliPath: CLI },
  });
  const primary = h.prompt("主轮");
  primary.catch(() => {});
  await flush();
  // Images on a running turn take the queue hub: prompt(images, streamingBehavior) →
  // the steer hook → injectSteer. The public steer(text) capability stays text-only
  // (the host never hands it images).
  await h.prompt("再看这张", { images: [IMG], streamingBehavior: "steer" });
  await flush();
  assert.deepEqual(prompts(stub).at(-1).params.prompt, [
    { type: "text", text: "再看这张" },
    { type: "image", data: "QUJD", mimeType: "image/png" },
  ], "注入轮同样发图");
  assert.deepEqual(lastUser(h).content, [{ type: "text", text: "再看这张" }, MIRRORED], "镜像带图（steer 条目）");
  stub.answerPrompt({ stopReason: "end_turn" }, 1);
  stub.answerPrompt({ stopReason: "end_turn" }, 0);
  await primary.catch(() => {});
  await h.dispose();
});

test("session/load 回放：图片 chunk 折进前一条 user 条目，不单独成气泡", async () => {
  const sid = "sid-replay-img";
  const { h, stub } = await makeReadyHandle(QoderHandle, { sessionId: sid, stubOpts: { sessionId: sid } });
  h.loading = true; // replay window: handshake already done, tail replayed here
  stub.notify({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "看这张图" } });
  stub.notify({ sessionUpdate: "user_message_chunk", content: { type: "image", data: "QUJD", mimeType: "image/png" } });
  await flush();
  const users = h.getMessages().filter((m) => m?.role === "user");
  assert.equal(users.length, 1, "文字 + 图片是同一轮");
  assert.deepEqual(users[0].content, [{ type: "text", text: "看这张图" }, MIRRORED]);
  await h.dispose();
});

test("session/load 回放：没有前置文字块时图片自成一条（不丢）", async () => {
  const sid = "sid-replay-img-only";
  const { h, stub } = await makeReadyHandle(QoderHandle, { sessionId: sid, stubOpts: { sessionId: sid } });
  h.loading = true;
  stub.notify({ sessionUpdate: "user_message_chunk", content: { type: "image", data: "QUJD", mimeType: "image/png" } });
  await flush();
  assert.deepEqual(lastUser(h).content, [MIRRORED]);
  await h.dispose();
});
