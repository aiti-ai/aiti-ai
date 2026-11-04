/**
 * DraftKeeperCore 状态机测试（node:test，假 storage + 真实微延时）。
 * 覆盖：写入落盘、清空确认、发送提升（sessionCreated）与 promote 窗口竞态、
 * 切换/刷新恢复、失败写回（rejected，含 alias 解析）、旧 per-tab 迁移。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createKeeperCore, mergeSubmission } from "./core.mjs";

const DELAYS = { flushMs: 5, scanMs: 5, clearConfirmMs: 10 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 槽位原文是 ts:base64(JSON)；解码成 JSON 明文再断言 */
const decodeStored = (raw) => {
  if (!raw) return null;
  const b64 = raw.includes(":") ? raw.slice(raw.indexOf(":") + 1) : raw;
  return new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
};

function mockStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
    keys: () => [...map.keys()],
    _map: map,
  };
}

function makeCore(storage, { restores = [], log = () => {} } = {}) {
  const restoreCalls = restores;
  const core = createKeeperCore({
    storage,
    onRestore: (draft) => { restoreCalls.push({ ...draft }); return true; },
    log,
    delays: DELAYS,
  });
  return { core, restoreCalls };
}

const snap = (value, extra = {}) => ({
  value,
  images: [],
  imageCount: 0,
  hasInput: value.length > 0,
  ...extra,
});

test("输入落盘（debounce 后 WRITE）", async () => {
  const st = mockStorage();
  const { core } = makeCore(st);
  core.onKeyChange(undefined, "sid-1");
  core.onChange(snap("hello"));
  assert.equal(st.getItem("crashrestore-sid-1"), null); // 未到 flush 延时
  await sleep(20);
  assert.match(decodeStored(st.getItem("crashrestore-sid-1")), /hello/);
});

test("清空 → 延迟确认后清槽位；期间新输入则取消清除", async () => {
  const st = mockStorage();
  const { core } = makeCore(st);
  core.onKeyChange(undefined, "sid-1");
  core.onChange(snap("hello"));
  await sleep(20);
  assert.ok(st.getItem("crashrestore-sid-1"));
  core.onChange(snap("")); // 发送/清空
  await sleep(30);
  assert.equal(st.getItem("crashrestore-sid-1"), null);

  // 期间新输入 → 取消清除
  core.onChange(snap("again"));
  await sleep(20);
  core.onChange(snap(""));
  core.onChange(snap("typing")); // 10ms 确认窗内新输入
  await sleep(30);
  assert.match(decodeStored(st.getItem("crashrestore-sid-1")) ?? "", /typing/);
});

test("清空后切走（新 key 快照非空）：确认链到期仍应清槽，草稿不复活", async () => {
  // 回归：确认链裁决曾看全局 lastSnap——切走后它描述的是别的框（有内容），
  // 已清除的槽被误判「仍有输入」而永久保留 → 切回后草稿复活。
  const st = mockStorage();
  const { core } = makeCore(st);
  core.onKeyChange(undefined, "new:d9:/tmp/ws");
  core.onChange(snap("abandoned draft"));
  await sleep(20);
  assert.ok(st.getItem("crashrestore-new:/tmp/ws"));

  core.onChange(snap(""));                      // 用户清空 → 确认链启动
  core.onKeyChange("new:d9:/tmp/ws", "sid-a"); // 立即切走
  core.onChange(snap("other box content"));     // 另一个框有内容
  await sleep(40);                              // 确认链到期
  assert.equal(st.getItem("crashrestore-new:/tmp/ws"), null, "已清除的槽应被确认链清掉，不被另一框内容干扰");

  // 切回也不复活
  core.onKeyChange("sid-a", "new:dz:/tmp/ws");
  core.onChange(snap(""));
  await sleep(40);
  assert.equal(core.getDraft("new:dz:/tmp/ws"), null, "切回后不应恢复已放弃的草稿");
});

test("发送提升：sessionCreated 清 provisional 槽位，promote 窗口新输入落 sid", async () => {
  const st = mockStorage();
  const { core } = makeCore(st);
  const pk = "new:d1:/tmp/ws";
  core.onKeyChange(undefined, pk);
  core.onChange(snap("the message"));
  await sleep(20);
  assert.ok(st.getItem("crashrestore-new:/tmp/ws")); // provisional 草稿已落盘

  core.onChange(snap(""));            // 发送 → clearInput 清框
  core.applyIntent({ type: "sessionCreated", provisionalKey: pk, sessionId: "sid-9" });
  await sleep(30);                    // 清空确认链稍后到：对已空槽位幂等
  assert.equal(st.getItem("crashrestore-new:/tmp/ws"), null);

  // promote 窗口：core 的 draftKey prop 还没切换，用户新输入 → 必须落 sid 槽位
  core.onChange(snap("follow-up typing"));
  await sleep(20);
  assert.match(decodeStored(st.getItem("crashrestore-sid-9")) ?? "", /follow-up typing/);
  assert.equal(st.getItem("crashrestore-new:/tmp/ws"), null);
});

test("发送提升竞态：清空确认链在 sessionCreated 之后到，不误清新输入", async () => {
  const st = mockStorage();
  const { core } = makeCore(st);
  const pk = "new:d2:/tmp/ws";
  core.onKeyChange(undefined, pk);
  core.onChange(snap("msg"));
  await sleep(20);
  core.onChange(snap(""));                                   // 清空确认启动（10ms 窗口）
  core.applyIntent({ type: "sessionCreated", provisionalKey: pk, sessionId: "sid-8" });
  core.onChange(snap("new draft right away"));               // 3ms 后用户已打字
  await sleep(40);
  assert.match(decodeStored(st.getItem("crashrestore-sid-8")) ?? "", /new draft right away/);
  assert.equal(st.getItem("crashrestore-new:/tmp/ws"), null);
});

test("切换会话再切回：草稿保留并恢复进框", async () => {
  const st = mockStorage();
  const { core, restoreCalls } = makeCore(st);
  const pk = "new:d3:/tmp/ws";
  core.onKeyChange(undefined, pk);
  core.onChange(snap("switch survivor"));
  await sleep(20);
  core.onKeyChange(pk, "sid-other");   // 切走（flushAll 落盘）
  core.onChange(snap(""));             // 新会话空框
  await sleep(30);
  assert.match(decodeStored(st.getItem("crashrestore-new:/tmp/ws")) ?? "", /switch survivor/);
  core.onKeyChange("sid-other", "new:d4:/tmp/ws"); // 切回新建页（新 draftId，同 cwd 族槽位）
  core.onChange(snap(""));
  await sleep(40);
  assert.ok(restoreCalls.some((r) => r.value === "switch survivor"), "scan 应恢复草稿进框");
  assert.match(decodeStored(st.getItem("crashrestore-new:/tmp/ws")) ?? "", /switch survivor/, "恢复后槽位必须保留（防恢复即删回归）");
});

test("同 key 切回（同一 session）：清屏后草稿恢复进框且槽位保留", async () => {
  // 回归：切回同 key 时旧实现 known 保留旧值 → scan 的 slotVal !== knownVal 恒假：
  // 不恢复，且随后的空快照走清空确认链把槽位删掉（「切换丢草稿」根因）。
  // 旧测试用新 draftId 切回（known 天然为 null）绕开了这条路径，这里钉死同 key。
  const st = mockStorage();
  const { core, restoreCalls } = makeCore(st);
  core.onKeyChange(undefined, "sid-k");
  core.onChange(snap("survivor for sid-k"));
  await sleep(20);
  assert.ok(st.getItem("crashrestore-sid-k"));

  core.onKeyChange("sid-k", "sid-other"); // 切走
  core.onChange(snap("") );                // 新会话清屏
  await sleep(30);
  assert.ok(st.getItem("crashrestore-sid-k"), "切走后原槽位保留");

  core.onKeyChange("sid-other", "sid-k"); // 切回同一个 key
  core.onChange(snap(""));                // 清屏快照
  await sleep(40);
  assert.ok(restoreCalls.some((r) => r.value === "survivor for sid-k"), "同 key 切回应恢复草稿进框");
  assert.match(decodeStored(st.getItem("crashrestore-sid-k")) ?? "", /survivor for sid-k/, "恢复后槽位必须保留");
});

test("同 key 重挂（ChatWindow 重挂/扩展晚注册补发）：草稿恢复且不被清空确认链误删", async () => {
  const st = mockStorage();
  const { core, restoreCalls } = makeCore(st);
  core.onKeyChange(undefined, "sid-r");
  core.onChange(snap("remount survivor"));
  await sleep(20);

  core.onKeyChange(undefined, "sid-r"); // 重挂：ChatInput 挂载发 (undefined, K)
  core.onChange(snap(""));              // 挂载清屏快照
  await sleep(40);
  assert.ok(restoreCalls.some((r) => r.value === "remount survivor"), "重挂后应恢复草稿进框");
  assert.match(decodeStored(st.getItem("crashrestore-sid-r")) ?? "", /remount survivor/, "恢复后槽位必须保留");
});

test("发送清槽路径不受 known 失效影响：发送后确认链正常清槽", async () => {
  const st = mockStorage();
  const { core } = makeCore(st);
  core.onKeyChange(undefined, "sid-c");
  core.onChange(snap("to be sent"));
  await sleep(20);
  assert.ok(st.getItem("crashrestore-sid-c"));
  core.onChange(snap("")); // 发送 → 清空确认链（不走 onKeyChange）
  await sleep(30);
  assert.equal(st.getItem("crashrestore-sid-c"), null, "发送后槽位应被确认链清除");
});

test("发送失败 rejected：merge 进现有草稿并写回框", async () => {
  const st = mockStorage();
  const { core, restoreCalls } = makeCore(st);
  const sid = "sid-r";
  core.onKeyChange(undefined, sid);
  core.onChange(snap("old draft"));
  await sleep(20);
  core.applyIntent({ type: "rejected", key: sid, text: "failed submission" });
  await sleep(20);
  const stored = JSON.parse(decodeStored(st.getItem("crashrestore-sid-r")) ?? "{}");
  assert.match(stored.value, /failed submission/);
  assert.match(stored.value, /old draft/);
  assert.ok(restoreCalls.some((r) => r.value.includes("failed submission")), "当前框应写回合并结果");
});

test("rejected 经 alias 解析：promote 后对 provisional key 的失败写回落 sid", async () => {
  const st = mockStorage();
  const { core, restoreCalls } = makeCore(st);
  const pk = "new:d5:/tmp/ws";
  core.onKeyChange(undefined, pk);
  core.onChange(snap("first"));
  await sleep(20);
  core.onChange(snap(""));
  core.applyIntent({ type: "sessionCreated", provisionalKey: pk, sessionId: "sid-7" });
  core.applyIntent({ type: "rejected", key: pk, text: "was rejected" }); // core 仍持 provisional key
  await sleep(20);
  assert.match(decodeStored(st.getItem("crashrestore-sid-7")) ?? "", /was rejected/);
  assert.ok(restoreCalls.some((r) => r.value.includes("was rejected")));
});

test("刷新模拟：新实例同 storage，打开即 scan 恢复", async () => {
  const st = mockStorage();
  const { core: coreA } = makeCore(st);
  coreA.onKeyChange(undefined, "new:d6:/tmp/ws");
  coreA.onChange(snap("survives reload"));
  await sleep(20);
  coreA.dispose();

  const { core: coreB, restoreCalls } = makeCore(st);
  coreB.onKeyChange(undefined, "new:d7:/tmp/ws"); // 新 draftId，同 cwd 族
  coreB.onChange(snap(""));
  await sleep(30);
  assert.ok(restoreCalls.some((r) => r.value === "survives reload"));
});

test("旧 per-tab 槽位迁移：crashrestore-<key>-<tabId> → 共享槽位", async () => {
  const st = mockStorage();
  const legacy = Buffer.from(JSON.stringify({ value: "legacy text", images: [] }), "utf8").toString("base64");
  st.setItem("crashrestore-new:oldtab:/tmp/ws-tab42", `123:${legacy}`);
  const { core, restoreCalls } = makeCore(st);
  core.onKeyChange(undefined, "new:any:/tmp/ws");
  core.onChange(snap(""));
  await sleep(30);
  assert.ok(restoreCalls.some((r) => r.value === "legacy text"), "迁移后应恢复");
  assert.match(decodeStored(st.getItem("crashrestore-new:/tmp/ws")) ?? "", /legacy text/);
  assert.equal(st.getItem("crashrestore-new:oldtab:/tmp/ws-tab42"), null, "旧槽位应被清理");
});

test("mergeSubmission 语义：提交在前、原稿在后、重复不加", () => {
  assert.equal(mergeSubmission("failed", [], "old", []).value, "failed\n\nold");
  assert.equal(mergeSubmission("same", [], "same", []).value, "same");
  assert.equal(mergeSubmission("only", [], "", []).value, "only");
});

test("suppress 快照不写不清", async () => {
  const st = mockStorage();
  const { core } = makeCore(st);
  core.onKeyChange(undefined, "sid-s");
  core.onChange(snap("temp prefill", { suppress: true }));
  await sleep(20);
  assert.equal(st.getItem("crashrestore-sid-s"), null);
  core.onChange(snap("", { suppress: true }));
  await sleep(30);
  assert.equal(st.getItem("crashrestore-sid-s"), null);
});

test("发送清空确认窗口内 scan 不复活刚发走的草稿（edit-from-here 发送链路）", async () => {
  const st = mockStorage();
  const { core, restoreCalls } = makeCore(st);
  core.onKeyChange(undefined, "sid-1");
  core.onChange(snap(""));
  // suppress 被宿主旧广播击穿的形态：预填文本落进槽位
  core.onChange(snap("MSG"));
  await sleep(10); // flush 落盘
  assert.ok(st.getItem("crashrestore-sid-1"));
  // 发送：清空 + enhancersVersion 补偿 effect 重跑（onKeyChange(S,S) 重挂 scan）
  core.onChange(snap(""));
  core.onKeyChange("sid-1", "sid-1");
  core.onChange(snap("")); // pendingScan → scan：确认窗口内必须否决
  assert.equal(restoreCalls.length, 0); // 不恢复
  await sleep(30); // 清空确认到期
  assert.equal(st.getItem("crashrestore-sid-1"), null); // 槽位已清
});

test("确认窗口过后 scan 恢复能力不受否决影响（他窗新写的草稿仍能同步进框）", async () => {
  const st = mockStorage();
  const { core, restoreCalls } = makeCore(st);
  core.onKeyChange(undefined, "sid-2");
  core.onChange(snap(""));
  core.onChange(snap("draft"));
  await sleep(10);
  core.onChange(snap("")); // 清空 → 确认窗口
  core.onKeyChange("sid-2", "sid-2");
  core.onChange(snap("")); // 窗口内 scan：否决
  assert.equal(restoreCalls.length, 0);
  await sleep(30); // 确认走完，槽位已清
  assert.equal(st.getItem("crashrestore-sid-2"), null);
  // 他窗后来写入的新草稿 → 仍能正常恢复
  st.setItem("crashrestore-sid-2", `${Date.now()}:${btoa(JSON.stringify({ value: "from other window", images: [] }))}`);
  core.onKeyChange("sid-2", "sid-2");
  core.onChange(snap(""));
  assert.equal(restoreCalls.length, 1);
  assert.equal(restoreCalls[0].value, "from other window");
});

test("clearAllDrafts 清本会话全部槽位（含旧 per-tab 残留）", async () => {
  const st = mockStorage();
  const { core } = makeCore(st);
  core.onKeyChange(undefined, "sid-x");
  core.onChange(snap("live"));
  await sleep(20);
  st.setItem("crashrestore-sid-x-tab1", "1:abcd");
  core.clearAllDrafts("sid-x");
  assert.equal(st.getItem("crashrestore-sid-x"), null);
  assert.equal(st.getItem("crashrestore-sid-x-tab1"), null);
});

test("pruneStale：过期槽位清理、新槽位保留、活跃会话不受影响", async () => {
  const st = mockStorage();
  const { core } = makeCore(st);
  // 活跃槽位（新写入）
  core.onKeyChange(undefined, "sid-live");
  core.onChange(snap("live draft"));
  await sleep(20);
  // 8 天前的陈旧槽位 + 无 ts 旧格式
  const old = Buffer.from(JSON.stringify({ value: "stale", images: [] }), "utf8").toString("base64");
  st.setItem("crashrestore-sid-old", `${Date.now() - 8 * 24 * 60 * 60 * 1000}:${old}`);
  st.setItem("crashrestore-sid-nots", old); // 无 ts 前缀 → 旧格式，清
  const removed = core.pruneStale();
  assert.ok(removed >= 2, `应清理 ≥2 条，实际 ${removed}`);
  assert.equal(st.getItem("crashrestore-sid-old"), null);
  assert.equal(st.getItem("crashrestore-sid-nots"), null);
  assert.ok(st.getItem("crashrestore-sid-live"), "活跃槽位保留");
});

test("sessionCreated 后 core 的 key 广播（pk→sid）幂等：重定向不破坏、新输入仍落 sid", async () => {
  const st = mockStorage();
  const { core, restoreCalls } = makeCore(st);
  const pk = "new:d9:/tmp/ws";
  core.onKeyChange(undefined, pk);
  core.onChange(snap("sent msg"));
  await sleep(20);
  core.onChange(snap(""));
  core.applyIntent({ type: "sessionCreated", provisionalKey: pk, sessionId: "sid-6" });
  // React 稍后补发 key 广播（enhancersVersion 补偿 / draftKey prop 切换）
  core.onKeyChange(pk, "sid-6");
  core.onChange(snap(""));            // remount 空框
  await sleep(30);
  assert.equal(st.getItem("crashrestore-new:/tmp/ws"), null, "provisional 保持已清");
  core.onChange(snap("typed after promote"));
  await sleep(20);
  assert.match(decodeStored(st.getItem("crashrestore-sid-6")) ?? "", /typed after promote/);
  assert.ok(restoreCalls.every(r => !r.value.includes("sent msg")), "已发送消息不得复活");
});

test("sessionCreated 未发生（旧 core 回退路径）时 clearDraft 也清 provisional", async () => {
  const st = mockStorage();
  const { core } = makeCore(st);
  const pk = "new:da:/tmp/ws";
  core.onKeyChange(undefined, pk);
  core.onChange(snap("legacy path"));
  await sleep(20);
  core.clearDraft(pk); // deprecated v1 方法（applyDraftIntent 回退用）
  await sleep(20);
  assert.equal(st.getItem("crashrestore-new:/tmp/ws"), null);
});

test("slotKeyOf 归一化：draftId 自身含冒号（?cwd= 引导的 initial:<cwd>）不污染 cwd 段", async () => {
  const st = mockStorage();
  const { core, restoreCalls } = makeCore(st);
  // ?cwd= 引导：draftId = initial:/tmp/ws → draftKey 含双份 cwd
  core.onKeyChange(undefined, "new:initial:/tmp/ws:/tmp/ws");
  core.onChange(snap("guided entry"));
  await sleep(20);
  // 普通 uuid draftId 的新建页（用户日常路径）必须读到同一份草稿
  const st2keys = () => [...st._map.keys()];
  assert.ok(st2keys().some(k => k === "crashrestore-new:/tmp/ws"), `应归一化到共享槽位，实际 ${st2keys()}`);
  core.onKeyChange("new:initial:/tmp/ws:/tmp/ws", "new:uuid-1:/tmp/ws");
  core.onChange(snap(""));
  await sleep(30);
  assert.ok(restoreCalls.some(r => r.value === "guided entry"), "日常路径应恢复引导入口写的草稿");
});

test("废弃 draftId 残留写回修复：发送后 flushAll 不再污染共享槽位", async () => {
  // 回归：归一化槽位 crashrestore-new:<cwd> 按 cwd 共享，drafts 却按 draftId 存。——
  // 旧实现 onKeyChange 只 flushAll 不清理废弃 new:* 副本，发送后 sessionCreated 只清当前
  // pk，导致废弃 draftId 的残留经 flushAll 写回共享槽位（新建会话发送后残留）。
  const st = mockStorage();
  const { core } = makeCore(st);
  // 废弃 draftId，输入后切走（旧实现：drafts[old1] 残留内存）
  core.onKeyChange(undefined, "new:old1:/tmp/ws");
  core.onChange(snap("stale leftover"));
  await sleep(20);
  assert.ok(st.getItem("crashrestore-new:/tmp/ws"), "废弃草稿先落盘一次");
  core.onKeyChange("new:old1:/tmp/ws", "sid-other"); // 切走 → 旧实现残留 drafts[old1]
  // 当前新建页（新 draftId）输入并发送
  core.onKeyChange("sid-other", "new:cur:/tmp/ws");
  core.onChange(snap("fresh"));
  await sleep(20);
  core.onChange(snap(""));
  core.applyIntent({ type: "sessionCreated", provisionalKey: "new:cur:/tmp/ws", sessionId: "sid-9" });
  core.onKeyChange("new:cur:/tmp/ws", "sid-9");
  await sleep(40); // 确认链 + 落盘全部走完
  assert.equal(st.getItem("crashrestore-new:/tmp/ws"), null, "废弃 draftId 的残留不得写回共享槽位");
});

test("清空立即清挂起 flush：确认窗内 onKeyChange 不写回（发送即清的根因回归）", async () => {
  const st = mockStorage();
  const { core } = makeCore(st);
  core.onKeyChange(undefined, "new:w1:/tmp/ws");
  core.onChange(snap("to send"));
  // 不等待 flush 落盘：立即清空（发送）。修复后 onChange("") 应清掉挂起的 flush 定时器
  // 与内存副本，使槽位从未落盘（旧实现：留给 5ms 后 flush 落盘 → 残留）。
  core.onChange(snap(""));
  assert.equal(st.getItem("crashrestore-new:/tmp/ws"), null, "清空即清挂起 flush，槽位不落盘");
  // 确认链窗口内立即切走（onKeyChange 内 flushAll）：不得把已清除草稿写回
  core.onKeyChange("new:w1:/tmp/ws", "sid-9");
  assert.equal(st.getItem("crashrestore-new:/tmp/ws"), null, "确认窗内 flushAll 不得写回已清除草稿");
  await sleep(40); // 确认链到期 → clearSlot 幂等
  assert.equal(st.getItem("crashrestore-new:/tmp/ws"), null, "确认链到期后槽位保持已清");
});

test("废弃 new:* 内存副本随 onKeyChange 清理：切回经 scan 恢复仍不丢", async () => {
  const st = mockStorage();
  const { core, restoreCalls } = makeCore(st);
  core.onKeyChange(undefined, "new:keep:/tmp/ws");
  core.onChange(snap("keep me"));
  await sleep(20);
  core.onKeyChange("new:keep:/tmp/ws", "sid-a"); // 切走：flushAll 落盘 + 清内存副本
  // 切回（新 draftId），scan 从共享槽位恢复
  core.onKeyChange("sid-a", "new:any:/tmp/ws");
  core.onChange(snap(""));
  await sleep(40);
  assert.ok(restoreCalls.some((r) => r.value === "keep me"), "切回应经 scan 恢复，不丢草稿");
  assert.match(decodeStored(st.getItem("crashrestore-new:/tmp/ws")) ?? "", /keep me/, "恢复后槽位保留");
});

test("中文/混合草稿编码无损（TextEncoder→btoa 链路）", async () => {
  const st = mockStorage();
  const cn = "外部 agent 的 modesl切换支持。1、拿到外部的models 🤖 emoji too";
  const { core: coreA } = makeCore(st);
  coreA.onKeyChange(undefined, "sid-cn");
  coreA.onChange(snap(cn));
  await sleep(20);
  coreA.dispose();
  // 刷新模拟：新实例同 key 打开
  const { core: coreB, restoreCalls } = makeCore(st);
  coreB.onKeyChange(undefined, "sid-cn");
  coreB.onChange(snap(""));
  await sleep(30);
  assert.ok(restoreCalls.some((r) => r.value === cn), "中文+emoji 草稿应无损恢复");
});
