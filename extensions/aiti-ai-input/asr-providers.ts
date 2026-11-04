import { createHmac } from "node:crypto";

/**
 * ASR 引擎（provider）层 —— docs/aiti-ai-input-asr-provider-plan.md
 *
 * 一句话：把「语音识别服务器」从「自建 8767 单选」改成「引擎可插拔」。
 * 引擎的唯一契约 = 「一段音频 → 文本」+ 能力声明（真流式/热词/2-pass）；
 * 客户端链路（VAD 伪实时分句 → 松手整段精修）不感知引擎，只按能力降级。
 *
 * - builtin：自建 8767（voice-asr-stream.py / GLM 服务），真流式 + 模型级热词 + 2-pass。
 * - siliconflow / baidu / xfyun：云 API（非流式），quick/final 同一实现，体验走现有 VAD 伪实时分句链。
 *
 * 本模块是纯逻辑（不碰 fs / 不读 feature）：配置由 index.ts 读出后传入，便于单测与复用。
 */

export type AsrMode = "quick" | "final";

export interface AsrProviderField {
  key: string;
  label: string;
  secret?: boolean;      // 敏感字段：读配置时脱敏（只回 configured + 尾 4 位）
  placeholder?: string;
}

export interface AsrTranscribeArgs {
  raw: ArrayBuffer | Uint8Array; // 请求体（multipart，音频字段名 audio）；/asr/test 会直接构造
  contentType: string;           // 原始 content-type（含 boundary，builtin 原样透传用）
  mode: AsrMode;                 // quick = VAD 分句每句；final = 松手整段精修
  base: string;                  // builtin 用：8767 基址（AITI_ASR_STREAM_BASE）
  ws?: string;                   // builtin 用：workspace 热词 key
  pcfg: Record<string, unknown>; // 该引擎自己的配置（apiKey/model…）
  hotwords?: string[];           // 请求级热词注入（讯飞实测被拒，当前无云引擎用；builtin 走 8767 推送）
  timeoutMs: number;             // WS 类引擎（讯飞）没有 AbortSignal 可用，需自带超时
  signal?: AbortSignal;
}

export type AsrTranscribeResult =
  | { ok: true; text: string; data?: unknown }   // data = 上游原始响应（builtin 原样回传，保证行为不变）
  | { ok: false; error: string; status?: number; hint?: string };

export interface AsrProviderSpec {
  id: string;
  label: string;
  capabilities: { stream: boolean; hotwords: boolean; pass2: boolean };
  fields: AsrProviderField[];
  timeout: Record<AsrMode, number>;
  ready(pcfg: Record<string, unknown>): boolean;
  transcribe(args: AsrTranscribeArgs): Promise<AsrTranscribeResult>;
}

// ---------------------------------------------------------------- builtin（自建 8767）

const builtin: AsrProviderSpec = {
  id: "builtin",
  label: "自建服务 8767（FunASR / Qwen3 / GLM）",
  capabilities: { stream: true, hotwords: true, pass2: true },
  fields: [],
  timeout: { quick: 10_000, final: 15_000 },
  ready: () => true,
  async transcribe({ raw, contentType, mode, base, ws, signal }) {
    const path = mode === "final" ? "/voice/transcribe" : "/voice/quick";
    const hs: Record<string, string> = contentType ? { "content-type": contentType } : {};
    if (ws) hs["x-aiti-ws"] = ws;   // 8767 按此取对应 workspace 热词
    const res = await fetch(`${base}${path}`, { method: "POST", headers: hs, body: raw, signal });
    const data = await res.json().catch(() => null) as { text?: unknown; error?: unknown } | null;
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        error: String(data?.error || (mode === "final" ? "asr2-failed" : "quick-failed")),
      };
    }
    return { ok: true, text: String(data?.text ?? ""), data };
  },
};

// ---------------------------------------------------------------- siliconflow（硅基流动）

const SILICONFLOW_URL = "https://api.siliconflow.cn/v1/audio/transcriptions";
const SF_DEFAULT_MODEL = "FunAudioLLM/SenseVoiceSmall";

/** 从客户端 multipart 里取出音频段（字段名 audio，兼容 file / 任意首个文件段）。 */
async function extractAudio(raw: ArrayBuffer, contentType: string): Promise<{ blob: Blob; name: string } | null> {
  try {
    const req = new Request("http://asr.local/upload", {
      method: "POST",
      headers: contentType ? { "content-type": contentType } : {},
      body: raw,
    });
    const form = await req.formData();
    const pick = (v: FormDataEntryValue | null): { blob: Blob; name: string } | null => {
      if (!v || typeof v === "string") return null;
      return { blob: v as Blob, name: (v as File).name || "voice.wav" };
    };
    const hit = pick(form.get("audio")) || pick(form.get("file"));
    if (hit) return hit;
    for (const [, v] of form) { const any = pick(v); if (any) return any; }
  } catch { /* 解析失败 → 上层报 missing-audio */ }
  return null;
}

/**
 * 手写 multipart/form-data 报文。
 * ⚠ 不能直接用 FormData 当 fetch body：扩展宿主里的 fetch 不序列化 FormData
 * （实测发出去是 "[object FormData]" + content-type: text/plain，上游 400）——
 * 二进制 body（Uint8Array）才是宿主 fetch 可靠支持的形态。
 */
export function encodeMultipart(parts: Array<{ name: string; value: string | Uint8Array; filename?: string; type?: string }>): { body: Uint8Array; contentType: string } {
  const boundary = `----aitiAsrForm${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const push = (s: string) => chunks.push(enc.encode(s));
  for (const p of parts) {
    const fname = p.filename ? `; filename="${String(p.filename).replace(/["\r\n]/g, "_")}"` : "";
    push(`--${boundary}\r\nContent-Disposition: form-data; name="${p.name}"${fname}\r\n`);
    if (p.filename) push(`Content-Type: ${p.type || "application/octet-stream"}\r\n`);
    push("\r\n");
    if (typeof p.value === "string") push(p.value); else chunks.push(p.value);
    push("\r\n");
  }
  push(`--${boundary}--\r\n`);
  const body = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let off = 0;
  for (const c of chunks) { body.set(c, off); off += c.length; }
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}

/** 上游错误 → 中文提示（实测/官方错误码：30001 余额、20012 模型名、429 限流、401 key）。 */
function sfError(status: number, data: unknown): { error: string; status: number; hint?: string } {
  const d = data as { error?: { message?: unknown; code?: unknown } | string; message?: unknown; code?: unknown } | null;
  const msg = typeof d?.error === "object" ? String(d.error?.message ?? "")
    : typeof d?.error === "string" ? d.error
      : String(d?.message ?? "");
  const code = Number((typeof d?.error === "object" ? d?.error?.code : undefined) ?? d?.code ?? NaN);
  const error = msg ? `siliconflow: ${msg}` : `siliconflow-http-${status}`;
  let hint: string | undefined;
  if (status === 401) hint = "API Key 无效或已过期（到 cloud.siliconflow.cn 检查）";
  else if (code === 30001 || status === 402) hint = "账户余额不足，请充值后重试";
  else if (code === 20012) hint = "模型名无效（默认 FunAudioLLM/SenseVoiceSmall）";
  else if (status === 429) hint = "触发限流，稍后重试";
  return { error, status, hint };
}

const siliconflow: AsrProviderSpec = {
  id: "siliconflow",
  label: "硅基流动（云 API · SenseVoiceSmall）",
  capabilities: { stream: false, hotwords: false, pass2: false },
  fields: [
    { key: "apiKey", label: "API Key（sk-…）", secret: true, placeholder: "sk-..." },
    { key: "model", label: "模型", placeholder: SF_DEFAULT_MODEL },
    // 端点可覆盖：自建/代理的 OpenAI 兼容 /audio/transcriptions 也能用（留空 = 官方端点）
    { key: "baseUrl", label: "端点（可选）", placeholder: SILICONFLOW_URL },
  ],
  // 实测：硅基流动 ASR 排队严重（1~4s 音频 27~82s 出结果），超时给到 60s 仍可能不够——
  // 仅适合「本地 8767 不可用」时的兜底，交互链路请优先讯飞/百度。
  timeout: { quick: 60_000, final: 60_000 },
  ready: (pcfg) => String(pcfg.apiKey || "").trim().length > 0,
  async transcribe({ raw, contentType, pcfg, signal }) {
    const key = String(pcfg.apiKey || "").trim();
    if (!key) return { ok: false, error: "siliconflow-not-configured", hint: "未配置 API Key（POST /asr/config 写入）" };
    const audio = await extractAudio(raw, contentType);
    if (!audio) return { ok: false, error: "missing-audio", hint: "请求体需含 audio 音频段" };
    const mp = encodeMultipart([
      { name: "model", value: String(pcfg.model || SF_DEFAULT_MODEL) },
      { name: "file", filename: audio.name, type: audio.blob.type || "audio/wav", value: new Uint8Array(await audio.blob.arrayBuffer()) },
    ]);
    let res: Response;
    try {
      res = await fetch(String(pcfg.baseUrl || SILICONFLOW_URL), {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": mp.contentType },
        body: mp.body,
        signal,
      });
    } catch (e) {
      return { ok: false, error: `siliconflow-request-failed: ${String((e as Error)?.message || e)}`, hint: "请求未到达上游（网络/超时/代理）" };
    }
    const data = await res.json().catch(() => null);
    if (!res.ok) return { ok: false, ...sfError(res.status, data) };
    const text = String((data as { text?: unknown } | null)?.text ?? "").trim();
    return { ok: true, text, data: { ok: true, text } };
  },
};

// ---------------------------------------------------------------- Azure AI 语音（短语音识别 REST）

const azure: AsrProviderSpec = {
  id: "azure",
  label: "Azure AI 语音（短语音识别 · F0 每月 5 小时免费）",
  capabilities: { stream: false, hotwords: false, pass2: false },
  fields: [
    { key: "subscriptionKey", label: "密钥 Key1", secret: true },
    { key: "region", label: "区域（如 eastasia）", placeholder: "eastasia" },
    { key: "language", label: "语言", placeholder: "zh-CN" },
  ],
  timeout: { quick: 20_000, final: 30_000 },
  ready: (pcfg) => !!String(pcfg.subscriptionKey || "").trim() && !!String(pcfg.region || "").trim(),
  async transcribe({ raw, contentType, pcfg, signal }) {
    const key = String(pcfg.subscriptionKey || "").trim();
    const region = String(pcfg.region || "").trim();
    const lang = String(pcfg.language || "zh-CN").trim() || "zh-CN";
    if (!key || !region) return { ok: false, error: "azure-not-configured", hint: "未配置密钥/区域（POST /asr/config）" };
    const audio = await extractAudio(raw, contentType);
    if (!audio) return { ok: false, error: "missing-audio", hint: "请求体需含 audio 音频段" };
    const bytes = await audioBytes(audio.blob);
    // 短语音识别（一次性）：body 直接是音频字节，不是 multipart
    const url = `https://${region}.stc.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1?language=${encodeURIComponent(lang)}&format=detailed`;
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: {
          "Ocp-Apim-Subscription-Key": key,
          "content-type": "audio/wav; codecs=audio/pcm; samplerate=16000",
          accept: "application/json",
        },
        body: bytes,
        signal,
      });
    } catch (e) {
      return { ok: false, error: `azure-request-failed: ${String((e as Error)?.message || e)}`, hint: "请求未到达 Azure（区域/网络/超时）" };
    }
    const d = await res.json().catch(() => null) as { RecognitionStatus?: string; DisplayText?: string; NBest?: Array<{ Display?: string }> } | null;
    if (!res.ok) {
      return {
        ok: false,
        error: `azure: ${d?.RecognitionStatus || res.status}`,
        status: res.status,
        hint: res.status === 401 ? "密钥无效（复制 Key1）" : res.status === 404 ? "区域写错了（如 eastasia / southeastasia）" : undefined,
      };
    }
    if ((d?.RecognitionStatus || "") !== "Success") {
      return {
        ok: false,
        error: `azure: ${d?.RecognitionStatus || "NoMatch"}`,
        hint: d?.RecognitionStatus === "NoMatch" ? "没听清（静音/噪音/语言不匹配）" : undefined,
      };
    }
    const text = String(d?.DisplayText || d?.NBest?.[0]?.Display || "").trim();
    return { ok: true, text, data: { ok: true, text } };
  },
};

// ---------------------------------------------------------------- OpenAI 兼容端点（自建 / 代理 / 其它云）

const openai: AsrProviderSpec = {
  id: "openai",
  label: "OpenAI 兼容端点（自建 / 代理 / 其它云）",
  capabilities: { stream: false, hotwords: false, pass2: false },
  fields: [
    { key: "baseUrl", label: "端点（…/v1 或完整 …/audio/transcriptions）", placeholder: "http://127.0.0.1:8000/v1" },
    { key: "apiKey", label: "API Key（本地服务可留空）", secret: true },
    { key: "model", label: "模型", placeholder: "whisper-1" },
  ],
  // 端点可能是本机（快）也可能是第三方云（慢），超时给到 30/45s
  timeout: { quick: 30_000, final: 45_000 },
  ready: (pcfg) => !!String(pcfg.baseUrl || "").trim(),
  async transcribe({ raw, contentType, pcfg, signal }) {
    const base = String(pcfg.baseUrl || "").trim();
    if (!base) return { ok: false, error: "openai-not-configured", hint: "未配置端点 baseUrl（POST /asr/config）" };
    const audio = await extractAudio(raw, contentType);
    if (!audio) return { ok: false, error: "missing-audio", hint: "请求体需含 audio 音频段" };
    // 端点容错：只填到 /v1 时自动补 OpenAI 标准转写路径
    const url = /\/audio\/transcriptions(\?|$)/.test(base) ? base : base.replace(/\/+$/, "") + "/audio/transcriptions";
    const mp = encodeMultipart([
      { name: "model", value: String(pcfg.model || "whisper-1") },
      { name: "file", filename: audio.name, type: audio.blob.type || "audio/wav", value: new Uint8Array(await audio.blob.arrayBuffer()) },
    ]);
    const headers: Record<string, string> = { "content-type": mp.contentType };
    const key = String(pcfg.apiKey || "").trim();
    if (key) headers.authorization = `Bearer ${key}`;
    let res: Response;
    try {
      res = await fetch(url, { method: "POST", headers, body: mp.body, signal });
    } catch (e) {
      return { ok: false, error: `openai-request-failed: ${String((e as Error)?.message || e)}`, hint: "请求未到达端点（地址/网络/超时）" };
    }
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      const msg = String((data as { error?: { message?: unknown } | string; message?: unknown } | null)?.error
        && typeof (data as { error: { message?: unknown } }).error === "object"
        ? (data as { error: { message?: unknown } }).error.message ?? ""
        : (data as { message?: unknown } | null)?.message ?? "");
      return {
        ok: false,
        error: `openai: ${msg || res.status}`,
        status: res.status,
        hint: res.status === 401 ? "API Key 无效" : res.status === 404 ? "端点路径不对（应为 …/audio/transcriptions）" : undefined,
      };
    }
    const text = String((data as { text?: unknown } | null)?.text ?? "").trim();
    return { ok: true, text, data: { ok: true, text } };
  },
};

// ---------------------------------------------------------------- 音频工具

/** 读音频段字节（multipart 里的 File → Uint8Array） */
async function audioBytes(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer());
}

/** 去掉 WAV 头 → raw PCM16（讯飞要 raw L16；本来就是裸流则原样返回） */
function stripWav(bytes: Uint8Array): Uint8Array {
  const isRiff = bytes.length > 44 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46;
  if (!isRiff) return bytes;
  for (let i = 12; i + 8 <= Math.min(bytes.length, 4096); i++) {
    if (bytes[i] === 0x64 && bytes[i + 1] === 0x61 && bytes[i + 2] === 0x74 && bytes[i + 3] === 0x61) { // "data"
      const size = bytes[i + 4] | (bytes[i + 5] << 8) | (bytes[i + 6] << 16) | (bytes[i + 7] << 24);
      return bytes.subarray(i + 8, i + 8 + size);
    }
  }
  return bytes.subarray(44);
}

// ---------------------------------------------------------------- 百度智能云（短语音识别 REST）

const BAIDU_TOKEN_URL = "https://aip.baidubce.com/oauth/2.0/token";
const BAIDU_API = "https://vop.baidu.com/server_api";
// 极速版（dev_pid 80001）是独立端点：打到 server_api 会报 3302 / 6: No permission to access data
const BAIDU_PRO_API = "https://vop.baidu.com/pro_api";
const BAIDU_HINTS: Record<number, string> = {
  3301: "音频质量差（需 16k/16bit 单声道 wav，或环境噪音大）",
  3302: "鉴权失败（API Key / Secret Key 不对，或应用未开通语音识别）",
  3305: "超出免费额度/QPS（到控制台「语音技术」领取免费额度包）",
  3310: "QPS 超限（降低请求频率）",
  216201: "请求频率超限",
};
let baiduTokenCache: { ak: string; token: string; exp: number } | null = null;

/** access_token（30 天有效，进程内缓存，到期前 60s 刷新） */
async function baiduAccessToken(ak: string, sk: string, signal?: AbortSignal): Promise<string> {
  const now = Date.now();
  if (baiduTokenCache && baiduTokenCache.ak === ak && baiduTokenCache.exp - now > 60_000) return baiduTokenCache.token;
  const res = await fetch(`${BAIDU_TOKEN_URL}?grant_type=client_credentials&client_id=${encodeURIComponent(ak)}&client_secret=${encodeURIComponent(sk)}`, { method: "POST", signal });
  const d = await res.json().catch(() => null) as { access_token?: string; expires_in?: number; error_description?: string } | null;
  if (!res.ok || !d?.access_token) throw new Error(d?.error_description || `baidu-token-${res.status}`);
  baiduTokenCache = { ak, token: d.access_token, exp: now + Number(d.expires_in || 2_592_000) * 1000 };
  return d.access_token;
}

const baidu: AsrProviderSpec = {
  id: "baidu",
  label: "百度智能云（短语音识别 · 普通话）",
  capabilities: { stream: false, hotwords: false, pass2: false },
  fields: [
    { key: "apiKey", label: "API Key（控制台）", secret: true, placeholder: "0oMh…" },
    { key: "secretKey", label: "Secret Key", secret: true, placeholder: "CIbv…" },
    { key: "devPid", label: "dev_pid（1537 普通话 / 80001 极速版）", placeholder: "1537" },
  ],
  timeout: { quick: 10_000, final: 15_000 },
  ready: (pcfg) => !!String(pcfg.apiKey || "").trim() && !!String(pcfg.secretKey || "").trim(),
  async transcribe({ raw, contentType, pcfg, signal }) {
    const ak = String(pcfg.apiKey || "").trim();
    const sk = String(pcfg.secretKey || "").trim();
    if (!ak || !sk) return { ok: false, error: "baidu-not-configured", hint: "未配置 API Key / Secret Key（POST /asr/config）" };
    const audio = await extractAudio(raw, contentType);
    if (!audio) return { ok: false, error: "missing-audio", hint: "请求体需含 audio 音频段" };
    const bytes = await audioBytes(audio.blob);
    let token: string;
    try {
      token = await baiduAccessToken(ak, sk, signal);
    } catch (e) {
      return { ok: false, error: `baidu-token-failed: ${String((e as Error)?.message || e)}`, hint: "检查 API Key / Secret Key" };
    }
    const devPid = Number(pcfg.devPid || 1537) || 1537;
    const res = await fetch(devPid === 80001 ? BAIDU_PRO_API : BAIDU_API, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        format: "wav", rate: 16000, channel: 1, cuid: "aiti-ai-input",
        token, dev_pid: devPid,
        speech: Buffer.from(bytes).toString("base64"), len: bytes.length,
      }),
      signal,
    });
    const d = await res.json().catch(() => null) as { err_no?: number; err_msg?: string; result?: string[] } | null;
    const errNo = Number(d?.err_no ?? 0);
    if (errNo !== 0) {
      return { ok: false, error: `baidu: ${d?.err_msg || errNo}`, status: errNo, hint: BAIDU_HINTS[errNo] };
    }
    const text = (d?.result || []).join("").trim();
    return { ok: true, text, data: { ok: true, text } };
  },
};

// ---------------------------------------------------------------- 讯飞（iat 听写，WSS 一次性提交）

const XF_HOST = "iat-api.xfyun.cn";
const XF_HINTS: Record<number, string> = {
  10043: "音频过大（单句 ≤60s）",
  10105: "APPID 非法（或应用未开通语音听写）",
  10163: "参数/鉴权错误（检查 APIKey / APISecret 与系统时间）",
  11200: "超出每日限额",
  11201: "日限熔断（次日恢复）",
};

/** 一次性听写：建一条 WSS → 分帧送完整音频（status 0/1）→ 尾帧 status 2 → 收结果。 */
async function xfyunOnce(o: {
  appId: string; apiKey: string; apiSecret: string; pcm: Uint8Array; timeoutMs: number;
}): Promise<{ text?: string; code?: number; message?: string }> {
  const WS = (globalThis as { WebSocket?: unknown }).WebSocket;
  if (typeof WS !== "function") return { code: -1, message: "宿主无全局 WebSocket（需 Node 22+）" };
  const date = new Date().toUTCString();
  const sig = createHmac("sha256", o.apiSecret)
    .update(`host: ${XF_HOST}\ndate: ${date}\nGET /v2/iat HTTP/1.1`).digest("base64");
  const auth = Buffer.from(`api_key="${o.apiKey}", algorithm="hmac-sha256", headers="host date request-line", signature="${sig}"`).toString("base64");
  const url = `wss://${XF_HOST}/v2/iat?authorization=${encodeURIComponent(auth)}&date=${encodeURIComponent(date)}&host=${encodeURIComponent(XF_HOST)}`;
  // ⚠ 不传 business.hotword：实测该字段被服务端拒（10163 unknown field）——
  //   讯飞 iat 的热词走控制台「用户词表」上传，识别时按 appid 生效，不能按请求注入。
  const business: Record<string, unknown> = { language: "zh_cn", domain: "iat", accent: "mandarin", vad_eos: 10000 };
  return await new Promise((resolve) => {
    let ws: WebSocket | null = null;
    let out = "";
    let settled = false;
    const finish = (r: { text?: string; code?: number; message?: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws?.close(); } catch { /* 已关 */ }
      resolve(r);
    };
    const timer = setTimeout(() => finish({ code: -2, message: `讯飞识别超时（${o.timeoutMs}ms）` }), o.timeoutMs);
    try {
      ws = new (WS as typeof WebSocket)(url);
    } catch (e) {
      finish({ code: -3, message: String((e as Error)?.message || e) });
      return;
    }
    ws.onopen = () => {
      const send = (status: number, audioB64: string) => ws?.send(JSON.stringify({
        common: { app_id: o.appId },
        business,
        data: { status, format: "audio/L16;rate=16000", encoding: "raw", audio: audioB64 },
      }));
      const CH = 1280 * 5; // 40ms/帧 × 5
      let off = 0, first = true;
      while (off < o.pcm.length) {
        send(first ? 0 : 1, Buffer.from(o.pcm.subarray(off, off + CH)).toString("base64"));
        first = false;
        off += CH;
      }
      send(2, "");
    };
    ws.onmessage = (ev: MessageEvent) => {
      let m: { code?: number; message?: string; data?: { status?: number; result?: { ws?: Array<{ cw?: Array<{ w?: string }> }> } } };
      try { m = JSON.parse(String(ev.data)); } catch { return; }
      if (m.code !== 0) { finish({ code: m.code, message: m.message }); return; }
      out += (m.data?.result?.ws || []).map((w) => (w.cw || []).map((c) => c.w || "").join("")).join("");
      if (m.data?.status === 2) finish({ text: out.trim() });
    };
    ws.onerror = () => finish({ code: -4, message: "WebSocket 连接错误（网络/鉴权）" });
    ws.onclose = () => finish({ code: -5, message: "连接被关闭（未收到结果）" });
  });
}

const xfyun: AsrProviderSpec = {
  id: "xfyun",
  label: "讯飞开放平台（听写 iat · 真流式 + 一次性提交兜底）",
  capabilities: { stream: false, hotwords: false, pass2: false }, // 热词只能控制台上传用户词表，不支持请求级注入
  fields: [
    { key: "appId", label: "APPID", placeholder: "2061196f" },
    { key: "apiKey", label: "APIKey", secret: true },
    { key: "apiSecret", label: "APISecret", secret: true },
  ],
  timeout: { quick: 12_000, final: 15_000 },
  ready: (pcfg) => !!String(pcfg.appId || "").trim() && !!String(pcfg.apiKey || "").trim() && !!String(pcfg.apiSecret || "").trim(),
  async transcribe({ raw, contentType, pcfg, timeoutMs }) {
    const appId = String(pcfg.appId || "").trim();
    const apiKey = String(pcfg.apiKey || "").trim();
    const apiSecret = String(pcfg.apiSecret || "").trim();
    if (!appId || !apiKey || !apiSecret) return { ok: false, error: "xfyun-not-configured", hint: "未配置 APPID / APIKey / APISecret" };
    const audio = await extractAudio(raw, contentType);
    if (!audio) return { ok: false, error: "missing-audio", hint: "请求体需含 audio 音频段" };
    const pcm = stripWav(await audioBytes(audio.blob));
    const r = await xfyunOnce({ appId, apiKey, apiSecret, pcm, timeoutMs });
    if (r.text === undefined) {
      return { ok: false, error: `xfyun: ${r.message || r.code}`, status: r.code, hint: XF_HINTS[Number(r.code)] };
    }
    return { ok: true, text: r.text, data: { ok: true, text: r.text } };
  },
};

// ---------------------------------------------------------------- 注册表与配置读写（纯函数）

export const ASR_PROVIDERS: AsrProviderSpec[] = [builtin, xfyun, baidu, siliconflow, openai, azure];
export const ASR_PROVIDER_DEFAULT = "builtin";

export function asrProviderSpec(id: string): AsrProviderSpec {
  return ASR_PROVIDERS.find((p) => p.id === id) ?? ASR_PROVIDERS[0];
}

/** 当前引擎 id（配置缺失/非法 → builtin，保证旧配置行为不变）。 */
export function asrProviderId(cfg: Record<string, unknown>): string {
  const raw = String(cfg?.provider || "").trim();
  return ASR_PROVIDERS.some((p) => p.id === raw) ? raw : ASR_PROVIDER_DEFAULT;
}

/** 某引擎的私有配置节（cfg.providers[id]）。 */
export function asrProviderCfg(cfg: Record<string, unknown>, id: string): Record<string, unknown> {
  const all = cfg?.providers;
  const p = all && typeof all === "object" && !Array.isArray(all) ? (all as Record<string, unknown>)[id] : null;
  return p && typeof p === "object" && !Array.isArray(p) ? p as Record<string, unknown> : {};
}

/** 当前引擎是否可用（云引擎 = key 已配）。 */
export function asrProviderReady(cfg: Record<string, unknown>, id?: string): boolean {
  const pid = id || asrProviderId(cfg);
  return asrProviderSpec(pid).ready(asrProviderCfg(cfg, pid));
}

/** 脱敏后的引擎总览（/asr/config 与 /features 共用；key 绝不回传前端）。 */
export function asrProviderView(cfg: Record<string, unknown>): {
  provider: string;
  providerReady: boolean;
  providers: Array<{
    id: string; label: string; capabilities: { stream: boolean; hotwords: boolean; pass2: boolean };
    ready: boolean; params: Record<string, { configured: boolean; tail?: string; value?: string }>;
    fields: AsrProviderField[];   // 字段元信息（前端动态表单；key 值不回传，只在 params 里给 configured/tail）
  }>;
} {
  const provider = asrProviderId(cfg);
  return {
    provider,
    providerReady: asrProviderReady(cfg, provider),
    providers: ASR_PROVIDERS.map((p) => {
      const pcfg = asrProviderCfg(cfg, p.id);
      const params: Record<string, { configured: boolean; tail?: string; value?: string }> = {};
      for (const f of p.fields) {
        const raw = String(pcfg[f.key] ?? "").trim();
        params[f.key] = f.secret
          ? (raw ? { configured: true, tail: raw.slice(-4) } : { configured: false })
          : { configured: raw.length > 0, value: raw };
      }
      return { id: p.id, label: p.label, capabilities: p.capabilities, ready: p.ready(pcfg), params, fields: p.fields };
    }),
  };
}

/** 合并引擎配置（白名单：只认各 spec.fields 声明的键；空串 = 删除该项）。 */
export function asrMergeProviderCfg(
  cfg: Record<string, unknown>,
  body: Record<string, unknown>,
): { cfg: Record<string, unknown>; error?: string } {
  const next: Record<string, unknown> = { ...cfg };
  if (typeof body.provider === "string") {
    const pid = body.provider.trim();
    if (!ASR_PROVIDERS.some((p) => p.id === pid)) {
      return { cfg, error: `provider 必须是：${ASR_PROVIDERS.map((p) => p.id).join(" | ")}` };
    }
    next.provider = pid;
  }
  const incoming = body.providers;
  if (incoming && typeof incoming === "object" && !Array.isArray(incoming)) {
    const prevAll = next.providers && typeof next.providers === "object" && !Array.isArray(next.providers)
      ? next.providers as Record<string, unknown> : {};
    const providers: Record<string, unknown> = { ...prevAll };
    for (const spec of ASR_PROVIDERS) {
      const inc = (incoming as Record<string, unknown>)[spec.id];
      if (!inc || typeof inc !== "object" || Array.isArray(inc)) continue;
      const curPrev = providers[spec.id];
      const cur: Record<string, unknown> = curPrev && typeof curPrev === "object" && !Array.isArray(curPrev)
        ? { ...(curPrev as Record<string, unknown>) } : {};
      for (const f of spec.fields) {
        const v = (inc as Record<string, unknown>)[f.key];
        if (typeof v !== "string") continue;
        const sv = v.trim();
        if (!sv) delete cur[f.key]; else cur[f.key] = sv;
      }
      providers[spec.id] = cur;
    }
    next.providers = providers;
  }
  return { cfg: next };
}
