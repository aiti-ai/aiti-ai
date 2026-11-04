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
  version: "0.1.0",
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
    toolbar: [{ id: "aiti-channels-open", label: "IM 渠道", title: "aiti-channels：cc-connect 托管 + IM 渠道 + 管理台嵌入", icon: "icons/message-circle.svg" }],
    dialogs: [{ id: "aiti-channels-panel", label: "IM 渠道与 cc-connect 管理" }],
    i18n: {
      en: {
        "channels.title": "IM Channels & cc-connect",
        "channels.open": "IM Channels",
        "channels.close": "Close",
      },
      "zh-CN": {
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
        m.saveInstance({ id, name, config, dataDir });
        void acp.ensureAll([id]);
        return json({ ok: true, instance: { id, name, config, dataDir } });
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
            acp: { connector: acp.connectorBin(), socketPath: acp.acpSocketPath(instId) },
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

      // 扫码授权代理：转发到实例 management API 的官方 setup 向导（feishu/weixin）。
      // 前端不直连 cc-connect 端口/token——经本代理带 token 转发；save 不代代（凭证自动回填
      // 我们的 config-gen 表单，配置生成仍归 config-gen，避免两边写同一 config 打架）。
      if (action === "setup" && req.method === "POST") {
        const platform = String(p[1] || "");
        const op = String(p[2] || ""); // begin | poll
        if (!"feishu weixin".includes(platform) || !["begin", "poll"].includes(op)) return json({ ok: false, error: "不支持的平台/操作" }, 400);
        const cfg = readConfigFile(mOpts.config || manager.DEFAULTS.config);
        const port = (cfg && cfg.management && cfg.management.port) || 9820;
        const token = (cfg && cfg.management && cfg.management.token) || "";
        const body = await parseBody(req);
        try {
          const r = await fetch(`http://127.0.0.1:${port}/api/v1/setup/${platform}/${op}`, {
            method: "POST",
            headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(20000),
          });
          const d = await r.json().catch(() => ({}));
          return json({ ok: r.ok, status: r.status, data: d });
        } catch (e: any) {
          return json({ ok: false, error: `实例未运行或 management(${port}) 不可达：先启动实例再扫码，或手填凭证` }, 502);
        }
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
        if (!project || !message) return json({ ok: false, error: "需要 project + message" }, 400);
        // session_key 留空 → 自动取该项目第一个活跃会话（与 aiti-im-send 工具一致）
        if (!sessionKey) {
          try {
            const r = await m.listSessions(mOpts.sock);
            const raw: any = r.data;
            const sessions: any[] = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.sessions) ? raw.sessions : []);
            const hit = sessions.find((s: any) => s.project === project) || sessions[0];
            if (hit && (hit.session_key || hit.id)) sessionKey = hit.session_key || hit.id;
          } catch { /* 保持空 */ }
        }
        if (!sessionKey) return json({ ok: false, error: "无活跃会话可自动选择，请先给目标机器人发消息激活会话（或用 aiti-im-list 拿 session_key）" }, 400);
        try {
          const r = await m.sendMessage({ project, sessionKey, message, filePath, fileName: b.fileName ? String(b.fileName) : undefined, mimeType: b.mimeType ? String(b.mimeType) : undefined, sock: mOpts.sock });
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

        // 取活跃会话（socket /sessions；返回 null/空时给 [] ）
        const fetchSessions = async (): Promise<any[]> => {
          try {
            const r = await m.listSessions(defOpts.sock);
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
                const r = await m.sendMessage({ project, sessionKey: sessionKey, message, filePath, sock: defOpts.sock });
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
