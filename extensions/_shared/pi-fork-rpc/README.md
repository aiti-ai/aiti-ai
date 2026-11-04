/**
 * pi-fork-rpc — pi 系 fork 家族 RPC spawn 的最小公共层（载体无关）。
 *
 * 拆分背景（docs/aiti-pi-agent-split-plan.md）：aiti-pi-agent 曾用一份 PiForkSpec
 * 参数化同时承载 pi / omp 两个后端，差异已大到「共享抽象反而耦合」——拆成两个独立
 * 扩展后，本层只保留「线协议解析 + CLI 解析 + spawn env + 家族类型」，不含任何 fork
 * 语义（命令映射 / 能力面 / 生命周期收口由各扩展自己的 handle 实现负责）。
 *
 * 权威源在本目录（git 管理）；消费扩展（aiti-pi-agent / aiti-omp-agent）以**副本**
 * 形式携带（fork-rpc/ 子目录，deploy 时随扩展拷入部署目录；同步见 scripts/sync-pi-fork-rpc.mjs）。
 * 本层无宿主依赖（不 import pi-web lib），可被 node:test 直载（--experimental-strip-types）。
 */
