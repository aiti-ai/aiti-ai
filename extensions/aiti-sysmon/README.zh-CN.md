# aiti-sysmon（服务器状态查看器）

pi-web 所在服务器的实时状态面板：左栏停靠块「系统状态」，一眼看到 **CPU / 内存 / 磁盘 / 网络 / 温度 / 传感器**。
数据来自 [`systeminformation`](https://www.npmjs.com/package/systeminformation)（纯 JS、零原生编译、跨平台）。
npm 包：[`@aiti-ai/aiti-sysmon`](https://www.npmjs.com/package/@aiti-ai/aiti-sysmon)。

## 能力

- **OS 头行**：主机名 · 发行版 · 内核 · 运行时长
- **CPU**：总占用大数字 + 60 点迷你历史条 + 每核小条 + loadavg + 温度
- **传感器**：全芯片温度列表（lm-sensors 风格），直读内核 `/sys/class/hwmon`（k10temp / nvme / amdgpu /
  acpitz 等），阈值变色（≥70 琥珀、≥90 红）；平台无可读传感器时整区隐藏
- **内存**：RAM 已用/总量条 + swap 条
- **磁盘**：各挂载点已用/总量条（≥80% 琥珀、≥90% 红；自动滤掉 squashfs/loop/efivarfs 噪音挂载）
- **网络**：各真实网卡 ↓/↑ 实时速率 + 累计流量（自动滤 lo / docker 桥 / veth，保留 VPN 隧道），非 up 半透明
- **底部工具行**：暂停/恢复 + 手动刷新 + 间隔快捷切换（2s / 5s / 15s）
- **多语言**：面板文案全量中英双语，跟随宿主 UI 语言

## 工作方式（零常驻开销）

- **服务端**：只读快照 API `GET /api/extensions/aiti-sysmon/snapshot`，**无后台定时器**——速率类数值
  （CPU 占用 %、网卡每秒速率）由 systeminformation 在相邻两次调用间做 delta，客户端轮询节奏即采样窗口；
  慢变数据（磁盘 30s / OS 信息 10min / 温度 5s / hwmon 扫描 5s）服务端 TTL 缓存，单次轮询开销极低。
- **客户端**：左栏停靠 face（bundle 常驻加载；与「任务」区块同语义自动入栈，默认折叠）。仅当面板**展开、
  页面可见、未暂停**时才轮询；折叠或切后台立即停止；首帧渲染布局镜像骨架屏（pulse 动画尊重
  `prefers-reduced-motion`）；CPU 迷你历史条为客户端内存内最近 60 点，**不落盘**。
- **温度**：平台读不到 → `temp: null`，面板显示 N/A + 「如何启用？」链接 → 配置指南：
  <https://aiti.pw/extensions/aiti-sysmon.html>

## 设置（扩展管理器）

| id | 类型 | 默认 | 含义 |
|---|---|---|---|
| `interval` | string | `3` | 面板展开时的轮询间隔（秒） |
| `showSensors` | boolean | 开 | 显示温度行 + 传感器芯片列表 |

## 温度显示 N/A？（Linux）

温度读内核 hwmon 子系统（`/sys/class/hwmon`，sysfs）——AMD `k10temp` / Intel `coretemp` 等驱动内核自带、
通常自动加载，**无需用户态工具**。若 CPU 温度仍为 N/A（驱动未加载/老内核），安装并探测 lm-sensors：

```bash
sudo apt install lm-sensors && sudo sensors-detect   # Debian/Ubuntu
sudo dnf install lm_sensors && sudo sensors-detect   # RHEL/Fedora
sudo pacman -S lm_sensors && sudo sensors-detect     # Arch
sensors                                              # 验证出数
```

无需重启 pi-web——下一个轮询周期（≤5s 温度缓存过期）即显示。Windows 主机：核心温度通常拿不到（按
N/A 降级）；CPU/内存/磁盘/网络不受影响。

## 目录结构

```
index.ts            manifest + server.api（snapshot）
core.cjs            纯函数层（格式化/TTL 缓存，带单测，client bundle 共用）
client/src/         JSX 源码（vite lib 构建 → dist/aiti-sysmon-client.mjs）
icons/              扩展本地图标（dock 头行用 icons/gauge.svg）
tools/              build-client.mjs / deploy.mjs
test/core.test.mjs  node:test 单测
```

## 构建与部署

```bash
npm install                      # client 构建用 vite
node tools/deploy.mjs            # 构建 → 拷贝双实例 → 依赖 reconcile → 热重载
```

服务端运行时依赖 `systeminformation` 声明在 `package.json` `dependencies`，由 aiti-extman reconcile
装入共享 web-root `node_modules`（部署脚本按红线不装依赖、不拷 node_modules）。

## 测试

```bash
node --test test/core.test.mjs   # 或 pi-work scripts/test-web-ext.mjs --only aiti-sysmon
```

## 许可

MIT — 见 [LICENSE](LICENSE)。
