# 主流软件扩展机制调研 — 对 pi-web 扩展方案的启示

> 调研对象分两大类：**AI 类软件**（与 pi-web 场景最接近）与**常用企业软件**。
> 目的：验证 `docs/service-tunnels-extension.md` 的插入点设计，并借鉴各家的
> 成熟做法（动态加载、安全模型、分发渠道、前端扩展）。

---

## 1. AI 类软件

### 1.1 OpenAI GPTs / Actions — 声明式 + 云托管

- **形态**：Custom GPT = 系统提示词 + 知识文档 + **Actions**（上传 OpenAPI schema，
  声明可调用的外部 API）；无自定义代码运行在 OpenAI 侧，逻辑全在外部服务。
- **扩展点**：模型侧无扩展，扩展=外部 HTTP API（schema 声明化接入）。
- **动态加载**：运行时启用/停用，零部署（外部 API 自己部署）。
- **对我们的启示**：声明式 schema（OpenAPI）接入外部能力是"最薄扩展"；但
  service-tunnels 需要进程内特权（起隧道进程、读端口、改 middleware 决策），
  纯 HTTP 协议化不适用——**必须保留命令式代码**。

### 1.2 Claude / MCP（Model Context Protocol）— 协议标准

- **形态**：MCP = 统一客户端-服务端协议，MCP server 暴露 tools/resources/prompts；
  Claude、Cursor 等作为 MCP client 连接任意 server（stdio / SSE / streamable HTTP）。
- **扩展点**：模型接入外部能力 = 实现一个 MCP server，无需改 host。
- **动态加载**：运行时连接/断开，server 可独立部署、独立升级。
- **对我们的启示**：**API 协议化**——pi-web 的 catch-all API 壳可定义统一协议
  （action 命名、错误码、鉴权传递），让扩展的 client bundle 与 server handler
  松耦合；未来若 pi-web 支持 MCP client，服务发现类扩展可整体走 MCP。

### 1.3 Cursor / VS Code — contribution points + 惰性激活

- **形态**：扩展 = `package.json` 声明 **contribution points**（commands、views、
  menus、keybindings、settings）+ 代码文件（main 入口，可选）；VS Code 是 host
  进程，扩展在**独立 Extension Host 进程**运行（崩溃隔离）。
- **动态加载**：**activation events 惰性激活**（`onCommand:foo`、`onView:bar`、
  `onStartupFinished`…）——声明了才加载；运行时 enable/disable，无需重启。
- **分发**：市场（marketplace）+ `code --install-extension`；本地目录开发模式。
- **对我们的启示**：
  1. **惰性激活**直接可抄：扩展 manifest 声明 `activationEvents`
     （如 `onApi:service-tunnels`、`onUi:toolbar`、`onStartup`），core 按需加载，
     不必启动时全 load；
  2. **进程隔离**（Extension Host）是 Dify daemon 之外的另一种沙箱模型；
  3. UI 挂载点（menus/views）本质就是我们的插槽，验证了「manifest 声明 + host
     渲染」的可行性。

### 1.4 n8n — npm 节点包 + 社区市场

- **形态**：节点（node）= npm 包（`n8n-nodes-*`），导出 `NodeDefinition`；core
  从 `~/.n8n/nodes`（外部目录）加载。官方 + 社区市场双渠道。
- **动态加载**：**外部目录扫描**，重启/热加载后生效。
- **对我们的启示**：目录扫描加载（与 pi 的 `~/.pi/agent/extensions` 一致）
  + npm 包分发，正是我们 Phase 2/3 的路线。

### 1.5 Dify — 独立插件 daemon + gRPC + 远程调试

- **形态**：插件 = Python（pip 包）或 Node（npm 包），**由独立 daemon 进程
  运行**，宿主 API server 经 gRPC 通信；模型/工具/Agent 策略/数据源全部插件化。
- **动态加载**：安装/卸载/启停走 daemon 生命周期；**远程调试**（本地起插件，
  平台通过 host:port + API key 连入）；本地 / debug / serverless 三种 runtime。
- **安全模型**：插件与 core 进程隔离，gRPC 是唯一通道。
- **对我们的启示**：这是**进程级隔离**最完整的实现——我们 Phase 3 的沙箱方案
  可直接对照：worker_threads / child_process + IPC，而不是 vm（js 生态里
  worker 更可靠）。

### 1.6 Open WebUI — 服务器端任意 Python + 多层扩展

- **形态**：Tools / Functions / Pipes / Filters / Pipelines 五类，**全部在
  服务器执行任意 Python**（官方明说"by design，这就是它们强大的原因"）；
  Pipelines 是独立于 UI 的 OpenAI API 插件框架（UI-agnostic）。
- **动态加载**：UI 内启停；Pipelines 可独立部署。
- **安全模型**：信任即全部能力——与我们的"扩展=完全服务器权限"认知一致，
  印证了信任目录模型的普遍性。
- **对我们的启示**：功能分层（tool/pipe/filter 各自职责）值得借鉴——
  service-tunnels 扩展可拆成「middleware 决策层 / API 管理层 / UI 层」三个
  内部分层，便于未来各自独立开关。

### 1.7 OpenHands — 插件打包 agent 组件 + 事件流

- **形态**：SDK 化核心（immutable 事件流 + 无状态 agent）；插件 = 打包
  Skills / 子代理 / 工具等组件的分发单元。
- **对我们的启示**：核心保持**小、无状态、事件驱动**，扩展包成组件集合——
  与 pi-web 现状（core 无状态 API + 进程内单例）一致，方向正确。

### 1.8 pi 自身（本仓库依赖的 agent）

- 形态：`~/.pi/agent/extensions/`（全局）/ `.pi/extensions/`（项目）目录扫描，
  **jiti 运行时加载 TS**，导出 default factory 接收 `ExtensionAPI`
  （`pi.on` / `pi.registerTool` / `pi.registerCommand` …）；支持单文件/目录/
  npm 包三种布局；`/reload` 热重载；工厂函数可异步。
- 对 pi-web 的启示：**同源方案直接复用**——加载器（jiti）、目录约定、三种布局、
  热重载语义都可以照搬，降低理解成本。

---

## 2. 常用企业软件

### 2.1 Jira / Atlassian Forge — serverless 托管 + manifest 权限声明

- **形态**：Forge = 云原生 serverless 平台（**Deno 运行时**，JS/TS），应用
  manifest 声明（permissions/scopes、modules、triggers）；Atlassian 托管运行、
  内建 API 认证；web trigger 暴露 HTTP 入口；本地开发 CLI（forge deploy 一键）。
- **安全模型**：**权限声明集中在 manifest**（scope 列表），平台强制最小权限；
  代码不接触客户基础设施。
- **对我们的启示**：
  1. **manifest 权限声明**（fs 范围 / 端口 / 进程 / 网络能力）值得抄进我们的
     扩展 API——加载时校验并展示，用户知情；
  2. 托管/部署由平台负责（对我们是"代码随 pi-web 分发"）vs 自托管（对我们
     是"外部目录"）两条路线都成立，Forge 验证了前者的产品化路径。

### 2.2 GitLab — 以 webhook + REST API 为中心

- **形态**：**无通用插件运行时**；扩展方式 = 项目级 integrations（官方适配器
  清单）+ **webhook**（事件 → 外部 URL）+ 完整 REST/GraphQL API。
- **对我们的启示**：企业软件里"API 为中心"的集成是主流且低维护——pi-web 的
  `/api/service-tunnels` 本身就是这种集成面；但 service-tunnels 需要
  **middleware 决策注入**（GitLab 做不到，只能 webhook 出站），所以纯 API 模型
  不够，仍需插件式插入点——这正是我们的方案比 GitLab 模型更重的原因。

### 2.3 WordPress — action/filter 钩子 + 目录插件

- **形态**：插件 = PHP 文件放 `wp-content/plugins/<name>/`（目录扫描），**hook
  系统**：`add_action` / `add_filter`（事件/过滤双向），插件间互相钩子；
  主题也参与钩子。激活/停用生命周期函数。
- **对我们的启示**：钩子模型=我们 middleware 钩子 + API 分发 + 前端插槽的
  同构物；目录布局（`plugins/<name>/`）+ 生命周期（activate/deactivate）直接
  对应我们的 `loadAll/startAll/shutdown`。WordPress 生态证明该模型的长期可维护性。

### 2.4 Jenkins — 最成熟的插件框架，也是兼容性泥潭

- **形态**：插件 = Java jar + `hpi` 包，声明 extension points（扩展点接口）；
  独立类加载器（插件间隔离）；系统内安装/升级；与核心严格版本耦合。
- **教训**：**插件 API 版本化 + 兼容策略是生死线**（Jenkins 插件与核心版本
  强耦合导致升级地狱）。我们的扩展 API 必须：版本化（manifest 声明
  `compatVersion`）、注册表加载时校验、明确 deprecated 路径。

### 2.5 Chrome（浏览器扩展）— manifest + 最小权限 + 隔离

- **形态**：manifest v3 = 声明 permissions/host_permissions/content_scripts/
  background（service worker）+ 可选最小权限原则；UI 扩展 = 图标 badge +
  action popup + content scripts 注入页面；代码与页面隔离。
- **动态加载**：加载/卸载/更新即生效（开发者模式 reload）。
- **对我们的启示**：**最小权限 + 能力声明**的浏览器侧对应物——我们前端
  bundle 只应获得 manifest 声明的插槽权限；popup/badge ≈ 我们的 toolbar 插槽
  + 状态点。

### 2.6 Slack — app + 事件订阅 + 双通道

- **形态**：app 声明（manifest：scopes、event subscriptions、slash commands、
  interactive components），Slack 推送事件到外部 HTTPS 端点（或 socket mode）；
  逻辑在外部服务。
- **对我们的启示**：事件订阅（event subscription）对应我们可选的
  `extension events`（如暴露状态变更 → 通知扩展），未来可加。

---

## 3. 横向对比表

| 软件 | 代码形态 | 托管方式 | 动态加载 | 前端/UI 扩展 | 安全模型 | 分发 |
|---|---|---|---|---|---|---|
| GPTs/Actions | 声明式 OpenAPI | 外部（用户侧） | 运行时启停 | ❌（无 UI） | 外部 API 自担 | 商店/分享 |
| MCP | 命令式 server | 独立进程 | 运行时连接 | ❌ | server 权限自担 | 目录/市场 |
| VS Code/Cursor | contribution points + 命令式 | host 内独立进程 | **惰性激活** + 运行时启停 | ✅（views/menus 声明 + Webview） | 用户授权 + 权限提示 | 市场 + 目录 |
| n8n | 命令式 node 包 | 进程内 | 目录扫描 | ✅（节点配置表单） | 无强隔离 | npm + 社区市场 |
| Dify | 命令式包（py/js） | **独立 daemon + gRPC** | 安装/启停 API | ✅（插件前端 bundle） | **进程隔离** + 远程调试密钥 | 市场 + 手动安装 |
| Open WebUI | 命令式 Python | 进程内 | UI 启停 | ✅（内置 UI） | 信任即全部权限 | 市场 + 目录 |
| OpenHands | SDK 组件集合 | 进程内/容器 | 插件打包 | ✅ | 沙箱容器（Docker） | pip/GitHub |
| **pi（agent）** | **jiti 加载 TS，default factory + ExtensionAPI** | 进程内 | **目录扫描 + /reload 热重载** | ✅（TUI status/widget） | 信任目录 | npm/git 包 |
| Jira/Forge | manifest + Deno | **serverless 托管** | 部署即生效 | ✅（UI kit 模块） | **manifest 权限声明** | 市场 |
| GitLab | 无运行时 | 外部 | — | ❌ | 令牌/scope | 集成目录 |
| WordPress | hook + PHP 文件 | 进程内 | 目录 + activate/deactivate | ✅（主题 + hook） | 信任目录 | 市场 + 目录 |
| Jenkins | extension points + jar | 进程内独立类加载器 | 安装/升级 | ✅ | 核心版本耦合 | 市场 |
| Chrome | manifest v3 | 独立进程 | 加载即生效 | ✅（popup/注入） | **最小权限 + 声明** | 商店 |
| Slack | manifest + 事件订阅 | 外部 | 订阅启停 | ✅（block kit UI） | OAuth scope | App 目录 |

---

## 4. 对 pi-web 扩展方案的启示（方案修订建议）

### 4.1 直接采纳（成本低、收益明确）

1. **惰性激活**（VS Code）：扩展 manifest 增加 `activationEvents`（`onStartup` /
   `onApi:<path>` / `onUi:<slot>`），core 按需加载——替代"启动全 load"。
   service-tunnels 用 `onStartup` + `onMiddleware`（proxy 钩子必须启动就绪）。
2. **目录约定 + 生命周期语义对齐 pi**（WordPress/pi）：`~/.pi/web/extensions/<id>/`、
   `activate/deactivate` 语义、`/api/extensions/reload` 热重载——与 pi agent 的
   扩展心智一致，用户零学习成本。
3. **API 协议化**（MCP/GitLab 思路）：catch-all 壳定义统一协议（action 路由、
   错误码、`isApiRequestAllowed` 继承、manifest 版本），前端 bundle 与 server
   handler 解耦。
4. **外部目录 + npm 包分发双通道**（n8n/Open WebUI/pi）：本地目录用于开发/内置
   扩展，npm/git 包用于分发（复用 `/api/plugins` 的 `DefaultPackageManager`）。

### 4.2 建议纳入方案（需排期）

5. **manifest 权限声明**（Forge/Chrome）：扩展声明所需能力
   （`fs: [扩展目录]`、`port: [1-65535]`、`process: true`、`network: true`），
   registry 加载时校验并在 `/api/extensions/status` 展示；core 对越权调用
   fail-closed。这是把「扩展=完全服务器权限」收敛为「最小必要权限」的关键。
6. **进程级隔离**（Dify daemon / VS Code Extension Host）：Phase 3 将扩展
   迁入 `worker_threads`/`child_process` + IPC，崩溃隔离；middleware 钩子经
   IPC 桥接（保留 fail-closed）。注意 middleware 与 worker 的时序（请求可能
   早于 worker 就绪 → 503/403 而非裸奔）。
7. **版本化兼容层**（Jenkins 教训）：`compatVersion` 声明 + registry 校验 +
   文档化 deprecated 路径；`/api/extensions/manifest` 带 API 版本字段。

### 4.3 明确不做/低优先

8. **serverless 托管**（Forge 模式）：pi-web 是自托管单进程，serverless 托管
   不适用；但「manifest 声明 + 平台认证注入」的**接口风格**可学（扩展 API
   上下文注入 `ExtServerContext`，内含门禁后的请求上下文）。
9. **MCP server 支持**：可作为远期集成方向（把扩展能力暴露为 MCP server），
   不影响当前抽取。

### 4.4 与现有方案的对应关系（验证）

| 现有方案设计 | 对应借鉴 |
|---|---|
| `globalThis.__piWebExt` 注册表 + middleware 钩子 | WordPress action hook / VS Code host |
| `/api/extensions/[...path]` catch-all + 兼容壳 | GitLab API 为中心 + MCP 协议化 |
| `ExtSlots`（toolbar/dialogs/banners） | VS Code contribution points / WordPress 主题钩子 |
| 受信目录 + fail-closed | Open WebUI（信任即权限）+ Jenkins 版本耦合教训的反面 |
| jiti 加载 TS + 三种布局 + 热重载 | pi 自身扩展系统（同源复用） |
| Phase 3 沙箱（worker 进程） | Dify daemon / VS Code Extension Host |

---

## 5. 结论

1. **插入点设计方向正确**：所有被调研软件的扩展模型都可归结为「**声明 +
   钩子**」两类——我们的 manifest（声明）+ middleware/API/UI 插槽（钩子）符合
   主流；没有一家靠运行时注册路由（都受限于构建期静态性，与 Next 同理）。
2. **三处值得立刻补进方案**：惰性激活（activationEvents）、manifest 权限声明、
   扩展 API 版本化——都是低成本高回报。
3. **安全模型收敛路径清晰**：信任目录（现在）→ 权限声明（Phase 2）→ 进程隔离
   （Phase 3），与 Dify/VS Code 的演进一致。
4. **前端动态加载有成熟先例**：VS Code Webview、Dify 插件前端 bundle、
   Chrome content scripts 都验证了「预编译 bundle + host 插槽 + 动态 import」
   的可行性，我们的 importmap 方案不冒险。
