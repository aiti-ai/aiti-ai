容器管理面板：容器 / 镜像 / 卷 / 网络 + compose 项目分组，支持启停、日志、删除、清理与容器内执行；同一套能力以 `aiti_containers_*` 工具暴露给 AI（危险动作需确认）。

自动探测 docker / podman / nerdctl，无需配置。只读操作（列表 / 日志 / inspect）可直接用；危险操作（删除 / 清理 / compose down / 容器内执行）需要二次确认。
