/**
 * service-tunnels 扩展 —— 服务端口发现 / 虚拟主机代理 / 隧道 / 认证 / 自暴露。
 *
 * 本扩展是 service-tunnels 的完整载体（2026-08 从 pi-web core 剥离）：
 *   - server.startup    → 创建库单例（globalThis.__piServiceTunnels，与宿主
 *     middleware 共享）＋ PI_WEB_EXPOSE 自暴露
 *   - server.middleware → 服务虚拟主机分支 + allowlocal 直连门禁（原 proxy.ts
 *     service 专属逻辑，宿主在核心门禁前调用）
 *   - server.api        → /api/extensions/service-tunnels/<action>
 *   - ui.toolbar/dialogs/banners + client bundle → ServicesDialog / 自暴露告警
 *
 * 兼容：aiti-devtools 扩展仍经 globalThis.__piServiceTunnels 读库实例
 * （inject 端口 enroll 等），宿主 proxy.ts 经 globalThis.__aitiInject 读注入注册。
 */
import { getServiceTunnels, maybeExposeSelf, initExposeInjectFile, restoreExposeInject } from "./server/integration.ts";
import { mergeLibCatalog } from "./server/i18n.ts";
import { join } from "node:path";
import { handleApi } from "./server/api.ts";
import { serviceTunnelsMiddleware } from "./server/middleware.ts";
import { I18N } from "./server/i18n.ts";

export default {
  id: "service-tunnels",
  name: "Service Tunnels",
  version: "0.4.0",
  icon: "icon.svg",
  client: "dist/service-tunnels.mjs",

  ui: {
    clientImmediately: false, // [懒加载 v2] M1 已同步生产，懒化重启用
    toolbar: [{ id: "ports", label: "服务端口", title: "服务端口与隧道（发现 / 暴露 / 认证 / 自暴露）", icon: "icons/globe.svg" }],
    // aiti-float dock v3：停靠槽静态声明（懒扩展物化触发 + 静态入口；id 与 client 注册一致）
    rightFileDock: [{ id: "ports", label: "服务端口" }],
    dialogs: [{ id: "ports", label: "Service ports" }],
    banners: [{ id: "self-expose-alert", label: "自暴露无认证告警" }],
    i18n: I18N,
  },

  server: {
    startup(ctx) {
      // 库单例（globalThis 共享：宿主 middleware / aiti-devtools 扩展同源读取）
      const st = getServiceTunnels();
      // 跨扩展服务出口（DI 方案 P1）：ctx.services 通道（aiti-devtools 读 enroll 等；
      // globalThis.__piServiceTunnels 双轨保留——宿主 middleware 独立 bundle 仍走它）
      ctx.services?.provide?.("service-tunnels.api", st);
      // 注入白名单持久化（expose 周期一致）：文件随 configDir，startup 恢复（reload 不丢）
      try {
        initExposeInjectFile(join(ctx?.configDir ?? "", "expose-inject.json"));
        restoreExposeInject();
      } catch { /* 非致命 */ }
      // 预热 tools 探测缓存（which 子进程探测很贵 ~700ms）——用户第一次打开
      // 配置对话框时直接命中热缓存，不卡首帧。
      try {
        const st = getServiceTunnels();
        const c = (globalThis as Record<string, unknown>).__stToolCache;
        if (!c && typeof st.tools?.list === "function") {
          const val = { at: Date.now(), allowDownload: st.tools.allowDownload(), toolStatus: st.tools.list() };
          (globalThis as Record<string, unknown>).__stToolCache = val;
        }
      } catch { /* 非致命 */ }
      void mergeLibCatalog().catch(() => {});
      // M1 capabilities 探测（一次性 + globalThis 缓存；/status 直接命中热缓存）
      void import("./server/capabilities.ts").then((m) => m.detectCapabilities(getServiceTunnels())).catch(() => {});
      // 可选自暴露（PI_WEB_EXPOSE，best-effort 不阻塞启动）
      void maybeExposeSelf();
      console.log(`[service-tunnels] 就绪：库单例 + ${ctx?.configDir ?? "?"}`);
    },
    shutdown() {
      // 库单例保留在 globalThis（跨 reload 复用，与 aiti-devtools 桥同理）；
      // 需要停自暴露时由 API self-stop / 宿主退出清理钩子处理。
    },

    // /api/extensions/service-tunnels/<action>
    async api(req, ctx) {
      // face-assets 静态 serve（管理端采集页加载 face-api.js + 模型；软依赖：
      // 资产未下载时 404，前端提示先点开启触发下载）
      const p = ctx.path || [];
      if (req.method === "GET" && p[0] === "face-assets" && p[1]) {
        // 支持多段（face-assets/models/<file>——face-api loadFromUri(base+"/models/")）
        let file = p.slice(1).join("/").replace(/\.\./g, "");
        if (!/^[\w./-]+$/.test(file)) return new Response("bad file", { status: 400 });
        // face-api loadFromUri(base+"/models/") 拉的是 models/<file>，但 cache
        // 目录里模型文件是平铺的（与 portal server 同一约定：剥 models/ 前缀）
        if (file.startsWith("models/")) file = file.slice("models/".length);
        try {
          const st = getServiceTunnels() as unknown as {
            auth?: { biometricAssetsEnsure?: () => Promise<{ dir: string }> };
          };
          const { dir } = (await st.auth?.biometricAssetsEnsure?.()) ?? { dir: "" };
          if (!dir) return new Response("assets unavailable", { status: 502 });
          const { readFile } = await import("node:fs/promises");
          const { join } = await import("node:path");
          const buf = await readFile(join(dir, file));
          const ct = file.endsWith(".js") ? "application/javascript; charset=utf-8"
            : file.endsWith(".json") ? "application/json"
            : "application/octet-stream";
          return new Response(buf, { headers: { "content-type": ct, "cache-control": "public, max-age=3600" } });
        } catch {
          return new Response("not found", { status: 404 });
        }
      }
      const res = await handleApi(req, ctx);
      return res;
    },

    // 服务虚拟主机 + allowlocal 门禁（宿主 proxy.ts 在 DNS-rebinding 门禁前调用本钩子）
    async middleware(req) {
      return serviceTunnelsMiddleware(req);
    },
  },
};
