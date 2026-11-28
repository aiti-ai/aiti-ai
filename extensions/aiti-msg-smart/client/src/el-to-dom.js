/**
 * el-to-dom — minimal React element tree → real DOM (delegated click paths have no react-dom)
 *
 * The popover card is built with ctx.h (React createElement). Paragraph clicks hand that tree
 * to react-dom, but code-line / diff-cell / thinking-line clicks come from a document-level
 * click delegate where no React root exists, so the very same tree is rebuilt with DOM APIs.
 *
 * Supported node shapes mirror what the card actually uses: null/false/true (skipped),
 * strings/numbers (text nodes), arrays (fragments), function components (no hooks) and
 * `{ type: <tagName>, props }` elements.
 *
 * Function components MUST be expanded here: `createElement(node.type)` turns the function's
 * source text into a tag name and throws InvalidCharacterError ("... is not a valid name"),
 * which emptied the whole card — the file section's open/reveal icons are function components,
 * so a code-line popover vanished as soon as the async path probe re-rendered it with rows.
 */

/** React style keys that stay unitless when set through the DOM (React's own set). */
const UNITLESS_STYLE = new Set(["opacity", "zIndex", "flex", "flexGrow", "flexShrink", "order", "lineHeight", "fontWeight", "zoom", "scale", "aspectRatio"]);

const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * @param {any} node React element tree produced by createElement
 * @param {Document} doc target document (the popover may live in a same-origin iframe)
 * @param {string} [ns] SVG namespace while building inside an <svg> subtree (doctype: icons)
 * @returns {Node|null}
 */
export function elToDom(node, doc, ns) {
  if (node == null || node === false || node === true) return null;
  if (typeof node === "string" || typeof node === "number") return doc.createTextNode(String(node));
  if (Array.isArray(node)) {
    const frag = doc.createDocumentFragment();
    for (const n of node) {
      const d = elToDom(n, doc, ns);
      if (d) frag.appendChild(d);
    }
    return frag;
  }
  const props = node.props || {};
  // Function component (no react-dom, no hooks here): call it and rebuild the returned tree.
  // children already travel inside props, so nothing else needs spreading.
  if (typeof node.type === "function") return elToDom(node.type({ ...props }), doc, ns);
  // SVG subtrees must use createElementNS: plain createElement("svg") yields an
  // HTMLUnknownElement in the HTML namespace (verified in Chrome) — icons rendered as
  // nothing at all. Inside <svg> everything (path/circle/line/rect) stays SVG-namespace.
  const isSvg = node.type === "svg";
  const childNs = isSvg ? SVG_NS : ns;
  const el = isSvg || ns ? doc.createElementNS(childNs, node.type) : doc.createElement(node.type);
  for (const k of Object.keys(props)) {
    if (k === "children" || k === "key") continue;
    const v = props[k];
    if (v == null) continue;
    if (k === "style" && typeof v === "object") {
      for (const sk of Object.keys(v)) {
        let sv = v[sk];
        // React appends px to numeric style values (except unitless ones); DOM assignment does not.
        if (typeof sv === "number" && !UNITLESS_STYLE.has(sk)) sv = sv + "px";
        try { el.style[sk] = sv; } catch {}
      }
    }
    else if (k === "className") el.className = String(v);
    else if (k.startsWith("on") && typeof v === "function") {
      const ev = k.slice(2).toLowerCase();
      el.addEventListener(ev, v); // native event: stopPropagation/currentTarget behave like React's synthetic event
    }
    else if (k === "dangerouslySetInnerHTML" && v && typeof v.__html === "string") {
      // Provider icon {svg} markup (circle/line/path mix) lands verbatim; on an
      // SVG-namespace root this parses in SVG context → real renderable children.
      try { el.innerHTML = v.__html; } catch {}
    }
    else if (v !== false) { try { el.setAttribute(k, String(v)); } catch {} }
  }
  const kd = elToDom(props.children, doc, childNs);
  if (kd) el.appendChild(kd);
  return el;
}
