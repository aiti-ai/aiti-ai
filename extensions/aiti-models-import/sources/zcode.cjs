"use strict";
/**
 * zcode 适配器 — ~/.zcode/v2/config.json（ZCode 桌面端 provider 注册表）
 *
 * 结构（aiti-zcode-agent/zcode-core.ts readProviderRegistry 同源）：顶层 provider 段，
 * 键 = 通道 id，值 {name?, baseURL|options.baseURL, models: {<modelId>: …}}；
 * bigmodel/zai 端点为 anthropic 协议 → api = anthropic-messages。
 * key：~/.zcode/v2/credentials.json 为桌面端加密存储（aes-256-gcm，secret 随机器）——
 *      M1 不解密，草稿不带 key + 警告（导入后向导补 key 即可用）。
 * 通道过滤（镜像 zcode 扩展自身语义，zcode-core.ts buildZcodeCatalogRefs）：
 *   - *-start-plan 通道彻底排除（验证码只能桌面 GUI 产生，pi-web 无法驱动）
 *   - 套餐缓存（coding-plan-cache.json）有数据时按 family 授权过滤（无授权的通道导了也跑不通）
 */
const path = require("node:path");
const core = require("../core.cjs");

/** 套餐可用性（readPlanStatus 同源）：[{channel, status}]；缺文件/坏 JSON → 空数组。 */
function readPlanStatus(io) {
  const text = io.readText(path.join(io.home, ".zcode", "v2", "coding-plan-cache.json"));
  if (!text) return [];
  try {
    const j = JSON.parse(text);
    return Object.entries((j.entryStatus && j.entryStatus.items) || {}).map(([k, v]) => ({
      channel: String(k).replace(/^builtin:/, ""),
      status: v && typeof v.status === "string" ? v.status : "unknown",
    }));
  } catch { return []; }
}

module.exports = {
  id: "zcode",
  label: "ZCode",
  kind: "importable",
  homeFiles(home) {
    return [{ path: path.join(home, ".zcode", "v2", "config.json"), label: "config.json" }];
  },
  scan(io) {
    const p = path.join(io.home, ".zcode", "v2", "config.json");
    if (!io.exists(p)) return { available: false, reason: "未安装（无 ~/.zcode/v2/config.json）", drafts: [], notes: [] };
    const text = io.readText(p);
    if (text == null) return { available: false, reason: "config.json 读取失败", drafts: [], notes: [] };
    let cfg;
    try { cfg = JSON.parse(text); } catch (e) { return { available: false, reason: "config.json 解析失败：" + String((e && e.message) || e), drafts: [], notes: [] }; }

    const channels = cfg && typeof cfg.provider === "object" && cfg.provider ? cfg.provider : {};
    const plan = readPlanStatus(io);
    const available = new Set(plan.filter((x) => x.status === "available").map((x) => x.channel));
    const hasPlanData = plan.length > 0;
    const entitledFamilies = new Set([...available].map((c) => c.split("-")[0]));
    const drafts = [];
    const notes = [];
    for (const [rawKey, raw] of Object.entries(channels)) {
      const rawChannel = rawKey.replace(/^builtin:/, ""); // 桌面端 config.json 通道键带 builtin: 前缀（readProviderRegistry 同款剥除）
      if (rawChannel.endsWith("-start-plan")) {
        notes.push("通道 " + rawChannel + " 为套餐（start-plan）通道：验证码只能桌面端产生，pi-web 无法驱动，跳过");
        continue;
      }
      if (hasPlanData && !entitledFamilies.has(rawChannel.split("-")[0])) {
        notes.push("通道 " + rawChannel + " 无有效套餐授权，跳过");
        continue;
      }
      const ch = raw && typeof raw === "object" ? raw : {};
      const baseUrl = core.normBaseUrl(ch.baseURL || (ch.options && ch.options.baseURL));
      if (!baseUrl) { notes.push("通道 " + rawChannel + " 无 baseURL，跳过"); continue; }
      const modelIds = ch.models && typeof ch.models === "object" ? Object.keys(ch.models) : [];
      drafts.push(core.normalizeDraft({
        key: "zcode-" + core.sanitizeId(rawChannel),
        label: ch.name || rawChannel,
        sourceId: "zcode",
        baseUrl,
        api: "anthropic-messages",
        apiKey: null,
        apiKeyEnv: null,
        models: modelIds.map((id) => ({ id })),
        modelMeta: core.metaById(modelIds, (id) => (ch.models || {})[id]),
        warnings: ["key 在 ZCode 桌面端加密存储（credentials.json），导入后请在 🧙 向导给该 provider 补 key"],
      }));
    }
    if (!drafts.length) notes.push("config.json 未配置可导入的 provider 通道");
    return { available: true, drafts, notes };
  },
};
