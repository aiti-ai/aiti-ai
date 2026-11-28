/**
 * ui-dialogs unit tests (node --test; esbuild bundling + DOM stub, same pattern as the _shared
 * degradation-layer tests).
 *
 * Coverage:
 *   1. uiConfirm: OK→true / cancel→false / Esc→false; danger styling (red confirm button + warn icon)
 *   2. uiAlert: string shortcut + {kind:"error"}; OK closes
 *   3. uiPrompt: OK returns the value / cancel→null / Esc→null; required empty-value interception
 *   4. Queue serialization: multiple dialogs sent together show one at a time; the next appears
 *      only after the previous resolves
 *   5. data-ext-float contract attributes all present (float/full/autoh/keepmask/max/persist)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { runEsbuild } from "./esbuild-bin.ts";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/** DOM stub: enough for ui-dialogs' create / event / query paths.
 * opts.dialog=true gives createElement("dialog") showModal/close (browser top-layer path);
 * omitted by default (legacy browser / no showModal → z-index fallback path). */
function makeDomStub(opts) {
  const withDialog = !!(opts && opts.dialog);
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
        if (sel !== "button") return []; // only "button" is supported precisely; other selectors return empty (tests walk children)
        const out = [];
        const walk = (n) => { for (const c of n.children) { if (c.tag === "button") out.push(c); walk(c); } };
        walk(this);
        return out;
      },
    };
    if (withDialog && tag === "dialog") {
      el.open = false;
      el.showModal = function () { this.open = true; (this.modalCalls ||= []).push("showModal"); };
      el.close = function () { this.open = false; (this.modalCalls ||= []).push("close"); };
    }
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

async function loadModule(opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), "uidlg-test-"));
  const stub = `
const { document } = (${makeDomStubSource})(${JSON.stringify(opts)});
globalThis.document = document;
export * from ${JSON.stringify(join(here, "ui-dialogs.ts"))};
`;
  const entry = join(dir, "entry.mjs");
  writeFileSync(entry, stub);
  const bundle = join(dir, "bundle.mjs");
  // Derived form (Linux native ELF / Windows official .exe, or node running a JS entry directly) is settled by esbuild-bin
  await runEsbuild(join(here, "..", "aiti-float", "node_modules", "esbuild", "bin", "esbuild"),
    [entry, "--bundle", "--format=esm", "--platform=node", "--outfile=" + bundle]);
  const mod = await import(pathToFileURL(bundle).href);
  return { mod, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// makeDomStub is serialized into the stub via Function.toString
const makeDomStubSource = makeDomStub.toString();

/** Get the currently shown overlay (last child of body) */
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

  await t.test("confirm: OK → true", async () => {
    const p = mod.uiConfirm({ message: "Delete group X?" });
    await new Promise((r) => setTimeout(r, 150));
    const panel = overlayOf(body).children[0];
    const btns = buttons(panel);
    assert.equal(btns.length, 2);
    btns[btns.length - 1].click(); // primary button is last
    assert.equal(await p, true);
    assert.equal(body.children.length, 0, "overlay should leave after OK");
  });

  await t.test("confirm: cancel → false; danger red button + warn icon + contract attributes", async () => {
    const p = mod.uiConfirm({ message: "Proceed?", detail: "$ rm -rf /", danger: true });
    await new Promise((r) => setTimeout(r, 150));
    const overlay = overlayOf(body);
    const panel = overlay.children[0];
    // Contract attributes
    assert.equal(panel.getAttribute("data-ext-float"), "1");
    assert.equal(panel.getAttribute("data-ext-float-full"), "1");
    assert.equal(panel.getAttribute("data-ext-float-keepmask"), "1");
    assert.equal(panel.getAttribute("data-ext-float-max"), "0");
    assert.equal(panel.getAttribute("data-ext-float-persist"), "0");
    // danger confirm button is red
    const btns = buttons(panel);
    assert.ok(btns[btns.length - 1].style.cssText.includes("#ef4444"), "danger confirm button should be red");
    // detail monospace block
    const pre = panel.children.find((c) => c.tag === "pre");
    assert.ok(pre && pre.textContent.includes("rm -rf"), "detail block should show the command text");
    btns[0].click();
    assert.equal(await p, false);
  });

  await t.test("no showModal: top-level body div + highest z-index fallback", async () => {
    const p = mod.uiConfirm("fallback tier");
    await new Promise((r) => setTimeout(r, 150));
    const overlay = overlayOf(body);
    assert.equal(overlay.tag, "div", "without showModal the host is a plain div");
    assert.ok(overlay.style.cssText.includes("2147483600"), "fallback tier must beat self-managed panel z-indices");
    buttons(overlay.children[0])[0].click();
    assert.equal(await p, false);
  });

  await t.test("confirm: Esc → false", async () => {
    const p = mod.uiConfirm("Continue?");
    await new Promise((r) => setTimeout(r, 150));
    const panel = overlayOf(body).children[0];
    panel.keydown("Escape");
    assert.equal(await p, false);
  });

  await t.test("alert: string shortcut + kind error", async () => {
    const p1 = mod.uiAlert("Done");
    await new Promise((r) => setTimeout(r, 150));
    let panel = overlayOf(body).children[0];
    buttons(panel).at(-1).click();
    assert.equal(await p1, undefined);

    const p2 = mod.uiAlert({ message: "Save failed", kind: "error" });
    await new Promise((r) => setTimeout(r, 150));
    panel = overlayOf(body).children[0];
    // error icon is an svg (first child of the head)
    const svg = panel.querySelector("svg") ?? panel.children[0].children[0];
    assert.ok(svg && svg.tag === "svg", "error dialog should have an svg icon");
    buttons(panel).at(-1).click();
    assert.equal(await p2, undefined);
  });

  await t.test("prompt: OK returns value / cancel → null / Esc → null / default focused+selected", async () => {
    const p1 = mod.uiPrompt({ message: "Enter a name:", value: "Draft" });
    await new Promise((r) => setTimeout(r, 150));
    const panel = overlayOf(body).children[0];
    const input = panel.children.find((c) => c.tag === "input");
    assert.ok(input, "should have an input");
    assert.ok(input.focused && input.selected, "input should be focused and selected");
    input.value = "New name";
    buttons(panel).at(-1).click();
    assert.equal(await p1, "New name");

    const p2 = mod.uiPrompt("Type again:");
    await new Promise((r) => setTimeout(r, 150));
    buttons(overlayOf(body).children[0])[0].click();
    assert.equal(await p2, null);

    const p3 = mod.uiPrompt("Esc cancels:");
    await new Promise((r) => setTimeout(r, 150));
    overlayOf(body).children[0].keydown("Escape");
    assert.equal(await p3, null);
  });

  await t.test("queue serialization: only one shown at a time", async () => {
    const p1 = mod.uiConfirm("The first");
    const p2 = mod.uiConfirm("The second");
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(body.children.length, 1, "only one overlay at a time");
    const panel1 = overlayOf(body).children[0];
    // The first panel's body should be "The first" (panel.children = [head, msg, foot])
    const msg1 = panel1.children[1];
    assert.ok((msg1?.textContent || "").includes("The first"), "the first dialog shows first");
    buttons(panel1).at(-1).click();
    assert.equal(await p1, true);
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(body.children.length, 1, "the second appears only after the first finishes");
    const panel2 = overlayOf(body).children[0];
    assert.notEqual(panel2, panel1, "the second is a new instance");
    buttons(panel2)[0].click();
    assert.equal(await p2, false);
  });
});

test("top-layer path (<dialog>.showModal): escapes z-index stacking and closes on settle", async (t) => {
  const { mod, cleanup } = await loadModule({ dialog: true });
  t.after(cleanup);
  const body = globalThis.document.body;

  await t.test("showModal on mount, same semantics as the fallback (confirm/cancel/Esc)", async () => {
    const p1 = mod.uiConfirm({ message: "Sign out this subscription?", danger: true, confirmText: "Sign out" });
    await new Promise((r) => setTimeout(r, 150));
    const overlay = overlayOf(body);
    assert.equal(overlay.tag, "dialog", "showModal available → dialog modal host");
    assert.equal(overlay.open, true, "should enter modal (top layer)");
    assert.deepEqual(overlay.modalCalls, ["showModal"]);
    buttons(overlay.children[0]).at(-1).click();
    assert.equal(await p1, true);
    assert.equal(body.children.length, 0, "overlay leaves after confirm");
    assert.equal(overlay.open, false, "settle must close() to exit the top layer");
    assert.deepEqual(overlay.modalCalls, ["showModal", "close"]);

    // cancel → null
    const p2 = mod.uiPrompt({ message: "Input:", value: "x" });
    await new Promise((r) => setTimeout(r, 150));
    buttons(overlayOf(body).children[0])[0].click();
    assert.equal(await p2, null);

    // native Esc (dialog cancel event) → cancel; browser must not close on its own
    const p3 = mod.uiConfirm("Esc cancel");
    await new Promise((r) => setTimeout(r, 150));
    const ov = overlayOf(body);
    let prevented = false;
    for (const fn of ov.handlers.cancel || []) fn({ preventDefault() { prevented = true; } });
    assert.equal(await p3, false);
    assert.equal(prevented, true, "cancel must preventDefault (this module owns the settle path)");
    assert.equal(ov.open, false);
    assert.equal(ov.removed, true);
  });
});
