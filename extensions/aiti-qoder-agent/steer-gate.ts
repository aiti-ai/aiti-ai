/**
 * steer-gate — Qoder 运行中注入（steer）能力的**探针门控**（只做判定，不写盘；fs 仅
 * realpath 一处，用于把证据键归一）。
 *
 * 背景：驱动换代后注入面换了协议——stream-json 时代是 stdin `user` 帧带
 * `priority:"next"`（AgentLoop 工具间隙 drain），ACP 时代是**在途 session/prompt 旁
 * 再发一条 session/prompt**（CLI 在 initialize 里以 `agentCapabilities._meta.qoder.
 * promptQueueing` 自报能力，入队默认 priority:"next"）。两代的实跑证据**不能互认**：
 * 同族 codebuddy 有吞输入前科、CLI 也没有投递失败的显式错误，凭读代码开能力位就是
 * 「假 steer 按钮」换个地方复发。
 *
 * 门控规则（唯一开门条件）：探针账本里**这个 CLI 二进制 + 同一驱动**有
 * `verdict:"pass"` 记录。键 = realpath 归一后的绝对路径（PATH 上的 `~/.local/bin/
 * qoderclicn` 是符号链接，升级会把它指向新版本 → 不归一就等于旧证据永久继承）；
 * 记录里的 `cliVersion` 作二次新鲜度校验（运行时 init 回报的版本对不上就提示重跑，
 * 见 steerEvidenceStale）。
 *
 * 探针：ACP 用 `node tools/steer-probe-acp.mjs --record`；stream-json 旧探针
 * `tools/steer-probe.mjs --record` 仍在，但其记录只对 stream-json 驱动有效。
 *
 * The generic parsing/merging/lookup core lives in probe-book.ts (the compact gate shares
 * it); this file keeps only the steer-specific constant, wording and explicit signatures.
 */

import {
  canonicalCliKey,
  defaultProbeStateDir,
  describeProbeGate,
  mergeProbeRecord,
  parseProbeBook,
  probeBookPath,
  probeEvidenceStale,
  probePassed,
  withCapabilityGate,
  type ProbeBook,
  type ProbeDriver,
  type ProbeRecord,
  type ProbeVerdict,
} from "./probe-book.ts";

export type SteerProbeVerdict = ProbeVerdict;

/** 证据所属驱动：两代注入面互认 = 假证据（见头注释）。 */
export type SteerProbeDriver = ProbeDriver;

export type SteerProbeRecord = ProbeRecord;

/** 探针账本：key = CLI 二进制绝对路径（版本化），value = 最近一次探针结论。 */
export type SteerProbeBook = ProbeBook;

/** 账本文件名（落在扩展 stateDir 根，与 queues/ task-lists/ interactions/ 同级）。 */
export const STEER_PROBE_FILE = "steer-probe.json";

export function steerProbePath(stateDir: string): string {
  return probeBookPath(stateDir, STEER_PROBE_FILE);
}

/**
 * 工具侧兜底 stateDir（探针脚本没有 ctx）：与扩展 `extDataDir()` 同约定——
 * `PI_WEB_DATA_DIR` 优先，否则 `~/.pi/web/data`；双实例本机共用同一数据根。
 */
export const defaultSteerStateDir = defaultProbeStateDir;

/**
 * 宽容解析：缺文件 / 坏 JSON / 结构不对 → 空账本（= 无证据 = steer 关）。
 * 脏文件绝不可能导致能力位被打开，这是门控的失效方向（fail-closed）。
 * 兼容两种落盘形态：`{probes:{…}}`（带包装，方便手改）与裸 map。
 */
export const parseSteerProbeBook = parseProbeBook;

/**
 * 证据键：CLI 二进制的规范路径（realpath）。PATH 命中常是符号链接（版本升级会把它
 * 重新指向新二进制），不归一则旧证据会被新版本继承。realpath 失败（路径不存在/权限）
 * → 原样返回（fail-closed：查不到 pass 记录就是不开门）。
 */
export { canonicalCliKey };

/**
 * 唯一开门判据：该 CLI 二进制（规范路径）在**该驱动**下有 pass 记录
 * （fail/blocked/缺记录/驱动不符一律关）。
 */
export const steerProbePassed = probePassed;

/** 合并一条探针结论（覆盖同二进制旧记录；fail/blocked 也写——留痕，且能撤下旧 pass）。 */
export const mergeSteerProbeRecord = mergeProbeRecord;

/** 基能力表 + 门控结果 → 该 CLI 的实际能力表（只动 steer；其余声明不受探针影响）。 */
export function withSteerGate<T extends Record<string, boolean>>(base: T, enabled: boolean): T {
  return withCapabilityGate(base, "steer", enabled);
}

/** 人读一行状态（startup 日志 / 探针输出共用口径）。 */
export function describeSteerGate(book: SteerProbeBook, cliPath: string | null, driver?: SteerProbeDriver): string {
  return describeProbeGate(book, cliPath, driver, "steer");
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
  driver: SteerProbeDriver = "acp",
): string | null {
  return probeEvidenceStale(
    book,
    cliPath,
    reportedVersion,
    driver,
    "steer",
    driver === "acp" ? "tools/steer-probe-acp.mjs" : "tools/steer-probe.mjs",
  );
}
