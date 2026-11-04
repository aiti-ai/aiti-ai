/**
 * 测试专用极简 DOM 桩（非产物代码：不被生产模块 import，esbuild 打包不会带入）。
 *
 * 只实现「生成脚本」真正用到的那一小块面：className/classList、attributes、
 * children + appendChild/insertBefore/remove/replaceWith、querySelector(All)/closest、
 * addEventListener + fire、innerHTML 轻解析（标签 + class/属性 → 真节点，够 querySelector 命中）。
 * 目的：用例跑**实际生成的脚本**（node:vm），而不是匹配 TS 源码——模板串转义/拼接一错就红。
 */

const VOID_TAGS = new Set(["img", "br", "input", "hr", "source", "use", "meta", "link", "path"]);

const TOKEN_RE = /^(?:\.([\w-]+)|#([\w-]+)|\[([\w-]+)(?:=["']?([^\]"']*)["']?)?\]|([a-zA-Z][\w-]*))/;

/** 复合选择器（`.a.b[x="y"]`）逐 token 匹配；不支持伪类/兄弟组合（桩无需）。 */
function matchCompound(el, part) {
  let rest = String(part);
  while (rest) {
    const m = TOKEN_RE.exec(rest);
    if (!m) return false;
    if (m[1]) { if (!el.classList.contains(m[1])) return false; }
    else if (m[2]) { if (el.id !== m[2]) return false; }
    else if (m[3]) {
      const v = el.getAttribute(m[3]);
      if (m[4] === undefined ? v === null : v !== m[4]) return false;
    } else if (m[5]) { if (el.tagName !== m[5].toUpperCase()) return false; }
    rest = rest.slice(m[0].length);
  }
  return true;
}

export function matchesSel(el, sel) {
  return String(sel).split(",").some((s) => s.trim().split(/\s+/).every((part) => matchCompound(el, part)));
}

/** 后序遍历所有后代（不含自身）。 */
function descendants(el, fn) {
  el.children.forEach((c) => { fn(c); descendants(c, fn); });
}

/** CSSStyleDeclaration 近似：未设置读 ""（浏览器语义；「存旧值→还原」的写法依赖这点）。 */
function makeStyle() {
  const raw = {};
  return new Proxy(raw, {
    get(t, k) {
      if (typeof k !== "string" || k in t || k in Object.prototype || k.startsWith("_")) return t[k];
      return "";
    },
    set(t, k, v) { t[k] = String(v); return true; },
  });
}

export function makeEl(tag, doc) {
  const el = {
    tagName: String(tag).toUpperCase(), attrs: {}, children: [], parentElement: null,
    style: makeStyle(), textContent: "", hidden: false, type: "", handlers: {},
    ownerDocument: doc || null,
  };
  const classes = new Set();
  Object.defineProperty(el, "className", {
    get: () => Array.from(classes).join(" "),
    set: (v) => { classes.clear(); String(v || "").split(/\s+/).forEach((c) => c && classes.add(c)); },
  });
  el.classList = {
    add: (...cs) => cs.forEach((c) => classes.add(c)),
    remove: (...cs) => cs.forEach((c) => classes.delete(c)),
    contains: (c) => classes.has(c),
    toggle: (c, force) => {
      const on = force === undefined ? !classes.has(c) : !!force;
      if (on) classes.add(c); else classes.delete(c);
      return on;
    },
  };
  el.setAttribute = (k, v) => { el.attrs[k] = String(v); };
  el.getAttribute = (k) => (k in el.attrs ? el.attrs[k] : null);
  el.appendChild = (c) => { el.children.push(c); c.parentElement = el; return c; };
  el.insertBefore = (c, ref) => {
    const i = ref ? el.children.indexOf(ref) : -1;
    el.children.splice(i < 0 ? el.children.length : i, 0, c);
    c.parentElement = el;
    return c;
  };
  el.remove = () => {
    const p = el.parentElement;
    if (p) p.children.splice(p.children.indexOf(el), 1);
    el.parentElement = null;
  };
  el.replaceWith = (n) => {
    const p = el.parentElement;
    el.replaced = n;
    if (!p) return;
    const i = p.children.indexOf(el);
    p.children.splice(i, 1, n);
    n.parentElement = p;
  };
  el.querySelectorAll = (sel) => { const out = []; descendants(el, (c) => { if (matchesSel(c, sel)) out.push(c); }); return out; };
  el.querySelector = (sel) => el.querySelectorAll(sel)[0] || null;
  el.contains = (n) => { for (let p = n; p; p = p.parentElement) if (p === el) return true; return false; };
  el.closest = (sel) => (matchesSel(el, sel) ? el : el.parentElement ? el.parentElement.closest(sel) : null);
  el.addEventListener = (t, fn) => { (el.handlers[t] ||= []).push(fn); };
  el.fire = (t, ev) => (el.handlers[t] || []).forEach((fn) => fn(ev));
  el.click = () => { el.clicked = (el.clicked || 0) + 1; el.fire("click", { target: el }); };
  el.showModal = () => { el.open = true; };
  el.close = () => { el.open = false; el.fire("close", {}); };
  Object.defineProperty(el, "innerHTML", {
    get: () => el._html || "",
    set: (v) => {
      el._html = String(v);
      el.children = [];
      const stack = [el];
      const tagRe = /<(\/?)([a-zA-Z][\w-]*)([^>]*)>/g;
      let m;
      while ((m = tagRe.exec(el._html)) !== null) {
        const top = stack[stack.length - 1];
        if (m[1]) { if (stack.length > 1) stack.pop(); continue; }
        const child = makeEl(m[2], doc);
        const attrRe = /([\w-]+)\s*=\s*"([^"]*)"/g;
        let a;
        while ((a = attrRe.exec(m[3])) !== null) {
          if (a[1] === "class") child.className = a[2];
          else if (a[1] === "id") child.id = a[2];
          else child.setAttribute(a[1], a[2]);
        }
        top.appendChild(child);
        if (!/\/\s*$/.test(m[3]) && !VOID_TAGS.has(m[2].toLowerCase())) stack.push(child);
      }
    },
  });
  return el;
}

/**
 * iframe 文档桩：body/head + 事件监听表 + defaultView（窗口）。
 * @param win 预先造好的窗口（渲染器要往 window 上挂 mermaid / 读 XMLSerializer 等）
 */
export function makeDoc(win) {
  const doc = {
    handlers: {},
    created: [],
    createElement: (t) => { const el = makeEl(t, doc); doc.created.push(el); return el; },
    createTextNode: (t) => ({ nodeType: 3, textContent: t }),
    addEventListener: (t, fn) => { (doc.handlers[t] ||= []).push(fn); },
    fire: (t, ev) => (doc.handlers[t] || []).forEach((fn) => fn(ev)),
    defaultView: win || null,
  };
  doc.head = makeEl("head", doc);
  doc.body = makeEl("body", doc);
  doc.documentElement = makeEl("html", doc);
  doc.querySelector = (sel) => [doc.documentElement, doc.head, doc.body].map((n) => n.querySelector(sel)).filter(Boolean)[0] || null;
  return doc;
}
