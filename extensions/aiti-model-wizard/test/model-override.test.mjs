// wizard core 单元测试：modelOverrides.contextWindow 读写（G2，docs/aiti-model-wizard-settings-takeover-plan.md）
// 覆盖：setModelOverrideData 纯变换（新建/更新/删除/空容器/空条目清理）+ getModelOverrides 读值
// + providersStatus 过滤 overrides-only 幽灵行 + MODEL_META_FIELDS 含 inputLimits（G4 透传）
import { createRequire } from "module";
import { Tester } from "../../../pi-models-combo/test/util.mjs";

const require = createRequire(import.meta.url);
const wz = require("../core.cjs");
const { ok, finish } = Tester();

// ① 新建 overrides-only 条目（managed provider 无模型条目场景）
const data = { providers: {} };
let r = wz.setModelOverrideData(data, "anthropic", "claude-opus-4", 500000);
ok("① setModelOverrideData 新建 ok", r.ok === true);
ok("① 落 providers[anthropic].modelOverrides", data.providers.anthropic?.modelOverrides?.["claude-opus-4"]?.contextWindow === 500000, JSON.stringify(data.providers.anthropic));
ok("① getModelOverrides 读回", wz.getModelOverrides(data, "anthropic")["claude-opus-4"] === 500000);

// ② 更新已有覆盖（保留 modelOverrides 内其它键/其它模型）
wz.setModelOverrideData(data, "anthropic", "claude-opus-4", 800000);
wz.setModelOverrideData(data, "anthropic", "claude-sonnet-4", 200000);
ok("② 更新 + 多模型共存", data.providers.anthropic.modelOverrides["claude-opus-4"].contextWindow === 800000
  && data.providers.anthropic.modelOverrides["claude-sonnet-4"].contextWindow === 200000);

// ③ 同一模型条目内的其它覆盖键保留（只动 contextWindow）
wz.setModelOverrideData(data, "anthropic", "claude-opus-4", 900000);
ok("③ 更新后值正确", data.providers.anthropic.modelOverrides["claude-opus-4"].contextWindow === 900000);

// ④ 删除单模型覆盖（undefined）→ 键删除；条目仍在
wz.setModelOverrideData(data, "anthropic", "claude-sonnet-4", undefined);
ok("④ 删除单模型覆盖", !("claude-sonnet-4" in data.providers.anthropic.modelOverrides)
  && data.providers.anthropic.modelOverrides["claude-opus-4"].contextWindow === 900000);

// ⑤ 删除唯一覆盖 → modelOverrides 整键删除；provider 条目空 → 整条删除（pi 拒收空条目）
wz.setModelOverrideData(data, "anthropic", "claude-opus-4", undefined);
ok("⑤ modelOverrides 空后整键 + provider 条目清理", !("anthropic" in data.providers), JSON.stringify(data.providers));

// ⑥ 已有内容的 provider：覆盖写入不破坏既有字段，删除覆盖后 provider 仍存在
const d6 = { providers: { zhipu: { baseUrl: "https://x", api: "openai-completions", models: [{ id: "glm-5" }] } } };
wz.setModelOverrideData(d6, "zhipu", "glm-5", 128000);
ok("⑥ 既有 provider 写覆盖不破坏字段", d6.providers.zhipu.baseUrl === "https://x" && d6.providers.zhipu.models.length === 1
  && d6.providers.zhipu.modelOverrides["glm-5"].contextWindow === 128000);
wz.setModelOverrideData(d6, "zhipu", "glm-5", undefined);
ok("⑥ 删除覆盖后 provider 条目保留", !!d6.providers.zhipu && !d6.providers.zhipu.modelOverrides, JSON.stringify(d6.providers.zhipu));

// ⑦ 非对象 modelOverrides 容错（手工改坏成字符串不崩）
const d7 = { providers: { bad: { modelOverrides: "junk" } } };
const r7 = wz.setModelOverrideData(d7, "bad", "m1", 1000);
ok("⑦ 容错：坏类型重建为对象", r7.ok === true && d7.providers.bad.modelOverrides.m1.contextWindow === 1000, JSON.stringify(d7.providers.bad));

// ⑧ getModelOverrides：缺失 provider / 无 overrides → 空对象
ok("⑧ 缺失 provider → {}", Object.keys(wz.getModelOverrides({ providers: {} }, "nope")).length === 0);
ok("⑧ 无 overrides → {}", Object.keys(wz.getModelOverrides({ providers: { a: { baseUrl: "x" } } }, "a")).length === 0);

// ⑨ providersStatus 过滤 overrides-only 幽灵行（原生 isOverridesOnly 同判定）
const { mkdtempSync } = await import("node:fs");
const path = await import("node:path");
const os = await import("node:os");
const dir = mkdtempSync(path.join(os.tmpdir(), "wizard-ov-"));
const fs = await import("node:fs");
fs.writeFileSync(path.join(dir, "models.json"), JSON.stringify({
  providers: {
    "ov-only": { modelOverrides: { "m1": { contextWindow: 400000 } } },
    "real": { baseUrl: "https://x", api: "openai-completions", models: [{ id: "m2" }] },
  },
}));
const st = wz.providersStatus(dir, { modelsPath: path.join(dir, "models.json"), catalog: { autoRefresh: false } });
ok("⑨ overrides-only 不进树", !st.providers.some((x) => x.provider === "ov-only") && st.providers.some((x) => x.provider === "real"), JSON.stringify(st.providers.map((x) => x.provider)));

// ⑩ G4：MODEL_META_FIELDS 含 inputLimits（upsert 白名单透传）
const d10 = { providers: {} };
wz.upsertProviderData(d10, { provider: "p10", baseUrl: "x", api: "openai-completions", keepKey: true, models: [{ id: "m", inputLimits: { images: { resize: { maxBytes: 4718592 } } } }] });
ok("⑩ inputLimits 落盘", d10.providers.p10.models[0].inputLimits?.images?.resize?.maxBytes === 4718592, JSON.stringify(d10.providers.p10.models[0]));

finish();
