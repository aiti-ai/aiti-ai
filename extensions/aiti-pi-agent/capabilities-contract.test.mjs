/**
 * B5 · capabilities 契约测试（docs/aiti-pi-agent-split-plan.md 阶段 2-B5）
 *
 * 钉死 pi / omp 两系的 RPC 能力位与「2026-09-19 真机探针」结论一致（pi 0.84.4 --mode rpc 实测）：
 *   - 探针发 get_usage / navigate_tree / set_active_tools / delete_session → 全部
 *     `Unknown command`（协议不支持）→ 能力位必须保持 false（不硬造、前端降级）；
 *   - 探针发 get_state → success:true（基础面）。
 * 上游若新增这些命令，先更新探针结论再翻能力位——本测试就是那个提醒器。
 * Run: node --test capabilities-contract.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { capabilitiesFor } from "./fork-rpc/spec.ts";
const { PI_SPEC } = await import("./pi-handle.ts");
const { OMP_SPEC } = await import("../aiti-omp-agent/omp-handle.ts");

/** 真机探针（2026-09-19，pi 0.84.4）确认不存在的命令 → 对应能力位必须为 false。 */
const PROBED_UNSUPPORTED = [
  "getUsage",        // rpc: get_usage      → Unknown command
  "navigateTree",    // rpc: navigate_tree  → Unknown command
  "deleteSession",   // rpc: delete_session → Unknown command
  "setActiveTools",  // rpc: set_active_tools → Unknown command
];

/** 基础面：真机确认存在的命令 → 能力位必须为 true。 */
const PROBED_SUPPORTED = [
  "setThinkingLevel", // set_thinking_level
  "compact",
  "getCommands",      // get_state 含 commands
  "listModels",
];

for (const [name, spec] of [["pi", PI_SPEC], ["omp", OMP_SPEC]]) {
  test(`B5 契约（${name}）：探针判否的能力位保持 false`, () => {
    const caps = capabilitiesFor(spec);
    for (const key of PROBED_UNSUPPORTED) {
      assert.equal(caps[key], false, `${name}.${key} 应为 false（真机 Unknown command）`);
    }
  });

  test(`B5 契约（${name}）：基础面能力位保持 true`, () => {
    const caps = capabilitiesFor(spec);
    for (const key of PROBED_SUPPORTED) {
      assert.equal(caps[key], true, `${name}.${key} 应为 true`);
    }
  });

  test(`B5 契约（${name}）：respondInteraction 已声明（UI 应答管道已实现）`, () => {
    const caps = capabilitiesFor(spec);
    assert.equal(caps.respondInteraction, true);
  });
}

test("B5：两系 listTools 语义（omp dumpTools 有、pi RPC 无）", () => {
  const piCaps = capabilitiesFor(PI_SPEC);
  const ompCaps = capabilitiesFor(OMP_SPEC);
  assert.equal(piCaps.listTools, false); // pi RPC 无 dumpTools（spec.commands.hasDumpTools=false）
  assert.equal(ompCaps.listTools, true); // omp get_state.dumpTools
});

test("B5：两系 steering 条目可管理（pi-web 队列面板 steer 行只读判据的唯一数据源）", () => {
  // pi-web 的 computeQueueSteerReadonly：steer:true 且未声明 steerQueueManage → steer 行
  // 只读。本系队列变更走 clear+重注入（_shared/pi-fork-rpc/remote-queue.ts），条目收得
  // 回来，必须声明 true——掉这一行就把可管理的队列静默锁成只读（前端不报错）。
  for (const [name, spec] of [["pi", PI_SPEC], ["omp", OMP_SPEC]]) {
    const caps = capabilitiesFor(spec);
    assert.equal(caps.steer, true, `${name}.steer`);
    assert.equal(caps.queueManage, true, `${name}.queueManage`);
    assert.equal(caps.steerQueueManage, true, `${name}.steerQueueManage`);
  }
});
