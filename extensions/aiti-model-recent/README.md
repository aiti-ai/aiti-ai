# @aiti-ai/aiti-model-recent

> 模型选择器「最近使用」数据提供方——纯 service 扩展（零 UI），面板最近段同步取数 + pick 事件入库 LRU；localStorage key 与原实现一致零迁移

## 来源 · Origin

本包是 **aiti** 生态的组成部分——以 [pi](https://pi.dev) 为引擎的个人 AI 开发工作台与本地调试注入生态：**aiti-agent**（自托管 Web 工作台，基于开源项目 [pi-web](https://github.com/aiti-ai/pi-web) 构建，浏览器为主操作面）+ 各开发工具内的调试注入（aiti-devtools）+ 丰富的扩展体系。

This package is part of the **aiti** ecosystem — a personal AI development workbench powered by [pi](https://pi.dev): **aiti-agent** (a self-hosted web workbench built on the open-source [pi-web](https://github.com/aiti-ai/pi-web)) plus debug injection into mainstream dev tools (aiti-devtools) and a rich extension system.

- 工作台 / workbench: <https://github.com/aiti-ai/pi-web>
- 生态仓库 / monorepo: <https://github.com/aiti-ai/aiti-ai>
- 官网 / site: <https://aiti.pw>

## 功能定位（中文）

模型选择器「最近使用」数据提供方——纯 service 扩展（零 UI），面板最近段同步取数 + pick 事件入库 LRU；localStorage key 与原实现一致零迁移

聊天增强 · tags: `model-selector` · `recent` · `lru` · `service` · `defork`

## Positioning (English)

The model selector's "recently used" data provider — a pure service extension (zero UI); the panel's recent section fetches data synchronously and pick events feed the LRU; the localStorage key matches the original implementation, zero migration

## 安装 / 部署

```bash
# 部署到 ~/.pi/web/extensions/aiti-model-recent/ 后 reload（需宿主 ≥ service 接缝版本，defork P4）
```

## 文档 · Documentation

- 中文完整文档（aiti-docs）: <https://aiti.pw/extensions/aiti-model-recent.html>
- English docs: <https://aiti.pw/en/extensions/aiti-model-recent.html>
- 扩展注册表 / registry: <https://aiti.pw/extensions.html> · machine-readable <https://aiti.pw/extensions.json>

## License

MIT
