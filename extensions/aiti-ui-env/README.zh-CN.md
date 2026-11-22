# @aiti-ai/aiti-ui-env

> 后台无头服务器 UI 调试的环境分配器 —— 4 态模式裁决新启动 MCP/应用的显示环境，Xvfb+openbox+picom+AT-SPI 虚拟屏 + VNC-on-web + RDP-on-web，Linux/Windows/macOS 三平台服务化；VNC 密码由 VNC server 自己认证（桥纯透传）

[English](./README.md) · 简体中文

## 关于 aiti

本包是 **aiti** 生态的组成部分——以 [pi](https://pi.dev) 为引擎的个人 AI 开发工作台与本地调试注入生态：**aiti-agent**（自托管 Web 工作台，基于开源项目 [pi-web](https://github.com/aiti-ai/pi-web) 构建，浏览器为主操作面）+ 各开发工具内的调试注入（aiti-devtools）+ 丰富的扩展体系。

- 工作台（aiti-agent，基于 pi-web）: <https://github.com/aiti-ai/pi-web>
- 生态仓库: <https://github.com/aiti-ai/aiti-ai>
- 官网: <https://aiti.pw>

分类: 调试 · tags: `headless` · `xvfb` · `vnc` · `rdp` · `atspi` · `audio` · `pipewire` · `pulseaudio` · `display` · `virtual-desktop` · `noVNC` · `vnc-password`

## 安装

随 **aiti-agent**（`@aiti-ai/pi-web`）捆绑发行——在工作台内的扩展管理器（ExtMan / 应用中心）启用即可。

手动安装：把本包放到 `~/.pi/web/extensions/aiti-ui-env/` 后 reload。

服务化（虚拟屏常驻，Linux）：

```bash
cd scripts/linux && ./setup-linux.sh && ./install-service.sh
```

## 文档

- 中文文档: <https://aiti.pw/extensions/aiti-ui-env.html>
- Documentation (English): <https://aiti.pw/en/extensions/aiti-ui-env.html>
- 扩展注册表: <https://aiti.pw/extensions.html> · machine-readable <https://aiti.pw/extensions.json>

## 音频会话（Linux，默认开）

经 `resolve` / `run` / 无头虚拟屏启动的 GUI 应用会继承用户的 PipeWire/Pulse 会话，
即使 pi-web 本身由 systemd 或 SSH 启动：

- `PULSE_SERVER=unix:/run/user/<uid>/pulse/native`
- `PIPEWIRE_RUNTIME_DIR=/run/user/<uid>`

路径按当前 uid 自动探测，只在 socket 存在时注入；父进程已显式设置的值优先。扩展启动时
也会把音频环境 hydrate 到进程 env，agent bash 会话可直接继承。开关在扩展管理器
（ExtMan）→ aiti-ui-env → 功能管理 → **音频输出（Linux PipeWire/Pulse）**，**默认开**；
关闭后不改动任何音频环境变量。

## ARGB compositor（2026-11-21）

Linux 虚拟屏在 WM 之后自动启动 **picom**（缺失时回退 compton/xcompmgr），用于 Tauri/GTK 透明字幕窗：

- 裸拉起：`--bare` / `ensureHeadless` 自动启动，按 `DISPLAY=:N` 进程级幂等
- systemd：新增 `ui-env-compositor.service`，target 的 `Wants` 引入；ExecStart 自动选 picom/compton/xcompmgr
- setup 脚本：依赖清单增加 `picom`，安装后无需手工启动
- 停止虚拟屏：`stopHeadless` 一并清理该 display 的 compositor
- 验证：`DISPLAY=:N picom --backend xrender --no-vsync` 运行后，24/32-bit Xvfb 上的 Tauri caption 透明

## 许可证

MIT
