/**
 * aiti-quickstart · examples widget config（「试试这样问」动态设置）。
 *
 * 存储：<configDir>/examples.json（原子写 tmp+rename，照 clone.ts history 形状）。
 * 结构：{ version: 1, mode: "auto" | "prompts" | "builtin", maxChips: number }
 *   - mode=auto（默认）：aiti-prompts 收藏优先，不足 maxChips 内置池随机补足
 *   - mode=prompts：只显示收藏；mode=builtin：只显示内置池
 *   - maxChips：展示条数上限（2~8，默认 4）
 */
import * as fs from "node:fs";
import * as path from "node:path";

export type ExamplesMode = "auto" | "prompts" | "builtin";

export interface ExamplesConfig {
  mode: ExamplesMode;
  maxChips: number;
}

export const EXAMPLES_CONFIG_DEFAULT: ExamplesConfig = { mode: "auto", maxChips: 4 };
const MODES: ExamplesMode[] = ["auto", "prompts", "builtin"];

function clampMaxChips(v: unknown): number {
  const n = typeof v === "number" ? v : parseInt(String(v ?? ""), 10);
  if (!Number.isFinite(n)) return EXAMPLES_CONFIG_DEFAULT.maxChips;
  return Math.max(2, Math.min(8, Math.round(n)));
}

export function normalizeExamplesConfig(raw: unknown): ExamplesConfig {
  const r = (raw ?? {}) as Partial<ExamplesConfig>;
  return {
    mode: MODES.includes(r.mode as ExamplesMode) ? (r.mode as ExamplesMode) : EXAMPLES_CONFIG_DEFAULT.mode,
    maxChips: clampMaxChips(r.maxChips),
  };
}

function fileOf(configDir: string): string {
  return path.join(configDir, "examples.json");
}

export function readExamplesConfig(configDir: string): ExamplesConfig {
  try {
    if (!fs.existsSync(fileOf(configDir))) return { ...EXAMPLES_CONFIG_DEFAULT };
    return normalizeExamplesConfig(JSON.parse(fs.readFileSync(fileOf(configDir), "utf8")));
  } catch {
    return { ...EXAMPLES_CONFIG_DEFAULT };
  }
}

export function writeExamplesConfig(configDir: string, raw: unknown): ExamplesConfig {
  const next = normalizeExamplesConfig(raw);
  fs.mkdirSync(configDir, { recursive: true });
  const file = fileOf(configDir);
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, ...next }, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, file);
  return next;
}
