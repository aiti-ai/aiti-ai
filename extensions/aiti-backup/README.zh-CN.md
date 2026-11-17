# @aiti-ai/aiti-backup

> pi-web state 层大数据快照备份——硬链接增量 + 独立子进程执行 + 崩溃安全临时文件 + keepCount 保留轮转；与 aiti-configs（小配置 git 版本化）互补。

[English](./README.md) · 简体中文

## 关于 aiti

本包是 **aiti** 生态的组成部分——以 [pi](https://pi.dev) 为引擎的个人 AI 开发工作台与本地调试注入生态：**aiti-agent**（自托管 Web 工作台，基于开源项目 [pi-web](https://github.com/aiti-ai/pi-web) 构建，浏览器为主操作面）+ 各开发工具内的调试注入（aiti-devtools）+ 丰富的扩展体系。

- 工作台（aiti-agent，基于 pi-web）: <https://github.com/aiti-ai/pi-web>
- 生态仓库: <https://github.com/aiti-ai/aiti-ai>
- 官网: <https://aiti.pw>

## 功能定位

state 层大数据（会话归档 `.pwarc` / git-trace ops / `~/.pi/agent/sessions`）的**快照备份**——与 aiti-configs 互补：configs 管「小配置 git 版本化」，本扩展管「大数据快照」。

## 机制

- **快照语义**：每次备份 = `<dest>/<sourceId>/snapshots/<UTC时间戳>/` 完整时间点副本 + `manifest.json`（完成标记）
- **硬链接增量**：与上一快照同 path 且 size+mtime 一致的文件 `fs.link` 零拷贝；目标盘不支持（exFAT 等）自动整轮降级复制（`mode:"full"`）
- **源严格只读**：备份从不写/删源；symlink 不跟随（记 skipped）；运行态噪音名默认排除
- **执行隔离**：扫描/复制全在独立子进程 `bin/backup-runner.cjs`（宿主零阻塞），进度走 stdout JSONL → event-bus `aiti-backup:progress|done|error`（无轮询）
- **中断安全**：任意时刻 kill 只可能留 `.tmp-*` 半成品（下次运行自动清理）；同源运行锁防并发
- **保留轮转**：`keepCount`（默认 7）删最旧，仅限 snapshots/ 内时间戳命名目录
- **恢复**：直接从快照目录拷回（快照内为源的原样相对路径）

## 使用（API）

```bash
base=/api/extensions/aiti-backup
curl -s localhost:3001$base/status                                   # 源清单（state 自动发现 + pi-sessions）
curl -s -X POST localhost:3001$base/config -H content-type:application/json \
  -d '{"dest":"/mnt/your-backup-disk"}'                               # 设目的地（与源互斥校验）
curl -s -X POST localhost:3001$base/backup -H content-type:application/json -d '{"all":true}'
curl -s localhost:3001$base/runs                                     # 运行历史
```

- 源开关：`POST config {"sourceOverrides":{"pi-sessions":{"enabled":false}}}`；自定义源：`custom:[{id,path}]`。
- 目的地由用户自选（外接盘/NAS），**备份内容未加密**；备份会话内容含隐私，请放在自己控制的盘上。

## 安装

随 **aiti-agent**（`@aiti-ai/pi-web`）捆绑发行——在工作台内的扩展管理器（ExtMan / 应用中心）启用即可。

手动安装：把本包放到 `~/.pi/web/extensions/aiti-backup/` 后 reload。

## 文档

- 中文文档: <https://aiti.pw/extensions/aiti-backup.html>
- Documentation (English): <https://aiti.pw/en/extensions/aiti-backup.html>
- 扩展注册表: <https://aiti.pw/extensions.html> · machine-readable <https://aiti.pw/extensions.json>

## 许可证

MIT
