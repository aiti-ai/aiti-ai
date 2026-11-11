# @aiti-ai/service-tunnels

> 本机服务一键公网可达 —— 端口发现（服务识别/自定义名）/ 五种暴露模式（隧道·vhost·混合·路由器映射·IPv6 直连）/ 认证网关（portal·TOTP·人脸声纹）/ DDNS 自动解析 / 网络体检 doctor

## 来源 · Origin

本包是 **aiti** 生态的组成部分——以 [pi](https://pi.dev) 为引擎的个人 AI 开发工作台与本地调试注入生态：**aiti-agent**（自托管 Web 工作台，基于开源项目 [pi-web](https://github.com/aiti-ai/pi-web) 构建，浏览器为主操作面）+ 各开发工具内的调试注入（aiti-devtools）+ 丰富的扩展体系。

This package is part of the **aiti** ecosystem — a personal AI development workbench powered by [pi](https://pi.dev): **aiti-agent** (a self-hosted web workbench built on the open-source [pi-web](https://github.com/aiti-ai/pi-web)) plus debug injection into mainstream dev tools (aiti-devtools) and a rich extension system.

- 工作台 / workbench: <https://github.com/aiti-ai/pi-web>
- 生态仓库 / monorepo: <https://github.com/aiti-ai/aiti-ai>
- 官网 / site: <https://aiti.pw>

## 功能定位（中文）

本机服务一键公网可达 —— 端口发现（服务识别/自定义名）/ 五种暴露模式（隧道·vhost·混合·路由器映射·IPv6 直连）/ 认证网关（portal·TOTP·人脸声纹）/ DDNS 自动解析 / 网络体检 doctor

服务隧道 · tags: `tunnels` · `ports` · `expose` · `portmap` · `ipv6` · `ddns` · `auth` · `totp` · `biometric` · `doctor` · `inject`

## Positioning (English)

One-click public reachability for local services — port discovery (service identification/custom names) / five exposure modes (tunnel·vhost·hybrid·router portmap·IPv6 direct) / auth gateway (portal·TOTP·face and voiceprint) / DDNS auto resolution / network health doctor

## 安装 / 部署

```bash
# 源码：pi-web-ext/service-tunnels/
# 部署：node tools/deploy.mjs（构建客户端 + 拷贝 + 目标内 npm install --omit=dev）
# 生效：POST /api/extensions/reload
```

## 文档 · Documentation

- 中文完整文档（aiti-docs）: <https://aiti.pw/extensions/service-tunnels.html>
- English docs: <https://aiti.pw/en/extensions/service-tunnels.html>
- 扩展注册表 / registry: <https://aiti.pw/extensions.html> · machine-readable <https://aiti.pw/extensions.json>

## License

MIT
