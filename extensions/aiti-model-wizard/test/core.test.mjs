// wizard core 单元测试：多 key 写入/清空/删除/改名/状态打码（models.json provider.apiKeys 存储）
import { createRequire } from "module";
import fs from "node:fs"; import path from "node:path"; import os from "node:os";
import { Tester } from "../../../pi-models-combo/test/util.mjs";

const require = createRequire(import.meta.url);
const wz = require("../core.cjs");
const { ok, finish } = Tester();
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wizard-"));
const modelsFile = path.join(dir, "models.json");
// autoRefresh:false：纯变换路径不碰网络（models.dev 强制刷新另在 ⑪ 用注入下载器专测）
const cfg = { modelsPath: modelsFile, catalog: { autoRefresh: false } };
const read = () => JSON.parse(fs.readFileSync(modelsFile, "utf8"));

// ① upsertProviderData 纯变换（pi-web 路径）
const data = { providers: {} };
wz.upsertProviderData(data, { provider: "zhipu", baseUrl: "https://open.bigmodel.cn/api/paas/v4", api: "openai-completions", keys: [{ name: "a", key: "sk-z1" }, { name: "b", key: "sk-z2" }], models: [] });
ok("① upsertProviderData 写 apiKeys + apiKey=first", data.providers.zhipu.apiKeys.length === 2 && data.providers.zhipu.apiKey === "sk-z1");
ok("① baseUrl 尾斜杠去除", data.providers.zhipu.baseUrl === "https://open.bigmodel.cn/api/paas/v4");

// ①b 元数据反填：wizard 只传 {id}，应自动从 models-store 补 contextWindow/maxTokens/compat/reasoning
const storeMeta = { deepseek: { models: [{ id: "deepseek-v4-pro", contextWindow: 1000000, maxTokens: 384000, reasoning: true, compat: { supportsDeveloperRole: false, thinkingFormat: "deepseek" } }] } };
const d2 = { providers: {} };
wz.upsertProviderData(d2, { provider: "deepseek", baseUrl: "x", api: "openai-completions", models: [{ id: "deepseek-v4-pro" }], store: storeMeta });
const ds = d2.providers.deepseek.models[0];
ok("①b 只传{id}→ 反填 ctx=1M/max=384k/reasoning=true/compat", ds.contextWindow === 1000000 && ds.maxTokens === 384000 && ds.reasoning === true && ds.compat && ds.compat.thinkingFormat === "deepseek", JSON.stringify(ds));
// ①c 显式 reasoning:false 尊重用户（不反填为 true），但 ctx/max 仍补
const d3 = { providers: {} };
wz.upsertProviderData(d3, { provider: "deepseek", baseUrl: "x", api: "openai-completions", models: [{ id: "deepseek-v4-pro", reasoning: false }], store: storeMeta });
const ds3 = d3.providers.deepseek.models[0];
ok("①c 显式 reasoning:false 保留 + ctx/max 仍反填", ds3.reasoning === false && ds3.contextWindow === 1000000, JSON.stringify(ds3));

// ② 直接文件路径（agent 工具路径，async）：保存带 key
const save = await wz.upsertProvider(dir, cfg, { provider: "openrouter", baseUrl: "https://openrouter.ai/api/v1/", api: "openai-completions", keys: [{ name: "k1", key: "sk-aaa", rpm: 60 }, { name: "k1", key: "sk-bbb" }], models: [{ id: "gpt-4o" }] });
ok("② upsertProvider ok + apiKeys 落盘", !!save.ok && read().providers.openrouter.apiKeys.length === 2);
ok("② 重复名 k1→k1-2", read().providers.openrouter.apiKeys[1].name === "k1-2");

// ③ providersStatus：keys 打码 + keyCount
const st = wz.providersStatus(dir, cfg);
const p = st.providers.find((x) => x.provider === "openrouter");
ok("③ providersStatus keyCount=2 + keys 打码", p.keyCount === 2 && p.keys.every((k) => k.key === "***"), JSON.stringify(p.keys));

// ④ setProviderKeys 移除一个
const kept = wz.setProviderKeys(dir, cfg, "openrouter", wz.getProviderKeys(dir, cfg, "openrouter").filter((k) => k.name !== "k1"));
ok("④ remove k1 后剩 1 个（k1-2 改名）", read().providers.openrouter.apiKeys.length === 1 && read().providers.openrouter.apiKeys[0].name === "k1-2");
ok("④ apiKey 同步为剩下那个", read().providers.openrouter.apiKey === "sk-bbb");

// ⑤ setProviderKeys 清空 → apiKeys/apiKey 删除
const clr = wz.setProviderKeys(dir, cfg, "openrouter", []);
ok("⑤ 清空 ok", !!clr.ok);
ok("⑤ 清空后 apiKeys/apiKey 都不存在", !("apiKeys" in read().providers.openrouter) && !("apiKey" in read().providers.openrouter));

// ⑤b 临时禁用 key（enabled:false）：apiKey 自动切到第一把启用的 key，配置不删除
await wz.upsertProvider(dir, cfg, { provider: "diskeys", baseUrl: "https://d.com", api: "openai-completions", keys: [{ name: "a", key: "sk-d1" }, { name: "b", key: "sk-d2" }, { name: "c", key: "sk-d3" }], models: [] });
ok("⑤b 三把全启用 apiKey=第一把", read().providers.diskeys.apiKey === "sk-d1");
wz.setProviderKeys(dir, cfg, "diskeys", [{ name: "a", key: "sk-d1", enabled: false }, { name: "b", key: "sk-d2" }, { name: "c", key: "sk-d3" }]);
ok("⑤b 禁用首 key → apiKey 切到 sk-d2 + enabled 落库", read().providers.diskeys.apiKey === "sk-d2" && read().providers.diskeys.apiKeys[0].enabled === false);
ok("⑤b normalizeKeyEntry 透传 enabled:false", wz.normalizeKeyEntry({ name: "x", key: "sk-x", enabled: false }).enabled === false);
ok("⑤b maskKeyEntry 透传 enabled:false（key 打码）", wz.maskKeyEntry({ name: "x", key: "sk-1234567890", enabled: false }).enabled === false && wz.maskKeyEntry({ name: "x", key: "sk-1234567890" }).key === "sk-***7890");
wz.setProviderKeys(dir, cfg, "diskeys", [{ name: "a", key: "sk-d1" }, { name: "b", key: "sk-d2" }, { name: "c", key: "sk-d3" }]);
ok("⑤b 重新启用 → apiKey 回 sk-d1 且 enabled 标记清除", read().providers.diskeys.apiKey === "sk-d1" && !("enabled" in read().providers.diskeys.apiKeys[0]));

// ⑤c provider / 模型 级 enabled:false：providersStatus 透出（引擎过滤在 pi-models-combo 侧单测）
fs.writeFileSync(modelsFile, JSON.stringify({ providers: { disabledProv: { baseUrl: "https://dp.com", api: "openai-completions", apiKey: "sk-dp", enabled: false, models: [{ id: "m1", enabled: false }, { id: "m2" }] } } }));
const st2 = wz.providersStatus(dir, cfg);
const dp = st2.providers.find((x) => x.provider === "disabledProv");
ok("⑤c providersStatus 透出 provider.enabled:false", dp && dp.enabled === false);
ok("⑤c providersStatus 透出模型级 enabled（m1 禁 / m2 启）", dp.models.some((m) => m.id === "m1" && m.enabled === false) && dp.models.some((m) => m.id === "m2" && m.enabled !== false));

// ⑤d comboPageData：聚合组 / 虚拟模型 / 成员 enabled 透出
const cd = wz.comboPageData({ providers: { g1: { combo: true, baseUrl: "http://combo.pmc.invalid/", enabled: false, models: [{ id: "fast", enabled: false, combo: { members: [{ provider: "pa", model: "ma", weight: 10, enabled: false }] } }] } } }, {});
ok("⑤d comboPageData 组/虚拟模型/成员 enabled 透出", cd.combos[0].enabled === false && cd.combos[0].models[0].enabled === false && cd.combos[0].models[0].members[0].enabled === false);

// ⑤e comboSaveProviderData：保留成员/虚拟模型 enabled + 全禁成员拒绝
const cdata = { providers: {
  pa: { baseUrl: "https://pa.com", apiKey: "sk-pa", models: [{ id: "ma", api: "openai-completions" }] },
  pb: { baseUrl: "https://pb.com", apiKey: "sk-pb", models: [{ id: "mb", api: "openai-completions" }] },
} };
const cr = wz.comboSaveProviderData(cdata, { provider: "g2", displayName: "组2", models: [{ id: "fast", members: [{ provider: "pa", model: "ma", enabled: false }, { provider: "pb", model: "mb" }] }] }, null, null);
ok("⑤e 保存保留成员 enabled（ma 禁 / mb 启）", cr.ok && cdata.providers.g2.models[0].combo.members[0].enabled === false && !("enabled" in cdata.providers.g2.models[0].combo.members[1]), JSON.stringify(cr));
const cr2 = wz.comboSaveProviderData({ providers: { pa: { baseUrl: "https://pa.com", apiKey: "sk-pa", models: [{ id: "ma", api: "openai-completions" }] } } }, { provider: "g3", displayName: "组3", models: [{ id: "fast", members: [{ provider: "pa", model: "ma", enabled: false }] }] }, null, null);
ok("⑤e 全部成员禁用 → 拒绝保存", cr2.ok === false && /已禁用/.test(cr2.error || ""), JSON.stringify(cr2));

// ⑥ 改名（renameFrom 场景）：老 provider 的 key 应一并消失（keys 写在同一 provider 对象里）
await wz.upsertProvider(dir, cfg, { provider: "old", baseUrl: "https://x.com", api: "openai-completions", keys: [{ name: "a", key: "sk-old" }], models: [] });
await wz.upsertProvider(dir, cfg, { provider: "new", baseUrl: "https://y.com", api: "openai-completions", keys: [{ name: "a", key: "sk-new" }], models: [] });
const delOld = wz.deleteProvider(dir, cfg, "old");
ok("⑥ deleteProvider 删除 old", !!delOld.ok && !("old" in read().providers));
ok("⑥ new 保留 apiKeys", read().providers.new.apiKeys[0].key === "sk-new");

// ⑦ 单 key 兼容：不传 keys 只传 apiKey
await wz.upsertProvider(dir, cfg, { provider: "single", baseUrl: "https://s.com", api: "openai-completions", apiKey: "sk-single", models: [] });
ok("⑦ 单 key 路径正常（无 apiKeys 字段）", read().providers.single.apiKey === "sk-single" && !("apiKeys" in read().providers.single));

// ⑧ maskKey/maskKeyEntry 工具（>8 字符保留前3+后4）
ok("⑧ maskKey 打码", wz.maskKey("sk-abcdef1234") === "sk-***1234");

// ===== ⑨ 新模型检测与提醒（前日/今日快照 + toast 频控） =====
const remCfg = { modelsPath: modelsFile, reminder: { maxPerDay: 3, minGapMs: 2 * 60 * 60 * 1000 } };
// 首次配置：无前日基线 → 不提示（建基线）
wz.snapshotProvider(dir, "X", ["a", "b"], { merge: true });
fs.writeFileSync(modelsFile, JSON.stringify({ providers: { X: { apiKey: "sk-x", models: [{ id: "a" }, { id: "b" }] } } }));
let nm = wz.computeNewModels(dir, remCfg);
ok("⑨ 首次（无前日基线）不提示", nm.total === 0 && nm.baseline === false);
// 跨天：prev={X:[a,b]}，今日扫描拉到 [a,b,c] → 新=c
wz.rollReminder(dir, Date.now() + 86400000);
wz.snapshotProvider(dir, "X", ["a", "b", "c"]);
nm = wz.computeNewModels(dir, remCfg);
ok("⑨ 跨天后发现新模型 c", nm.total === 1 && nm.providers.X.count === 1 && nm.providers.X.newModels[0] === "c", JSON.stringify(nm));
// 已配置 c 后 → 新增消失（不重复提醒）
fs.writeFileSync(modelsFile, JSON.stringify({ providers: { X: { apiKey: "sk-x", models: [{ id: "a" }, { id: "b" }, { id: "c" }] } } }));
ok("⑨ 启用新模型后不再提示", wz.computeNewModels(dir, remCfg).total === 0);
// 编辑流预勾选：未启用 c 时 newModelsForProvider 返回 c
fs.writeFileSync(modelsFile, JSON.stringify({ providers: { X: { apiKey: "sk-x", models: [{ id: "a" }, { id: "b" }] } } }));
ok("⑨ newModelsForProvider=[c]", wz.newModelsForProvider(dir, remCfg, "X").join(",") === "c");
ok("⑨ newModelsForProvider 不存在 provider=[]", wz.newModelsForProvider(dir, remCfg, "ZZZ").length === 0);
// toast 频控：放行 → 同刻阻止(gap) → 2h 后放行 → 第 4 次 daily-limit → 跨天 count 重置但 gap 仍生效
ok("⑨ toast 第1次放行", wz.toastDecision(dir, remCfg).allowed === true);
wz.markToastShown(dir, remCfg);
ok("⑨ 同刻再次被 gap 阻止", wz.toastDecision(dir, remCfg).allowed === false && wz.toastDecision(dir, remCfg).reason === "gap");
let r = wz.loadReminder(dir); r.toast.lastAt = Date.now() - 3 * 3600 * 1000; wz.saveReminder(dir, r);
ok("⑨ 2h 后放行", wz.toastDecision(dir, remCfg).allowed === true);
wz.markToastShown(dir, remCfg); wz.markToastShown(dir, remCfg);
ok("⑨ 第4次 daily-limit", wz.toastDecision(dir, remCfg).allowed === false && wz.toastDecision(dir, remCfg).reason === "daily-limit");
r = wz.loadReminder(dir); r.toast.day = "2000-01-01"; wz.saveReminder(dir, r);
ok("⑨ 跨天 count 重置、gap 仍生效", wz.toastDecision(dir, remCfg).allowed === false && wz.toastDecision(dir, remCfg).count === 0);
// 删除 provider 同步清快照
wz.removeReminderProvider(dir, "X");
ok("⑨ 删除后无新模型", wz.computeNewModels(dir, remCfg).total === 0 && !wz.computeNewModels(dir, remCfg).providers.X);

// —— ⑨b pending 待告知集（错过 toast 不丢）：跨天滚动保留 / ack 同日不弹回 / 单 id ack / 幽灵清理 ——
fs.writeFileSync(modelsFile, JSON.stringify({ providers: { X: { apiKey: "sk-x", models: [{ id: "a" }, { id: "b" }] }, Y: { apiKey: "sk-y", models: [{ id: "p0" }] } } }));
wz.snapshotProvider(dir, "Y", ["p0"]);
wz.rollReminder(dir, Date.now() + 2 * 86400000);            // 跨天：prev={Y:[p0]}
wz.snapshotProvider(dir, "Y", ["p0", "p1"]);               // 今日扫描发现 p1
nm = wz.computeNewModels(dir, remCfg);
ok("⑨b 发现 p1 入待告知集", nm.total === 1 && nm.providers.Y && nm.providers.Y.newModels[0] === "p1", JSON.stringify(nm));
wz.rollReminder(dir, Date.now() + 3 * 86400000);            // 再跨天，且今日扫描与昨日相同 → 当日 diff=0
wz.snapshotProvider(dir, "Y", ["p0", "p1"]);
nm = wz.computeNewModels(dir, remCfg);
ok("⑨b 跨天滚动后 pending 保留（旧逻辑归零）", nm.total === 1 && nm.providers.Y && nm.providers.Y.newModels[0] === "p1", JSON.stringify(nm));
wz.ackNewModels(dir, "Y");                                   // 全量 ack
nm = wz.computeNewModels(dir, remCfg);
ok("⑨b ack 后同日 diff 不弹回", nm.total === 0, JSON.stringify(nm));
wz.snapshotProvider(dir, "Y", ["p2"], { merge: true });     // 又发现 p2
nm = wz.computeNewModels(dir, remCfg);
ok("⑨b 新 id 仍会入集", nm.total === 1 && nm.providers.Y && nm.providers.Y.newModels[0] === "p2", JSON.stringify(nm));
wz.ackNewModels(dir, "Y", ["p2"]);                           // 单 id ack
ok("⑨b 单 id ack 清除", wz.computeNewModels(dir, remCfg).total === 0);
// 活 diff 下的 acked 回归点：同日扫描又出 p9（diff 活着）→ ack → 立即重算不得弹回
wz.snapshotProvider(dir, "Y", ["p0", "p1", "p9"]);
nm = wz.computeNewModels(dir, remCfg);
ok("⑨b 同日新 diff 只含未 ack 的 p9", nm.total === 1 && nm.providers.Y && nm.providers.Y.newModels[0] === "p9", JSON.stringify(nm));
wz.ackNewModels(dir, "Y");
nm = wz.computeNewModels(dir, remCfg);
ok("⑨b ack 后活 diff 不弹回（acked 记录）", nm.total === 0, JSON.stringify(nm));
// —— ⑨c 整目录漂移降噪：单家一次新增超过阈值 → 不提醒（厂商整包更新不刷屏）——
{
  const bigPrev = Array.from({ length: 40 }, (_, i) => "big-" + i);
  const bigCurr = [...bigPrev, ...Array.from({ length: 15 }, (_, i) => "drift-" + i)]; // 新增 15 > max(10, ceil(55*0.25)=14)
  fs.writeFileSync(modelsFile, JSON.stringify({ providers: { BIG: { apiKey: "sk-b", models: [] } } }));
  wz.snapshotProvider(dir, "BIG", bigPrev);   // 昨日快照（真实今天写入今日桶）
  const crossDay = () => { const rr2 = wz.loadReminder(dir); rr2.prev = rr2.curr; rr2.prevDay = rr2.currDay; wz.saveReminder(dir, rr2); };
  crossDay();                                  // 跨天滚动：prev={BIG:[big-*]}（避免未来时间戳与 snapshotProvider 的 now 滚动互踩）
  wz.snapshotProvider(dir, "BIG", bigCurr);   // 今日扫描拉到整包新增
  nm = wz.computeNewModels(dir, remCfg);
  ok("⑨c 超阈值整包新增被降噪（15 > 14）", nm.total === 0 && !nm.providers.BIG, JSON.stringify(nm));
  const bigCurr2 = [...bigPrev, "add-1", "add-2"]; // 新增 2 ≤ 阈值 → 正常提醒
  wz.snapshotProvider(dir, "BIG", bigCurr2);
  nm = wz.computeNewModels(dir, remCfg);
  ok("⑨c 小增量仍正常提醒", nm.total === 2 && nm.providers.BIG && nm.providers.BIG.count === 2, JSON.stringify(nm));
}

let rr = wz.loadReminder(dir); rr.pending.Z = ["zz"]; wz.saveReminder(dir, rr); // 幽灵 provider（未配置）
nm = wz.computeNewModels(dir, remCfg);
ok("⑨b 幽灵 provider 自动清理", nm.providers.Z === undefined, JSON.stringify(nm.providers));

// ===== ⑩ providerScanParams：合并 store 补 baseUrl（zai-coding-cn 场景）+ env key + 缺 key/base 标记 =====
// 搭一个临时 store：zai-coding-cn 只存 key，baseUrl/models 在 store；ark-coding 用 env key；nokey 无 key
const storeFile = path.join(dir, "models-store.json");
const scanCfg = { modelsPath: modelsFile, modelsStorePath: storeFile };
fs.writeFileSync(storeFile, JSON.stringify({ "zai-coding-cn": { models: [{"id": "glm-4.6", "baseUrl": "https://open.bigmodel.cn/api/coding/paas/v4"}] } }));
// 直接写 models.json（upsertProvider 不保留 apiKeyEnv，故用文件写入保证可控）
fs.writeFileSync(modelsFile, JSON.stringify({ providers: {
  "zai-coding-cn": { api: "openai-completions", apiKey: "sk-zai" },
  "ark-coding": { api: "openai-completions", apiKeyEnv: "ARK_API_KEY" },
  "nokey": { baseUrl: "https://x.com", api: "openai-completions" }
} }, null, 2));
const oldEnv = process.env.ARK_API_KEY;
process.env.ARK_API_KEY = "ark-e1";
const sp = wz.providerScanParams(dir, scanCfg);
ok("⑩ zai-coding-cn 合并 store 得 baseUrl", sp.find(x => x.name === "zai-coding-cn")?.baseUrl === "https://open.bigmodel.cn/api/coding/paas/v4");
ok("⑩ ark-coding 经 apiKeyEnv 取 key", sp.find(x => x.name === "ark-coding")?.apiKey === "ark-e1");
ok("⑩ nokey 标记 hasKey=false", sp.find(x => x.name === "nokey")?.hasKey === false && sp.find(x => x.name === "nokey")?.hasBase === true);
if (oldEnv === undefined) delete process.env.ARK_API_KEY; else process.env.ARK_API_KEY = oldEnv;

// ===== ⑪ models.dev 第三源反填：映射 / 定位 / TTL 与强制刷新 / 端到端 =====
// ⑪a mapModelsDevModel 字段映射（ox-alpha-free 真实规格结构）
const mdMapped = wz.mapModelsDevModel({
  id: "ox-alpha-free", name: "Ox Alpha Free (Unlimited)", reasoning: true,
  reasoning_options: [{ type: "effort", values: ["low", "high", "max"] }],
  modalities: { input: ["text", "image", "video"], output: ["text"] },
  limit: { context: 1000000, output: 131072 },
  cost: { input: 0, output: 0, cache_read: 0 },
  interleaved: { field: "reasoning_content" },
});
ok("⑪a ctx/max + input 过滤 video 只留 text/image", mdMapped.contextWindow === 1000000 && mdMapped.maxTokens === 131072 && JSON.stringify(mdMapped.input) === '["text","image"]');
ok("⑪a cost 四字段齐全（cache_write 缺省补 0）", mdMapped.cost.input === 0 && mdMapped.cost.output === 0 && mdMapped.cost.cacheRead === 0 && mdMapped.cost.cacheWrite === 0);
ok("⑪a thinkingLevelMap 全 level 显式化", mdMapped.thinkingLevelMap.low === "low" && mdMapped.thinkingLevelMap.high === "high" && mdMapped.thinkingLevelMap.max === "max" && mdMapped.thinkingLevelMap.medium === null && mdMapped.thinkingLevelMap.off === null);
ok("⑪a interleaved→compat.requiresReasoningContentOnAssistantMessages", mdMapped.compat && mdMapped.compat.requiresReasoningContentOnAssistantMessages === true);

// ⑪b findModelsDevProvider：slug 命中 + baseUrl 兜底匹配（models.json 的 provider 名与目录 slug 不同）
const MD = { providers: { "opencode-go": { id: "opencode-go", name: "OpenCode Go", api: "https://opencode.ai/zen/go/v1", models: { "ox-alpha-free": { id: "ox-alpha-free", name: "Ox Alpha Free (Unlimited)", reasoning: true, limit: { context: 1000000, output: 131072 }, modalities: { input: ["text", "image"] }, cost: { input: 0, output: 0, cache_read: 0 }, reasoning_options: [{ type: "effort", values: ["low", "high"] }], interleaved: { field: "reasoning_content" } } } } } };
const f1 = wz.findModelsDevProvider(MD, "opencode-go");
ok("⑪b slug 精确命中", f1.ok && f1.models.length === 1 && f1.models[0].id === "ox-alpha-free");
const f2 = wz.findModelsDevProvider(MD, "opencode-go-2", "https://opencode.ai/zen/go/v1/");
ok("⑪b baseUrl 归一兜底命中（尾斜杠/不同 provider 名）", f2.ok && f2.slug === "opencode-go" && f2.models[0].id === "ox-alpha-free");
ok("⑪b 未命中返回 ok:false", wz.findModelsDevProvider(MD, "nope", "https://other.com/v1").ok === false && wz.findModelsDevProvider(null, "x").ok === false);

// ⑪c 三源反填优先级 + 未知模型不再落裸 {id}（upsertProviderData 纯变换）
const d4 = { providers: {} };
wz.upsertProviderData(d4, {
  provider: "opencode-go-2", baseUrl: "https://opencode.ai/zen/go/v1", api: "openai-completions",
  models: [{ id: "ox-alpha-free" }, { id: "mine", contextWindow: 42 }], store: {},
  mdModels: (wz.findModelsDevProvider(MD, "opencode-go-2", "https://opencode.ai/zen/go/v1").models),
});
const ox = d4.providers["opencode-go-2"].models.find((m) => m.id === "ox-alpha-free");
ok("⑪c 裸{id}→ 从 models.dev 反填 ctx/max/reasoning/input/cost/thinking/compat", ox.contextWindow === 1000000 && ox.maxTokens === 131072 && ox.reasoning === true && ox.cost && ox.thinkingLevelMap && ox.compat, JSON.stringify(ox));
ok("⑪c 显式值不被目录覆盖（first-wins）", d4.providers["opencode-go-2"].models.find((m) => m.id === "mine").contextWindow === 42);

// ⑪c2 第⑤源 OR/LiteLLM 兑底（extras）：md 未收录的裸条目从公共目录补全；链序 md 先于 extras
{
  const d5 = { providers: {} };
  const r5 = wz.upsertProviderData(d5, {
    provider: "p-x", baseUrl: "https://x.example/v1", api: "openai-completions",
    models: [{ id: "or-only" }, { id: "both-md-wins" }], store: {},
    mdModels: [{ id: "both-md-wins", name: "FromMd", limit: { context: 8000, output: 2000 } }],
    extras: [
      { id: "or-only", meta: { name: "OrOnly", contextWindow: 262144, maxTokens: 16384, cost: { input: 1, output: 2 } }, source: "openrouter" },
      { id: "both-md-wins", meta: { name: "ShouldLose", contextWindow: 999999 }, source: "litellm" },
    ],
  });
  const px = d5.providers["p-x"].models;
  const orOnly = px.find((m) => m.id === "or-only");
  ok("⑪c2 extras 兑底填充裸条目（OR/LiteLLM 链上最后一源）", orOnly.contextWindow === 262144 && orOnly.maxTokens === 16384 && orOnly.cost && orOnly.name === "OrOnly", JSON.stringify(orOnly));
  ok("⑪c2 fills 来源标注 openrouter", (r5.fills.find((f) => f.id === "or-only") || {}).fills?.contextWindow === "openrouter", JSON.stringify(r5.fills));
  const both = px.find((m) => m.id === "both-md-wins");
  ok("⑪c2 md 先于 extras（ctx=8000 非 999999，name=FromMd）", both.contextWindow === 8000 && both.maxTokens === 2000 && both.name === "FromMd", JSON.stringify(both));
}

// ⑪d~g 端到端（独立 tmpdir，隔离真实 ~/.pi；目录缓存种子化，网络用注入下载器）
const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "wizard-md-"));
const catDir = path.join(dir2, "cache", "catalog");
fs.mkdirSync(catDir, { recursive: true });
const writeCat = (obj) => { fs.writeFileSync(path.join(catDir, "models.dev.json"), JSON.stringify(obj)); fs.writeFileSync(path.join(catDir, "meta.json"), JSON.stringify({ ts: Date.now() })); };
writeCat(MD);
const modelsFile2 = path.join(dir2, "models.json");
const storeFile2 = path.join(dir2, "none.json");
const cfg2 = { modelsPath: modelsFile2, modelsStorePath: storeFile2, catalog: { ttlHours: 168 } };
let dlCalls = 0;
const fakeDownload = async () => {
  dlCalls++;
  await new Promise((r) => setTimeout(r, 20)); // 模拟网络延迟，让并发 single-flight 可观察
  writeCat({ providers: { ...MD.providers, newprov: { id: "newprov", api: "https://n.com/v1", models: { "stealth-x": { id: "stealth-x", reasoning: true, limit: { context: 200000, output: 32000 } } } } } });
  return { ok: true, source: "test" };
};

// ⑪d resolveMdForUpsert：目录已有未知模型 → 直接命中不刷新；查不到 → 强制刷新一次后命中
const ra = await wz.resolveMdForUpsert(dir2, cfg2, { provider: "opencode-go-2", baseUrl: "https://opencode.ai/zen/go/v1", models: [{ id: "ox-alpha-free" }], existingModels: [], store: {} });
ok("⑪d 目录已含该模型 → 命中且不触发下载", ra.mdModels.length === 1 && ra.refreshed === false && dlCalls === 0);
const rb = await wz.resolveMdForUpsert(dir2, cfg2, { provider: "newprov", baseUrl: "https://n.com/v1", models: [{ id: "stealth-x" }], existingModels: [], store: {}, _download: fakeDownload });
ok("⑪d 查不到 → 强制刷新一次后命中", rb.refreshed === true && rb.mdModels.some((m) => m.id === "stealth-x") && dlCalls === 1, JSON.stringify({ refreshed: rb.refreshed, dlCalls }));
// autoRefresh:false → 不打网
writeCat(MD); dlCalls = 0;
const rc = await wz.resolveMdForUpsert(dir2, { ...cfg2, catalog: { ttlHours: 168, autoRefresh: false } }, { provider: "newprov", baseUrl: "https://n.com/v1", models: [{ id: "stealth-x" }], existingModels: [], store: {} });
ok("⑪d autoRefresh:false 关闭强制刷新", rc.refreshed === false && dlCalls === 0 && rc.mdModels.length === 0);

// ⑪e ensureCatalog：force 触发注入下载；并发 single-flight 共享同一次
writeCat(MD); dlCalls = 0;
const e1 = await wz.ensureCatalog(dir2, cfg2, { force: true, _download: fakeDownload });
ok("⑪e force 触发刷新且 ok", e1.refreshed === true && e1.ok === true && dlCalls === 1);
dlCalls = 0;
const both = await Promise.all([
  wz.ensureCatalog(dir2, cfg2, { force: true, _download: fakeDownload }),
  wz.ensureCatalog(dir2, cfg2, { force: true, _download: fakeDownload }),
]);
ok("⑪e 并发 single-flight 共享一次下载", dlCalls === 1, "dlCalls=" + dlCalls);

// ⑪f modelParams 三源视图：store 无、models.json 只有裸 {id} → 从 models.dev 补全参数
fs.writeFileSync(modelsFile2, JSON.stringify({ providers: { "opencode-go-2": { baseUrl: "https://opencode.ai/zen/go/v1", api: "openai-completions", apiKey: "sk-k", models: [{ id: "ox-alpha-free" }] } } }));
const mp = await wz.modelParams(dir2, cfg2, "opencode-go-2");
const mpOx = mp.models.find((m) => m.id === "ox-alpha-free");
ok("⑪f modelParams 反填后 ctx=1M + modelsDev.used=true", mp.ok && mpOx.contextWindow === 1000000 && mp.modelsDev.used === true && mp.modelsDev.slug === "opencode-go");

// ⑪g upsertProvider（agent 工具路径）端到端：裸模型落盘即带全参数
dlCalls = 0;
const up = await wz.upsertProvider(dir2, cfg2, { provider: "opencode-go-2", baseUrl: "https://opencode.ai/zen/go/v1", api: "openai-completions", apiKey: "sk-n", keepKey: true, models: [{ id: "ox-alpha-free" }] });
const upModel = JSON.parse(fs.readFileSync(modelsFile2, "utf8")).providers["opencode-go-2"].models[0];
ok("⑪g 落盘带全参数 + catalogRefreshed=false（未触发下载）", up.ok === true && up.catalogRefreshed === false && upModel.contextWindow === 1000000 && upModel.reasoning === true && dlCalls === 0);

// ⑫ 厂商 /models 富字段 + OpenRouter/LiteLLM 兜底源
// ⑫a modelListExtra：各家兼容网关实际返回的参数键（Groq/Mistral/Together/Gemini/vLLM）
ok("⑫a Groq context_window", wz.modelListExtra({ id: "llama-3", context_window: 131072 }).contextWindow === 131072);
ok("⑫a Mistral max_context_length + Gemini inputTokenLimit/outputTokenLimit", wz.modelListExtra({ max_context_length: 32768 }).contextWindow === 32768 && (() => { const e = wz.modelListExtra({ inputTokenLimit: 1048576, outputTokenLimit: 8192 }); return e.contextWindow === 1048576 && e.maxTokens === 8192; })());
ok("⑫a 裸 {id} 不猜（无歧义键时返回 null）", wz.modelListExtra({ id: "gpt-x", max_tokens: 4096 }) === null);
// ⑫b mapOpenRouterModel：ctx/pricing×1e6/modalities/supported_parameters→reasoning/top_provider.max_completion_tokens
const orm = wz.mapOpenRouterModel({
  id: "deepseek/deepseek-v4-pro", context_length: 1048576,
  pricing: { prompt: "0.000001122", completion: "0.000003366", input_cache_read: "0.0000000374" },
  architecture: { input_modalities: ["text", "image"] },
  supported_parameters: ["tools", "reasoning_effort"],
  top_provider: { max_completion_tokens: 65536 },
});
ok("⑫b OR ctx/max/input/reasoning", orm.contextWindow === 1048576 && orm.maxTokens === 65536 && JSON.stringify(orm.input) === '["text","image"]' && orm.reasoning === true);
ok("⑫b OR pricing $/token→$/M（四位小数）", orm.cost.input === 1.122 && orm.cost.output === 3.366 && orm.cost.cacheRead === 0.0374 && orm.cost.cacheWrite === 0);
// ⑫c findOpenRouterModel：精确 → 后缀匹配取 created 最新（条目带可映射字段供 ⑪h 复用）
const ORD = [
  { id: "vendor-a/mymodel", created: 100, context_length: 131072, pricing: { prompt: "0", completion: "0" }, architecture: { input_modalities: ["text"] }, supported_parameters: ["tools"] },
  { id: "vendor-b/mymodel", created: 200, context_length: 262144, pricing: { prompt: "0", completion: "0" }, architecture: { input_modalities: ["text"] }, supported_parameters: ["tools"] },
  { id: "other/x" },
];
ok("⑫c OR 精确命中", wz.findOpenRouterModel(ORD, "other/x").id === "other/x");
ok("⑫c OR 后缀匹配取最新", wz.findOpenRouterModel(ORD, "mymodel").id === "vendor-b/mymodel");
// ⑫d LiteLLM：归一尾段匹配（大小写/分隔符差异）+ 保守映射（只信 max_input/max_output_tokens）
const LLD = {
  "azure_ai/FW-DeepSeek-V4-Pro": { max_input_tokens: 163840, max_output_tokens: 163840, input_cost_per_token: 6.2e-7, output_cost_per_token: 1.85e-6, cache_read_input_token_cost: 3.1e-8, supports_reasoning: true },
  "deepseek/deepseek-chat": { max_input_tokens: 65536, max_output_tokens: 8192, input_cost_per_token: 2.7e-7, output_cost_per_token: 1.1e-6, mode: "chat" },
};
const lle = wz.findLiteLlmEntry(LLD, "FW-DeepSeek-V4-Pro");
ok("⑫d LLM 归一匹配（大小写不同也命中）", !!lle && lle.max_input_tokens === 163840);
const llm = wz.mapLiteLlmModel(lle);
ok("⑫d LLM ctx/max/cost×1e6/supports_reasoning", llm.contextWindow === 163840 && llm.maxTokens === 163840 && llm.reasoning === true && llm.cost.input === 0.62 && llm.cost.cacheRead === 0.031);
ok("⑫d LLM 未命中返回 null", wz.findLiteLlmEntry(LLD, "nonexistent-model") === null);
// ⑪e ensureAuxAll：注入下载器 + stale 触发 + single-flight
writeCat(MD); dlCalls = 0;
let orDl = 0, llDl = 0;
const dlOR = async () => { orDl++; await new Promise((r) => setTimeout(r, 15)); fs.writeFileSync(path.join(catDir, "openrouter.json"), JSON.stringify(ORD)); fs.writeFileSync(path.join(catDir, "openrouter.meta.json"), JSON.stringify({ ts: Date.now() })); return { ok: true };
};
const dlLL = async () => { llDl++; fs.writeFileSync(path.join(catDir, "litellm.json"), JSON.stringify(LLD)); fs.writeFileSync(path.join(catDir, "litellm.meta.json"), JSON.stringify({ ts: Date.now() })); return { ok: true };
};
const auxR = await wz.ensureAuxAll(dir2, cfg2, { _dlOpenRouter: dlOR, _dlLiteLlm: dlLL });
ok("⑪e aux 首次无缓存都下载", auxR.openrouter.refreshed === true && auxR.litellm.refreshed === true && orDl === 1 && llDl === 1);
await Promise.all([wz.ensureAuxAll(dir2, cfg2, { _dlOpenRouter: dlOR, _dlLiteLlm: dlLL }), wz.ensureAuxAll(dir2, cfg2, { _dlOpenRouter: dlOR, _dlLiteLlm: dlLL })]);
ok("⑪e aux 新鲜后不再下载", orDl === 1 && llDl === 1);
// ⑪h resolveMdForUpsert 五源端到端：models.dev 没有的模型 → OpenRouter 兑底；autoRefresh:false 时用已有缓存
fs.writeFileSync(modelsFile2, JSON.stringify({ providers: {} }));
dlCalls = 0;
const rh = await wz.resolveMdForUpsert(dir2, cfg2, { provider: "someprov", baseUrl: "https://s.com/v1", models: [{ id: "mymodel" }, { id: "FW-DeepSeek-V4-Pro" }], existingModels: [], store: {}, _download: fakeDownload, _dlOpenRouter: dlOR, _dlLiteLlm: dlLL });
ok("⑪h md 查不到 → OR/LLM 兑底命中并映射", rh.extras.length === 2 && rh.extras[0].source === "openrouter" && rh.extras[0].meta.contextWindow === 262144 && rh.extras.some((x) => x.source === "litellm" && x.meta.contextWindow === 163840), JSON.stringify(rh.extras));
ok("⑪h auxUsed 标记两源", rh.auxUsed.openrouter === true && rh.auxUsed.litellm === true);
// ⑪i upsertProviderData listExtras 优先级夹在 store 与 md 之间
const d5 = { providers: {} };
wz.upsertProviderData(d5, { provider: "p", baseUrl: "https://p.com/v1", api: "openai-completions", models: [{ id: "m1" }], store: {}, listExtras: [{ id: "m1", contextWindow: 999 }], mdModels: [{ id: "m1", limit: { context: 888, output: 777 } }] });
ok("⑪i listExtras 优先于 models.dev", d5.providers.p.models[0].contextWindow === 999);
// ⑪j 审核修复项：
// (1) listExtras 字段白名单——任意杂键被剥掉
const d6 = { providers: {} };
wz.upsertProviderData(d6, { provider: "q", baseUrl: "https://q/v1", api: "openai-completions", models: [{ id: "m9" }], store: {}, listExtras: [{ id: "m9", contextWindow: 4096, evilKey: "x", headers: { auth: "y" } }] });
ok("⑪j listExtras 白名单剥杂键", d6.providers.q.models[0].contextWindow === 4096 && !("evilKey" in d6.providers.q.models[0]) && !("headers" in d6.providers.q.models[0]));
// (2) modelParams：已有显式 meta 的模型不查 aux（auxUsed 不误报）
fs.writeFileSync(modelsFile2, JSON.stringify({ providers: { richprov: { baseUrl: "https://r.com/v1", api: "openai-completions", apiKey: "sk-r", models: [{ id: "v/coolmodel", contextWindow: 777, maxTokens: 7, reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } }));
const mp2 = await wz.modelParams(dir2, cfg2, "richprov");
ok("⑪j 全 meta 模型不触发 aux 查询（auxUsed 全 false）", mp2.ok && mp2.auxUsed.openrouter === false && mp2.auxUsed.litellm === false && mp2.models[0].contextWindow === 777);
// (3) aux 跟随强刷的 30min 降级：新鲜时 force 不传给 ensureAux（先重置限频让 force 真触发）
writeCat(MD); dlCalls = 0; orDl = 0;
wz.resetCatalogForceGap();
const rf = await wz.resolveMdForUpsert(dir2, cfg2, { provider: "newprov2", baseUrl: "https://n2.com/v1", models: [{ id: "stealth-y" }], existingModels: [], store: {}, _download: fakeDownload, _dlOpenRouter: dlOR });
ok("⑪j OR 刚下过(<30min)→强刷降级为 TTL 不重复下载", dlCalls === 1 && orDl === 0, JSON.stringify({ mdDownloaded: dlCalls, orDl }));

// ===== ⑬ 目录合并 excludeModels：china-catalog 声明的已下线模型从 models.dev 快照合并中剔除 =====
{
  const dir3 = fs.mkdtempSync(path.join(os.tmpdir(), "wizard-cn-"));
  fs.mkdirSync(path.join(dir3, "cache", "catalog"), { recursive: true });
  fs.writeFileSync(path.join(dir3, "cache", "catalog", "models.dev.json"), JSON.stringify({ providers: { modelscope: { id: "modelscope", name: "ModelScope", api: "https://api-inference.modelscope.cn/v1", models: {
    "ZhipuAI/GLM-4.6": { id: "ZhipuAI/GLM-4.6" },                            // 快照滞后死模型
    "Qwen/Qwen3-235B-A22B-Instruct-2507": { id: "Qwen/Qwen3-235B-A22B-Instruct-2507" } // 快照活模型
  } } } }));
  fs.writeFileSync(path.join(dir3, "cache", "catalog", "meta.json"), JSON.stringify({ ts: Date.now() }));
  const idx = wz.buildIndex(dir3, { modelsPath: path.join(dir3, "m.json"), catalog: { ttlHours: 168, autoRefresh: false } });
  const ids = idx.byKey.get("modelscope").models.map((m) => m.id);
  ok("⑬ 快照死模型被 excludeModels 剔除（GLM-4.6）", !ids.includes("ZhipuAI/GLM-4.6"), JSON.stringify(ids));
  ok("⑬ 快照活模型保留 + 目录默认在前（GLM-5.2）", ids.includes("Qwen/Qwen3-235B-A22B-Instruct-2507") && ids[0] === "ZhipuAI/GLM-5.2", JSON.stringify(ids));
  fs.rmSync(dir3, { recursive: true, force: true });
}

// ===== ⑭ apiKey 三形态解析（resolveSecretValue）=====
{
  const lit = await wz.resolveSecretValue("sk-literal-key");
  ok("⑭a 字面量原样", lit === "sk-literal-key");
  process.env.__WIZARD_TEST_KEY__ = "sk-from-env";
  const env = await wz.resolveSecretValue("__WIZARD_TEST_KEY__");
  ok("⑭b 环境变量名取 env", env === "sk-from-env");
  const sh = await wz.resolveSecretValue("!echo sk-from-shell");
  ok("⑭c !命令取 stdout（去尾换行）", sh === "sk-from-shell");
  const bad = await wz.resolveSecretValue("!exit 3");
  ok("⑭d 命令失败返回空串", bad === "");
}

// ===== ⑮ probe-cap：报错文本解析真实上限 + 已知修正表 =====
{
  ok("⑮a parseMaxTokensFromError 取 <requested 的最大候选", wz.parseMaxTokensFromError("max_tokens is too large: 131072.0, maximum is 128000", 131072) === 128000 && wz.parseMaxTokensFromError("不能超过 65536，当前 200000", 200000) === 65536 && wz.parseMaxTokensFromError("no numbers here", 999999) === null);
  ok("⑮b 修正表命中 ark-coding glm", wz.knownMaxTokensCap("ark-coding", "glm-5-2-260617") === 128000);
  ok("⑮b 修正表未命中返回 undefined", wz.knownMaxTokensCap("ark-coding", "other") === undefined);
}

// ===== ⑯ 一级撤销（stashUndo/loadUndo/restoreUndoData）=====
{
  const dir4 = fs.mkdtempSync(path.join(os.tmpdir(), "wizard-undo-"));
  const data = { providers: { a: { api: "x", models: [{ id: "m1" }] }, b: { api: "y", models: [] } } };
  // 模拟一次保存前快照：b 新建（null）、a 改名前旧条目
  wz.stashUndo(dir4, { b: null, oldA: data.providers.a });
  const u = wz.loadUndo(dir4);
  ok("⑯a stash→load 快照一致", !!u && u.providers.b === null && u.providers.oldA.models[0].id === "m1");
  // 模拟保存后状态：a 被改名删除、b 带了坏数据
  const after = { providers: { b: { api: "bad" } } };
  const r = wz.restoreUndoData(after, u);
  ok("⑯b 恢复：oldA 回归、b 回滚为不存在（null→删）", r.ok && r.data.providers.oldA && !r.data.providers.b, JSON.stringify(r.data.providers));
  fs.rmSync(dir4, { recursive: true, force: true });
}

// ===== ⑰ provider 级 headers 显式替换/清空/不传保留 =====
{
  const d = { providers: {} };
  wz.upsertProviderData(d, { provider: "h1", baseUrl: "https://x.com/v1", api: "openai-completions", headers: { "X-A": "1", "Bad Header": "", "X-B": "2" }, models: [] });
  ok("⑰a 显式 headers 整体替换+剥空值", d.providers.h1.headers && d.providers.h1.headers["X-A"] === "1" && d.providers.h1.headers["X-B"] === "2" && !("Bad Header" in d.providers.h1.headers), JSON.stringify(d.providers.h1.headers));
  wz.upsertProviderData(d, { provider: "h1", baseUrl: "https://x.com/v1", api: "openai-completions", headers: {}, models: [] });
  ok("⑰b 空 headers=清除", d.providers.h1.headers === undefined);
  wz.upsertProviderData(d, { provider: "h1", baseUrl: "https://x.com/v1", api: "openai-completions", headers: { "Keep": "yes" }, models: [] });
  wz.upsertProviderData(d, { provider: "h1", baseUrl: "https://x.com/v1", api: "openai-completions", models: [] }); // 不传 headers
  ok("⑰c 不传保留旧 headers", d.providers.h1.headers && d.providers.h1.headers.Keep === "yes");
  // ⑰d fills 来源报告：显式传入字段不报，反填命中的字段带源标签
  const store = { ds: { models: [{ id: "m1", contextWindow: 1000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } };
  const d2 = { providers: {} };
  const r2 = wz.upsertProviderData(d2, { provider: "ds", baseUrl: "x", api: "openai-completions", models: [{ id: "m1" }], store });
  ok("⑰d fills 报告反填来源（内置目录）", Array.isArray(r2.fills) && r2.fills.length === 1 && r2.fills[0].fills.contextWindow === "内置目录" && r2.fills[0].fills.cost === "内置目录", JSON.stringify(r2.fills));
  const d3 = { providers: {} };
  const r3 = wz.upsertProviderData(d3, { provider: "ds", baseUrl: "x", api: "openai-completions", models: [{ id: "m1", contextWindow: 1000 }], store });
  ok("⑰e 显式传入的字段不进 fills", r3.fills.every((f) => f.fills.contextWindow === undefined));
  // ⑰f 修正表夹持：ark-coding glm 元数据虚报 131072 → 写入被夹到 128000
  const storeArk = { "ark-coding": { models: [{ id: "glm-5-2-260617", maxTokens: 131072 }] } };
  const d4 = { providers: {} };
  wz.upsertProviderData(d4, { provider: "ark-coding", baseUrl: "x", api: "openai-completions", models: [{ id: "glm-5-2-260617" }], store: storeArk });
  ok("⑰f 虚报 maxTokens 夹到修正值", d4.providers["ark-coding"].models[0].maxTokens === 128000);
  // ⑰g GLM 推理模型强制回传 reasoning_content（智谱 thinking+tool_calls 400001 防护）
  {
    const st = { "zai": { models: [{ id: "glm-5.2", reasoning: true, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } };
    const dg = { providers: {} };
    wz.upsertProviderData(dg, { provider: "zai", baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4", api: "openai-completions", models: [{ id: "glm-5.2" }], store: st });
    const gm = dg.providers.zai.models.find((m) => m.id === "glm-5.2");
    ok("⑰g1 GLM 推理模型补 compat.requiresReasoningContentOnAssistantMessages", gm && gm.compat && gm.compat.requiresReasoningContentOnAssistantMessages === true, JSON.stringify(gm));
    // 非 GLM 推理模型不误加
    const st2 = { "x": { models: [{ id: "foo-r1", reasoning: true, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } };
    const dx = { providers: {} };
    wz.upsertProviderData(dx, { provider: "x", baseUrl: "https://x.com/v1", api: "openai-completions", models: [{ id: "foo-r1" }], store: st2 });
    const fm = dx.providers.x.models.find((m) => m.id === "foo-r1");
    ok("⑰g2 非 GLM 推理模型不强制加标志", !(fm.compat && fm.compat.requiresReasoningContentOnAssistantMessages), JSON.stringify(fm));
  }
}

// ===== ⑱ 跨提供商同 id 互证（crossProviderModelMeta）=====
{
  const mdData = { providers: {
    a: { models: { "zai-org/glm-5.2": { name: "GLM-5.2", reasoning: true, limit: { context: 1048576, output: 131072 }, modalities: { input: ["text"] } } } },
    b: { models: { "glm-5.2": { limit: { context: 1000000, output: 131072 }, cost: { input: 1, output: 2, cache_read: 0, cache_write: 0 } } } },
    c: { models: { "glm-5.2-short": { limit: { context: 9999, output: 999 } } } },
    d: { models: { "deepseek-ai/DeepSeek-V4-X": { name: "X", limit: { context: 500000, output: 50000 }, cost: { input: 0.5, output: 1.5, cache_read: 0, cache_write: 0 } } } },
  } };
  const r1 = wz.crossProviderModelMeta(mdData, "zai-org/glm-5.2");
  ok("⑱a 精确归一化命中", r1 && r1.meta && r1.meta.contextWindow === 1048576);
  const r2 = wz.crossProviderModelMeta(mdData, "ZhipuAI/GLM-5.2");
  ok("⑱b 命名变体末段匹配（ZhipuAI/GLM-5.2 ↔ zai-org|裸）且排除 -short 衍生", r2 && r2.meta && r2.meta.contextWindow === 1048576 && r2.meta.maxTokens === 131072 && r2.from.length === 2, JSON.stringify(r2));
  ok("⑱c 多源 cost 不一致不带（a 无 cost、b 有 → 单命中带）", r2.meta.cost && r2.meta.cost.input === 1);
  const r3 = wz.crossProviderModelMeta(mdData, "deepseek-ai/DeepSeek-V4-X");
  ok("⑱d 单命中带 cost", r3 && r3.meta && r3.meta.cost && r3.meta.cost.input === 0.5);
  ok("⑱e 短 id 守护（gpt 不启用模糊）", wz.crossProviderModelMeta(mdData, "gpt") === null);
  ok("⑱f 全不命中返回 null", wz.crossProviderModelMeta(mdData, "nonexistent-model-xyz") === null);
}

// ===== ⑲ missingParams：查不到参数的模型落裸条目并上报（客户端据此弹 ai-helper 补全） =====
{
  // ⑲a 纯变换路径：未知模型（store 无、无显式 meta）→ 落裸条目 + missingParams 含它；已知模型不进
  const store = { "z": { models: [{ id: "known-m", contextWindow: 8000, maxTokens: 4096 }] } };
  const dA = { providers: {} };
  const rA = wz.upsertProviderData(dA, {
    provider: "z", baseUrl: "https://z.com/v1", api: "openai-completions",
    models: [{ id: "known-m" }, { id: "brand-new-unknown-123" }], store,
  });
  const missA = (rA.missingParams || []).map((m) => m.id);
  ok("⑲a 未知模型进 missingParams、已知模型不进", missA.includes("brand-new-unknown-123") && !missA.includes("known-m"), JSON.stringify(missA));
  const savedA = dA.providers.z.models.find((m) => m.id === "brand-new-unknown-123");
  ok("⑲a 未知模型落裸条目（无 ctx/max）", !!savedA && savedA.contextWindow == null && savedA.maxTokens == null);

  // ⑲b async agent 路径（upsertProvider）同样返回 missingParams（AI 工具 save 后能提示用户）
  const saveB = await wz.upsertProvider(dir, cfg, {
    provider: "test-miss", baseUrl: "https://t.com/v1", api: "openai-completions",
    keys: [{ name: "k", key: "sk-t" }], models: [{ id: "no-data-anywhere-xyz" }],
  });
  const missB = (saveB.missingParams || []).map((m) => m.id);
  ok("⑲b upsertProvider 返回 missingParams 含未知模型", missB.includes("no-data-anywhere-xyz"), JSON.stringify(missB));

  // ⑲c 参数已全的模型重新保存 → missingParams 为空（不会误报已修复模型）
  const dC = { providers: {} };
  const rC = wz.upsertProviderData(dC, {
    provider: "z", baseUrl: "https://z.com/v1", api: "openai-completions",
    models: [{ id: "known-m" }], store,
  });
  ok("⑲c 参数已全的模型不进 missingParams", (rC.missingParams || []).length === 0, JSON.stringify(rC.missingParams));
}

// ===== ⑳ 扫描回流 aux 缓存 + 参数反填兑底重查（新模型上架即查得到参数） =====
{
  const dirA = fs.mkdtempSync(path.join(os.tmpdir(), "amw-aux-"));
  const cfgA = { modelsPath: path.join(dirA, "models.json"), catalog: {} };
  // ⑳a 回流：非 openrouter baseUrl → skip 不写
  const skipR = wz.updateAuxFromScan(dirA, cfgA, "https://api.deepseek.com/v1", [{ id: "deepseek-v4" }]);
  ok("⑳a 非 openrouter 源不回流", skipR.skip === true && !fs.existsSync(path.join(dirA, "cache", "catalog", "openrouter.json")));
  // ⑳b openrouter baseUrl → 写入缓存（数组格式与 downloadAux 一致）+ meta.via=scan
  const raw1 = [{ id: "tencent/hy3" }, { id: "qwen/qwen4" }];
  const w1 = wz.updateAuxFromScan(dirA, cfgA, "https://openrouter.ai/api/v1", raw1);
  const meta1 = JSON.parse(fs.readFileSync(path.join(dirA, "cache", "catalog", "openrouter.meta.json"), "utf8"));
  ok("⑳b openrouter 扫描回流写入缓存", w1.updated === true && JSON.parse(fs.readFileSync(path.join(dirA, "cache", "catalog", "openrouter.json"), "utf8")).length === 2 && meta1.via === "scan");
  // ⑳c 内容全量比对：同 id 集但内容变了（价格/窗口修正）→ 也覆写；完全一致 → unchanged
  const w2 = wz.updateAuxFromScan(dirA, cfgA, "https://openrouter.ai/api/v1", [{ id: "qwen/qwen4" }, { id: "tencent/hy3" }]);
  ok("⑳c 完全一致不覆写", w2.unchanged === true);
  const w2b = wz.updateAuxFromScan(dirA, cfgA, "https://openrouter.ai/api/v1", [{ id: "qwen/qwen4", context_length: 262144 }, { id: "tencent/hy3" }]);
  ok("⑳c 内容修正也覆写（全量比对而非仅 id 集）", w2b.updated === true && wz.loadAux(dirA, cfgA, "openrouter").data[0].context_length === 262144);
  // ⑳d 新模型上架（id 集变化）→ 覆写 + meta 更新：扫描发现的同一时刻反填数据已就位
  const raw2 = raw1.concat([{ id: "tencent/hy4-preview", context_length: 1048576, top_provider: { max_completion_tokens: 64000 } }]);
  const w3 = wz.updateAuxFromScan(dirA, cfgA, "https://openrouter.ai/api/v1", raw2);
  ok("⑳d 新模型上架覆写缓存", w3.updated === true && wz.loadAux(dirA, cfgA, "openrouter").data.some((m) => m.id === "tencent/hy4-preview"));

  // ⑳e 参数反填兑底：缓存旧（>10min）+ 缺字段 + openrouter 源 → 强刷一次重查命中
  fs.writeFileSync(path.join(dirA, "cache", "catalog", "openrouter.meta.json"), JSON.stringify({ ts: Date.now() - 2 * 3600 * 1000, source: "openrouter" }));
  let dlCalls = 0;
  const { aux, models } = await wz.auxBackfillWithRetry(dirA, cfgA, ["tencent/hy4-preview"], "https://openrouter.ai/api/v1",
    (ex) => { const h = ex.find((e) => e.id === "tencent/hy4-preview"); return [{ id: "tencent/hy4-preview", ...(h ? h.meta : {}) }]; },
    { _dlOpenRouter: () => { dlCalls++; return Promise.resolve({ ok: true }); } });
  const hy4 = models[0];
  ok("⑳e 缓存旧+缺字段 → 强刷重查命中", dlCalls === 1 && !!hy4.contextWindow && !!hy4.maxTokens, JSON.stringify(hy4));
  // ⑳f 缓存新鲜（回流刚写过）→ 不刷网直接返回（缺也缺，不打上游）
  let dlCalls2 = 0;
  await wz.auxBackfillWithRetry(dirA, cfgA, ["some/private-model"], "https://openrouter.ai/api/v1",
    (ex) => [{ id: "some/private-model" }], { _dlOpenRouter: () => { dlCalls2++; return Promise.resolve({ ok: true }); } });
  ok("⑳f 缓存新鲜不刷网", dlCalls2 === 0);
  fs.rmSync(dirA, { recursive: true, force: true });
}

fs.rmSync(dir2, { recursive: true, force: true });
fs.rmSync(dir, { recursive: true, force: true });
finish("wizard core.test · 多 key 管理 + 新模型检测/提醒");

// ⑫ 免费模型包名匹配（「免费」页签安装状态）：freeNpmName + matchInstalledFree
const fmItems = {
  a: { npm: "npm:pi-opencode-free" },
  b: { npm: "npm:pi-freeflow" },
  c: { npm: "npm:pi-free@1.2.3" },
  d: { npm: "npm:@scope/pkg@2.0" },
  e: { npm: "git:github.com/x/y" },
};
ok("⑫ freeNpmName 裸名/版本/Scope/非npm", wz.freeNpmName("npm:pi-free") === "pi-free" && wz.freeNpmName("npm:pi-free@1.2.3") === "pi-free" && wz.freeNpmName("npm:@scope/pkg@2.0") === "@scope/pkg" && wz.freeNpmName("git:x") === "");
const m1 = wz.matchInstalledFree(fmItems, new Set(["pi-opencode-free", "pi-freeflow", "pi-free", "@scope/pkg"]));
ok("⑫ matchInstalledFree 进程内包名集合（本地路径开发版与 npm 版同名即已装）", m1.a && m1.b && m1.c && m1.d && !m1.e);
const m2 = wz.matchInstalledFree(fmItems, new Set());
ok("⑫ matchInstalledFree 空集合 → 全 false", !m2.a && !m2.b && !m2.c && !m2.d && !m2.e);
