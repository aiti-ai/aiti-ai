/**
 * md-desc —— 扩展详情 markdown 描述渲染（DESC.md 约定）。
 *
 * 数据链：扩展目录 DESC.md（extman 服务端 withDescription 静态读取，附到 entry.descriptionMd）
 *   → extman client（本组件）约定变量替换 → 极简 markdown 渲染。
 *
 * 约定变量（{{名称}}，渲染前整体替换，代码块内同样生效——bookmarklet/脚本模板的关键）：
 *   {{aiti-url}}      当前 pi-web 实例外部地址（origin + basePath，如 https://pi.example.com:8443/dev）
 *   {{ext-id}}        扩展 id
 *   {{ext-dir}}       扩展安装目录（本地详情才有）
 *   {{ext-data-dir}}  扩展数据目录（本地详情才有，可能缺省）
 *
 * 安全模型：全部经 React 元素生成（无 dangerouslySetInnerHTML、无 raw HTML 透传），
 * 链接只放行 http/https（javascript: 等不生成 <a>——bookmarklet 一律走代码块「复制」）。
 * 支持：# 标题 / 段落 / **粗** *斜* `行内码` / ``` 围栏代码块（带复制按钮） /
 *       - 无序与 1. 有序列表（一层缩进）/ > 引用 / --- 分隔线 / [文字](http…) / http(s) 自动成链。
 */
import { useState } from "react";
import { t, apiUrl } from "./host-shim";
import type { CSSProperties, ReactNode } from "react";

export type MdVars = Record<string, string>;

/** 组装某扩展的约定变量表（basePath 经宿主 apiUrl 探针推导，多实例 /dev 前缀安全）。 */
export function extDescVars(extId: string, entry?: { dir?: string; configDir?: string }): MdVars {
  const vars: MdVars = { "ext-id": extId };
  try {
    const probe = apiUrl("/api/__md_probe__");
    const base = probe.replace(/\/api\/__md_probe__.*$/, "").replace(/\/+$/, "");
    vars["aiti-url"] = location.origin + base;
  } catch {
    vars["aiti-url"] = location.origin;
  }
  if (entry && typeof entry.dir === "string" && entry.dir) vars["ext-dir"] = entry.dir;
  if (entry && typeof entry.configDir === "string" && entry.configDir) vars["ext-config-dir"] = entry.configDir;
  return vars;
}

/** {{var}} 替换；未知变量原样保留（肉眼可见好排查）。 */
export function substVars(text: string, vars: MdVars): string {
  return text.replace(/\{\{\s*([A-Za-z0-9_-]+)\s*\}\}/g, (m: string, k: string) =>
    Object.prototype.hasOwnProperty.call(vars, k) ? vars[k] : m);
}

// ---------- 行内解析 ----------
// 顺序：`code` → **bold** → *italic* → [text](http…) → 裸 http(s) 自动成链
const INLINE_RE = /(`([^`]+)`)|(\*\*([^*]+)\*\*)|(\*([^*\n]+)\*)|(\[([^\]]+)\]\((https?:\/\/[^)\s]+)\))|((?:https?:\/\/)[^\s<>()[\]"']+)/g;

const inlineCodeStyle: CSSProperties = {
  fontFamily: "var(--font-mono)", fontSize: "0.92em",
  background: "var(--bg-hover)", borderRadius: 4, padding: "1px 5px", overflowWrap: "anywhere",
};

/** 行内 markdown → ReactNode[]（纯文本自动转义，链接仅 http/https）。 */
function inline(text: string, keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0, m: RegExpExecArray | null, i = 0;
  INLINE_RE.lastIndex = 0;
  while ((m = INLINE_RE.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const k = keyBase + "-" + i++;
    if (m[2] !== undefined) {
      out.push(<code key={k} style={inlineCodeStyle}>{m[2]}</code>);
    } else if (m[4] !== undefined) {
      out.push(<strong key={k} style={{ fontWeight: 700 }}>{m[4]}</strong>);
    } else if (m[6] !== undefined) {
      out.push(<em key={k}>{m[6]}</em>);
    } else if (m[8] !== undefined) {
      out.push(<a key={k} href={m[9]} target="_blank" rel="noopener noreferrer" style={{ color: "var(--accent)" }}>{m[8]}</a>);
    } else if (m[10] !== undefined) {
      out.push(<a key={k} href={m[10]} target="_blank" rel="noopener noreferrer" style={{ color: "var(--accent)", overflowWrap: "anywhere" }}>{m[10]}</a>);
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

// ---------- 围栏代码块（带复制） ----------
function CodeBlock({ code, lang }: { code: string; lang: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    const done = () => { setCopied(true); setTimeout(() => setCopied(false), 1500); };
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(code).then(done).catch(() => {});
    } else {
      // 免 clipboard 权限兜底（http 部署场景）
      try {
        const ta = document.createElement("textarea");
        ta.value = code; ta.style.position = "fixed"; ta.style.opacity = "0";
        document.body.appendChild(ta); ta.select();
        document.execCommand("copy"); document.body.removeChild(ta); done();
      } catch {}
    }
  };
  return (
    <div style={{ border: "1px solid var(--border)", borderRadius: 6, background: "var(--bg-panel)", overflow: "hidden", minWidth: 0 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, padding: "3px 8px", borderBottom: "1px solid var(--border)" }}>
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--text-dim)" }}>{lang || "code"}</span>
        <button type="button" onClick={copy}
          style={{ border: "1px solid var(--border)", borderRadius: 5, background: "var(--bg)", color: copied ? "#10b981" : "var(--text-muted)", fontSize: 10, padding: "1px 8px", cursor: "pointer" }}>
          {copied ? "✓ " + t("ext.copied") : t("ext.copy")}
        </button>
      </div>
      <pre style={{ margin: 0, padding: "8px 10px", overflowX: "auto", fontFamily: "var(--font-mono)", fontSize: 11, lineHeight: 1.5, whiteSpace: "pre" }}>
        <code>{code}</code>
      </pre>
    </div>
  );
}

// ---------- 块级解析 ----------
const isListLine = (l: string) => /^\s*(?:[-*+]|\d+[.)])\s+/.test(l);
const isBlockStart = (l: string) => /^(#{1,4}\s|```|\s*>|\s*[-*+]\s|\s*\d+[.)]\s)/.test(l);

/** markdown 描述组件：substVars 后按块解析渲染。 */
export function MdDesc({ text, vars }: { text: string; vars: MdVars }) {
  const lines = substVars(text, vars).split(/\r?\n/);
  const blocks: ReactNode[] = [];
  let i = 0, key = 0;

  while (i < lines.length) {
    const line = lines[i];

    // 围栏代码块（```lang … ```）
    const fence = line.match(/^```\s*(\S*)\s*$/);
    if (fence) {
      const lang = fence[1] || "";
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) { buf.push(lines[i]); i++; }
      i++; // 收尾 ```（缺失则吃到尾）
      blocks.push(<CodeBlock key={key++} code={buf.join("\n")} lang={lang} />);
      continue;
    }

    if (!line.trim()) { i++; continue; }

    // 标题
    const h = line.match(/^(#{1,4})\s+(.+)$/);
    if (h) {
      const lv = h[1].length;
      const style: CSSProperties = lv <= 2
        ? { fontSize: lv === 1 ? 14 : 13, fontWeight: 700, color: "var(--text)", marginTop: 4 }
        : { fontSize: 12, fontWeight: 700, color: "var(--text-muted)", marginTop: 2 };
      blocks.push(<div key={key++} style={style}>{inline(h[2], "h" + key)}</div>);
      i++;
      continue;
    }

    // 分隔线
    if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) {
      blocks.push(<div key={key++} style={{ borderTop: "1px solid var(--border)", margin: "2px 0" }} />);
      i++;
      continue;
    }

    // 引用
    if (/^\s*>\s?/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) { buf.push(lines[i].replace(/^\s*>\s?/, "")); i++; }
      blocks.push(
        <div key={key++} style={{ borderLeft: "3px solid var(--border)", paddingLeft: 10, color: "var(--text-dim)", fontSize: 12, lineHeight: 1.55, margin: "2px 0" }}>
          {buf.map((l, n) => <div key={n}>{inline(l, "q" + key + "-" + n)}</div>)}
        </div>
      );
      continue;
    }

    // 列表（一层缩进；缩进续行并入上一条）
    if (isListLine(line)) {
      const ordered = /^\s*\d+[.)]\s/.test(line);
      const items: { level: number; text: string }[] = [];
      while (i < lines.length) {
        const mm = lines[i].match(/^(\s*)(?:[-*+]|\d+[.)])\s+(.+)$/);
        if (mm) {
          items.push({ level: Math.floor(mm[1].replace(/\t/g, "  ").length / 2), text: mm[2] });
          i++;
          continue;
        }
        if (items.length && /^\s+\S/.test(lines[i]) && !/^```/.test(lines[i])) {
          items[items.length - 1].text += " " + lines[i].trim();
          i++;
          continue;
        }
        break;
      }
      blocks.push(
        <div key={key++} style={{ display: "flex", flexDirection: "column", gap: 3, margin: "2px 0" }}>
          {items.map((it, n) => (
            <div key={n} style={{ display: "flex", gap: 6, paddingLeft: it.level * 14, fontSize: 12, lineHeight: 1.55 }}>
              <span style={{ color: "var(--text-dim)", flexShrink: 0 }}>{ordered ? (n + 1) + "." : "•"}</span>
              <span style={{ flex: 1, minWidth: 0 }}>{inline(it.text, "li" + key + "-" + n)}</span>
            </div>
          ))}
        </div>
      );
      continue;
    }

    // 段落（连续非空行；单换行保留为换行）
    const buf: string[] = [];
    while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i])) { buf.push(lines[i]); i++; }
    blocks.push(
      <div key={key++} style={{ fontSize: 12, lineHeight: 1.6, color: "var(--text)" }}>
        {buf.map((l, n) => <div key={n}>{inline(l, "p" + key + "-" + n)}</div>)}
      </div>
    );
  }

  return <div style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 0 }}>{blocks}</div>;
}
