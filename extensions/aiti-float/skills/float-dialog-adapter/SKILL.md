---
name: float-dialog-adapter
title: AI 帮我把弹窗接入浮动契约（拖拽/缩放/小屏全屏/最大化）
placeholder: 描述你的弹窗（哪个扩展、什么布局、要不要小屏全屏/最大化按钮）…
---

# float-dialog-adapter · 扩展弹窗接入 aiti-float 浮动契约

你要帮用户把一个扩展弹窗（面板）接入 aiti-float 浮动契约。权威文档：`docs/aiti-web-ext-float-dialogs.md`（aiti-ai 仓）；参考实现：`pi-web-ext/aiti-ui-env/client/src/ui-env-app.tsx`、`pi-web-ext/demo`、`pi-web-ext/templates/ext-jsx-client`。

## 标准接入（最小改动）

只改两处，零逻辑零状态：

1. **面板根节点**（不是全屏遮罩层！）加属性：

```jsx
<div onClick={(e) => e.stopPropagation()}          {/* 面板：阻止冒泡到遮罩的点外关闭 */}
     data-ext-float="1"
     data-ext-float-w={780} data-ext-float-h={720} /* 初始尺寸 px */
     data-ext-float-full="1"                       /* 小屏全屏（≤640px 宽或 ≤700px 高），一律加 */
     style={{ width: 780, maxWidth: "calc(100vw - 16px)",
              height: "min(720px, 86vh)", borderRadius: 12, ... }}>
```

   - style 里的 width/height/borderRadius **保留**——它们是未装 aiti-float 时的兜底样式；float 接管后用 `!important` 覆盖，React 重渲染冲不掉。
2. **内容区**包一层 `style={{ flex: 1, overflowY: "auto", minHeight: 0 }}`（float 会给面板补 `display:flex; flex-direction:column; overflow:hidden` 布局基线）。

自动获得：标题栏拖拽移动（首个子元素 = 把手）、边缘/右下角缩放、位置尺寸持久化、点按置前、视口夹紧、双击把手复位、**小屏自动全屏**（跨断点动态切换，勿再手写 matchMedia/useSmallScreen 切样式）。

## 属性速查

| 属性 | 用途 |
|---|---|
| `data-ext-float` | `"1"` 移动+缩放；`"drag"` 仅移动；`"resize"` 仅缩放 |
| `data-ext-float-drag` | 标在子元素上=指定拖拽把手（缺省第一个子元素） |
| `data-ext-float-w/-h` | 初始尺寸 px |
| `data-ext-float-min-w/-min-h` | 最小尺寸（缺省 320×200） |
| `data-ext-float-autoh="1"` | 自动高度：高度随内容不接管（内容高度不定的弹窗用，如向导首页） |
| `data-ext-float-key` | 持久化键（缺省按框架 `data-ext-item` 反查，一般不用填） |
| `data-ext-float-full` | 小屏全屏（新弹窗一律加） |
| `data-ext-float-max` | `"0"`=不注入自动最大化按钮（缺省自动注入，无需任何代码） |
| `data-ext-float-keepmask` | `"1"`=保留半透明遮罩（真模态确认框用）；缺省遮罩自动去除——祖先链上半透明全屏遮罩变透明 + 点击穿透，浮窗不挡消息区 |

## 最大化按钮（v0.4.0 起自动注入，零代码）

float 增强面板时自动往标题栏塞 ⛶/❐ 按钮（插在最后一个交互元素=通常 ✕ 之前），
点击切换最大化并同步图标；小屏全屏态自动隐藏。**扩展什么都不用写**。

确要自绘/豁免：面板加 `data-ext-float-max="0"`，再用 API：

```jsx
<button onClick={(e) => {
  const panel = e.currentTarget.closest("[data-ext-float]");
  setMaximized(window.__piweFloat.toggleMax(panel)); // 返回切换后状态，同步图标
}}>
  {maximized ? "还原" : "全屏"}
</button>
```

React state 只存图标状态；不要自己切 style、不要 key 重挂载。另有 `__piweFloat.setMax(p,v)` / `.isMax(p)` / `.isFull(p)`。
**不要自备 toggleMax 按钮**（extman / ai-usage / ai-schedule / subagents 已迁移到自动注入）。

## 检查清单（改完逐项过）

- [ ] 属性加在**面板**上，不是遮罩 div 上
- [ ] 面板有点击遮罩关闭时，面板内 `stopPropagation`
- [ ] 内容区有 `flex:1 + overflow:auto` 包裹层
- [ ] 小屏适配用 `data-ext-float-full`，删掉了手写的 matchMedia/useState 全屏逻辑
- [ ] 弹窗没有自己的自绘拖拽逻辑（有的话**不接**，两套手势打架——如 ai-helper）
- [ ] 构建部署：对应扩展 `tools/deploy.mjs` + `POST /api/extensions/reload`，刷新页面开弹窗验证：能拖/能缩/关开重开位置还在/窄窗下铺满
