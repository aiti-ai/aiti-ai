/**
 * aiti-extman shared-deps —— 扩展共享 node_modules（每 webRoot 一份：<webRoot>/node_modules）
 *
 * 原理：jiti 以扩展入口为起点解析裸说明符（node 规则逐级向上找 <dir>/node_modules），
 * <webRoot>/node_modules 一旦存在即对 extensions/ 下所有扩展生效——扩展本地 node_modules
 * 就近优先，共享根兜底没带副本的包。机制仿 pi 本体 npm: 包安装（~/.pi/agent/npm/）：
 * 骨架 package.json + `npm install --prefix <webRoot> --legacy-peer-deps`，去重 /
 * lockfile / 卸载裁剪全交 npm。
 *
 * 约定：<webRoot>/package.json 的 dependencies 字段由本模块全权管理——每次 reconcile
 * 用「用户扩展根全部扩展 package.json 的 dependencies+optionalDependencies 并集」重写，
 * 手改会被覆盖。devDependencies（构建期）与 peerDependencies（宿主提供）不收；
 * --legacy-peer-deps 防止把 @earendil-works/pi-* 之类 peer 从 registry 装进共享根
 * （与 pi 同理由）。reconcile 只由 install/remove/ops reconcile-deps / deploy 通知触发，
 * 无任何定时轮询；模块内 Promise 队列串行（跨进程唯一的写入方就是本模块）。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
import { runNpm } from "./installer.js";

// ── 目录约定（内联自 pi-web lib/ext/data-dir.ts；与 installer.ts 同款 env 覆盖）──

function webRoot(): string {
  return process.env.PI_WEB_DEV_DIST === "1"
    ? join(homedir(), ".pi", "web-dev")
    : join(homedir(), ".pi", "web");
}

function extensionsRoot(): string {
  return process.env.PI_WEB_EXTENSIONS_DIR || join(webRoot(), "extensions");
}

/** 共享根 = <webRoot>（node_modules 与骨架 package.json 所在；取 extensionsRoot 的父目录，env 覆盖天然一致）。 */
export function sharedRoot(): string {
  return dirname(extensionsRoot());
}

/** 用户扩展根（供 index.ts 圈定注解范围；其他根 dev/bundled/extra 的依赖不进共享根）。 */
export function extensionsRootPath(): string {
  return extensionsRoot();
}

const SKELETON = { name: "pi-web-extensions", private: true } as const;

function readJson(p: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** 确保共享根有骨架 package.json（缺失才写；避免部署目录无 package.json 时裸 npm i 向上「假成功」的历史坑）。 */
export function ensureSkeleton(): string {
  const root = sharedRoot();
  mkdirSync(root, { recursive: true });
  const pkgPath = join(root, "package.json");
  if (!existsSync(pkgPath)) writeFileSync(pkgPath, JSON.stringify(SKELETON, null, 2) + "\n");
  return pkgPath;
}

// ── 依赖并集收集 ──

export interface DepsUnion {
  /** 并集（name → spec；同名不同 spec 由 mergeSpecs 合并——同族区间取交集，互斥区间才留 `||`）。 */
  deps: Record<string, string>;
  /** 逐扩展声明的依赖（含 optional；供 status 注解与按扩展排查）。 */
  byExt: Record<string, Record<string, string>>;
}

/** 简单区间：^x.y.z / ~x.y.z / x.y.z。带 || >= * tag 的一律算复杂。 */
const SIMPLE_SPEC = /^([~^]?)(\d+)\.(\d+)\.(\d+)$/;

type SemVer = [number, number, number];

function parseSimple(spec: string): { prefix: string; ver: SemVer } | null {
  const m = SIMPLE_SPEC.exec(spec);
  if (!m) return null;
  return { prefix: m[1], ver: [+m[2], +m[3], +m[4]] as SemVer };
}

function cmpVer(a: SemVer, b: SemVer): number {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

/** npm 区间上界语义：^0.1.x 锁 minor、^0.0.x 锁 patch、~ 锁 major.minor、裸版本号精确。 */
function covers(spec: string, ver: SemVer): boolean {
  const s = parseSimple(spec)!;
  if (cmpVer(s.ver, ver) > 0) return false;
  if (s.prefix === "") return cmpVer(s.ver, ver) === 0;
  if (s.prefix === "~") return ver[0] === s.ver[0] && ver[1] === s.ver[1];
  if (s.ver[0] > 0) return ver[0] === s.ver[0];
  if (s.ver[1] > 0) return ver[0] === 0 && ver[1] === s.ver[1];
  return ver[0] === 0 && ver[1] === 0 && ver[2] === s.ver[2];
}

/**
 * 同名依赖的多条区间合并。**共享根只有一份物理拷贝**，`a || b` 等于放弃约束：npm 看到
 * 已装的 0.1.4 满足 `^0.1.3 || ^0.1.4 || ^0.1.5` 就不再动手，声明 `^0.1.5` 的扩展永远拿不到
 * 它要的新 API（实测把 aiti-qoder-agent v0.4.0 卡在门外）。所以同族区间取**交集**——即下界
 * 最高的那条（^0.1.5 ⊂ ^0.1.3，高下界同时满足所有声明者）；区间互不相交（跨 major 等）或有
 * 复杂 spec 时退回 `||`，因为单拷贝本就服务不了互斥区间，交回 npm 自选。
 */
export function mergeSpecs(specs: string[]): string {
  const fallback = specs.join(" || ");
  if (specs.some((s) => !parseSimple(s))) return fallback;
  const top = specs.reduce((a, b) =>
    cmpVer(parseSimple(a)!.ver, parseSimple(b)!.ver) >= 0 ? a : b);
  const ver = parseSimple(top)!.ver;
  return specs.every((s) => covers(s, ver)) ? top : fallback;
}

/** 收集用户扩展根里全部扩展声明的运行时依赖并集。只做静态读文件，不执行任何扩展代码。 */
export function collectDeps(root = extensionsRoot()): DepsUnion {
  const byDep: Record<string, Set<string>> = {};
  const byExt: Record<string, Record<string, string>> = {};
  let names: string[] = [];
  try {
    names = readdirSync(root).filter((d) => !d.startsWith("."));
  } catch {
    return { deps: {}, byExt: {} };
  }
  for (const name of names) {
    const dir = join(root, name);
    if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) continue;
    const pkg = readJson(join(dir, "package.json"));
    if (!pkg) continue;
    const mine: Record<string, string> = {};
    for (const field of ["dependencies", "optionalDependencies"] as const) {
      const obj = pkg[field];
      if (!obj || typeof obj !== "object") continue;
      for (const [dep, spec] of Object.entries(obj as Record<string, unknown>)) {
        if (typeof spec !== "string" || !spec) continue;
        (byDep[dep] ??= new Set()).add(spec);
        mine[dep] = spec;
      }
    }
    if (Object.keys(mine).length > 0) byExt[name] = mine;
  }
  const deps: Record<string, string> = {};
  for (const dep of Object.keys(byDep).sort()) deps[dep] = mergeSpecs([...byDep[dep]]);
  return { deps, byExt };
}

// ── reconcile（并集写根 package.json → npm install；串行） ──

export interface ReconcileResult {
  ok: boolean;
  reason: string;
  root: string;
  /** 本次对齐到的依赖并集。 */
  deps: Record<string, string>;
  /** 并集相比根 package.json 现值是否有变化（有变化才重写 deps 字段；npm install 始终跑，satisfied 时秒级空转）。 */
  changed: boolean;
  output?: string;
  error?: string;
}

let lastResult: ReconcileResult | null = null;
let queue: Promise<unknown> = Promise.resolve();

/** 全量 reconcile。内部吞错（ok:false + error 返回），调用方无需 try；多次并发调用按序执行。 */
export function reconcile(reason = "manual"): Promise<ReconcileResult> {
  const run = queue.then(() => doReconcile(reason));
  queue = run.catch(() => {});
  return run;
}

async function doReconcile(reason: string): Promise<ReconcileResult> {
  const pkgPath = ensureSkeleton();
  const root = sharedRoot();
  const { deps } = collectDeps();
  const pkg = readJson(pkgPath) ?? { ...SKELETON };
  const prev = (pkg.dependencies ?? {}) as Record<string, string>;
  const changed = JSON.stringify(prev) !== JSON.stringify(deps);
  const result: ReconcileResult = { ok: false, reason, root, deps, changed };
  try {
    if (changed) {
      pkg.dependencies = deps;
      writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
    }
    // npm install 始终执行：deps 未变时对齐 node_modules 与 lockfile（手动删库/上次失败自愈）；
    // deps 变化时安装新增 + 裁剪并集里消失的包。
    const { stdout, stderr } = await runNpm(
      ["install", "--prefix", root, "--omit=dev", "--legacy-peer-deps", "--no-audit", "--no-fund"],
      root,
    );
    result.ok = true;
    result.output = (stderr || stdout || "").split("\n").filter(Boolean).slice(-6).join("\n");
  } catch (e) {
    const err = e as { stderr?: string; stdout?: string; message?: string };
    result.error = (err.stderr || err.stdout || err.message || String(e))
      .split("\n")
      .filter(Boolean)
      .slice(-8)
      .join("\n");
  }
  lastResult = result;
  return result;
}

// ── 状态视图（status 注解用） ──

export type DepState = "local" | "shared" | "missing";

export interface SharedDepsState {
  root: string;
  nodeModules: string;
  pkgExists: boolean;
  /** 根 package.json 当前的 dependencies（extman 管理的并集视图）。 */
  deps: Record<string, string>;
  lastResult: ReconcileResult | null;
}

export function depsState(): SharedDepsState {
  const root = sharedRoot();
  const pkg = readJson(join(root, "package.json"));
  return {
    root,
    nodeModules: join(root, "node_modules"),
    pkgExists: pkg != null,
    deps: (pkg?.dependencies ?? {}) as Record<string, string>,
    lastResult,
  };
}

/**
 * 逐扩展依赖状态（文件级探测，不用 require.resolve）：就近优先语义就是文件系统事实——
 * 扩展本地 node_modules/<name> 存在 = local，共享根存在 = shared，都没有 = missing。
 * 关键原因：长驻进程里 Module._pathCache 会缓存目录删除前的旧解析结果（require.resolve
 * 命中缓存不碰磁盘），状态会撒谎；existsSync 永远是真值。直接依赖在共享根是平铺顶层，
 * 无需处理嵌套 hoist。
 */
export function extDepStates(dir: string, depNames: string[]): Record<string, DepState> {
  const out: Record<string, DepState> = {};
  const localNm = join(dir, "node_modules");
  const sharedNm = join(sharedRoot(), "node_modules");
  for (const name of depNames) {
    if (existsSync(join(localNm, name))) out[name] = "local";
    else if (existsSync(join(sharedNm, name))) out[name] = "shared";
    else out[name] = "missing";
  }
  return out;
}
