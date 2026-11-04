/**
 * steer-gate — Qoder 运行中注入（steer）能力的**探针门控**（只做判定，不写盘；fs 仅
 * realpath 一处，用于把证据键归一）。
 *
 * 背景：qodercli（CC 族 headless stream-json）的入站 `user` 帧带 `priority`
 * （now/next/later）→ 进它自己的全局消息队列，当前轮工具间隙被 AgentLoop drain。
 * 这条注入面**存在**，但同族 codebuddy 有吞输入前科，且没有投递失败的显式错误——
 * 所以能力位不能凭读代码就打开（那就是刚修掉的「假 steer 按钮」换个地方复发）。
 *
 * 门控规则（唯一开门条件）：探针账本里**这个 CLI 二进制**有 `verdict:"pass"` 记录。
 * 键 = realpath 归一后的绝对路径（PATH 上的 `~/.local/bin/qoderclicn` 是符号链接，
 * 升级会把它指向新版本 → 不归一就等于旧证据永久继承）；记录里的 `cliVersion` 作二次
 * 新鲜度校验（运行时 init 帧回报的版本对不上就提示重跑探针，见 steerEvidenceStale）。
 *
 * 探针：`node tools/steer-probe.mjs --record`（判据与日志见 tools/steer-probe.mjs 头注释）。
 */

import { homedir } from "node:os";
import { realpathSync } from "node:fs";
import { join } from "node:path";

export type SteerProbeVerdict = "pass" | "fail" | "blocked";

export interface SteerProbeRecord {
  verdict: SteerProbeVerdict;
  /** CLI `--version` 原文（仅人读追溯；开门只看路径键）。 */
  cliVersion?: string;
  /** ISO 时间（探针跑完的时刻）。 */
  at?: string;
  /** 判据明细（C1/C2/C3 各条的证据，见探针脚本）。 */
  evidence?: Record<string, unknown>;
}

/** 探针账本：key = CLI 二进制绝对路径（版本化），value = 最近一次探针结论。 */
export type SteerProbeBook = Record<string, SteerProbeRecord>;

/** 账本文件名（落在扩展 stateDir 根，与 queues/ task-lists/ interactions/ 同级）。 */
export const STEER_PROBE_FILE = "steer-probe.json";

export function steerProbePath(stateDir: string): string {
  return join(stateDir, STEER_PROBE_FILE);
}

/**
 * 工具侧兜底 stateDir（探针脚本没有 ctx）：与扩展 `extDataDir()` 同约定——
 * `PI_WEB_DATA_DIR` 优先，否则 `~/.pi/web/data`；双实例本机共用同一数据根。
 */
export function defaultSteerStateDir(home = homedir()): string {
  const root = process.env.PI_WEB_DATA_DIR || join(home, ".pi", "web", "data");
  return join(root, "aiti-qoder-agent", "state");
}

/**
 * 宽容解析：缺文件 / 坏 JSON / 结构不对 → 空账本（= 无证据 = steer 关）。
 * 脏文件绝不可能导致能力位被打开，这是门控的失效方向（fail-closed）。
 * 兼容两种落盘形态：`{probes:{…}}`（带包装，方便手改）与裸 map。
 */
export function parseSteerProbeBook(text: string | null | undefined): SteerProbeBook {
  if (!text) return {};
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return {};
  }
  const obj = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const inner = obj.probes && typeof obj.probes === "object"
    ? (obj.probes as Record<string, unknown>)
    : obj;
  const book: SteerProbeBook = {};
  for (const [cliPath, rec] of Object.entries(inner)) {
    if (!rec || typeof rec !== "object") continue;
    const r = rec as Record<string, unknown>;
    const verdict = r.verdict;
    if (verdict !== "pass" && verdict !== "fail" && verdict !== "blocked") continue;
    book[cliPath] = {
      verdict,
      ...(typeof r.cliVersion === "string" ? { cliVersion: r.cliVersion } : {}),
      ...(typeof r.at === "string" ? { at: r.at } : {}),
      ...(r.evidence && typeof r.evidence === "object" ? { evidence: r.evidence as Record<string, unknown> } : {}),
    };
  }
  return book;
}

/**
 * 证据键：CLI 二进制的规范路径（realpath）。PATH 命中常是符号链接（版本升级会把它
 * 重新指向新二进制），不归一则旧证据会被新版本继承。realpath 失败（路径不存在/权限）
 * → 原样返回（fail-closed：查不到 pass 记录就是不开门）。
 */
export function canonicalCliKey(cliPath: string | null | undefined): string {
  if (!cliPath) return "";
  try {
    return realpathSync(cliPath);
  } catch {
    return cliPath;
  }
}

/** 唯一开门判据：该 CLI 二进制（规范路径）有 pass 记录（fail/blocked/缺记录一律关）。 */
export function steerProbePassed(book: SteerProbeBook | null | undefined, cliPath: string | null | undefined): boolean {
  if (!book || !cliPath) return false;
  return book[canonicalCliKey(cliPath)]?.verdict === "pass";
}

/** 合并一条探针结论（覆盖同二进制旧记录；fail/blocked 也写——留痕，且能撤下旧 pass）。 */
export function mergeSteerProbeRecord(
  book: SteerProbeBook,
  cliPath: string,
  record: SteerProbeRecord,
): SteerProbeBook {
  return { ...book, [canonicalCliKey(cliPath)]: { ...record } };
}

/** 基能力表 + 门控结果 → 该 CLI 的实际能力表（只动 steer；其余声明不受探针影响）。 */
export function withSteerGate<T extends Record<string, boolean>>(base: T, enabled: boolean): T {
  if (base.steer === enabled) return base;
  return { ...base, steer: enabled };
}

/** 人读一行状态（startup 日志 / 探针输出共用口径）。 */
export function describeSteerGate(book: SteerProbeBook, cliPath: string | null): string {
  if (!cliPath) return "steer=off（未解析到 CLI 路径）";
  const rec = book[canonicalCliKey(cliPath)];
  if (!rec) return `steer=off（${cliPath} 无探针记录）`;
  if (rec.verdict === "pass") return `steer=on（探针 pass @${rec.at ?? "?"}）`;
  return `steer=off（探针 ${rec.verdict} @${rec.at ?? "?"}）`;
}

/**
 * 证据新鲜度：门控键是 CLI **路径**，而 PATH 上常是符号链接（`~/.local/bin/qoderclicn`
 * → 版本化文件）。升级把链接指向新二进制时，键不变、证据却属于旧版本——CLI 自己在
 * `system/init` 里报 `qodercli_version`，与探针记录不符就给一句重跑提示（只提示不收回
 * 能力：能力表在会话创建时就已发布给宿主，中途改会让前端按钮与后端行为不一致）。
 */
export function steerEvidenceStale(
  book: SteerProbeBook,
  cliPath: string,
  reportedVersion: string,
): string | null {
  const want = book[canonicalCliKey(cliPath)]?.cliVersion;
  if (!want || !reportedVersion || want === reportedVersion) return null;
  return `steer 探针记录版本 ${want} ≠ 本轮 CLI ${reportedVersion}（${cliPath}）→ 重跑 tools/steer-probe.mjs --record`;
}
