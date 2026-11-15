// pinyin-index 单测：node --test pinyin-index.test.mjs（本地 node_modules 有 pinyin-pro）
// 共享根缺失 pinyin-pro 时 loadPinyin 降级 → 全部返回空串，用例会失败——视为环境问题（未 reconcile）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { extPinyin } from "./pinyin-index.mjs";

test("中文全拼连写 + 首字母（多音字按词组校正）", () => {
  assert.equal(extPinyin("服务隧道"), "fuwusuidao fwsd");
  assert.equal(extPinyin("扩展管理"), "kuozhanguanli kzgl");
});

test("中英混合：拼音只覆盖中文段（英文段由调用方 hay 原文匹配）", () => {
  assert.equal(extPinyin("AI 输入"), "shuru sr");
});

test("非中文 / i18n key / 空串 → 空串（纯增项）", () => {
  assert.equal(extPinyin("aiti-app-center"), "");
  assert.equal(extPinyin("i18n:ext.title"), "");
  assert.equal(extPinyin(""), "");
  assert.equal(extPinyin(null), "");
});

test("memo：同输入重复调用结果一致", () => {
  assert.equal(extPinyin("服务隧道"), extPinyin("服务隧道"));
});
