/**
 * 数学渲染插件（hydration 专项 P1.2 —— docs/pi-web-hydration-perf-plan.md）
 *
 * remark-math + rehype-katex（连带 katex ~300KB）只在正文命中数学标记时
 * 经 `lib/markdown.ts` 的 loadMathPlugins() 动态 import——本模块必须保持
 * 只被动态引用，不得进入任何首屏 chunk 的静态依赖图。
 */
import rehypeKatex from "rehype-katex";
import remarkMath from "remark-math";
import type { Options as ReactMarkdownOptions } from "react-markdown";

export const mathRemarkPlugins: ReactMarkdownOptions["remarkPlugins"] = [remarkMath];

export const mathRehypePlugins: ReactMarkdownOptions["rehypePlugins"] = [
  [rehypeKatex, { throwOnError: false, strict: false }],
];
