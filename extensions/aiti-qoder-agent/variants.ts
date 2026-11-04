/**
 * Qoder 变体表（单一来源）。
 *
 * 三个键各有主人，混用会静默断链（历史上 CN 变体因 agentKey 写成 type 的值
 * "qoder-cn"，导致 qodercn:<sid> 的历史行永远找不到 provider → 「会话不存在」）：
 *   - type     = provider 注册键（`<extId>/<type>`）：recycleApi providerType、前端后端记忆引用，勿改
 *   - agentKey = All Sessions join key = handle.id 复合前缀：必须等于 session-manager
 *                适配器 id（`lib/agents/registry.ts`），否则该变体历史行打不开
 *   - stateKey = 模型状态文件键（`lib/model-runtime-ext` 命名空间，与 join key 无关）
 */
export type QoderVariant = "intl" | "cn";

export interface QoderVariantInfo {
  variant: QoderVariant;
  type: string;
  label: string;
  agentKey: string;
  stateKey: string;
}

export const QODER_VARIANTS: readonly QoderVariantInfo[] = [
  { variant: "intl", type: "qoder", label: "Qoder CLI (国际版)", agentKey: "qoder", stateKey: "qoder" },
  { variant: "cn", type: "qoder-cn", label: "Qoder CLI CN (中国站)", agentKey: "qodercn", stateKey: "qoder-cn" },
];

export function qoderVariant(variant: QoderVariant): QoderVariantInfo {
  return QODER_VARIANTS.find((v) => v.variant === variant) ?? QODER_VARIANTS[0];
}
