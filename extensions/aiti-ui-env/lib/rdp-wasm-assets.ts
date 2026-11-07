/**
 * aiti-ui-env · grdpwasm main.wasm 资产确保（对齐 service-tunnels face-api 模型方案）
 *
 * 背景：@aiti-ai/grdpwasm 的 tarball 带 main.wasm（~10MB，供 jsDelivr/unpkg 分发），
 * 但 npm install 后 postinstall 即删本地副本——页面运行时经 justget 从 CDN 竞速下载。
 * 本模块是服务端兜底：rdp 实例启动前确保缓存目录有一份 wasm，
 * rdp-bridge serve 同源 main.wasm 时静态目录没有就回退到这份缓存。
 *
 * 下载链路：
 *   1. registry /latest 拿最新版本号 + tarball 地址（npmjs ↔ npm.example.com 双 registry）
 *   2. justget 竞速原始文件：jsDelivr → unpkg
 *   3. 兜底：justget 竞速下载 tgz → gunzip → 最小 tar 解析抽出 package/static/main.wasm
 *      （包刚发布、CDN 未同步时这条保证可用；npmmirror 也参与竞速）
 *
 * justget 走 npm 依赖进程内 download()（2026-09-19 起，替代原 vendored justget.node.mjs
 * 打包副本；依赖经 extman reconcile 进共享根）。包缺失时 loadJustget 返回 null →
 * jgDownload 校验不过 → 各源集合顺次跳过 → 返回 null，页面回落自身 CDN 链。
 *
 * 校验：wasm 魔数 \0asm + 体积下限；坏文件重下。并发用 promise 单例防重复下载。
 */
import { gunzipSync } from "node:zlib";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** justget 进程内下载器（npm 依赖；null=包不可用）。模块级缓存——探测过就不再 import。 */
type JgDownloadFn = (opts: { url: string; output: string; mirrors?: string[] }) => Promise<unknown>;
let _jgDownload: JgDownloadFn | null | undefined;
async function loadJustget(): Promise<JgDownloadFn | null> {
  if (_jgDownload !== undefined) return _jgDownload;
  try {
    const mod: any = await import("justget");
    _jgDownload = typeof mod?.download === "function" ? mod.download : null;
  } catch { _jgDownload = null; }
  return _jgDownload;
}

const PKG = "@aiti-ai/grdpwasm";
const PKG_NAME = "grdpwasm";
const PKG_PATH_ENC = "@aiti-ai%2fgrdpwasm";
const MIN_WASM_BYTES = 1_000_000;
const REGISTRIES = ["https://registry.npmjs.org", "https://registry.npmjs.org"];
/** 原始文件 CDN（需版本号）；tarball 镜像（版本号来自 /latest 动态拼） */
const RAW_CDNS = (ver: string) => [
  `https://cdn.jsdelivr.net/npm/${PKG}@${ver}/static/main.wasm`,
  `https://unpkg.com/${PKG}@${ver}/static/main.wasm`,
];
const TARBALL_MIRRORS = (ver: string) => [
  `https://registry.npmjs.org/${PKG}/-/${PKG_NAME}-${ver}.tgz`,
  `https://registry.npmjs.org/${PKG}/-/${PKG_NAME}-${ver}.tgz`,
  `https://registry.npmmirror.com/${PKG}/-/${PKG_NAME}-${ver}.tgz`,
];

/** 入参为扩展 configDir（= <extRoot>/config）；数据分层：cache 在 <extRoot>/cache 下。 */
export function wasmCachePath(configDir: string): string {
  return join(dirname(configDir), "cache", "grdpwasm", "main.wasm");
}

/** 缓存里的 wasm 是否可用（存在 + 魔数 \0asm + 体积下限） */
export function cachedWasmValid(file: string): boolean {
  try {
    if (!existsSync(file) || statSync(file).size < MIN_WASM_BYTES) return false;
    const head = readFileSync(file).subarray(0, 4);
    return head[0] === 0 && head[1] === 0x61 && head[2] === 0x73 && head[3] === 0x6d;
  } catch {
    return false;
  }
}

function rmSilent(f: string) {
  try { rmSync(f); } catch { /* ignore */ }
}

async function fetchJson(url: string, timeoutMs = 10_000): Promise<any | null> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

/** registry /latest → { version, tarball }；多 registry 依次试 */
async function latestMeta(): Promise<{ version: string; tarball?: string } | null> {
  for (const reg of REGISTRIES) {
    const meta = await fetchJson(`${reg}/${PKG_PATH_ENC}/latest`);
    if (meta?.version && typeof meta.version === "string") {
      return { version: meta.version, tarball: meta.dist?.tarball };
    }
  }
  return null;
}

/** justget 多镜像竞速下载到指定文件；validate 按用途区分（wasm 魔数 / tgz 非空） */
async function jgDownload(urls: string[], output: string, validate: (f: string) => boolean = cachedWasmValid): Promise<boolean> {
  rmSilent(output);
  const [url, ...mirrors] = urls;
  const dl = await loadJustget();
  if (dl) {
    try {
      await dl({ url, mirrors, output });
    } catch { /* 失败走下方校验 */ }
  }
  return validate(output);
}

/** npm tgz（gzip）里抽出 package/static/main.wasm —— 最小 ustar 解析（够用即可） */
function extractWasmFromTgz(tgz: string): Buffer | null {
  try {
    const raw = gunzipSync(readFileSync(tgz));
    const NAME_LEN = 100, SIZE_OFF = 124, TYPE_OFF = 156, PREFIX_OFF = 345, BLOCK = 512;
    let off = 0;
    let longName: string | null = null;
    while (off + BLOCK <= raw.length) {
      const header = raw.subarray(off, off + BLOCK);
      if (header.every((b) => b === 0)) break; // 结束块
      let name = header.subarray(0, NAME_LEN).toString("utf8").replace(/\0.*$/, "");
      const prefix = header.subarray(PREFIX_OFF, PREFIX_OFF + 155).toString("utf8").replace(/\0.*$/, "");
      if (prefix) name = prefix + "/" + name;
      const sizeStr = header.subarray(SIZE_OFF, SIZE_OFF + 12).toString("utf8").replace(/\0.*$/, "").trim();
      const size = parseInt(sizeStr, 8) || 0;
      const type = String.fromCharCode(header[TYPE_OFF] || 48);
      const dataOff = off + BLOCK;
      if (type === "L") { // GNU longname：紧随其后的数据是真名
        longName = raw.subarray(dataOff, dataOff + size).toString("utf8").replace(/\0+$/, "");
      } else {
        const entryName = longName ?? name;
        longName = null;
        if (entryName === "package/static/main.wasm" && type === "0") {
          return Buffer.from(raw.subarray(dataOff, dataOff + size));
        }
      }
      off = dataOff + Math.ceil(size / BLOCK) * BLOCK;
    }
  } catch { /* 坏包 */ }
  return null;
}

let inflight: Promise<string | null> | null = null;

/**
 * 确保缓存目录有可用的 grdpwasm main.wasm，返回其绝对路径（失败 null）。
 * 已有有效缓存直接返回；下载中并发调用共享同一 promise。
 */
export function ensureRdpWasm(configDir: string): Promise<string | null> {
  const dest = wasmCachePath(configDir);
  if (cachedWasmValid(dest)) return Promise.resolve(dest);
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      mkdirSync(dirname(dest), { recursive: true });
      const meta = await latestMeta();
      const ver = meta?.version;
      if (!ver) return null;
      console.log(`[grdpwasm-assets] fetching ${PKG}@${ver} main.wasm via justget …`);
      // ① 原始文件 CDN 竞速
      const tmpRaw = dest + ".dl";
      if (await jgDownload(RAW_CDNS(ver), tmpRaw)) {
        rmSilent(dest);
        writeFileSync(dest, readFileSync(tmpRaw));
        rmSilent(tmpRaw);
        console.log(`[grdpwasm-assets] ok via CDN → ${dest}`);
        return dest;
      }
      rmSilent(tmpRaw);
      // ② tgz 兜底自解包（CDN 未同步 / 被墙时走这里；registry tarball 直连优先）
      const tmpTgz = dest.replace(/\.wasm$/, ".tgz");
      const tgzOk = (f: string) => { try { return statSync(f).size > 100_000; } catch { return false; } };
      const tarballSets: string[][] = [];
      if (meta?.tarball) tarballSets.push([meta.tarball]);
      tarballSets.push(TARBALL_MIRRORS(ver));
      for (const urls of tarballSets) {
        if (!(await jgDownload(urls, tmpTgz, tgzOk))) continue;
        const wasm = extractWasmFromTgz(tmpTgz);
        if (wasm && wasm.length >= MIN_WASM_BYTES && wasm[0] === 0 && wasm[1] === 0x61) {
          rmSilent(dest);
          writeFileSync(dest, wasm);
          rmSilent(tmpTgz);
          console.log(`[grdpwasm-assets] extracted from tgz → ${dest} (${(wasm.length / 1048576).toFixed(1)} MB)`);
          return dest;
        }
      }
      rmSilent(tmpTgz);
      console.log("[grdpwasm-assets] all sources failed; page will fall back to its own CDN chain");
      return null;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}
