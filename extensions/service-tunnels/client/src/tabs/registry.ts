/**
 * tabs/registry — M2 tab 注册表：声明式 tab 清单 + capabilities 门控。
 * 缺能力 → 隐藏不报错（方案 §5 M1）；新增 tab 在此登记即可。
 */
export type TabId = "ports" | "self" | "users" | "ddns" | "doctor";

/** /status capabilities 段（server/capabilities.ts 探测）。 */
export interface StCapabilities {
  portIdentity: boolean;
  serviceLabels: boolean;
  exposeModes: string[];
  ddnsRegistry: boolean;
  netcheck: boolean;
  libVersion?: string;
}

export interface TabDef {
  id: TabId;
  /** i18n key（扩展自有 services.* 或合并进来的库 ui.* 键）。 */
  labelKey: string;
  /** 能力门控（null = 始终可见）。 */
  cap?: (caps: StCapabilities | null) => boolean;
}

export const TAB_DEFS: TabDef[] = [
  { id: "ports", labelKey: "services.tabPorts" },
  { id: "self", labelKey: "services.tabSelf" },
  { id: "users", labelKey: "services.tabUsers" },
  { id: "ddns", labelKey: "services.tabDdns", cap: (c) => !!c?.ddnsRegistry },
  { id: "doctor", labelKey: "services.tabDoctor", cap: (c) => !!c?.netcheck },
];

export function visibleTabs(caps: StCapabilities | null): TabDef[] {
  return TAB_DEFS.filter((d) => !d.cap || d.cap(caps));
}
