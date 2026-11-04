# aiti-backup · pi-web 数据备份扩展

state 层大数据（会话归档 `.pwarc` / git-trace ops / `~/.pi/agent/sessions`）的**快照备份**——与 aiti-configs 互补：configs 管「小配置 git 版本化」，本扩展管「大数据快照」（方案：`docs/pi-web-ext-data-backup-extension-plan.md`，§7 已全拍板）。

## 机制（M1+M2 已实施）

- **快照语义**：每次备份 = `<dest>/<sourceId>/snapshots/<UTC时间戳>/` 完整时间点副本 + `manifest.json`（完成标记）；
- **硬链接增量**：与上一快照同 path 且 size+mtime 一致的文件 `fs.link` 零拷贝；目标盘不支持（exFAT 等）自动整轮降级复制（`mode:"full"`）；
- **源严格只读**：备份从不写/删源；symlink 不跟随（记 skipped）；运行态噪音名默认排除；
- **执行隔离**：扫描/复制全在独立子进程 `bin/backup-runner.cjs`（宿主零阻塞），进度走 stdout JSONL → event-bus `aiti-backup:progress|done|error`（无轮询）；
- **中断安全**：任意时刻 kill 只可能留 `.tmp-*` 半成品（下次运行自动清理）；同源运行锁防并发；
- **保留轮转**：`keepCount`（默认 7）删最旧，仅限 snapshots/ 内时间戳命名目录；
- **恢复**（M4 待实施）：M1/M2 阶段可直接从快照目录拷回（快照内为源的原样相对路径）。

## 使用（当前为 API 形态，UI 面板=M5）

```bash
base=/dev/api/extensions/aiti-backup            # prod 实例去掉 /dev
curl -s localhost:3001$base/status                                   # 源清单（state 自动发现 + pi-sessions）
curl -s -X POST localhost:3001$base/config -H content-type:application/json \
  -d '{"dest":"/mnt/your-backup-disk"}'                               # 设目的地（与源互斥校验）
curl -s -X POST localhost:3001$base/backup -H content-type:application/json -d '{"all":true}'
curl -s localhost:3001$base/runs                                     # 运行历史
```

- 源开关：`POST config {"sourceOverrides":{"pi-sessions":{"enabled":false}}}`；自定义源：`custom:[{id,path}]`。
- 目的地由用户自选（外接盘/NAS），**备份内容未加密**；备份会话内容含隐私，请放在自己控制的盘上。
