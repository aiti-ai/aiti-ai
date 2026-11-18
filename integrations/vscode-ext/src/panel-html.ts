/**
 * Bridge panel webview rendering (pure HTML builder; host fetches state and refreshes the whole
 * page — zero polling).
 * 2026-11-14 UI rework: status header (bridge + counts + primary actions) -> injection channel
 * cards -> injectable services table -> secondary sections (framework integrations, manual
 * ports, connected pages, bridge logs) collapsed into <details>.
 * i18n: pure node module (no vscode import) — the host passes its translator (vscode.l10n.t)
 * in as `t`; default is identity so tests can call it without a locale.
 */
import type { ServiceHit } from "./port-scan";
import type { FrameworkRow } from "./frameworks";
import { INTEGRATION_CATALOG, DEVTOOLS_HOME } from "./frameworks";
import { originOf } from "./targets";

export type Translate = (message: string, ...args: Array<string | number | boolean>) => string;

export interface PanelState {
  bridgeOk: boolean; bridgeHere: boolean; bridgeSpawnedHere: boolean; bridgeBase: string; bridgeLogs: string;
  aiUrl: string;
  proxyList: Array<{ target: string; proxyUrl: string }>;
  discovered: ServiceHit[];
  manual: string[];
  sessions: unknown[];
  frameworks: FrameworkRow[];
}

interface SessionRow {
  pageId?: string; title?: string | null; url?: string | null;
  frameworks?: unknown; active?: boolean;
}

export function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
}

function btn(cmd: string, label: string, data?: Record<string, string>, primary = false): string {
  const attrs = Object.entries(data || {}).map(([k, v]) => ` data-${k}="${esc(v)}"`).join("");
  return `<button class="${primary ? "primary" : ""}" data-cmd="${esc(cmd)}"${attrs}>${label}</button>`;
}

export function panelHtml(s: PanelState, t: Translate = (x) => x): string {
  const dot = (ok: boolean) => ok ? '<span class="ok">●</span>' : '<span class="bad">●</span>';
  const bridgeLabel = s.bridgeSpawnedHere ? t("spawned by this extension") : s.bridgeOk ? t("external · reused") : t("not connected");
  const aiWindowUrl = (s.aiUrl || "").trim() || `${s.bridgeBase.replace(/\/+$/, "")}/cockpit.html`;

  const injected = new Set(s.proxyList.map((p) => originOf(p.target)));
  const proxyOf = (origin: string) => s.proxyList.find((p) => originOf(p.target) === origin)?.proxyUrl;
  const pageHits = s.discovered.filter((h) => h.kind === "page");
  const otherHits = s.discovered.filter((h) => h.kind !== "page");

  // ---- injection channels (core area, card rows) ----
  const channelCards = s.proxyList.length
    ? s.proxyList.map((p) => `
      <div class="row">
        <span class="ok">●</span>
        <span class="grow"><b>${esc(originOf(p.target))}</b> <span class="dim">${t("→ proxy")}</span> <code>${esc(p.proxyUrl)}</code></span>
        ${btn("open-proxy", t("Open"), { url: p.proxyUrl })}
        ${btn("stop-target", t("Stop"), { url: p.target })}
      </div>`).join("")
    : `<p class="dim empty">${t('No injection channels yet — pick a service under "Injectable services" below and click Inject, or register a port manually.')}</p>`;

  // ---- injectable services (discovery area) ----
  const hitRow = (h: ServiceHit) => {
    const origin = originOf(h.url);
    const active = injected.has(origin);
    const pUrl = proxyOf(origin);
    const action = h.kind !== "page"
      ? `<span class="dim">${t("not a page")}</span>`
      : active
        ? `<span class="ok">${t("injected")}</span> ${pUrl ? btn("open-proxy", t("Open"), { url: pUrl }) : ""}`
        : btn("enable-target", t("Inject"), { url: h.url }, true);
    return `<tr>
      <td><span class="fw">${esc(h.framework || "HTTP")}</span></td>
      <td><code>:${h.port}</code></td>
      <td class="dim">${esc(h.process)}</td>
      <td class="dim td-title">${esc(h.title)}</td>
      <td class="td-actions">${action}</td>
    </tr>`;
  };
  const pageTable = pageHits.length
    ? `<table><thead><tr><th>${t("Framework")}</th><th>${t("Port")}</th><th>${t("Process")}</th><th>${t("Title")}</th><th></th></tr></thead><tbody>${pageHits.map(hitRow).join("")}</tbody></table>`
    : `<p class="dim empty">${t("No page services found — start a dev server in the IDE integrated terminal, then click Refresh. Only descendants of this extension host process tree are listed; unrelated processes are never enumerated.")}</p>`;
  const otherDetails = otherHits.length
    ? `<details class="sub"><summary>${t("Non-page services ({0})", otherHits.length)}</summary><table><tbody>${otherHits.map(hitRow).join("")}</tbody></table></details>`
    : "";

  // ---- collapsed: framework integrations ----
  const frameworkRows = INTEGRATION_CATALOG.map((c) => {
    const row = s.frameworks.find((f) => f.id === c.id);
    const detected = row?.detected || row?.integrated;
    const status = row?.integrated ? `<span class="ok">${t("integrated")}</span>` : detected ? `<span class="dim">${t("not integrated")}</span>` : '<span class="dim">—</span>';
    const actions = [
      btn("fw-docs", t("Docs"), { url: c.docsUrl }),
      detected && !row?.integrated && c.pkg ? btn("fw-install", t("Install dep"), { url: c.pkg }) : "",
      row?.canApply && detected && !row.integrated ? btn("fw-apply", t("One-click integrate"), { id: c.id }, true) : "",
    ].filter(Boolean).join(" ");
    return `<tr><td>${esc(c.name)}</td><td>${status}</td><td class="td-actions">${actions}</td></tr>`;
  }).join("");

  // ---- collapsed: manual registrations ----
  const manualRows = s.manual.map((u) => {
    const origin = originOf(u);
    const active = injected.has(origin);
    const pUrl = proxyOf(origin);
    const action = active
      ? `<span class="ok">${t("injected")}</span> ${pUrl ? btn("open-proxy", t("Open"), { url: pUrl }) : ""}`
      : btn("enable-target", t("Inject"), { url: origin }, true);
    return `<div class="row"><span class="grow"><code>${esc(origin)}</code></span>${action} ${btn("remove-manual", t("Remove"), { url: origin })}</div>`;
  }).join("");

  // ---- collapsed: connected pages ----
  const sessionRows = (s.sessions as SessionRow[]).map((r) => `
    <tr><td><code>${esc(r.pageId)}</code></td><td>${esc(r.title || t("(untitled)"))}</td><td class="dim td-title">${esc((r.url || "").slice(0, 80))}</td>
    <td>${r.active ? '<span class="ok">●</span>' : '<span class="dim">○</span>'}</td></tr>`).join("");

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);padding:0;margin:0;font-size:13px}
.wrap{max-width:900px;margin:0 auto;padding:14px 16px 24px}
/* 状态头 */
header{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:10px 14px;margin-bottom:14px;
  background:var(--vscode-editor-background);border:1px solid var(--vscode-panel-border);border-radius:6px}
.stat-main{font-size:13px;display:flex;align-items:center;gap:6px}
.pill{font-size:11px;padding:1px 8px;border-radius:8px;background:var(--vscode-badge-background);color:var(--vscode-badge-foreground)}
.stat-sub{width:100%;font-size:11px;opacity:.75;margin-top:2px}
.actions{margin-left:auto;display:flex;gap:6px;flex-wrap:wrap}
/* 区块 */
h2{font-size:11px;text-transform:uppercase;letter-spacing:.06em;opacity:.72;margin:18px 0 8px;font-weight:600}
h2 .n{font-weight:400;opacity:.8;text-transform:none;letter-spacing:0;margin-left:6px}
section{margin-bottom:4px}
/* 行卡 */
.row{display:flex;align-items:center;gap:8px;padding:6px 10px;margin:4px 0;
  background:var(--vscode-editor-background);border:1px solid var(--vscode-panel-border);border-radius:4px}
.row:hover{border-color:var(--vscode-focusBorder)}
.grow{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
/* 表格 */
table{border-collapse:collapse;width:100%;margin:4px 0}
th{font-size:10px;text-transform:uppercase;letter-spacing:.05em;opacity:.6;text-align:left;font-weight:600}
td{border-top:1px solid var(--vscode-panel-border);padding:5px 8px;font-size:12px;vertical-align:middle}
tr:hover td{background:var(--vscode-list-hoverBackground)}
.td-actions{text-align:right;white-space:nowrap}
.td-title{max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fw{font-size:11px;padding:1px 7px;border-radius:8px;background:var(--vscode-badge-background);color:var(--vscode-badge-foreground)}
/* 按钮 */
button{font-family:inherit;font-size:12px;margin:1px;padding:3px 12px;cursor:pointer;border:none;border-radius:3px;
  background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}
button:hover{background:var(--vscode-button-secondaryHoverBackground)}
button.primary{background:var(--vscode-button-background);color:var(--vscode-button-foreground)}
button.primary:hover{background:var(--vscode-button-hoverBackground)}
/* 折叠区 */
details{margin:14px 0;border:1px solid var(--vscode-panel-border);border-radius:5px;background:var(--vscode-editor-background)}
summary{cursor:pointer;padding:8px 14px;font-size:12px;font-weight:600;opacity:.85;user-select:none}
summary:hover{opacity:1}
details[open] summary{border-bottom:1px solid var(--vscode-panel-border)}
details .inner{padding:6px 14px 12px}
details.sub{margin:8px 0 2px;background:transparent}
details.sub summary{padding:5px 10px;font-weight:400;opacity:.7}
.empty{padding:10px 4px}
.ok{color:var(--vscode-testing-iconPassed)}.bad{color:var(--vscode-testing-iconFailed)}.dim{opacity:.68}
code{color:var(--vscode-textPreformat-foreground);font-size:12px}
.hint{font-size:11px;opacity:.65;margin:6px 2px;line-height:1.5}
</style></head><body><div class="wrap">

<header>
  <span class="stat-main">${dot(s.bridgeOk)} ${t("Bridge")} <code>${esc(s.bridgeBase)}</code> <span class="pill">${bridgeLabel}</span></span>
  <span class="actions">
    ${s.proxyList.length ? btn("stop-all", t("Stop all")) : btn("enable", t("Enable debugging"), undefined, true)}
    ${s.bridgeOk ? btn("cockpit", t("Open AI window")) : ""}
    ${btn("refresh", t("Refresh"))}
  </span>
  <span class="stat-sub">${t("AI window:")} <code>${esc(aiWindowUrl)}</code> ${btn("set-ai-url", t("Settings"))} ${btn("fw-docs", t("Docs"), { url: "https://aiti.pw/devtools/" })} · ${t("{0} injection channel(s) · {1} injectable page(s) · {2} connected page(s)", s.proxyList.length, pageHits.length, s.sessions.length)}${s.bridgeOk ? "" : t(" · bridge not connected (enable debugging spawns it)")}</span>
</header>

<section>
  <h2>${t("Injection channels")}<span class="n">${t("target ↔ proxy one-to-one")}</span></h2>
  ${channelCards}
</section>

<section>
  <h2>${t("Injectable services")}<span class="n">${t("started in IDE terminals / tasks")}</span></h2>
  ${pageTable}
  ${otherDetails}
</section>

<details>
  <summary>${t("Framework integrations (carrier plugins — proxy-free; full aiti suite built into the dev server)")}</summary>
  <div class="inner">
    <table><tbody>${frameworkRows}</tbody></table>
    <p class="hint">${t("Carrier plugins serve the app's same-origin {0} suite (launcher + bridge + MCP + cockpit) — more robust than proxy injection. Restart the dev server to apply. {1}", "/aiti/", btn("fw-docs", t("Integration overview"), { url: DEVTOOLS_HOME }))} ${t("Any site can also use proxy injection or the Chrome extension (no code changes).")}</p>
  </div>
</details>

<details>
  <summary>${t("Manually registered ports ({0})", s.manual.length)}</summary>
  <div class="inner">
    ${manualRows || `<p class="dim">${t("None.")}</p>`}
    <p>${btn("add-manual", t("＋ Register port"))}</p>
  </div>
</details>

<details>
  <summary>${t("Connected pages ({0})", s.sessions.length)}</summary>
  <div class="inner">
    ${sessionRows ? `<table><thead><tr><th>pageId</th><th>${t("Title")}</th><th>URL</th><th></th></tr></thead><tbody>${sessionRows}</tbody></table>` : `<p class="dim">${t("None yet — open a page through the proxy and wait for the launcher to connect to the bridge.")}</p>`}
  </div>
</details>

<details>
  <summary>${t("Bridge logs (this window)")}</summary>
  <div class="inner"><pre style="background:var(--vscode-textCodeBlock-background);padding:8px;font-size:11px;max-height:160px;overflow:auto;white-space:pre-wrap">${esc(s.bridgeLogs) || `<span class="dim">${t("(no logs)")}</span>`}</pre></div>
</details>

<p class="hint">${t("The AI window can point to any aiti-compatible carrier page (default: local bridge cockpit). For self-hosting we recommend {0} (session management / model picker / full multi-agent AI window) — docs: {1}.", "<code>@aiti-ai/pi-web</code>", btn("fw-docs", "aiti.pw/devtools", { url: "https://aiti.pw/devtools/" }))}</p>

</div>
<script>
const vscode = acquireVsCodeApi();
document.querySelectorAll("button").forEach(b => b.addEventListener("click", () => {
  vscode.postMessage({ type: b.dataset.cmd, url: b.dataset.url, id: b.dataset.id });
}));
</script>
</body></html>`;
}
