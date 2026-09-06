/**
 * sessionForkGate — 「编辑重发」前置门（client 侧 handler 扩展点；名称沿用 fork 时代，注册 API 不变）。
 *
 * 扩展经 client ctx.registerSessionForkGate(gate) 注册；调用方
 * （components/ChatWindow.handleEditFromHereMark）在「从此处编辑」打标记前依次 await
 * 全部 gate：任一返回 false 或抛错 → 立即中止本次标记（后续 gate 不再执行）。
 * 全部放行才进入标记态。消费场景：aiti-git-trace 的「回撤前置门」——编辑重发
 * （回退到分支点重发）前让用户决定是否回滚该区间产生的文件变更（docs/aiti-git-trace-plan.md §5.4）。
 * 注：fork（分支按钮 → useAgentSession.handleFork）自 9963a46 起有意不触发本门——
 * 新会话追加式、不动原会话，无回滚诉求。
 *
 * 本模块零 React 依赖（lib/composer/bus.ts 同款总线模式）：注册方在扩展 client
 * bundle 的 effect 里注册并持有 disposer（HMR 重载时精确移除旧 gate）。
 */
import type { SessionForkGate, SessionForkGateInfo } from "./types";

export type { SessionForkGate, SessionForkGateInfo };

const gates: SessionForkGate[] = [];

/** 注册前置门；返回 disposer（精确移除本次注册，effect 返回值直接用）。 */
export function registerSessionForkGate(gate: SessionForkGate): () => void {
  gates.push(gate);
  return () => {
    const i = gates.indexOf(gate);
    if (i >= 0) gates.splice(i, 1);
  };
}

/**
 * 依次执行全部前置门（注册序）。全部放行 → true；任一返回 false 或抛错 →
 * 立即取消（返回 false，不再执行后续 gate），抛错仅 console.warn 不向上冒。
 * 无注册 gate 时恒放行（true）——零扩展时 fork 行为与从前完全一致。
 */
export async function runSessionForkGates(info: SessionForkGateInfo): Promise<boolean> {
  for (const gate of gates) {
    try {
      const ok = await gate(info);
      if (!ok) return false;
    } catch (e) {
      console.warn("[ext] sessionForkGate cancelled the fork:", e);
      return false;
    }
  }
  return true;
}

/** 测试辅助：清空全部 gate（生产代码勿调）。 */
export function resetSessionForkGatesForTests(): void {
  gates.length = 0;
}
