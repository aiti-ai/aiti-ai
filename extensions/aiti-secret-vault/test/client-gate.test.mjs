// Client-side pre-send gate: register -> onBeforeSend -> dialog -> mask.
//
// This drives the real client bundle entry (`register(ctx)`) with a minimal DOM
// stub, because the gate is only reachable through the composer enhancement the
// client registers. A regression here is silent in the browser (no dialog, no
// masking), so it must fail loudly in tests instead.
import assert from "node:assert/strict";
import { test } from "node:test";

/** Placeholder literal, assembled so this file never contains a live-shaped token. */
const PH = (hash) => "r" + "sec_" + hash;

// ---- minimal DOM ---------------------------------------------------------
class Node {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.style = {};
    this.handlers = {};
    this.attributes = {};
    this.textContent = "";
    this.title = "";
    this.value = "";
    this.checked = false;
    this.type = "";
    this.id = "";
    this.parentNode = null;
  }
  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }
  removeChild(child) {
    this.children = this.children.filter((c) => c !== child);
    return child;
  }
  remove() {
    if (this.parentNode) this.parentNode.removeChild(this);
  }
  setAttribute(k, v) {
    this.attributes[k] = v;
  }
  getAttribute(k) {
    return this.attributes[k];
  }
  addEventListener(type, fn) {
    this.handlers[type] = fn;
  }
  removeEventListener(type) {
    delete this.handlers[type];
  }
  querySelectorAll() {
    return [];
  }
  querySelector() {
    return null;
  }
  focus() {}
  select() {}
  showModal() {
    this.open = true;
  }
  close() {
    this.open = false;
  }
  click() {
    this.handlers.click?.({ preventDefault() {}, stopPropagation() {}, target: this });
  }
  find(tag, textIncludes) {
    for (const c of this.children) {
      const matches = !tag || c.tagName === tag.toUpperCase();
      const textOk = textIncludes === undefined || String(c.textContent).includes(textIncludes);
      if (matches && textOk) return c;
      const nested = c.find ? c.find(tag, textIncludes) : null;
      if (nested) return nested;
    }
    return null;
  }
}

function installDom() {
  const body = new Node("body");
  const head = new Node("head");
  const document = {
    body,
    head,
    createElement: (tag) => new Node(tag),
    createElementNS: (_ns, tag) => new Node(tag),
    createTextNode: (text) => {
      const n = new Node("#text");
      n.textContent = text;
      return n;
    },
    getElementById: () => null,
    addEventListener() {},
    querySelector: () => null,
    querySelectorAll: () => [],
    activeElement: null,
  };
  const store = () => {
    const m = new Map();
    return {
      getItem: (k) => (m.has(k) ? m.get(k) : null),
      setItem: (k, v) => m.set(k, String(v)),
      removeItem: (k) => m.delete(k),
      clear: () => m.clear(),
    };
  };
  const window = {
    localStorage: store(),
    sessionStorage: store(),
    dispatchEvent() {},
    addEventListener() {},
  };
  globalThis.window = window;
  globalThis.document = document;
  globalThis.HTMLElement = Node;
  globalThis.HTMLButtonElement = Node;
  globalThis.Event = class {
    constructor(type) {
      this.type = type;
    }
  };
  globalThis.CustomEvent = globalThis.Event;
  return { document, body, window };
}

installDom();

const client = (await import("../client/src/aiti-secret-vault-client.mjs")).default;

// ---- harness -------------------------------------------------------------
function makeCtx() {
  const ctx = {
    enhancements: [],
    registerItems() {},
    apiUrl: (p) => "http://local" + p,
    t: (k) => k,
    h: () => null,
    useState: (v) => [v, () => {}],
    useEffect: () => {},
  };
  ctx.registerComposerEnhancement = (enh) => {
    ctx.enhancements.push(enh);
    return () => {};
  };
  return ctx;
}

const ARK = "ark-1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d-9f8e";
const CANDIDATES = [
  { index: 0, label: "ARK_KEY", ruleId: "ark-token", confidence: "high", preview: "ark-1a\u20269f8e", stored: false },
];

function stubFetch({ scan, mask }) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const path = String(url).replace("http://local", "");
    const body = init && init.body ? JSON.parse(init.body) : undefined;
    calls.push({ path, body });
    const payload = path.endsWith("/preflight/scan") ? scan : mask;
    return { json: async () => payload };
  };
  return calls;
}

function gateOf(ctx) {
  const enh = ctx.enhancements.find((e) => e.id === "aiti-secret-vault-preflight");
  assert.ok(enh, "composer enhancement registered");
  assert.equal(typeof enh.onBeforeSend, "function");
  return enh.onBeforeSend;
}

function openDialog() {
  const dialogs = globalThis.document.body.children.filter((c) => c.tagName === "DIALOG");
  assert.equal(dialogs.length, 1, "one dialog is open");
  return dialogs[0];
}

function clickDialog(buttonKey, opts = {}) {
  const dlg = openDialog();
  if (opts.remember) {
    const cb = dlg.find("INPUT");
    assert.ok(cb, "remember checkbox present");
    cb.checked = true;
    cb.handlers.change?.({ target: cb });
  }
  const btn = dlg.find("BUTTON", buttonKey);
  assert.ok(btn, 'button "' + buttonKey + '" present');
  btn.click();
}

const tick = () => new Promise((r) => setImmediate(r));

// ---- tests ---------------------------------------------------------------
test("gate: mask decision stores into the vault and rewrites the message", async () => {
  installDom();
  const ctx = makeCtx();
  await client(ctx);
  const gate = gateOf(ctx);
  const maskedText = "look " + PH("deadbeef") + " please";
  const calls = stubFetch({
    scan: { ok: true, locked: false, candidates: CANDIDATES },
    mask: { ok: true, text: maskedText, aliases: ["auto-ark-key-1"] },
  });

  const pending = gate("look " + ARK + " please", 0);
  await tick();
  clickDialog("sv.pf.mask");
  const out = await pending;

  assert.deepEqual(out, { text: maskedText });
  assert.deepEqual(
    calls.map((c) => c.path),
    ["/api/extensions/aiti-secret-vault/preflight/scan", "/api/extensions/aiti-secret-vault/preflight/mask"],
  );
  assert.deepEqual(calls[1].body.indices, [0]);
});

test("gate: send-as-is passes the text through untouched", async () => {
  installDom();
  const ctx = makeCtx();
  await client(ctx);
  const gate = gateOf(ctx);
  stubFetch({ scan: { ok: true, locked: false, candidates: CANDIDATES } });
  const pending = gate("look " + ARK, 0);
  await tick();
  clickDialog("sv.pf.raw");
  assert.equal(await pending, undefined);
});

test("gate: cancel stops the send and keeps the composer", async () => {
  installDom();
  const ctx = makeCtx();
  await client(ctx);
  const gate = gateOf(ctx);
  stubFetch({ scan: { ok: true, locked: false, candidates: CANDIDATES } });
  const pending = gate("look " + ARK, 0);
  await tick();
  clickDialog("sv.pf.cancel");
  assert.deepEqual(await pending, { cancel: true });
});

test("gate: remember=raw stops asking for the rest of the session", async () => {
  installDom();
  const ctx = makeCtx();
  await client(ctx);
  const gate = gateOf(ctx);
  const calls = stubFetch({
    scan: { ok: true, locked: false, candidates: CANDIDATES },
    mask: { ok: true, text: "x " + PH("deadbeef"), aliases: ["a"] },
  });
  const first = gate("look " + ARK, 0);
  await tick();
  clickDialog("sv.pf.raw", { remember: true });
  assert.equal(await first, undefined);

  const scans = calls.filter((c) => c.path.endsWith("/scan")).length;
  assert.equal(await gate("again " + ARK, 0), undefined, "no dialog, no mask");
  assert.equal(calls.filter((c) => c.path.endsWith("/scan")).length, scans, "not even scanned again");
});

test("gate: remember=mask auto-masks the following messages", async () => {
  installDom();
  const ctx = makeCtx();
  await client(ctx);
  const gate = gateOf(ctx);
  stubFetch({
    scan: { ok: true, locked: false, candidates: CANDIDATES },
    mask: { ok: true, text: "auto " + PH("deadbeef"), aliases: ["a"] },
  });
  const first = gate("look " + ARK, 0);
  await tick();
  clickDialog("sv.pf.mask", { remember: true });
  assert.deepEqual(await first, { text: "auto " + PH("deadbeef") });

  const second = await gate("again " + ARK, 0);
  assert.deepEqual(second, { text: "auto " + PH("deadbeef") });
  assert.equal(globalThis.document.body.children.filter((c) => c.tagName === "DIALOG").length, 0);
});

test("gate: a failed mask cancels instead of sending plaintext", async () => {
  installDom();
  const ctx = makeCtx();
  await client(ctx);
  const gate = gateOf(ctx);
  stubFetch({
    scan: { ok: true, locked: true, candidates: CANDIDATES },
    mask: { ok: false, error: "locked" },
  });
  const pending = gate("look " + ARK, 0);
  await tick();
  clickDialog("sv.pf.mask");
  assert.deepEqual(await pending, { cancel: true }, "mask failure must not send plaintext");
});

test("gate: already-masked text and non-candidates are left alone", async () => {
  installDom();
  const ctx = makeCtx();
  await client(ctx);
  const gate = gateOf(ctx);
  const calls = stubFetch({ scan: { ok: true, locked: false, candidates: [] } });
  assert.equal(await gate("already " + PH("deadbeef") + " masked", 0), undefined);
  assert.equal(calls.length, 0, "no scan for already-masked text");
  assert.equal(await gate("just a normal sentence", 0), undefined);
  assert.equal(globalThis.document.body.children.filter((c) => c.tagName === "DIALOG").length, 0);
});

test("gate: panel toggle disables the pre-send check", async () => {
  const dom = installDom();
  const ctx = makeCtx();
  await client(ctx);
  const gate = gateOf(ctx);
  dom.window.localStorage.setItem("aiti-secret-vault:preflight-off", "1");
  const calls = stubFetch({ scan: { ok: true, locked: false, candidates: CANDIDATES } });
  assert.equal(await gate("look " + ARK, 0), undefined);
  assert.equal(calls.length, 0);
});
