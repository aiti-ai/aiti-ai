// Provider ids with a usage adapter. OpenCode only appears as `opencode-go`:
// the Go plan quota endpoint is the sole OpenCode usage API (`opencode` / Zen
// expose none — balance is console-only), so Zen ids are intentionally absent.
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
