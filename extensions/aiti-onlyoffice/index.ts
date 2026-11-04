/**
 * aiti-onlyoffice · OnlyOffice DocumentServer 集成（M2 深度保真档，docs/aiti-editor-office-plan.md §2.4）。
 *
 * 链路（Document Server integration API，非 WOPI）：
 *   1. server 生成 config：document.url（/download，HMAC token）+ editorConfig.callbackUrl
 *      （/callback，HMAC token）+ key=hash(path+mtime) → JWT(HS256) 签名 → client
 *   2. client 动态加载 <dsPublicUrl>/web-apps/apps/api/documents/api.js → DocsAPI.DocEditor iframe
 *   3. 保存：DS callback POST（status=2/6 + url）→ server 拉内容 → 原子写盘 → { error: 0 }
 *   4. mtime 变 → key 变 → DS 重拉（live 刷新天然成立）
 *
 * 安全：download/callback URL 带一次性 HMAC token（path+expiry 签名）防穿越/盗链；
 * JWT secret 存 configDir/jwt-secret（不入仓，scripts/onlyoffice-up.sh 读同一份给容器）。
 * provider 注册由 client 在 /status 探测通过后进行（healthcheck 失败 → 菜单自然无此项）。
 */
import { createHmac, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolveAllowedWriteRoot } from "./blob-save-route";
import { hmacToken, verifyToken, documentTypeOf } from "./token";

// ── feature 读取（服务端 ctx.features.get：boolean feature → boolean；string feature → string）──
function featureBool(ctx: any, id: string, dflt: boolean): boolean {
  try {
    const v = ctx.features?.get?.(id);
    if (typeof v === "boolean") return v;
  } catch { /* 缺席默认 */ }
  return dflt;
}
function featureString(ctx: any, id: string, dflt: string): string {
  try {
    const v = ctx.features?.get?.(id);
    if (typeof v === "string" && v.trim()) return v.trim();
  } catch { /* 缺席默认 */ }
  return dflt;
}

// ── JWT secret（configDir/jwt-secret，自动生成；容器侧由 onlyoffice-up.sh 读同一份）──
function loadSecret(configDir: string | undefined): string {
  if (!configDir) return "aiti-onlyoffice-insecure-dev-secret";
  const p = join(configDir, "jwt-secret");
  try { return readFileSync(p, "utf8").trim(); } catch { /* 首次生成 */ }
  const secret = randomBytes(32).toString("hex");
  try { mkdirSync(configDir, { recursive: true }); writeFileSync(p, secret, { mode: 0o600 }); } catch { /* 忽略 */ }
  return secret;
}

// ── JWT HS256（零依赖，node:crypto）──
const b64url = (buf: Buffer | string): string => Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
function jwtSign(payload: object, secret: string): string {
  const h = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const p = b64url(JSON.stringify(payload));
  const sig = b64url(createHmac("sha256", secret).update(h + "." + p).digest());
  return h + "." + p + "." + sig;
}

const ALLOWED_EXTS = [".docx", ".xlsx", ".xlsm", ".pptx", ".doc", ".ppt", ".odt", ".odp", ".ods"]; // 保存白名单（DS 回存保持原格式，含老格式）

// ── healthcheck 缓存（30s，按需探测非轮询）──
let _hc: { at: number; ok: boolean } | null = null;
async function healthcheck(url: string): Promise<boolean> {
  if (_hc && Date.now() - _hc.at < 30000) return _hc.ok;
  let ok = false;
  try {
    const r = await fetch(url.replace(/\/$/, "") + "/healthcheck", { signal: AbortSignal.timeout(3000), cache: "no-store" });
    ok = r.ok && (await r.text()).trim() === "true";
  } catch { ok = false; }
  _hc = { at: Date.now(), ok };
  return ok;
}

// ── 容器回访基址：与网页同 URL（§2.4 部署拓扑，2026-09-07 修正）──
// DS 容器与浏览器访问同一个网页地址（pi.example.com 指向本机、nginx 同域反代、证书有效），
// 因此回访基址 = 浏览器看到的 origin（proto + Host）+ basePath，零推导魔法。
// proto 取 X-Forwarded-Proto（nginx 置 https）；dev 监听 0.0.0.0，经内网 IP 直连的
// origin 同样容器可达。个别特殊拓扑（DS 在别的机器等）用 containerBase feature 覆盖。
function pageOrigin(req: Request): string {
  const xf = req.headers.get("x-forwarded-proto")?.split(",")[0].trim();
  let proto = xf || "";
  if (!proto) {
    try { proto = new URL(req.url).protocol.replace(":", ""); } catch { proto = "http"; }
  }
  return proto + "://" + (req.headers.get("host") || "127.0.0.1");
}

export default {
  id: "aiti-onlyoffice",
  name: "aiti-onlyoffice",
  version: "0.1.0",
  description: "OnlyOffice DocumentServer 深度保真编辑档：.docx/.xlsx/.pptx 预览+编辑（Docker 后端，feature 默认关）",
  client: "dist/aiti-onlyoffice-client.mjs",
  clientImmediately: true,
  icon: "icon.svg",
  features: [
    { id: "onlyoffice.enabled", label: "启用 OnlyOffice", description: "开启后探测 DocumentServer，健康时注册 word/sheet/slide 三 provider（Docker：scripts/onlyoffice-up.sh）", default: false },
    { id: "onlyoffice.url", type: "string", label: "DocumentServer 地址", description: "本机服务端/容器访问的 DS 地址（healthcheck 与文档下载基准）", value: "http://127.0.0.1:8802" },
    { id: "onlyoffice.publicUrl", type: "string", label: "浏览器侧 DS 地址", description: "浏览器加载 api.js 用的 DS 地址；留空跟随「DocumentServer 地址」。nginx /onlyoffice/ 反代场景填 https://…/onlyoffice", value: "", placeholder: "http://127.0.0.1:8802" },
    { id: "onlyoffice.containerBase", type: "string", label: "回调地址", description: "DS 容器回访（download/callback）的基址。默认=网页地址（浏览器访问的 协议+域名+端口，容器与网页同源可达）；仅当容器无法访问网页地址（如 DS 部署在别的机器）时设置覆盖，如 https://pi.example.com:8443", value: "", placeholder: "https://pi.example.com:8443" },
  ],
  server: {
    startup(ctx: any) {
      console.log("[aiti-onlyoffice] 就绪（enabled=" + featureBool(ctx, "onlyoffice.enabled", false) + "）");
    },
    async api(req: Request, ctx: any) {
      const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
      const url = new URL(req.url);
      const p = url.pathname.split("/").filter(Boolean);
      const last = p[p.length - 1];
      const secret = loadSecret(ctx.configDir);
      const dsUrl = featureString(ctx, "onlyoffice.url", "http://127.0.0.1:8802");
      const publicUrl = featureString(ctx, "onlyoffice.publicUrl", "") || dsUrl;

      // GET /status → client 注册判据（feature 开 + healthcheck 通过才注册 provider）
      if (last === "status" && req.method === "GET") {
        const enabled = featureBool(ctx, "onlyoffice.enabled", false);
        const available = enabled ? await healthcheck(dsUrl) : false;
        return json({ ok: true, enabled, available, publicUrl, message: !enabled ? "功能未开启（扩展管理器 → aiti-onlyoffice → 功能）" : !available ? "DocumentServer 不可达（scripts/onlyoffice-up.sh 启动）" : "" });
      }

      // GET /config?filePath=… → JWT 签名的 DocEditor config
      if (last === "config" && req.method === "GET") {
        if (!featureBool(ctx, "onlyoffice.enabled", false)) return json({ ok: false, error: "OnlyOffice 功能未开启" }, 403);
        if (!(await healthcheck(dsUrl))) return json({ ok: false, error: "DocumentServer 不可达" }, 503);
        const filePath = url.searchParams.get("filePath") || "";
        const cwd = url.searchParams.get("cwd") || undefined;
        const target = resolveAllowedWriteRoot(filePath, cwd);
        const docType = documentTypeOf(filePath);
        if (!target) return json({ ok: false, error: "路径不在白名单内" }, 400);
        if (!docType) return json({ ok: false, error: "不支持的文件类型" }, 400);
        let st;
        try { st = statSync(target); } catch { return json({ ok: false, error: "文件不存在" }, 404); }
        const key = createHmac("sha1", secret).update(target + ":" + Math.floor(st.mtimeMs) + ":" + st.size).digest("hex");
        // basePath 前缀（多实例 /dev）：Next 剥掉 basePath 后 handler 才见 req.url，
        // 只能取进程环境 PI_WEB_BASE_PATH（dev 实例 = "/dev"）
        const basePath = (process.env.PI_WEB_BASE_PATH || "").replace(/\/$/, "");
        // 容器回访基址：显式 feature > 推导（IP Host 原样 / loopback → docker0 IP / 兜底 host.docker.internal）
        const explicitBase = featureString(ctx, "onlyoffice.containerBase", "");
        const hostHdr = req.headers.get("host") || "127.0.0.1";
        const containerBase = ((explicitBase || pageOrigin(req)) + basePath).replace(/\/$/, "");
        const payload = {
          documentType: docType,
          document: {
            fileType: (filePath.split(".").pop() || "").toLowerCase(),
            key,
            title: (filePath.split("/").pop() || "document"),
            url: containerBase + "/api/extensions/aiti-onlyoffice/download?t=" + encodeURIComponent(hmacToken(secret, target, 3600_000)),
            permissions: { edit: true, print: true, download: true },
          },
          editorConfig: {
            callbackUrl: containerBase + "/api/extensions/aiti-onlyoffice/callback?t=" + encodeURIComponent(hmacToken(secret, target, 86_400_000)),
            lang: "zh-CN",
            mode: "edit",
            user: { id: "pi-web-local", name: "本地用户" },
            customization: { forcesave: true, autosave: true, compactHeader: true, hideRulers: false },
          },
          type: "desktop",
        };
        return json({ ok: true, config: { ...payload, token: jwtSign(payload, secret) }, dsApiUrl: publicUrl.replace(/\/$/, "") + "/web-apps/apps/api/documents/api.js" });
      }

      // GET /download?t=… → DS 拉文档（HMAC token 校验 + 白名单）
      if (last === "download" && req.method === "GET") {
        const v = verifyToken(secret, url.searchParams.get("t") || "");
        if (!v) return json({ ok: false, error: "token 无效或过期" }, 403);
        const target = resolveAllowedWriteRoot(v.filePath);
        const docType = documentTypeOf(target || "");
        if (!target || !docType) return json({ ok: false, error: "路径不在白名单内" }, 400);
        try {
          const buf = readFileSync(target);
          return new Response(new Uint8Array(buf), { headers: { "content-type": "application/octet-stream", "cache-control": "no-store" } });
        } catch (e) {
          return json({ ok: false, error: "读取失败: " + String((e as Error).message || e) }, 500);
        }
      }

      // POST /callback?t=… → DS 保存回传（status 2/6 带 url → 拉内容原子写盘）
      if (last === "callback" && req.method === "POST") {
        const respond = (body: object) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json", "cache-control": "no-store" } });
        const v = verifyToken(secret, url.searchParams.get("t") || "");
        if (!v) return respond({ error: 1 });
        const target = resolveAllowedWriteRoot(v.filePath);
        if (!target || !ALLOWED_EXTS.some((e) => target.toLowerCase().endsWith(e))) return respond({ error: 1 });
        let body: any;
        try { body = await req.json(); } catch { return respond({ error: 1 }); }
        const payload = body && typeof body === "object" && body.token ? (await (async () => { try { return JSON.parse(Buffer.from(String(body.token).split(".")[1], "base64").toString("utf8")); } catch { return body; } })()) : body;
        const status = payload?.status;
        if (status !== 2 && status !== 6) return respond({ error: 0 }); // 1=编辑中 4=无更改关闭
        const saveUrl = payload?.url;
        if (typeof saveUrl !== "string" || !/^https?:\/\//.test(saveUrl)) return respond({ error: 1 });
        try {
          const r = await fetch(saveUrl, { signal: AbortSignal.timeout(30000) });
          if (!r.ok) return respond({ error: 1 });
          const buf = Buffer.from(await r.arrayBuffer());
          if (buf.length === 0) return respond({ error: 1 });
          const tmp = join(dirname(target), ".aiti-onlyoffice-save-tmp-" + process.pid + "-" + Date.now());
          mkdirSync(dirname(target), { recursive: true });
          writeFileSync(tmp, buf);
          renameSync(tmp, target);
          const after = statSync(target);
          console.log("[aiti-onlyoffice][callback] 已保存 " + target + " (" + after.size + " bytes, status=" + status + ")");
          return respond({ error: 0 });
        } catch (e) {
          console.log("[aiti-onlyoffice][callback] 写盘失败: " + String((e as Error).message || e));
          return respond({ error: 1 });
        }
      }

      return json({ ok: false, error: "not found" }, 404);
    },
  },
};
