/**
 * tts-local-service —— lifecycle + voice assets for the local TTS service (extension side).
 *
 * The service itself is a Python process managed by `server/tts-service/start-tts.sh|.ps1`
 * (start = bootstrap + serve). This module owns:
 *   - path layout (cache area: venv/models/logs; state area: voices.json + reference audio)
 *   - start/stop/restart (prefers the aiti-cmd PTY runner so logs land in the ⚡ command panel,
 *     falls back to a detached spawn writing the same log file)
 *   - prepare.json / runtime.json / ready.json readers (progress + actual port)
 *   - voice CRUD (reference audio normalization via ffmpeg, 3-30s, <=10MB)
 *
 * No polling anywhere: progress is pushed by /tts/progress (fs.watch on prepare.json).
 */
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const SERVICE_DIR = (() => {
  try {
    return join(fileURLToPath(new URL(".", import.meta.url)), "tts-service");
  } catch {
    return resolve(process.cwd(), "server", "tts-service");
  }
})();

export interface ServicePaths {
  home: string;
  prepare: string;
  runtime: string;
  ready: string;
  log: string;
  models: string;
  venvHojo: string;
  venvQwen3: string;
  voicesJson: string;
  voicesDir: string;
}

function dataRoot(configDir?: string): string {
  return configDir || join(process.env.PI_WEB_DATA_DIR || join(process.env.HOME || ".", ".pi", "web", "data"), "aiti-ai-speek");
}

/** Resolve cache/state paths. `cacheDir`/`stateDir` come from the host context when available. */
export function localPaths(opts: { configDir?: string; cacheDir?: string; stateDir?: string }): ServicePaths {
  const root = dataRoot(opts.configDir);
  const cache = opts.cacheDir || join(root, "cache");
  const state = opts.stateDir || join(root, "state");
  const home = join(cache, "tts-service");
  return {
    home,
    prepare: join(home, "prepare.json"),
    runtime: join(home, "runtime.json"),
    ready: join(home, "ready.json"),
    log: join(home, "logs", "tts.log"),
    models: join(home, "models"),
    venvHojo: join(home, "venv-hojo"),
    venvQwen3: join(home, "venv-qwen3"),
    voicesJson: join(state, "voices.json"),
    voicesDir: join(state, "voices"),
  };
}

export function readJsonSafe<T = Record<string, unknown>>(file: string): T | null {
  try {
    if (!existsSync(file)) return null;
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

export interface PreparePhase {
  phase: string;
  percent: number | null;
  message?: string;
  at?: number;
  provider?: string;
  port?: number;
  pid?: number;
}

export function readPrepare(paths: ServicePaths): PreparePhase | null {
  return readJsonSafe<PreparePhase>(paths.prepare);
}

export function readRuntime(paths: ServicePaths): { port?: number; provider?: string; pid?: number } | null {
  return readJsonSafe(paths.runtime);
}

export function readReady(paths: ServicePaths): {
  provider?: string; family?: string; venv?: string; modelDir?: string; tn?: boolean; at?: number;
} | null {
  return readJsonSafe(paths.ready);
}

/** Directory size in bytes (shallow recursion; used only for `/tts/info` reporting). */
export function dirBytes(dir: string, depth = 2): number {
  if (!existsSync(dir)) return 0;
  let total = 0;
  let entries: string[] = [];
  try { entries = readdirSync(dir); } catch { return 0; }
  for (const name of entries) {
    const p = join(dir, name);
    try {
      const st = statSync(p);
      if (st.isDirectory()) {
        if (depth > 0) total += dirBytes(p, depth - 1);
      } else {
        total += st.size;
      }
    } catch { /* skip */ }
  }
  return total;
}

function scriptFor(): { cmd: string; file: string; args: string[] } {
  if (process.platform === "win32") {
    return { cmd: "powershell", file: join(SERVICE_DIR, "start-tts.ps1"), args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File"] };
  }
  return { cmd: "bash", file: join(SERVICE_DIR, "start-tts.sh"), args: [] };
}

export interface StartOptions {
  paths: ServicePaths;
  provider: string;
  port: number;
  idleTimeout: number;
  format?: string;
  hfEndpoint?: string;
  source?: string;
  /** aiti-cmd runner (ctx.services "aiti-cmd.runner"); when absent a detached spawn is used. */
  runner?: { run?: (opts: Record<string, unknown>) => unknown };
}

function sshQuote(p: string): string {
  return `'${String(p).replace(/'/g, "'\\''")}'`;
}

/** Start the service (bootstrap included). Returns whether a PTY session or detached process was used. */
export async function startService(opts: StartOptions): Promise<{
  ok: boolean; mode: "cmd" | "spawn"; sessionId?: string; queued?: boolean; error?: string;
}> {
  const { paths } = opts;
  mkdirSync(paths.home, { recursive: true });
  mkdirSync(join(paths.home, "logs"), { recursive: true });
  const { cmd, file, args } = scriptFor();
  const env = {
    ...process.env,
    AITI_TTS_HOME: paths.home,
    AITI_TTS_PROVIDER: opts.provider,
    AITI_TTS_PORT: String(opts.port),
    AITI_TTS_IDLE_TIMEOUT: String(opts.idleTimeout),
    AITI_TTS_VOICES_JSON: paths.voicesJson,
    ...(opts.hfEndpoint ? { AITI_TTS_HF_ENDPOINT: opts.hfEndpoint } : {}),
    ...(opts.source ? { AITI_TTS_SOURCE: opts.source } : {}),
    ...(opts.format ? { AITI_TTS_FORMAT: opts.format } : {}),
  };
  // Preferred: aiti-cmd PTY session (logs visible in the ⚡ command panel, same-life with pi-web).
  if (opts.runner?.run) {
    const posixCmd = `AITI_TTS_HOME=${sshQuote(paths.home)} AITI_TTS_PROVIDER=${sshQuote(opts.provider)} `
      + `AITI_TTS_PORT=${opts.port} AITI_TTS_IDLE_TIMEOUT=${opts.idleTimeout} `
      + `AITI_TTS_VOICES_JSON=${sshQuote(paths.voicesJson)} `
      + `${opts.hfEndpoint ? `AITI_TTS_HF_ENDPOINT=${sshQuote(opts.hfEndpoint)} ` : ""}`
      + `bash ${sshQuote(file)} start --provider ${sshQuote(opts.provider)} --port ${opts.port} --idle-timeout ${opts.idleTimeout}`;
    const winCmd = `powershell -NoProfile -ExecutionPolicy Bypass -File "${file}" start -Provider ${opts.provider} -Port ${opts.port} -IdleTimeout ${opts.idleTimeout}`;
    try {
      const r = await Promise.resolve(opts.runner.run({
        command: process.platform === "win32" ? winCmd : posixCmd,
        cwd: SERVICE_DIR,
        name: "本地 TTS 服务（aiti-ai-speek）",
        source: "tts-selfheal",
        ttlMs: 24 * 3600 * 1000,
      })) as { ok?: boolean; sessionId?: string; queued?: boolean; error?: string } | undefined;
      if (r?.ok) return { ok: true, mode: "cmd", sessionId: r.sessionId, queued: r.queued === true };
      // Fall through to detached spawn instead of failing outright.
      console.log("[aiti-ai-speek] aiti-cmd launch unavailable:", r?.error || "no session");
    } catch (e) {
      console.log("[aiti-ai-speek] aiti-cmd launch threw:", String((e as Error)?.message || e));
    }
  }
  // Fallback: detached spawn; the script itself tees to <home>/logs/tts.log.
  try {
    const child = spawn(cmd, [...args, file, "start", "--provider", opts.provider, "--port", String(opts.port), "--idle-timeout", String(opts.idleTimeout)], {
      cwd: SERVICE_DIR,
      env,
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
    return { ok: true, mode: "spawn" };
  } catch (e) {
    return { ok: false, mode: "spawn", error: String((e as Error)?.message || e) };
  }
}

/** Stop the service (script does an exact port-based kill; idempotent). */
export async function stopService(paths: ServicePaths): Promise<{ ok: boolean; error?: string }> {
  const { cmd, file, args } = scriptFor();
  return new Promise((resolveP) => {
    execFile(cmd, [...args, file, "stop"], {
      cwd: SERVICE_DIR,
      env: { ...process.env, AITI_TTS_HOME: paths.home },
      timeout: 30000,
    }, (err) => resolveP(err ? { ok: false, error: String(err.message || err) } : { ok: true }));
  });
}

/** Last N lines of the service log (settings panel "log entry"). */
export function tailLog(paths: ServicePaths, lines = 20): string {
  try {
    if (!existsSync(paths.log)) return "";
    const all = readFileSync(paths.log, "utf8").split(/\r?\n/);
    return all.slice(Math.max(0, all.length - lines)).join("\n");
  } catch {
    return "";
  }
}

// ── voices.json + reference audio ──────────────────────────────────────────────────────────
export interface VoiceEntry {
  id: string;
  label?: string;
  ref_audio?: string;
  ref_text?: string;
  language?: string;
  xvec_only?: boolean;
  provider?: string;
  created_at?: number;
  sample?: string;
}

export function readVoiceEntries(paths: ServicePaths): VoiceEntry[] {
  const data = readJsonSafe<unknown>(paths.voicesJson);
  const list = Array.isArray(data) ? data : (data as { voices?: unknown })?.voices;
  return Array.isArray(list) ? (list as VoiceEntry[]).filter((v) => v && typeof v.id === "string") : [];
}

export function writeVoiceEntries(paths: ServicePaths, list: VoiceEntry[]): void {
  mkdirSync(join(paths.voicesJson, ".."), { recursive: true });
  writeFileSync(paths.voicesJson, JSON.stringify(list, null, 2));
}

/** Slug used as voice id (also the reference audio file name).
 *  ASCII-only on purpose: the id travels through URLs and file names on every platform. */
export function slugifyVoice(name: string): string {
  const raw = String(name || "").trim().toLowerCase();
  const ascii = raw
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  if (ascii) return ascii;
  // Non-latin names (e.g. one written in CJK) keep a stable, filesystem-safe id; the label stays readable.
  if (!raw) return "";
  const digest = createHash("sha1").update(raw).digest("hex").slice(0, 8);
  return `voice-${digest}`;
}

let ffmpegPath: string | null | undefined;
function findFfmpeg(): string | null {
  if (ffmpegPath !== undefined) return ffmpegPath;
  const candidates = [
    "ffmpeg",
    "/usr/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/opt/homebrew/bin/ffmpeg",
    `${process.env.HOME || ""}/.local/bin/ffmpeg`,
  ];
  ffmpegPath = null;
  for (const c of candidates) {
    try {
      if (c === "ffmpeg") { ffmpegPath = "ffmpeg"; break; } // spawn resolves PATH
      if (c && existsSync(c)) { ffmpegPath = c; break; }
    } catch { /* skip */ }
  }
  return ffmpegPath;
}

function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolveP, reject) => {
    execFile(findFfmpeg() || "ffmpeg", args, { timeout: 60000 }, (err, _out, stderr) => {
      if (err) reject(new Error(String(stderr || err.message).slice(-400)));
      else resolveP();
    });
  });
}

/** Duration in seconds via ffprobe (null when unavailable/unparsable). */
function probeDuration(file: string): Promise<number | null> {
  return new Promise((resolveP) => {
    const exe = findFfmpeg()?.replace(/ffmpeg(\.exe)?$/, process.platform === "win32" ? "ffprobe.exe" : "ffprobe") || "ffprobe";
    execFile(exe, ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", file], { timeout: 15000 },
      (err, stdout) => {
        if (err) return resolveP(null);
        const n = parseFloat(String(stdout).trim());
        resolveP(Number.isFinite(n) ? n : null);
      });
  });
}

export interface SaveVoiceOptions {
  paths: ServicePaths;
  id: string;
  label: string;
  refText: string;
  language: string;
  xvecOnly: boolean;
  provider: string;
  audio: { buf: Buffer; name?: string; type?: string };
}

/**
 * Persist reference audio as 24 kHz mono WAV and return the voices.json entry.
 * WAV uploads are stored as-is; anything else goes through ffmpeg (absent -> actionable error).
 */
export async function saveVoice(opts: SaveVoiceOptions): Promise<VoiceEntry> {
  const { paths, audio } = opts;
  if (audio.buf.length > 10 * 1024 * 1024) throw new Error("reference audio is larger than 10MB");
  const isRiff = audio.buf.length > 12 && audio.buf.toString("ascii", 0, 4) === "RIFF";
  mkdirSync(paths.voicesDir, { recursive: true });
  const target = join(paths.voicesDir, `${opts.id}.wav`);
  const tmp = join(paths.voicesDir, `.${opts.id}.upload`);
  writeFileSync(tmp, audio.buf);
  try {
    if (isRiff) {
      // Normalize sample rate/layout anyway: the 80M encoder resamples, but a mono 24 kHz file
      // keeps reference audio uniform and the duration probe cheap.
      if (findFfmpeg()) {
        await runFfmpeg(["-hide_banner", "-loglevel", "error", "-y", "-i", tmp, "-ac", "1", "-ar", "24000", "-c:a", "pcm_s16le", target]);
      } else {
        writeFileSync(target, audio.buf);
      }
    } else {
      if (!findFfmpeg()) {
        throw new Error("this format needs ffmpeg (not found); upload a WAV file or install ffmpeg");
      }
      await runFfmpeg(["-hide_banner", "-loglevel", "error", "-y", "-i", tmp, "-ac", "1", "-ar", "24000", "-c:a", "pcm_s16le", target]);
    }
  } finally {
    try { unlinkSync(tmp); } catch { /* already moved */ }
  }
  const duration = await probeDuration(target);
  if (duration != null && (duration < 2.5 || duration > 35)) {
    try { unlinkSync(target); } catch { /* ignore */ }
    throw new Error(`reference audio should be 3-30s (got ${duration.toFixed(1)}s)`);
  }
  const entry: VoiceEntry = {
    id: opts.id,
    label: opts.label,
    ref_audio: target,
    ref_text: opts.refText,
    language: opts.language,
    xvec_only: opts.xvecOnly,
    provider: opts.provider,
    created_at: Date.now(),
    sample: "我是克隆音色，很高兴为你朗读。",
  };
  const list = readVoiceEntries(paths).filter((v) => v.id !== opts.id);
  list.push(entry);
  writeVoiceEntries(paths, list);
  return entry;
}

/** Remove one voice entry + its reference audio (built-ins are rejected by the caller). */
export function deleteVoiceEntry(paths: ServicePaths, id: string): boolean {
  const list = readVoiceEntries(paths);
  const hit = list.find((v) => v.id === id);
  if (!hit) return false;
  writeVoiceEntries(paths, list.filter((v) => v.id !== id));
  if (hit.ref_audio && String(hit.ref_audio).startsWith(paths.voicesDir)) {
    try { unlinkSync(hit.ref_audio); } catch { /* already gone */ }
  }
  return true;
}

/** Wipe the local service cache (venv + models); requires explicit user action in the panel. */
export function purgeServiceCache(paths: ServicePaths): { removed: boolean } {
  try {
    if (existsSync(paths.home)) rmSync(paths.home, { recursive: true, force: true });
    return { removed: true };
  } catch {
    return { removed: false };
  }
}
