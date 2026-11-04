/**
 * aiti-mail · pi-web 通用「邮件发送出口」扩展（v0.1.0）
 *
 * 方案：docs/aiti-ai-schedule-integration-plan.md §4.6
 * 定位：配置一次 SMTP，任何扩展/AI 都能发（aiti-ai-schedule 是首个消费方）。
 *
 * 结构：index.ts（入口 + API）+ smtp.ts（零依赖 SMTP 客户端）+ store.ts（node:sqlite 发送记录）
 *       + client/aiti-mail-client.mjs（管理弹窗：配置/发送记录）
 *
 * 配置存储：dataDir/config.json（0600）{host, port, secure, user, pass, from}
 *   —— 不放 features.json（密码会进 aiti-configs 同步面；v3 拍板：encrypt.patterns 加密入仓，
 *      `web/data/aiti-mail/*.json`）；API GET /config 对 pass 只回 hasPass，不回显明文。
 *
 * API 面：
 *   GET  /config               当前配置（pass 不回显 → hasPass）
 *   POST /config               保存配置（pass 缺省=保留旧值；写 0600）
 *   POST /test                 {to} 发测试邮件（source=test）
 *   POST /send                 {to, subject, body, source?} 对外发送入口；to 逗号分隔，
 *                              逐个发送逐条记录；返回 {ok, results:[{to,status,error}]}
 *   GET  /log?limit=&status=   发送记录（默认 50，倒序）
 */
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join as pathJoin } from "node:path";
import { sendMail, parseAddressList, type SmtpConfig } from "./smtp.ts";
import { SendStore } from "./store.ts";

let store: SendStore | null = null;
let configDir = "";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json", "cache-control": "no-store" },
});

// ───────────────────────── 配置（0600 本地文件，方案 §4.6） ─────────────────────────

interface MailConfig { host: string; port: number; secure: boolean; noStarttls?: boolean; user?: string; pass?: string; from?: string }

function cfgFile(): string { return pathJoin(configDir, "config.json"); }

function loadConfig(): MailConfig | null {
  try {
    if (!existsSync(cfgFile())) return null;
    const c = JSON.parse(readFileSync(cfgFile(), "utf8"));
    if (!c || !c.host) return null;
    return {
      host: String(c.host),
      port: Number(c.port) || (c.secure ? 465 : 587),
      secure: c.secure === true || Number(c.port) === 465,
      user: c.user ? String(c.user) : undefined,
      pass: c.pass ? String(c.pass) : undefined,
      from: c.from ? String(c.from) : undefined,
    };
  } catch { return null; }
}

/** 写 0600（writeFileSync mode 只作用于新建；已存在文件再 chmod 兜底）。 */
function saveConfig(cfg: MailConfig): void {
  const p = cfgFile();
  writeFileSync(p, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
  try { chmodSync(p, 0o600); } catch { /* Windows 忽略 */ }
}

/** 对外回显：pass → hasPass（明文永不出口）。 */
function redactConfig(c: MailConfig) {
  return { host: c.host, port: c.port, secure: c.secure, noStarttls: !!c.noStarttls, user: c.user || "", from: c.from || "", hasPass: !!c.pass };
}

// ───────────────────────── 发送 + 逐条记录 ─────────────────────────

interface SendOutcome { to: string; status: "ok" | "error"; error?: string; messageId?: string; durationMs: number }

async function sendAndRecord(cfg: MailConfig, toList: string[], subject: string, body: string, source: string): Promise<SendOutcome[]> {
  const results: SendOutcome[] = [];
  const from = cfg.from || cfg.user || cfg.host;
  for (const to of toList) {
    const t0 = Date.now();
    try {
      const r = await sendMail(
        { host: cfg.host, port: cfg.port, secure: cfg.secure, noStarttls: cfg.noStarttls, user: cfg.user, pass: cfg.pass, from },
        { from, to: [to], subject, body },
      );
      store?.insert({
        ts: new Date().toISOString(), to_addr: to, subject: subject.slice(0, 300),
        body_len: Buffer.byteLength(body, "utf8"), status: "ok", error: null,
        message_id: r.messageId, duration_ms: Date.now() - t0, source,
      });
      results.push({ to, status: "ok", messageId: r.messageId, durationMs: Date.now() - t0 });
    } catch (e: any) {
      const err = String(e?.message || e).slice(0, 400);
      store?.insert({
        ts: new Date().toISOString(), to_addr: to, subject: subject.slice(0, 300),
        body_len: Buffer.byteLength(body, "utf8"), status: "error", error: err,
        message_id: null, duration_ms: Date.now() - t0, source,
      });
      results.push({ to, status: "error", error: err, durationMs: Date.now() - t0 });
    }
  }
  return results;
}

// ───────────────────────── 扩展入口 ─────────────────────────

export default {
  id: "aiti-mail",
  name: "邮件发送",
  version: "0.1.0",
  icon: "icon.svg",
  client: "dist/aiti-mail-client.mjs",

  // AI 自管理（M3 帮助点：教 AI 帮用户配 SMTP / 查记录 / 调 /send）
  ai: {
    manage: true,
    intro: "AI 能帮我配置 SMTP 发件邮箱、发测试邮件、查发送记录",
    skills: "skills",
  },

  ui: {
    clientImmediately: false, // [懒加载 v2] 静态条目点击拉起
    toolbar: [{ id: "aiti-mail-open", label: "邮件", title: "邮件：SMTP 配置 / 发送测试 / 发送记录", icon: "icons/mail.svg" }],
    // aiti-float dock v3：停靠槽静态声明（懒扩展物化触发 + 静态入口；id 与 client 注册一致）
    rightFileDock: [{ id: "panel", label: "邮件" }],
    dialogs: [{ id: "aiti-mail-panel", label: "邮件（SMTP 配置 / 发送记录）" }],
  },

  server: {
    startup(ctx: any) {
      configDir = String(ctx.configDir || "");
      store = new SendStore(configDir); // mails.db → cache（store 内插 cache 层）
      store.startRetentionTimer(); // 启动清理一次 + 每日一次（unref）
      console.log("[aiti-mail] 就绪 · configDir=" + configDir + " · SMTP " + (loadConfig() ? "已配置" : "未配置"));
    },
    shutdown() {
      store?.close();
      store = null;
    },

    async api(req: any, ctx: any) {
      const p = ctx.path || [];
      const url = new URL(req.url);

      // GET /config —— pass 不回显（hasPass）
      if (req.method === "GET" && p[0] === "config" && p.length === 1) {
        const c = loadConfig();
        return json({ ok: true, configured: !!c, config: c ? redactConfig(c) : null });
      }

      // POST /config —— 保存；pass 缺省=保留旧值
      if (req.method === "POST" && p[0] === "config" && p.length === 1) {
        const b = await req.json().catch(() => null);
        if (!b || !b.host || !String(b.host).trim()) return json({ ok: false, error: "host 必填" }, 400);
        const old = loadConfig();
        const port = Number(b.port) || (b.secure ? 465 : 587);
        const cfg: MailConfig = {
          host: String(b.host).trim(),
          port,
          secure: b.secure === true || b.secure === "true" || port === 465,
          noStarttls: b.noStarttls !== undefined ? b.noStarttls === true : !!old?.noStarttls,
          user: b.user !== undefined ? String(b.user).trim() : old?.user,
          pass: b.pass ? String(b.pass) : old?.pass, // 缺省=保留旧值
          from: b.from !== undefined ? String(b.from).trim() : old?.from,
        };
        saveConfig(cfg);
        return json({ ok: true, config: redactConfig(cfg) });
      }

      // POST /test —— 发测试邮件（source=test）
      if (req.method === "POST" && p[0] === "test" && p.length === 1) {
        const cfg = loadConfig();
        if (!cfg) return json({ ok: false, error: "SMTP 未配置——先填写并保存配置" }, 400);
        const b = await req.json().catch(() => null);
        const toList = parseAddressList(String(b?.to || "")).map((a) => a.address);
        if (toList.length === 0) return json({ ok: false, error: "缺少合法收件人 to" }, 400);
        const results = await sendAndRecord(cfg, toList,
          "aiti-mail 测试邮件",
          "这是一封来自 pi-web aiti-mail 的测试邮件。\n\n收到即说明 SMTP 配置正确。\n\n—— pi-web 邮件\n" + new Date().toISOString(),
          "test");
        return json({ ok: results.every((r) => r.status === "ok"), results });
      }

      // POST /send —— 对外发送入口（多收件人逐个发、逐条记录）
      if (req.method === "POST" && p[0] === "send" && p.length === 1) {
        const cfg = loadConfig();
        if (!cfg) return json({ ok: false, error: "SMTP 未配置——先在 邮件 弹窗配置" }, 400);
        const b = await req.json().catch(() => null);
        const toList = parseAddressList(String(b?.to || "")).map((a) => a.address);
        if (toList.length === 0) return json({ ok: false, error: "缺少合法收件人 to（逗号分隔）" }, 400);
        const subject = String(b?.subject || "").trim();
        if (!subject) return json({ ok: false, error: "缺少 subject" }, 400);
        const body = String(b?.body ?? "");
        const source = String(b?.source || "api").slice(0, 120);
        const results = await sendAndRecord(cfg, toList, subject, body, source);
        const failed = results.filter((r) => r.status !== "ok");
        return json({
          ok: failed.length === 0,
          ...(failed.length ? { error: failed.length + "/" + results.length + " 个收件人发送失败" } : {}),
          results,
        });
      }

      // GET /log?limit=&status= —— 发送记录
      if (req.method === "GET" && p[0] === "log" && p.length === 1) {
        if (!store) return json({ ok: false, error: "扩展未初始化" }, 503);
        return json({ ok: true, sends: store.list(url.searchParams.get("limit") || 50, url.searchParams.get("status") || undefined) });
      }

      return json({ ok: false, error: "not found: " + p.join("/") }, 404);
    },
  },
};
