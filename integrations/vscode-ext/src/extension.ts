/**
 * aiti-devtools-vscode · 扩展主入口
 *
 * 「启用页面调试」= 桥生命周期 + 代理注入 + MCP 配置（docs/ide/vscode.md 规划落地）。
 *
 * 登记模型（service-tunnels 同款）：
 *   - 发现只是候选列表：只列 VS Code 主进程后代进程树里的监听服务（集成终端/任务/调试起的），
 *     永不枚举任意用户进程；外加用户手动登记的端口（workspaceState 持久化）。
 *   - 登记即代理：每个目标一个独立代理端口（8788 起，一一对应），互不影响；停止逐行可控。
 * 桥面板：手动刷新快照（零轮询——仓库红线），桥健康按配置端口探测（跨窗口如实显示）。
 */
import * as vscode from "vscode";
const l10n = vscode.l10n;
import { existsSync, mkdirSync } from "fs";
import { join } from "path";
import { BridgeManager } from "./bridge-manager";
import { launcherScriptTag, startProxy, type ProxyHandle } from "./proxy-server";
import { panelHtml, type PanelState } from "./panel-html";
import { upsertMcpConfig } from "./mcp-config";
import { resolveBridgePath, resolveShimPath } from "./paths";
import { discoverVscodeServices, type ServiceHit } from "./port-scan";
import { originOf, normalizeTargetInput, isProxyableOrigin } from "./targets";
import { detectFrameworks, applyFramework, INTEGRATION_CATALOG, DEVTOOLS_HOME } from "./frameworks";

let bridge: BridgeManager | undefined;
/** 登记表：目标 origin → 独立代理实例（一一对应） */
const proxies = new Map<string, { handle: ProxyHandle }>();
let ctxStore: vscode.ExtensionContext | undefined;
/** 扩展安装根（dist/bridge 自带桥的解析基准） */
let extRoot: string | undefined;
let statusItem: vscode.StatusBarItem | undefined;
let panel: vscode.WebviewPanel | undefined;

export function activate(ctx: vscode.ExtensionContext): void {
  ctxStore = ctx;
  extRoot = ctx.extensionUri.fsPath;
  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
  statusItem.command = "aiti.openPanel";
  statusItem.show();
  updateStatus();

  ctx.subscriptions.push(
    statusItem,
    vscode.commands.registerCommand("aiti.enableDebug", (arg?: unknown) =>
      enableDebug(typeof arg === "string" ? arg : undefined)),
    vscode.commands.registerCommand("aiti.stopDebug", stopDebug),
    vscode.commands.registerCommand("aiti.openPanel", openPanel),
    vscode.commands.registerCommand("aiti.reinject", reinject),
  );

  // 工作区级自动启用（aiti.autoEnable：dev host 自动化测试 / 一打开工程即调试）
  if (cfg<boolean>("autoEnable")) void enableDebug(undefined, true);

  // 设置即生效：targetUrl 变更 → 自动登记新通道；aiUrl 变更 → 重建代理换注入 tag（刷新页面生效）
  ctx.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("aiti.aiUrl")) {
        if (proxies.size) void reinject();
        return;
      }
      if (!e.affectsConfiguration("aiti.targetUrl")) return;
      const url = (cfg<string>("targetUrl") || "").trim();
      if (!url) {
        vscode.window.showInformationMessage(l10n.t("aiti: targetUrl cleared — auto-discovery will be used on next enable"));
        return;
      }
      void applyConfiguredTarget(originOf(url));
    }),
  );
}

/** 设置路径：确保桥 + 登记目标通道（targetUrl 变更/启用命令共用） */
async function applyConfiguredTarget(target: string): Promise<void> {
  const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const bridgePath = resolveBridgePath(cfg<string>("bridgePath"), extRoot);
  const shimPath = resolveShimPath(cfg<string>("shimPath"), extRoot);
  if (!bridgePath || !shimPath || !wsRoot) {
    vscode.window.showErrorMessage(l10n.t("aiti: failed to resolve bridge/shim paths or no workspace open — check the aiti.bridgePath setting"));
    return;
  }
  const b = ensureBridge();
  try {
    const how = await b.ensureRunning(bridgePath);
    b.reusedExternal = how === "already";
  } catch (e) {
    vscode.window.showErrorMessage(l10n.t("aiti: bridge failed to start — {0}", (e as Error).message));
    return;
  }
  let proxyUrl: string;
  let warning: string | undefined = "";
  try {
    ({ proxyUrl, warning } = await enrollProxy(target));
  } catch (e) {
    vscode.window.showErrorMessage(l10n.t("aiti: proxy failed to start — {0}", (e as Error).message));
    return;
  }
  const mcp = upsertMcpConfig(wsRoot, shimPath, b.bridgeBase);
  if (!mcp.ok) vscode.window.showWarningMessage(l10n.t("aiti: mcp.json not written — {0}", mcp.message ?? ""));
  if (cfg<boolean>("autoOpenBrowser")) openExternal(proxyUrl);
  updateStatus();
  vscode.window.showInformationMessage(l10n.t("aiti: {0} → {1}{2}", target, proxyUrl, warning ?? ""));
}

export function deactivate(): void {
  for (const [, p] of proxies) p.handle.close().catch(() => {});
  proxies.clear();
  bridge?.stop();
}

// ---------- helpers ----------

function cfg<T>(key: string): T {
  return vscode.workspace.getConfiguration("aiti").get<T>(key) as T;
}

function bridgePort(): number {
  return cfg<number>("bridgePort") || 8777;
}

function ensureBridge(): BridgeManager {
  if (!bridge || bridge.port !== bridgePort()) {
    bridge?.stop();
    const dataDir = ctxStore ? join(ctxStore.globalStorageUri.fsPath, "bridge-data") : undefined;
    if (dataDir) mkdirSync(dataDir, { recursive: true });
    bridge = new BridgeManager(bridgePort(), {
      assetsDir: extRoot ? join(extRoot, "dist", "bridge-assets") : undefined, // 自带资产（launcher/cockpit…）
      dataDir, // 消息 session 存储进扩展私有目录
    });
  }
  return bridge;
}

/** 手动登记端口（workspaceState 持久化，随工作区） */
function manualTargets(): string[] {
  return ctxStore?.workspaceState.get<string[]>("aiti.manualTargets") ?? [];
}
function saveManualTargets(list: string[]): Thenable<void> {
  return ctxStore?.workspaceState.update("aiti.manualTargets", list) ?? Promise.resolve();
}

function updateStatus(): void {
  if (!statusItem) return;
  const hasProxy = proxies.size > 0;
  const hasBridge = !!bridge && (bridge.spawnedHere || bridge.reusedExternal);
  if (hasProxy && hasBridge) {
    statusItem.text = `$(broadcast) aiti(${proxies.size})`;
    statusItem.backgroundColor = undefined;
    const first = [...proxies.values()][0]?.handle;
    statusItem.tooltip = l10n.t(
      "aiti debugging: {0} injected\n{1}\nbridge {2}\nclick to open the bridge panel",
      proxies.size,
      first ? `${first.url} → ${first.target}` : "",
      bridge!.bridgeBase,
    );
  } else if (hasProxy || hasBridge) {
    statusItem.text = `$(circle-half) aiti (${[hasBridge ? l10n.t("bridge") : "", hasProxy ? l10n.t("{0} proxy", proxies.size) : ""].filter(Boolean).join("+")})`;
    statusItem.backgroundColor = undefined;
    statusItem.tooltip = l10n.t("aiti partially ready — open the bridge panel for details");
  } else {
    statusItem.text = `$(circle-slash) aiti`;
    statusItem.backgroundColor = undefined;
    statusItem.tooltip = l10n.t('aiti not enabled — run "aiti: Enable page debugging" from the command palette');
  }
}

function openExternal(url: string): void {
  Promise.resolve(vscode.env.openExternal(vscode.Uri.parse(url))).catch(() => {});
}

// ---------- 登记模型（发现 → 登记为独立代理） ----------

async function enrollProxy(target: string): Promise<{ target: string; proxyUrl: string; warning?: string }> {
  const origin = originOf(target);
  if (!isProxyableOrigin(origin)) {
    throw new Error(l10n.t("invalid target URL: {0} — examples: http://localhost:5173 or localhost:5173 / :5173 / 5173", target));
  }
  const existing = proxies.get(origin);
  if (existing) {
    // 死通道短路修复：handle 还在但服务不再响应 → 丢弃重建
    const alive = await fetch(existing.handle.url, { signal: AbortSignal.timeout(800) })
      .then((r) => r.ok)
      .catch(() => false);
    if (alive) return { target: origin, proxyUrl: existing.handle.url };
    await dropProxy(origin);
  }
  // 目标预检（2 次重试）：不可达仍登记，但明确警告——不静默产出 502 通道
  let reachable = false;
  for (let i = 0; i < 2 && !reachable; i++) {
    reachable = await fetch(origin, { signal: AbortSignal.timeout(900) })
      .then(() => true)
      .catch(() => false);
    if (!reachable && i === 0) await new Promise((r) => setTimeout(r, 400));
  }
  const warning = reachable ? "" : l10n.t(" (⚠ target unreachable for now — refresh the proxy page once the service is up; no need to re-enable)");
  const b = ensureBridge();
  const tag = launcherScriptTag(b.bridgeBase, "aiti-devtools", cfg<string>("aiUrl"));
  const used = new Set([...proxies.values()].map((p) => p.handle.port));
  const basePort = cfg<number>("proxyPort") || 8788;
  for (let attempt = 0; attempt < 10; attempt++) {
    const port = basePort + attempt;
    if (used.has(port)) continue;
    try {
      const handle = await startProxy(origin, port, tag, (s) => console.log(`[aiti-proxy:${port}] ${s}`));
      proxies.set(origin, { handle });
      updateStatus();
      return { target: origin, proxyUrl: handle.url, warning };
    } catch (e) {
      if (!String(e).includes("EADDRINUSE")) throw e; // 端口被外部占用 → 试下一个
    }
  }
  throw new Error(l10n.t("proxy port allocation failed (10 consecutive ports busy)"));
}

async function dropProxy(origin: string): Promise<void> {
  const p = proxies.get(origin);
  if (!p) return;
  proxies.delete(origin);
  await p.handle.close().catch(() => {});
  updateStatus();
}

// ---------- 目标发现与解析 ----------

/** 目标解析：显式参数（面板按钮/E2E）> 设置 targetUrl > 自动发现（1 个直选 / 多个 QuickPick）> 手动输入 */
async function resolveTarget(explicit?: string, auto = false): Promise<string | undefined> {
  const configured = (explicit || cfg<string>("targetUrl") || "").trim();
  if (configured) return configured;
  const candidates = await collectCandidates();
  if (candidates.length === 1) {
    vscode.window.showInformationMessage(
      l10n.t("aiti: auto-selected {0} :{1} ({2})", candidates[0].framework || l10n.t("manual entry"), candidates[0].port, candidates[0].process || "manual"),
    );
    return candidates[0].url;
  }
  if (candidates.length > 1) {
    if (auto) {
      const h = candidates[0];
      vscode.window.showInformationMessage(
        l10n.t("aiti: auto-enabled the first candidate :{0} ({1} candidates in total — switch in the bridge panel)", h.port, candidates.length),
      );
      return h.url;
    }
    const items: Array<vscode.QuickPickItem & { url?: string }> = [
      ...candidates.map((h) => ({
        label: `${h.framework || "手动"}  :${h.port}`,
        description: h.process,
        detail: `${h.title}${h.title ? " · " : ""}${h.url}`,
        url: h.url,
      })),
      { label: `$(edit) ${l10n.t("Enter a URL manually…")}` },
    ];
    const pick = await vscode.window.showQuickPick(items, { placeHolder: l10n.t("Pick the page service to inject") });
    return pick?.url;
  }
  if (auto) {
    vscode.window.showInformationMessage(l10n.t("aiti: no running page service found — start a dev server in the IDE terminal, then enable it from the bridge panel"));
    return undefined;
  }
  return (
    normalizeTargetInput(
      (await vscode.window.showInputBox({
        prompt: l10n.t("No running page service found — enter the target URL (formats like localhost:5173 / :5173 / 5173 are supported)"),
        placeHolder: "http://localhost:5173",
      })) || "",
    ) || undefined
  );
}

/** 候选 = VS Code 子进程服务（自动发现） ∪ 手动登记端口；已登记的排除 */
async function collectCandidates(): Promise<Array<ServiceHit & { manual?: boolean }>> {
  const exclude = [bridgePort(), ...[...proxies.values()].map((p) => p.handle.port)];
  const discovered = (await Promise.resolve(
    vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: l10n.t("aiti: enumerating ports of VS Code child-process services…") },
      () => discoverVscodeServices({
        excludePorts: exclude,
        excludeCmdline: [/vscode-mcp-server/, /aiti-bridge/],
      }),
    ),
  ).catch(() => [] as ServiceHit[])) as ServiceHit[];
  const out: Array<ServiceHit & { manual?: boolean }> = discovered.filter((h: ServiceHit) => h.kind === "page");
  for (const url of manualTargets()) {
    const origin = originOf(url);
    if (out.some((h) => originOf(h.url) === origin) || proxies.has(origin)) continue;
    const port = Number(origin.split(":").pop());
    out.push({ port, pid: 0, process: l10n.t("manual entry"), url, kind: "page", framework: l10n.t("manual"), title: "" });
  }
  return out;
}

// ---------- commands ----------

async function enableDebug(targetOverride?: string, auto = false): Promise<void> {
  const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!wsRoot) {
    vscode.window.showErrorMessage(l10n.t("aiti: open a workspace first (.vscode/mcp.json is written into the project)"));
    return;
  }
  const bridgePath = resolveBridgePath(cfg<string>("bridgePath"), extRoot);
  if (!bridgePath) {
    vscode.window.showErrorMessage(l10n.t("aiti: cannot find aiti-bridge.mjs — install @aiti-ai/aiti-bridge or set the path in the aiti.bridgePath setting"));
    return;
  }
  const shimPath = resolveShimPath(cfg<string>("shimPath"), extRoot);
  if (!shimPath) {
    vscode.window.showErrorMessage(l10n.t("aiti: cannot find aiti-mcp-shim.cjs — likewise; set aiti.shimPath to specify it"));
    return;
  }

  const targetRaw = await resolveTarget(targetOverride, auto);
  if (!targetRaw) return;
  const target = originOf(targetRaw);

  await applyConfiguredTarget(target);
}

async function stopDebug(): Promise<void> {
  const count = proxies.size;
  for (const [origin, p] of proxies) {
    proxies.delete(origin);
    await p.handle.close().catch(() => {});
  }
  updateStatus();
  if (bridge?.spawnedHere) {
    bridge.stop();
    vscode.window.showInformationMessage(l10n.t("aiti: stopped ({0} proxy channel(s) + the bridge spawned by this extension)", count));
  } else {
    vscode.window.showInformationMessage(l10n.t("aiti: stopped {0} proxy channel(s) (bridge not spawned by this extension; left running)", count));
  }
}

async function reinject(): Promise<void> {
  if (!proxies.size) {
    vscode.window.showInformationMessage(l10n.t('aiti: debugging is not enabled yet — run "aiti: Enable page debugging" first'));
    return;
  }
  const b = ensureBridge();
  const tag = launcherScriptTag(b.bridgeBase, "aiti-devtools", cfg<string>("aiUrl"));
  let n = 0;
  for (const [target, p] of [...proxies.entries()]) {
    const port = p.handle.port;
    await p.handle.close().catch(() => {});
    proxies.delete(target);
    try {
      const handle = await startProxy(target, port, tag, (s) => console.log(`[aiti-proxy:${port}] ${s}`));
      proxies.set(target, { handle });
      n++;
    } catch (e) {
      vscode.window.showErrorMessage(l10n.t("aiti: proxy restart failed ({0}) — {1}", target, (e as Error).message));
    }
  }
  vscode.window.showInformationMessage(l10n.t("aiti: {0} proxy channel(s) restarted — refresh the page to re-inject", n));
  updateStatus();
}

function openPanel(): void {
  if (panel) {
    panel.reveal();
    void refreshPanel();
    return;
  }
  panel = vscode.window.createWebviewPanel("aitiBridgePanel", l10n.t("aiti bridge panel"), vscode.ViewColumn.Active, {
    enableScripts: true,
  });
  panel.onDidDispose(() => { panel = undefined; });
  panel.webview.onDidReceiveMessage((msg: { type: string; url?: string; id?: string }) => {
    switch (msg.type) {
      case "refresh": void refreshPanel(); break;
      case "set-ai-url":
        void (async () => {
          const cur = cfg<string>("aiUrl") || "";
          const v = await vscode.window.showInputBox({
            prompt: l10n.t("AI window URL (empty = local bridge cockpit; may point to a pi-web instance — self-hosting docs: aiti.pw/devtools · npm @aiti-ai/pi-web)"),
            value: cur,
            placeHolder: "https://pi.example.com/ 或 http://127.0.0.1:8080/",
          });
          if (v === undefined) return; // 取消
          await vscode.workspace.getConfiguration("aiti").update("aiUrl", v.trim(), vscode.ConfigurationTarget.Workspace);
          void refreshPanel(); // config-change listener already rebuilds proxies
        })();
        break;
      case "cockpit": {
        // aiUrl 设置优先（pi-web 实例等），空则本地桥 cockpit
        const ai = (cfg<string>("aiUrl") || "").trim();
        if (ai) openExternal(ai);
        else if (bridge) openExternal(`${bridge.bridgeBase}/cockpit.html`);
        break;
      }
      case "open-proxy": if (msg.url) openExternal(msg.url); break;
      case "stop-all": void vscode.commands.executeCommand("aiti.stopDebug").then(() => refreshPanel()); break;
      case "enable": void vscode.commands.executeCommand("aiti.enableDebug").then(() => refreshPanel()); break;
      case "enable-target":
        if (msg.url) void vscode.commands.executeCommand("aiti.enableDebug", msg.url).then(() => refreshPanel());
        break;
      case "stop-target":
        if (msg.url) void dropProxy(originOf(msg.url)).then(() => refreshPanel());
        break;
      case "add-manual": {
        void vscode.window
          .showInputBox({ prompt: l10n.t("Register a service port or URL (e.g. :3000 or http://localhost:3000)"), placeHolder: ":3000" })
          .then(async (input) => {
            if (!input) return;
            const origin = originOf(input); // normalizeTargetInput covers :3000 / bare port / scheme-less forms
            const list = manualTargets();
            if (!list.includes(origin)) await saveManualTargets([...list, origin]);
            void refreshPanel();
          });
        break;
      }
      case "fw-docs":
        if (msg.url) openExternal(msg.url);
        break;
      case "fw-install":
        if (msg.url) installDep(msg.url);
        break;
      case "fw-apply":
        if (msg.id) void applyFrameworkCommand(msg.id).then(() => refreshPanel());
        break;
      case "remove-manual":
        if (msg.url) void Promise.resolve(saveManualTargets(manualTargets().filter((u) => originOf(u) !== originOf(msg.url!)))).then(() => refreshPanel());
        break;
    }
  });
  void refreshPanel();
}

/** 一键安装载体依赖（探测包管理器，集成终端执行——用户可见可干预） */
function installDep(pkg: string): void {
  const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!wsRoot) return;
  const has = (f: string) => existsSync(join(wsRoot, f));
  const cmd = has("pnpm-lock.yaml") ? "pnpm add -D"
    : has("yarn.lock") ? "yarn add -D"
    : has("bun.lock") || has("bun.lockb") ? "bun add -d"
    : "npm i -D";
  const term = vscode.window.createTerminal({ name: "aiti setup", cwd: wsRoot });
  term.show();
  term.sendText(`${cmd} ${pkg}`);
}

/** 一键应用载体接入（config 补丁 + .aiti-bak 备份；失败时模板进剪贴板） */
async function applyFrameworkCommand(id: string): Promise<void> {
  const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!wsRoot) return;
  const r = applyFramework(wsRoot, id);
  if (r.ok) {
    const doc = await vscode.workspace.openTextDocument(r.file);
    await vscode.window.showTextDocument(doc, { preview: true });
    vscode.window.showInformationMessage(l10n.t("aiti: integrated into {0} (previous file backed up as .aiti-bak) — restart the dev server to apply", r.file));
  } else {
    if (r.snippet) await vscode.env.clipboard.writeText(r.snippet);
    vscode.window.showWarningMessage(`aiti: ${r.reason}${r.snippet ? l10n.t(" — integration template copied to the clipboard") : ""}`);
  }
}

/** 面板：扩展宿主取数（桥 sessions + 服务发现 + 登记表单次快照），webview 只渲染——零轮询 */
async function refreshPanel(): Promise<void> {
  if (!panel) return;
  const b = bridge;
  const base = b?.bridgeBase ?? `http://127.0.0.1:${bridgePort()}/aiti`;
  let sessions: unknown[] = [];
  let bridgeOk = false;
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 1500);
    const res = await fetch(`${base}/bridge/sessions`, { signal: ctl.signal });
    clearTimeout(timer);
    bridgeOk = res.ok;
    if (res.ok) {
      const data: unknown = await res.json();
      if (Array.isArray(data)) sessions = data;
      else if (data && typeof data === "object" && Array.isArray((data as { sessions?: unknown[] }).sessions)) {
        sessions = (data as { sessions: unknown[] }).sessions;
      }
    }
  } catch { bridgeOk = false; }

  const proxyList = [...proxies.entries()].map(([target, p]) => ({ target, proxyUrl: p.handle.url }));
  const discovered = await discoverVscodeServices({
    excludePorts: [
      bridgePort(),
      ...proxyList.map((p) => Number(new URL(p.proxyUrl).port)).filter((n) => Number.isFinite(n)),
    ],
    excludeCmdline: [/vscode-mcp-server/, /aiti-bridge/],
  }).catch(() => [] as ServiceHit[]);

  const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const frameworks = wsRoot ? detectFrameworks(wsRoot) : [];
  const state: PanelState = {
    bridgeOk,
    bridgeHere: !!b,
    bridgeSpawnedHere: !!b?.spawnedHere,
    bridgeBase: base,
    bridgeLogs: b?.tailLogs(12) ?? "",
    aiUrl: cfg<string>("aiUrl") || "",
    proxyList,
    discovered,
    manual: manualTargets(),
    sessions,
    frameworks,
  };
  panel.webview.html = panelHtml(state, (...args) => l10n.t(...(args as [string, ...Array<string | number | boolean>])));
}


