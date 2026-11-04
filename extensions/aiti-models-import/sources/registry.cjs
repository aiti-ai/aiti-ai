"use strict";
/**
 * 来源适配器注册表 — 新来源 = 一个 sources/<id>.cjs + 本表注册一行。
 *
 * importable 适配器契约：
 *   { id, label, kind: "importable", homeFiles(home): [{path,label}], scan(io): {available, reason?, drafts, notes} }
 *   io = { home, exists(p), readText(p)→string|null }（可注入可测）
 * 草稿（DraftProvider）字段见 docs/aiti-models-import-plan.md §4.1；一律经 core.normalizeDraft 规整。
 *
 * not-importable 条目（cursor/qoder 等）：静态声明 + 一句原因，弹窗灰显（§2.2）。
 */
const codex = require("./codex.cjs");
const zcode = require("./zcode.cjs");
const opencode = require("./opencode.cjs");

/** 固定不可导入来源（无文件化模型配置；列出以满足「列出所有 agent 配置」且说明原因）。 */
const NOT_IMPORTABLE = [
  {
    id: "cursor",
    label: "Cursor",
    kind: "not-importable",
    reason: "无文件化模型配置——登录态在 auth.json（加密），模型为会话内 lastUsedModel，无可导入项",
  },
  {
    id: "qoder",
    label: "Qoder",
    kind: "not-importable",
    reason: "凭据 WASM 加密、端点为区域常量，模型清单来自服务端 API 而非本地配置文件",
  },
];

const REGISTRY = [codex, zcode, opencode, ...NOT_IMPORTABLE];

function listSources() {
  return REGISTRY;
}

module.exports = { listSources };
