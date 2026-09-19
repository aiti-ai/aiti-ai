/**
 * Math rendering plugins (hydration-specific item P1.2 — internal
 * hydration-perf design doc).
 *
 * remark-math + rehype-katex (pulling in ~300KB of katex) are dynamically
 * imported via loadMathPlugins() in `lib/markdown.ts` only when the body hits a
 * math marker — this module must stay dynamically referenced only and must
 * never enter the static dependency graph of any first-paint chunk.
 */
import rehypeKatex from "rehype-katex";
import remarkMath from "remark-math";
import type { Options as ReactMarkdownOptions } from "react-markdown";

export const mathRemarkPlugins: ReactMarkdownOptions["remarkPlugins"] = [remarkMath];

export const mathRehypePlugins: ReactMarkdownOptions["rehypePlugins"] = [
  [rehypeKatex, { throwOnError: false, strict: false }],
];
