/**
 * 品牌图标（#9）：@lobehub/icons 按需引入（vite tree-shake，只内联用到的单色/彩色组件）。
 * ProviderAvatar：目录卡 / 订阅服务 / 已配置卡片 / 推荐卡共用的品牌头像；
 * 未命中映射时回退首字母渐变方块（与原 UI 一致）。
 */
import DeepSeekColor from "@lobehub/icons/es/DeepSeek/components/Color";
import ZhipuColor from "@lobehub/icons/es/Zhipu/components/Color";
import ChatGLMColor from "@lobehub/icons/es/ChatGLM/components/Color";
import ZAIMono from "@lobehub/icons/es/ZAI/components/Mono";
import MoonshotMono from "@lobehub/icons/es/Moonshot/components/Mono";
import KimiColor from "@lobehub/icons/es/Kimi/components/Color";
import QwenColor from "@lobehub/icons/es/Qwen/components/Color";
import AlibabaColor from "@lobehub/icons/es/Alibaba/components/Color";
import MinimaxColor from "@lobehub/icons/es/Minimax/components/Color";
import BaichuanColor from "@lobehub/icons/es/Baichuan/components/Color";
import StepfunMono from "@lobehub/icons/es/Stepfun/components/Mono";
import SenseNovaColor from "@lobehub/icons/es/SenseNova/components/Color";
import HunyuanColor from "@lobehub/icons/es/Hunyuan/components/Color";
import DoubaoColor from "@lobehub/icons/es/Doubao/components/Color";
import VolcengineColor from "@lobehub/icons/es/Volcengine/components/Color";
import WenxinColor from "@lobehub/icons/es/Wenxin/components/Color";
import BaiduColor from "@lobehub/icons/es/Baidu/components/Color";
import SiliconCloudColor from "@lobehub/icons/es/SiliconCloud/components/Color";
import ModelScopeColor from "@lobehub/icons/es/ModelScope/components/Color";
import XiaomiMiMoMono from "@lobehub/icons/es/XiaomiMiMo/components/Mono";
import OpenAIMono from "@lobehub/icons/es/OpenAI/components/Mono";
import ClaudeMono from "@lobehub/icons/es/Claude/components/Mono";
import AnthropicMono from "@lobehub/icons/es/Anthropic/components/Mono";
import GoogleColor from "@lobehub/icons/es/Google/components/Color";
import GeminiColor from "@lobehub/icons/es/Gemini/components/Color";
import XAIMono from "@lobehub/icons/es/XAI/components/Mono";
import GrokMono from "@lobehub/icons/es/Grok/components/Mono";
import GroqMono from "@lobehub/icons/es/Groq/components/Mono";
import MistralColor from "@lobehub/icons/es/Mistral/components/Color";
import CohereColor from "@lobehub/icons/es/Cohere/components/Color";
import PerplexityColor from "@lobehub/icons/es/Perplexity/components/Color";
import TogetherColor from "@lobehub/icons/es/Together/components/Color";
import FireworksColor from "@lobehub/icons/es/Fireworks/components/Color";
import CerebrasColor from "@lobehub/icons/es/Cerebras/components/Color";
import OpenRouterMono from "@lobehub/icons/es/OpenRouter/components/Mono";
import NvidiaColor from "@lobehub/icons/es/Nvidia/components/Color";
import CloudflareColor from "@lobehub/icons/es/Cloudflare/components/Color";
import AwsColor from "@lobehub/icons/es/Aws/components/Color";
import AzureColor from "@lobehub/icons/es/Azure/components/Color";
import GithubCopilotMono from "@lobehub/icons/es/GithubCopilot/components/Mono";
import HuggingFaceColor from "@lobehub/icons/es/HuggingFace/components/Color";
import VercelMono from "@lobehub/icons/es/Vercel/components/Mono";
import OllamaMono from "@lobehub/icons/es/Ollama/components/Mono";
import OpenCodeMono from "@lobehub/icons/es/OpenCode/components/Mono";

type IconComp = React.ComponentType<{ size?: number | string }>;

// 精确 id 映射（models.dev id / 国内目录 id / 常见别名，全部小写）
const BY_ID: Record<string, { Icon: IconComp; color?: boolean }> = {
  "deepseek": { Icon: DeepSeekColor, color: true },
  "zhipu": { Icon: ZhipuColor, color: true },
  "zhipuai": { Icon: ZhipuColor, color: true },
  "chatglm": { Icon: ChatGLMColor, color: true },
  "glm": { Icon: ZhipuColor, color: true },
  "zai": { Icon: ZAIMono },
  "zai-coding-cn": { Icon: ZAIMono },
  "zai-coding": { Icon: ZAIMono },
  "bigmodel-cn": { Icon: ZhipuColor, color: true },
  "moonshotai": { Icon: MoonshotMono },
  "moonshotai-cn": { Icon: MoonshotMono },
  "moonshot": { Icon: MoonshotMono },
  "kimi": { Icon: KimiColor, color: true },
  "kimi-coding": { Icon: KimiColor, color: true },
  "qwen": { Icon: QwenColor, color: true },
  "alibaba": { Icon: AlibabaColor, color: true },
  "dashscope": { Icon: QwenColor, color: true },
  "minimax": { Icon: MinimaxColor, color: true },
  "minimax-cn": { Icon: MinimaxColor, color: true },
  "baichuan": { Icon: BaichuanColor, color: true },
  "stepfun": { Icon: StepfunMono },
  "sensenova": { Icon: SenseNovaColor, color: true },
  "hunyuan": { Icon: HunyuanColor, color: true },
  "tencent": { Icon: HunyuanColor, color: true },
  "doubao": { Icon: DoubaoColor, color: true },
  "ark": { Icon: VolcengineColor, color: true },
  "ark-coding": { Icon: VolcengineColor, color: true },
  "volcengine": { Icon: VolcengineColor, color: true },
  "bytedance": { Icon: DoubaoColor, color: true },
  "wenxin": { Icon: WenxinColor, color: true },
  "baidu": { Icon: BaiduColor, color: true },
  "ernie": { Icon: WenxinColor, color: true },
  "siliconcloud": { Icon: SiliconCloudColor, color: true },
  "siliconflow": { Icon: SiliconCloudColor, color: true },
  "modelscope": { Icon: ModelScopeColor, color: true },
  "xiaomi": { Icon: XiaomiMiMoMono },
  "xiaomimimo": { Icon: XiaomiMiMoMono },
  "openai": { Icon: OpenAIMono },
  "openai-codex": { Icon: OpenAIMono },
  "azure-openai-responses": { Icon: AzureColor, color: true },
  "claude": { Icon: ClaudeMono },
  "anthropic": { Icon: AnthropicMono },
  "google": { Icon: GoogleColor, color: true },
  "google-vertex": { Icon: GoogleColor, color: true },
  "gemini": { Icon: GeminiColor, color: true },
  "xai": { Icon: XAIMono },
  "grok": { Icon: GrokMono },
  "groq": { Icon: GroqMono },
  "mistral": { Icon: MistralColor, color: true },
  "cohere": { Icon: CohereColor, color: true },
  "perplexity": { Icon: PerplexityColor, color: true },
  "together": { Icon: TogetherColor, color: true },
  "fireworks": { Icon: FireworksColor, color: true },
  "cerebras": { Icon: CerebrasColor, color: true },
  "openrouter": { Icon: OpenRouterMono },
  "nvidia": { Icon: NvidiaColor, color: true },
  "cloudflare-ai-gateway": { Icon: CloudflareColor, color: true },
  "cloudflare-workers-ai": { Icon: CloudflareColor, color: true },
  "amazon-bedrock": { Icon: AwsColor, color: true },
  "aws": { Icon: AwsColor, color: true },
  "azure": { Icon: AzureColor, color: true },
  "github-copilot": { Icon: GithubCopilotMono },
  "github": { Icon: GithubCopilotMono },
  "huggingface": { Icon: HuggingFaceColor, color: true },
  "vercel-ai-gateway": { Icon: VercelMono },
  "vercel": { Icon: VercelMono },
  "ollama": { Icon: OllamaMono },
  "opencode": { Icon: OpenCodeMono },
  "opencode-go": { Icon: OpenCodeMono },
};

// 名称模糊匹配（id 未命中时按展示名包含关键词兜底）
const BY_NAME: [string, { Icon: IconComp; color?: boolean }][] = [
  ["deepseek", { Icon: DeepSeekColor, color: true }],
  ["智谱", { Icon: ZhipuColor, color: true }],
  ["zhipu", { Icon: ZhipuColor, color: true }],
  ["chatglm", { Icon: ChatGLMColor, color: true }],
  ["月之暗面", { Icon: MoonshotMono }],
  ["moonshot", { Icon: MoonshotMono }],
  ["kimi", { Icon: KimiColor, color: true }],
  ["通义", { Icon: QwenColor, color: true }],
  ["qwen", { Icon: QwenColor, color: true }],
  ["阿里", { Icon: AlibabaColor, color: true }],
  ["minimax", { Icon: MinimaxColor, color: true }],
  ["百川", { Icon: BaichuanColor, color: true }],
  ["阶跃", { Icon: StepfunMono }],
  ["商汤", { Icon: SenseNovaColor, color: true }],
  ["混元", { Icon: HunyuanColor, color: true }],
  ["豆包", { Icon: DoubaoColor, color: true }],
  ["火山", { Icon: VolcengineColor, color: true }],
  ["文心", { Icon: WenxinColor, color: true }],
  ["百度", { Icon: BaiduColor, color: true }],
  ["硅基流动", { Icon: SiliconCloudColor, color: true }],
  ["siliconflow", { Icon: SiliconCloudColor, color: true }],
  ["魔搭", { Icon: ModelScopeColor, color: true }],
  ["modelscope", { Icon: ModelScopeColor, color: true }],
  ["小米", { Icon: XiaomiMiMoMono }],
  ["openai", { Icon: OpenAIMono }],
  ["claude", { Icon: ClaudeMono }],
  ["anthropic", { Icon: AnthropicMono }],
  ["gemini", { Icon: GeminiColor, color: true }],
  ["google", { Icon: GoogleColor, color: true }],
  ["谷歌", { Icon: GoogleColor, color: true }],
  ["grok", { Icon: GrokMono }],
  ["groq", { Icon: GroqMono }],
  ["mistral", { Icon: MistralColor, color: true }],
  ["cohere", { Icon: CohereColor, color: true }],
  ["perplexity", { Icon: PerplexityColor, color: true }],
  ["together", { Icon: TogetherColor, color: true }],
  ["fireworks", { Icon: FireworksColor, color: true }],
  ["cerebras", { Icon: CerebrasColor, color: true }],
  ["openrouter", { Icon: OpenRouterMono }],
  ["nvidia", { Icon: NvidiaColor, color: true }],
  ["cloudflare", { Icon: CloudflareColor, color: true }],
  ["bedrock", { Icon: AwsColor, color: true }],
  ["azure", { Icon: AzureColor, color: true }],
  ["copilot", { Icon: GithubCopilotMono }],
  ["huggingface", { Icon: HuggingFaceColor, color: true }],
  ["ollama", { Icon: OllamaMono }],
];

function resolveIcon(id?: string, name?: string): { Icon: IconComp; color?: boolean } | null {
  const key = String(id || "").trim().toLowerCase();
  if (key && BY_ID[key]) return BY_ID[key];
  const hay = String(name || "") + " " + String(id || "");
  const low = hay.toLowerCase();
  for (const [kw, ent] of BY_NAME) {
    if (low.includes(kw.toLowerCase())) return ent;
  }
  return null;
}

/** 品牌头像：命中 → 白底圆角块 + 品牌 SVG；未命中 → 首字母渐变方块（原样式）。 */
export function ProviderAvatar({ id, name, size = 24, radius }: { id?: string; name?: string; size?: number; radius?: number }) {
  const hit = resolveIcon(id, name);
  const r = radius ?? Math.round(size * 0.32);
  if (hit) {
    return (
      <span className="amw-avatar" style={{ width: size, height: size, borderRadius: r }}>
        <hit.Icon size={Math.round(size * 0.66)} />
      </span>
    );
  }
  const label = String(name || id || "?").trim().charAt(0).toUpperCase() || "?";
  return (
    <span className="amw-avatar is-fallback" style={{ width: size, height: size, borderRadius: r, fontSize: Math.round(size * 0.48) }}>{label}</span>
  );
}
