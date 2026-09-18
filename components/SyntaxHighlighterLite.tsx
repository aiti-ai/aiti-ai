"use client";

/**
 * 轻量代码高亮（hydration 专项 P1.1 —— docs/pi-web-hydration-perf-plan.md）
 *
 * 全量 Prism（`react-syntax-highlighter` 的 `Prism` 出口，~1.24MB 全语言）改为
 * PrismLight（refractor 核心、零语言）+ 常用语言显式注册。消费方经 React.lazy
 * 动态加载本组件——本模块不再进入首屏 chunk；首帧由 Suspense fallback 纯文本兜底，
 * 高亮 chunk 就绪后自动升级。
 *
 * 未注册语言一律降级为无高亮纯文本（PrismLight 对未知 grammar 安全），不做动态
 * 语言按需拉取（聊天语言不可枚举，每个语言一个 chunk 的碎片化得不偿失）。
 */

import SyntaxHighlighter from "react-syntax-highlighter/dist/esm/prism-light";
import type { SyntaxHighlighterProps } from "react-syntax-highlighter";

import javascript from "react-syntax-highlighter/dist/esm/languages/prism/javascript";
import jsx from "react-syntax-highlighter/dist/esm/languages/prism/jsx";
import typescript from "react-syntax-highlighter/dist/esm/languages/prism/typescript";
import tsx from "react-syntax-highlighter/dist/esm/languages/prism/tsx";
import python from "react-syntax-highlighter/dist/esm/languages/prism/python";
import json from "react-syntax-highlighter/dist/esm/languages/prism/json";
import bash from "react-syntax-highlighter/dist/esm/languages/prism/bash";
import yaml from "react-syntax-highlighter/dist/esm/languages/prism/yaml";
import sql from "react-syntax-highlighter/dist/esm/languages/prism/sql";
import rust from "react-syntax-highlighter/dist/esm/languages/prism/rust";
import go from "react-syntax-highlighter/dist/esm/languages/prism/go";
import java from "react-syntax-highlighter/dist/esm/languages/prism/java";
import c from "react-syntax-highlighter/dist/esm/languages/prism/c";
import cpp from "react-syntax-highlighter/dist/esm/languages/prism/cpp";
import csharp from "react-syntax-highlighter/dist/esm/languages/prism/csharp";
import php from "react-syntax-highlighter/dist/esm/languages/prism/php";
import ruby from "react-syntax-highlighter/dist/esm/languages/prism/ruby";
import diff from "react-syntax-highlighter/dist/esm/languages/prism/diff";
import ini from "react-syntax-highlighter/dist/esm/languages/prism/ini";
import kotlin from "react-syntax-highlighter/dist/esm/languages/prism/kotlin";
import swift from "react-syntax-highlighter/dist/esm/languages/prism/swift";
import markdown from "react-syntax-highlighter/dist/esm/languages/prism/markdown";
import markup from "react-syntax-highlighter/dist/esm/languages/prism/markup";
import css from "react-syntax-highlighter/dist/esm/languages/prism/css";
import graphql from "react-syntax-highlighter/dist/esm/languages/prism/graphql";
import lua from "react-syntax-highlighter/dist/esm/languages/prism/lua";
import makefile from "react-syntax-highlighter/dist/esm/languages/prism/makefile";
import perl from "react-syntax-highlighter/dist/esm/languages/prism/perl";

const LANGUAGES: Record<string, Parameters<typeof SyntaxHighlighter.registerLanguage>[1]> = {
  javascript,
  jsx,
  typescript,
  tsx,
  python,
  json,
  bash,
  yaml,
  sql,
  rust,
  go,
  java,
  c,
  cpp,
  csharp,
  php,
  ruby,
  diff,
  ini,
  kotlin,
  swift,
  markdown,
  markup,
  css,
  graphql,
  lua,
  makefile,
  perl,
};
const REGISTERED = new Set(Object.keys(LANGUAGES));
for (const [name, grammar] of Object.entries(LANGUAGES)) {
  SyntaxHighlighter.registerLanguage(name, grammar);
}

/** 常见 fence 语言别名 → 注册名；未命中且未注册的语法 → undefined（纯文本渲染） */
const ALIASES: Record<string, string> = {
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  node: "javascript",
  ts: "typescript",
  py: "python",
  python3: "python",
  sh: "bash",
  shell: "bash",
  zsh: "bash",
  console: "bash",
  terminal: "bash",
  session: "bash",
  yml: "yaml",
  htm: "markup",
  html: "markup",
  xml: "markup",
  svg: "markup",
  vue: "markup",
  svelte: "markup",
  rb: "ruby",
  golang: "go",
  "c++": "cpp",
  cs: "csharp",
  dotnet: "csharp",
  docker: "ini",
  dockerfile: "ini",
  env: "ini",
  toml: "ini",
  conf: "ini",
  patch: "diff",
  postgres: "sql",
  postgresql: "sql",
  mysql: "sql",
  sqlite: "sql",
  kts: "kotlin",
  plaintext: undefined as unknown as string,
  text: undefined as unknown as string,
  txt: undefined as unknown as string,
  log: undefined as unknown as string,
};

/** 归一化 language prop；返回 undefined 表示不高亮（PrismLight 渲染纯文本） */
function normalizeLanguage(lang: SyntaxHighlighterProps["language"]): string | undefined {
  if (typeof lang !== "string") return undefined;
  const key = lang.toLowerCase().trim();
  if (!key || key in ALIASES) {
    const alias = ALIASES[key];
    if (!alias) return undefined;
    return REGISTERED.has(alias) ? alias : undefined;
  }
  return REGISTERED.has(key) ? key : undefined;
}

export default function SyntaxHighlighterLite(props: SyntaxHighlighterProps) {
  return <SyntaxHighlighter {...props} language={normalizeLanguage(props.language)} />;
}
