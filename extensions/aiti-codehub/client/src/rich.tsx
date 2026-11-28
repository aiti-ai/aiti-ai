/**
 * Rich text renderer for work item descriptions/comments.
 *
 * - RICHTEXT providers (Yunxiao) supply raw HTML → DOMPurify sanitizes it.
 * - Markdown bodies (issues, Yunxiao MARKDOWN) → marked → DOMPurify.
 * - Authenticated Yunxiao file URLs (images/attachments) are rewritten to the
 *   extension's server-side proxy, which attaches the PAT/OAuth token.
 */
import DOMPurify from "dompurify";
import { marked } from "marked";
import { apiUrl, t } from "./host-shim";
import { S } from "./ui";

const ALLOWED_TAGS = [
  "a", "article", "b", "blockquote", "br", "code", "del", "div", "em", "h1", "h2", "h3", "h4", "h5", "h6",
  "hr", "i", "img", "li", "ol", "p", "pre", "s", "span", "strong", "sub", "sup", "table", "tbody", "td", "tfoot",
  "th", "thead", "tr", "u", "ul", "font",
];
const ALLOWED_ATTR = ["href", "src", "alt", "title", "target", "rel", "colspan", "rowspan", "start", "type", "style", "class", "width", "height"];

export function isYunxiaoFileUrl(url: string): boolean {
  try {
    const u = new URL(url, location.origin);
    const hostOk = u.hostname === "devops.aliyun.com" || u.hostname === "openapi-rdc.aliyuncs.com" || u.hostname.endsWith(".aliyuncs.com");
    return hostOk && u.pathname.includes("/projex/api/workitem/file/");
  } catch {
    return false;
  }
}

/**
 * Authenticated attachment proxy. `instance` is the account instance id (the platform
 * may have several accounts, each with its own token) — never a hardcoded platform.
 */
export function fileProxyUrl(fileId: string, workitemId: string, instance = "yunxiao", download = false): string {
  return apiUrl(
    "/api/extensions/aiti-codehub/file?provider=" + encodeURIComponent(instance || "yunxiao") +
    "&workitemId=" + encodeURIComponent(workitemId) +
    "&fileId=" + encodeURIComponent(fileId) +
    (download ? "&download=1" : ""),
  );
}

/** Extract the Yunxiao fileIdentifier from a web file URL. */
export function fileIdentifierOf(url: string): string | null {
  try {
    const u = new URL(url, location.origin);
    return u.searchParams.get("fileIdentifier");
  } catch {
    return null;
  }
}

function rewriteLinks(html: string, workitemId: string, instance: string): string {
  try {
    const doc = new DOMParser().parseFromString(html, "text/html");
    for (const img of Array.from(doc.querySelectorAll("img"))) {
      const src = img.getAttribute("src") || "";
      const fid = isYunxiaoFileUrl(src) ? fileIdentifierOf(src) : null;
      if (fid) img.setAttribute("src", fileProxyUrl(fid, workitemId, instance));
      img.setAttribute("loading", "lazy");
      img.setAttribute("referrerpolicy", "no-referrer");
      if (!img.getAttribute("alt")) img.setAttribute("alt", "");
    }
    for (const a of Array.from(doc.querySelectorAll("a"))) {
      const href = a.getAttribute("href") || "";
      const fid = isYunxiaoFileUrl(href) ? fileIdentifierOf(href) : null;
      if (fid) {
        a.setAttribute("href", fileProxyUrl(fid, workitemId, instance, true));
        a.setAttribute("title", a.textContent ? t("ch.rich.downloadNamed", { name: a.textContent.trim() }) : t("ch.rich.download"));
      }
      a.setAttribute("target", "_blank");
      a.setAttribute("rel", "noreferrer noopener");
    }
    return doc.body.innerHTML;
  } catch {
    return html;
  }
}

/** HTML for a rich body, or null when the content is plain text. */
export function richHtml(text: string | undefined, html: string | undefined, format: string | undefined, workitemId = "", instance = ""): string | null {
  let raw = "";
  if (html) raw = html;
  else if (format === "markdown" && text) {
    try {
      raw = marked.parse(text, { gfm: true, breaks: true }) as string;
    } catch {
      raw = "";
    }
  }
  if (!raw) return null;
  const clean = DOMPurify.sanitize(raw, { ALLOWED_TAGS, ALLOWED_ATTR });
  return rewriteLinks(clean, workitemId, instance);
}

export function RichBody(p: {
  text?: string;
  html?: string;
  format?: string;
  workitemId?: string;
  /** Account instance id for authenticated attachment URLs. */
  instance?: string;
  style?: Record<string, unknown>;
}) {
  const rendered = richHtml(p.text, p.html, p.format, p.workitemId || "", p.instance || "");
  if (rendered) {
    return <div className="codehub-rich" style={{ lineHeight: 1.65, fontSize: 12.5, wordBreak: "break-word", ...(p.style || {}) }} dangerouslySetInnerHTML={{ __html: rendered }} />;
  }
  return <div style={{ whiteSpace: "pre-wrap", lineHeight: 1.65, fontSize: 12.5, color: "var(--text, #ddd)", ...(p.style || {}), ...(p.text ? {} : S.muted) }}>{p.text || t("ch.rich.empty")}</div>;
}

if (typeof document !== "undefined" && !document.getElementById("codehub-rich-style")) {
  const st = document.createElement("style");
  st.id = "codehub-rich-style";
  st.textContent = `
.codehub-rich img { max-width: 100%; height: auto; border-radius: 6px; border: 1px solid var(--border, #3a3a3a); }
.codehub-rich p { margin: 6px 0; }
.codehub-rich ol, .codehub-rich ul { margin: 6px 0; padding-left: 24px; }
.codehub-rich ol { list-style: decimal outside; }
.codehub-rich ul { list-style: disc outside; }
.codehub-rich li { margin: 2px 0; display: list-item; }
.codehub-rich li > p { margin: 2px 0; }
.codehub-rich h1, .codehub-rich h2, .codehub-rich h3, .codehub-rich h4 { margin: 10px 0 6px; font-size: 14px; }
.codehub-rich a { color: var(--accent, #2563eb); }
.codehub-rich table { border-collapse: collapse; margin: 6px 0; }
.codehub-rich td, .codehub-rich th { border: 1px solid var(--border, #3a3a3a); padding: 4px 7px; }
.codehub-rich pre { overflow: auto; padding: 8px 10px; background: var(--bg-panel, #141414); border: 1px solid var(--border, #3a3a3a); border-radius: 6px; }
.codehub-rich code { font-family: ui-monospace, SFMono-Regular, monospace; font-size: 11.5px; }
.codehub-rich blockquote { margin: 6px 0; padding-left: 10px; border-left: 3px solid var(--border, #3a3a3a); color: var(--text-muted, #999); }
`;
  document.head.appendChild(st);
}
