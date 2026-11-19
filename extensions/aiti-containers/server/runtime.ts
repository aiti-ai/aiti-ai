/**
 * aiti-containers · runtime layer.
 *
 * Responsibilities (deliberately narrow):
 *  - probe a container CLI (docker / podman / nerdctl) and its compose subcommand
 *  - execute argv arrays via execFile (never a shell string)
 *  - normalize the JSON-ish CLI output into stable resource models
 *  - turn CLI failures into actionable messages
 *
 * No state is persisted here; the probe cache lives in the caller (index.ts) so
 * a hot reload simply re-probes on the next request.
 */
import { execFile } from "node:child_process";
import { parsePortMappings, type PortMapping } from "./ports.ts";
import { basename } from "node:path";
import { promisify } from "node:util";

const pexecFile = promisify(execFile);

export type CliKind = "docker" | "podman" | "nerdctl";
export const CLI_KINDS: CliKind[] = ["docker", "podman", "nerdctl"];

export interface RuntimeInfo {
  /** False when no usable CLI was found. */
  ok: boolean;
  /** Executable to invoke (may be a custom path). */
  bin: string;
  kind: CliKind | "custom";
  version: string;
  compose: boolean;
  composeVersion: string;
  /** `ps --format json` (docker 23+): 100x faster than the `{{json .}}` template, which
   *  makes the engine compute expensive per-container fields. */
  psJson: boolean;
  /** Actionable message when ok is false (or when compose is missing). */
  error: string;
  /** Configured selector that produced this probe (auto / docker / podman / a path). */
  preference: string;
  probedAt: number;
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** Run one CLI invocation. Non-zero exits are returned, not thrown. */
export async function runCli(bin: string, args: string[], opts: { timeout?: number } = {}): Promise<RunResult> {
  try {
    const r = await pexecFile(bin, args, {
      timeout: opts.timeout ?? 20000,
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
      encoding: "utf8",
      env: process.env,
    });
    return { code: 0, stdout: String(r.stdout ?? ""), stderr: String(r.stderr ?? ""), timedOut: false };
  } catch (e) {
    const err = e as { code?: number | string; stdout?: string; stderr?: string; killed?: boolean; signal?: string; message?: string };
    const code = typeof err.code === "number" ? err.code : -1;
    return {
      code,
      stdout: String(err.stdout ?? ""),
      stderr: String(err.stderr ?? err.message ?? ""),
      timedOut: !!(err.killed || err.signal === "SIGTERM"),
    };
  }
}

/** First dotted version in a string ("Docker version 26.1.3, build ..." -> "26.1.3"). */
export function firstVersion(text: string): string {
  const m = String(text || "").match(/\b(\d+\.\d+(?:\.\d+)?)\b/);
  return m ? m[1] : "";
}

/** True when the selector names one of the supported CLIs. */
function isKnownKind(value: string): value is CliKind {
  return (CLI_KINDS as string[]).includes(value);
}

async function probeOne(bin: string, preference: string): Promise<RuntimeInfo | null> {
  const v = await runCli(bin, ["--version"], { timeout: 8000 });
  if (v.code !== 0) return null;
  const version = firstVersion(v.stdout + " " + v.stderr);
  const c = await runCli(bin, ["compose", "version"], { timeout: 8000 });
  const compose = c.code === 0;
  const psJson = true;
  const base = basename(bin).replace(/\.exe$/i, "");
  const kind: CliKind | "custom" = isKnownKind(base) ? base : "custom";
  return {
    ok: true,
    bin,
    kind,
    version,
    compose,
    composeVersion: compose ? firstVersion(c.stdout + " " + c.stderr) : "",
    psJson,
    error: compose ? "" : "未探测到 compose 子命令：compose 项目操作不可用（其余功能正常）",
    preference,
    probedAt: Date.now(),
  };
}

/**
 * Probe the container runtime. `preferred` comes from the `cli` feature:
 * "auto" (default), a known kind, or an executable path.
 */
export async function detectRuntime(preferred = "auto"): Promise<RuntimeInfo> {
  const pref = String(preferred || "auto").trim();
  const lower = pref.toLowerCase();
  const candidates: Array<{ bin: string; pref: string }> = [];

  if (lower && lower !== "auto") {
    candidates.push({ bin: pref, pref });
  } else {
    for (const kind of CLI_KINDS) candidates.push({ bin: kind, pref: "auto" });
  }

  const attempts: string[] = [];
  for (const c of candidates) {
    const info = await probeOne(c.bin, c.pref);
    if (info) return info;
    attempts.push(c.bin);
  }

  return {
    ok: false,
    bin: "",
    kind: "docker",
    version: "",
    compose: false,
    composeVersion: "",
    psJson: false,
    error:
      "未找到可用的容器 CLI（已尝试：" + attempts.join(" / ") + "）。" +
      "请安装 docker / podman / nerdctl 并确保可执行文件在 PATH 中；" +
      "Linux 上还需要把当前用户加入 docker 组或使用 rootless 模式。",
    preference: pref || "auto",
    probedAt: Date.now(),
  };
}

/** Last resort: combine stdout and stderr (docker logs writes to both). */
export function mergedOutput(r: RunResult): string {
  const out = (r.stdout || "").replace(/\s+$/, "");
  const err = (r.stderr || "").replace(/\s+$/, "");
  if (out && err) return out + "\n" + err;
  return out || err;
}

const MAX_ERR = 4000;

/** Map common CLI failures to an actionable Chinese message (truncated). */
export function explainError(stderr: string, code?: number): string {
  const raw = String(stderr || "").trim();
  const s = raw.toLowerCase();
  const clip = (t: string) => (t.length > MAX_ERR ? t.slice(0, MAX_ERR) + "\n…(输出已截断)" : t);
  if (!s) return code ? "命令退出码 " + code : "未知错误";
  if (s.includes("permission denied") && (s.includes("docker.sock") || s.includes("podman.sock") || s.includes("unix socket"))) {
    return "无容器 socket 访问权限：把当前用户加入 docker 组（sudo usermod -aG docker $USER 后重新登录），或启用 rootless 模式。原始输出：\n" + clip(raw);
  }
  if (s.includes("cannot connect to the docker daemon") || s.includes("is the docker daemon running")) {
    return "容器 daemon 未运行或 socket 不可达：先启动 dockerd / podman socket（systemctl start docker / systemctl --user start podman.socket）。原始输出：\n" + clip(raw);
  }
  if (s.includes("command not found") || s.includes("enoent") || s.includes("executable file not found")) {
    return "未找到容器 CLI：请安装 docker / podman / nerdctl 并确保在 PATH 中。原始输出：\n" + clip(raw);
  }
  if (s.includes("no such container") || s.includes("no such object")) {
    return "目标不存在或已被删除（可刷新列表确认）。原始输出：\n" + clip(raw);
  }
  if (s.includes("conflict") && (s.includes("already in use") || s.includes("already exists"))) {
    return "名称或标签已被占用。原始输出：\n" + clip(raw);
  }
  return clip(raw);
}

/** Parse newline-delimited JSON objects (tolerates blank lines and stray text). */
export function parseJsonLines(text: string): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  for (const line of String(text || "").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || (t[0] !== "{" && t[0] !== "[")) continue;
    try {
      const v = JSON.parse(t);
      if (Array.isArray(v)) {
        for (const item of v) if (item && typeof item === "object") rows.push(item as Record<string, unknown>);
      } else if (v && typeof v === "object") {
        rows.push(v as Record<string, unknown>);
      }
    } catch {
      /* skip malformed line */
    }
  }
  return rows;
}

/** Parse docker-style label strings: "k=v,k2=v2". Values keep their first '='. */
export function parseLabels(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  const s = String(value ?? "").trim();
  if (!s) return out;
  for (const pair of s.split(",")) {
    const i = pair.indexOf("=");
    if (i <= 0) continue;
    const k = pair.slice(0, i).trim();
    const v = pair.slice(i + 1);
    if (k) out[k] = v;
  }
  return out;
}

const trim = (v: unknown): string => String(v ?? "").trim();
const asBool = (v: unknown): boolean => {
  const s = String(v ?? "").toLowerCase();
  return s === "true" || s === "1";
};

export interface ComposeRef {
  project: string;
  service: string;
  workingDir: string;
  configFiles: string;
}

export interface ContainerSummary {
  id: string;
  shortId: string;
  name: string;
  image: string;
  command: string;
  status: string;
  state: string;
  running: boolean;
  ports: string;
  createdAt: string;
  runningFor: string;
  networks: string;
  labels: Record<string, string>;
  compose: ComposeRef | null;
  portsList: PortMapping[];
}

/** Docker's `ps --format '{{json .}}'` has no State field; podman's does. */
function looksRunning(status: string, state: string): boolean {
  const s = state ? state.toLowerCase() : "";
  if (s) return s === "running" || s === "up";
  return /^(up|running)\b/i.test(status.trim());
}

export function parseContainers(stdout: string): ContainerSummary[] {
  return parseJsonLines(stdout)
    .map((r) => {
      const labels = parseLabels(r.Labels);
      const project = labels["com.docker.compose.project"] || labels["io.podman.compose.project"] || "";
      const service = labels["com.docker.compose.service"] || labels["io.podman.compose.service"] || "";
      const status = trim(r.Status);
      const state = trim(r.State);
      const id = trim(r.ID);
      const names = trim(r.Names);
      const compose: ComposeRef | null = project
        ? {
            project,
            service,
            workingDir: labels["com.docker.compose.project.working_dir"] || "",
            configFiles: labels["com.docker.compose.project.config_files"] || "",
          }
        : null;
      return {
        id,
        shortId: id.slice(0, 12),
        name: names.split(",")[0].trim() || id.slice(0, 12),
        image: trim(r.Image),
        command: trim(r.Command),
        status,
        state,
        running: looksRunning(status, state),
        ports: trim(r.Ports),
        createdAt: trim(r.CreatedAt),
        runningFor: trim(r.RunningFor) || trim(r.CreatedAt),
        networks: trim(r.Networks),
        labels,
        compose,
        portsList: parsePortMappings(r.Ports),
      };
    })
    .filter((c) => c.id || c.name);
}

export interface ImageSummary {
  id: string;
  repository: string;
  tag: string;
  digest: string;
  size: string;
  createdAt: string;
  dangling: boolean;
  ref: string;
}

export function parseImages(stdout: string): ImageSummary[] {
  const rows = parseJsonLines(stdout).map((r) => {
    const repository = trim(r.Repository);
    const tag = trim(r.Tag);
    const dangling = (!repository || repository === "<none>") && (!tag || tag === "<none>");
    return {
      id: trim(r.ID),
      repository: repository || "<none>",
      tag: tag || "<none>",
      digest: trim(r.Digest),
      size: trim(r.Size),
      createdAt: trim(r.CreatedAt),
      dangling,
      ref: dangling ? trim(r.ID).slice(0, 12) : repository + (tag && tag !== "<none>" ? ":" + tag : ""),
    };
  });
  // The same image can appear once per tag; keep each tag row (matches the VS Code explorer).
  return rows.filter((r) => r.id || r.repository !== "<none>");
}

export interface VolumeSummary {
  name: string;
  driver: string;
  scope: string;
  mountpoint: string;
  createdAt: string;
  labels: Record<string, string>;
}

export function parseVolumes(stdout: string): VolumeSummary[] {
  return parseJsonLines(stdout).map((r) => ({
    name: trim(r.Name),
    driver: trim(r.Driver) || "local",
    scope: trim(r.Scope),
    mountpoint: trim(r.Mountpoint),
    createdAt: trim(r.CreatedAt),
    labels: parseLabels(r.Labels),
  }));
}

export interface NetworkSummary {
  id: string;
  name: string;
  driver: string;
  scope: string;
  ipv6: boolean;
  internal: boolean;
  createdAt: string;
  labels: Record<string, string>;
}

export function parseNetworks(stdout: string): NetworkSummary[] {
  return parseJsonLines(stdout).map((r) => ({
    id: trim(r.ID) || trim(r.Id) || trim(r.Name),
    name: trim(r.Name),
    driver: trim(r.Driver),
    scope: trim(r.Scope),
    ipv6: asBool(r.IPv6),
    internal: asBool(r.Internal),
    createdAt: trim(r.CreatedAt),
    labels: parseLabels(r.Labels),
  }));
}

export interface SystemUsageRow {
  type: string;
  totalCount: number;
  active: number;
  size: string;
  reclaimable: string;
}

export function parseSystemUsage(stdout: string): SystemUsageRow[] {
  return parseJsonLines(stdout).map((r) => ({
    type: trim(r.Type),
    totalCount: Number(r.TotalCount ?? 0) || 0,
    active: Number(r.Active ?? 0) || 0,
    size: trim(r.Size),
    reclaimable: trim(r.Reclaimable),
  }));
}
