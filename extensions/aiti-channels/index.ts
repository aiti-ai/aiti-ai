/**
 * aiti-channels · IM 渠道接入 + cc-connect 大前端外壳（双引擎并存）
 *
 * 定位（docs/aiti-channels-extension-plan.md §3.5）：
 *   - 托管 cc-connect（进程生命周期归 aiti，不做 systemd）：install 检测/start/stop/restart/探活
 *   - 面板（大前端外壳）：概览/项目/通道/会话/配置 + 🖥️ 管理台 Tab 内嵌 cc-connect 原生 Web UI
 *   - 嵌入方式：独立子域 iframe `https://cc.pi.example.com:8443/?token=...`
 *       （Authelia session cookie 域 = example.com 通配 → pi-web 登录态在 cc.pi.example.com 直接有效；
 *         cc-connect Login 支持 ?token= 自动登录 → 零二次登录，全生态保留）
 *   - 出站通道：cc-connect Unix socket API（POST /send 文本/文件、GET /sessions）—— 已实测
 *
 * 服务端只依赖 Node 内建模块；托管/探测/socket 客户端在 lib/manager.ts。
 */
import * as manager from "./lib/manager.js";
import * as installer from "./lib/installer.js";
import { renderConfig } from "./lib/config-gen.js";
import { readConfigFile } from "./lib/config.js";
import { readCardModes, setCardMode } from "./lib/bot-edit.js";
import * as chatRelay from "./lib/chat-relay.js";
import * as acp from "./lib/acp-server.js";
import * as path from "node:path";
import * as fs from "node:fs";
import * as net from "node:net";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json", "cache-control": "no-store" },
});

// ---- management API proxy helper (v2 full-capability surface) ----
// Root-path allowlist: anything else must NOT leak through to the cc-connect port.
const MGMT_ALLOW = ["status", "restart", "reload", "config", "settings", "agents", "projects", "providers", "cron", "skills", "bridge", "setup"];

function mgmtBase(mOpts: { config?: string }): { port: number; token: string } | null {
  const cfg = readConfigFile(mOpts.config || manager.DEFAULTS.config);
  const mgmt = cfg?.management;
  if (!mgmt?.port) return null;
  return { port: Number(mgmt.port) || 9820, token: String(mgmt.token || "") };
}

/** Proxy one call to the instance management API (Bearer injected server-side;
 *  the client never sees the token). Returns parsed body + HTTP status. */
async function mgmtApi(mOpts: { config?: string }, method: string, apiPath: string, body?: unknown, timeoutMs = 30000): Promise<{ status: number; data: any; error?: string }> {
  const base = mgmtBase(mOpts);
  if (!base) return { status: 0, data: null, error: "实例 config 缺 [management]（端口未知）" };
  try {
    const r = await fetch(`http://127.0.0.1:${base.port}/api/v1/${apiPath}`, {
      method,
      headers: { "content-type": "application/json", ...(base.token ? { authorization: `Bearer ${base.token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await r.text();
    let data: any = text;
    try { data = JSON.parse(text); } catch { /* keep raw (GET /config is TOML text) */ }
    return { status: r.status, data };
  } catch (e: any) {
    return { status: 0, data: null, error: `实例 management 不可达（未运行？）：${e.message}` };
  }
}

function parseBody(req: Request): Promise<Record<string, any>> {
  return req.json().catch(() => ({}));
}

// 跨 reload 单例：托管状态（dataDir）在 globalThis。key 带 LIB_VERSION——reload 换新实例。
function mgr(): typeof manager {
  const g = globalThis as Record<string, any>;
  const key = `__aitiChannels_${(manager as any).LIB_VERSION || "dev"}`;
  if (!g[key]) g[key] = manager;
  return g[key] as typeof manager;
}

// iframe 嵌入地址（带 management token 自动登录）。端口随 config。
function iframeUrl(cfg: any): string {
  const port = cfg?.management?.port || 9820;
  const token = cfg?.management?.token || "";
  return `https://cc.pi.example.com:8443/?token=${encodeURIComponent(token)}`;
}

export default {
  id: "aiti-channels",
  name: "IM 渠道（cc-connect 大前端）",
  icon: "icon.svg",
  client: "dist/aiti-channels-client.mjs",

  ai: {
    manage: true,
    intro: "AI 能帮我管理 IM 渠道（cc-connect）：发钉钉/飞书消息、查渠道状态/会话/消息日志、启停实例",
    skills: "skills",
  },

  features: [
    { id: "behavior.proxy-bridge", label: "cc-connect 托管", group: "进程行为", default: true,
      description: "接管 cc-connect 进程生命周期（start/stop/restart/探活，不做 systemd）" },
    { id: "behavior.embed-ui", label: "管理台嵌入", group: "进程行为", default: true,
      description: "面板 🖥️ 管理台 Tab 内嵌 cc-connect 原生 Web UI（独立子域 iframe）" },
    { id: "tool.aiti-im-list", label: "aiti-im-list · 渠道/项目/会话清单", group: "agent 工具", default: true,
      description: "列出 IM 渠道/项目/活跃会话（cc-connect）：进程状态、项目清单、活跃会话；发消息前先拿 session_key" },
    { id: "tool.aiti-im-send", label: "aiti-im-send · 发渠道消息", group: "agent 工具", default: true,
      description: "经 cc-connect socket API 向钉钉/飞书/微信等 IM 渠道发文本/文件" },
    { id: "agentTools.enabled", type: "boolean", label: "AI 工具（IM 渠道）", group: "AI", default: false,
      description: "会话内注入 aiti-im-* 工具（默认关；需要时经 aiti-helper 帮助点（🤖）临时启用，或扩展管理器开启）" },
  ],

  ui: {
    clientImmediately: false, // [懒加载 v2] M1 已同步生产，懒化重启用
    // id 与 client 注册对齐（aiti-channels-open——原 channels 为历史错位，M1 审计发现）
    toolbar: [{ id: "aiti-channels-open", label: "i18n:channels.open", title: "i18n:channels.app.title", icon: "icons/message-circle.svg" }],
    // aiti-float dock: three-face registration (floating / left block / right tab); ids match the client.
    sidebarExplorerDock: [{ id: "panel", label: "i18n:it.aiti-channels-panel.label", icon: "message-circle" }],
    rightFileDock: [{ id: "panel", label: "i18n:it.aiti-channels-panel.label" }],
    dialogs: [
      { id: "aiti-channels-panel", label: "i18n:it.aiti-channels-panel.label" },
      { id: "aiti-channels-remote", label: "i18n:it.aiti-channels-remote.label", hideOnMobile: true },
      { id: "aiti-channels-bots", label: "i18n:it.aiti-channels-bots.label" },
    ],
    i18n: {
      en: {
      "自重启": "Auto-restart",
      "版本": "Version",
      "有新版本": "update available",
      "去安装": "Go install",
      "快捷操作": "Quick actions",
      "配置摘要": "Config summary",
      "cc-connect 安装 / 更新（justget 多源竞速 + gitee 镜像）": "cc-connect install / update (justget multi-source racing + gitee mirror)",
      "检测版本": "Check version",
      "当前安装": "Current install",
      "最新发布": "latest release",
      "下载方式": "Download method",
      "主源 GitHub：https://github.com/chenhg5/cc-connect/releases": "Primary source GitHub: https://github.com/chenhg5/cc-connect/releases",
      "🟠 镜像 Gitee：https://gitee.com/cg33/cc-connect/releases/download/（国内快，谁快用谁）": "🟠 Gitee mirror: https://gitee.com/cg33/cc-connect/releases/download/ (fast in China; use whichever is faster)",
      "已是最新": "Already latest",
      "版本自动取最新发布版（无需手动输入）；下载较大（约 50MB 二进制），耗时取决于网络；进度看服务端日志。": "Version auto-fills from the latest release (no manual input); the download is large (~50MB binary) and depends on your network; progress is in the server log.",
      "说明：安装后当前运行进程不受影响；下次重启（♻自重启/restart-cc）会用新版本。官方 release 不含本地源码定制（如小屏适配），升级前请注意。": "Note: installing does not affect the running process; the new version applies on next restart (♻ auto-restart / restart-cc). Official releases do not include local source customizations (e.g. small-screen tweaks) — check before upgrading.",
      "实例": "Instances",
      "刷新": "Refresh",
      "添加配置（多 workspace × 多 IM，一键建）": "Add config (multiple workspaces × multiple IMs, one click)",
      "自动创建（id/dataDir/端口全自动）": "Auto-create (id/dataDir/port all automatic)",
      "取消": "Cancel",
      "创建后默认带一个 piweb（pi-web 会话）项目 + 钉钉 IM 壳，填路径和凭证即可用": "After creation it comes with a piweb (pi-web session) project + a DingTalk IM shell — fill paths and credentials to use",
      "全局（management / bridge / log）": "Global (management / bridge / log)",
      "添加项目": "Add project",
      "agent 类型": "Agent type",
      "💡 piweb：IM 消息会进": "💡 piweb: IM messages go into",
      "下的 pi-web 会话（带完整工具能力），会话可在 All Sessions 里打开查看/继续互动；图片附件落在该目录 .cc-connect/attachments/。": "pi-web session under that directory (full tool capabilities); the session can be opened/viewed/continued in All Sessions; image attachments land in that directory's .cc-connect/attachments/.",
      "原生直连（type=piweb，无连接器进程；需新版 cc-connect）": "Native direct connection (type=piweb, no connector process; requires a recent cc-connect)",
      "平台类型": "Platform type",
      "该类型未收录参数表——生成后到 config.toml 手填 options": "No parameter table for this type — fill options manually in config.toml after generating",
      "官网入口：": "Official site: ",
      "扫码授权（自动获取 AppID/Secret）": "Scan-to-authorize (AppID/Secret fetched automatically)",
      "打开授权页并扫码确认": "Open the auth page and scan to confirm",
      "等待授权中…完成后凭证自动填入": "Waiting for authorization… credentials fill in automatically when done",
      "授权成功，凭证已自动填入上方字段": "Authorized — credentials filled into the fields above automatically",
      "添加平台": "Add platform",
      "生成并启动（配置写入 + 拉起实例）": "Generate & Start (writes config + launches the instance)",
      "仅生成配置": "Generate config only",
      "查看日志": "View logs",
      "表单化配置：填好项目/平台/凭据 → 生成 config.toml（自动备份）→ 启动实例。每个实例独立 config/dataDir/socket/端口，互不影响。钉钉接入需在钉钉开放平台建应用（Stream 模式，AppKey/AppSecret/AgentId）。": "Form-based config: fill in projects/platforms/credentials → generate config.toml (auto backup) → start instances. Each instance has its own config/dataDir/socket/port, fully isolated. DingTalk requires creating an app on the DingTalk open platform (Stream mode: AppKey/AppSecret/AgentId).",
      "无项目 — 到 📝配置 添加 [[projects]]": "No projects — add [[projects]] in 📝 Config",
      "(无平台)": "(no platform)",
      "未配置平台 — 到 📝配置 在 [[projects.platforms]] 添加": "No platforms configured — add them in 📝 Config under [[projects.platforms]]",
      "渠道接入（钉钉/飞书/微信…）在 cc-connect 配置 [projects] 的 platforms 里定义（app_id/secret/bot 等）。出站发消息走 socket API，接入细节见原版管理台 🖥️。": "Channel integrations (DingTalk/Feishu/WeChat…) are defined under [projects] platforms in cc-connect config (app_id/secret/bot etc.). Outbound messages go through the socket API; see the original admin console 🖥️ for integration details.",
      "发消息（socket API → IM）": "Send message (socket API → IM)",
      "发送": "Send",
      "无活跃会话（IM 里给机器人发消息激活）": "No active sessions (message the bot in IM to activate)",
      "活跃": "active",
      "⟳ 刷新": "⟳ Refresh",
      "暂无消息记录 — 经本面板/aiti-im-send 发出的消息都会记录": "No message records yet — messages sent via this panel / aiti-im-send are logged",
      "cc-connect 运行日志": "cc-connect run logs",
      "cc-connect 原生管理台（独立子域 iframe，共享登录态，含实时聊天）": "cc-connect native admin UI (standalone-subdomain iframe, shared login, live chat)",
      "↗ 新窗打开": "↗ Open in new window",
      "管理台地址未就绪（需 cc-connect 启用 [management]）": "Admin UI address not ready (requires cc-connect to enable [management])",
      "IM 渠道 & cc-connect": "IM Channels & cc-connect",
      " · 可更新": " · update available",
      " · 已是最新": " · already latest",
      " 下载器：justget（多源竞速分块下载） — ": " downloader: justget (multi-source racing chunked download) — ",
      " 安装位置：": " install location: ",
      " 平台 ": " platform ",
      " 项目（": " project (",
      " 项目：": " project: ",
      "(无日志)": "(no logs)",
      "(空消息)": "(empty message)",
      "begin 失败（实例未运行？）": "begin failed (instance not running?)",
      "bridge 端口": "bridge port",
      "cc-connect 未运行": "cc-connect not running",
      "cc-connect 管理台": "cc-connect admin UI",
      "cc-connect 运行中": "cc-connect running",
      "management token（Web UI 登录）": "management token (Web UI login)",
      "management 端口": "management port",
      "piweb（pi-web 会话）": "piweb (pi-web session)",
      "reload 已触发": "reload triggered",
      "session_key（点下方会话填充）": "session_key (fill from the sessions below)",
      "○ 未运行": "○ not running",
      "」是 piweb（pi-web 会话），需要填 work_dir": "\" is piweb (a pi-web session) — work_dir is required",
      "下载中…": "Downloading…",
      "会话": "Sessions",
      "停止": "Stop",
      "先填配置名（如 my-im）": "Fill in a config name first (e.g. my-im)",
      "关": "off",
      "分配失败：": "Allocation failed: ",
      "创建失败：": "Create failed: ",
      "删除": "Delete",
      "原版": "Original admin",
      "发消息": "Send message",
      "发送失败：": "Send failed: ",
      "启动": "Start",
      "启动失败：": "Start failed: ",
      "失败": "failed",
      "失败：": "failed: ",
      "如 /home/.../atest": "e.g. /home/.../atest",
      "如 9810": "e.g. 9810",
      "如 9820": "e.g. 9820",
      "如 atest": "e.g. atest",
      "安装": "Install",
      "安装 / 更新": "Install / update",
      "安装失败：": "Install failed: ",
      "安装状态拉取失败：": "Install status fetch failed: ",
      "完成": "done",
      "实例已创建，填写下方表单生成配置": "Instance created — fill the form below to generate the config",
      "工作目录 work_dir": "working directory work_dir",
      "已启动": "started",
      "已是最新版本": "Already the latest version",
      "已热应用配置 → 项目：": "Config hot-applied → project: ",
      "开": "on",
      "总览": "Overview",
      "打开管理台": "Open admin UI",
      "执行安装 / 更新": "Run install / update",
      "授权失败：": "Authorization failed: ",
      "无": "none",
      "日志": "Logs",
      "未命名": "Unnamed",
      "未安装": "not installed",
      "未知": "unknown",
      "未运行": "not running",
      "活跃会话（": "active sessions (",
      "消息": "Messages",
      "消息内容…": "Message content…",
      "消息已发送并记录日志": "Message sent and logged",
      "消息日志": "Message log",
      "消息日志（": "message logs (",
      "消息记录": "Message log",
      "添加配置失败：": "Add config failed: ",
      "渠道": "Channels",
      "渠道（": "channels (",
      "源：": "source: ",
      "热应用 config.toml": "Hot-apply config.toml",
      "热应用 config.toml（POST /api/v1/reload）": "Hot-apply config.toml (POST /api/v1/reload)",
      "版本检测告警：": "Version check warning: ",
      "版本：": "Version: ",
      "状态拉取失败：": "Status fetch failed: ",
      "端口": "Port",
      "编辑配置": "Edit config",
      "自动生成/留空": "auto-generated / leave empty",
      "自动获取最新": "auto-fetch latest",
      "自动重启（保留 pid）": "Auto-restart (keep pid)",
      "自动重启（进程替换保留 pid）": "Auto-restart (process replacement keeps pid)",
      "运行中": "running",
      "配置": "Config",
      "配置「": "config \"",
      "配置名（如 my-im、atest）": "Config name (e.g. my-im, atest)",
      "配置已生成": "Config generated",
      "配置拉取失败：": "Config fetch failed: ",
      "配置生成失败：": "Config generation failed: ",
      "重启": "Restart",
      "需要实例 id + dataDir（cc-connect 数据目录）": "Needs instance id + dataDir (the cc-connect data directory)",
      "需要项目名 + 消息内容": "Needs project name + message content",
      "项目": "Projects",
      "项目「": "project \"",
      "项目名": "Project name",
      "项目名（如 autoai）": "Project name (e.g. autoai)",
      "（免 sudo；sudo 可用时同步 /usr/local/bin/cc-connect）": "(no sudo; synced to /usr/local/bin/cc-connect when sudo is available)",
      "（可手填凭证）": "(credentials can be filled manually)",
      "）到托管目录，sudo 可用时已同步系统 bin": ") to the managed dir; synced to system bin when sudo is available",
        "feat.behavior.proxy-bridge.desc": "Manages the cc-connect process lifecycle (start/stop/restart/health checks; no systemd)",
        "feat.behavior.embed-ui.desc": "Embeds cc-connect's native Web UI (standalone-subdomain iframe) in a 🖥️ admin Tab of the panel",
        "feat.tool.aiti-im-list.desc": "Lists IM channels/projects/active sessions (cc-connect): process status, project list, active sessions; grab channel state, project list and active sessions before sending",
        "feat.tool.aiti-im-send.desc": "Sends text/files to IM channels like DingTalk/Feishu/WeCom via the cc-connect socket API",
        "feat.agentTools.enabled.desc": "Injects aiti-im-* tools into sessions (off by default; enable temporarily via the AI helper 🤖 or the extension manager)",
        "it.aiti-channels-panel.label": "IM channels & cc-connect manager",
        "it.aiti-channels-remote.label": "Mobile remote control",
        "it.aiti-channels-bots.label": "Bot management",
        "ext.displayName": "IM Channels",
        "feat.behavior.proxy-bridge": "cc-connect hosting",
        "feat.behavior.embed-ui": "Embed admin UI",
        "feat.tool.aiti-im-list": "aiti-im-list · channel/project/session list",
        "feat.tool.aiti-im-send": "aiti-im-send · send channel message",
        "feat.agentTools.enabled": "AI tool (IM channels)",
        "feat.aiti-channels-panel": "IM channels & cc-connect manager",
        "channels.app.title": "aiti-channels: cc-connect hosting + IM channels + admin embed",
        "channels.title": "IM Channels & cc-connect",
        "channels.open": "IM Channels",
        "channels.close": "Close",
        "新建项目": "New project",
        "使用流程：新建项目 → 接平台（机器人 tab 扫码/Token）→ 聊天/会话交互": "Flow: new project → connect a platform (scan/token in Bots) → chat/sessions",
        "需要项目名": "project name required",
        "项目已创建（reload 热应用）": "Project created (hot-applied via reload)",
        "首个平台（可选——之后也可在机器人 tab 扫码/填 token 接入）": "First platform (optional — can also be added later via Bots scan/token)",
        "work_dir（工作目录，可后补）": "work_dir (can be filled later)",
        "创建项目（add-platform + reload 热应用）": "Create project (add-platform + reload hot-apply)",
        "扫码接入更顺：到 机器人 tab 新建机器人": "Scanning is smoother: create a bot in the Bots tab",
        "暂无项目 — 点右上「新建项目」，或到 机器人 tab 扫码直建": "No projects — click \"New project\" above, or scan-to-create in the Bots tab",
        "config 当前实际项目": "Projects currently in config.toml",
        "上方表单只用于【整份重新生成】config.toml（批量初始化场景）；日常单个项目的增改请走 项目 tab（新建/详情）或 机器人 tab（扫码/Token 接平台）——它们经 cc-connect 官方 API 增量写入并热应用，不覆盖整份配置。": "The form above is only for REGENERATING the whole config.toml (bulk bootstrap); for day-to-day single-project changes use the Projects tab (new/detail) or the Bots tab (scan/token) — they write incrementally through cc-connect's official API and hot-apply, never overwriting the whole file.",
        "去项目 tab 管理单个项目 →": "Manage a single project in the Projects tab →",
        "使用流程：① 安装/启动实例 → ② 项目 tab「新建项目」→ ③ 机器人 tab 扫码/Token 接平台 → ④ 聊天 tab 实时对话、会话 tab 管理。单个项目增改走 项目/机器人 tab；整份批量配置走 配置 tab。": "Flow: ① install/start the instance → ② \"New project\" in Projects → ③ connect a platform (scan/token) in Bots → ④ chat live in Chat, manage sessions in Sessions. Single-project changes live in Projects/Bots; whole-file bulk config lives in Config.",
        "ilink 网关长轮询（ilinkai.weixin.qq.com）· 非官方通道建议小号专用": "ilink gateway long-polling (ilinkai.weixin.qq.com) · unofficial channel, a burner account is recommended",
        "飞书开放平台官方 device flow · WS 长连接免公网": "Feishu Open Platform official device flow · WS long connection, no public IP",
        "Lark 开放平台（device flow 自动识别切换）· WS 长连接": "Lark Open Platform (device flow auto-detects the domain) · WS long connection",
        "@BotFather 建 bot · Bot API long-polling（国内需代理）": "create a bot via @BotFather · Bot API long-polling (proxy needed in CN)",
        "钉钉开放平台 · Stream 模式免公网": "DingTalk Open Platform · Stream mode, no public IP",
        "Developer Portal · Gateway WS": "Developer Portal · Gateway WS",
        "Socket Mode 免公网": "Socket Mode, no public IP",
        "自建 NapCat/Lagrange 正向 WS": "self-hosted NapCat/Lagrange forward WS",
        "QQ 开放平台": "QQ Open Platform",
        "管理后台建应用 · 回调模式需公网": "admin console app · callback mode needs a public endpoint",
        "Messaging API · 需公网 webhook": "Messaging API · public webhook required",
        "homeserver bot 账号 access_token": "homeserver bot account access_token",
        "developer.webex.com · WebSocket": "developer.webex.com · WebSocket",
        "WPS 开放平台": "WPS Open Platform",
        "内测通道": "closed-beta channel",
        "service account + pubsub": "service account + pubsub",
        "微博开放平台": "Weibo Open Platform",
        "扫码确认页将显示 OpenClaw 字样——本通道走 ilink 网关，与开源项目 OpenClaw 的微信插件（openclaw-weixin）同一网关，属预期行为，不是点错了。": "The scan confirm page will show OpenClaw wording — this channel uses the ilink gateway, the same one as the OpenClaw openclaw-weixin plugin; expected behavior, not a mis-click.",
        "语言（en/zh/zh-TW/ja/es/ko/ru）": "Language (en/zh/zh-TW/ja/es/ko/ru)",
        "日志级别": "Log level",
        "空闲超时（分钟）": "Idle timeout (min)",
        "显示思考消息": "Show thinking messages",
        "思考消息最大长度": "Thinking max length",
        "显示工具消息": "Show tool messages",
        "工具消息最大长度": "Tool messages max length",
        "流式预览": "Stream preview",
        "流式预览间隔（ms）": "Stream preview interval (ms)",
        "限流：最大消息数": "Rate limit: max messages",
        "限流：窗口（秒）": "Rate limit: window (s)",
        "附件发送": "Attachment sending",
        "钉钉": "DingTalk",
        "微信": "WeChat",
        "飞书 · 中国": "Feishu (CN)",
        "Lark · 全球": "Lark (Global)",
        "Telegram": "Telegram",
        "QQ（OneBot）": "QQ (OneBot)",
        "QQ 机器人": "QQ Bot",
        "企业微信": "WeCom",
        "WPS 协作": "WPS Docs",
        "WPS 协作空间": "WPS AgentSpace",
        "腾讯元宝": "Tencent Yuanbao",
        "微博": "Weibo",
        "更多渠道（token / 表单接入，同一「新建机器人」向导）": "More channels (token/form via the same new-bot wizard)",
        "最新": "latest:",
        "当前": "Installed:",
        "active": "active",
        "api_key 需自填": "api_key must be filled in",
        "Bridge 已连接": "Bridge connected",
        "Bridge 未连接": "Bridge not connected",
        "Bridge 适配器（/bridge/adapters）": "Bridge adapters (/bridge/adapters)",
        "cron 表达式（当前": "cron expression (current ",
        "cwd": "cwd",
        "pause": "pause",
        "paused": "paused",
        "prompt（定时投给 agent 的内容）": "prompt (sent to the agent on schedule)",
        "resume": "resume",
        "run": "run",
        "work_dir（bot ↔ 项目一一对应）": "work_dir (bot ↔ project 1:1)",
        "二维码生成中…": "Generating QR…",
        "从预设填充：": "Prefill from preset:",
        "使用 Bot Channel": "Use Bot Channel",
        "保存修改": "Save changes",
        "全局": "Global",
        "全局设置（/settings）": "Global settings (/settings)",
        "关联机器人": "Link bot",
        "关闭": "Close",
        "创建": "Create",
        "创建（add-platform，重启后生效）": "Create (add-platform; applies after restart)",
        "创建全局 Provider": "Create global provider",
        "删": "Del",
        "删除全局 Provider": "Delete global provider",
        "删除机器人": "Delete bot",
        "🗑 删除机器人": "🗑 Delete bot",
        "删除该定时任务？": "Delete this cron job?",
        "删除项目": "Delete project",
        "删除项目（含全部平台与会话映射）": "Delete the project (all platforms and session mappings)",
        "加载历史…": "Loading history…",
        "危险区": "Danger zone",
        "去配置": "Configure",
        "发消息到": "Send to",
        "名称（如 deepseek）": "Name (e.g. deepseek)",
        "启用": "Enabled",
        "复制链接": "Copy link",
        "多工作区绑定（/workspaces）": "Workspace bindings (/workspaces)",
        "定时任务": "Cron jobs",
        "对方输入中…": "typing…",
        "工作目录 work_dir（缺省当前工作区）": "work_dir (defaults to the current workspace)",
        "已从预设填充": "Prefilled from preset",
        "已创建": "Created",
        "已删除": "Deleted",
        "已删除（重启实例生效）": "Deleted (applies after instance restart)",
        "已就绪": "Ready",
        "已恢复": "Resumed",
        "已暂停": "Paused",
        "已激活": "Activated",
        "已移除": "Removed",
        "已绑定": "Bound",
        "已装": "installed",
        "已解绑": "Unbound",
        "已触发": "Triggered",
        "常规设置（PATCH /projects/{name}）": "General settings (PATCH /projects/{name})",
        "微信扫码登录 ilink 网关（确认页显示 OpenClaw 字样属预期）——重新扫码可换号。": "WeChat scan signs in via the ilink gateway (OpenClaw wording on the confirm page is expected) — rescan to switch accounts.",
        "心跳 Heartbeat": "Heartbeat",
        "心跳间隔（分钟）": "Heartbeat interval (min)",
        "手机扫码连接": "Scan to connect",
        "打开手机访问卡（service-tunnels）": "Open the phone access card (service-tunnels)",
        "扫码并创建": "Scan & create",
        "扫码并确认": "and confirm",
        "扫码或在手机上打开链接，即可远程控制当前工作区。": "Scan or open the link on your phone to control this workspace remotely.",
        "扫码或复制链接": "scan or copy the link",
        "扫码直建": "scan-to-create",
        "技能 Skills": "Skills",
        "技能市场预设（/skills/presets）": "Skill catalog presets (/skills/presets)",
        "把外部聊天工具接入 aiti 机器人（每个机器人 = 一个 cc-connect 项目）。": "Connect external chat tools to your aiti bots (each bot = one cc-connect project).",
        "授权成功，正在保存凭据并建项目…": "Authorized — saving credentials and creating the project…",
        "搜索预设…": "Search presets…",
        "收起": "Collapse",
        "新建": "New",
        "新建全局": "New global",
        "新建机器人": "New bot",
        "（无 bridge 适配器连接）": "(no bridge adapters connected)",
        "无会话——发一条消息即建（bridge:web-admin 模式）": "No sessions — sending a message creates one (bridge:web-admin mode)",
        "（无可选模型——先在 Providers 配置）": "(no models — configure Providers first)",
        "（无已装技能）": "(no installed skills)",
        "无法扫码？在手机上打开链接": "Cannot scan? Open the link on your phone",
        "（无项目级 Provider）": "(no project providers)",
        "暂无定时任务（cc-connect /cron）": "No cron jobs (cc-connect /cron)",
        "暂无机器人 — 点「新建机器人」开始": "No bots yet — click “New bot” to start",
        "暂无项目（先在机器人/配置创建）": "No projects yet (create one in Bots/Config first)",
        "未绑定": "Unbound",
        "（未设置，用实例缺省）": "(not set; instance default applies)",
        "未配置": "Not configured",
        "机器人": "Bots",
        "机器人名称（=cc-connect 项目名）": "Bot name (= cc-connect project name)",
        "机器人回复颗粒度": "Reply granularity",
        "机器人已创建（restart-cc 重启实例后连上平台）": "Bot created (restart-cc to connect the platform)",
        "机器人管理": "Bot management",
        "标准回复": "Standard",
        "模型（/projects/{name}/models）": "Models (/projects/{name}/models)",
        "模型已切换": "Model switched",
        "模型提供方 Providers": "Model providers",
        "正在获取二维码…": "Fetching QR code…",
        "此平台暂只支持标准回复（card_mode=legacy）。": "This platform only supports standard replies (card_mode=legacy).",
        "流式卡片": "Streaming card",
        "渠道来源：各渠道经 cc-connect 官方通道接入；微信扫码页 OpenClaw 字样 = ilink 网关与 OpenClaw 插件同源，属预期行为。": "Channel sources: all channels connect via cc-connect through official platform APIs; the OpenClaw wording on the WeChat scan page = the ilink gateway shared with the OpenClaw plugin — expected behavior.",
        "激活": "Activate",
        "用": "Scan with",
        "用手机相机扫码，在手机上打开这个工作区（登录后接管当前会话）。": "Scan with your phone camera to open this workspace on mobile (sign in to take over the current session).",
        "确认删除机器人": "Confirm bot deletion",
        "确认删除项目": "Confirm project deletion",
        "移动端远程控制": "Mobile remote control",
        "移除这个机器人（DELETE project，重启实例生效）。": "Remove this bot (DELETE project; applies after instance restart).",
        "移除项目 Provider": "Remove project provider",
        "等待手机确认…（device flow 轮询，间隔由服务端下发）": "Waiting for phone confirmation… (device-flow polling, interval from the server)",
        "等待扫码确认…": "Waiting for scan confirmation…",
        "精选": "Featured",
        "绑定": "Bind",
        "编辑": "Edit",
        "网页管理会话（bridge:web-admin）": "Web-admin session (bridge:web-admin)",
        "聊天": "Chat",
        "表达式": "Expr",
        "表达式已更新": "Expression updated",
        "解绑": "Unbind",
        "设置已保存": "Settings saved",
        "连接聊天 Bot，适合更长时间的移动端访问。": "Connect a chat bot for longer-running mobile access.",
        "选择左侧会话，或直接在下方发消息（默认网页管理会话）": "Pick a session on the left, or just type below (defaults to the web-admin session)",
        "重新扫码": "Rescan",
        "间隔": "Interval",
        "间隔已更新": "Interval updated",
        "需要名称": "name required",
        "需要 项目 + cron + prompt": "project + cron + prompt required",
        "项目级": "Per-project",
        "项目访问范围": "Project access scope",
        "项目详情": "Project detail",
        "预设": "presets",
        "预设目录": "preset catalog",
        "飞书/Lark 官方 device flow——重新扫码可换应用。": "Feishu/Lark official device flow — rescan to switch apps.",
        "飞书/Lark 支持基于 Card JSON 2.0 的流式卡片，工具调用只显示折叠摘要。": "Feishu/Lark supports streaming cards (Card JSON 2.0); tool calls show as collapsed summaries.",
        "默认模型": "Default model",
        "Bot 会话": "Bot sessions",
        "connected": "connected",
        "degraded": "degraded",
        "Providers": "Providers",
        "Skills": "Skills",
        "下载器：justget（多源竞速分块下载） —": "downloader: justget (multi-source racing chunked download) — ",
        "会话已删除": "Session deleted",
        "保存失败": "Save failed",
        "保存失败：": "Save failed: ",
        "删除会话": "Delete session",
        "删除失败": "Delete failed",
        "删除失败：": "Delete failed: ",
        "· 可更新": " · update available",
        "安装位置：": " install location: ",
        "定时": "Cron",
        "（实例未运行，无健康数据）": "(instance down; no health data)",
        "已保存 allow_from（": "Saved allow_from (",
        "· 已是最新": " · already latest",
        "已连平台": "Connected platforms",
        "平台": "Platforms",
        "收起管理": "Hide manage",
        "无法扫码？打开授权页": "Cannot scan? Open the authorize page",
        "最近会话": "Recent sessions",
        "渠道接入（钉钉/飞书/微信…）在 cc-connect 配置 [projects] 的 platforms 里定义（app_id/secret/bot 等）。健康/白名单经 management API 实时读取，出站发消息走 socket API，接入细节见原版管理台 🖥️。": "Channels (DingTalk/Feishu/WeChat…) are defined under [projects].platforms in the cc-connect config (app_id/secret/bot etc.). Health/allowlist are read live via the management API; outbound goes through the socket API; see the original admin UI 🖥️ for integration details.",
        "白名单": "Allowlist",
        "白名单 allow_from": "allow_from",
        "空=不限，逗号分隔": "empty = unrestricted; comma separated",
        "管理": "Manage",
        "系统": "System",
        "运行时长": "Uptime",
        "项目（": "Projects (",
        "项目：": "Projects: ",
      },
      "zh-CN": {
      "自重启": "自重启",
      "版本": "版本",
      "有新版本": "有新版本",
      "去安装": "去安装",
      "快捷操作": "快捷操作",
      "配置摘要": "配置摘要",
      "cc-connect 安装 / 更新（justget 多源竞速 + gitee 镜像）": "cc-connect 安装 / 更新（justget 多源竞速 + gitee 镜像）",
      "检测版本": "检测版本",
      "当前安装": "当前安装",
      "最新发布": "最新发布",
      "下载方式": "下载方式",
      "主源 GitHub：https://github.com/chenhg5/cc-connect/releases": "主源 GitHub：https://github.com/chenhg5/cc-connect/releases",
      "🟠 镜像 Gitee：https://gitee.com/cg33/cc-connect/releases/download/（国内快，谁快用谁）": "🟠 镜像 Gitee：https://gitee.com/cg33/cc-connect/releases/download/（国内快，谁快用谁）",
      "已是最新": "已是最新",
      "版本自动取最新发布版（无需手动输入）；下载较大（约 50MB 二进制），耗时取决于网络；进度看服务端日志。": "版本自动取最新发布版（无需手动输入）；下载较大（约 50MB 二进制），耗时取决于网络；进度看服务端日志。",
      "说明：安装后当前运行进程不受影响；下次重启（♻自重启/restart-cc）会用新版本。官方 release 不含本地源码定制（如小屏适配），升级前请注意。": "说明：安装后当前运行进程不受影响；下次重启（♻自重启/restart-cc）会用新版本。官方 release 不含本地源码定制（如小屏适配），升级前请注意。",
      "实例": "实例",
      "刷新": "刷新",
      "添加配置（多 workspace × 多 IM，一键建）": "添加配置（多 workspace × 多 IM，一键建）",
      "自动创建（id/dataDir/端口全自动）": "自动创建（id/dataDir/端口全自动）",
      "取消": "取消",
      "创建后默认带一个 piweb（pi-web 会话）项目 + 钉钉 IM 壳，填路径和凭证即可用": "创建后默认带一个 piweb（pi-web 会话）项目 + 钉钉 IM 壳，填路径和凭证即可用",
      "全局（management / bridge / log）": "全局（management / bridge / log）",
      "添加项目": "添加项目",
      "agent 类型": "agent 类型",
      "💡 piweb：IM 消息会进": "💡 piweb：IM 消息会进",
      "下的 pi-web 会话（带完整工具能力），会话可在 All Sessions 里打开查看/继续互动；图片附件落在该目录 .cc-connect/attachments/。": "下的 pi-web 会话（带完整工具能力），会话可在 All Sessions 里打开查看/继续互动；图片附件落在该目录 .cc-connect/attachments/。",
      "原生直连（type=piweb，无连接器进程；需新版 cc-connect）": "原生直连（type=piweb，无连接器进程；需新版 cc-connect）",
      "平台类型": "平台类型",
      "该类型未收录参数表——生成后到 config.toml 手填 options": "该类型未收录参数表——生成后到 config.toml 手填 options",
      "官网入口：": "官网入口：",
      "扫码授权（自动获取 AppID/Secret）": "扫码授权（自动获取 AppID/Secret）",
      "打开授权页并扫码确认": "打开授权页并扫码确认",
      "等待授权中…完成后凭证自动填入": "等待授权中…完成后凭证自动填入",
      "授权成功，凭证已自动填入上方字段": "授权成功，凭证已自动填入上方字段",
      "添加平台": "添加平台",
      "生成并启动（配置写入 + 拉起实例）": "生成并启动（配置写入 + 拉起实例）",
      "仅生成配置": "仅生成配置",
      "查看日志": "查看日志",
      "表单化配置：填好项目/平台/凭据 → 生成 config.toml（自动备份）→ 启动实例。每个实例独立 config/dataDir/socket/端口，互不影响。钉钉接入需在钉钉开放平台建应用（Stream 模式，AppKey/AppSecret/AgentId）。": "表单化配置：填好项目/平台/凭据 → 生成 config.toml（自动备份）→ 启动实例。每个实例独立 config/dataDir/socket/端口，互不影响。钉钉接入需在钉钉开放平台建应用（Stream 模式，AppKey/AppSecret/AgentId）。",
      "无项目 — 到 📝配置 添加 [[projects]]": "无项目 — 到 📝配置 添加 [[projects]]",
      "(无平台)": "(无平台)",
      "未配置平台 — 到 📝配置 在 [[projects.platforms]] 添加": "未配置平台 — 到 📝配置 在 [[projects.platforms]] 添加",
      "渠道接入（钉钉/飞书/微信…）在 cc-connect 配置 [projects] 的 platforms 里定义（app_id/secret/bot 等）。出站发消息走 socket API，接入细节见原版管理台 🖥️。": "渠道接入（钉钉/飞书/微信…）在 cc-connect 配置 [projects] 的 platforms 里定义（app_id/secret/bot 等）。出站发消息走 socket API，接入细节见原版管理台 🖥️。",
      "发消息（socket API → IM）": "发消息（socket API → IM）",
      "发送": "发送",
      "无活跃会话（IM 里给机器人发消息激活）": "无活跃会话（IM 里给机器人发消息激活）",
      "活跃": "活跃",
      "⟳ 刷新": "⟳ 刷新",
      "暂无消息记录 — 经本面板/aiti-im-send 发出的消息都会记录": "暂无消息记录 — 经本面板/aiti-im-send 发出的消息都会记录",
      "cc-connect 运行日志": "cc-connect 运行日志",
      "cc-connect 原生管理台（独立子域 iframe，共享登录态，含实时聊天）": "cc-connect 原生管理台（独立子域 iframe，共享登录态，含实时聊天）",
      "↗ 新窗打开": "↗ 新窗打开",
      "管理台地址未就绪（需 cc-connect 启用 [management]）": "管理台地址未就绪（需 cc-connect 启用 [management]）",
      "IM 渠道 & cc-connect": "IM 渠道 & cc-connect",
      " · 可更新": " · 可更新",
      " · 已是最新": " · 已是最新",
      " 下载器：justget（多源竞速分块下载） — ": " 下载器：justget（多源竞速分块下载） — ",
      " 安装位置：": " 安装位置：",
      " 平台 ": " 平台 ",
      " 项目（": " 项目（",
      " 项目：": " 项目：",
      "(无日志)": "(无日志)",
      "(空消息)": "(空消息)",
      "begin 失败（实例未运行？）": "begin 失败（实例未运行？）",
      "bridge 端口": "bridge 端口",
      "cc-connect 未运行": "cc-connect 未运行",
      "cc-connect 管理台": "cc-connect 管理台",
      "cc-connect 运行中": "cc-connect 运行中",
      "management token（Web UI 登录）": "management token（Web UI 登录）",
      "management 端口": "management 端口",
      "piweb（pi-web 会话）": "piweb（pi-web 会话）",
      "reload 已触发": "reload 已触发",
      "session_key（点下方会话填充）": "session_key（点下方会话填充）",
      "○ 未运行": "○ 未运行",
      "」是 piweb（pi-web 会话），需要填 work_dir": "」是 piweb（pi-web 会话），需要填 work_dir",
      "下载中…": "下载中…",
      "会话": "会话",
      "停止": "停止",
      "先填配置名（如 my-im）": "先填配置名（如 my-im）",
      "关": "关",
      "分配失败：": "分配失败：",
      "创建失败：": "创建失败：",
      "删除": "删除",
      "原版": "原版",
      "发消息": "发消息",
      "发送失败：": "发送失败：",
      "启动": "启动",
      "启动失败：": "启动失败：",
      "失败": "失败",
      "失败：": "失败：",
      "如 /home/.../atest": "如 /home/.../atest",
      "如 9810": "如 9810",
      "如 9820": "如 9820",
      "如 atest": "如 atest",
      "安装": "安装",
      "安装 / 更新": "安装 / 更新",
      "安装失败：": "安装失败：",
      "安装状态拉取失败：": "安装状态拉取失败：",
      "完成": "完成",
      "实例已创建，填写下方表单生成配置": "实例已创建，填写下方表单生成配置",
      "工作目录 work_dir": "工作目录 work_dir",
      "已启动": "已启动",
      "已是最新版本": "已是最新版本",
      "已热应用配置 → 项目：": "已热应用配置 → 项目：",
      "开": "开",
      "总览": "总览",
      "打开管理台": "打开管理台",
      "执行安装 / 更新": "执行安装 / 更新",
      "授权失败：": "授权失败：",
      "无": "无",
      "日志": "日志",
      "未命名": "未命名",
      "未安装": "未安装",
      "未知": "未知",
      "未运行": "未运行",
      "活跃会话（": "活跃会话（",
      "消息": "消息",
      "消息内容…": "消息内容…",
      "消息已发送并记录日志": "消息已发送并记录日志",
      "消息日志": "消息日志",
      "消息日志（": "消息日志（",
      "消息记录": "消息记录",
      "添加配置失败：": "添加配置失败：",
      "渠道": "渠道",
      "渠道（": "渠道（",
      "源：": "源：",
      "热应用 config.toml": "热应用 config.toml",
      "热应用 config.toml（POST /api/v1/reload）": "热应用 config.toml（POST /api/v1/reload）",
      "版本检测告警：": "版本检测告警：",
      "版本：": "版本：",
      "状态拉取失败：": "状态拉取失败：",
      "端口": "端口",
      "编辑配置": "编辑配置",
      "自动生成/留空": "自动生成/留空",
      "自动获取最新": "自动获取最新",
      "自动重启（保留 pid）": "自动重启（保留 pid）",
      "自动重启（进程替换保留 pid）": "自动重启（进程替换保留 pid）",
      "运行中": "运行中",
      "配置": "配置",
      "配置「": "配置「",
      "配置名（如 my-im、atest）": "配置名（如 my-im、atest）",
      "配置已生成": "配置已生成",
      "配置拉取失败：": "配置拉取失败：",
      "配置生成失败：": "配置生成失败：",
      "重启": "重启",
      "需要实例 id + dataDir（cc-connect 数据目录）": "需要实例 id + dataDir（cc-connect 数据目录）",
      "需要项目名 + 消息内容": "需要项目名 + 消息内容",
      "项目": "项目",
      "项目「": "项目「",
      "项目名": "项目名",
      "项目名（如 autoai）": "项目名（如 autoai）",
      "（免 sudo；sudo 可用时同步 /usr/local/bin/cc-connect）": "（免 sudo；sudo 可用时同步 /usr/local/bin/cc-connect）",
      "（可手填凭证）": "（可手填凭证）",
      "）到托管目录，sudo 可用时已同步系统 bin": "）到托管目录，sudo 可用时已同步系统 bin",
        "it.aiti-channels-panel.label": "IM 渠道与 cc-connect 管理",
        "it.aiti-channels-remote.label": "移动端远程控制",
        "it.aiti-channels-bots.label": "机器人管理",
        "ext.displayName": "IM 渠道",        "channels.app.title": "aiti-channels：cc-connect 托管 + IM 渠道 + 管理台嵌入",
        "channels.title": "IM 渠道与 cc-connect",
        "channels.open": "IM 渠道",
        "channels.close": "关闭",
      },
    },
  },

  server: {
    startup(ctx: any) {
      const m = mgr();
      // 数据分层（config/cache）：本扩展自身 dataDir 内容全是运行态（pid/socket/日志/acp/实例注册表）→ cache 区；
      // 兜底：PI_WEB_DATA_DIR 优先（Docker/Windows 数据根独立于 ~/.pi）；未设 = ~/.pi/web/data 原行为
      const cacheRoot = (ctx && ctx.cacheDir) || path.join(process.env.PI_WEB_DATA_DIR || path.join(homedir(), ".pi", "web", "data"), "aiti-channels", "cache");
      // 数据分层（config/state/cache）：运行态（pid/socket/日志/acp/实例注册表）→ cache；
      // msg-log（历史）→ state/（见 lib/manager.ts）；存量迁移由一次性脚本负责（不背包袱）。
      m.setDataDir(cacheRoot);
      // keep acp-server path/registry resolution on the same dataDir even when
      // hot reload splits the manager module into per-importer copies
      acp.setDataDir(cacheRoot);
      // P3：ACP server 随 pi-web 常驻（每实例一个 Unix socket；cc-connect 连接器连这里）。
      // globalThis 单例——reload 复用已有 server，socket 不中断。
      void acp.ensureAll(m.listInstances().map((i: any) => i.id));
      console.log(`[aiti-channels] 就绪。dataDir=${m.getDataDir()}`);
    },
    shutdown() {
      acp.stopAllAcpServers();
      // 不清 cc-connect 进程（托管进程独立生命周期，面板/启动逻辑显式管理）
    },

    // /api/extensions/aiti-channels/<path>
    async api(req: Request, ctx: any) {
      const m = mgr();
      const p = (ctx.path || []).filter(Boolean);
      const action = p[0];
      // 实例解析：?instance=<id>，缺省 default（现有配置）。每个实例独立 config/dataDir/socket。
      const instId = (ctx.searchParams && ctx.searchParams.get("instance")) || "default";
      const inst = m.resolveInstance(instId);
      if (!inst) return json({ ok: false, error: `实例不存在：${instId}` }, 404);
      const mOpts = m.optsFor(inst);

      // 状态 + 探测（进程/端口/socket/版本/config）
      if (action === "status") {
        const st = await m.probe(mOpts);
        return json({ ok: true, instance: instId, instanceName: inst.name, ...st, iframeUrl: iframeUrl(st.cfg) });
      }

      // 添加配置向导：名字 → 自动分配 id/dataDir/端口（避开已有实例与本机占用），不落盘
      if (action === "suggest-config" && req.method === "POST") {
        const b = await parseBody(req);
        const raw = String(b.name || "").trim();
        const taken = new Set(m.listInstances().map((i: any) => i.id));
        let id = (raw.replace(/[^a-zA-Z0-9_-]/g, "-").replace(/^-+|-+$/g, "").toLowerCase() || "");
        if (!id || taken.has(id)) { let n = 2; while (taken.has(`${id || "cc"}${n}`)) n++; id = `${id || "cc"}${n}`; }
        // 端口分配：先避开已有实例 config 里声明的端口，再 TCP 试绑确认本机空闲
        const used = new Set<number>();
        for (const it of m.listInstances()) {
          try { const c = readConfigFile(it.config); if (c?.management?.port) used.add(Number(c.management.port)); if (c?.bridge?.port) used.add(Number(c.bridge.port)); } catch { /* 忽略读不了配置的实例 */ }
        }
        const freePort = (from: number, to: number): number => { for (let p = from; p <= to; p++) { if (!used.has(p)) return p; } return from; };
        const mgmt = freePort(9821, 9849);
        used.add(mgmt);
        const bridge = freePort(9811, 9839);
        const dataDir = path.join(homedir(), ".cc-connect-" + id);
        return json({ ok: true, id, name: raw || id, dataDir, managementPort: mgmt, bridgePort: bridge, token: randomUUID().replace(/-/g, "").slice(0, 24) });
      }

      // 实例列表（每实例 probe 摘要）
      if (action === "instances") {
        const list = m.listInstances();
        const out = [];
        for (const it of list) {
          const st = await m.probe(m.optsFor(it));
          out.push({ id: it.id, name: it.name, config: it.config, dataDir: it.dataDir, running: st.running, pid: st.pid, version: st.version, port9820: st.port9820, sockAlive: st.sockAlive, projectCount: (st.cfg?.projects || []).length });
        }
        return json({ ok: true, instances: out });
      }

      // 创建/删除/保存实例
      if (action === "instance" && req.method === "POST") {
        const b = await parseBody(req);
        const op2 = String(b.op || "create");
        if (op2 === "delete") {
          const id = String(b.id || "");
          if (!id || id === "default") return json({ ok: false, error: "不能删除默认实例" }, 400);
          const it = m.resolveInstance(id);
          if ((await m.status(m.optsFor(it))).running) return json({ ok: false, error: "实例正在运行，先停止再删除" }, 409);
          m.deleteInstance(id);
          acp.stopAcpServer(id);
          return json({ ok: true, id });
        }
        // create / save：id + 路径信息（config 由 config-gen 生成）
        const id = String(b.id || "");
        if (!/^[a-zA-Z0-9_-]+$/.test(id) || !id) return json({ ok: false, error: "实例 id 只能含字母数字_-" }, 400);
        const name = String(b.name || id);
        const dataDir = String(b.dataDir || "");
        if (!dataDir) return json({ ok: false, error: "需要 dataDir（cc-connect 数据目录）" }, 400);
        const config = String(b.config || path.join(m.getDataDir(), "instances", id, "config.toml"));
        // acpTcpPort: optional fixed ACP TCP port; 0/empty clears the override
        const tcpRaw = Number(b.acpTcpPort);
        const acpTcpPort = Number.isFinite(tcpRaw) && tcpRaw > 0 ? tcpRaw : undefined;
        const prev = m.listInstances().find((i: any) => i.id === id);
        m.saveInstance({ id, name, config, dataDir, ...(prev?.bin ? { bin: prev.bin } : {}), ...(prev?.logFile ? { logFile: prev.logFile } : {}), ...(acpTcpPort ? { acpTcpPort } : {}) });
        void acp.ensureAll([id]);
        return json({ ok: true, instance: { id, name, config, dataDir, ...(acpTcpPort ? { acpTcpPort } : {}) } });
      }

      // 配置生成（表单 → 写 config.toml，不手动编辑文件）
      if (action === "config-gen" && req.method === "POST") {
        const b = await parseBody(req);
        try {
          const toml = renderConfig({
            dataDir: inst.dataDir,
            language: b.language || "zh",
            logLevel: b.logLevel || "info",
            management: b.management === false ? undefined : { enabled: true, port: Number(b.management?.port) || 9820, token: b.management?.token || randomUUID().replace(/-/g, "").slice(0, 24) },
            bridge: b.bridge === false ? undefined : { enabled: true, port: Number(b.bridge?.port) || 9810, token: b.bridge?.token || (b.management?.token || randomUUID().replace(/-/g, "").slice(0, 24)) },
            acp: { connector: acp.connectorBin(), socketPath: acp.primaryEndpoint(instId).socket, connectorSocket: acp.acpSocketPath(instId) },
            projects: Array.isArray(b.projects) ? b.projects.map((x: any) => ({
              name: String(x.name || ""),
              agent: x.agent || "piweb",
              work_dir: x.work_dir ? String(x.work_dir) : "",
              mode: x.mode ? String(x.mode) : "",
              // 原生 piweb agent（type=piweb 直连）；缺省走 type=acp+连接器兜底
              piwebNative: !!x.piwebNative,
              platforms: Array.isArray(x.platforms) ? x.platforms.map((y: any) => ({
                type: String(y.type || ""),
                fields: y.fields && typeof y.fields === "object" ? y.fields : undefined,
                // 旧平铺字段（兼容）：config-gen 会合入 fields
                client_id: y.client_id, client_secret: y.client_secret, agent_id: y.agent_id, bot_name: y.bot_name,
              })) : [],
            })) : [],
          });
          fs.mkdirSync(path.dirname(inst.config), { recursive: true });
          if (fs.existsSync(inst.config)) fs.copyFileSync(inst.config, inst.config + ".bak-" + Date.now());
          fs.writeFileSync(inst.config, toml, "utf8");
          return json({ ok: true, path: inst.config, note: "配置已生成，点 ▶启动 或 ♻重启 生效" });
        } catch (e: any) { return json({ ok: false, error: "配置生成失败：" + e.message }, 500); }
      }

      // Scan-to-create proxy (v2): feishu/lark/weixin — begin|poll|save passthrough.
      // lark shares cc-connect's /setup/feishu/* endpoints (one official device-flow
      // entry; poll auto-detects the lark domain via tenant_brand); save routes by
      // body.platform_type (feishu/lark -> feishu/save, weixin -> weixin/save). The
      // config write belongs to cc-connect's save itself (aiti-channels only forwards
      // and hints reload/restart — never write the same config from both sides).
      if (action === "setup" && req.method === "POST") {
        const platform = String(p[1] || "");
        const op = String(p[2] || ""); // begin | poll | save
        const supported = platform === "feishu" || platform === "lark" || platform === "weixin";
        if (!supported || !["begin", "poll", "save"].includes(op)) return json({ ok: false, error: "不支持的平台/操作" }, 400);
        const body = await req.json().catch(() => ({}));
        // save routes by the platform that owns the credentials (lark also saves via feishu/save, distinguished by platform_type)
        const ccPlatform = platform === "weixin" ? "weixin" : "feishu";
        const st = await m.probe(mOpts);
        if (!st.running) return json({ ok: false, error: "实例未运行：先启动实例再扫码/保存（或手填凭证走完整面板）" }, 409);
        const r = await mgmtApi(mOpts, "POST", `setup/${ccPlatform}/${op}`, body, 60000);
        if (r.status === 0) return json({ ok: false, error: r.error }, 502);
        return json({ ok: r.status >= 200 && r.status < 300, status: r.status, data: r.data });
      }

      // ---- v2 full-capability management proxy (GET/POST/PATCH/DELETE all pass; root allowlist) ----
      // /api/extensions/aiti-channels/mgmt/<cc-connect api/v1 path>?instance=<id>
      if (action === "mgmt") {
        const sub = p.slice(1).filter(Boolean).join("/");
        const root = sub.split("/")[0];
        if (!MGMT_ALLOW.includes(root)) return json({ ok: false, error: `mgmt path not allowed: ${root}` }, 403);
        if (!sub) return json({ ok: false, error: "mgmt path required" }, 400);
        const method = (ctx.method || "GET").toUpperCase();
        // strip our own routing params (?instance=) before proxying
        const fwd = new URLSearchParams(ctx.searchParams);
        fwd.delete("instance");
        const qs = fwd.toString();
        const body = ["GET", "HEAD"].includes(method) ? undefined : await req.text().catch(() => undefined);
        const r = await mgmtApi(mOpts, method, sub + (qs ? `?${qs}` : ""), body === undefined || body === "" ? undefined : body);
        if (r.status === 0) return json({ ok: false, error: r.error }, 502);
        return new Response(typeof r.data === "string" ? r.data : JSON.stringify(r.data), {
          status: r.status,
          headers: { "content-type": "application/json", "cache-control": "no-store" },
        });
      }

      // ---- v2 bots aggregate API (bot-management data plane; secrets never leave the host) ----
      // GET bots: projects × config (card_mode/work_dir) -> ZCode-style bot list
      if (action === "bots" && req.method === "GET") {
        const st = await m.probe(mOpts);
        const cfg = st.cfg || {};
        const modes = readCardModes((() => { try { return fs.existsSync(mOpts.config) ? fs.readFileSync(mOpts.config, "utf8") : ""; } catch { return ""; } })());
        const projCfg: any[] = Array.isArray(cfg.projects) ? cfg.projects : [];
        const r = await mgmtApi(mOpts, "GET", "projects");
        const mgmtPayload = r.data?.data || r.data || {}; // cc-connect mgmtJSON wraps in {data}
        const projects: any[] = r.status === 200 && Array.isArray(mgmtPayload.projects) ? mgmtPayload.projects : [];
        return json({
          ok: true,
          instance: instId,
          running: !!st.running,
          version: st.version || null,
          mgmtReachable: r.status === 200,
          bots: projects.map((pj: any) => {
            const pc = projCfg.find((x: any) => x.name === pj.name) || {};
            return {
              name: pj.name,
              agent_type: pj.agent_type || pc.agent || null,
              platforms: pj.platforms || [],
              sessions_count: pj.sessions_count ?? null,
              heartbeat_enabled: !!pj.heartbeat_enabled,
              bound: (pj.platforms || []).length > 0,
              card_mode: modes.byProject[pj.name] || modes.global || "legacy",
              work_dir: (pc.agentOptions && pc.agentOptions.work_dir) || pc.work_dir || null,
              allow_from: pc.allow_from || null,
            };
          }),
          // config-only projects (visible even when the instance is down / old cc-connect without mgmt)
          configOnly: r.status !== 200 ? projCfg.map((pc: any) => ({
            name: pc.name, agent_type: pc.agent || null, platforms: (pc.platforms || []).map((y: any) => y.type),
            sessions_count: null, heartbeat_enabled: false, bound: (pc.platforms || []).length > 0,
            card_mode: modes.byProject[pc.name] || modes.global || "legacy", work_dir: (pc.agentOptions && pc.agentOptions.work_dir) || pc.work_dir || null, allow_from: pc.allow_from || null,
          })) : [],
          mgmtError: r.status === 0 ? r.error : null,
        });
      }

      // POST bot-create-token: token/form platforms -> cc-connect add-platform (brand-new projects allowed, config-only)
      if (action === "bot-create-token" && req.method === "POST") {
        const b = await parseBody(req);
        const project = String(b.project || "").trim();
        const type = String(b.type || "").trim();
        if (!project || !type) return json({ ok: false, error: "需要 project + type" }, 400);
        const st = await m.probe(mOpts);
        if (!st.running) return json({ ok: false, error: "实例未运行：先启动实例（add-platform 需要 management API）" }, 409);
        const r = await mgmtApi(mOpts, "POST", `projects/${encodeURIComponent(project)}/add-platform`, {
          type,
          options: b.options && typeof b.options === "object" ? b.options : {},
          work_dir: b.work_dir ? String(b.work_dir) : undefined,
          agent_type: b.agent_type ? String(b.agent_type) : undefined,
        }, 30000);
        if (r.status === 0) return json({ ok: false, error: r.error }, 502);
        return json({ ok: r.status >= 200 && r.status < 300, status: r.status, data: r.data });
      }

      // POST bot-delete: removes the bot (= DELETE project; bot <-> project is 1:1)
      if (action === "bot-delete" && req.method === "POST") {
        const b = await parseBody(req);
        const project = String(b.project || "").trim();
        if (!project) return json({ ok: false, error: "需要 project" }, 400);
        const st = await m.probe(mOpts);
        if (!st.running) return json({ ok: false, error: "实例未运行：先启动实例" }, 409);
        const r = await mgmtApi(mOpts, "DELETE", `projects/${encodeURIComponent(project)}`);
        if (r.status === 0) return json({ ok: false, error: r.error }, 502);
        return json({ ok: r.status >= 200 && r.status < 300, status: r.status, data: r.data });
      }

      // POST bot-update：PATCH /projects/{name}（work_dir/agent_type/language/platform_allow_from…）
      if (action === "bot-update" && req.method === "POST") {
        const b = await parseBody(req);
        const project = String(b.project || "").trim();
        const patch = b.patch && typeof b.patch === "object" ? b.patch : null;
        if (!project || !patch) return json({ ok: false, error: "需要 project + patch" }, 400);
        const st = await m.probe(mOpts);
        if (!st.running) return json({ ok: false, error: "实例未运行：先启动实例" }, 409);
        const r = await mgmtApi(mOpts, "PATCH", `projects/${encodeURIComponent(project)}`, patch);
        if (r.status === 0) return json({ ok: false, error: r.error }, 502);
        return json({ ok: r.status >= 200 && r.status < 300, status: r.status, data: r.data });
      }

      // POST bot-cardmode: reply granularity (card_mode legacy|rich; the ONLY local TOML-edit scenario)
      if (action === "bot-cardmode" && req.method === "POST") {
        const b = await parseBody(req);
        const mode = String(b.mode || "") === "rich" ? "rich" : "legacy";
        const project = b.project ? String(b.project) : null;
        const cfgPath = mOpts.config || manager.DEFAULTS.config;
        let raw = "";
        try { raw = fs.existsSync(cfgPath) ? fs.readFileSync(cfgPath, "utf8") : ""; } catch (e: any) { return json({ ok: false, error: "读 config 失败：" + e.message }, 500); }
        if (!raw) return json({ ok: false, error: "config.toml 不存在：先在面板创建实例配置" }, 409);
        try {
          const r = setCardMode(raw, mode as "legacy" | "rich", project);
          fs.copyFileSync(cfgPath, cfgPath + ".bak-" + Date.now());
          fs.writeFileSync(cfgPath, r.raw, "utf8");
        } catch (e: any) { return json({ ok: false, error: e.message }, 400); }
        // hot-apply (reload reads the config back; on failure hint restart)
        const rl = await mgmtApi(mOpts, "POST", "reload", {}, 15000);
        return json({
          ok: true,
          scope: project ? `project:${project}` : "global",
          note: rl.status === 200 ? "card_mode 已写入并热应用（reload）" : "card_mode 已写入 config；reload 失败（实例未运行？），重启实例后生效",
          reload: rl.status,
        });
      }

      // GET bot-meta: dynamic platform/agent list + cc-connect version (drives the scan/form wizards)
      if (action === "bot-meta" && req.method === "GET") {
        const st = await m.probe(mOpts);
        const r = st.running ? await mgmtApi(mOpts, "GET", "agents") : { status: 0, data: null, error: "instance not running" };
        const payload = r.data?.data || r.data || {}; // cc-connect mgmtJSON wraps in {data}
        const agents = Array.isArray(payload.agents) ? payload.agents : [];
        const platforms = Array.isArray(payload.platforms) ? payload.platforms : [];
        return json({
          ok: true,
          instance: instId,
          version: st.version || null,
          running: !!st.running,
          agents, platforms,
          mgmtReachable: r.status === 200,
          mgmtError: r.status === 0 ? r.error : null,
        });
      }

      // ---- v2 Chat (P2): Bridge WS relay — the same-origin equivalent of the native admin's live chat view) ----
      // GET chat-relay-status: bridge availability + relay connection state (token never leaves the host)
      if (action === "chat-relay-status") {
        const info = chatRelay.bridgeInfo(mOpts);
        return json({ ok: true, instance: instId, bridge: { enabled: info.enabled, port: info.port, path: info.path }, relay: chatRelay.relayStatus(instId) });
      }
      // GET chat-stream?project=: SSE downlink (bridge frames, filtered by project; sink removed on disconnect)
      if (action === "chat-stream") {
        const project = ctx.searchParams.get("project");
        return chatRelay.sseChat(instId, mOpts, project);
      }
      // POST chat-send {project, session_key?, content}: send via the bridge WS (web-admin session pattern)
      if (action === "chat-send" && req.method === "POST") {
        const b = await parseBody(req);
        const r = chatRelay.sendChat(instId, mOpts, { project: String(b.project || ""), sessionKey: String(b.session_key || ""), content: String(b.content || "") });
        return json(r, r.ok ? 200 : 502);
      }

      // ACP server（P3：pi-web 作为 agent 后端）状态：监听/socket/连接器/桥接会话
      if (action === "acp-status") {
        return json({ ok: true, instance: instId, ...(await acp.acpStatus(instId)) });
      }

      // 进程托管
      if (action === "start" && req.method === "POST") return json(await m.start(mOpts));
      if (action === "stop" && req.method === "POST") return json(await m.stop(mOpts));
      if (action === "restart" && req.method === "POST") return json(await m.restart(mOpts));
      if (action === "log") {
        const n = Math.min(Number(ctx.searchParams.get("n")) || 80, 300);
        return json({ ok: true, ...m.logTail(mOpts, n) });
      }

      // 配置读取（GET 返回解析后 cfg + 原文 raw）/ 保存（POST 写回 config.toml 原文）
      if (action === "config") {
        const cfgPath = mOpts.config || manager.DEFAULTS.config;
        if (req.method === "POST") {
          const b = await parseBody(req);
          const raw = b.raw != null ? String(b.raw) : (b.toml != null ? String(b.toml) : "");
          if (!raw) return json({ ok: false, error: "需要 raw/toml 文本" }, 400);
          try {
            // 备份后写回
            if (fs.existsSync(cfgPath)) {
              const bak = cfgPath + ".bak-panel-" + Date.now();
              fs.copyFileSync(cfgPath, bak);
            }
            fs.writeFileSync(cfgPath, raw, "utf8");
            return json({ ok: true, path: cfgPath, note: "已写回 config.toml，点 💾reload 热应用运行时参数（项目/平台增删改需重启）" });
          } catch (e: any) { return json({ ok: false, error: "写配置失败：" + e.message }, 500); }
        }
        const cfg = readConfigFile(cfgPath);
        let raw = "";
        try { raw = fs.existsSync(cfgPath) ? fs.readFileSync(cfgPath, "utf8") : ""; } catch { /* ignore */ }
        return json({ ok: !!cfg, cfg, raw });
      }

      // 发消息（socket API）——成功/失败都写消息日志；session_key 可留空自动选该项目第一个活跃会话
      if (action === "send" && req.method === "POST") {
        const b = await parseBody(req);
        const project = String(b.project || "");
        let sessionKey = String(b.session_key || "");
        const message = String(b.message || "");
        const filePath = b.filePath ? String(b.filePath) : undefined;
        // cc-connect api_addr patch：实例配置 api_addr → 出站走 TCP（Windows 可达通道）
        const ccApiAddr = readConfigFile(mOpts.config || manager.DEFAULTS.config)?.apiAddr || undefined;
        if (!project || !message) return json({ ok: false, error: "需要 project + message" }, 400);
        // session_key 留空 → 自动取该项目第一个活跃会话（与 aiti-im-send 工具一致）
        if (!sessionKey) {
          try {
            const r = await m.listSessions(mOpts.sock, ccApiAddr);
            const raw: any = r.data;
            const sessions: any[] = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.sessions) ? raw.sessions : []);
            const hit = sessions.find((s: any) => s.project === project) || sessions[0];
            if (hit && (hit.session_key || hit.id)) sessionKey = hit.session_key || hit.id;
          } catch { /* 保持空 */ }
        }
        if (!sessionKey) return json({ ok: false, error: "无活跃会话可自动选择，请先给目标机器人发消息激活会话（或用 aiti-im-list 拿 session_key）" }, 400);
        try {
          const r = await m.sendMessage({ project, sessionKey, message, filePath, fileName: b.fileName ? String(b.fileName) : undefined, mimeType: b.mimeType ? String(b.mimeType) : undefined, sock: mOpts.sock, tcpAddr: ccApiAddr });
          const ok = r.data && (r.data as any).status === "ok";
          m.writeMsgLog(mOpts, { project, session_key: sessionKey, message, file: filePath || null, result: ok ? "ok" : "error", detail: r });
          return json({ ok: true, socket: r, logged: true });
        } catch (e: any) {
          m.writeMsgLog(mOpts, { project, session_key: sessionKey, message, file: filePath || null, result: "error", detail: { error: e.message } });
          return json({ ok: false, error: e.message }, 500);
        }
      }

      // 消息日志（我们平台经 cc-connect 发的消息记录）
      if (action === "msg-log") {
        const n = Math.min(Number(ctx.searchParams.get("n")) || 100, 500);
        return json({ ok: true, logs: m.readMsgLogs(mOpts, n) });
      }

      // 活跃会话（socket API）
      if (action === "sessions") {
        try {
          const r = await m.listSessions(mOpts.sock);
          return json({ ok: true, data: r.data });
        } catch (e: any) { return json({ ok: false, error: e.message }, 500); }
      }

      // 触发 cc-connect 配置 reload（POST /api/v1/reload，经服务端转发带 token）
      if (action === "reload-cc" && req.method === "POST") {
        const cfg = readConfigFile(mOpts.config || manager.DEFAULTS.config);
        const port = (cfg && cfg.management && cfg.management.port) || 9820;
        const token = (cfg && cfg.management && cfg.management.token) || "";
        try {
          const r = await fetch(`http://127.0.0.1:${port}/api/v1/reload`, {
            method: "POST",
            headers: token ? { authorization: `Bearer ${token}` } : {},
            signal: AbortSignal.timeout(15000),
          });
          const d = await r.json().catch(() => null);
          return json({ ok: r.ok, status: r.status, data: d });
        } catch (e: any) { return json({ ok: false, error: "reload 请求失败：" + e.message }, 500); }
      }

      // 触发 cc-connect 自动重启（POST /api/v1/restart，进程替换保留 pid）
      if (action === "restart-cc" && req.method === "POST") {
        const cfg = readConfigFile(mOpts.config || manager.DEFAULTS.config);
        const port = (cfg && cfg.management && cfg.management.port) || 9820;
        const token = (cfg && cfg.management && cfg.management.token) || "";
        try {
          const r = await fetch(`http://127.0.0.1:${port}/api/v1/restart`, {
            method: "POST",
            headers: token ? { authorization: `Bearer ${token}` } : {},
            signal: AbortSignal.timeout(10000),
          });
          const d = await r.json().catch(() => null);
          return json({ ok: r.ok, status: r.status, data: d });
        } catch (e: any) { return json({ ok: false, error: "restart 请求失败：" + e.message }, 500); }
      }

      // 安装状态：当前版本 / 最新版本 / 可更新 / 下载源
      if (action === "install-status") {
        const cur = await installer.currentVersion();
        let latest: { tag: string; source: string } | null = null;
        let err: string | null = null;
        try { latest = await installer.latestVersion(); } catch (e: any) { err = e.message; }
        const needUpdate = !!(latest && cur.version && latest.tag !== cur.version);
        return json({
          ok: true,
          current: cur.version,
          currentBin: cur.bin,
          latest: latest ? latest.tag : null,
          latestSource: latest ? latest.source : null,
          needUpdate,
          managedBin: installer.managedBin(),
          justgetCli: installer.resolveJustgetCli(),
          justgetMode: await installer.justgetMode(),
          error: err,
        });
      }

      // 安装/更新（justget 下载：主源 github + 镜像 gitee；安装到托管 bin + sudo 同步系统 bin）
      if (action === "install" && req.method === "POST") {
        const b = await parseBody(req);
        try {
          const r = await installer.install(b.tag ? String(b.tag) : undefined, { systemBin: b.systemBin !== false });
          return json(r, r.ok ? 200 : 409);
        } catch (e: any) { return json({ ok: false, error: e.message }, 500); }
      }

      return json({ ok: false, error: "not found: " + p.join("/") }, 404);
    },

    // ---- 方案 M：agent 工具（进程内注入，零配置） ----
    // 命名（用户指定）：aiti-im-list / aiti-im-send
    agent: {
      agentTools(info: any) {
        // 门控由 core 统一判定（feature agentTools.enabled + per-session enableExtTools），此处无条件返回
        const m = mgr();
        const mOpts = { dataDir: m.getDataDir() };
        // agent 工具默认作用在默认实例
        const defInst = m.resolveInstance("default");
        const defOpts = m.optsFor(defInst || { id: "default", name: "默认", config: manager.DEFAULTS.config, dataDir: "" });
        // cc-connect api_addr patch：默认实例配置 api_addr → 出站 TCP（Windows 可达通道）
        const defApiAddr = readConfigFile(defOpts.config || manager.DEFAULTS.config)?.apiAddr || undefined;

        // 取活跃会话（socket /sessions；返回 null/空时给 [] ）
        const fetchSessions = async (): Promise<any[]> => {
          try {
            const r = await m.listSessions(defOpts.sock, defApiAddr);
            const raw = r.data;
            if (Array.isArray(raw)) return raw;
            if (raw && Array.isArray(raw.sessions)) return raw.sessions;
            return [];
          } catch { return []; }
        };
        const snipe = (t: string, n = 80) => {
          const s = String(t || "");
          return s.length > n ? s.slice(0, n) + "…" : s;
        };

        return [
          {
            name: "aiti-im-list",
            label: "aiti-im-list",
            description: "列出 IM 渠道/项目/活跃会话（cc-connect）。返回：进程状态（运行/pid/版本）、项目清单（agent 类型/平台/会话数）、活跃会话（project/platform/session_key/active/chat_name/history_count/last_message 摘要）。发消息（aiti-im-send）前先用它拿到 session_key。",
            parameters: { type: "object", properties: {}, },
            async execute() {
              try {
                const st = await m.probe(defOpts);
                const sessions = await fetchSessions();
                return JSON.stringify({
                  ok: true,
                  process: { running: st.running, pid: st.pid, version: st.version, port9820: st.port9820, sockAlive: st.sockAlive },
                  projects: (st.cfg?.projects || []).map((x: any) => ({ name: x.name, agent: x.agentType, platforms: (x.platforms || []).map((y: any) => y.type), work_dir: x.agentOptions?.work_dir || null })),
                  sessions: sessions.map((s: any) => ({
                    project: s.project || null,
                    platform: s.platform || "im",
                    session_key: s.session_key || s.id || null,
                    active: !!s.active,
                    chat_name: s.chat_name || null,
                    history_count: s.history_count ?? null,
                    last_message: s.last_message ? snipe(typeof s.last_message === "string" ? s.last_message : s.last_message.content) : null,
                  })),
                  hint: sessions.length ? "用 aiti-im-send 发消息（project + session_key）" : "无活跃会话：在钉钉/飞书等给机器人发消息激活后，再 aiti-im-list 查看",
                });
              } catch (e: any) { return JSON.stringify({ ok: false, error: e.message }); }
            },
          },
          {
            name: "aiti-im-send",
            label: "aiti-im-send",
            description: "经 cc-connect 向 IM 渠道（钉钉/飞书/微信…）发文本或文件，并写消息日志。参数：project=项目名（必填）、message=要发的文本（必填）；session_key=会话 key（可选——不填则自动取该项目第一个活跃会话）；filePath=本地文件绝对路径（可选，发文件）。调用前可用 aiti-im-list 拿 session_key。",
            parameters: {
              type: "object",
              properties: {
                project: { type: "string", description: "cc-connect 项目名（如 autoai/justdb，aiti-im-list 可查）" },
                session_key: { type: "string", description: "会话 key（格式 dingtalk:d:<cid>:<staffId>；不填则自动取该项目第一个活跃会话）" },
                message: { type: "string", description: "要发送的文本内容" },
                filePath: { type: "string", description: "可选：要发送的本地文件绝对路径（发文件时用）" },
              },
              required: ["project", "message"],
            },
            async execute(args: any, _signal?: any) {
              const project = String(args.project || "");
              const message = String(args.message || "");
              const filePath = args.filePath ? String(args.filePath) : undefined;
              let sessionKey = args.session_key ? String(args.session_key) : "";
              try {
                if (!project || !message) return JSON.stringify({ ok: false, error: "需要 project + message" });
                // session_key 未给 → 自动取该项目第一个活跃会话
                if (!sessionKey) {
                  const sessions = await fetchSessions();
                  const hit = sessions.find((s: any) => s.project === project) || sessions[0];
                  if (hit && hit.session_key) {
                    sessionKey = hit.session_key;
                  } else {
                    return JSON.stringify({ ok: false, error: "无活跃会话可自动选择，请先用 aiti-im-list 拿 session_key" });
                  }
                }
                const r = await m.sendMessage({ project, sessionKey: sessionKey, message, filePath, sock: defOpts.sock, tcpAddr: defApiAddr });
                const ok = r.data && (r.data as any).status === "ok";
                m.writeMsgLog(mOpts, { project, session_key: sessionKey, message, file: filePath || null, result: ok ? "ok" : "error", detail: r });
                return JSON.stringify({ ok, project, session_key: sessionKey, file: filePath || null, socket: r, logged: true });
              } catch (e: any) {
                m.writeMsgLog(mOpts, { project, session_key: sessionKey || "", message, file: filePath || null, result: "error", detail: { error: e.message } });
                return JSON.stringify({ ok: false, error: e.message });
              }
            },
          },
        ];
      },
    },
  },
};
