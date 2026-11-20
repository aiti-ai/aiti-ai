# aiti-sysmon（服务器状态查看器）

pi-web 所在服务器的实时状态面板：左栏停靠块，一眼看到 **CPU / 内存 / 磁盘 / 网络 / 温度**。数据来自
[`systeminformation`](https://www.npmjs.com/package/systeminformation)（纯 JS、零原生编译、跨平台）。

## 工作方式

- **服务端**：只读快照 API `GET /api/extensions/aiti-sysmon/snapshot`，全程**无后台定时器**——速率类数值
  （CPU 占用 %、网卡 rx/tx 每秒）由 systeminformation 在相邻两次调用间做 delta，客户端轮询节奏即采样窗口；
  慢变数据（磁盘 30s / OS 信息 10min / 温度 5s）服务端 TTL 缓存，单次轮询开销极低。
- **客户端**：左栏停靠 face（懒加载，展开才物化 bundle）。仅当面板展开、页面可见、未暂停时采样；
  折叠/切后台立即停止；CPU 迷你历史条为客户端内存内最近 60 点，**不落盘**。
- **温度**：平台读不到（Linux 未装 lm-sensors、多数 Windows 主机）→ `temp: null`，面板显示
  `TEMP N/A` + 「如何启用？」链接 → 配置指南：<https://aiti.pw/extensions/aiti-sysmon.html>

## 设置（扩展管理器）

| id | 类型 | 默认 | 含义 |
|---|---|---|---|
| `interval` | string | `3` | 面板展开时的轮询间隔（秒） |
| `showSensors` | boolean | 开 | 显示 CPU 温度行（读不到显示 N/A + 指引链接） |

## 构建与部署

```bash
npm install                      # client 构建用 vite
node tools/deploy.mjs            # 构建 → 拷到 ~/.pi/web{,-dev}/extensions/aiti-sysmon → 热重载
```

服务端运行时依赖 `systeminformation` 声明在 `package.json` `dependencies`，由 aiti-extman reconcile
装入共享 web-root `node_modules`（部署脚本按红线不装依赖、不拷 node_modules）。

## 温度启用（Linux）

```bash
sudo apt install lm-sensors && sudo sensors-detect   # Debian/Ubuntu
sudo dnf install lm_sensors && sudo sensors-detect   # RHEL/Fedora
sudo pacman -S lm_sensors && sudo sensors-detect     # Arch
sensors                                              # 验证出数
```

详见文档站 <https://aiti.pw/extensions/aiti-sysmon.html>。

## 测试

```bash
node --test test/core.test.mjs   # 或 pi-work scripts/test-web-ext.mjs --only aiti-sysmon
```
