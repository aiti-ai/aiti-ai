/**
 * aiti-model-wizard · agent 工具 inputSchema 结构防回归（源级校验）
 *
 * 背景（2026-09-18 事故）：`model_wizard_combo_save` 的 inputSchema 顶层 `properties` 少闭合
 * 一个 `}`，`required: ["provider","models"]` 被吃进 `properties` 里，成为一个「值是数组的属性」。
 * 严格 provider（opencode-go / Console Go，校验 properties 每个值必须 object/boolean）会拒收
 * 整个请求：`Invalid schema for function '…': ["provider","models"] is not of types "boolean", "object"`
 * ——该扩展帮助点会话直接建会即 400。
 *
 * 本测试在源级解析 index.ts 里全部 `inputSchema:` 字面量（不 import 扩展模块），断言结构合法：
 *   - 顶层必须是 object 且有 properties
 *   - 任意 properties 映射的每个值必须是对象（或布尔，JSON Schema 允许 false 关掉字段）
 *   - 任意 items 必须是对象（或布尔）
 *   - required（若有）必须是字符串数组，且键都在同级 properties 里
 *   - type（若有）是字符串或字符串数组
 *
 * Run: node --test pi-web-ext/aiti-model-wizard/schema-shape.test.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(here, "index.ts"), "utf8");

/** 从 `startAt` 往后找 `inputSchema: `，按字符串感知的花括号配对截取字面量。 */
function extractSchemaLiteral(src, startAt) {
  const j = src.indexOf("inputSchema: ", startAt);
  if (j < 0) return null;
  const k = j + "inputSchema: ".length;
  let depth = 0, end = -1, instr = null, esc = false;
  for (let x = k; x < src.length; x++) {
    const ch = src[x];
    if (instr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === instr) instr = null;
      continue;
    }
    if (ch === '"' || ch === "'") { instr = ch; continue; }
    if (ch === "{") depth++;
    else if (ch === "}") { depth--; if (depth === 0) { end = x + 1; break; } }
  }
  return end > 0 ? src.slice(k, end) : null;
}

/** 收集 TOOLS 里的全部工具名（`{ name: "xxx", description: "` 模式）。 */
function collectTools(src) {
  const out = [];
  const re = /\{ name: "([a-z_][a-z0-9_]*)", description: "/g;
  let m;
  while ((m = re.exec(src))) out.push({ name: m[1], at: m.index });
  return out;
}

/** 递归结构校验；返回问题清单（空=合法）。 */
function validateSchema(node, path, issues) {
  if (typeof node === "boolean") return;                       // JSON Schema 允许 boolean
  if (!node || typeof node !== "object" || Array.isArray(node)) {
    issues.push(path + " 不是对象: " + JSON.stringify(node));
    return;
  }
  if ("type" in node && typeof node.type !== "string" && !Array.isArray(node.type)) {
    issues.push(path + ".type 必须是字符串或字符串数组");
  }
  if ("properties" in node) {
    const props = node.properties;
    if (!props || typeof props !== "object" || Array.isArray(props)) {
      issues.push(path + ".properties 不是对象");
    } else {
      for (const [k, v] of Object.entries(props)) {
        // 核心断言：properties 的每个值必须是 schema 对象（或 boolean 简写）
        if (typeof v !== "object" || v === null || Array.isArray(v)) {
          issues.push(path + ".properties." + k + " 必须是 schema 对象/boolean，实际: " + JSON.stringify(v));
        } else {
          validateSchema(v, path + ".properties." + k, issues);
        }
      }
      if ("required" in node) {
        if (!Array.isArray(node.required) || node.required.some((r) => typeof r !== "string")) {
          issues.push(path + ".required 必须是字符串数组");
        } else {
          for (const r of node.required) {
            if (!(r in props)) issues.push(path + ".required 含未声明属性: " + r);
          }
        }
      }
    }
  } else if ("required" in node) {
    issues.push(path + " 有 required 但无 properties（会诱使显式声明 required 的解析器误判）");
  }
  if ("items" in node) {
    // 数组 items 允许 schema 对象或 boolean；数组自身 schema 也必须合法
    validateSchema(node.items, path + ".items", issues);
  }
}

const tools = collectTools(SRC);

test("TOOLS 至少 1 个工具（名提取模式未失效）", () => {
  assert.ok(tools.length >= 5, "应解析出全部 agent 工具，实际 " + tools.length);
});

for (const t of tools) {
  test("inputSchema 结构合法: " + t.name, () => {
    const lit = extractSchemaLiteral(SRC, t.at);
    assert.ok(lit, t.name + " 找不到 inputSchema 字面量");
    let schema;
    try {
      schema = (0, eval)("(" + lit + ")");   // 字面量是合法 JS 对象表达式（本文件校验用，可信源码）
    } catch (e) {
      assert.fail(t.name + " inputSchema 不是合法对象字面量: " + e.message);
    }
    assert.equal(schema.type, "object", t.name + " 顶层 type 应为 object");
    assert.ok(schema.properties && typeof schema.properties === "object" && !Array.isArray(schema.properties),
      t.name + " 顶层缺 properties 映射");
    const issues = [];
    validateSchema(schema, t.name, issues);
    assert.deepEqual(issues, [], t.name + " schema 结构问题:\n  " + issues.join("\n  "));
  });
}

test("回归钉子：combo_save 的 required 必须在顶层（而非 properties 里）", () => {
  const t = tools.find((x) => x.name === "model_wizard_combo_save");
  assert.ok(t, "找不到 model_wizard_combo_save");
  const lit = extractSchemaLiteral(SRC, t.at);
  const schema = (0, eval)("(" + lit + ")");
  assert.ok(!("required" in schema.properties), "properties 里不应出现 required 键（括号错位特征）");
  assert.deepEqual(schema.required, ["provider", "models"], "顶层 required 应为 [provider, models]");
});
