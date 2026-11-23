// aiti-crash-fatal — Fatal 崩溃测试扩展（dev 隔离专用，不进 prod）
// 三个崩溃入口（部分崩理念：每次只蹦一个，均有备份/可恢复）：
//  1️⃣ 崩页面（/corrupt）——复现「服务干崩 → chat ui 进不去，只能到 reload 那个页面」：
//     备份 app/page.tsx 并写入 render throw 版 → 刷新 → server component 抛错
//     → 无 app/error.tsx → 逃到 app/global-error.tsx（🚑 急救页）。POST /restore 还原。
//  2️⃣ 崩扩展 startup（/crash-ext）——部分崩演习：cacheDir 写崩溃标志，reload 后
//     server.startup throw → registry errors → manifest failed → 页面左下角 ⚠
//     「启动失败」指示器。扩展本体加载成功：页面/API/client 全活着，
//     POST /restore-ext 随时可恢复（幂等）。
//  3️⃣ 崩编译（/corrupt-build）——复现编译期错误（Build Error，如
//     "Export xxx doesn't exist in target module"）：往 components/AppShell.tsx 顶部
//     注入不存在导出的 import → Turbopack 模块图坏 → dev overlay 全屏接管，
//     global-error（渲染期边界）结构上接不住。急救出口 = /rescue.html（public/ 静态页
//     不进编译图）+ rescue-hook.js（layout + nginx 双路径注入，Build Error 横幅自动引导）。
//     POST /restore-build 还原。
import { promises as fs, existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { execSync } from "node:child_process";

const TARGET = path.join(process.cwd(), "app/page.tsx");
const BAK = path.join(os.tmpdir(), "aiti-crash-fatal-page.bak");

// 场景③ 崩编译目标：AppShell.tsx 在所有页面的客户端模块图上，编译坏 = 整站 Build Error
const BUILD_TARGET = path.join(process.cwd(), "components/AppShell.tsx");
const BUILD_BAK = path.join(os.tmpdir(), "aiti-crash-fatal-appshell.bak");
// 注入两行：不存在导出的 named import + **引用它** —— Turbopack 只对「被引用的缺失导出」报
// "Export ... doesn't exist in target module"（真实案例中 hasExtRender 被调用才炸；未引用的
// 缺失导入会被摇树吞掉不报错）。
// 注意必须插在 "use client" 指令**之后**（若有）：指令必须在文件最前，插到它前面
// 会变成另一类编译错（directive 位置错），不复现目标错误形态。
const BUILD_MARKER = "import { __aiti_fatal_no_such_export__ } from \"./ExtSlots\";\n" +
  "void __aiti_fatal_no_such_export__; // aiti-crash-fatal build-error drill (restore: POST /api/extensions/aiti-crash-fatal/restore-build)\n";

const CRASH_CONTENT = `// DEV CRASH — global-error emergency drill（aiti-crash-fatal 写入）.
// restore: POST /api/extensions/aiti-crash-fatal/restore
export default async function Home() {
  throw new Error("DEV CRASH — global-error 急救演习（app/page.tsx 被 aiti-crash-fatal 故意破坏）。已备份原文件，POST /api/extensions/aiti-crash-fatal/restore 恢复后刷新即正常。");
}
`;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

const crashFlag = (cacheDir: string) => path.join(cacheDir, "crash-startup.flag");

export default {
  id: "aiti-crash-fatal",
  icon: "icon.svg",
  name: "Fatal 崩溃测试（破坏核心文件 → global-error 急救页）",
  client: "dist/crash-fatal-client.mjs",

  ui: {
    // English manifest-text overrides (name/description/feature labels); zh source lives in the manifest.
    i18n: {
      "zh-CN": {
        "it.close.label": "关闭",
        "it.close.label.2": "关闭",
        "it.close.label.3": "关闭",
        "it.close.label.4": "关闭",
        "it.close.label.5": "关闭",
        "it.close.label.6": "关闭",
        "it.close.label.7": "关闭",
        "it.close.label.8": "关闭",
        "it.close.label.9": "关闭",
        "it.close.label.10": "关闭",
        "it.fatal.title": "Fatal 崩溃测试",
        "it.fatal.title.2": "Fatal 崩溃测试：崩页面（global-error 急救页）/ 崩扩展 startup（⚠ 启动失败指示器）",
        "it.fatal.body": "选择崩溃模式（均有备份 / 可恢复）：\n\n🧨 崩扩展 startup（部分崩）— 本扩展 startup 入口崩：页面 / API / client 全活着，左下角出现 ⚠「启动失败」指示器，可看加载失败消息。60s 自动恢复。\n\n💥 崩页面 — 破坏 app/page.tsx：刷新后整页崩到 🚑 global-error 急救页（chat UI 进不去）。\n\n🧱 崩编译 — 注入不存在导出：Build Error overlay 全屏接管（编译错 global-error 接不住）→ rescue-hook 🚑 横幅自动引导进 /rescue.html 静态急救页。",
        "it.fatal.ext-crashed": "\n\n⚠ 当前正处于 startup 崩溃态，可点「立即恢复扩展」。",
        "it.fatal.build-broken": "\n\n🧱 当前正处于编译错误态，可点「立即恢复编译」。",
        "it.copy.label": "复制",
        "it.copied.label": "已复制 ✓",
        "it.cancel.label": "取消",
        "it.restore-build.label": "立即恢复编译（restore-build）",
        "it.restore-build.done.title": "已还原 AppShell.tsx",
        "it.restore-build.done.body": "等 HMR 自动恢复（或刷新页面）→ Build Error 消失。若页面已全屏 overlay，从 /dev/rescue.html 发指令让 AI 跑 restore-build。",
        "it.restore-ext.label": "立即恢复扩展",
        "it.restore-ext.done.title": "已恢复",
        "it.restore-ext.done.body": "startup 崩溃标志已清除并 reload。左下角 ⚠ 应已消失（若还在，刷新页面）。",
        "it.crash-ext.label": "崩扩展 startup",
        "it.crash-ext.done.title": "扩展已恢复",
        "it.crash-ext.done.body": "startup 崩溃标志已清除并 reload，左下角 ⚠ 应已消失。",
        "it.crash-ext.crashed.title": "扩展 startup 已崩（部分崩）",
        "it.crash-ext.crashed.body": "startup 入口已崩，页面 / API / 本扩展按钮全部存活（部分崩）。\n\n· 左下角出现黄色 ⚠ 按钮，点开见「aiti-crash-fatal · 启动失败」完整消息（含恢复提示）\n· 点 ⚠ 弹层里的 🚑 也可叫急救 AI\n· 60s 后自动恢复；或点下方按钮立即恢复",
        "it.restore-now.label": "立即恢复",
        "it.fail.title": "失败",
        "it.fail.body": "失败：{error}",
        "it.network-error.title": "网络错误",
        "it.crash-build.label": "崩编译（Build Error）",
        "it.crash-build.done.title": "已注入编译错误（AppShell.tsx）",
        "it.crash-build.done.body": "已向 components/AppShell.tsx 顶部注入不存在导出的 import（备份在 {bak}）。\n\n等 HMR / 刷新页面 → 全屏 Build Error overlay（global-error 接不住编译错）→ rescue-hook 🚑 横幅 → 自动引导进 /rescue.html 静态急救页（不进编译图，模块图坏时依然可达）。\n\n还原：本弹窗重开点「立即恢复编译」，或访问 /api/extensions/aiti-crash-fatal/restore-build，或在急救页发指令让 AI 跑。",
        "it.crash-page.label": "崩页面",
        "it.crash-page.done.title": "已破坏 app/page.tsx",
        "it.crash-page.done.body": "已破坏 app/page.tsx（备份在 {bak}）。\n\n现在刷新页面（Cmd/Ctrl+R）→ 页面崩到 🚑 急救页（chat UI 进不去）。\n\n在急救页发指令测试急救 AI，或直接访问 /api/extensions/aiti-crash-fatal/restore（GET）还原。",
        "ext.displayName": "崩溃演习（开发）",
      },
      en: {
        "it.close.label": "Close",
        "it.close.label.2": "Close",
        "it.close.label.3": "Close",
        "it.close.label.4": "Close",
        "it.close.label.5": "Close",
        "it.close.label.6": "Close",
        "it.close.label.7": "Close",
        "it.close.label.8": "Close",
        "it.close.label.9": "Close",
        "it.close.label.10": "Close",
        "it.fatal.title": "Fatal crash drill",
        "it.fatal.title.2": "Fatal crash drill: crash the page (global-error rescue page) / crash extension startup (⚠ startup-failure indicator)",
        "it.fatal.body": "Choose a crash mode (each mode backs up and is recoverable):\n\n🧨 Crash extension startup (partial) — this extension's startup entry throws: the page / API / client all stay alive, a ⚠ \"startup failed\" indicator appears at the bottom left with the load-failure message. Recovers automatically in 60s.\n\n💥 Crash page — corrupts app/page.tsx: after a refresh the whole page crashes into the 🚑 global-error rescue page (the chat UI is unreachable).\n\n🧱 Crash build — injects a missing export: the Build Error overlay takes over the full screen (compile errors cannot be caught by global-error) → the rescue-hook 🚑 banner guides into the static /rescue.html rescue page.",
        "it.fatal.ext-crashed": "\n\n⚠ The extension is currently in the startup-crashed state; use \"Restore extension now\".",
        "it.fatal.build-broken": "\n\n🧱 The build is currently broken; use \"Restore build now\".",
        "it.copy.label": "Copy",
        "it.copied.label": "Copied ✓",
        "it.cancel.label": "Cancel",
        "it.restore-build.label": "Restore build now (restore-build)",
        "it.restore-build.done.title": "AppShell.tsx restored",
        "it.restore-build.done.body": "HMR recovers automatically (or refresh the page) → the Build Error disappears. If the page is fully covered by the overlay, send an instruction from /dev/rescue.html to have the AI run restore-build.",
        "it.restore-ext.label": "Restore extension now",
        "it.restore-ext.done.title": "Restored",
        "it.restore-ext.done.body": "The startup crash flag was cleared and reloaded. The ⚠ at the bottom left should be gone (refresh the page if it is still there).",
        "it.crash-ext.label": "Crash extension startup",
        "it.crash-ext.done.title": "Extension restored",
        "it.crash-ext.done.body": "The startup crash flag was cleared and reloaded; the ⚠ at the bottom left should be gone.",
        "it.crash-ext.crashed.title": "Extension startup crashed (partial)",
        "it.crash-ext.crashed.body": "The startup entry crashed; the page / API / this extension's button all stay alive (partial crash).\n\n· A yellow ⚠ button appears at the bottom left; open it for the full \"aiti-crash-fatal · startup failed\" message (with recovery hints)\n· The 🚑 inside the ⚠ popover also summons the rescue AI\n· Auto-recovers after 60s; or use the button below to restore immediately",
        "it.restore-now.label": "Restore now",
        "it.fail.title": "Failed",
        "it.fail.body": "Failed: {error}",
        "it.network-error.title": "Network error",
        "it.crash-build.label": "Crash build (Build Error)",
        "it.crash-build.done.title": "Compile error injected (AppShell.tsx)",
        "it.crash-build.done.body": "Injected an import of a non-existent export at the top of components/AppShell.tsx (backup at {bak}).\n\nWait for HMR / refresh the page → full-screen Build Error overlay (global-error cannot catch compile errors) → rescue-hook 🚑 banner → auto-guided into the static /rescue.html rescue page (not part of the compile graph, reachable even with a broken module graph).\n\nRestore: reopen this popup and click \"Restore build now\", or call /api/extensions/aiti-crash-fatal/restore-build, or send an instruction from the rescue page to have the AI run it.",
        "it.crash-page.label": "Crash page",
        "it.crash-page.done.title": "app/page.tsx corrupted",
        "it.crash-page.done.body": "app/page.tsx was corrupted (backup at {bak}).\n\nRefresh the page now (Cmd/Ctrl+R) → the page crashes into the 🚑 rescue page (the chat UI is unreachable).\n\nSend an instruction from the rescue page to test the rescue AI, or call /api/extensions/aiti-crash-fatal/restore (GET) to restore directly.",
        "ext.displayName": "Crash Drill (dev)",
      },
    },
  },

  server: {
    // 崩溃入口（部分崩）：标志文件存在就 throw → registry errors → ⚠「启动失败」。
    // 注意 startup throw 时扩展已加载成功（loadAll 先行），API/client 不受影响。
    async startup(ctx) {
      if (existsSync(crashFlag(ctx.cacheDir))) {
        throw new Error("DEV CRASH — startup 演习（aiti-crash-fatal 故意崩溃的入口）。本扩展 API 仍存活：POST /api/extensions/aiti-crash-fatal/restore-ext 后 reload 即恢复。");
      }
    },
    async api(req, ctx) {
    const p = ctx.path || [];
    // POST /crash-ext → 写 startup 崩溃标志（部分崩：页面/API/client 全活，reload 后 ⚠ 可见）
    if (p[0] === "crash-ext" && req.method === "POST") {
      try {
        await fs.mkdir(ctx.cacheDir, { recursive: true });
        await fs.writeFile(crashFlag(ctx.cacheDir), new Date().toISOString(), "utf8");
        return json({ ok: true, note: "startup 崩溃标志已写入。reload 后 startup 入口崩（左下角 ⚠「启动失败」），页面/API/client 不受影响。" });
      } catch (e) {
        return json({ ok: false, error: String(e) }, 500);
      }
    }
    // POST /restore-ext → 清 startup 崩溃标志（幂等；API 活着所以崩着也能调）
    if (p[0] === "restore-ext" && req.method === "POST") {
      try {
        await fs.unlink(crashFlag(ctx.cacheDir)).catch(() => {});
        return json({ ok: true, note: "标志已清除。reload 后 startup 恢复，⚠ 消失。" });
      } catch (e) {
        return json({ ok: false, error: String(e) }, 500);
      }
    }
    if (process.env.NODE_ENV !== "development") {
      return json({ ok: false, error: "仅 dev 可用（NODE_ENV !== development）" }, 403);
    }
    // POST /corrupt → 备份 app/page.tsx + 写入 render throw 版
    if (p[0] === "corrupt" && req.method === "POST") {
      try {
        const orig = await fs.readFile(TARGET, "utf8");
        await fs.writeFile(BAK, orig, "utf8");
        await fs.writeFile(TARGET, CRASH_CONTENT, "utf8");
        return json({
          ok: true,
          target: TARGET,
          bak: BAK,
          note: "已破坏 app/page.tsx（render throw）。刷新页面 → 🚑 global-error 急救页。",
        });
      } catch (e) {
        return json({ ok: false, error: String(e) }, 500);
      }
    }
    // POST /restore → 从备份（或 git 兑底）还原 app/page.tsx
    if (p[0] === "restore" && req.method === "POST") {
      try {
        let content = "";
        try {
          const bak = await fs.readFile(BAK, "utf8");
          if (bak.trim()) content = bak;
        } catch { /* no bak */ }
        if (!content) {
          // bak 缺失/空 → 从 git 已提交版兑底（app/page.tsx 是已提交文件，git show 必得原版）
          content = execSync("git show HEAD:app/page.tsx", { cwd: process.cwd(), encoding: "utf8" });
        }
        await fs.writeFile(TARGET, content, "utf8");
        await fs.unlink(BAK).catch(() => {});
        return json({ ok: true, note: "已还原 app/page.tsx（" + (content === CRASH_CONTENT ? "git 兑底" : "备份") + "）。刷新页面 → 正常。" });
      } catch (e) {
        return json({ ok: false, error: String(e) }, 500);
      }
    }
    // POST /corrupt-build → 备份 components/AppShell.tsx + 顶部注入不存在导出的 import
    //（编译期错误演习：Build Error overlay 全屏接管，global-error 接不住 → rescue.html 急救）
    if (p[0] === "corrupt-build" && req.method === "POST") {
      try {
        const cur = await fs.readFile(BUILD_TARGET, "utf8");
        if (cur.includes("__aiti_fatal_no_such_export__")) {
          // 幂等守卫：已处于破坏态不再覆盖备份（否则备份会存成破坏版，restore 复原不回去）
          return json({ ok: true, target: BUILD_TARGET, bak: BUILD_BAK, already: true, note: "已处于破坏态（未重复破坏）。刷新/等 HMR → Build Error overlay → 🚑 横幅 → /rescue.html。" });
        }
        await fs.writeFile(BUILD_BAK, cur, "utf8");
        // 插在 "use client" 指令之后（若有），保证触发的是「导出不存在」而非「指令位置」编译错
        let sabotaged: string;
        if (cur.startsWith('"use client"')) {
          const nl = cur.indexOf("\n");
          sabotaged = cur.slice(0, nl + 1) + BUILD_MARKER + cur.slice(nl + 1);
        } else {
          sabotaged = BUILD_MARKER + cur;
        }
        await fs.writeFile(BUILD_TARGET, sabotaged, "utf8");
        return json({
          ok: true,
          target: BUILD_TARGET,
          bak: BUILD_BAK,
          note: "已注入不存在导出 import（编译错）。刷新/等 HMR → Build Error overlay → rescue-hook 🚑 横幅 → /rescue.html 急救页。POST /restore-build 还原。",
        });
      } catch (e) {
        return json({ ok: false, error: String(e) }, 500);
      }
    }
    // POST /restore-build → 从备份（或 git 兑底）还原 components/AppShell.tsx
    if (p[0] === "restore-build" && req.method === "POST") {
      try {
        let content = "";
        try {
          const bak = await fs.readFile(BUILD_BAK, "utf8");
          if (bak.trim() && !bak.includes("__aiti_fatal_no_such_export__")) content = bak;
        } catch { /* no bak */ }
        if (!content) {
          // bak 缺失/被污染 → git 已提交版兑底（AppShell.tsx 是已提交文件）
          content = execSync("git show HEAD:components/AppShell.tsx", { cwd: process.cwd(), encoding: "utf8" });
        }
        await fs.writeFile(BUILD_TARGET, content, "utf8");
        await fs.unlink(BUILD_BAK).catch(() => {});
        return json({ ok: true, note: "已还原 components/AppShell.tsx。等 HMR 自动恢复（或刷新）→ Build Error 消失。" });
      } catch (e) {
        return json({ ok: false, error: String(e) }, 500);
      }
    }
    // GET /status → 当前是否处于被破坏态（以 page.tsx 内容判，不靠 bak 存在）+ startup 崩溃态
    if (p[0] === "status" && req.method === "GET") {
      let corrupted = false;
      try {
        const cur = await fs.readFile(TARGET, "utf8");
        corrupted = cur.includes("DEV CRASH — global-error emergency drill");
      } catch { /* unreadable */ }
      let hasBak = false;
      try { await fs.access(BAK); hasBak = true; } catch { /* no bak */ }
      let extCrashed = false;
      try { await fs.access(crashFlag(ctx.cacheDir)); extCrashed = true; } catch { /* not crashed */ }
      // 场景③ 编译错误态（以 AppShell.tsx 是否含注入标记判）
      let buildCorrupted = false;
      try {
        const cur = await fs.readFile(BUILD_TARGET, "utf8");
        buildCorrupted = cur.includes("__aiti_fatal_no_such_export__");
      } catch { /* unreadable */ }
      return json({ ok: true, corrupted, bak: hasBak ? BAK : null, target: TARGET, extCrashed, buildCorrupted, buildBak: buildCorrupted ? BUILD_BAK : null });
    }
    return json({ ok: false, error: "unknown route: " + JSON.stringify(p) }, 404);
    },
  },
};
