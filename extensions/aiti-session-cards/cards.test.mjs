/**
 * aiti-session-cards 接线测试：entry 注册 sessionRequestCard 插槽的 interaction/permission 两 item，
 * meta.kinds 路由元数据正确；feature 关停 → dispose + 不再注册（宿主 core 兜底卡接管）；
 * 卡本体渲染——tool_auth（如 EnterPlanMode）/缺正文的 plan_approval 必须有正文摘要 + 可点作答出口
 * （挂起的 ask 不能弹一张没按钮的空卡）。
 *
 * entry 是 TSX（vite 构建，react alias host-shim）——node 直读不了，esbuild 打包为可测 bundle
 * （react 与 react/jsx-runtime 都指向桩，jsx=automatic）。
 */
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";
import { runEsbuild } from "../_shared/esbuild-bin.ts";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

const REACT_STUB = [
  "export const Fragment = Symbol.for('react.fragment');",
  "export const createElement = (type, props, ...children) => ({ type, props, children });",
  "export const useState = (v) => [v, () => {}];",
  "export const useEffect = () => {};",
  "export const useLayoutEffect = () => {};",
  "export const useRef = () => ({ current: null });",
  "export const useCallback = (fn) => fn;",
  "export const useMemo = (fn) => fn();",
].join("\n");

const JSX_STUB = [
  "export const Fragment = Symbol.for('react.fragment');",
  "export function jsx(type, props, key) { const p = { ...props }; if (key !== undefined) p.key = key; return { type, props: p }; }",
  "export const jsxs = jsx;",
].join("\n");

/** 打包 entry.tsx（react/jsx 走桩）→ import 后的注册函数。 */
async function buildEntry(t) {
  const dir = mkdtempSync(join(tmpdir(), "asc-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const reactStub = join(dir, "react-stub.js");
  const jsxStub = join(dir, "jsx-stub.js");
  writeFileSync(reactStub, REACT_STUB);
  writeFileSync(jsxStub, JSX_STUB);
  const outfile = join(dir, "bundle.mjs");
  // 派生形态（Linux 原生 ELF / Windows 官方 .exe，或 node 直跑 JS 入口）由 esbuild-bin 收口
  await runEsbuild(
    join(here, "..", "aiti-float", "node_modules", "esbuild", "bin", "esbuild"),
    [
      join(here, "client", "src", "entry.tsx"), "--bundle", "--format=esm", "--platform=node",
      "--jsx=automatic", "--alias:react=" + reactStub, "--alias:react/jsx-runtime=" + jsxStub,
      "--outfile=" + outfile, "--log-level=error"],
  );
  return import(pathToFileURL(outfile).href);
}

function makeCtx(features, registered, disposed) {
  return {
    registerItems: (slot, items) => { registered.push({ slot, items }); return () => {}; },
    disposeItems: (slot, ids) => { disposed.push({ slot, ids }); },
    getFeatures: () => features,
    onFeatureChange: () => {},
  };
}

/** jsx 桩产出的元素树 → 拼接全部文本（含按钮 title 之外的可见文案）。 */
function collectText(node) {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(collectText).join(" ");
  if (typeof node === "object") {
    const children = node.children ?? node.props?.children;
    return children == null ? "" : collectText(children);
  }
  return "";
}

/** 元素树里全部 button（含 onClick/文案），供「点按钮 → 出答案」断言。 */
function collectButtons(node, out = []) {
  if (Array.isArray(node)) { for (const n of node) collectButtons(n, out); return out; }
  if (node == null || typeof node !== "object") return out;
  if (node.type === "button" && node.props) out.push({ label: collectText(node.props.children), onClick: node.props.onClick });
  collectButtons(node.children ?? node.props?.children, out);
  return out;
}

/** 渲染一张卡：entry 的 render 只产元素（桩不递归组件），拿到 type 再直接调函数组件。 */
function renderCard(interactionItem, request) {
  const answers = [];
  const respond = async (answer) => { answers.push(answer); return true; };
  const element = interactionItem.render({ request, respond });
  const tree = typeof element?.type === "function" ? element.type(element.props) : element;
  return { text: collectText(tree), buttons: collectButtons(tree), answers };
}

test("entry 注册 interaction+permission 两卡（kinds 元数据）+ feature 门控", async (t) => {
  const registered = [];
  const disposed = [];
  const mod = await buildEntry(t);

  // 开（默认）：两 item 注册，kinds/backend 路由元数据正确
  mod.default(makeCtx({}, registered, disposed));
  await new Promise((r) => setImmediate(r));
  assert.equal(registered.length, 1);
  assert.equal(registered[0].slot, "sessionRequestCard");
  const ids = registered[0].items.map((it) => it.id);
  assert.deepEqual(ids.sort(), ["interaction", "permission"]);
  const interaction = registered[0].items.find((it) => it.id === "interaction");
  assert.deepEqual(interaction.meta.kinds.sort(),
    ["interaction:ask_user", "interaction:generic", "interaction:open_url", "interaction:plan_approval", "interaction:tool_auth"].sort());
  assert.ok(!("backend" in interaction.meta), "通用卡不得声明 backend（跨后端共用）");
  const permission = registered[0].items.find((it) => it.id === "permission");
  assert.deepEqual(permission.meta.kinds, ["permission"]);

  // 关停：dispose + 不注册（core 兜底卡接管）
  registered.length = 0;
  disposed.length = 0;
  mod.default(makeCtx({ "sessionCards.enabled": false }, registered, disposed));
  await new Promise((r) => setImmediate(r));
  assert.equal(registered.length, 0, "feature 关停后不得注册");
  assert.deepEqual(disposed.at(-1), { slot: "sessionRequestCard", ids: ["interaction", "permission"] });
});

test("tool_auth 卡（EnterPlanMode）：正文摘要 + 拒绝/允许，且作答出正确的 accept/decline", async (t) => {
  const registered = [];
  const mod = await buildEntry(t);
  mod.default(makeCtx({}, registered, []));
  const interaction = registered[0].items.find((it) => it.id === "interaction");

  const card = renderCard(interaction, {
    requestId: "r1", family: "interaction", kind: "interaction:tool_auth",
    capability: "respondInteraction", toolName: "EnterPlanMode",
    input: { reason: "用户要求进入 plan 模式，并先找到之前的相关方案文档" },
  });
  assert.match(card.text, /工具授权/, "标题须是「工具授权」（不是空壳「交互请求」）");
  assert.match(card.text, /EnterPlanMode/, "工具名角标");
  assert.match(card.text, /reason: 用户要求进入 plan 模式/, "input 摘要须上卡（正文不得空白）");
  const deny = card.buttons.find((b) => b.label === "拒绝");
  const allow = card.buttons.find((b) => b.label === "允许");
  assert.ok(deny?.onClick && allow?.onClick, "工具授权必须有 拒绝/允许 两个出口");
  await allow.onClick();
  await deny.onClick();
  assert.deepEqual(card.answers.map((a) => a.action), ["accept", "decline"]);
});

test("plan_approval 缺方案正文（ExitPlanMode 只带 allowedPrompts）→ 摘要兜底 + 审批出口仍在", async (t) => {
  const registered = [];
  const mod = await buildEntry(t);
  mod.default(makeCtx({}, registered, []));
  const interaction = registered[0].items.find((it) => it.id === "interaction");

  const card = renderCard(interaction, {
    requestId: "r2", family: "interaction", kind: "interaction:plan_approval",
    capability: "respondInteraction", toolName: "ExitPlanMode",
    input: { allowedPrompts: [{ prompt: "run tests", tool: "Bash" }] },
  });
  assert.match(card.text, /方案审批/);
  assert.match(card.text, /允许命令: run tests（Bash）/, "allowedPrompts 翻成人话，卡不空跑");
  assert.ok(card.buttons.some((b) => b.label === "批准方案"), "审批出口不得因缺正文而消失");
  assert.ok(card.buttons.some((b) => b.label === "拒绝"));
});
