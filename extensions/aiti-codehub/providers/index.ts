/**
 * Built-in providers. Adding a platform = new folder + one line here.
 */
import type { ForgeProvider } from "../server/contract.ts";
import { yunxiaoProvider } from "./yunxiao/index.ts";
import { githubProvider } from "./github/index.ts";
import { giteeProvider } from "./gitee/index.ts";
import { gitlabProvider } from "./gitlab/index.ts";

export const BUILTIN_PROVIDERS: ForgeProvider[] = [
  yunxiaoProvider,
  githubProvider,
  giteeProvider,
  gitlabProvider,
];
