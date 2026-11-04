// 扩展自持的 provider id 清单（16 个 id；core 上游同形只覆盖 8 家官方直连）。
// 与 core lib/provider-usage-ids.ts 同名独立模块——数据形状兼容（UsageReport
// 字段超集），但互不依赖：core 停在本簇时扩展仍全量可用。
// OpenCode 只登记 `opencode-go`：Go 套餐窗口是 OpenCode 唯一对 API key 开放的
// 用量端点；`opencode` / `opencode-zen`（Zen 按次付费余额）没有 API（余额只在
// 网页控制台，需登录会话），登记它们只会把 Go 窗口挂到 Zen 名下。
export const PROVIDER_USAGE_IDS = [
  "openai-codex",
  "deepseek",
  "openrouter",
  "moonshotai",
  "moonshotai-cn",
  "minimax",
  "minimax-cn",
  "vercel-ai-gateway",
  "zai",
  "zai-coding-cn",
  "kimi-coding",
  "opencode-go",
  "github-copilot",
  "baseten",
  "siliconflow",
  "siliconflow-cn",
] as const;

export type ProviderUsageId = (typeof PROVIDER_USAGE_IDS)[number];

export function isProviderUsageId(value: string): value is ProviderUsageId {
  return (PROVIDER_USAGE_IDS as readonly string[]).includes(value);
}
