"use strict";
/**
 * codex 适配器 — ~/.codex/config.toml
 *
 * 可导入：[model_providers.<id>] {name?, base_url, env_key?, wire_api?} → provider 草稿；
 *         顶层 model(+model_provider) 作为「当前默认模型」挂到对应 provider 草稿。
 * 不导入：~/.codex/auth.json（官方 OAuth 登录态，与 models.json 型互斥）。
 * key：codex 只存 env 变量名（env_key），明文在用户 shell env——pi-web 进程读不到，
 *      → 草稿落 apiKeyEnv + 警告（saveBatch 的 upsert 支持 apiKeyEnv 写入）。
 * TOML 解析：smol-toml（package.json dependencies，extman reconcile 装进共享根）；
 *      缺失时降级为 available+错误 note，不炸。
 */
const path = require("node:path");
const core = require("../core.cjs");

const API_MAP = { chat: "openai-completions", responses: "openai-responses" };

module.exports = {
  id: "codex",
  label: "Codex CLI",
  kind: "importable",
  homeFiles(home) {
    return [{ path: path.join(home, ".codex", "config.toml"), label: "config.toml" }];
  },
  scan(io) {
    const p = path.join(io.home, ".codex", "config.toml");
    if (!io.exists(p)) return { available: false, reason: core.msg("mi.srv.codex.notInstalled"), drafts: [], notes: [] };
    const text = io.readText(p);
    if (text == null) return { available: false, reason: core.msg("mi.srv.codex.readFailed"), drafts: [], notes: [] };

    let cfg;
    try {
      let toml;
      try { toml = require("smol-toml"); } catch { return { available: false, reason: core.msg("mi.srv.codex.tomlDepMissing"), drafts: [], notes: [] }; }
      cfg = toml.parse(text);
    } catch (e) {
      return { available: false, reason: core.msg("mi.srv.codex.parseFailed", { detail: String((e && e.message) || e) }), drafts: [], notes: [] };
    }
    if (!cfg || typeof cfg !== "object") return { available: false, reason: core.msg("mi.srv.codex.empty"), drafts: [], notes: [] };

    const providers = cfg.model_providers && typeof cfg.model_providers === "object" ? cfg.model_providers : {};
    const activeProvider = String(cfg.model_provider || "openai");
    const defaultModel = String(cfg.model || "").trim();
    const drafts = [];
    const notes = [core.msg("mi.srv.codex.authNote")];
    for (const [rawId, raw] of Object.entries(providers)) {
      const prov = raw && typeof raw === "object" ? raw : {};
      const baseUrl = core.normBaseUrl(prov.base_url);
      if (!baseUrl) { notes.push(core.msg("mi.srv.codex.noBaseUrl", { key: rawId })); continue; }
      const envKey = prov.env_key ? String(prov.env_key) : null;
      const warnings = [];
      if (envKey) warnings.push(core.msg("mi.srv.codex.envKey", { env: envKey }));
      else warnings.push(core.msg("mi.srv.codex.noKey"));
      if (activeProvider === rawId && defaultModel) {
        // The active default model rides along on the draft; codex persists no other model list,
        // so the rest can be fetched through the wizard's /discover after importing.
      } else if (!defaultModel || activeProvider !== rawId) {
        warnings.push(core.msg("mi.srv.codex.noModels"));
      }
      drafts.push(core.normalizeDraft({
        key: "codex-" + core.sanitizeId(rawId),
        label: prov.name || rawId,
        sourceId: "codex",
        baseUrl,
        api: API_MAP[String(prov.wire_api || "chat")] || "openai-completions",
        apiKey: null,
        apiKeyEnv: envKey,
        models: activeProvider === rawId && defaultModel ? [{ id: defaultModel }] : [],
        warnings,
      }));
    }
    if (!drafts.length) notes.push(core.msg("mi.srv.codex.noProviders"));
    return { available: true, drafts, notes };
  },
};
