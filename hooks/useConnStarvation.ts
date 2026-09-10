"use client";

import { useEffect, useState } from "react";

/** 连接池饥饿让路辅助（防抱死，lib/conn-guard）：文件/媒体 watch 类 SSE 的让路与重建信号。
 *
 *  走 window "piwe-conn-starve" 广播协议（与 running broker / bridge-client 同通道）。
 *
 *  用法：watch useEffect 内引用返回值的 starved / epoch（进依赖数组）：
 *    const { starved: connStarved, epoch: connEpoch } = useConnStarvation();
 *    useEffect(() => {
 *      if (connStarved) return;          // 饥饿让路：不建连（cleanup 已关旧连接）
 *      ...原有建连逻辑...
 *    }, [...原有依赖, connStarved, connEpoch]);
 *  starve → epoch 自增 → effect 重跑 cleanup 关旧连接 + gate 不重建（释放 socket 让 fetch 通过）；
 *  unstarve → epoch 再自增 → effect 重跑重建连接。事件驱动，零轮询。 */
export function useConnStarvation(): { starved: boolean; epoch: number } {
  const [state, setState] = useState({ starved: false, epoch: 0 });
  useEffect(() => {
    const handler = (ev: Event) => {
      const starved = Boolean((ev as CustomEvent<{ starved?: boolean }>).detail?.starved);
      setState((prev) => (prev.starved === starved ? prev : { starved, epoch: prev.epoch + 1 }));
    };
    window.addEventListener("piwe-conn-starve", handler);
    return () => window.removeEventListener("piwe-conn-starve", handler);
  }, []);
  return state;
}
