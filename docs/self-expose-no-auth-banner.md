# 方案：自暴露无认证（expose self 不带秘）时页面顶部红色 🔴 告警

## 一、需求

当 pi-web **自身被公开暴露**（`expose self`：`PI_WEB_EXPOSE` 环境变量或「服务」对话框 → Self 页手动暴露）且**未启用任何网关认证**（`auth=none`，即"不带秘"）时：

1. 页面顶部**常驻红色 🔴 提示**（不依赖打开服务对话框）。
2. **点击提示 → 弹出原因说明**：为什么危险。
3. 原因弹窗内**引导更换 expose 方法**：改用带认证的方式（portal/basic/authelia）、或改为仅 proxy、或立即停止暴露。

## 二、现状与缺口

已有防护（都在「服务」对话框**内部**）：

- 活动暴露列表对 `provider` 为空的暴露行显示 `⚠ 无认证` 红色徽标（`services.exposeProviderNone` + `noAuthWarnHint`）。
- Self 页 `warnNonLoopback`：非回环访问时显示 ⚠ 提示。
- `auth=none` / tcp 裸隧道在公开前有 `ConfirmDialog` 泄露风险确认（`confirmNoAuth*`）。

缺口：

- 以上提示全部在对话框内，**不开对话框就看不到**。自暴露无认证时，pi-web 的整个 UI（可执行任意命令、读写用户文件）对任何拿到 URL 的人完全开放，属于最高风险场景，需要**脱离对话框的全局告警**。
- 无现成判定信号：`getSelfExposeState()` 的 `auth` 字段在运行时 `auth=none` 场景下为 `null`（auth-none 的 expose 记录 `provider` 为空/undefined），无法直接区分"无认证暴露"与"未暴露"。

## 三、服务端检测

文件：`lib/service-tunnels-integration.ts` → `getSelfExposeState()`

在返回值中新增显式布尔字段 `unauthenticated`：

```ts
const selfs = st.exposes().filter((e) => e.port === port && (e.site === "pi-web" || e.name?.startsWith("expose-self-")));
const exposing = selfs.some((e) => e.running);
// 无认证 = 任一 running 自暴露通道未挂 provider（auth-none 记录 provider 为空/undefined，
// tcp 自暴露同样无 provider），或 env 配置显式 auth=none
// （mode=none 未暴露时 exposing=false，已被排除，不会误报）
const unauthenticated = exposing && (
  selfs.some((e) => e.running && !e.provider)
  || globalThis.__piWebExposeConfig?.auth === "none"
);
```

判定依据（代码事实）：

- `exposeSelf()`：`authNone = opts.auth === "none"` → binding `provider: ""`，`st.auth.expose(..., auth: "none")` → expose 记录 `provider: undefined`；带认证时记录必有 provider（portal/basic/…）。
- 任何一条 running 通道无认证即告警（多条通道只要有一条"裸奔"就算）。

## 四、轻量 API

文件：`app/api/service-tunnels/route.ts`（GET）

新增 `?self-only=1` 短路，只返回 self 状态（放在 `ensureSites` / `listPiServices` / schemas 本地化等重活**之前**）：

```ts
if (request.nextUrl.searchParams.get("self-only") === "1") {
  return NextResponse.json({ self: getSelfExposeState() });
}
```

## 五、顶栏告警（事件驱动，**不轮询**）

### 触发时机：会话加载完成信号

不设定时器轮询。告警刷新完全由事件驱动：

1. **新会话 / 老会话加载完成后延迟拉一次**：ChatWindow 每次（重）挂载对应 `sessionKey` 自增 + `selectedSession?.id` 变化（选老会话、新会话拿到真实 id、初始 URL 恢复）。AppShell 用这两个值合成一个信号传给 SelfExposeAlert：

```tsx
// 会话加载完成信号：ChatWindow 重挂载 / 会话 id 确立时变化
const sessionLoadedKey = `${sessionKey}:${selectedSession?.id ?? "new"}`;
...
<SelfExposeAlert sessionLoadedKey={sessionLoadedKey} onOpenServices={...} />
```

2. **页面初始加载**：mount 后延迟拉一次（覆盖尚未选会话的场景）。
3. **后台标签暂停；`visibilitychange`（回到可见）/ `focus` / `online` 时延迟刷新**：监听这三个事件，仅当 `document.visibilityState === "visible"` 才触发，且防抖合并（连续事件只刷一次）。

### 新组件 `components/SelfExposeAlert.tsx`

- **`load()`**：拉一次 `GET /api/service-tunnels?self-only=1` → `{ self: { exposing, unauthenticated } }`。
- **延迟**：会话加载信号变化后 `setTimeout` ~1s 再拉（让 useAgentSession 的初始加载先落地）；visible/focus/online 走 ~500ms 防抖 + 延迟；每次只拉**一次**，无任何 interval。
- **显示条件**：`self.exposing === true && self.unauthenticated === true`，且未被本次会话 dismiss。
- **渲染**：红色细条，插在顶栏（topBar）闭合处（AppShell.tsx ~1616 行）与内容区之间，全宽、不遮挡交互：
  `🔴 <标题> · <一行摘要> [查看原因 ›] [×]`
- **dismiss**：内存态（useState）——刷新页面/重启后自动重现，安全告警不做长期静默。

### AppShell 集成

```tsx
const [servicesInitialTab, setServicesInitialTab] = useState<Tab>(); // Tab = "ports" | "self" | "users"
...
<SelfExposeAlert
  sessionLoadedKey={sessionLoadedKey}
  onOpenServices={() => { setServicesInitialTab("self"); setServicesOpen(true); }}
/>
...
{servicesOpen && (
  <ServicesDialog
    onClose={() => setServicesOpen(false)}
    onOpenFile={handleOpenFile}
    initialTab={servicesInitialTab ?? "ports"}
  />
)}
```

### `components/ServicesDialog.tsx` 小改

增加可选 prop `initialTab?: "ports" | "self" | "users"`，`useState` 初值用它（默认 `"ports"`）——从告警进入时直接停在 **Self 页**，用户当场把 `auth` 从 `none` 改成 portal/basic 并重新暴露。

## 六、交互：点击 → 原因 → 换方法

原因弹窗（固定遮罩、风格与现有 ConfirmDialog 一致，zIndex 1100）：

- **标题**：`⚠ 自暴露未启用认证`
- **原因正文**：pi-web 承载 agent 会话，可执行任意命令、读写用户文件；无认证暴露 = 任何拿到地址的人都能完全控制 → 数据泄露 / 被利用风险。说明即使 `allowlocal` 关闭，开放的虚拟主机 / 隧道入口依然可经部署域访问。
- **建议（更换 expose 方法，逐条）**：
  1. 换成带认证的方法：「服务 → 暴露 pi-web 自身」把认证从 `none` 改为 portal / basic（或 authelia），并确保该站点下有可登录用户（可开 2FA）。
  2. 或模式改为仅 proxy（本地虚拟主机，受 allowlocal / 密码门禁约束），不开启隧道。
  3. 或立即停止暴露。
- **按钮**：
  - `去更换暴露方式`（主按钮）→ 打开服务对话框并停在 Self 页。
  - `立即停止暴露`（红色）→ `POST { action: "self-stop" }`，成功后本地立即隐藏告警并刷新状态。
  - `知道了（本次会话不再提示）`（次按钮）→ dismiss。

## 七、i18n

`lib/i18n/messages/en.ts` / `zh-CN.ts` 新增：

| key | zh-CN（示意） | en（示意） |
| --- | --- | --- |
| `services.selfNoAuth` | 自暴露未启用认证 | pi-web exposed without authentication |
| `services.selfNoAuthSummary` | 任何拿到地址的人都能完全控制 | anyone with the URL can fully control it |
| `services.selfNoAuthReason` | 为什么需要处理 | Why this matters |
| `services.selfNoAuthBody` | pi-web 可执行命令、读写文件… | pi-web can run commands / read files… |
| `services.selfNoAuthSuggest` | 换带认证的暴露方式 / 仅 proxy / 停止（多行） | switch to an authed method / proxy-only / stop |
| `services.selfNoAuthOpen` | 去更换暴露方式 | Switch expose method |
| `services.selfNoAuthStop` | 立即停止暴露 | Stop exposing now |
| `services.selfNoAuthDismiss` | 本次会话不再提示 | Don't show again this session |

## 八、边界与安全

- **fail-safe**：只有服务端明确返回 `unauthenticated: true` 才显示；接口失败不显示（不误报）。
- **多条通道**：任一 running 通道无认证即告警。
- **浏览入口无关**：告警依据服务端暴露状态，而非当前浏览器是否在回环访问——暴露本身即风险。
- **停止幂等**：`self-stop` 停隧道 + 移除 binding，可随时重新暴露。
- **无轮询开销**：只会在会话加载完成后 / 页面回到前台时各拉一次；后台标签零请求。

## 九、文件改动清单

1. `lib/service-tunnels-integration.ts` — `getSelfExposeState()` 增加 `unauthenticated` 字段。
2. `app/api/service-tunnels/route.ts` — GET `?self-only=1` 短路。
3. `components/SelfExposeAlert.tsx` — 新组件（事件驱动单次拉取 + 条幅 + 原因弹窗 + 停止 / 跳转 / dismiss；visible/focus/online 防抖刷新）。
4. `components/AppShell.tsx` — 合成 `sessionLoadedKey` 信号、集成条幅 + `servicesInitialTab` 状态。
5. `components/ServicesDialog.tsx` — `initialTab` prop（默认 `"ports"`）。
6. `lib/i18n/messages/en.ts` / `zh-CN.ts` — 新增 key。

## 十、测试

- 手动：
  1. `PI_WEB_EXPOSE="mode=both,auth=none"` 启动 → 会话加载完成后（延迟 ~1s）页面顶部出现红色条幅 → 点击弹原因 →「去更换暴露方式」→ Self 页把 auth 改 portal 重新暴露 → 再次切换会话后条幅消失。
  2. `mode=none`（不暴露）→ 无条幅。
  3. `auth=portal`（带认证）→ 无条幅。
  4. 停止暴露后条幅消失；dismiss 后刷新页面重现；切到后台标签再回来（visibilitychange/focus）→ 延迟刷新一次。
- 可选单测：`getSelfExposeState().unauthenticated` 的纯函数化（`globalThis.__piServiceTunnels` mock，参照 `lib/*.test.mjs` 现有模式）。
