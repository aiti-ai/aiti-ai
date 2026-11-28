# AGENTS.md · aiti-containers

pi-web 扩展：容器管理面板 + agent 工具（对标 `microsoft/vscode-containers`）。

## 结构

| 路径 | 职责 |
|---|---|
| `index.ts` | 扩展入口：features / server.api / agentTools（部署时被宿主用 jiti 转译） |
| `server/runtime.ts` | CLI 探测（docker/podman/nerdctl）、`execFile` 执行器、输出解析、错误映射 |
| `server/ops.ts` | 资源聚合、动作白名单、危险集合、日志/inspect/动作派发 |
| `client/src/entry.ts` | 面板 UI（宿主 `h()` 手写，无 JSX、无运行时依赖） |
| `tools/build.mjs` | esbuild 打包 client → `dist/` |
| `tools/deploy.mjs` | 构建 + 拷贝 dev 部署目录 + reload dev（**不部署 prod**） |
| `skills/containers-ops/` | AI 排障手册（ai.manage 帮助点） |

## 硬约束（改代码前看）

1. **永不拼 shell 字符串**：命令行一律 argv 数组 + `execFile`；动作只能走 `BUILDERS` 白名单（`server/ops.ts`）。
2. **危险动作必须可确认**：新增危险动作要同时进 `DANGER` 集合；否则 AI 会无确认执行。
3. **禁轮询**：面板只在手动刷新 / 动作成功后重取；不要加 `setInterval` 或定时拉取。
4. **容量与超时**：`maxBuffer 64MB`、默认 20s（pull/compose up 180s）；logs `tail ≤ 2000`，输出截断标注。
5. **注释英文**（仓门禁 `check-new-cjk-comments`）；UI 文案可中文。
6. **feature 只有 boolean / string / textlist**（没有 number）；数值用 string 再 `Number()`。
7. **client 产物统一 `dist/`**；`index.ts` 的 `client` 字段指向 ll产物，别手改部署目录里的 dist。
8. 服务端只用 node 内置模块；不要为了小功能引新依赖。

## 本地验证

```bash
node tools/build.mjs
node tools/deploy.mjs
curl -s http://127.0.0.1:30142/dev/api/extensions/aiti-containers/state | python3 -m json.tool | head -40
node ../../workspace-tools/gates/gate-all.mjs --root ../..   # 仓根跑（本目录是 aiti-ai/extensions/aiti-containers）
```

真机 UI：dev 实例（30142）打开面板；危险操作走「再点确认」。

## 已知边界

- compose 项目仅从容器 label 推导（`com.docker.compose.project.working_dir`）；不是本机 compose 起的容器没有项目目录，compose 动作会失败并回传 stderr。
- podman 的 `{{json .}}` 字段与 docker 略有差异（已兼容 State/Status）；更老的 podman 可能不支持 `system df --format`，此时 `usage` 为空但不影响其他视图。
- 只读 `inspect` 返回原始 JSON（可能很大），截断 200KB。
