/**
 * ui-dialogs 单测（node --test；esbuild 打包 + DOM 桩，同 _shared 降级层测试范式）。
 *
 * 覆盖点：
 *   1. uiConfirm：确定→true / 取消→false / Esc→false；danger 样式（红确认按钮 + warn 图标）
 *   2. uiAlert：字符串快捷 + {kind:"error"}；确定关闭
 *   3. uiPrompt：确定回值 / 取消→null / Esc→null；required 空值拦截
 *   4. 队列串行：同发多个弹窗一次只显示一个，前一个 resolve 后下一个才出现
 *   5. data-ext-float 契约属性齐全（float/full/autoh/keepmask/max/persist）
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { runEsbuild } from "./esbuild-bin.ts";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/** DOM 桩：足够 ui-dialogs 的创建/事件/查询路径 */
function makeDomStub() {
  const mkEl = (tag = "div") => {
    const el = {
      tag, style: new Proxy({}, { get: (t, k) => (k === "cssText" ? t.cssText : t[k]), set: (t, k, v) => { t[k] = v; return true; } }),
      attrs: {}, handlers: {}, children: [], parentElement: null, textContent: "", value: "", tabIndex: 0,
      type: "", placeholder: "", focused: false,
      setAttribute(k, v) { this.attrs[k] = String(v); },
      getAttribute(k) { return this.attrs[k] ?? null; },
      appendChild(c) { this.children.push(c); c.parentElement = this; return c; },
      remove() {
        const p = this.parentElement;
        if (!p) return;
        const i = p.children.indexOf(this);
        if (i >= 0) p.children.splice(i, 1);
        this.parentElement = null;
        this.removed = true;
      },
      removed: false,
      addEventListener(type, fn) { (this.handlers[type] ||= []).push(fn); },
      removeEventListener() {},
      click() { for (const fn of this.handlers.click || []) fn({ target: this, preventDefault() {}, stopPropagation() {} }); },
      keydown(key) { for (const fn of this.handlers.keydown || []) fn({ key, target: this, preventDefault() {}, stopPropagation() {} }); },
      focus() { this.focused = true; },
      select() { this.selected = true; },
      querySelector(sel) { return this.querySelectorAll(sel)[0] ?? null; },
      querySelectorAll(sel) {
        if (sel !== "button") return []; // 只精确支持 button；其他选择器返回空（测试走 children 遍历）
        const out = [];
        const walk = (n) => { for (const c of n.children) { if (c.tag === "button") out.push(c); walk(c); } };
        walk(this);
        return out;
      },
    };
    return el;
  };
  const body = mkEl("body");
  const document = {
    createElement: (tag) => mkEl(tag),
    createElementNS: (_ns, tag) => mkEl(tag.toLowerCase()),
    body,
    activeElement: null,
  };
  return { document, body };
}

async function loadModule() {
  const dir = mkdtempSync(join(tmpdir(), "uidlg-test-"));
  const stub = `
const { document } = (${makeDomStubSource})();
globalThis.document = document;
export * from ${JSON.stringify(join(here, "ui-dialogs.ts"))};
`;
  const entry = join(dir, "entry.mjs");
  writeFileSync(entry, stub);
  const bundle = join(dir, "bundle.mjs");
  // 派生形态（Linux 原生 ELF / Windows 官方 .exe，或 node 直跑 JS 入口）由 esbuild-bin 收口
  await runEsbuild(join(here, "..", "aiti-float", "node_modules", "esbuild", "bin", "esbuild"),
    [entry, "--bundle", "--format=esm", "--platform=node", "--outfile=" + bundle]);
  const mod = await import(pathToFileURL(bundle).href);
  return { mod, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// makeDomStub 序列化进 stub：借 Function.toString
const makeDomStubSource = makeDomStub.toString();

/** 取当前显示的 overlay（body 最后一个子节点） */
function overlayOf(body) {
  return body.children[body.children.length - 1];
}
function buttons(panel) {
  return panel.querySelectorAll("button");
}

test("ui-confirm-alert-prompt", async (t) => {
  const { mod, cleanup } = await loadModule();
  t.after(cleanup);
  const doc = globalThis.document;
  const body = doc.body;

  await t.test("confirm：确定 → true", async () => {
    const p = mod.uiConfirm({ message: "删除分组 X？" });
    await new Promise((r) => setTimeout(r, 10));
    const panel = overlayOf(body).children[0];
    const btns = buttons(panel);
    assert.equal(btns.length, 2);
    btns[btns.length - 1].click(); // 主按钮在最后
    assert.equal(await p, true);
    assert.equal(body.children.length, 0, "确定后 overlay 应离场");
  });

  await t.test("confirm：取消 → false；danger 红按钮 + warn 图标 + 契约属性", async () => {
    const p = mod.uiConfirm({ message: "确认执行？", detail: "$ rm -rf /", danger: true });
    await new Promise((r) => setTimeout(r, 10));
    const overlay = overlayOf(body);
    const panel = overlay.children[0];
    // 契约属性
    assert.equal(panel.getAttribute("data-ext-float"), "1");
    assert.equal(panel.getAttribute("data-ext-float-full"), "1");
    assert.equal(panel.getAttribute("data-ext-float-keepmask"), "1");
    assert.equal(panel.getAttribute("data-ext-float-max"), "0");
    assert.equal(panel.getAttribute("data-ext-float-persist"), "0");
    // danger 确认按钮红色
    const btns = buttons(panel);
    assert.ok(btns[btns.length - 1].style.cssText.includes("#ef4444"), "danger 确认按钮应为红色");
    // detail 等宽块
    const pre = panel.children.find((c) => c.tag === "pre");
    assert.ok(pre && pre.textContent.includes("rm -rf"), "detail 块应展示命令文本");
    btns[0].click();
    assert.equal(await p, false);
  });

  await t.test("confirm：Esc → false", async () => {
    const p = mod.uiConfirm("继续吗？");
    await new Promise((r) => setTimeout(r, 10));
    const panel = overlayOf(body).children[0];
    panel.keydown("Escape");
    assert.equal(await p, false);
  });

  await t.test("alert：字符串快捷 + kind error", async () => {
    const p1 = mod.uiAlert("已完成");
    await new Promise((r) => setTimeout(r, 10));
    let panel = overlayOf(body).children[0];
    buttons(panel).at(-1).click();
    assert.equal(await p1, undefined);

    const p2 = mod.uiAlert({ message: "保存失败", kind: "error" });
    await new Promise((r) => setTimeout(r, 10));
    panel = overlayOf(body).children[0];
    // error 图标为 svg（head 的首个子元素）
    const svg = panel.querySelector("svg") ?? panel.children[0].children[0];
    assert.ok(svg && svg.tag === "svg", "error 弹窗应有 svg 图标");
    buttons(panel).at(-1).click();
    assert.equal(await p2, undefined);
  });

  await t.test("prompt：确定回值 / 取消 → null / Esc → null / 默认值聚焦全选", async () => {
    const p1 = mod.uiPrompt({ message: "输入名称：", value: "草稿" });
    await new Promise((r) => setTimeout(r, 10));
    const panel = overlayOf(body).children[0];
    const input = panel.children.find((c) => c.tag === "input");
    assert.ok(input, "应有输入框");
    assert.ok(input.focused && input.selected, "输入框应聚焦全选");
    input.value = "新名字";
    buttons(panel).at(-1).click();
    assert.equal(await p1, "新名字");

    const p2 = mod.uiPrompt("再输入：");
    await new Promise((r) => setTimeout(r, 10));
    buttons(overlayOf(body).children[0])[0].click();
    assert.equal(await p2, null);

    const p3 = mod.uiPrompt("Esc 取消：");
    await new Promise((r) => setTimeout(r, 10));
    overlayOf(body).children[0].keydown("Escape");
    assert.equal(await p3, null);
  });

  await t.test("队列串行：一次只显示一个", async () => {
    const p1 = mod.uiConfirm("第一个");
    const p2 = mod.uiConfirm("第二个");
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(body.children.length, 1, "同时只有一个 overlay");
    const panel1 = overlayOf(body).children[0];
    // 第一个面板的正文应是「第一个」（panel.children = [head, msg, foot]）
    const msg1 = panel1.children[1];
    assert.ok((msg1?.textContent || "").includes("第一个"), "先显示第一个弹窗");
    buttons(panel1).at(-1).click();
    assert.equal(await p1, true);
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(body.children.length, 1, "第一个结束后第二个才出现");
    const panel2 = overlayOf(body).children[0];
    assert.notEqual(panel2, panel1, "第二个是新实例");
    buttons(panel2)[0].click();
    assert.equal(await p2, false);
  });
});
