# aiti-cpu-meter

主线程流畅度检测器 —— 读秒 + **0-100 流畅度分** + **颜色分层** + **最小化** + **AI 卡顿调试**。一个功能做**内部版/外部版双产物**，
可注册/注入到**其他网站**评估开发者自己的站点。

## 这是什么

| 能力 | 说明 |
|---|---|
| **流畅度评分** | 0-100（100=流畅，0=卡死），Apdex/INP/TBT 锚定的 gap 幅值曲线 + 阻塞/冻结惩罚，4 档颜色 |
| **读秒器** | rAF 驱动，主线程卡死即冻结（诊断卡死时刻的硬信号） |
| **会话统计** | 全程时间加权**平均流畅度** + **运行时长** + **最低谷**——工作全程挂着，收工点开看整体表现 |
| **最小化** | 缩成小图标（色点 + 实时分数），拖到不碍事处长期跑着，点开 ⇄ 展开；位置/状态持久化 |
| **现场报告 report()** | `window.__aitiCpuMeter.report()` 一键取全套现场：评分/窗口平均/gap/长任务/**LoAF 脚本归因**/卡顿快照/环境 |
| **✨ 问 AI（内部版）** | 面板按钮 → 现场报告交 aiti-helper 建「调试页面卡顿」会话（帮助点 `jank-debug`） |
| **✨ 问 AI（外部版）** | 面板按钮 → prompt 输入弹窗 → 收集现场 POST 回 pi-web 建 session → 自动跳转会话页 |
| **双产物** | 内部版（pi-web 扩展，features 控制）+ 外部版（standalone 单文件，任意网站注入） |

## 三通道注入（开发者评估自己的网站）

### ① service-tunnels 注入（主路径：被代理/公开的站点）

在 service-tunnels 公开/代理自己的站点端口时，公开表单勾选 **CPU 流畅度检测器** → 该通道的 HTML
响应自动注入外部版（无需改自己网站代码）。注册源 id=`aiti-cpu-meter`（零 service-tunnels 改动）。

### ② bookmarklet（任意未代理网站）

```
javascript:(()=>{if(window.__aitiCpuMeter){window.__aitiCpuMeter.dispose();return;}const s=document.createElement('script');s.src='https://<pi-web 域>/api/extensions/aiti-cpu-meter/aiti-cpu-meter.js';s.defer=true;document.head.appendChild(s)})()
```

执行一次注入、再执行一次卸载。可带参数：`aiti-cpu-meter.js?meter-pos=right-top&meter-score=off&meter-min=off`。

### ③ 跨实例注入（feature：service.url + inject.enabled）

从目标 pi-web 实例拉外部版注入当前页（参照 aiti-debug-inject）。

## 交互

- **最小化**：标题栏 **−** → 缩成小图标（色点 + 实时两位分数，颜色随流畅度变化），可拖到任意位置，点开展开。
- **拖动**：**内部版**面板走 aiti-float 契约（data-ext-float，拖动/位置持久化接管，max=0 不注入最大化）；**外部版**面板 + FAB 由 core 自带拖动（外部网站没有 aiti-float），位置持久化。两版 FAB 均由 core 自带拖动。
- **关闭**：**✕** 只隐藏当前页（不持久化，刷新重现）；最小化/展开状态会持久化（刷新后保持小图标原位）。
- 展开态面板：**第一行** 当前分（大）+ 10 格色条（同色）；**第二行** 会话统计（平均/运行/最低）；下面保留 v0.1 原始诊断行
  （CPU 读秒 / gap / max / longtask / 上次卡顿快照）。标题栏为「渲染流畅度」。

## 问 AI（v0.3：适配 aiti-helper）

面板标题栏 ✨ 按钮（lucide sparkles，与 aiti-helper 同图形；feature `askAi` / URL 参数 `meter-ask=0` 关），两条路径汇聚到同一个帮助点：

- **内部版**（pi-web 页面）：点 ✨ → 弹 aiti-helper 对话框（`jank-debug` 帮助点已预选、
  现场报告 JSON 已预填输入框）→ 用户补充现象描述 → 生成 → AI 按 `skills/jank-debug/SKILL.md`
  手册调试（读本报告/LoAF 归因/历史卡顿案例库 → 定位元凶 → 修复建议）。
  aiti-helper 是懒加载扩展：未物化时先 `ctx.ensureMaterialized("aiti-helper")` 拉起再唤起。
  会话 cwd = 当前会话工作目录（helper invoke 自动带）。
- **外部版**（任意注入网站，没有 aiti-helper）：点 ✨ → 简易 prompt 弹窗（自动附当前分/平均/最低/
  longtask 概要）→ 提交 → `POST /api/extensions/aiti-cpu-meter/ask-ai` → 服务端**两段式建会话**
  （`ensure_session` 秒级拿 sessionId → 非阻塞发 prompt，手册指针内联注入——不等模型回合，
  不撞网关 60s 超时；同 ts 幂等，POST 超时后 GET 重试不重复建；`ask-ai` 已声明 publicApi 作
  GET 兑底）→ 返回 `{ sessionId, url }` → 新标签页跳转 pi-web `/?session=<id>`。pi-web 地址按
  注入脚本来源自动推导（也可 `__aitiCpuMeterOpts.base` 显式指定）；跨域回源需部署
  `API_ALLOW_ORIGINS`（本部署已配 `*`）。
  会话 cwd = 用户 HOME（外部站点调试与项目无关联，AI 可跨仓读性能文档；env
  `AITI_CPU_METER_CWD` 可覆盖）。
  服务端两段式建会话（ensure_session 秒级 → 非阻塞发 prompt）——不等模型回合，不撞网关 60s 超时；
  同 ts 幂等（POST 超时后 GET 重试不重复建会话，失败不缓存可重试）。
  报告附带：页面脚本源码路径全集 + 主要大块区域（LoAF 归因对号用）+ doc 元信息 + 同站 cookie
  （`meter-cookie=0` 关；HttpOnly 不可见）。
  会话 cwd = 用户 HOME（外部站点调试与项目无关联，AI 可跨仓读性能文档；env
  `AITI_CPU_METER_CWD` 可覆盖）。

帮助点手册内含**本仓历史卡顿案例库**（强制同步布局循环/轮询风暴/同步 IO/微任务自激风暴/正则回溯等
12 类，均带 commit 出处）与修复工具箱（LoAF 归因/scheduler.yield/读写分离/content-visibility 等）。

## 架构（v0.2 新标准：core + 双产物 + 自定打包）

```
client/core.mjs             共享核心：读秒/评分/颜色/双态UI/拖动/会话统计/幂等/dispose/LoAF 归因/report()/动作按钮（无 ctx 依赖）
client/internal-client.mjs  内部版壳：register(ctx) 读 extman features 接线 core + 问AI(aiti-helper，懒物化兼容) + 跨实例注入
client/standalone.mjs       外部版壳：读 URL 参数 + window.__aitiCpuMeterOpts → core + 问AI(弹窗→ask-ai→跳转)
tools/build.mjs             esbuild 组合 core+壳 → dist/aiti-cpu-meter-client.mjs(ESM) + dist/aiti-cpu-meter.js(IIFE)
tools/deploy.mjs            分发：index.ts/icon + client 产物 → 扩展 client/；standalone → 扩展 assets/；skills/ 递归拷贝
index.ts                    features + server：assets 静态服务 + meter-version + ask-ai 建会话 + __stInjectRegistry 注入注册
skills/                     aiti-helper 帮助点：jank-debug「调试页面卡顿」（现场分析手册 + 历史案例库 + 修复工具箱）
```

- **不兼容旧格式**：v0.1 client 源码弃用，不保留兼容层。
- **内部版接 aiti-float**（pi-web 内有它）：面板标 `data-ext-float="1"`（autoh/max=0/显式 key），拖动/位置/缩放/置前由 aiti-float 接管；**外部版自带拖动**（外部网站没有 aiti-float，功能一致，core 同一份实现）。
- 服务端端点：`/api/extensions/aiti-cpu-meter/aiti-cpu-meter.js`（外部版，no-store）、
  `.../meter-version`（内容哈希，浏览器侧注入前取 `?v=`）。
- 外部版幂等：`window.__aitiCpuMeter` 已存在则先 dispose（防三通道叠加）；dispose 后可卸载。

## 评分算法

```
gapScore(g)：≤33ms=100 · 200ms=40 · 1000ms=10 · 10000ms=0（分段线性，贴合人眼）
frameHealth = min(gapScore(ewmaGap), gapScore(recentMax))     # 持续(EWMA)与尖峰(衰减max)取较差
流畅度 = clamp( 100 − 0.60×(100−frameHealth) − 0.20×blockingPenalty − 0.20×freezePenalty , 0, 100 )
  blockingPenalty = 长任务 TBT 阻塞占比 EWMA（Σmax(0,dur−50)）
  freezePenalty  = min(50, 冻结次数×10)（>600ms 帧，衰减计数）
颜色：≥90 绿 · 75–89 黄 · 50–74 橙 · <50 红
```

锚定公开算法：**Apdex**（满意度阈值）、**INP**（200/500ms）、**TBT**（Google）、**RAIL**（帧 ≤16.7ms）。
校准（实现期实测）：全程空闲=100 · 断续 120ms=82 · 单次 2s 冻结=44 · 反复 1s 冻结×5=38 · 持续 150ms≈75。

## 特性（feature 开关，extman 功能管理面板）

| feature | type | 默认 | 说明 |
|---|---|---|---|
| `enabled` | boolean | true | 本实例显示检测器 |
| `pos` | string | left-bottom | 默认位置（可拖动后以拖动位置为准） |
| `score` | boolean | true | 流畅度评分行（关 = 纯读秒） |
| `minimize` | boolean | true | 支持最小化（关 = 只有展开态 + ✕） |
| `askAi` | boolean | true | 面板「问 AI」按钮（✨ sparkles 图标；现场报告 → aiti-helper 卡顿调试会话） |
| `inject.enabled` | boolean | false | 跨实例注入（从 `service.url` 目标实例注入外部版） |
| `service.url` | string | — | 目标 pi-web 基址（含子路径） |

## 部署

```bash
node pi-web-ext/aiti-cpu-meter/tools/build.mjs   # 构建双产物（esbuild，复用仓库根依赖）
node pi-web-ext/aiti-cpu-meter/tools/deploy.mjs  # 部署到 ~/.pi/web{,-dev}/extensions/aiti-cpu-meter/
```

生效：`POST /api/extensions/reload`（或重启 pi-web）+ 刷新页面；注入注册 reload 后生效。

## 依赖 / 结构

纯扩展：core + 双壳 + index.ts（server 资产服务 + ask-ai 建会话 + 注入注册）+ build/deploy 脚本。无 server 业务逻辑、
无 UI 插槽、无 npm 构建链（esbuild 复用仓库根）。拖动/定位：内部版面板接 aiti-float（v0.3 起，统一契约；
aiti-float 未装时静态停角位）、FAB 与外部版全自带。

## 设计说明

- 后台标签页：rAF 停发天然不采样；恢复可见时重置帧基准，不把隐藏时长当卡顿。会话统计仅可见时累计。
- 首载 2s 门控：只采集不评分，避开首帧布局大 gap。
- localStorage 键带 `aiti-cpu-meter:` 前缀，第三方网站各站域名隔离，无冲突。
- 协议唯一来源：注入注册点（`__stInjectRegistry`）归 service-tunnels，本扩展经其注册（软依赖：未装则跳过）。
