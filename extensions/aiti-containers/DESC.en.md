Container management panel: containers / images / volumes / networks with compose-project grouping, supporting start-stop, logs, removal, pruning and exec inside a container. The same capabilities are exposed to AI as `aiti_containers_*` tools (destructive actions require confirmation).

Auto-detects docker / podman / nerdctl — no configuration needed. Read-only operations (list / logs / inspect) are always available; destructive operations (remove / prune / compose down / exec) require a second confirmation.
