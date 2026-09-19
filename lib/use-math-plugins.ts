"use client";

/**
 * Hook for lazily loading math plugins (hydration-specific item P1.2 — internal
 * hydration-perf design doc).
 *
 * When the body has no math markers, the base plugins are used directly
 * (katex/remark-math stay unloaded); only when a marker is present is
 * `lib/markdown-math` dynamically pulled in and the math plugins appended after
 * the base ones. The first math-bearing content renders one frame as raw `$…$`
 * text and upgrades to formulas once the chunk is ready — later instances are
 * immediately available via the module cache.
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
  // Initial value takes the loaded snapshot: when the module is already ready
  // (re-renders / preloaded tests / SSR preload), math plugins apply synchronously
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
