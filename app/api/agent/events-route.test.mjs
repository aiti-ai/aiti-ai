import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const agentEventsSource = await readFile(new URL("./[id]/events/route.ts", import.meta.url), "utf8");
const agentEventStreamSource = await readFile(new URL("../../../lib/agent-event-stream.ts", import.meta.url), "utf8");
const agentPostSource = await readFile(new URL("./[id]/route.ts", import.meta.url), "utf8");

test("agent SSE 惰性建 runtime：打开会话不冷启动，wrapper 出现后经广播附着", () => {
  assert.match(agentEventsSource, /createAgentEventStream\(req, id, sessionPromise\)/);
  // 本地会话无 wrapper 时不得 startRpcSession（打开会话只为查看不拉 runtime）；
  // 改挂惰性句柄，真 wrapper 由后续真实交互带起后经 running 广播唤醒附着。
  assert.doesNotMatch(agentEventsSource, /startRpcSession\(/);
  assert.match(agentEventsSource, /sessionPromise = Promise\.resolve\(createPendingAgentSessionHandle\(/);
  assert.match(agentEventsSource, /waitForRpcSession\(id, \(wrapper\) => onReady\(wrapper\)\)/);
  assert.match(agentEventsSource, /if \(req\.signal\.aborted\) return new Response\(null, \{ status: 204 \}\)/);
  assert.match(agentEventsSource, /"Cache-Control": "no-cache, no-transform"/);
  assert.match(agentEventsSource, /"X-Accel-Buffering": "no"/);
});

test("agent SSE reuses one TextEncoder per stream", () => {
  assert.equal((agentEventStreamSource.match(/new TextEncoder\(\)/g) ?? []).length, 1);
  assert.match(agentEventStreamSource, /controller\.enqueue\(encoder\.encode\(/);
});

test("复合外部 id（zcode:sess_x 等）注册表空窗冷恢复兜底，不 404", () => {
  // events：SSE 立即打开，sessionPromise 异步冷恢复；失败经 startup_error 带真实原因
  assert.match(agentEventsSource, /sessionPromise = resolveExternalCompositeSession\(id\)\.then/);
  assert.match(agentEventsSource, /会话后端不可用/);
  assert.doesNotMatch(agentEventsSource, /await resolveExternalCompositeSession/);
  // POST：404 前先试冷恢复；仍失败才 404 且带真实原因 + prompt_rejected 语义
  assert.match(agentPostSource, /const ext = await resolveExternalCompositeSession\(id\)/);
  assert.match(agentPostSource, /会话后端不可用/);
});
