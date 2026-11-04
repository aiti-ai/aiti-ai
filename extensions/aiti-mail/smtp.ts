/**
 * smtp.ts —— 零依赖 SMTP 客户端（aiti-mail，方案 docs/aiti-ai-schedule-integration-plan.md §4.6）
 *
 * 覆盖主流：
 *   - 465 = 隐式 TLS（tls.connect）；587/25 = 明文连接 + STARTTLS 升级（服务端 advertised 才升）；
 *     secure:false && port:465 自动纠正为隐式 TLS。
 *   - AUTH：优先 PLAIN，服务端不 advertised 则 LOGIN 兜底；无 user 时跳过认证。
 *   - MIME：UTF-8；主题 RFC 2047 encoded-word（B 编码，每词 ≤75 字符）；
 *     正文 text/plain; charset=UTF-8，base64 按 76 字符切行（RFC 2045，998 限制内）；
 *     Date / Message-ID / From / To 头；DATA 阶段 dot-stuffing + CRLF。
 *   - 全程超时 25s；不自动重试（调用方决定）。
 *
 * 可测性：encodeRfc2047 / buildMime / parseAddressList / formatAddress / splitAddresses
 * 为纯函数，tools/smtp.test.mjs（node:test 零依赖）覆盖。
 */
import net from "node:net";
import tls from "node:tls";
import { hostname } from "node:os";

export interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;            // true=隐式 TLS（465）
  /** true=明文直连：即使服务器 advertised STARTTLS 也不升级（25 直连内网中继档）。
   *  缺省 false=安全默认（advertised 即升级）。 */
  noStarttls?: boolean;
  user?: string;
  pass?: string;
  from?: string;              // 缺省用 user
}

export interface OutgoingMail {
  from: string;
  to: string[];               // 已解析的地址列表
  subject: string;
  body: string;
  messageId?: string;         // 缺省自动生成
  date?: Date;                // 缺省 now
}

/** 全程超时（方案 §4.6：25s） */
export const SMTP_TIMEOUT_MS = 25_000;

// ───────────────────────── 纯函数：地址 ─────────────────────────

/**
 * 拆分逗号分隔的收件人串（容忍「名字, 带 <addr> 的项」内部逗号——按 <> 配对切分）。
 * 返回原始片段（trim 后非空）；解析成 {name,address} 用 parseAddressList。
 */
export function splitAddresses(s: string): string[] {
  // 全角逗号/分号统一为半角（中文输入常见）
  const src = String(s || "").replace(/，/g, ",").replace(/；/g, ";");
  const out: string[] = [];
  let cur = "";
  let depth = 0; // <> 内的逗号不算分隔
  let inQuote = false;
  for (const ch of src) {
    if (ch === '"') inQuote = !inQuote;
    if (!inQuote) {
      if (ch === "<") depth++;
      else if (ch === ">" && depth > 0) depth--;
      else if (ch === "," && depth === 0) { out.push(cur.trim()); cur = ""; continue; }
      else if (ch === ";" && depth === 0) { out.push(cur.trim()); cur = ""; continue; }
    }
    cur += ch;
  }
  out.push(cur.trim());
  return out.filter(Boolean);
}

/** 解析单个地址片段：「user@host」或「Name <user@host>」或「"Name" <user@host>」。 */
export function parseAddress(piece: string): { name: string; address: string } | null {
  const s = String(piece || "").trim();
  if (!s) return null;
  const m = s.match(/^(.*?)<\s*([^<>\s]+)\s*>$/);
  if (m) {
    const name = m[1].trim().replace(/^"(.*)"$/, "$1").trim();
    return { name, address: m[2] };
  }
  if (/^[^\s@]+@[^\s@]+$/.test(s)) return { name: "", address: s };
  return null;
}

/** 解析逗号分隔的地址串 → 地址对象列表（非法片段丢弃）。 */
export function parseAddressList(s: string): { name: string; address: string }[] {
  const out: { name: string; address: string }[] = [];
  for (const piece of splitAddresses(s)) {
    const a = parseAddress(piece);
    if (a) out.push(a);
  }
  return out;
}

/** 地址 → 头部形态：有名字 → `Name <addr>`（名字含非 ASCII 时 RFC 2047 编码）；否则裸地址。 */
export function formatAddress(a: { name: string; address: string }): string {
  if (!a.name) return a.address;
  // 纯 ASCII 名字直接用（引号包起防特殊字符）；否则 encoded-word
  if (/^[\x20-\x7e]*$/.test(a.name)) {
    return /^[\w .-]*$/.test(a.name) ? `${a.name} <${a.address}>` : `"${a.name.replace(/"/g, "")}" <${a.address}>`;
  }
  return `${encodeRfc2047(a.name)} <${a.address}>`;
}

// ───────────────────────── 纯函数：RFC 2047 / MIME ─────────────────────────

/**
 * RFC 2047 encoded-word（B 编码）：「=?UTF-8?B?<base64>?=」。
 * 每个 encoded-word 整体 ≤75 字符 → base64 净荷 ≤ (75 - 12) 字符，按 UTF-8 字节边界切块，
 * 词间以 CRLF+空格 折叠（RFC 2047 §2）。
 */
export function encodeRfc2047(text: string): string {
  const s = String(text ?? "");
  // 纯可打印 ASCII（无 ?_= 特殊风险字符）无需编码
  if (/^[\x20-\x7e]*$/.test(s) && !/[?=]/.test(s)) return s;
  const bytes = Buffer.from(s, "utf8");
  // encoded-word 整体 ≤75 字符："=?UTF-8?B?" (10) + b64 + "?=" (2) → b64 ≤63 且为 4 的倍数 → 60
  // 字符 → 净荷 ≤ 60/4*3 = 45 字节
  const maxPayload = 45;
  const words: string[] = [];
  let start = 0;
  while (start < bytes.length) {
    // 按 UTF-8 字符边界切块（不切多字节字符中间）
    let end = Math.min(start + maxPayload, bytes.length);
    while (end > start && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
    if (end === start) end = Math.min(start + maxPayload, bytes.length); // 畸形字节兜底：硬切
    words.push("=?UTF-8?B?" + bytes.subarray(start, end).toString("base64") + "?=");
    start = end;
  }
  return words.join("\r\n ");
}

/**
 * 组装完整 RFC 822 报文（未含 SMTP DATA 点透传——那是 sendMail 的事）。
 * 行尾 CRLF；正文 base64 76 字符切行。
 */
export function buildMime(mail: OutgoingMail): string {
  const date = mail.date || new Date();
  const messageId = mail.messageId || `<${date.getTime()}.${Math.random().toString(36).slice(2, 10)}@${hostname()}>`;
  const headers: string[] = [
    `From: ${formatAddress({ name: "", address: mail.from })}`,
    `To: ${mail.to.map((t) => formatAddress({ name: "", address: t })).join(", ")}`,
    `Subject: ${encodeRfc2047(mail.subject || "")}`,
    `Date: ${formatRfc5322Date(date)}`,
    `Message-ID: ${messageId}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset=UTF-8',
    "Content-Transfer-Encoding: base64",
  ];
  const body = Buffer.from(mail.body || "", "utf8").toString("base64").replace(/(.{76})/g, "$1\r\n");
  return headers.filter(Boolean).join("\r\n") + "\r\n\r\n" + body + (body.endsWith("\r\n") ? "" : "\r\n");
}

/** RFC 5322 日期：「Mon, 07 Sep 2026 09:00:00 +0000」（恒 UTC，确定性/免时区换算错误）。 */
export function formatRfc5322Date(d: Date): string {
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${days[d.getUTCDay()]}, ${pad(d.getUTCDate())} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} +0000`;
}

/** DATA 阶段 dot-stuffing：行首的 . 加倍（RFC 5321 §4.5.2）。 */
export function dotStuff(payload: string): string {
  return String(payload).replace(/\r\n\./g, "\r\n..").replace(/^\./, "..");
}

// ───────────────────────── 协议层 ─────────────────────────

class SmtpError extends Error {
  code: string;
  constructor(msg: string, code = "") { super(msg); this.code = code; }
}

/** 命令-应答管道：逐行收包，多行应答（250-…）聚合到终行（250 空格）。 */
class SmtpConn {
  private socket: net.Socket | any;
  private buffer = "";
  private waiter: { resolve: (lines: string[]) => void; reject: (e: Error) => void } | null = null;
  private closed = false;

  private deadline: number;

  constructor(socket: net.Socket | any, deadline: number) {
    this.socket = socket;
    this.deadline = deadline;
    socket.setEncoding("binary");
    socket.on("data", (chunk: string) => {
      this.buffer += chunk;
      this.drain();
    });
    socket.on("error", (e: Error) => this.fail(new SmtpError("连接错误：" + (e as any).message)));
    socket.on("close", () => {
      this.closed = true;
      this.fail(new SmtpError("连接被对端关闭"));
    });
    socket.setTimeout(Math.max(1000, deadline - Date.now()), () => {
      this.fail(new SmtpError("超时（" + SMTP_TIMEOUT_MS / 1000 + "s）"));
    });
  }

  private checkDeadline() {
    if (Date.now() > this.deadline) this.fail(new SmtpError("超时（" + SMTP_TIMEOUT_MS / 1000 + "s）"));
  }

  private drain() {
    if (!this.waiter) return;
    // 完整应答：出现「\d{3} 」终行即聚合完毕
    const lines = this.buffer.split(/\r?\n/);
    let complete = -1;
    for (let i = 0; i < lines.length - 1; i++) {
      if (/^\d{3}([ ]|$)/.test(lines[i])) { complete = i; break; }
    }
    if (complete === -1) { this.checkDeadline(); return; }
    const reply = lines.slice(0, complete + 1);
    this.buffer = lines.slice(complete + 1).join("\r\n");
    const w = this.waiter; this.waiter = null;
    w.resolve(reply);
  }

  private fail(e: Error) {
    const w = this.waiter;
    if (w) { this.waiter = null; w.reject(e); }
    try { this.socket.destroy(); } catch { /* 忽略 */ }
  }

  /** 读一条完整应答（多行聚合）。 */
  readReply(): Promise<string[]> {
    if (this.closed) return Promise.reject(new SmtpError("连接已关闭"));
    this.checkDeadline();
    return new Promise((resolve, reject) => { this.waiter = { resolve, reject }; this.drain(); });
  }

  write(line: string) {
    if (this.closed) throw new SmtpError("连接已关闭");
    this.socket.write(line.endsWith("\r\n") ? line : line + "\r\n");
  }

  /** STARTTLS：把现有明文 socket 升级为 TLS（复用底层 fd；旧 data 监听拆除）。 */
  async starttls(servername: string) {
    const raw = this.socket;
    try { raw.removeAllListeners("data"); } catch { /* 忽略 */ }
    // STARTTLS 协商后服务器不再发明文；残余缓冲清空（TLS 握手从裸字节重新开始）
    this.buffer = "";
    this.waiter = null;
    const upgraded = await new Promise<any>((resolve, reject) => {
      const s = (tls as any).connect({
        socket: raw,
        servername,
        rejectUnauthorized: false, // 自签证书也发（自托管场景；不校验链是邮件客户端常见宽松档）
      }, () => resolve(s));
      s.once("error", (e: Error) => reject(e));
    });
    // 换绑监听
    this.socket = upgraded;
    upgraded.setEncoding("binary");
    upgraded.on("data", (chunk: string) => { this.buffer += chunk; this.drain(); });
    upgraded.on("error", (e: Error) => this.fail(new SmtpError("TLS 连接错误：" + (e as any).message)));
    upgraded.on("close", () => { this.closed = true; this.fail(new SmtpError("连接被对端关闭")); });
    upgraded.setTimeout(Math.max(1000, this.deadline - Date.now()), () => this.fail(new SmtpError("超时（" + SMTP_TIMEOUT_MS / 1000 + "s）")));
  }

  end() {
    try { this.socket.end(); } catch { /* 忽略 */ }
    this.closed = true;
  }
}

function checkReply(stage: string, reply: string[]): void {
  const code = parseInt((reply[0] || "").slice(0, 3), 10);
  if (!(code >= 200 && code < 400)) {
    throw new SmtpError(stage + " 失败 " + (reply[0] || "").trim().slice(0, 120), String(code || ""));
  }
}

/**
 * 发送一封邮件（一次连接，多收件人逐个 RCPT）。
 * 返回 messageId（服务器未回 id 时用本地生成的）。
 */
export async function sendMail(cfg: SmtpConfig, mail: OutgoingMail): Promise<{ messageId: string }> {
  const secure = cfg.secure || cfg.port === 465; // 方案：secure:false && port:465 自动纠正
  const deadline = Date.now() + SMTP_TIMEOUT_MS;
  const messageId = mail.messageId || `<${Date.now()}.${Math.random().toString(36).slice(2, 10)}@${hostname()}>`;
  const full: OutgoingMail = { ...mail, messageId, date: new Date() };
  const payload = buildMime(full);

  const socket: any = await new Promise((resolve, reject) => {
    const s = secure
      ? (tls as any).connect({ host: cfg.host, port: cfg.port, servername: cfg.host, rejectUnauthorized: false })
      : net.connect({ host: cfg.host, port: cfg.port });
    const onErr = (e: Error) => { s.destroy(); reject(new SmtpError("连接 " + cfg.host + ":" + cfg.port + " 失败：" + (e as any).message)); };
    s.once("error", onErr);
    s.once(secure ? "secureConnect" : "connect", () => { s.removeListener("error", onErr); resolve(s); });
  });

  const conn = new SmtpConn(socket, deadline);
  try {
    checkReply("问候", await conn.readReply()); // 220 banner

    const ehlo = async () => {
      conn.write("EHLO " + hostname());
      const r = await conn.readReply();
      checkReply("EHLO", r);
      return r.join("\n").toUpperCase();
    };
    let caps = await ehlo();

    if (!secure && !cfg.noStarttls && /STARTTLS/.test(caps)) {
      conn.write("STARTTLS");
      checkReply("STARTTLS", await conn.readReply());
      await conn.starttls(cfg.host);
      caps = await ehlo(); // TLS 后必须重新 EHLO
    }

    if (cfg.user) {
      const line = Buffer.from("\0" + cfg.user + "\0" + (cfg.pass || ""), "utf8").toString("base64");
      if (/AUTH[^\n]*\bPLAIN\b/.test(caps)) {
        conn.write("AUTH PLAIN " + line);
        checkReply("AUTH PLAIN", await conn.readReply());
      } else if (/AUTH/.test(caps)) {
        // LOGIN 兜底
        conn.write("AUTH LOGIN");
        checkReply("AUTH LOGIN 用户名", await conn.readReply()); // 334 VXNlcm5hbWU6
        conn.write(Buffer.from(cfg.user, "utf8").toString("base64"));
        checkReply("AUTH LOGIN 密码", await conn.readReply()); // 334 UGFzc3dvcmQ6
        conn.write(Buffer.from(cfg.pass || "", "utf8").toString("base64"));
        checkReply("AUTH LOGIN", await conn.readReply());
      } else {
        throw new SmtpError("服务器不支持 AUTH（PLAIN/LOGIN 均未 advertised）");
      }
    }

    const from = mail.from;
    conn.write("MAIL FROM:<" + from + ">");
    checkReply("MAIL FROM", await conn.readReply());
    for (const rcpt of mail.to) {
      conn.write("RCPT TO:<" + rcpt + ">");
      checkReply("RCPT TO " + rcpt, await conn.readReply());
    }
    conn.write("DATA");
    checkReply("DATA", await conn.readReply()); // 354
    conn.write(dotStuff(payload) + "\r\n.");
    const dotReply = await conn.readReply();
    checkReply("投递", dotReply); // 250

    conn.write("QUIT");
    try { await conn.readReply(); } catch { /* 服务器先关也算成功 */ }
    conn.end();
    return { messageId };
  } catch (e: any) {
    try { conn.end(); } catch { /* 忽略 */ }
    throw e instanceof SmtpError ? e : new SmtpError(String(e?.message || e));
  }
}
