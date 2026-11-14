# @aiti-ai/aiti-cpu-meter

> 主线程流畅度检测器——读秒 + **0-100 流畅度分** + **颜色分层** + **最小化** + **AI 卡顿调试**。内部版（pi-web 扩展）/ 外部版（standalone 单文件，可注入任意网站）双产物。

[English](./README.md) · 简体中文

## 关于 aiti

本包是 **aiti** 生态的组成部分——以 [pi](https://pi.dev) 为引擎的个人 AI 开发工作台与本地调试注入生态：**aiti-agent**（自托管 Web 工作台，基于开源项目 [pi-web](https://github.com/aiti-ai/pi-web) 构建，浏览器为主操作面）+ 各开发工具内的调试注入（aiti-devtools）+ 丰富的扩展体系。

- 工作台（aiti-agent，基于 pi-web）: <https://github.com/aiti-ai/pi-web>
- 生态仓库: <https://github.com/aiti-ai/aiti-ai>
- 官网: <https://aiti.pw>

## 功能定位

| 能力 | 说明 |
|---|---|
| **流畅度评分** | 0-100（100=流畅，0=卡死），Apdex/INP/TBT 锚定的 gap 幅值曲线 + 阻塞/冻结惩罚，4 档颜色 |
| **读秒器** | rAF 驱动，主线程卡死即冻结（诊断卡死时刻的硬信号） |
| **会话统计** | 全程时间加权**平均流畅度** + **运行时长** + **最低谷**——工作全程挂着，收工点开看整体表现 |
| **最小化** | 缩成小图标（色点 + 实时分数），拖到不碍事处长期跑着；位置/状态持久化 |
| **现场报告 report()** | `window.__aitiCpuMeter.report()` 一键取全套现场：评分/窗口平均/gap/长任务/**LoAF 脚本归因**/卡顿快照/环境 |
| **✨ 问 AI** | 面板按钮 → 现场报告交 aiti-helper 建「调试页面卡顿」会话（内部版）；或 POST 回 pi-web 建会话并自动跳转（外部版） |
| **双产物** | 内部版（pi-web 扩展，features 控制）+ 外部版（standalone 单文件，任意网站注入） |

## 三通道注入（开发者评估自己的网站）

### ① service-tunnels 注入（主路径：被代理/公开的站点）

在 service-tunnels 公开/代理自己的站点端口时，公开表单勾选 **CPU 流畅度检测器** → 该通道的 HTML 响应自动注入外部版（无需改自己网站代码）。注册源 id=`aiti-cpu-meter`。

### ② bookmarklet（任意未代理网站）

```
javascript:(()=>{if(window.__aitiCpuMeter){window.__aitiCpuMeter.dispose();return;}const s=document.createElement('script');s.src='https://<pi-web 域>/api/extensions/aiti-cpu-meter/aiti-cpu-meter.js';s.defer=true;document.head.appendChild(s)})()
```

执行一次注入、再执行一次卸载。可带参数：`aiti-cpu-meter.js?meter-pos=right-top&meter-score=off&meter-min=off`。

### ③ 跨实例注入（feature：service.url + inject.enabled）

从目标 pi-web 实例拉外部版注入当前页。

## 交互

- **最小化**：标题栏 **−** → 缩成小图标（色点 + 实时两位分数），可拖动，点开展开。
- **拖动**：内部版面板走 aiti-float 契约（拖动/位置持久化接管）；外部版面板 + FAB 自带拖动，位置持久化。
- **关闭**：**✕** 只隐藏当前页（刷新重现）；最小化/展开状态持久化。
- 展开态面板：第一行当前分（大）+ 10 格色条；第二行会话统计（平均/运行/最低）；下面保留原始诊断行（CPU 读秒 / gap / max / longtask / 上次卡顿快照）。

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
校准：全程空闲=100 · 断续 120ms=82 · 单次 2s 冻结=44 · 反复 1s 冻结×5=38 · 持续 150ms≈75。

## 特性（feature 开关，extman 功能管理面板）

| feature | type | 默认 | 说明 |
|---|---|---|---|
| `enabled` | boolean | false | 本实例显示检测器（默认关，extman「功能管理」打开） |
| `pos` | string | left-bottom | 默认位置（可拖动后以拖动位置为准） |
| `score` | boolean | true | 流畅度评分行（关 = 纯读秒） |
| `minimize` | boolean | true | 支持最小化（关 = 只有展开态 + ✕） |
| `askAi` | boolean | true | 面板「问 AI」按钮（✨；现场报告 → aiti-helper 卡顿调试会话） |
| `inject.enabled` | boolean | false | 跨实例注入（从 `service.url` 目标实例注入外部版） |
| `service.url` | string | — | 目标 pi-web 基址（含子路径） |

## 设计说明

- 后台标签页：rAF 停发天然不采样；恢复可见时重置帧基准，不把隐藏时长当卡顿。会话统计仅可见时累计。
- 首载 2s 门控：只采集不评分，避开首帧布局大 gap。
- localStorage 键带 `aiti-cpu-meter:` 前缀，第三方网站各站域名隔离，无冲突。
- 注入注册点（`__stInjectRegistry`）归 service-tunnels，本扩展经其注册（软依赖）。

## 安装

随 **aiti-agent**（`@aiti-ai/pi-web`）捆绑发行——在工作台内的扩展管理器（ExtMan / 应用中心）启用即可。

手动安装：把本包放到 `~/.pi/web/extensions/aiti-cpu-meter/` 后 reload。外部版产物由 `/api/extensions/aiti-cpu-meter/aiti-cpu-meter.js` 提供。

## 文档

- 中文文档: <https://aiti.pw/extensions/aiti-cpu-meter.html>
- Documentation (English): <https://aiti.pw/en/extensions/aiti-cpu-meter.html>
- 扩展注册表: <https://aiti.pw/extensions.html> · machine-readable <https://aiti.pw/extensions.json>

## 许可证

MIT
