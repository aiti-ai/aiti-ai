/**
 * session-manager · 客户端 feature 读取（extman「功能管理」声明即用）。
 *
 * 宿主经 ctx.getFeatures() 同步提供生效状态（含声明 default），ctx.onFeatureChange(cb)
 * 订阅变更（extman 切换即推送，零轮询）。本模块把两者包装成 React hook：
 *   const on = useFeature("behavior.favorite-icons"); // 缺省 false
 *
 * 注意缺省语义：宿主 getExtFeaturesOf 对"未声明/未知"返回 undefined → 视为启用；
 * 但扩展声明的 feature 一定在 status.features 里（含 default 计算后的 enabled），
 * 所以显式声明的 boolean feature 这里用 !== false 即可得到正确开/关。
 */
import { useState, useEffect } from "react";
import { getFeatures, onFeatureChange } from "./host-shim";

export function isFeatureOn(id: string): boolean {
  const v = getFeatures()[id];
  return v === true || v === "true" || v === undefined; // 未声明/未知 → 视为启用（宿主语义）
}

export function useFeature(id: string): boolean {
  const [on, setOn] = useState<boolean>(() => isFeatureOn(id));
  useEffect(() => {
    let alive = true;
    const l = () => { if (alive) setOn(isFeatureOn(id)); };
    return () => { alive = false; onFeatureChange(l)(); };
  }, [id]);
  return on;
}