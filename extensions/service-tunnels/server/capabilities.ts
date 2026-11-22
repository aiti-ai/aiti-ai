/**
 * capabilities — M1 能力协商（方案 §5）：/status 增 capabilities 段。
 *
 * 探测式（不假设库版本）：startup 探测一次 + globalThis 缓存；客户端按能力
 * 门控 tab/列/表单项，缺能力 → 隐藏不报错。库 0.3.66 已有 portmap/ipv6/ddns
 * 实例面；port-identity 经 importLib 探测（specifier 失败时物理兜底，旧宿主
 * 进程 exports 缓存视图下亦可用）。
 */
import type { ServiceTunnels } from "service-tunnels";
import { readDdnsConfigs } from "service-tunnels";

export interface StCapabilities {
  /** 端口服务识别（enrichWithIdentity/identifyPort）——ports 主行 icon/title。 */
  portIdentity: boolean;
  /** 用户自定义服务名（port-label 写 state.serviceLabels）。 */
  serviceLabels: boolean;
  /** 支持的 expose 模式（tunnel/proxy/both 基础 + portmap/ipv6 按实例面）。 */
  exposeModes: string[];
  /** DDNS registry（readDdnsConfigs/writeDdnsConfigs/DDNS_PROVIDERS 根导出）。 */
  ddnsRegistry: boolean;
  /** 网络体检（st.netcheck.run；库实现未落 → false，doctor tab 隐藏）。 */
  netcheck: boolean;
  /** 库版本（package.json，探测失败省略）。 */
  libVersion?: string;
}

const g = globalThis as { __stExtCapabilities?: StCapabilities | null };
// 缓存生命周期 = 模块生命周期：宿主 reload 会重新求值本模块 → 缓存重置重探
// （否则 lib 升级后 reload，globalThis 里的陈旧探测值会一直上报旧版本/旧能力）。
g.__stExtCapabilities = undefined;

async function hasSubpathExport(sub: string, name: string): Promise<boolean> {
  // importLib 带「部署目录物理 dist 文件」兜底——宿主 exports 解析缓存旧视图下也能探测
  const { importLib } = await import("./lib-import.ts");
  const mod = await importLib<Record<string, unknown>>(sub.replace(/^service-tunnels\//, ""));
  return typeof mod?.[name] === "function";
}

/** 探测库能力（一次性；结果缓存 globalThis）。失败字段 fail-low（false/缺省）。 */
export async function detectCapabilities(st: ServiceTunnels): Promise<StCapabilities> {
  // mock 门控与库侧对齐：ST_UI_DOCTOR_MOCK=1 时 doctor tab 点亮（dev/test 专用）
  const doctorMock = process.env.ST_UI_DOCTOR_MOCK === "1";
  if (g.__stExtCapabilities) return g.__stExtCapabilities;
  const inst = st as unknown as Record<string, Record<string, unknown> | undefined>;
  let libVersion: string | undefined;
  try {
    // resolve 定位 + readFileSync 直读：require 读 JSON 会进程级缓存（npm 升级
    // 库后 reload 仍报旧版本）；物理直读让 libVersion 随 reload 即时刷新。
    const { createRequire } = await import("node:module");
    const { readFileSync } = await import("node:fs");
    const require = createRequire(import.meta.url);
    const pkgPath = require.resolve("service-tunnels/package.json");
    libVersion = (JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string }).version;
  } catch { /* layouts without a resolvable package.json */ }
  const caps: StCapabilities = {
    portIdentity: await hasSubpathExport("service-tunnels/port-identity", "enrichWithIdentity"),
    // 用户 label 与 port-identity 同批落地（库 8f079c5）——判据同源；
    // 原判据（state/daemon 面存在）对任何版本恒真，无判别力（深审建议11）
    serviceLabels: await hasSubpathExport("service-tunnels/port-identity", "enrichWithIdentity"),
    exposeModes: [
      "tunnel", "proxy", "both",
      ...(typeof inst.portmap?.probe === "function" ? ["portmap"] : []),
      ...(typeof inst.ipv6?.detect === "function" ? ["ipv6"] : []),
    ],
    // dep floor 0.3.66 起根导出 readDdnsConfigs/writeDdnsConfigs/DDNS_PROVIDERS
    ddnsRegistry: typeof readDdnsConfigs === "function",
    netcheck: typeof inst.netcheck?.run === "function" || doctorMock,
    ...(libVersion ? { libVersion } : {}),
  };
  g.__stExtCapabilities = caps;
  return caps;
}

/** 同步取缓存（未探测过 → null；客户端首轮渲染前 status 已带）。 */
export function cachedCapabilities(): StCapabilities | null {
  return g.__stExtCapabilities ?? null;
}

/** 测试注入口：清缓存。 */
export function resetCapabilitiesCache(): void {
  g.__stExtCapabilities = undefined;
}
