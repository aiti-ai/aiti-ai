# @aiti-ai/aiti-ui-env

> 后台无头服务器 UI 调试的环境分配器 —— 4 态模式裁决新启动 MCP/应用的显示环境，Xvfb+openbox+AT-SPI 虚拟屏 + VNC-on-web + RDP-on-web，Linux/Windows/macOS 三平台服务化；VNC 密码由 VNC server 自己认证（桥纯透传）

## 来源 · Origin

本包是 **aiti** 生态的组成部分——以 [pi](https://pi.dev) 为引擎的个人 AI 开发工作台与本地调试注入生态：**aiti-agent**（自托管 Web 工作台，基于开源项目 [pi-web](https://github.com/aiti-ai/pi-web) 构建，浏览器为主操作面）+ 各开发工具内的调试注入（aiti-devtools）+ 丰富的扩展体系。

This package is part of the **aiti** ecosystem — a personal AI development workbench powered by [pi](https://pi.dev): **aiti-agent** (a self-hosted web workbench built on the open-source [pi-web](https://github.com/aiti-ai/pi-web)) plus debug injection into mainstream dev tools (aiti-devtools) and a rich extension system.

- 工作台 / workbench: <https://github.com/aiti-ai/pi-web>
- 生态仓库 / monorepo: <https://github.com/aiti-ai/aiti-ai>
- 官网 / site: <https://aiti.pw>

## 功能定位（中文）

后台无头服务器 UI 调试的环境分配器 —— 4 态模式裁决新启动 MCP/应用的显示环境，Xvfb+openbox+AT-SPI 虚拟屏 + VNC-on-web + RDP-on-web，Linux/Windows/macOS 三平台服务化；VNC 密码由 VNC server 自己认证（桥纯透传）

调试 · tags: `headless` · `xvfb` · `vnc` · `rdp` · `atspi` · `display` · `virtual-desktop` · `noVNC` · `vnc-password`

## Positioning (English)

Environment allocator for UI debugging on headless background servers — a 4-state mode arbiter decides whether newly launched MCP/apps land on a real desktop or an Xvfb headless virtual display (Xvfb+openbox+AT-SPI virtual display + VNC-on-web + RDP-on-web), service-ized on Linux/Windows/macOS; the VNC password is authenticated by the VNC server itself (the bridge is pure passthrough)

## 安装 / 部署

```bash
# 部署到 ~/.pi/web/extensions/aiti-ui-env/ 后 reload：
cd pi-web-ext/aiti-ui-env && node tools/deploy.mjs
curl -X POST http://127.0.0.1:<端口>/api/extensions/reload
# 服务化（虚拟屏常驻）：
cd scripts/linux && ./setup-linux.sh && ./install-service.sh
```

## 文档 · Documentation

- 中文完整文档（aiti-docs）: <https://aiti.pw/extensions/aiti-ui-env.html>
- English docs: <https://aiti.pw/en/extensions/aiti-ui-env.html>
- 扩展注册表 / registry: <https://aiti.pw/extensions.html> · machine-readable <https://aiti.pw/extensions.json>

## License

MIT
