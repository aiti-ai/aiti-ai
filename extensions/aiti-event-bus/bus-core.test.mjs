/**
 * aiti-event-bus · 单元测试（node --test）
 *
 * 覆盖：总线 fan-out / 坏 sink 剔除 / 退订、访问器接管（读恒得 wrapper / 赋值吸收 /
 * 守卫恢复 / 热重载堆叠 / 槽缺席防御）——重点回归 turbopack dev 下模块再求值
 * 重赋 __piPageEvents 冲掉接管的场景（bus-core 注释所述）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createEventBus, installPageEventSlot, frameMatches } from "./bus-core.ts";

function freshOwner() {
  return {};
}

test("总线 fan-out：帧契约 { type, ...data }，多 sink 全收", () => {
  const bus = createEventBus();
  const got1 = [];
  const got2 = [];
  bus.addSink((f) => got1.push(f));
  bus.addSink((f) => got2.push(f));
  bus.publish("mc:avail", { ok: true });
  assert.deepEqual(got1, [{ type: "mc:avail", ok: true }]);
  assert.deepEqual(got2, [{ type: "mc:avail", ok: true }]);
  assert.equal(bus.sinkCount, 2);
});

test("坏 sink 抛错被剔除，其余 sink 照常收帧", () => {
  const bus = createEventBus();
  const got = [];
  bus.addSink(() => { throw new Error("boom"); });
  bus.addSink((f) => got.push(f));
  bus.publish("running", {});
  bus.publish("running", {});
  assert.equal(got.length, 2);
  assert.equal(bus.sinkCount, 1); // 坏 sink 已剔除
});

test("addSink 退订后不再收帧", () => {
  const bus = createEventBus();
  const got = [];
  const off = bus.addSink((f) => got.push(f));
  off();
  bus.publish("ed-watch", { id: "w1" });
  assert.deepEqual(got, []);
  assert.equal(bus.sinkCount, 0);
});

test("接管双喂：读槽得到 wrapper，前任与总线都收到", () => {
  const owner = freshOwner();
  const prevGot = [];
  const prevSlot = { publish: (t, d) => prevGot.push({ t, d }) };
  owner.__slot = prevSlot;
  const bus = createEventBus();
  const got = [];
  bus.addSink((f) => got.push(f));
  installPageEventSlot(owner, "__slot", bus);
  owner.__slot.publish("pf:remind", { n: 1 }); // 读 → wrapper
  assert.deepEqual(prevGot, [{ t: "pf:remind", d: { n: 1 } }]);
  assert.deepEqual(got, [{ type: "pf:remind", n: 1 }]);
});

test("前任抛错不阻断总线", () => {
  const owner = freshOwner();
  owner.__slot = { publish: () => { throw new Error("prev down"); } };
  const bus = createEventBus();
  const got = [];
  bus.addSink((f) => got.push(f));
  installPageEventSlot(owner, "__slot", bus);
  assert.doesNotThrow(() => owner.__slot.publish("running", {}));
  assert.deepEqual(got, [{ type: "running" }]);
});

test("clobber 免疫：模块再求值式重赋值被 setter 吸收为新前任（关键回归）", () => {
  const owner = freshOwner();
  const coreA = [];
  const coreB = [];
  owner.__slot = { publish: (t, d) => coreA.push({ t, d }) }; // instrumentation 首次求值
  const bus = createEventBus();
  const got = [];
  bus.addSink((f) => got.push(f));
  installPageEventSlot(owner, "__slot", bus);
  // 路由惰性编译 → agent-page-events 模块再求值 → 无条件重赋全局（旧实现在此被冲掉）
  owner.__slot = { publish: (t, d) => coreB.push({ t, d }) };
  owner.__slot.publish("running", {});
  assert.deepEqual(coreA, []);                  // 首任已被替换（吸收，不再喂）
  assert.deepEqual(coreB, [{ t: "running", d: {} }]); // 新前任照喂
  assert.deepEqual(got, [{ type: "running" }]); // 总线不断流
  // 读恒得稳定 wrapper：赋值后再读还是我们的槽
  const before = owner.__slot;
  owner.__slot = { publish: () => {} };
  assert.equal(owner.__slot, before);
});

test("守卫恢复：restore 卸下访问器还原前任数据属性", () => {
  const owner = freshOwner();
  const prevSlot = { publish: () => {} };
  owner.__slot = prevSlot;
  const chain = installPageEventSlot(owner, "__slot", createEventBus());
  assert.equal(chain.restore(), true);
  const desc = Object.getOwnPropertyDescriptor(owner, "__slot");
  assert.equal(desc.get, undefined);      // 访问器已卸
  assert.equal(owner.__slot, prevSlot);   // 原槽对象还原
  assert.equal(chain.restore(), false);   // 已恢复，再 restore 无事发生
});

test("热重载堆叠：A→B 后 A restore 不动（守卫），B restore 还原 A 的槽（链不断）", () => {
  const owner = freshOwner();
  const core0 = [];
  const prev0 = { publish: (t, d) => core0.push({ t, d }) };
  owner.__slot = prev0;
  const busA = createEventBus();
  const gotA = [];
  busA.addSink((f) => gotA.push(f));
  const busB = createEventBus();
  const gotB = [];
  busB.addSink((f) => gotB.push(f));
  const chainA = installPageEventSlot(owner, "__slot", busA);
  const chainB = installPageEventSlot(owner, "__slot", busB); // B 捕捉到 A 的槽对象（旧 getter）
  assert.equal(chainA.restore(), false);  // 槽位是 B 的访问器 → A 不动
  assert.equal(chainB.restore(), true);
  // B restore 还原的是「B 接管时的前任」= A 的槽对象 → A wrapper 仍可达
  const back = owner.__slot;
  assert.notEqual(back, prev0);           // 回到的是 A 的 ourSlot（数据属性形态）
  back.publish("x", { v: 1 });            // A wrapper → prev0 + busA
  assert.deepEqual(gotA, [{ type: "x", v: 1 }]);
  assert.deepEqual(core0, [{ t: "x", d: { v: 1 } }]);
});

test("槽缺席防御：接管后读得 wrapper、总线照收；restore 后属性消失", () => {
  const owner = freshOwner();
  const bus = createEventBus();
  const got = [];
  bus.addSink((f) => got.push(f));
  const chain = installPageEventSlot(owner, "__slot", bus);
  assert.equal(chain.prev, undefined);
  owner.__slot.publish("t", {});
  assert.deepEqual(got, [{ type: "t" }]);
  assert.equal(chain.restore(), true);
  assert.equal("__slot" in owner, false); // 原本缺席 → 还原为缺席
});

test("install 后经惰性取槽发布同样命中 wrapper（index.ts services 出口同构路径）", () => {
  const owner = freshOwner();
  owner.__slot = { publish: () => {} };
  const bus = createEventBus();
  const got = [];
  bus.addSink((f) => got.push(f));
  installPageEventSlot(owner, "__slot", bus);
  // 模拟 index.ts services 出口：惰性现取全局槽再调 publish
  const publishViaSlot = (t, d) => owner.__slot?.publish?.(t, d ?? {});
  assert.doesNotThrow(() => publishViaSlot("my:evt", { k: 1 }));
  assert.deepEqual(got, [{ type: "my:evt", k: 1 }]);
});

// ---------- v0.2 主题订阅：frameMatches 白名单过滤 ----------

test("frameMatches：null = 全帧（v0.1 兼容）", () => {
  const f = { type: "running" };
  assert.equal(frameMatches(f, null), true);
  assert.equal(frameMatches({ type: "cmd-s_ab12" }, null), true);
});

test("frameMatches：白名单命中/未命中", () => {
  const types = new Set(["cmd-s_ab12", "cmd-sessions"]);
  assert.equal(frameMatches({ type: "cmd-s_ab12", evt: "data" }, types), true);
  assert.equal(frameMatches({ type: "cmd-sessions" }, types), true);
  assert.equal(frameMatches({ type: "cmd-s_cd34" }, types), false);  // 其他终端的帧
  assert.equal(frameMatches({ type: "running" }, types), false);     // core 状态帧
  assert.equal(frameMatches({ type: "cmd-s_ab1" }, types), false);   // 前缀相似但不等
});

test("frameMatches：空白名单 = 什么都不收（合法状态）", () => {
  assert.equal(frameMatches({ type: "anything" }, new Set()), false);
});

test("frameMatches：尾部 * 前缀通配（sched:* 动态 type 场景）", () => {
  const types = new Set(["sched:*"]);
  assert.equal(frameMatches({ type: "sched:run:start" }, types), true);
  assert.equal(frameMatches({ type: "sched:tick" }, types), true);
  assert.equal(frameMatches({ type: "sched" }, types), false);      // 前缀不含分隔符也不命中
  assert.equal(frameMatches({ type: "cmd-s_1" }, types), false);
  const mixed = new Set(["ed-watch", "sched:*"]);
  assert.equal(frameMatches({ type: "ed-watch" }, mixed), true);    // 精确与通配共存
  assert.equal(frameMatches({ type: "sched:x" }, mixed), true);
});
