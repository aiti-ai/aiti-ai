"use client";

/**
 * Lightweight code highlighting (hydration workstream P1.1 — docs/pi-web-hydration-perf-plan.md)
 *
 * Full Prism (the `Prism` export of `react-syntax-highlighter`, ~1.24MB with all languages)
 * is replaced by PrismLight (refractor core, zero languages) plus explicit registration of
 * common languages. Consumers load this component dynamically via React.lazy — this module
 * no longer enters the first-load chunk; the first frame falls back to plain text via the
 * Suspense fallback and upgrades automatically once the highlighting chunk is ready.
 *
 * Unregistered languages always degrade to unhighlighted plain text (PrismLight is safe
 * with unknown grammars); no on-demand language fetching (chat languages are not
 * enumerable, and one chunk per language fragments too much to be worth it).
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

/** Common fence language aliases → registered names; a miss on an unregistered grammar → undefined (rendered as plain text) */
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

/** Normalizes the language prop; returning undefined means no highlighting (PrismLight renders plain text) */
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
