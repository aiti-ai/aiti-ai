/**
 * aiti-msg-smart · 消息智能（段落点击识别 → 弹层动作条）
 *
 * 能力：注册 core 段落点击薄扩展点（registerParagraphClick），点击消息段落 →
 * 弹层卡片（对齐原 core QuoteReplyPopover 行为）：question 选项/引用回复 +
 * 文件打开/定位 + 外部 msg-popover-action 主题 provider（aiti-cmd 命令等）。
 * 全部识别/渲染在扩展侧，core 零感知。
 *
 * 扩展主题（ctx.registerTopicItem / ctx.getTopicItems）：
 *   - msg-popover-action：段落点击弹层动作 provider。recognize(text, {cwd, messageRole, element}) →
 *     返回动作列表 [{id, type, label, title, danger, unavailable, match, onClick(text, cwd)}]。
 *     element 可选（DOM 元素），provider 可据此做 DOM 上下文识别（如取 <code> 内容）。
 *   - inline-code-action：行内 <code> 点击弹层动作 provider。recognize(text, {element}) →
 *     返回动作列表 [{id, type, label, title, danger, onClick(text, element)}]。
 *     默认「复制」按钮内置，provider 添加额外动作（如收藏命令）。
 *
 * 纯客户端扩展为主：file 存在性校验走 core /api/files（encodeFilePathForApi）；
 * 跨仓分辨（主 cwd 未命中时）经自身 server api 进程内消费 aiti-git-trace services.trace 出口。
 * features（recognizer.*）启停：extman 可见，前端 fetch /api/extensions/status 查询。
 */
export default {
  id: "aiti-msg-smart",
  name: "消息智能（段落点击识别）",
  icon: "icon.svg",
  client: "dist/aiti-msg-smart-client.mjs",

  // 可选依赖（依赖与能力模型 P0 示例，评审记录 2026-09-06 确认）：有 aiti-git-trace 时
  // 跨仓文件分辨可用（经 services.trace 出口），没有也不影响本扩展其余识别功能。
  // 纯声明——extman 详情展示 ·optional 边；禁用/卸载 git-trace 不触发任何警告。
  optionalDependsOn: ["aiti-git-trace"],

  ui: {
    clientDependsOn: [],
    i18n: {
      // 注意：client ctx.t 只查本表（ExtSlots makeClientContext 的 tableFor），
      // 查不到返回 key 原文——新增 T.* 词条必须同步补齐三表，否则按钮显示裸 key。
      "zh-CN": {
        "chat.quoteReply": "引用回复",
        "chat.quoteFull": "引用全文",
        "chat.quoteLine": "引用单句",
        "chat.copy": "复制",
        "chat.copied": "已复制",
        "i18n.openFile": "打开文件",
        "export.revealDir": "定位目录",
        "files.openFolder": "打开文件夹",
      },
      "en": {
        "chat.quoteReply": "Quote reply",
        "chat.quoteFull": "Quote full",
        "chat.quoteLine": "Quote line",
        "chat.copy": "Copy",
        "chat.copied": "Copied",
        "i18n.openFile": "Open",
        "export.revealDir": "Reveal",
        "files.openFolder": "Open Folder",
      },
      "zh-TW": {
        "chat.quoteReply": "引用回覆",
        "chat.quoteFull": "引用全文",
        "chat.quoteLine": "引用單句",
        "chat.copy": "複製",
        "chat.copied": "已複製",
        "i18n.openFile": "開啟檔案",
        "export.revealDir": "定位目錄",
        "files.openFolder": "開啟資料夾",
      },
    },
  },

  features: [
    { id: "recognizer.question", label: "问题识别（引用回复）", description: "识别封闭问句/选择问 → 选项按钮 + 引用回复", group: "识别器", default: true },
    { id: "recognizer.selection", label: "划选识别（引用片段）", description: "消息区划选文字 → 弹层：复制 / 引用回复（当前会话）/ 新会话引用（投递到新建会话 composer）", group: "识别器", default: true },
    { id: "recognizer.file", label: "文件/目录识别", description: "提取段落内文件/目录路径 → 打开/定位按钮（存在性校验）", group: "识别器", default: true },
    { id: "recognizer.fileExternalRoots", label: "跨仓文件分辨", description: "主 cwd 未命中时，配合 aiti-git-trace 的会话识别仓/关注路径分辩 cwd 外文件（如写入 ~/workspace/pi-web 却只说 docs/x.md）", group: "识别器", default: true },
    { id: "recognizer.url", label: "链接识别", description: "识别段落内 http/https 链接 → 新窗口打开按钮", group: "识别器", default: true },
    { id: "recognizer.summary", label: "复制全文", description: "任意段落提供复制全文动作", group: "识别器", default: true },
  ],

  server: {
    // 跨仓分辨根薄出口：进程内消费 aiti-git-trace services.trace 服务出口
    // （docs/aiti-plan-first-plan.md §3 模式：不点对点 HTTP、不读兄弟 configDir）；
    // 本扩展客户端只调自己的 API。数据策略（去重/剔 cwd/排序）仍归客户端 mergeExternalRoots。
    async api(req: any, ctx: any) {
      if (ctx?.path?.[0] !== "resolve-roots" || req.method !== "POST") {
        return new Response(JSON.stringify({ ok: false, error: "not found" }), { status: 404, headers: { "content-type": "application/json" } });
      }
      let body: any = {};
      try { body = await req.json(); } catch { /* 空 body 容忍 */ }
      const cwd = typeof body?.cwd === "string" ? body.cwd : "";
      const session = typeof body?.session === "string" ? body.session : "";
      // 双轨（DI 方案 P1）：ctx.services 优先，__piWebExt.byId 穿透兜底（生产旧 core 过渡期）
      const svc = ctx?.services?.get?.("aiti-git-trace.trace")
        ?? (() => { const reg = (globalThis as any).__piWebExt; const loaded = reg && typeof reg.byId === "function" ? reg.byId("aiti-git-trace") : null; return loaded?.ext?.services?.trace ?? null; })();
      let stores: any[] = [];
      let watchPaths: any[] = [];
      const traceOk = !!svc && typeof svc.sessionStores === "function"; // capability 探测（§3.3）
      if (traceOk) {
        try { stores = svc.sessionStores(session) ?? []; } catch { /* 台账损坏等：按空处理 */ }
        try { watchPaths = typeof svc.watchPaths === "function" ? (svc.watchPaths(cwd) ?? []) : []; } catch { /* 同上 */ }
      }
      return new Response(JSON.stringify({ ok: true, traceOk, stores, watchPaths }), {
        headers: { "content-type": "application/json", "cache-control": "no-store" },
      });
    },
  },
};