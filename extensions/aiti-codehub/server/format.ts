/**
 * Formatting helpers shared by every provider: template expansion, branch-name
 * sanitizing and rich-text flattening (Yunxiao JSONML / HTML). No DOM APIs here —
 * the client reuses the same pure functions through the server.
 */
import type { ForgeWorkItem } from "./contract.ts";

export function replaceTemplate(template: string, vars: Record<string, string | undefined>, sanitize?: (v: string) => string): string {
  return String(template || "").replace(/\{(\w+)\}/g, (_m, key: string) => {
    const raw = vars[key] ?? "";
    return sanitize ? sanitize(String(raw)) : String(raw);
  });
}

/** Sanitize a branch name: git-ref rules + the legacy extension's character policy. */
export function sanitizeBranchName(value: string | undefined | null): string {
  let s = String(value || "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[\\/:*?"<>|~\s]+/g, "_") // illegal for git + whitespace
    .replace(/\.{2,}/g, "_") // no ".."
    .replace(/@\{/g, "_")
    .replace(/_+/g, "_")
    .replace(/^[-._/]+|[-._/]+$/g, "")
    .replace(/\.lock$/i, "")
    .slice(0, 50)
    .replace(/^[-._/]+|[-._/]+$/g, "");
  if (!s) s = "work";
  return s;
}

/**
 * Variables available in paste / AI / branch templates.
 * `provider` is the platform label (e.g. Yunxiao) and `account` the instance alias, so
 * multi-account setups keep stable template output.
 */
export function templateVars(item: ForgeWorkItem, provider: string, account = ""): Record<string, string> {
  const now = new Date();
  const date = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}`;
  return {
    provider,
    account,
    id: item.key || item.id || "",
    key: item.key || item.id || "",
    number: item.number !== undefined ? String(item.number) : item.key || "",
    title: item.title || "",
    description: item.description || "",
    type: item.type || "",
    category: item.type || "",
    status: item.status || "",
    state: item.state || "",
    assignee: item.assignee || "",
    creator: item.creator || "",
    priority: item.priority || "",
    labels: (item.tags || []).join(", "),
    tags: (item.tags || []).join(", "),
    link: item.webUrl || "",
    url: item.webUrl || "",
    scope: item.scope?.label || "",
    date,
  };
}

export function formatWorkItemText(item: ForgeWorkItem, provider: string, template: string, account = ""): string {
  const vars = templateVars(item, provider, account);
  return replaceTemplate(template, vars)
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function formatBranchName(item: ForgeWorkItem, provider: string, template: string, account = ""): string {
  const vars = templateVars(item, provider, account);
  return replaceTemplate(template, vars, sanitizeBranchName);
}

/* ───────────────────────────── rich text ───────────────────────────── */

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

/** HTML → plain text, collecting <img src> so the UI can show images as links. */
export function htmlToText(html: string): { text: string; images: string[] } {
  if (!html) return { text: "", images: [] };
  const images: string[] = [];
  for (const m of String(html).matchAll(/<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi)) {
    if (m[1]) images.push(m[1]);
  }
  const text = String(html)
    .replace(/<li[^>]*>/gi, "\n  • ")
    .replace(/<\/li>/gi, "")
    .replace(/<(p|div|h[1-6]|tr|table|ul|ol|blockquote|pre)[^>]*>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<\/h[1-6]>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/\n{2,}/g, "\n")
    .trim();
  return { text: decodeEntities(text), images };
}

type JsonMLNode = string | [string, Record<string, unknown>?, ...JsonMLNode[]];

/** JSONML (Yunxiao RICHTEXT) → plain text + image URLs. */
export function jsonmlToText(node: unknown): { text: string; images: string[] } {
  const images: string[] = [];
  const out: string[] = [];

  const walk = (n: unknown): void => {
    if (n === null || n === undefined) return;
    if (typeof n === "string") {
      out.push(n);
      return;
    }
    if (Array.isArray(n)) {
      const tag = String(n[0] ?? "");
      const attrs = (n[1] && typeof n[1] === "object" && !Array.isArray(n[1]) ? n[1] : {}) as Record<string, unknown>;
      if (tag === "img" || tag === "image") {
        const src = attrs.src || attrs.url;
        if (typeof src === "string" && src) images.push(src);
        return;
      }
      if (tag === "a" && typeof attrs.href === "string" && attrs.href) {
        // keep link text, append href in parentheses when it differs
        const before = out.length;
        for (const c of n.slice(2)) walk(c);
        const label = out.slice(before).join("").trim();
        if (label && label !== attrs.href) out.push(` (${attrs.href})`);
        return;
      }
      if (tag === "p") {
        const list = attrs.list as { level?: number; listStyle?: { text?: string } } | undefined;
        if (list) {
          const indent = "  ".repeat(Number(list.level) || 0);
          out.push(`\n${indent}${list.listStyle?.text || "•"} `);
        } else {
          out.push("\n");
        }
      } else if (tag === "br") {
        out.push("\n");
        return;
      } else if (tag === "li") {
        out.push("\n  • ");
      }
      for (const c of n.slice(2)) walk(c);
      if (tag === "p" || tag === "li" || /^h[1-6]$/.test(tag)) out.push("\n");
      return;
    }
    if (typeof n === "object") {
      const o = n as Record<string, unknown>;
      if (typeof o.text === "string") out.push(o.text);
    }
  };

  walk(node);
  const text = out.join("").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return { text, images };
}

/**
 * Flatten a Yunxiao description/comment payload. Accepts:
 * - a plain string (markdown / text);
 * - a JSON string of { htmlValue, jsonMLValue, formatType };
 * - the already-parsed object.
 */
export function flattenRichContent(description: unknown): { text: string; images: string[] } {
  if (description === null || description === undefined) return { text: "", images: [] };
  if (typeof description === "string") {
    const s = description.trim();
    if (!s) return { text: "", images: [] };
    if (s.startsWith("{") || s.startsWith("[")) {
      try {
        return flattenRichContent(JSON.parse(s));
      } catch {
        return { text: description, images: [] };
      }
    }
    return { text: description, images: [] };
  }
  if (Array.isArray(description)) return jsonmlToText(description);
  if (typeof description === "object") {
    const o = description as Record<string, unknown>;
    if (typeof o.htmlValue === "string" && o.htmlValue) return htmlToText(o.htmlValue);
    if (o.jsonMLValue !== undefined) return jsonmlToText(o.jsonMLValue);
    if (typeof o.text === "string") return { text: o.text, images: [] };
  }
  return { text: String(description), images: [] };
}

/** JSONML (Yunxiao RICHTEXT) → safe-ish HTML for the client renderer (DOMPurify runs there). */
export function jsonmlToHtml(node: unknown): string {
  const esc = (v: string): string => String(v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const escAttr = (v: string): string => esc(v).replace(/"/g, "&quot;");
  const walk = (n: unknown): string => {
    if (typeof n === "string") return esc(n);
    if (n === null || n === undefined || typeof n !== "object") return "";
    if (!Array.isArray(n)) return "";
    const tag = String(n[0] || "");
    const attrs = (n[1] && typeof n[1] === "object" && !Array.isArray(n[1]) ? n[1] : {}) as Record<string, unknown>;
    const kids = n.slice(2);
    const src = attrs.src || attrs.url;
    if (tag === "img" || tag === "image") {
      return typeof src === "string" && src ? `<img src="${escAttr(src)}" alt="">` : "";
    }
    const style: string[] = [];
    if (attrs.bold) style.push("font-weight:600");
    if (attrs.italic) style.push("font-style:italic");
    if (attrs.underline) style.push("text-decoration:underline");
    if (attrs.color) style.push(`color:${String(attrs.color)}`);
    if (attrs.sz) style.push(`font-size:${Number(attrs.sz) || 10.5}pt`);
    const href = typeof attrs.href === "string" && attrs.href ? ` href="${escAttr(attrs.href)}"` : "";
    const attr = `${href}${style.length ? ` style="${style.join(";")}"` : ""}`;
    const inner = kids.map(walk).join("");
    if (tag === "root") return inner;
    if (tag === "a") return `<a${attr} target="_blank" rel="noreferrer">${inner}</a>`;
    if (!tag) return inner;
    return `<${tag}${attr}>${inner}</${tag}>`;
  };
  return walk(node);
}

/* ───────────────────────────── rich content detection ───────────────────────────── */

/** Markdown-likeness score (headings/lists/code/links/tables/bold...). */
export function markdownScore(text: string): number {
  const s = String(text || "").replace(/\r\n/g, "\n");
  if (!s.trim()) return 0;
  let score = 0;
  if (/^#{1,6}\s+\S/m.test(s)) score += 2;
  if (/^```/m.test(s)) score += 2;
  if (/^\|.+\|\s*$/m.test(s) && /^\|[\s:|-]+\|\s*$/m.test(s)) score += 2;
  const listLines = (s.match(/^\s*(?:[-*+]|\d{1,3}[.)])\s+\S/gm) || []).length;
  if (listLines >= 2) score += 2;
  if (/\[[^\]]+\]\([^)\s]+\)/.test(s)) score += 1;
  if (/`[^`\n]+`/.test(s)) score += 1;
  if (/\*\*[^*\n]+\*\*|__[^_\n]+__/.test(s)) score += 1;
  if (/^>\s+\S/m.test(s)) score += 1;
  if (/^(-{3,}|\*{3,}|_{3,})\s*$/m.test(s)) score += 1;
  return score;
}

/** Whether the content carries Markdown structure (headings/lists/code/links/tables). */
export function looksLikeMarkdown(text: string): boolean {
  return markdownScore(text) >= 2;
}

/** Convert HTML-derived bullet text to Markdown list items (used only for markdown mode). */
export function markdownizeText(text: string): string {
  return String(text || "")
    .replace(/\u00a0/g, " ")
    .replace(/^(\s*)•\s+/gm, "$1- ");
}

/** HTML with only paragraphs/spans/breaks is "trivial"; real rich formatting is kept as HTML. */
export function isTrivialHtml(html: string): boolean {
  if (!html) return true;
  if (/<(img|a|ul|ol|li|table|thead|tbody|tr|td|th|pre|code|h[1-6]|strong|b|em|i|u|blockquote|font)\b/i.test(html)) return false;
  if (/<[^>]+\bstyle\s*=/i.test(html)) return false;
  return true;
}

export interface NormalizedRichContent {
  text: string;
  html?: string;
  format: "markdown" | "richtext" | "text";
  images: string[];
}

/**
 * Normalize a provider description/comment:
 * - explicit MARKDOWN → markdown;
 * - real rich HTML (formatting/images/lists/tables) → richtext;
 * - otherwise, Markdown-looking plain text (even when the platform claims RICHTEXT)
 *   is rendered as markdown;
 * - remaining content → text.
 */
export function normalizeRichContent(raw: unknown, formatType?: string): NormalizedRichContent {
  const flat = flattenRichContent(raw);
  let obj: Record<string, unknown> | null = null;
  if (raw && typeof raw === "object") obj = raw as Record<string, unknown>;
  else if (typeof raw === "string" && raw.trim().startsWith("{")) {
    try { obj = JSON.parse(raw) as Record<string, unknown>; } catch { obj = null; }
  }
  const html = obj && typeof obj.htmlValue === "string" && obj.htmlValue
    ? obj.htmlValue
    : obj && obj.jsonMLValue !== undefined
      ? jsonmlToHtml(obj.jsonMLValue)
      : "";
  const ft = String(formatType || "").toUpperCase();
  if (ft === "MARKDOWN") {
    return { text: typeof raw === "string" ? raw : flat.text, format: "markdown", images: flat.images };
  }
  const mdScore = markdownScore(flat.text);
  const toMarkdown = (): string => {
    let md = obj && obj.jsonMLValue !== undefined ? jsonmlToMarkdown(obj.jsonMLValue) : "";
    if (!md) md = markdownizeText(flat.text);
    const missing = flat.images.filter((u) => !md.includes(u));
    if (missing.length) md += "\n\n" + missing.map((u) => `![image](${u})`).join("\n");
    return compactTableRows(md.trim());
  };
  // Strong Markdown signal wins even when the platform wrapped it in rich HTML:
  // CEXP-style descriptions mix an editor list with literal "##"/tables/bold/code.
  if (mdScore >= 4) {
    return { text: toMarkdown(), format: "markdown", images: flat.images };
  }
  if (html && !isTrivialHtml(html)) {
    return { text: flat.text, html, format: "richtext", images: flat.images };
  }
  if (mdScore >= 2) {
    return { text: toMarkdown(), format: "markdown", images: flat.images };
  }
  if (html) return { text: flat.text, html, format: "richtext", images: flat.images };
  return { text: flat.text, format: "text", images: flat.images };
}

/** JSONML (Yunxiao RICHTEXT) → Markdown, preserving lists/links/images and literal Markdown text. */
export function jsonmlToMarkdown(node: unknown): string {
  const out: string[] = [];
  const walk = (n: unknown): void => {
    if (n === null || n === undefined) return;
    if (typeof n === "string") {
      out.push(n);
      return;
    }
    if (!Array.isArray(n)) return;
    const tag = String(n[0] || "");
    const attrs = (n[1] && typeof n[1] === "object" && !Array.isArray(n[1]) ? n[1] : {}) as Record<string, unknown>;
    const kids = n.slice(2);
    if (tag === "img" || tag === "image") {
      const src = attrs.src || attrs.url;
      if (typeof src === "string" && src) out.push(`\n![image](${src})\n`);
      return;
    }
    if (tag === "a") {
      const href = typeof attrs.href === "string" ? attrs.href : "";
      out.push("[");
      for (const k of kids) walk(k);
      out.push(`](${href})`);
      return;
    }
    if (tag === "br") {
      out.push("\n");
      return;
    }
    if (tag === "p") {
      const list = attrs.list as { level?: number; isOrdered?: boolean; listStyle?: { text?: string } } | undefined;
      if (list) {
        const indent = "  ".repeat(Number(list.level) || 0);
        out.push(`\n${indent}${list.isOrdered ? "1. " : "- "}`);
      } else {
        out.push("\n");
      }
      for (const k of kids) walk(k);
      out.push("\n");
      return;
    }
    if (tag === "li") {
      out.push("\n- ");
      for (const k of kids) walk(k);
      out.push("\n");
      return;
    }
    const bold = attrs.bold === true;
    const italic = attrs.italic === true;
    if (bold) out.push("**");
    if (italic) out.push("*");
    for (const k of kids) walk(k);
    if (italic) out.push("*");
    if (bold) out.push("**");
  };
  walk(node);
  return compactTableRows(out.join("").replace(/\*{4,}/g, "").replace(/\n{3,}/g, "\n\n").trim());
}

/** GFM tables require header/delimiter/rows on adjacent lines; HTML paragraphs add blanks. */
export function compactTableRows(md: string): string {
  const lines = String(md || "").split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === "") {
      let j = i + 1;
      while (j < lines.length && lines[j].trim() === "") j++;
      const prev = out.length ? out[out.length - 1] : "";
      const next = j < lines.length ? lines[j] : "";
      if (prev.trim().startsWith("|") && next.trim().startsWith("|")) continue;
    }
    out.push(lines[i]);
  }
  return out.join("\n");
}
