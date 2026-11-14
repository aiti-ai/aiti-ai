# @aiti-ai/service-tunnels

> 本机服务一键公网可达 —— 端口发现（服务识别/自定义名）/ 五种暴露模式（隧道·vhost·混合·路由器映射·IPv6 直连）/ 认证网关（portal·TOTP·人脸声纹）/ DDNS 自动解析 / 网络体检 doctor

[English](./README.md) · 简体中文

## 关于 aiti

本包是 **aiti** 生态的组成部分——以 [pi](https://pi.dev) 为引擎的个人 AI 开发工作台与本地调试注入生态：**aiti-agent**（自托管 Web 工作台，基于开源项目 [pi-web](https://github.com/aiti-ai/pi-web) 构建，浏览器为主操作面）+ 各开发工具内的调试注入（aiti-devtools）+ 丰富的扩展体系。

- 工作台（aiti-agent，基于 pi-web）: <https://github.com/aiti-ai/pi-web>
- 生态仓库: <https://github.com/aiti-ai/aiti-ai>
- 官网: <https://aiti.pw>

分类: 服务隧道 · tags: `tunnels` · `ports` · `expose` · `portmap` · `ipv6` · `ddns` · `auth` · `totp` · `biometric` · `doctor` · `inject`

## 安装

随 **aiti-agent**（`@aiti-ai/pi-web`）捆绑发行——在工作台内的扩展管理器（ExtMan / 应用中心）启用即可。

手动安装：把本包放到 `~/.pi/web/extensions/service-tunnels/` 后 reload。

## 文档

- 中文文档: <https://aiti.pw/extensions/service-tunnels.html>
- Documentation (English): <https://aiti.pw/en/extensions/service-tunnels.html>
- 扩展注册表: <https://aiti.pw/extensions.html> · machine-readable <https://aiti.pw/extensions.json>

## 许可证

MIT
