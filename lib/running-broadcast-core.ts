/**
 * running 广播的纯函数核心（零依赖）。
 *
 * 单独成文件的原因：lib/running-broadcast.ts 依赖 rpc-manager 等重型模块
 *（含 TS 参数属性语法，node --experimental-strip-types 无法加载）——功能测试需要
 * 可直载的纯函数。合并/键逻辑在此，接线回归由 lib/running-broadcast.test.mjs
 * 的 source-scan 覆盖。
 */

/** 多路运行集并集（去重；rpc 本地 + handle 后端 + TUI 桥未认领）。 */
export function mergeRunningIds(...groups: string[][]): string[] {
  return [...new Set(groups.flat())];
}

/** 运行集帧内容键（集合语义：排序 + 换行连接；空集 = ""）。 */
export function runningFrameKey(ids: string[]): string {
  return [...ids].sort().join("\n");
}
