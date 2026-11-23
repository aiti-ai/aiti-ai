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
const { msg } = require("../core.cjs");

/** Fixed non-importable sources (no file-backed model config; listed so "all agent configs" is complete, each with a reason). */
const NOT_IMPORTABLE = [
  {
    id: "cursor",
    label: "Cursor",
    kind: "not-importable",
    reason: msg("mi.srv.cursor.reason"),
  },
  {
    id: "qoder",
    label: "Qoder",
    kind: "not-importable",
    reason: msg("mi.srv.qoder.reason"),
  },
];

const REGISTRY = [codex, zcode, opencode, ...NOT_IMPORTABLE];

function listSources() {
  return REGISTRY;
}

module.exports = { listSources };
