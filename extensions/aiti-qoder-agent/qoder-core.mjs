// qoder-core.mjs — Qoder 私有 provider 核心（私人使用，勿外传）
// 从 qoderclicn 二进制中提取的 auth WASM + 官方 glue，实现：
//   1. 解密 ~/.qoder{,-cn}/.auth/user 凭据
//   2. QoderContext 构造 COSY 签名请求（prepareRequest / prepareInferRequest）
//   3. 调用 CN/国际推理端点（agent_chat_generation SSE，信封内为 OpenAI chunk）
// 逆向分析详见 docs/qodercli-auth-api-analysis.md
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ASSETS = join(dirname(fileURLToPath(import.meta.url)), 'assets');

let _g = null; // glue exports（含 QoderContext）

export async function initWasm() {
  if (_g) return _g;
  const glueSrc = readFileSync(join(ASSETS, 'qoder_glue.js'), 'utf8')
    .replaceAll('import.meta.url', '"x://x/qoder_auth_wasm_bg.wasm"');
  const wasmBytes = readFileSync(join(ASSETS, 'qoder_auth.wasm'));

  const sandbox = {
    TextDecoder, TextEncoder, console, Error, Object, Array, Math, Number, String, Symbol,
    Uint8Array, Int32Array, Uint32Array, BigInt64Array, Float64Array, Map, Set, WeakMap, WeakRef,
    FinalizationRegistry, Promise, JSON, Buffer, crypto: globalThis.crypto,
    process: { platform: process.platform, arch: process.arch, versions: { node: process.versions.node }, env: {}, argv: ['node'] },
  };
  sandbox.globalThis = sandbox;
  sandbox.ID = (t, all) => { for (const k in all) Object.defineProperty(t, k, { get: all[k], enumerable: true, configurable: true }); };
  sandbox.N = (init) => { let d = false, r; return () => { if (!d) { d = true; r = init(); } return r; }; };
  vm.createContext(sandbox);

  new vm.Script(glueSrc + '\n;[FCD(), gCD][1];').runInContext(sandbox);
  const mod = await WebAssembly.compile(wasmBytes);
  const provided = new vm.Script('[FCD(), MCD()][1]').runInContext(sandbox)['./qoder_auth_wasm_bg.js'];
  const io = { './qoder_auth_wasm_bg.js': {} };
  for (const imp of WebAssembly.Module.imports(mod)) io[imp.module][imp.name] = provided[imp.name];
  sandbox.X$ = (await WebAssembly.instantiate(mod, io)).exports;
  _g = new vm.Script('gCD').runInContext(sandbox);
  return _g;
}

/** 解密指定区域目录的凭据；失败返回 null */
export function decryptCredentials(g, dir) {
  try {
    const json = g.credential_storage_decrypt(
      readFileSync(join(dir, 'user'), 'utf8').trim(),
      readFileSync(join(dir, 'machine_id'), 'utf8').trim().slice(0, 16),
    );
    const creds = JSON.parse(json);
    if (!creds?.uid || !creds?.encrypt_user_info) return null;
    return creds;
  } catch {
    return null;
  }
}

/** 探测本机已登录区域：优先国内（~/.qoder-cn），其次国际（~/.qoder） */
export function detectRegion(g, osHome = process.env.HOME) {
  const candidates = [
    { name: 'cn', authDir: join(osHome, '.qoder-cn', '.auth'), inferBase: 'https://gateway.qoder.com.cn', openapiBase: 'https://openapi.qoder.com.cn' },
    { name: 'intl', authDir: join(osHome, '.qoder', '.auth'), inferBase: 'https://api2-v2.qoder.sh', openapiBase: 'https://openapi.qoder.sh' },
  ];
  for (const c of candidates) {
    const creds = decryptCredentials(g, c.authDir);
    if (creds) return { ...c, creds };
  }
  return null;
}

const CLIENT_META = JSON.stringify({ client_type: '5', business_product: 'cli', business_type: 'agent', scene: 'assistant' });

export class QoderClient {
  constructor(region) {
    this.region = region; // { name, authDir, inferBase, openapiBase, creds }
    this.ctx = null;
  }

  /** 创建/重建 WASM 上下文 */
  ensureContext() {
    if (!this.ctx) {
      const { creds } = this.region;
      this.ctx = new _g.QoderContext(
        readFileSync(join(this.region.authDir, 'machine_id'), 'utf8').trim(),
        '1.1.17',
        JSON.stringify({ uid: creds.uid, encrypt_user_info: creds.encrypt_user_info, key: creds.key }),
        CLIENT_META,
      );
    }
    return this.ctx;
  }

  decode(text) {
    try { return _g.decrypt_server_response(text); } catch { return text; }
  }

  /** 模型目录：GET {infer}/api/v2/model/list?Encode=1（加固 2026-09-15：fetch 加超时，端点 hang 时探测不再永挂） */
  async listModels() {
    const ctx = this.ensureContext();
    const r = ctx.prepareRequest(this.region.inferBase, '/api/v2/model/list?Encode=1', 'GET', 'auth');
    const resp = await fetch(r.url, { method: 'GET', headers: Object.fromEntries(r.headers), signal: AbortSignal.timeout(15_000) });
    const text = await resp.text();
    if (!resp.ok) throw new Error(`model/list HTTP ${resp.status}: ${text.slice(0, 200)}`);
    const data = JSON.parse(this.decode(text));
    return data.chat ?? [];
  }

  /** 配额余量：GET {infer}/api/v2/quota/usage（加固：同上，15s 超时） */
  async quotaUsage() {
    const ctx = this.ensureContext();
    const r = ctx.prepareRequest(this.region.inferBase, '/api/v2/quota/usage', 'GET', 'auth');
    const resp = await fetch(r.url, { method: 'GET', headers: Object.fromEntries(r.headers), signal: AbortSignal.timeout(15_000) });
    return JSON.parse(this.decode(await resp.text()));
  }

  /**
   * 流式推理。返回异步迭代器，逐个产出 OpenAI chat.completion.chunk JSON 对象。
   * request: { model, messages, stream?, max_tokens?, temperature?, reasoning_effort? }
   */
  async *streamChat(request) {
    const ctx = this.ensureContext();
    const body = JSON.stringify({ stream: true, ...request });
    const rr = ctx.prepareInferRequest(this.region.inferBase, body, '', '');
    const headers = Object.fromEntries(rr.headers);
    headers['Content-Type'] = 'application/json';
    const resp = await fetch(rr.url, { method: 'POST', headers, body: rr.body ?? undefined });
    if (!resp.ok || !resp.body) {
      const text = await resp.text().catch(() => '');
      throw new Error(`qoder infer HTTP ${resp.status}: ${this.decode(text).slice(0, 300)}`);
    }
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        const t = line.trim();
        if (!t.startsWith('data:')) continue;
        const payload = t.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        let env;
        try { env = JSON.parse(payload); } catch { continue; }
        if (typeof env.body === 'string') {
          // 信封内是标准 OpenAI chunk
          try { yield JSON.parse(env.body); } catch { /* 忽略坏块 */ }
        } else if (env.error || env.message) {
          throw new Error(`qoder infer error: ${JSON.stringify(env).slice(0, 300)}`);
        }
      }
    }
  }
}

export async function createClient(osHome = process.env.HOME) {
  const g = await initWasm();
  const region = detectRegion(g, osHome);
  if (!region) throw new Error('未找到已登录的 Qoder 凭据（~/.qoder-cn/.auth 或 ~/.qoder/.auth）');
  return new QoderClient(region);
}

/** credits 数字展示（千分位，最多 2 位小数；非数值原样）。 */
function fmtQuotaNum(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return String(n);
  return v.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

/**
 * 账号额度归一（agent-manager「额度」显示契约，2026-09-13）：
 * fetchQoderUsage 结果 → 统一视图 { available, display?, unit?, remaining?, used?, usedPercent?, expiresAt?, note?, packages[], fetchedAt }。
 * 纯函数（无 IO），便于单测。
 */
export function quotaFromUsage(usage, now = Date.now()) {
  const BUCKET_LABEL = { user_quota: "基础配额", add_on_quota: "增购包", org_resource_package: "组织包" };
  const c = usage?.credits ?? {};
  const remaining = typeof c.remaining === "number" ? c.remaining : undefined;
  const unit = c.unit ?? "credits";
  const packages = (usage?.buckets ?? []).map((b) => ({
    name: BUCKET_LABEL[b.name] ?? b.name,
    ...(b.remaining !== undefined ? { remaining: b.remaining } : {}),
    ...(b.total !== undefined ? { total: b.total } : {}),
    ...(b.used !== undefined ? { used: b.used } : {}),
    ...(b.usedPercent !== undefined ? { usedPercent: b.usedPercent } : {}),
  }));
  const notes = [];
  if (usage?.plan) notes.push("套餐：" + usage.plan);
  if (usage?.quotaExceeded) notes.push("配额已耗尽");
  const display = remaining !== undefined
    ? "额度 剩余 " + fmtQuotaNum(remaining) + " " + unit
    : typeof c.usedPercent === "number"
      ? "额度 已用 " + fmtQuotaNum(c.usedPercent) + "%"
      : "额度";
  return {
    available: true,
    display,
    unit,
    ...(remaining !== undefined ? { remaining } : {}),
    ...(typeof c.used === "number" ? { used: c.used } : {}),
    ...(typeof c.usedPercent === "number" ? { usedPercent: c.usedPercent } : {}),
    ...(c.expiresAt ? { expiresAt: c.expiresAt } : {}),
    ...(notes.length ? { note: notes.join(" · ") } : {}),
    packages,
    fetchedAt: now,
  };
}
