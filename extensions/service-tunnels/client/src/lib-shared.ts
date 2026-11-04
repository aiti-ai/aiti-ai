/**
 * lib-shared — 双端共享展示语义层（单源消费，方案 §3）。
 *
 * 直接 re-export 库的 src/ui-shared.ts（纯函数，构建时 esbuild 内联进
 * client bundle——运行时不依赖部署机上的库版本）。库 0.3.68 起提供。
 * 依赖说明：0.3.74 起经官方 JS 子路径（./ui-shared）消费——运行时/测试/构建
 * 三环境一致，不再依赖 dev symlink 或 node_modules 内 .ts strip。
 */
export {
  modeOf,
  fmtAddr,
  fmtBytes,
  identityView,
  ddnsBadge,
  netcheckEventView,
  adviceView,
  portmapProbeView,
} from "service-tunnels/ui-shared";
export type {
  ExposeMode,
  IdentityView,
  DdnsBadge,
  NetcheckEventView,
  AdviceCardView,
  NetcheckTone,
  PortmapProbeView,
} from "service-tunnels/ui-shared";
