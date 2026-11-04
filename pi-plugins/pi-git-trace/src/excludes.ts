/**
 * 内置排除清单（§3.5，# aiti-excludes v1）。
 * 构建产物 / 依赖 / 缓存 / 临时物；锁文件与 .env 不在列。
 * 全部受「显式追踪让位」（git ls-files 检查）与 trace.includeExtra 否定约束。
 */
export const EXCLUDES_VERSION = 2;

/** 目录型模式做让位检查（git ls-files -- <pattern>）时去掉尾部 "/" */
export const BUILTIN_EXCLUDES: string[] = [
  // —— Node / 前端
  "node_modules/",
  ".next/", ".nuxt/", ".output/", ".svelte-kit/", ".astro/", ".vite/", ".vitest/",
  ".parcel-cache/", ".turbo/", ".vercel/",
  "dist/", "build/", "out/", "coverage/", ".nyc_output/", ".cache/",
  ".eslintcache", "*.tsbuildinfo",
  ".yarn/cache", ".yarn/install-state.gz", ".pnpm-store/",
  // —— Python
  "__pycache__/", "*.py[cod]", ".ipynb_checkpoints/",
  ".venv/", "venv/", ".tox/", ".nox/", ".hypothesis/",
  ".pytest_cache/", ".mypy_cache/", ".ruff_cache/", "*.egg-info/",
  // —— JVM / .NET
  "target/", "build/", ".gradle/", "*.class",
  "bin/", "obj/", ".vs/",
  // —— Ruby
  ".bundle/", "vendor/bundle/",
  // —— 日志 / 临时 / 崩溃物
  "*.log", "logs/", "tmp/", ".tmp/", "*.swp", "*.swo", "core", "core.*",
  // —— OS / IDE
  ".DS_Store", "Thumbs.db", "desktop.ini",
  ".idea/", ".vscode/",
  // —— Windows 保留设备名（含 <name>.<ext> 形态；nul.txt 同为保留）：git 无法 stat/index，
  //    一旦混入枚举会让整批 git add fatal（毒丸）。典型来源：bash 里误用 cmd 风格
  //    `> nul` 重定向——bash 会创建名为 nul 的真实文件。同步实现：
  //    pi-git-trace/src/engine.ts isWindowsReservedPath 与
  //    pi-web-ext/aiti-git-trace/trace-core.ts isWindowsReservedPath。
  "nul", "nul.*", "con", "con.*", "prn", "prn.*", "aux", "aux.*",
  "com1", "com1.*", "com2", "com2.*", "com3", "com3.*", "com4", "com4.*",
  "com5", "com5.*", "com6", "com6.*", "com7", "com7.*", "com8", "com8.*",
  "com9", "com9.*",
  "lpt1", "lpt1.*", "lpt2", "lpt2.*", "lpt3", "lpt3.*", "lpt4", "lpt4.*",
  "lpt5", "lpt5.*", "lpt6", "lpt6.*", "lpt7", "lpt7.*", "lpt8", "lpt8.*",
  "lpt9", "lpt9.*",
];

export interface LetGoCheck {
  /** 返回应被「让位」剔除的模式（用户仓已显式 track） */
  dropped: Set<string>;
}

/**
 * 生成 aiti-excludes 文件内容（版本戳 + 去重 + 让位过滤）。
 * 注意：gitignore 否定规则限制——父目录被整目录排除时子路径无法用 ! 救回，
 * 文档 §9 已注明。
 */
export function renderExcludesFile(opts: {
  extraExcludes?: string[];
  includeExtra?: string[];
  dropped?: Set<string>;
}): string {
  const dropped = opts.dropped ?? new Set<string>();
  const seen = new Set<string>();
  const lines: string[] = [];
  lines.push(`# aiti-excludes v${EXCLUDES_VERSION} —— 构建产物 / 依赖 / 缓存 / 临时物；锁文件与 .env 不在列`);
  // 追踪仓自身不入库（§13.3①：git 不自动排除非 .git 名 gitdir，实证 ls-files --others 会吸入 store 内部文件）
  lines.push(".aiti-trace/");
  for (const raw of BUILTIN_EXCLUDES) {
    const pat = raw.trim();
    if (!pat || pat.startsWith("#")) continue;
    if (seen.has(pat)) continue;
    if (dropped.has(pat)) {
      lines.push(`# [让位] ${pat}  # 用户仓已显式 track，内置排除自动跳过`);
      continue;
    }
    seen.add(pat);
    lines.push(pat);
  }
  if (opts.extraExcludes?.length) {
    lines.push("# —— 用户追加（trace.excludeExtra）");
    for (const p of opts.extraExcludes) {
      const pat = p.trim();
      if (pat && !seen.has(pat)) {
        seen.add(pat);
        lines.push(pat);
      }
    }
  }
  if (opts.includeExtra?.length) {
    lines.push("# —— 用户豁免（trace.includeExtra，! 否定）");
    for (const p of opts.includeExtra) {
      const pat = p.trim();
      if (pat) lines.push(pat);
    }
  }
  return [
    "# --- aiti managed v1 ---",
    ...lines,
    "# --- end aiti managed ---",
  ].join("\n") + "\n";
}
