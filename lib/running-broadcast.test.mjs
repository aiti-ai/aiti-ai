/**
 * running 广播回归（lib/running-broadcast.ts）：
 *   1) 纯函数功能：并集合并 / 内容键（lib/running-broadcast-core.ts 零依赖可直载）；
 *   2) 接线 source-scan：三路订阅注册（globalThis 幂等）/ 宽发布 / 内容去重键、
 *      handle 订阅集合 globalThis 缝、instrumentation 与 running route 双入口、
 *      events route 直调（防与广播器双发总线）。
 *
 * 主模块依赖 rpc-manager 等（含 TS 参数属性，strip-types 无法直载）——功能部分
 * 落在零依赖 core，接线用 source-scan 守护（项目惯例，见 rpc-manager-running.test.mjs）。
 *
 * 背景：running 帧生产原挂在 events route 连接生命周期内——页面事件收敛到总线后
 * 无人直连（2026-09-15 生产实测 0 连接）→ 总线无 running 帧 → session-manager
 * 健康判据恒假 → 全端 30s 兜底轮询。本文件盯住修复不被合并/重构悄悄撤掉。
 *
 * 运行：node --experimental-strip-types --test lib/running-broadcast.test.mjs（npm test 收录）
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const { mergeRunningIds, runningFrameKey } = await import("./running-broadcast-core.ts");

test("mergeRunningIds：多路并集去重（保持首次出现顺序）", () => {
  assert.deepEqual(mergeRunningIds(["a", "b"], ["b", "c"], []), ["a", "b", "c"]);
  assert.deepEqual(mergeRunningIds([], []), []);
});

test("runningFrameKey：集合语义（排序无关 / 内容敏感）", () => {
  assert.equal(runningFrameKey(["b", "a"]), runningFrameKey(["a", "b"]));
  assert.notEqual(runningFrameKey(["a"]), runningFrameKey(["a", "b"]));
  assert.equal(runningFrameKey([]), "");
});

const read = (p) => readFile(new URL(p, import.meta.url), "utf8");

test("running-broadcast：三路订阅注册 + globalThis 幂等 + 宽发布 + 内容去重", async () => {
  const src = await read("./running-broadcast.ts");
  assert.match(src, /subscribeRunningSessions\(\(\) => publishMergedRunning\(\)\)/);
  assert.match(src, /subscribeRunningHandles\(\(\) => publishMergedRunning\(\)\)/);
  assert.match(src, /subscribeBridgeRunning\(\(\) => publishMergedRunning\(\)\)/);
  assert.match(src, /__piRunningBroadcastWired/); // globalThis 幂等标志（跨 realm 只注册一次）
  assert.match(src, /publishPageEventToBus\("running", \{ runningSessionIds: ids \}\)/);
  assert.match(src, /__piRunningBroadcastKey/); // 内容去重键（跨 realm 共享）
  assert.match(src, /if \(g\[KEY_SLOT\] === key\) return;/);
});

test("handle-store：running 订阅集合走 globalThis 缝（跨 realm 通知可达广播器）", async () => {
  const src = await read("./session/handle-store.ts");
  assert.match(src, /__piHandleRunningListeners/);
  assert.doesNotMatch(src, /^const runningListeners = new Set/m); // 不得退回模块级集合
});

test("双入口激活：instrumentation 启动段 + /api/agent/running 快照 route", async () => {
  const instr = await read("../instrumentation.ts");
  assert.match(instr, /await import\("@\/lib\/running-broadcast"\)/);
  assert.match(instr, /ensureRunningBroadcast\(\)/);
  // 必须在总线 startup 之后（首帧要经 __piPageEvents 访问器进总线，早于接管会丢）
  const bootIdx = instr.indexOf('startupById("aiti-event-bus")');
  const ensureIdx = instr.indexOf("ensureRunningBroadcast()");
  assert.ok(bootIdx >= 0 && ensureIdx > bootIdx, "ensure 必须晚于 aiti-event-bus startup");

  const snapRoute = await read("../app/api/agent/running/route.ts");
  assert.match(snapRoute, /ensureRunningBroadcast\(\)/);
});

test("events route：running 直调（不宽发布）——总线帧由广播器统一供给，防双发", async () => {
  const src = await read("../app/api/agent/running/events/route.ts");
  assert.match(src, /publishPageEvent\("running", \{ runningSessionIds: mergedRunningIds\(\) \}\)/);
  assert.doesNotMatch(src, /publishPageEventToBus\(\s*"running"/);
});
