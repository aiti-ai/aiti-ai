/**
 * aiti-git-trace WP-A —— bash/tool 路径识别纯函数（方案 §7.1）。
 * 供 WP-B 接入。表驱动、best-effort：解析不了就跳过，绝不抛错。
 *
 * 两个入口：
 *  - parseToolWritePath(input, cwd)  write/edit 类工具的 path 参数 → 绝对路径
 *  - parseBashTargets(command, cwd)  bash 识别 → { cwdEscapes, switchedDirs }
 *      cwdEscapes   落在起始 cwd 之外的写目标（重定向/tee/cp|mv 目标/sed -i/dd of=）
 *      switchedDirs 命令切换进入的目录（cd/pushd 目标 + git -C / make -C / tar -C /
 *                   npm --prefix / env -C / systemctl --root 等改基点旗标值）
 */
import * as path from "node:path";
import * as os from "node:os";

/* ------------------------------------------------------------------ */
/* 公共类型与默认规则表                                                  */
/* ------------------------------------------------------------------ */

export interface BashTargetsResult {
  /** 落在起始 cwd 之外的写目标绝对路径（去重、保序） */
  cwdEscapes: string[];
  /** 命令切换进入的目录绝对路径（cd/pushd 目标 + 改基点旗标值；去重、保序） */
  switchedDirs: string[];
  /**
   * 全部写目标绝对路径（cwd 内 + 逃逸，含重定向/tee/cp|mv 目标/sed -i/dd of=；
   * ignoreTargets 已剔除；去重、保序）。P0-3b 命中仓判定消费：cwd 内写入嵌套子仓的
   * 场景（无 cd、无逃逸）此前不可见，靠它按需注册副仓。
   */
  writeTargets: string[];
}

export interface BashRecognizeOptions {
  /** `~` 展开用的 home（默认 os.homedir()；测试注入） */
  home?: string;
  /** 命令 → 改基点旗标列表（旗标值同时计入 switchedDirs） */
  flagBasisCmds?: Record<string, string[]>;
  /** 全部非旗标参数都是写目标的命令（tee 类） */
  writeAllArgsCmds?: string[];
  /** 最后一个非旗标参数是写目标的命令（cp/mv 类；支持 `-t <dir>` 指定目标目录） */
  writeLastArgCmds?: string[];
  /** 行内编辑命令：出现匹配 inlineFlags 的旗标时，跳过首个非旗标参数（脚本表达式），其余为写目标 */
  inlineEditCmds?: { cmds: string[]; inlineFlags: RegExp }[];
  /** `VAR=<path>` 形式的写目标变量名（dd of=…） */
  assignTargetVars?: string[];
  /** 永不计为逃逸的写目标（默认 /dev/null） */
  ignoreTargets?: string[];
}

export const DEFAULT_BASH_RECOGNIZE_OPTIONS: Required<BashRecognizeOptions> = {
  home: os.homedir(),
  flagBasisCmds: {
    git: ["-C"],
    make: ["-C"],
    tar: ["-C"],
    npm: ["--prefix"],
    env: ["-C"],
    systemctl: ["--root"],
  },
  writeAllArgsCmds: ["tee"],
  writeLastArgCmds: ["cp", "mv"],
  inlineEditCmds: [{ cmds: ["sed"], inlineFlags: /^(-i|--in-place)/ }],
  assignTargetVars: ["of"],
  ignoreTargets: ["/dev/null"],
};

/** 透明转发包装命令（取其后真正的命令再识别） */
const WRAPPER_CMDS = new Set(["sudo", "nohup", "nice", "stdbuf", "command", "exec", "time"]);

/* ------------------------------------------------------------------ */
/* 工具函数                                                            */
/* ------------------------------------------------------------------ */

/** target 是否在 parent 内（含相等）。纯字符串判定，不碰 fs。 */
export function isWithinPath(parent: string, target: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(target));
  return rel === "" || (!rel.startsWith(".." + path.sep) && rel !== ".." && !path.isAbsolute(rel));
}

/** ~ 与变量/通配符处理后的绝对路径解析；解析不了返回 null（绝不抛错）。 */
function resolveAbs(basis: string, word: string, home: string): string | null {
  if (!word) return null;
  if (word.includes("$") || /[*?[]/.test(word)) return null; // 变量/通配：静态不可解析
  let w = word;
  if (w === "~") return home || null;
  if (w.startsWith("~/") && home) w = path.join(home, w.slice(2));
  else if (w.startsWith("~")) return null; // ~user 展开不了
  try {
    const abs = w.startsWith("/") ? path.normalize(w) : path.resolve(basis, w);
    return path.isAbsolute(abs) ? abs : null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* 词法：命令 → token 流（引号/转义/重定向/子 shell/heredoc）             */
/* ------------------------------------------------------------------ */

type Tok = { t: "word"; v: string } | { t: "op"; v: string };

/**
 * 词法器按平台选（lessons §6「bash 转义吃 \」欠账，2026-09-19）：
 *  - POSIX：bash 词法（\ 转义下一字符、\<newline> 行续接、"…\"…" 引内转义）
 *  - win32：\ 是字面字符（cmd/PowerShell 路径 C:\a\b 不再被吃成 C:Usersa…）；
 *    引号/操作符/heredoc 语义不变
 */
const WIN_LEX = process.platform === "win32";

/**
 * 词法器（尽力而为）：
 *  - 引号（'…' / "…"）、反斜杠转义（POSIX；win32 字面）
 *  - 控制操作符：; && || | & 换行 ( )
 *  - 重定向：> >> 2> 2>> &> &>> 1> <>（fd 数字仅在整词全为数字时归属操作符）
 *  - heredoc（<< <<-"）吞掉 body；here-string（<<<）吞掉其后一词
 *  - $(…) `…` 进程替换 <(…) >(…) 产出不透明词（内容不识别）
 *  - 注释 #…（词首才生效）；行续接 \<newline>（POSIX）
 */
function lex(input: string): Tok[] {
  const toks: Tok[] = [];
  const pendingHeredoc: string[] = [];
  let word = "";
  const pushWord = () => {
    if (word !== "") {
      toks.push({ t: "word", v: word });
      word = "";
    }
  };
  let i = 0;
  const n = input.length;
  try {
    while (i < n) {
      const c = input[i];
      // 行续接（POSIX 词法；win32 的 \ 是字面路径字符）
      if (!WIN_LEX && c === "\\" && input[i + 1] === "\n") {
        i += 2;
        continue;
      }
      if (!WIN_LEX && c === "\\") {
        if (input[i + 1] !== undefined) {
          word += input[i + 1];
          i += 2;
        } else i++;
        continue;
      }
      if (c === " " || c === "\t" || c === "\n") {
        if (c === "\n") {
          pushWord();
          toks.push({ t: "op", v: "\n" });
          // bash 语义：heredoc body 从下一行开始，按挂起的分隔符逐个吞到对应分隔符行
          if (pendingHeredoc.length) {
            for (const delim of pendingHeredoc) {
              while (i < n) {
                const eol = input.indexOf("\n", i);
                const line = eol === -1 ? input.slice(i) : input.slice(i, eol);
                if (line.trim() === delim) {
                  i = eol === -1 ? n : eol + 1;
                  break;
                }
                if (eol === -1) i = n;
                else i = eol + 1;
              }
            }
            pendingHeredoc.length = 0;
          }
        } else pushWord();
        i++;
        continue;
      }
      // 注释（词首才生效）
      if (c === "#" && word === "") {
        while (i < n && input[i] !== "\n") i++;
        continue;
      }
      // 单引号：字面
      if (c === "'") {
        i++;
        while (i < n && input[i] !== "'") word += input[i++];
        i++;
        continue;
      }
      // 双引号：POSIX 允许 \" 转义（win32 \ 字面）；$( 与 ` 简化为字面（含 $ 的词本就跳过）
      if (c === '"') {
        i++;
        while (i < n && input[i] !== '"') {
          if (!WIN_LEX && input[i] === "\\" && i + 1 < n) {
            word += input[i + 1];
            i += 2;
          } else {
            word += input[i++];
          }
        }
        i++;
        continue;
      }
      // $(…) / ${…}：不透明词
      if (c === "$" && (input[i + 1] === "(" || input[i + 1] === "{")) {
        const open = input[i + 1];
        const close = open === "(" ? ")" : "}";
        let depth = 1;
        i += 2;
        const start = i;
        while (i < n && depth > 0) {
          if (input[i] === open) depth++;
          else if (input[i] === close) depth--;
          if (depth > 0) i++;
        }
        word += "$(" + input.slice(start, i) + ")";
        i++;
        continue;
      }
      // 反引号：不透明词
      if (c === "`") {
        i++;
        const start = i;
        while (i < n && input[i] !== "`") i++;
        word += "$(" + input.slice(start, i) + ")";
        i++;
        continue;
      }
      // 进程替换 <(…) >(…)：吞掉括号平衡内容，产出不透明词
      if ((c === "<" || c === ">") && input[i + 1] === "(") {
        let depth = 1;
        i += 2;
        while (i < n && depth > 0) {
          if (input[i] === "(") depth++;
          else if (input[i] === ")") depth--;
          i++;
        }
        pushWord();
        continue;
      }
      // 子 shell 括号
      if (c === "(" || c === ")") {
        pushWord();
        toks.push({ t: "op", v: c });
        i++;
        continue;
      }
      // 重定向 family
      if (c === ">" || c === "<") {
        // fd 数字仅整词全为数字时归属操作符
        if (word !== "" && /^\d+$/.test(word)) word = "";
        pushWord();
        if (c === ">") {
          if (input[i + 1] === ">") {
            toks.push({ t: "op", v: ">>" });
            i += 2;
          } else {
            toks.push({ t: "op", v: ">" });
            i++;
          }
          continue;
        }
        // '<' family
        if (input.startsWith("<<<", i)) {
          // here-string：吞掉其后一词
          i += 3;
          while (i < n && (input[i] === " " || input[i] === "\t")) i++;
          const start = i;
          while (i < n && input[i] !== " " && input[i] !== "\t" && input[i] !== "\n") i++;
          i = start === i ? i : i; // 词内容直接丢弃
          continue;
        }
        if (input.startsWith("<<", i)) {
          const hereStr = input.startsWith("<<<", i);
          if (hereStr) continue;
          // heredoc：分隔符只读一词挂起；body 在换行处统一消费（同一行其余内容照常词法化）
          i += 2;
          if (input[i] === "-") i++;
          while (i < n && (input[i] === " " || input[i] === "\t")) i++;
          let delim = "";
          while (i < n && input[i] !== " " && input[i] !== "\t" && input[i] !== "\n") delim += input[i++];
          delim = delim.replace(/^["']|["']$/g, "");
          if (delim) pendingHeredoc.push(delim);
          continue;
        }
        if (input[i + 1] === ">") {
          toks.push({ t: "op", v: "<>" });
          i += 2;
        } else {
          toks.push({ t: "op", v: "<" });
          i++;
        }
        continue;
      }
      if (c === "&" && input[i + 1] === ">") {
        // &> / &>> → stdout+stderr 重定向
        pushWord();
        if (input[i + 2] === ">") {
          toks.push({ t: "op", v: ">>" });
          i += 3;
        } else {
          toks.push({ t: "op", v: ">" });
          i += 2;
        }
        continue;
      }
      if (c === "&") {
        pushWord();
        if (input[i + 1] === "&") {
          toks.push({ t: "op", v: "&&" });
          i += 2;
        } else {
          toks.push({ t: "op", v: "&" });
          i++;
        }
        continue;
      }
      if (c === "|") {
        pushWord();
        if (input[i + 1] === "|") {
          toks.push({ t: "op", v: "||" });
          i += 2;
        } else {
          toks.push({ t: "op", v: "|" });
          i++;
        }
        continue;
      }
      if (c === ";") {
        pushWord();
        toks.push({ t: "op", v: ";" });
        i++;
        continue;
      }
      // 普通词字符
      word += c;
      i++;
    }
  } catch {
    // 尽力而为：词法意外中断也返回已解析部分
  }
  pushWord();
  return toks;
}

/* ------------------------------------------------------------------ */
/* 引擎：分段 + 基点栈 + 规则表匹配                                      */
/* ------------------------------------------------------------------ */

interface Segment {
  words: string[];
  redirectTargets: string[];
}

function cmdName(w: string): string {
  const base = w.split("/").pop() ?? w;
  return base;
}

function parseBash(command: string, cwd: string, o: Required<BashRecognizeOptions>): BashTargetsResult {
  const res: BashTargetsResult = { cwdEscapes: [], switchedDirs: [], writeTargets: [] };
  const escapes = new Set<string>();
  const dirs = new Set<string>();
  const writes = new Set<string>();
  const startCwd = path.resolve(cwd); // 逃逸判定基准；绝不用 stacks[0][0]（会被 cd 改写）
  const toks = lex(command);

  let stacks: string[][] = [[path.resolve(cwd)]];
  let seg: Segment = { words: [], redirectTargets: [] };
  let pendingRedirect: string | null = null;

  const top = () => stacks[stacks.length - 1][stacks[stacks.length - 1].length - 1];
  const classifyTargets = (targets: (string | null)[]) => {
    for (const t of targets) {
      if (!t) continue;
      if (o.ignoreTargets.includes(t)) continue;
      writes.add(t);
      if (!isWithinPath(startCwd, t)) escapes.add(t);
    }
  };

  const processSegment = () => {
    try {
      if (seg.words.length === 0 && seg.redirectTargets.length === 0) return;
      const top0 = top();
      // 重定向目标（相对 shell 当前目录，不受命令旗标影响）
      classifyTargets(seg.redirectTargets.map((w) => resolveAbs(top0, w, o.home)));

      let j = 0;
      // 透明包装
      while (j < seg.words.length && WRAPPER_CMDS.has(seg.words[j])) j++;
      if (j >= seg.words.length) return;
      const cmd = cmdName(seg.words[j]);
      const args = seg.words.slice(j + 1);

      // —— cd / pushd / popd（跨段持久）——
      if (cmd === "cd" || cmd === "pushd" || cmd === "popd") {
        const rest = args.filter((a) => a !== "-L" && a !== "-P" && a !== "--");
        if (cmd === "popd") {
          if (stacks[stacks.length - 1].length > 1) stacks[stacks.length - 1].pop();
          return;
        }
        const target = rest.find((a) => a !== "-");
        if (!target || target === "~") {
          if (o.home) {
            if (cmd === "pushd") stacks[stacks.length - 1].push(o.home);
            else stacks[stacks.length - 1][stacks[stacks.length - 1].length - 1] = o.home;
            dirs.add(o.home);
          }
          return;
        }
        const abs = resolveAbs(top(), target, o.home);
        if (abs) {
          if (cmd === "pushd") stacks[stacks.length - 1].push(abs);
          else stacks[stacks.length - 1][stacks[stacks.length - 1].length - 1] = abs;
          dirs.add(abs);
        }
        return;
      }

      // —— 改基点旗标（仅本命令生效，计入 switchedDirs）——
      let effBasis = top0;
      const flagList = o.flagBasisCmds[cmd];
      if (flagList) {
        for (let k = 0; k < args.length; k++) {
          const w = args[k];
          if (flagList.includes(w) && args[k + 1] !== undefined) {
            const d = resolveAbs(top0, args[k + 1], o.home);
            if (d) {
              dirs.add(d);
              effBasis = d;
            }
            k++;
          } else {
            const f = flagList.find((fl) => fl.length > 1 && w.startsWith(fl) && w.length > fl.length);
            if (f) {
              let val = w.slice(f.length);
              if (val.startsWith("=")) val = val.slice(1);
              const d = resolveAbs(top0, val, o.home);
              if (d) {
                dirs.add(d);
                effBasis = d;
              }
            }
          }
        }
      }

      // —— 写目标规则 ——
      const isFlag = (w: string) => w.startsWith("-");
      const targets: (string | null)[] = [];
      if (o.writeAllArgsCmds.includes(cmd)) {
        for (const w of args) if (!isFlag(w)) targets.push(resolveAbs(top0, w, o.home));
      } else if (o.writeLastArgCmds.includes(cmd)) {
        let tDir: string | null = null;
        const operands: string[] = [];
        for (let k = 0; k < args.length; k++) {
          const w = args[k];
          if (w === "-t" && args[k + 1] !== undefined) {
            tDir = resolveAbs(top0, args[k + 1], o.home);
            k++;
          } else if (!isFlag(w)) operands.push(w);
        }
        if (tDir) targets.push(tDir);
        else if (operands.length > 0) targets.push(resolveAbs(effBasis, operands[operands.length - 1], o.home));
      } else {
        const inline = o.inlineEditCmds.find((r) => r.cmds.includes(cmd));
        if (inline && args.some((w) => inline.inlineFlags.test(w))) {
          const operands = args.filter((w) => !isFlag(w));
          // 首个非旗标参数是脚本表达式，跳过；其余为写目标文件
          for (let k = 1; k < operands.length; k++) targets.push(resolveAbs(top0, operands[k], o.home));
        }
        for (const w of args) {
          const m = /^([A-Za-z_][A-Za-z0-9_]*?)=(.*)$/.exec(w);
          if (m && o.assignTargetVars.includes(m[1]) && m[2]) {
            targets.push(resolveAbs(effBasis, m[2], o.home));
          }
        }
      }
      classifyTargets(targets);
    } catch {
      // 尽力而为
    }
  };

  const flush = () => {
    processSegment();
    seg = { words: [], redirectTargets: [] };
    pendingRedirect = null;
  };

  for (const tok of toks) {
    if (tok.t === "word") {
      if (pendingRedirect !== null) {
        seg.redirectTargets.push(tok.v);
        pendingRedirect = null;
      } else {
        seg.words.push(tok.v);
      }
      continue;
    }
    switch (tok.v) {
      case ";":
      case "\n":
      case "&&":
      case "||":
      case "|":
      case "&":
        flush();
        break;
      case "(":
        flush();
        stacks.push([...stacks[stacks.length - 1]]);
        break;
      case ")":
        flush();
        if (stacks.length > 1) stacks.pop();
        break;
      case ">":
      case ">>":
      case "<>":
        flush();
        pendingRedirect = tok.v;
        break;
      case "<":
        break;
      default:
        break;
    }
  }
  flush();

  res.cwdEscapes = [...escapes];
  res.switchedDirs = [...dirs];
  res.writeTargets = [...writes];
  return res;
}

/** bash 识别入口（任何输入都不抛错）。 */
export function parseBashTargets(
  command: string,
  cwd: string,
  options?: BashRecognizeOptions,
): BashTargetsResult {
  if (typeof command !== "string" || !cwd) return { cwdEscapes: [], switchedDirs: [], writeTargets: [] };
  const o: Required<BashRecognizeOptions> = {
    ...DEFAULT_BASH_RECOGNIZE_OPTIONS,
    ...options,
    home: options?.home ?? DEFAULT_BASH_RECOGNIZE_OPTIONS.home,
  };
  try {
    return parseBash(command, cwd, o);
  } catch {
    return { cwdEscapes: [], switchedDirs: [] };
  }
}

/* ------------------------------------------------------------------ */
/* tool 入口                                                           */
/* ------------------------------------------------------------------ */

/** write/edit 类工具的 path 参数 → 绝对路径；取不到/解析不了返回 null。 */
export function parseToolWritePath(
  input: Record<string, unknown> | undefined,
  cwd: string,
  home: string = os.homedir(),
): string | null {
  try {
    if (!input) return null;
    const v = input.file_path ?? input.path;
    if (typeof v !== "string" || !v.trim()) return null;
    return resolveAbs(cwd, v.trim(), home);
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* bash 可变性分类（P0-1 只读短路；方案 §P0-1）                          */
/* ------------------------------------------------------------------ */

export type BashMutability = "readonly" | "maybe-write";

/**
 * 只读白名单（保守集合，白名单外一律 maybe-write）。判定错向容忍度：
 * 只读误判为写 = 可接受（多一次探测）；写误判为读 = 零容忍（变更漏记）。
 * 因此凡有文件写副作用的命令/旗标一律不在表内，由下方危险旗标表二次拦截。
 */
const MUTABLE_READONLY_CMDS = new Set([
  // 纯查询（方案清单）
  "ls", "cat", "head", "tail", "wc", "grep", "rg", "find", "which", "type", "pwd",
  "date", "env", "printenv", "ps", "df", "du", "stat", "file", "readlink", "whoami",
  "id", "uptime", "echo", "printf", "jq", "tree",
  // 保守补充：无文件写副作用的常见读命令（重定向已被全局重定向扫描拦截）
  "sleep", "true", "false", "test", "[", ":", "basename", "dirname", "realpath",
  "sort", "uniq", "diff", "cmp", "comm", "cut", "paste", "tr", "nl", "od", "xxd",
  "base64", "md5sum", "sha1sum", "sha256sum", "sha512sum", "cksum", "tac", "rev",
  "fold", "fmt", "expand", "unexpand", "seq",
  // 目录栈操作（无文件副作用；cd 探索类只读会话得以整 op 归零）
  "cd", "pushd", "popd",
]);

/** 白名单命令的危险旗标：命中即 maybe-write（sort -o 写文件 / date -s 改时钟 / find 派生写） */
const READONLY_DANGEROUS_FLAGS: Record<string, RegExp> = {
  find: /^(-exec|-execdir|-ok|-okdir|-delete|-fls|-fprint|-fprintf|-fprint0)$/,
  sort: /^(-o|--output)/,
  date: /^(-s|--set)/,
  tree: /^(-o|--output)/,
};

/** git 只读子命令（方案清单 + grep）。branch/remote 需位置参数约束，单独判定。 */
const GIT_READONLY_SUBCOMMANDS = new Set([
  "status", "log", "diff", "show", "rev-parse", "describe", "ls-files",
  "blame", "shortlog", "cat-file", "grep",
]);

/** git 全局旗标中「旗标+值」两词形态（跳过时连值一起跳） */
const GIT_TWO_TOKEN_GLOBALS = new Set([
  "-c", "-C", "--git-dir", "--work-tree", "--namespace", "--super-prefix", "--exec-path",
]);

/**
 * 从词中提取 $(…) 命令替换内容（深度平衡扫描；$((…)) 算术豁免）。
 * 词法器把 $(…) / `…` 产出为不透明词，这里反向拆出内容递归分类。
 */
function extractCommandSubstitutions(word: string): string[] {
  if (!word.includes("$(")) return [];
  const out: string[] = [];
  let i = 0;
  for (;;) {
    const start = word.indexOf("$(", i);
    if (start < 0) break;
    let depth = 0;
    let j = start + 1;
    for (; j < word.length; j++) {
      if (word[j] === "(") depth++;
      else if (word[j] === ")") {
        depth--;
        if (depth === 0) break;
      }
    }
    if (depth !== 0) break; // 不平衡：放弃（词法器本应产出平衡词）
    const inner = word.slice(start + 2, j);
    // $((…)) 算术展开（紧邻形态）：无 fork 无文件副作用，豁免。
    // 注意 `$( (cmd) )`（带空格）是命令替换+子 shell，必须照常递归。
    if (!inner.startsWith("(") && inner.trim()) out.push(inner);
    i = j + 1;
  }
  return out;
}

/** env 特判：跳过赋值与旗标后，首个真实参数是被执行的命令 → 递归分类；无参数 = 纯打印 */
function classifyEnvArgs(args: string[]): BashMutability {
  for (let k = 0; k < args.length; k++) {
    const w = args[k];
    if (w === "-C" || w === "-u") { k++; continue; } // 带值旗标
    if (w.startsWith("-")) continue; // 无值旗标（-i/-0…）
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) continue; // VAR=val
    return classifyBashMutability(w);
  }
  return "readonly";
}

/** git 命令分类：跳过全局旗标 → 子命令白名单 + branch/remote 位置参数约束 */
function classifyGitArgs(args: string[]): BashMutability {
  let k = 0;
  while (k < args.length) {
    const w = args[k];
    if (GIT_TWO_TOKEN_GLOBALS.has(w) && !w.includes("=")) { k += 2; continue; }
    if (w.startsWith("-")) { k++; continue; }
    break;
  }
  if (k >= args.length) return "readonly"; // 裸 git（usage 输出）
  const sub = args[k];
  const rest = args.slice(k + 1);
  if (sub === "branch") {
    const positionals = rest.filter((w) => !w.startsWith("-"));
    return positionals.length === 0 || rest.includes("--list") ? "readonly" : "maybe-write";
  }
  if (sub === "remote") {
    return rest.filter((w) => !w.startsWith("-")).length === 0 ? "readonly" : "maybe-write";
  }
  if (!GIT_READONLY_SUBCOMMANDS.has(sub)) return "maybe-write";
  if (rest.some((w) => w.startsWith("--output"))) return "maybe-write"; // diff 家族 --output=<file> 写文件
  return "readonly";
}

/** 单命令段分类（词法后、包装/赋值已剥离） */
function classifySimpleCommand(cmd: string, args: string[]): BashMutability {
  if (cmd === "git") return classifyGitArgs(args);
  if (!MUTABLE_READONLY_CMDS.has(cmd)) return "maybe-write";
  const danger = READONLY_DANGEROUS_FLAGS[cmd];
  if (danger && args.some((a) => danger.test(a))) return "maybe-write";
  if (cmd === "env") return classifyEnvArgs(args);
  return "readonly";
}

/**
 * bash 命令可变性分类（P0-1 只读短路第一层：静态判定）。
 *
 * "readonly" = 保守白名单全命中且无任何写特征 → 整个 op 不记账（0 条 git 命令）；
 * "maybe-write" = 白名单外/含写特征/无法静态判定 → 走 P0-2 探测门。
 *
 * 判定层次：
 *   ① 进程替换 <(…) >(…)：内容不可静态判定 → maybe-write；
 *   ② 全局重定向扫描（> >> <> &> &>> 2> >|）：写目标即 maybe-write；
 *      豁免两类：>&N fd 复制（2>&1）与 >/dev/null（设备，不可能落盘）；
 *   ③ 逐段（&& ; | & 换行 ( ) 分段）白名单判定，任一段 maybe-write → 整条 maybe-write；
 *      词内 $(…)/`…` 命令替换递归分类；$((…)) 算术豁免。
 * 任何输入不抛错；异常输入一律 maybe-write（保守）。
 */
export function classifyBashMutability(command: string): BashMutability {
  if (typeof command !== "string") return "maybe-write";
  const trimmed = command.trim();
  if (!trimmed) return "readonly";
  if (/<\(|>\(/.test(trimmed)) return "maybe-write"; // ① 进程替换内容被词法器吞掉
  const toks = lex(trimmed);
  // ② 全局重定向扫描
  for (let i = 0; i < toks.length; i++) {
    const tok = toks[i];
    if (tok.t !== "op" || (tok.v !== ">" && tok.v !== ">>" && tok.v !== "<>")) continue;
    const a = toks[i + 1];
    const b = toks[i + 2];
    if (a && a.t === "op" && a.v === "&" && b && b.t === "word" && /^\d+$/.test(b.v)) continue; // >&N fd 复制
    if (a && a.t === "word" && a.v === "/dev/null") continue; // 设备目标
    return "maybe-write";
  }
  // ③ 逐段白名单（重定向目标词已被消费，不进段）
  let words: string[] = [];
  let skipNextWord = false;
  const flushSeg = (): BashMutability | null => {
    if (words.length === 0) return null;
    const seg = words;
    words = [];
    // 词内命令替换递归分类
    for (const w of seg) {
      for (const inner of extractCommandSubstitutions(w)) {
        if (classifyBashMutability(inner) === "maybe-write") return "maybe-write";
      }
    }
    // 前置赋值（FOO=bar cmd；纯赋值段 = 仅 shell 环境）
    let j = 0;
    while (j < seg.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(seg[j])) j++;
    if (j >= seg.length) return "readonly";
    // 透明包装（复用 WRAPPER_CMDS；其后紧邻旗标一并跳过，time -p ls 等）。
    // sudo 例外：改变命令解析语义（secure_path/提权），零容忍方向恒保守判写。
    while (j < seg.length && WRAPPER_CMDS.has(seg[j])) {
      if (seg[j] === "sudo") return "maybe-write";
      j++;
      while (j < seg.length && seg[j].startsWith("-")) j++;
    }
    if (j >= seg.length) return "readonly";
    return classifySimpleCommand(cmdName(seg[j]), seg.slice(j + 1));
  };
  for (const tok of toks) {
    if (tok.t === "word") {
      if (skipNextWord) { skipNextWord = false; continue; } // 重定向目标词
      words.push(tok.v);
      continue;
    }
    if (tok.v === ">" || tok.v === ">>" || tok.v === "<>" || tok.v === "<") {
      skipNextWord = true;
      continue;
    }
    const r = flushSeg();
    if (r === "maybe-write") return "maybe-write";
  }
  const r = flushSeg();
  if (r === "maybe-write") return "maybe-write";
  return "readonly";
}
