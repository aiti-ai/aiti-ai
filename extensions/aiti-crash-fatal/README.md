# aiti-crash-fatal — Fatal 崩溃测试扩展（dev 专用）

模拟 pi-web 不可用的三类崩溃场景，验证完整恢复回路（均**有目的地破坏一个核心文件**，有备份/可恢复，**绝不能进 prod**——`index.ts` 里 `NODE_ENV !== development` 直接拒，deploy 也只打 `~/.pi/web-dev/extensions/`）：

| 场景 | 破坏方式 | 预期恢复出口 | 方案 |
|---|---|---|---|
| ① 💥 崩页面 | `app/page.tsx` 写入 render throw 版 | SSR 渲染期 throw → `app/global-error.tsx` 🚑 急救页 | crash-rescue 场景② |
| ② 🧨 崩扩展 startup | dataDir 写崩溃标志 → reload 后 startup throw | 左下角 ⚠「启动失败」指示器（部分崩，页面/API/client 全活） | — |
| ③ 🧱 崩编译 | `components/AppShell.tsx` 顶部注入不存在导出的 import | Turbopack Build Error overlay 全屏接管（编译错发生在 React 树建立前，global-error **接不住**）→ `rescue-hook.js` 检测 overlay → 🚑 横幅自动引导进 `/rescue.html`（public/ 静态页，不进编译图，模块图坏时依然可达） | crash-rescue 场景③ → `aiti-ai/docs/aiti-web-crash-rescue-build-error-plan.md` |

## 使用

1. **部署**（仓库根跑）：`node pi-web-ext/aiti-crash-fatal/tools/deploy.mjs` → 只打 dev
2. **生效**：`POST /api/extensions/reload`
3. **触发崩溃**：dev 页面顶部工具栏点红色 **💥 Fatal** 按钮 → 自定义确认框（可复制）→ 选场景：
   - **💥 崩页面**：破坏 `app/page.tsx` → 刷新 → 🚑 global-error
   - **🧨 崩扩展 startup**：写崩溃标志 + reload → 左下角 ⚠（60s 自动恢复）
   - **🧱 崩编译**：注入 `AppShell.tsx` → 等 HMR / 刷新 → Build Error overlay → 🚑 横幅 → `/rescue.html`（全新加载场景由 nginx `/dev` sub_filter 注入同一钩子兑底）
4. **急救**：在急救页发指令给后台 AI（独立会话，含 aiti-configs 工具；可切 model；自动带错误上下文）
5. **手动恢复**：
   - 场景①：`POST /api/extensions/aiti-crash-fatal/restore` + 刷新
   - 场景②：`POST /api/extensions/aiti-crash-fatal/restore-ext` + reload（或 ⚠ 弹层内恢复）
   - 场景③：`POST /api/extensions/aiti-crash-fatal/restore-build` + 等 HMR（页面全屏 overlay 时从 `/dev/rescue.html` 发指令让 AI 跑）

## API

| 路由 | 方法 | 说明 |
|---|---|---|
| `/corrupt` | POST | 备份 `app/page.tsx` 并写入 render throw 版（备份在 `/tmp/aiti-crash-fatal-page.bak`） |
| `/restore` | POST | 从备份（或 git 兑底）还原 `app/page.tsx` |
| `/corrupt-build` | POST | 备份 `components/AppShell.tsx` 并顶部注入不存在导出 import（备份在 `/tmp/aiti-crash-fatal-appshell.bak`；幂等守卫：已破坏态不重复破坏/不覆盖备份） |
| `/restore-build` | POST | 从备份（或 git 兑底）还原 `components/AppShell.tsx` |
| `/crash-ext` | POST | 写 startup 崩溃标志（reload 后 startup throw → ⚠ 指示器） |
| `/restore-ext` | POST | 清 startup 崩溃标志（幂等） |
| `/status` | GET | `{ corrupted, extCrashed, buildCorrupted, ... }` 各场景破坏态 |

> Git 兑底依赖目标文件是已提交文件（`git show HEAD:<file>` 必得原版）。

## 手动兜底（若 restore 失效）

```bash
cd ~/workspace/pi-web
git show HEAD:app/page.tsx > app/page.tsx          # 场景①
git show HEAD:components/AppShell.tsx > components/AppShell.tsx  # 场景③
```
