// 模型聚合（combo provider）core 单元测试：保存校验 / 自动计算 / 列表 / 改名
import { createRequire } from "module";
import { Tester } from "../../../pi-models-combo/test/util.mjs";

const require = createRequire(import.meta.url);
const wz = require("../core.cjs");
const { ok, finish } = Tester();

const mkData = () => ({
  providers: {
    deepseek: {
      baseUrl: "https://api.deepseek.com/v1", api: "openai-completions", apiKey: "sk-d1",
      models: [
        { id: "deepseek-v4-pro", contextWindow: 128000, maxTokens: 8192, input: ["text"], reasoning: true, cost: { input: 0.28, output: 1.1 } },
        { id: "deepseek-v4-flash", contextWindow: 64000, maxTokens: 4096, input: ["text", "image"], cost: { input: 0.1, output: 0.4 } },
      ],
    },
    ark: {
      baseUrl: "https://ark.cn-beijing.volces.com/api/v3", api: "openai-completions",
      apiKeys: [{ name: "b1", key: "sk-a1" }, { name: "b2", key: "sk-a2" }],
      models: [{ id: "deepseek-v4-flash", contextWindow: 256000, maxTokens: 16384, input: ["text"] }],
    },
    claude: {
      baseUrl: "https://api.anthropic.com/v1", api: "anthropic-messages", apiKey: "sk-c1",
      models: [{ id: "claude-x", contextWindow: 200000, maxTokens: 8192, input: ["text", "image"] }],
    },
    orphan: { baseUrl: "https://x/v1", api: "openai-completions", models: [] }, // 无 key 无模型
  },
});

// ① 保存 happy path：自动计算（ctx/out 取最小、input 并集、cost 最贵）+ 默认权重省略
{
  const data = mkData();
  const r = wz.comboSaveProviderData(data, {
    provider: "快速组", displayName: "快速组",
    models: [{ id: "fast", members: [
      { provider: "deepseek", model: "deepseek-v4-pro" },
      { provider: "deepseek", model: "deepseek-v4-flash" },   // 带 image、更小窗口
      { provider: "ark", model: "deepseek-v4-flash", weight: 30 },
    ] }],
  });
  const p = data.providers["快速组"];
  ok("① 保存成功且写 combo:true + 占位 baseUrl", r.ok && p.combo === true && p.baseUrl === "http://combo.pmc.invalid/");
  const m = p.models[0];
  ok("① ctx/maxTokens 取成员最小值（64000/4096）", m.contextWindow === 64000 && m.maxTokens === 4096, JSON.stringify({ c: m.contextWindow, o: m.maxTokens }));
  ok("① input 并集 + cost 取最贵成员估算", m.input.join(",") === "text,image" && m.cost.input === 0.28 && m.cost.output === 1.1);
  ok("① 显式 weight 保留、默认 weight 省略", m.combo.members[0].weight === undefined && m.combo.members[1].weight === undefined && m.combo.members[2].weight === 30);
  ok("① provider 级 api 取成员协议", p.api === "openai-completions");
}

// ② 校验拒绝：跨协议 / 成员不存在 / 无 key 成员 / 非法权重 / 缺 id / 空成员
{
  const t = (name, fn) => { const d = mkData(); const r = fn(d); ok(name, !r.ok && !!r.error, r.error || ""); };
  t("② 跨协议 → 拒绝", (d) => wz.comboSaveProviderData(d, { provider: "x", models: [{ id: "m", members: [{ provider: "deepseek", model: "deepseek-v4-pro" }, { provider: "claude", model: "claude-x" }] }] }));
  t("② 成员不存在 → 拒绝", (d) => wz.comboSaveProviderData(d, { provider: "x", models: [{ id: "m", members: [{ provider: "nope", model: "n" }] }] }));
  t("② combo provider 作成员 → 拒绝（先建一个组合再引用）", (d) => {
    wz.comboSaveProviderData(d, { provider: "g1", models: [{ id: "a", members: [{ provider: "deepseek", model: "deepseek-v4-pro" }] }] });
    return wz.comboSaveProviderData(d, { provider: "g2", models: [{ id: "b", members: [{ provider: "g1", model: "a" }] }] });
  });
  t("② 非法权重 → 拒绝", (d) => wz.comboSaveProviderData(d, { provider: "x", models: [{ id: "m", members: [{ provider: "deepseek", model: "deepseek-v4-pro", weight: 0 }] }] }));
  t("② 空 members → 拒绝", (d) => wz.comboSaveProviderData(d, { provider: "x", models: [{ id: "m", members: [] }] }));
  t("② 缺虚拟模型 id → 拒绝", (d) => wz.comboSaveProviderData(d, { provider: "x", models: [{ id: "", members: [{ provider: "deepseek", model: "deepseek-v4-pro" }] }] }));
}

// ③ 重复成员引用忽略（不叠加槽位）；stickyTtlMin 透传
{
  const data = mkData();
  const r = wz.comboSaveProviderData(data, {
    provider: "g",
    models: [{ id: "fast", stickyTtlMin: 30, members: [
      { provider: "deepseek", model: "deepseek-v4-pro" },
      { provider: "deepseek", model: "deepseek-v4-pro" }, // 冗余
    ] }],
  });
  const m = data.providers.g.models[0];
  ok("③ 冗余引用去重 + stickyTtlMin 写入", r.ok && m.combo.members.length === 1 && m.combo.stickyTtlMin === 30);
}

// ④ 改名：新键写入 + 旧键删除
{
  const data = mkData();
  wz.comboSaveProviderData(data, { provider: "old-group", models: [{ id: "a", members: [{ provider: "ark", model: "deepseek-v4-flash" }] }] });
  const r = wz.comboSaveProviderData(data, {
    provider: "new-group", renameFrom: "old-group",
    models: [{ id: "a", members: [{ provider: "ark", model: "deepseek-v4-flash" }] }],
  });
  ok("④ 改名后旧 provider 删除、新 provider 存在", r.ok && !data.providers["old-group"] && !!data.providers["new-group"]);
}

// ⑤ 列表：combo 与成员池分流；无 key/无模型的 provider 不进池
{
  const data = mkData();
  wz.comboSaveProviderData(data, { provider: "g", models: [{ id: "fast", members: [{ provider: "deepseek", model: "deepseek-v4-pro" }] }] });
  const page = wz.comboPageData(data);
  ok("⑤ combos 列出聚合组（含成员构成与 ttl）", page.combos.length === 1 && page.combos[0].models[0].members.length === 1 && page.combos[0].providerId === "g");
  ok("⑤ members 池不含 combo 自身/无模型 provider，带元数据", page.members.every((x) => x.provider !== "g" && x.provider !== "orphan") && page.members.some((x) => x.provider === "ark" && x.keyCount === 2) && page.members.some((x) => x.model === "claude-x" && x.api === "anthropic-messages"));
}

// ⑥ store 兜底：未配 models 的 provider 从 pi 模型 store 补全成员池（与「已配置」同源）
{
  const data = mkData();
  data.providers.zai = { baseUrl: "https://open.bigmodel.cn/api/paas/v4", api: "openai-completions", apiKey: "sk-z" }; // 只配 provider
  const store = { zai: { models: [
    { id: "glm-4.6v", name: "GLM-4.6V", input: ["text", "image"], contextWindow: 200000, maxTokens: 128000, cost: { input: 0.6, output: 2 } },
    { id: "glm-5.2", reasoning: true },
  ] } };
  const page = wz.comboPageData(data, store);
  const zaiModels = page.members.filter((x) => x.provider === "zai");
  ok("⑥ 未配 models 的 provider → store 补全成员池", zaiModels.length === 2 && zaiModels.some((x) => x.model === "glm-4.6v" && x.contextWindow === 200000), JSON.stringify(zaiModels));
  const r = wz.comboSaveProviderData(data, {
    provider: "zai组",
    models: [{ id: "v", members: [{ provider: "zai", model: "glm-4.6v" }, { provider: "deepseek", model: "deepseek-v4-flash" }] }],
  }, store);
  ok("⑥ store 成员可过校验并入组（ctx 取 min / 能力并集含 image）",
    r.ok && data.providers["zai组"].models[0].contextWindow === 64000 && data.providers["zai组"].models[0].input.includes("image"), JSON.stringify(r));
}

// ⑦ types（承接类别）：保存透传 / 回读 / 非法拒绝 / 空数组省略 / 去重
{
  const data = mkData();
  const r = wz.comboSaveProviderData(data, {
    provider: "视觉组",
    models: [{ id: "vl", members: [
      { provider: "deepseek", model: "deepseek-v4-pro", types: ["text"] },
      { provider: "deepseek", model: "deepseek-v4-flash", types: ["vision"] },
      { provider: "ark", model: "deepseek-v4-flash" }, // 未配 = 全收（不写字段）
    ] }],
  });
  const m = data.providers["视觉组"].models[0].combo.members;
  ok("⑦ types 透传（text/vision）+ 未配省略", r.ok && JSON.stringify(m[0].types) === JSON.stringify(["text"]) && JSON.stringify(m[1].types) === JSON.stringify(["vision"]) && m[2].types === undefined);
  const page = wz.comboPageData(data);
  const vm = page.combos.find((c) => c.providerId === "视觉组");
  ok("⑦ comboPageData 回读 types", JSON.stringify(vm.models[0].members[0].types) === JSON.stringify(["text"]));

  const t = (name, fn) => { const d = mkData(); const r = fn(d); ok(name, !r.ok && !!r.error, r.error || ""); };
  t("⑦ 非法 types 值 → 拒绝", (d) => wz.comboSaveProviderData(d, { provider: "x", models: [{ id: "m", members: [{ provider: "deepseek", model: "deepseek-v4-pro", types: ["video"] }] }] }));
  t("⑦ types 非数组 → 拒绝", (d) => wz.comboSaveProviderData(d, { provider: "x", models: [{ id: "m", members: [{ provider: "deepseek", model: "deepseek-v4-pro", types: "text" }] }] }));

  const d4 = mkData();
  const r4 = wz.comboSaveProviderData(d4, { provider: "y", models: [{ id: "m", members: [{ provider: "deepseek", model: "deepseek-v4-pro", types: [] }] }] });
  ok("⑦ 空 types → 不写字段（全收）", r4.ok && d4.providers["y"].models[0].combo.members[0].types === undefined);
  const d5 = mkData();
  wz.comboSaveProviderData(d5, { provider: "z", models: [{ id: "m", members: [{ provider: "deepseek", model: "deepseek-v4-pro", types: ["text", "vision", "text"] }] }] });
  ok("⑦ types 去重", JSON.stringify(d5.providers["z"].models[0].combo.members[0].types) === JSON.stringify(["text", "vision"]));
}

// ⑦ 名称碰撞保护：不能把普通 provider 覆盖成聚合组
{
  const data = mkData();
  const r = wz.comboSaveProviderData(data, {
    provider: "deepseek", // 已存在的普通 provider
    models: [{ id: "x", members: [{ provider: "ark", model: "deepseek-v4-flash" }] }],
  });
  ok("⑦ 目标名为普通 provider → 拒绝覆盖", !r.ok && r.error.includes("不能覆盖"), JSON.stringify(r));
  ok("⑦ 原 provider 配置完好未被动过", !!data.providers.deepseek.models.length);
}

// ⑧ 同名聚合组碰撞：非改名流程覆盖另一个聚合组 → 拒绝
{
  const data = mkData();
  wz.comboSaveProviderData(data, { provider: "组A", models: [{ id: "a", members: [{ provider: "deepseek", model: "deepseek-v4-pro" }] }] });
  wz.comboSaveProviderData(data, { provider: "组B", models: [{ id: "b", members: [{ provider: "ark", model: "deepseek-v4-flash" }] }] });
  const r = wz.comboSaveProviderData(data, {
    provider: "组B", // 不带 renameFrom → 覆盖组B
    models: [{ id: "x", members: [{ provider: "deepseek", model: "deepseek-v4-pro" }] }],
  });
  ok("⑧ 覆盖另一个聚合组 → 拒绝（防静默吞组）", !r.ok && r.error.includes("已是另一个聚合组"), JSON.stringify(r));
  const r2 = wz.comboSaveProviderData(data, {
    provider: "组B", renameFrom: "组B",
    models: [{ id: "b2", members: [{ provider: "ark", model: "deepseek-v4-flash" }] }],
  });
  ok("⑧ 正常编辑（renameFrom 自身）→ 放行", r2.ok);
}

// ⑨ :free/:batch 后缀必须原样保留（已配置显示与聚合保存、引擎转发都要一致的模型 id）
{
  const data = mkData();
  data.providers.openrouter = {
    baseUrl: "https://openrouter.ai/api/v1", api: "openai-completions", apiKey: "sk-or",
    models: [{ id: "z-ai/glm-5.2:free" }, { id: "nvidia/nemotron:batch" }],
  };
  const page = wz.comboPageData(data, null);
  const ids = page.members.filter((x) => x.provider === "openrouter").map((x) => x.model);
  ok("⑨ 成员池保留 :free/:batch 后缀（与已配置显示一致）", ids.includes("z-ai/glm-5.2:free") && ids.includes("nvidia/nemotron:batch"), JSON.stringify(ids));
  const r = wz.comboSaveProviderData(data, {
    provider: "or组",
    models: [{ id: "f", members: [{ provider: "openrouter", model: "z-ai/glm-5.2:free" }] }],
  });
  ok("⑨ 保存后 combo.members 原样保留 :free（引擎转发才正确）", r.ok && data.providers["or组"].models[0].combo.members[0].model === "z-ai/glm-5.2:free", JSON.stringify(data.providers["or组"] && data.providers["or组"].models[0].combo.members));
}

// ⑩ 缺元数据的成员按「同 id 模型」跨 provider 补全参数（多 key/多入口镜像同一真实模型）
{
  const data = mkData();
  data.providers["sensenova-smart"] = {
    baseUrl: "https://smart/v1", api: "openai-completions",
    apiKeys: [{ name: "k1", key: "sk-1" }, { name: "k2", key: "sk-2" }],
    models: [{ id: "deepseek-v4-flash" }, { id: "sensenova-6.8-flash-lite" }], // 只有 id
  };
  const page = wz.comboPageData(data, null);
  const m = page.members.find((x) => x.provider === "sensenova-smart" && x.model === "deepseek-v4-flash");
  ok("⑩ 同 id 跨 provider 补全 ctx/maxTokens/能力（源自 deepseek 的定义）",
    m && m.contextWindow === 64000 && m.maxTokens === 4096 && m.input.includes("image"),
    JSON.stringify(m && { c: m.contextWindow, o: m.maxTokens, i: m.input }));
  const orphan = page.members.find((x) => x.provider === "sensenova-smart" && x.model === "sensenova-6.8-flash-lite");
  ok("⑩ 无同 id 可抄时保持缺省（ctx null 而非臆造）", orphan && orphan.contextWindow === null, JSON.stringify(orphan && { c: orphan.contextWindow }));
}

// ⑪ 运行时注册 provider 作成员（pi ModelRuntime 快照，如 pi-freeflow 的 freeflow）：
//     成员池展示 + 保存校验同源放行（引擎 flattenComboSlots 运行时能解析，校验不得误拒）
{
  const data = mkData();
  const runtime = [
    { provider: "freeflow", id: "minimax/minimax-m3:free", api: "openai-completions", baseUrl: "https://freeflow/v1", reasoning: false, input: ["text"] },
    { provider: "deepseek", id: "deepseek-v4-pro", api: "openai-completions", baseUrl: "http://127.0.0.1:9930/", reasoning: true }, // models.json 已有 → runtime 条目合并（不改成员池集合）
  ];
  const page = wz.comboPageData(data, null, runtime);
  ok("⑪ 成员池含运行时注册 provider（freeflow，id 保留 :free 后缀）",
    page.members.some((x) => x.provider === "freeflow" && x.model === "minimax/minimax-m3:free"),
    JSON.stringify(page.members.filter((x) => x.provider === "freeflow")));
  const r = wz.comboSaveProviderData(data, {
    provider: "free-coder",
    models: [{ id: "free", members: [{ provider: "freeflow", model: "minimax/minimax-m3:free" }] }],
  }, null, runtime);
  ok("⑪ 运行时成员保存放行（引擎同源，不再误报成员不存在）", r.ok, r.error || "");
  ok("⑪ 保存后 combo.members 原样保留运行时引用",
    data.providers["free-coder"].models[0].combo.members[0].provider === "freeflow"
    && data.providers["free-coder"].models[0].combo.members[0].model === "minimax/minimax-m3:free");
  // 无 runtime 时仍拒绝（保持硬校验：不存在的成员不能进组）
  const r2 = wz.comboSaveProviderData(mkData(), { provider: "x", models: [{ id: "m", members: [{ provider: "freeflow", model: "minimax/minimax-m3:free" }] }] });
  ok("⑪ 无 runtime 快照时运行时成员仍拒绝", !r2.ok, r2.error || "");
}

// ⑬ 校验与引擎一致性补严：嵌套组防漏网 + 归一化查找
{
  const data = mkData();
  // 聚合组配了 apiKeys（非常见）→ 旧逻辑靠 hasKey 误拦，现应按 combo 模型拒绝（与引擎 mdef.combo 同源）
  wz.comboSaveProviderData(data, { provider: "g1", models: [{ id: "a", members: [{ provider: "deepseek", model: "deepseek-v4-pro" }] }] });
  data.providers["g1"].apiKeys = [{ name: "k", key: "sk-x" }];
  const r1 = wz.comboSaveProviderData(data, { provider: "g2", models: [{ id: "b", members: [{ provider: "g1", model: "a" }] }] });
  ok("⑬ 带 key 的聚合组作成员仍拒绝（防嵌套组漏网）", !r1.ok, r1.error || "");
  // 归一化查找（引擎同款 normModelId）：成员引用省略 :free 后缀也能命中
  const runtime = [{ provider: "freeflow", id: "minimax/minimax-m3:free", api: "openai-completions", baseUrl: "https://freeflow/v1", reasoning: false, input: ["text"] }];
  const r2 = wz.comboSaveProviderData(mkData(), {
    provider: "norm-ref",
    models: [{ id: "v", members: [{ provider: "freeflow", model: "minimax/minimax-m3" }] }], // 无 :free 后缀
  }, null, runtime);
  ok("⑬ 归一化引用命中（省略 :free 后缀，引擎同源）", r2.ok, r2.error || "");
  // 写入的成员保留用户原始引用（不自作主归一化）
  const saved = (() => { const d = mkData(); wz.comboSaveProviderData(d, { provider: "norm-ref2", models: [{ id: "v", members: [{ provider: "freeflow", model: "minimax/minimax-m3" }] }] }, null, runtime); return d.providers["norm-ref2"].models[0].combo.members[0].model; })();
  ok("⑬ 写入成员保留原始引用（minimax/minimax-m3 原样）", saved === "minimax/minimax-m3", saved);
}

finish("wizard combo.test · 模型聚合（保存校验/自动计算/列表/改名/store 兜底）");
