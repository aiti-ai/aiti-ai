/**
 * steerSend 能力门控 —— 「无 steer 面的后端点了插队，条目被删掉而消息没发出去」回归（2026-09-22）。
 *
 * 背景：core（pi-web ChatWindow）现在把 onQueueSteerSend 按 sessionCap("steer") 摘除，
 * 面板侧 steerSend 因此不下发；契约改成 steerSend?（**存在即能力**）。若面板仍按原样渲染
 * 按钮，onClick 里 actions.remove(permanent) 照跑、发送却是空操作 —— 用户输入静默蒸发。
 * 两个入口都在这次改动里收口：折叠条「插队首个排队项」与 follow-up 行的行内插队按钮。
 *
 * 静态源码对照（同 _shared/agent-capability-contract.test.mjs 范式：不 import、零副作用）。
 * Run: node --test client/tests/steer-send-gating.test.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const srcRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const read = (f) => readFileSync(join(srcRoot, f), "utf8");

test("契约：steerSend 可选（core 无 steer 面时不下发，存在性即能力）", () => {
  const types = read("types.ts");
  assert.match(types, /steerSend\?\(text: string, images\?: QueueImage\[\]\): void;/);
  assert.doesNotMatch(types, /^\s*steerSend\(text: string/m, "steerSend 不得退回必选——那样面板无从判断能力");
});

test("折叠条：「插队首个排队项」按 steerSend 存在性显隐", () => {
  const panel = read("QueuePanel.tsx");
  assert.match(
    panel,
    /\{!\(steering\?\.\[0\]\) && followUp\?\.\[0\] && actions\.steerSend && \(/,
    "折叠条按钮的渲染条件必须带上 actions.steerSend",
  );
  assert.match(panel, /actions\.steerSend\?\.\(followUp\[0\]\.text/, "调用点须是可选链");
});

test("行内：follow-up 行的插队按钮按 steerSend 存在性显隐", () => {
  const row = read("QueueRow.tsx");
  assert.match(row, /const canSteerOut = Boolean\(actions\.steerSend\);/);
  assert.match(row, /\{kind === "follow-up" && canSteerOut && \(/, "行内按钮必须带 canSteerOut 门");
});

test("全量：不存在未门控的 steerSend 调用（漏一处就吞一次输入）", () => {
  for (const f of ["QueuePanel.tsx", "QueueRow.tsx"]) {
    const bare = read(f).match(/actions\.steerSend\(/g) ?? [];
    assert.deepEqual(bare, [], `${f} 里仍有 actions.steerSend( 直调——改为可选链并补渲染门`);
  }
});
