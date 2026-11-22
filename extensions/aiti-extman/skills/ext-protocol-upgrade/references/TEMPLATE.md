# vN-to-vN+1 · 迁移手册模板

> 复制本文件为 `references/v<N>-to-v<N+1>.md`，按下面结构填写。**每次协议 MAJOR bump 必须新增一本**（bump 流程见 `docs/pi-web-ext-protocol.md` §7）。
> 读者：AI（ext-protocol-upgrade skill）+ 人。目标：让 AI 能确定性地把扩展从 vN 改到 vN+1，改不了的要能识别并停下。

## 1. 版本摘要

- 协议：`vN` → `vN+1`（MAJOR bump 的原因一句话）
- 宿主侧变更：`pi-web` 哪个契约/行为改了（文件/PR/commit）
- 影响面：哪些扩展受影响（全量 / 用了某能力的子集）

## 2. 背景与根因

为什么破坏兼容（旧写法为什么在新宿主下会坏）：症状 → 根因 → 新语义。

## 3. 受影响特征清单（可 grep/可静态识别）

| # | 特征（精确模式） | 旧写法 | 新写法 | 可自动修复？ |
|---|---|---|---|---|
| 1 | 如 `ctx\.dataDir` | … | … | ✅ codemod / ❌ 需语义判断 |

> 此表未来直接喂给安装时筛查器（`aiti-extman/protocol-screen.mjs`，方案 §7）；「可自动修复」列决定 codemod 还是降级 AI。

## 4. 逐项改法（before / after 示例）

对每项给出：命中范围（server/client/部署脚本）、改法、常见误改、跨文件注意点。

```js
// ❌ 旧
const dir = ctx.dataDir;
// ✅ 新
const dir = ctx.configDir; // 或 ctx.stateDir / ctx.cacheDir
```

## 5. 验证清单

- [ ] `node scripts/check-ext-protocol.mjs --deployed` 该扩展 `ok`
- [ ] 构建（JSX client 重建）通过
- [ ] 该扩展测试 / `node scripts/test-web-ext.mjs --only <id>` 通过
- [ ] 浏览器冒烟项（列具体操作路径）
- [ ] 运行时无新告警（宿主 stderr / 页面 console）

## 6. 回滚与注意

- 旧宿主上不能再跑新写法（描述双向兼容窗口）；
- 部署顺序（先宿主还是先扩展）；
- 已知坑与陷阱。
