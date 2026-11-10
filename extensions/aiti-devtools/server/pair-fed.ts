/**
 * pair-fed —— pair 跨桥联邦代理（M3 路线 A 第二层；docs/aiti-bridge-pair-plan.md §13.4）
 *
 * 方向语义（v1 非对称，文档已记）：
 *   本桥 → 权威桥：per-device 精准（devices 并集以 "fed:" 前缀命名空间呈现，message/file 剥前缀转发）
 *   权威桥 → 本桥：桥级（权威桥用户向「pi-web 桥」设备发送 = 广播进本桥全部在线 pair 设备；
 *                    envelope 原样中继，from 保留原始发送者）
 *
 * 组成：
 *   - devices 并集：GET pair/devices 时拉权威桥清单，id 加 "fed:" 前缀合并（请求驱动，非轮询）
 *   - 出站转发：message（text）与 file（本地中转完成后向权威桥三步重放 init/chunk/complete）
 *   - 入站中继：server 侧对权威桥 events SSE 的长连接（fetch 流读，事件驱动；断线退避重连），
 *     envelope 原样 deliverToPeer 进本桥
 *   - fed 文件下载：fileId 本地 registry miss → 权威桥 pair-files 目录**同机直读**（8777 与 pi-web
 *     同机部署事实；跨机部署联邦文件下载不可用，可配 pairFed.filesDir）
 *
 * 生命周期：feature pairFed.enabled 门控（默认关）；relay 凭据持久化 cacheDir/pair-fed-cred.json
 * （peerId 幂等复用）；无任何轮询定时器（SSE 长连接 + 断线退避重连，同 bridge-client 模式）。
 */
import { join } from "node:path";
import { homedir } from "node:os";
import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync, openSync, readSync, closeSync, createReadStream } from "node:fs";
import { Readable } from "node:stream";

const FED_NS = "fed:";

export function createPairFed(opts: {
  TAG: string;
  cacheDir: string;
  log: (m: string) => void;
  /** 本桥在线 pair peers 广播入站 envelope */
  deliverToAllLocalPeers: (env: unknown) => number;
}) {
  const { TAG, cacheDir, log, deliverToAllLocalPeers } = opts;
  const credFile = join(cacheDir, "pair-fed-cred.json");
  // loopRunning = 入站循环实际存活标记（退出时复位）→ 关闭后再开启能重启循环；alive = 本轮循环运行位
  const state = { alive: false, loopRunning: false, attempt: 0 };
  let cfg = { enabled: false, url: "", filesDir: "" };
  let cred: { peerId: string; token: string } | null = null;

  function configure(next: { enabled: boolean; url?: string; filesDir?: string }) {
    cfg = {
      enabled: !!next.enabled,
      url: (next.url || "http://127.0.0.1:8777/aiti").replace(/\/+$/, ""),
      filesDir: next.filesDir || join(homedir(), ".pi", "aiti-bridge", "aiti-bridge", "pair-files"),
    };
    if (cfg.enabled && !state.loopRunning) { state.loopRunning = true; state.alive = true; void inboundLoop(); }
    if (!cfg.enabled) state.alive = false; // 关闭：入站循环自然退出（退出即复位 loopRunning，下次开启重启）
    return cfg;
  }

  const fedFetch = (path: string, init?: RequestInit) => fetch(cfg.url + path, init);

  // ---- relay 凭据（持久化 + 幂等注册） ----
  function loadCred(): { peerId: string; token: string } | null {
    if (cred) return cred;
    try {
      if (existsSync(credFile)) cred = JSON.parse(readFileSync(credFile, "utf8"));
    } catch {}
    return cred;
  }
  async function ensureCred(): Promise<{ peerId: string; token: string }> {
    const saved = loadCred();
    const r = await fedFetch("/bridge/pair/register", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ peerId: saved && saved.peerId, name: "pi-web 桥", ua: "pair-fed relay" }),
    }).then((x) => x.json());
    if (!r || !r.ok) throw new Error("fed register 失败: " + JSON.stringify(r).slice(0, 120));
    cred = { peerId: r.peerId, token: r.token };
    try { mkdirSync(cacheDir, { recursive: true }); writeFileSync(credFile, JSON.stringify(cred)); } catch {}
    return cred;
  }

  // ---- 入站中继（SSE 流读；断线退避重连——事件驱动，非轮询） ----
  async function inboundLoop() {
    while (state.alive) {
      try {
        const c = await ensureCred();
        const resp = await fedFetch("/bridge/pair/events?peer=" + encodeURIComponent(c.peerId) + "&token=" + encodeURIComponent(c.token));
        if (!resp.ok || !resp.body) throw new Error("fed events HTTP " + resp.status);
        const reader = (resp.body as ReadableStream<Uint8Array>).getReader();
        const dec = new TextDecoder();
        let buf = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done || !state.alive) break;
          buf += dec.decode(value, { stream: true });
          let idx: number;
          while ((idx = buf.indexOf("\n\n")) >= 0) {
            const frame = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            const dataLine = frame.split("\n").find((l) => l.startsWith("data: "));
            if (!dataLine) continue;
            try { onEnvelope(JSON.parse(dataLine.slice(6))); } catch {}
          }
        }
        if (state.alive) log(TAG + " fed 入站流断开，重连中");
      } catch (e: any) {
        if (state.alive) log(TAG + " fed 入站异常：" + String((e && e.message) || e) + "（退避重连）");
      }
      if (!state.alive) break;
      state.attempt += 1;
      await new Promise((r) => setTimeout(r, Math.min(15000, 1000 * state.attempt)));
    }
    state.loopRunning = false; // 循环退出（关闭或终态）→ 下次 configure(enabled) 可重启
  }

  function onEnvelope(env: any) {
    if (!env || (env.type !== "text" && env.type !== "file")) return; // ready/peer-join 等忽略
    const n = deliverToAllLocalPeers(env); // envelope 原样中继（from = 权威桥原始发送者）
    log(TAG + " fed 入站 " + env.type + " ← " + ((env.from && env.from.name) || "?") + " → 本桥 " + n + " 台在线设备");
  }

  // ---- devices 并集 ----
  async function fedDevices(): Promise<any[]> {
    if (!cfg.enabled) return [];
    try {
      const d = await fedFetch("/bridge/pair/devices").then((x) => x.json());
      const rows = (d && d.devices) || [];
      return rows
        .filter((x: any) => x && x.id)
        .map((x: any) => ({ ...x, id: FED_NS + x.id, fed: true }));
    } catch (e: any) {
      log(TAG + " fed devices 拉取失败：" + String((e && e.message) || e));
      return [];
    }
  }

  // ---- 出站：文本 ----
  async function fedSendText(toFed: string, text: string) {
    const c = await ensureCred();
    const r = await fedFetch("/bridge/pair/message", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ peer: c.peerId, token: c.token, to: toFed.slice(FED_NS.length), text }),
    }).then((x) => x.json());
    if (r && r.ok) return { ok: true, delivered: (r.delivered || []).map((x: any) => ({ ...x, id: FED_NS + x.id })) };
    return r && r.candidates ? { ok: false, candidates: r.candidates.map((x: any) => ({ ...x, id: FED_NS + x.id })) } : { ok: false, error: (r && r.error) || "fed 发送失败" };
  }

  // ---- 出站：文件（本地中转文件 → 权威桥三步重放） ----
  async function fedSendFile(info: { path: string; name: string; size: number; mime: string }, toFed: string) {
    const c = await ensureCred();
    const init = await fedFetch("/bridge/pair/file/init", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ peer: c.peerId, token: c.token, to: toFed.slice(FED_NS.length), name: info.name, size: info.size, mime: info.mime }),
    }).then((x) => x.json());
    if (!init || !init.ok) throw new Error("fed file init: " + JSON.stringify(init).slice(0, 120));
    const CHUNK = 1024 * 1024;
    const buf = Buffer.allocUnsafe(CHUNK);
    const fd = openSync(info.path, "r");
    try {
      let off = 0;
      while (off < info.size) {
        const n = readSync(fd, buf, 0, Math.min(CHUNK, info.size - off), off);
        const cr = await fedFetch("/bridge/pair/file/chunk/" + init.fileId + "?n=" + Math.floor(off / CHUNK), {
          method: "POST", body: buf.subarray(0, n),
        }).then((x) => x.json());
        if (!cr || cr.error) throw new Error("fed chunk: " + JSON.stringify(cr).slice(0, 120));
        off += n;
      }
    } finally { closeSync(fd); }
    const done = await fedFetch("/bridge/pair/file/complete/" + init.fileId, { method: "POST" }).then((x) => x.json());
    if (!done || !done.ok) throw new Error("fed complete: " + JSON.stringify(done).slice(0, 120));
    return { ok: true, fileId: init.fileId };
  }

  // ---- fed 文件同机直读 ----
  function fedFileLocalPath(fileId: string): string | null {
    if (!cfg.enabled || !cfg.filesDir) return null;
    const p = join(cfg.filesDir, String(fileId || ""));
    try { return existsSync(p) && statSync(p).isFile() ? p : null; } catch { return null; }
  }

  /** fed 文件代理元数据（真实 size 走 stat——content-length 必须与流字节数一致，否则下载被截断） */
  function fedFileProxy(fileId: string): { path: string; meta: { name: string; size: number; mime: string } } | null {
    const p = fedFileLocalPath(fileId);
    if (!p) return null;
    let size = 0;
    try { size = statSync(p).size; } catch {}
    return { path: p, meta: { name: String(fileId), size, mime: "application/octet-stream" } };
  }

  function fileStreamResponse(path: string, name: string, size: number, mime: string): Response {
    const stream = Readable.toWeb(createReadStream(path)) as unknown as ReadableStream;
    return new Response(stream, {
      headers: {
        "content-type": mime || "application/octet-stream",
        "content-length": String(size),
        "cache-control": "no-store",
        "content-disposition": "attachment; filename*=UTF-8''" + encodeURIComponent(name),
      },
    });
  }

  return { configure, fedDevices, fedSendText, fedSendFile, fedFileProxy, fileStreamResponse, isFed: (to: string) => String(to || "").startsWith(FED_NS), strip: (to: string) => String(to || "").slice(FED_NS.length) };
}
