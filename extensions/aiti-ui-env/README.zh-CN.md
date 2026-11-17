# @aiti-ai/aiti-ui-env

> 后台无头服务器 UI 调试的环境分配器 —— 4 态模式裁决新启动 MCP/应用的显示环境，Xvfb+openbox+AT-SPI 虚拟屏 + VNC-on-web + RDP-on-web，Linux/Windows/macOS 三平台服务化；VNC 密码由 VNC server 自己认证（桥纯透传）

[English](./README.md) · 简体中文

## 关于 aiti

本包是 **aiti** 生态的组成部分——以 [pi](https://pi.dev) 为引擎的个人 AI 开发工作台与本地调试注入生态：**aiti-agent**（自托管 Web 工作台，基于开源项目 [pi-web](https://github.com/aiti-ai/pi-web) 构建，浏览器为主操作面）+ 各开发工具内的调试注入（aiti-devtools）+ 丰富的扩展体系。

- 工作台（aiti-agent，基于 pi-web）: <https://github.com/aiti-ai/pi-web>
- 生态仓库: <https://github.com/aiti-ai/aiti-ai>
- 官网: <https://aiti.pw>

分类: 调试 · tags: `headless` · `xvfb` · `vnc` · `rdp` · `atspi` · `display` · `virtual-desktop` · `noVNC` · `vnc-password`

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

## 许可证

MIT
