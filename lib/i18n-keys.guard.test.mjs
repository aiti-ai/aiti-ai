// ─────────────────────────────────────────────────────────────────────────────
// i18n 护栏（i18n-keys-guard）
//
// 背景：上游合并曾造成两类 i18n 事故：
//   ① auto-merge 产生**重复键**（zh-TW 的 chat.followUpHint/steerHint 各出现两次，
//      静默后值覆盖前值——哪边生效全凭键序，纯运气）；
//   ② 双方各自改同一键文案，冲突解决时整块取一侧 → **我方键位语义文案被上游顶掉**
//      或上游新键缺失（组件界面直接显示原始 key）。
//
// 本护栏三件事：
//   1. 三语文件无重复键（对象字面量重复键 = 合并事故味道）；
//   2. 全仓源码引用的 t("key") ⊆ 三语键集（合并丢键立即红灯，而非用户看到裸 key）；
//   3. fork 关键语义键在三语中存在（排队/插队体系等冲突高发键逐个点名）。
// ─────────────────────────────────────────────────────────────────────────────
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { readdirSync, statSync } from "node:fs";
import test from "node:test";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const LANGS = ["en", "zh-CN", "zh-TW"];
const messageFile = (lang) => join(root, "lib", "i18n", "messages", `${lang}.ts`);

/** 递归收集源码文件（跳过 node_modules/点目录/测试文件/i18n 消息本身） */
function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const p = join(dir, entry);
    const s = statSync(p);
    if (s.isDirectory()) walk(p, out);
    else if ((entry.endsWith(".tsx") || entry.endsWith(".ts")) && !entry.endsWith(".test.mjs") && !entry.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

/** 解析消息文件里的键集合（键都是 "ns.name" 平铺形式，一行一个） */
async function parseKeys(lang) {
  const src = await readFile(messageFile(lang), "utf8");
  const set = new Set();
  const re = /^\s*"([a-zA-Z0-9_.-]+)":/gm;
  let m;
  while ((m = re.exec(src))) set.add(m[1]);
  return { set, dupes: findDuplicates(src) };
}

/** 逐行找重复键（修掉字符串值里的干扰后按行匹配） */
function findDuplicates(src) {
  const seen = new Map();
  const dupes = [];
  const re = /^\s*"([a-zA-Z0-9_.-]+)":/gm;
  let m;
  while ((m = re.exec(src))) {
    if (seen.has(m[1])) dupes.push(m[1]);
    else seen.set(m[1], true);
  }
  return dupes;
}

/** 收集全仓 t("key") / t('key') 字面量引用（剥掉注释，避免示例代码误报） */
async function collectUsedKeys() {
  const used = new Map(); // key → 首个引用文件（报错定位用）
  const dirs = ["components", "hooks", "lib", "app"].map((d) => join(root, d));
  const keyRe = /\bt\(\s*["']([a-zA-Z0-9_.-]+)["']/g;
  for (const dir of dirs) {
    for (const f of walk(dir)) {
      if (f.includes(join("lib", "i18n", "messages"))) continue;
      let src = await readFile(f, "utf8");
      src = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, ""); // 剥注释
      let m;
      while ((m = keyRe.exec(src))) {
        if (!used.has(m[1])) used.set(m[1], f.replace(root + "/", ""));
      }
    }
  }
  return used;
}

test("[i18n-guard] 三语消息文件无重复键（重复 = 合并事故：后值静默覆盖前值）", async () => {
  for (const lang of LANGS) {
    const { dupes } = await parseKeys(lang);
    assert.deepEqual(dupes, [], `${lang}.ts 存在重复键: ${dupes.join(", ")}\n  → 典型 auto-merge 事故：双方各改同一键且未去重。保留我方语义的那一份。`);
  }
});

test("[i18n-guard] 全仓 t() 引用键 ⊆ 三语键集（丢键 = 界面裸奔显示 key）", async () => {
  const used = await collectUsedKeys();
  assert.ok(used.size > 300, `引用键扫描异常偏少（${used.size}），扫描逻辑或目录结构变了，请检查测试本身`);
  for (const lang of LANGS) {
    const { set } = await parseKeys(lang);
    const missing = [...used.keys()].filter((k) => !set.has(k));
    assert.deepEqual(missing, [], `${lang}.ts 缺失被引用的键:\n${missing.map((k) => `    ${k}  ←  ${used.get(k)}`).join("\n")}\n  → 合并丢了键或键名漂移；按 merge-notes 恢复我方键/补上游新键。`);
  }
});

// 冲突高发键点名（都发生过「被上游顶掉」或「双方各自演化」）：
// 排队/插队体系是我方 queue-keeper 的语义，文案键必须存活于三语。
const FORK_CRITICAL_KEYS = [
  "chat.steer",
  "chat.followUp",
  "chat.steerHint",
  "chat.steerFromQueueHint",
  "chat.steerNoInput",
  "chat.followUpHint",
  "chat.followUpNoInput",
  // 注：chat.imagesCannotQueue 已于 2026-09 随「图片可排队」产品决策退役，不再点名
  "chat.minimizeQueue",
  "chat.continueQueueHint",
  "chat.queueRecoveryDismiss",
  "i18n.editFromHere",
  "sidebar.expandSubagents",
  "sidebar.collapseSubagents",
  "sidebar.expandBranches",
  "sidebar.collapseBranches",
];

test("[i18n-guard] fork 关键语义键三语齐全（排队/插队/编辑从此处/侧栏折叠——冲突高发区点名）", async () => {
  for (const lang of LANGS) {
    const { set } = await parseKeys(lang);
    const missing = FORK_CRITICAL_KEYS.filter((k) => !set.has(k));
    assert.deepEqual(missing, [], `${lang}.ts 缺失 fork 关键键: ${missing.join(", ")}\n  → 这些键的文案在历史上被上游版本顶掉过；恢复我方语义文案。`);
  }
});
