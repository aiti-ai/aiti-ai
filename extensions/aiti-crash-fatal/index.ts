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
  name: "Fatal 崩溃测试（破坏核心文件 → global-error 急救页）",
  client: "dist/crash-fatal-client.mjs",
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
