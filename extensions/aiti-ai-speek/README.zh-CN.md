# @aiti-ai/aiti-ai-speek

> AI 输出语音朗读——可切音色/暂停/跳过/停止；默认浏览器 Web Speech，可选 edge-tts 与**本地 TTS 引擎**（Hojo-TTS-Light 40M/80M，ONNX CPU，OpenAI 兼容服务，支持音色克隆）

[English](./README.md) · 简体中文

## 关于 aiti

本包是 **aiti** 生态的组成部分——以 [pi](https://pi.dev) 为引擎的个人 AI 开发工作台与本地调试注入生态：**aiti-agent**（自托管 Web 工作台，基于开源项目 [pi-web](https://github.com/aiti-ai/aiti-ai) 构建，浏览器为主操作面）+ 各开发工具内的调试注入（aiti-devtools）+ 丰富的扩展体系。

- 工作台 / 生态仓库（aiti-agent，基于 pi-web）: <https://github.com/aiti-ai/aiti-ai>
- 官网: <https://aiti.pw>

分类: 聊天增强 · tags: `tts` · `speech` · `audio`

## 安装

随 **aiti-agent**（`@aiti-ai/pi-web`）捆绑发行——在工作台内的扩展管理器（ExtMan / 应用中心）启用即可。

手动安装：把本包放到 `~/.pi/web/extensions/aiti-ai-speek/` 后 reload。

## 引擎

| 引擎 | 依赖 | 说明 |
|---|---|---|
| 浏览器 Web Speech | 无 | 默认兜底，零后端 |
| edge-tts | `pip install edge-tts` | 服务端音质档 |
| 本地（Hojo-TTS-Light） | Python 3.10-3.12（推荐 `uv`） | 纯本地、CPU 友好；选中即自动准备 venv + 依赖 + 模型（约 240MB），无需手工下载。40M = 17 个内置音色；80M = 用 3-30 秒参考音频做音色克隆。空闲 30 分钟自动退出。 |

本地服务监听 `127.0.0.1:8768`（被占用自动 8769-8778），对外是 OpenAI `/v1/audio/speech` 子集，
任何 OpenAI 兼容客户端都可直接复用。状态/启停/进度/日志/音色管理都在扩展设置面板；
`skills/tts-local-install` 记录了“一条命令”启动流程（`bash server/tts-service/start-tts.sh start`）。

## 文档

- 中文文档: <https://aiti.pw/extensions/aiti-ai-speek.html>
- Documentation (English): <https://aiti.pw/en/extensions/aiti-ai-speek.html>
- 扩展注册表: <https://aiti.pw/extensions.html> · machine-readable <https://aiti.pw/extensions.json>

## 许可证

MIT
