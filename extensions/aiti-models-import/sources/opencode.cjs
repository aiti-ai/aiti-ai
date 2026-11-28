"use strict";
/**
 * opencode 适配器 — ~/.config/opencode/{opencode.json,config.json} + ~/.local/share/opencode/auth.json
 *
 * 结构：provider.<id> {npm?, options:{baseURL, apiKey?}, models:{<modelId>: …}}；
 *       协议由 npm SDK 包名映射（@ai-sdk/anthropic → anthropic-messages 等，未知 → completions+警告）。
 *       models 可能为空（opencode 依赖 models.dev 远端补全）→ 导骨架 + 警告（upsert 空 models 不动既有，安全）。
 * key：options.apiKey 直读；否则 ~/.local/share/opencode/auth.json 的 {<id>:{type:"api", key}}。
 */
const path = require("node:path");
const core = require("../core.cjs");

const CONFIG_FILES = ["opencode.json", "config.json"];

function mapNpmApi(npm) {
  const s = String(npm || "");
  if (s.includes("anthropic")) return "anthropic-messages";
  if (s.includes("google")) return "google-generative-ai";
  if (s.includes("openai-responses")) return "openai-responses";
  return "openai-completions";
}

module.exports = {
  id: "opencode",
  label: "OpenCode",
  kind: "importable",
  homeFiles(home) {
    return CONFIG_FILES.map((f) => ({ path: path.join(home, ".config", "opencode", f), label: f }));
  },
  scan(io) {
    const dir = path.join(io.home, ".config", "opencode");
    const found = CONFIG_FILES.map((f) => path.join(dir, f)).filter((p) => io.exists(p));
    if (!found.length) return { available: false, reason: core.msg("mi.srv.opencode.notInstalled"), drafts: [], notes: [] };

    // 多配置文件合并 provider 段（同名后文件覆盖前文件，opencode 自身 merge 语义近似）
    const merged = {};
    const parseErrors = [];
    for (const p of found) {
      const text = io.readText(p);
      if (text == null) { parseErrors.push(core.msg("mi.srv.opencode.fileReadFailed", { file: path.basename(p) })); continue; }
      let cfg;
      try { cfg = JSON.parse(text); } catch (e) { parseErrors.push(core.msg("mi.srv.opencode.fileParseFailed", { file: path.basename(p), detail: String((e && e.message) || e) })); continue; }
      if (cfg && typeof cfg.provider === "object" && cfg.provider) Object.assign(merged, cfg.provider);
    }
    const notes = [...parseErrors];

    // auth.json（api 型 key 明文仓）：{<providerId>: {type:"api", key}}
    const authPath = path.join(io.home, ".local", "share", "opencode", "auth.json");
    let auth = {};
    if (io.exists(authPath)) {
      try {
        const a = JSON.parse(io.readText(authPath) || "{}");
        if (a && typeof a === "object") auth = a;
      } catch { notes.push(core.msg("mi.srv.opencode.authParseFailed")); }
    }

    const drafts = [];
    for (const [rawId, raw] of Object.entries(merged)) {
      const prov = raw && typeof raw === "object" ? raw : {};
      const opts = prov.options && typeof prov.options === "object" ? prov.options : {};
      const baseUrl = core.normBaseUrl(opts.baseURL);
      if (!baseUrl) { notes.push(core.msg("mi.srv.opencode.noBaseUrl", { provider: rawId })); continue; }
      const known = ["@ai-sdk/anthropic", "@ai-sdk/openai", "@ai-sdk/google"].some((p) => String(prov.npm || "").includes(p.split("/")[1]));
      const warnings = [];
      if (prov.npm && !known) warnings.push(core.msg("mi.srv.opencode.unknownSdk", { npm: String(prov.npm) }));
      const modelsMap = prov.models && typeof prov.models === "object" ? prov.models : {};
      const modelIds = Object.keys(modelsMap);
      if (!modelIds.length) warnings.push(core.msg("mi.srv.opencode.noModels"));
      const authEntry = auth[rawId] && typeof auth[rawId] === "object" ? auth[rawId] : null;
      const apiKey = typeof opts.apiKey === "string" && opts.apiKey ? opts.apiKey : (authEntry && authEntry.type === "api" && typeof authEntry.key === "string" ? authEntry.key : null);
      if (!apiKey) warnings.push(core.msg("mi.srv.opencode.noKey"));
      drafts.push(core.normalizeDraft({
        key: "opencode-" + core.sanitizeId(rawId),
        label: rawId,
        sourceId: "opencode",
        baseUrl,
        api: mapNpmApi(prov.npm),
        apiKey,
        apiKeyEnv: null,
        models: modelIds.map((id) => {
          const m = modelsMap[id] && typeof modelsMap[id] === "object" ? modelsMap[id] : {};
          return { id, name: m.name ? String(m.name) : undefined };
        }),
        modelMeta: core.metaById(modelIds, (id) => modelsMap[id]),
        warnings,
      }));
    }
    if (!drafts.length) notes.push(core.msg("mi.srv.opencode.noProviders"));
    return { available: true, drafts, notes };
  },
};
