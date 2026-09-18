"use client";

/**
 * 数学插件按需加载 hook（hydration 专项 P1.2 —— docs/pi-web-hydration-perf-plan.md）
 *
 * 正文无数学标记时直接用基础插件（不加载 katex/remark-math）；命中标记才动态拉
 * `lib/markdown-math` 并把数学插件追加到基础插件后。首个含数学的内容会先以原始
 * `$…$` 文本渲染一帧、chunk 就绪后升级为公式——之后的实例走模块缓存即时就绪。
 */
import { useEffect, useMemo, useState } from "react";
import type { Options as ReactMarkdownOptions } from "react-markdown";
import { hasMathMarker, getLoadedMathPlugins, loadMathPlugins, type MathPlugins } from "@/lib/markdown";

export function useMathMarkdownPlugins(
  content: string,
  baseRemark: ReactMarkdownOptions["remarkPlugins"],
  baseRehype: ReactMarkdownOptions["rehypePlugins"],
): { remark: ReactMarkdownOptions["remarkPlugins"]; rehype: ReactMarkdownOptions["rehypePlugins"] } {
  const wanted = hasMathMarker(content);
  // 初始值取已加载快照：模块已就绪时（二次渲染/预载过的测试/SSR 预载）同步带数学插件
  const [math, setMath] = useState<MathPlugins | null>(() => getLoadedMathPlugins());

  useEffect(() => {
    if (!wanted || math) return;
    let cancelled = false;
    loadMathPlugins().then((m) => {
      if (!cancelled) setMath(m);
    });
    return () => {
      cancelled = true;
    };
  }, [wanted, math]);

  return useMemo(
    () =>
      math
        ? { remark: [...(baseRemark ?? []), ...(math.remark ?? [])], rehype: [...(baseRehype ?? []), ...(math.rehype ?? [])] }
        : { remark: baseRemark, rehype: baseRehype },
    [baseRemark, baseRehype, math],
  );
}
