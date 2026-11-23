/**
 * el-to-dom regression tests — the delegated popover card must survive every node shape that
 * `buildCardNode` produces.
 *
 * Background: code-line / diff-cell / thinking-line clicks render the card through a
 * document-level click delegate (no react-dom). The file section embeds function components
 * (open/reveal icons) and question rows embed `SegmentRow`; passing one of those to
 * `createElement` makes the browser throw InvalidCharacterError, which blanked the whole card —
 * i.e. the click popover appeared and vanished as soon as the async path probe re-rendered it.
 * The fake document below deliberately rejects non-Name tag names, like a real one.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { elToDom } from "../client/src/el-to-dom.js";

/** Minimal DOM: enough for elToDom, and strict about tag names (createElement(function) throws). */
function fakeDoc() {
  const NAME = /^[A-Za-z][A-Za-z0-9-]*$/;
  const SVG_NS = "http://www.w3.org/2000/svg";
  const makeEl = (tag, ns) => {
    if (!NAME.test(tag)) {
      throw new Error(`InvalidCharacterError: The tag name provided ('${String(tag).slice(0, 40)}') is not a valid name.`);
    }
    return {
      tagName: tag.toUpperCase(),
      namespaceURI: ns || "http://www.w3.org/1999/xhtml",
      nodeType: 1,
      style: {},
      attrs: {},
      listeners: {},
      children: [],
      set className(v) { this.attrs.class = v; },
      get className() { return this.attrs.class; },
      setAttribute(k, v) { this.attrs[k] = v; },
      addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); },
      appendChild(n) {
        // Real DOM inserts a fragment's children (elToDom returns fragments for arrays)
        if (n && n.nodeType === 11) { for (const c of n.children) this.children.push(c); }
        else this.children.push(n);
        return n;
      },
    };
  };
  const frag = () => ({
    nodeType: 11,
    children: [],
    appendChild(n) {
      if (n && n.nodeType === 11) { for (const c of n.children) this.children.push(c); }
      else this.children.push(n);
      return n;
    },
  });
  return {
    createElement: makeEl,
    createElementNS: (ns, tag) => makeEl(tag, ns),
    createTextNode: (t) => ({ nodeType: 3, text: t }),
    createDocumentFragment: frag,
  };
}

test("function components are expanded instead of becoming tag names", () => {
  const doc = fakeDoc();
  // Same shape as the card's file row: a button whose child is a function component icon.
  const FolderOpenIcon = () => ({ type: "svg", props: { width: 12, children: [{ type: "path", props: { d: "M6 14l1" } }] } });
  const tree = {
    type: "button",
    props: { className: "file-action", children: [elLike(FolderOpenIcon)] },
  };
  const dom = elToDom(tree, doc);
  assert.equal(dom.tagName, "BUTTON");
  assert.equal(dom.attrs.class, "file-action");
  const svg = dom.children[0];
  assert.equal(svg.tagName, "SVG");
  assert.equal(svg.attrs.width, "12");
  assert.equal(svg.children[0].tagName, "PATH");
  assert.equal(svg.children[0].attrs.d, "M6 14l1");
});

test("function component receives its props (SegmentRow shape) and can return children", () => {
  const doc = fakeDoc();
  const SegmentRow = ({ segment, label }) => ({
    type: "span",
    props: { children: [{ type: "button", props: { title: segment, children: label } }] },
  });
  const dom = elToDom({ type: "span", props: { children: [elLike(SegmentRow, { segment: "a? b?", label: "引用单句：a?" })] } }, doc);
  assert.equal(dom.children[0].tagName, "SPAN");
  assert.equal(dom.children[0].children[0].tagName, "BUTTON");
  assert.equal(dom.children[0].children[0].attrs.title, "a? b?");
  assert.equal(dom.children[0].children[0].children[0].text, "引用单句：a?");
});

test("plain elements: numeric style → px, unitless style untouched, events, attributes, text", () => {
  const doc = fakeDoc();
  const onClick = () => {};
  const dom = elToDom({
    type: "span",
    props: {
      style: { maxWidth: 220, zIndex: 300, display: "flex" },
      className: "card",
      onClick,
      "data-msg-smart-card": "1",
      "aria-hidden": true,
      hidden: false,
      children: ["copy", null, false, 3, [ { type: "b", props: {} } ]],
    },
  }, doc);
  assert.equal(dom.style.maxWidth, "220px");
  assert.equal(dom.style.zIndex, 300); // unitless: number kept, no px
  assert.equal(dom.style.display, "flex");
  assert.equal(dom.attrs.class, "card");
  assert.equal(dom.attrs["data-msg-smart-card"], "1");
  assert.equal(dom.attrs["aria-hidden"], "true");
  assert.equal(dom.attrs.hidden, undefined); // false is skipped, not stringified
  assert.equal(typeof dom.listeners.click[0], "function");
  // null/false skipped; strings/numbers → text nodes; arrays flattened into the same fragment
  assert.deepEqual(dom.children.map((c) => c.nodeType ?? c.tagName), [3, 3, 1]);
  assert.equal(dom.children[0].text, "copy");
  assert.equal(dom.children[1].text, "3");
});

test("a non-Name tag string still fails loudly (guard on the fake document itself)", () => {
  const doc = fakeDoc();
  assert.throws(() => elToDom({ type: "svg icon", props: {} }, doc), /InvalidCharacterError/);
});

test("svg subtrees use createElementNS (plain createElement yields HTMLUnknownElement in real DOM)", () => {
  const doc = fakeDoc();
  const dom = elToDom({
    type: "svg",
    props: { viewBox: "0 0 24 24", children: [{ type: "path", props: { d: "M1 1" } }, { type: "circle", props: { cx: 2 } }] },
  }, doc);
  assert.equal(dom.namespaceURI, "http://www.w3.org/2000/svg");
  for (const c of dom.children) assert.equal(c.namespaceURI, "http://www.w3.org/2000/svg");
  // HTML context stays untouched (no ns threading into non-svg siblings)
  const btn = elToDom({ type: "button", props: { children: "x" } }, doc);
  assert.equal(btn.namespaceURI, "http://www.w3.org/1999/xhtml");
});

test("dangerouslySetInnerHTML lands verbatim on the element (provider icon {svg})", () => {
  const doc = fakeDoc();
  const markup = '<circle cx="18" cy="5" r="3"/><path d="M1 1"/>';
  const dom = elToDom({
    type: "svg",
    props: { dangerouslySetInnerHTML: { __html: markup } },
  }, doc);
  // fake doc: innerHTML assignment is a plain property write — asserts the branch ran and
  // wrote the markup (a real SVG root parses this in SVG context into renderable children).
  assert.equal(dom.innerHTML, markup);
  // malformed values are skipped silently (no throw, element still built)
  const bad = elToDom({ type: "svg", props: { dangerouslySetInnerHTML: { __html: 42 } } }, doc);
  assert.equal(bad.tagName, "SVG");
  // a tree with children and NO dangerouslySetInnerHTML keeps normal children
  const withKids = elToDom({ type: "svg", props: { children: [{ type: "path", props: { d: "M2 2" } }] } }, doc);
  assert.equal(withKids.children.length, 1);
});

test("function components receive the svg namespace context through recursion", () => {
  const doc = fakeDoc();
  const Icon = () => ({ type: "svg", props: { children: [{ type: "path", props: { d: "M3 3" } }] } });
  const dom = elToDom({ type: "span", props: { children: [elLike(Icon)] } }, doc);
  const svg = dom.children[0];
  assert.equal(svg.namespaceURI, "http://www.w3.org/2000/svg");
  assert.equal(svg.children[0].namespaceURI, "http://www.w3.org/2000/svg");
});

/** createElement(function) → { type: fn, props }, i.e. what ctx.h(h(FolderOpenIcon)) produces. */
function elLike(type, props) {
  return { type, props: props || {} };
}
