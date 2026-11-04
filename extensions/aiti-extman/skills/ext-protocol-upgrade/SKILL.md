---
name: ext-protocol-upgrade
title: AI 帮我升级扩展协议
placeholder: 哪个扩展要升级？（如 aiti-cmd；留空 = 全量协议体检出清单）
summary: 读协议规范与版本迁移手册 → 逐跳迁移源码 → 更新 package.json 声明 → 构建/测试/部署
---

# ext-protocol-upgrade · 扩展协议升级

你是 pi-web 扩展协议升级助手。任务：把扩展从它声明的 `aitiExtProtocol` 版本，按**逐版本迁移手册**升级到当前协议版本；改源码、更新声明、构建/测试/部署、回报。

## 0. 先读（信息源）

- **协议规范**（版本语义/兼容矩阵/变更记录/bump 流程）：`docs/pi-web-ext-protocol.md`
  - 注意 bump 规则（§2.1）：仅**明显改动已有接口且影响现有功能使用**才 bump（伴随迁移手册）；**纯增项不 bump**——变更记录里看到新增项但没有新版号是正常的，不要据此跑升级。
- **canonical 常量**：`pi-web-ext/_shared/ext-protocol.mjs`（当前版本 `EXT_PROTOCOL_VERSION`）
- **迁移手册**：本 skill 的 `references/` 目录（与 SKILL.md 同目录）——`legacy-to-v1.md` 等；文件名 = 一跳（`vN-to-vN+1.md`）。
- **扩展源码**：`pi-web-ext/<id>/`（改这里；部署产物在 `~/.pi/web{,-dev}/extensions/<id>/`，**不要直接改部署产物**）。

## 1. 体检（先确定谁要升级）

```bash
node scripts/check-ext-protocol.mjs --json --warn   # 全仓：声明/状态/upgradeRefs
node scripts/check-ext-protocol.mjs --deployed      # 加查部署目录漂移
```

- 用户指定了扩展 → 只看它的行；留空 → 输出待升级清单（`missing/stale/incompatible/invalid`），逐项处理。
- 状态含义与处置见规范 §4；`too_new` 是宿主过旧（升级 pi-web，不是改扩展）。

## 2. 迁移路由（逐跳，不许跳步）

1. 从 `<id>/package.json` 读 `aitiExtProtocol`（缺失 = legacy）。
2. 算迁移路径：读 `check-ext-protocol` 输出的 `upgradeRefs`（如 `["legacy-to-v1","v1-to-v2"]`）。
3. **按顺序**逐跳打开 `references/<ref>.md` 并执行；某一跳手册不存在 → **停下报告**（说明缺哪本手册），不要自创迁移方案。
4. 每一跳完成后可先验证再进下一跳（迁移手册会写每跳验证点）。

## 3. 单扩展改造流程（每一跳/全部完成后）

1. 通读迁移手册的「受影响特征」与「改法」，用 grep 在 `pi-web-ext/<id>/` 全量定位（server entry、client/src、deploy 脚本、skills 都算）。
2. 改源码（只改必要处；保留原有注释风格；跨文件语义不确定时宁可停手报告）。
3. **更新声明**：`<id>/package.json` 的 `aitiExtProtocol` 改为目标版本（当前 `1.0` 或 bump 后版本）。
4. 有 JSX client（`vite.config.ts` / `client/src`）→ `node pi-web-ext/<id>/tools/build-client.mjs`（或 deploy 内部会构建）。
5. 跑测试：该扩展的 `*.test.mjs`（`node scripts/test-web-ext.mjs --only <id>`）；无专属测试则至少 `node scripts/test-web-ext.mjs --only _shared` 不回归。
6. 部署：`node pi-web-ext/<id>/tools/deploy.mjs`（双实例 + 自动 reload；失败按脚本输出排查）。
7. 验证：
   - `node scripts/check-ext-protocol.mjs --deployed` → 该扩展源/部署两处声明一致且 `ok`；
   - 必要时浏览器验证扩展 UI/行为（或看 `POST /api/extensions/reload` 结果）。

## 4. 全量模式

- 输出清单表格（id/声明/状态/迁移跳数）→ 与用户确认后逐个处理；**一次一个扩展**，不要批量盲改。
- 全部完成后汇总：升级了几个/各自跳数/跳过的原因。

## 5. 汇报格式（不输出 JSON）

每扩展：`<id>`：声明 `X` → `Y`；改了哪些文件（+关键行为变化）；构建/测试/部署/校验结果；遗留（若有）。

## 6. 红线

- **禁 git 破坏性操作**（`git checkout --`/`restore`/`reset --hard`/`clean`）未经用户确认；操作前先 `git status`。
- **禁重启生产实例**（pi-web 3002 等 restart/stop 须用户明确同意）。
- 第三方 npm 包（无 `pi-web-ext/<id>/` 源码）：不要瞎改部署目录；提示用户（停用 / 等上游 / 手动 patch 并自担升级覆盖风险）。
- 手册没写到的破坏性特征 → 停下来汇报，不要猜。
- **安装时筛查**（未来能力，方案 §7）：`aiti-extman/protocol-screen.mjs` 当前是空函数占位；上线后发生 API 不兼容时实现——你只需按上述流程人工/半自动迁移。
