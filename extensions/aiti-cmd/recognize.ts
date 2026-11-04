/**
 * aiti-cmd · 命令识别（服务端）
 *
 * 现成方案优先（不造轮子）：
 *   - 命令存在性：`command-exists`（跨平台 which/where，含 builtin）
 *   - shell 词法解析：`shell-quote`（正确处理引号/转义，不执行）
 *   - 安装建议：Linux 调 Ubuntu 原生 `/usr/lib/command-not-found`（查 apt/snap 数据库）
 * 自制部分：词库（数据）、词库扫描正则（一次交替 matchAll）、危险检测、描述。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createRequire } from "node:module";
import { extractParams } from "./store.js";

const require = createRequire(import.meta.url);
const commandExistsPkg: (name: string) => Promise<string | null> = require("command-exists");
const { parse: shellParse } = require("shell-quote") as { parse: (s: string) => unknown[] };
const cmdExists = (name: string) => Promise.resolve(commandExistsPkg(name)).then((p) => !!p).catch(() => false);

// ---------------- 内置常用命令词库（分门别类；desc = 分类描述） ----------------
export const COMMAND_DICT: Array<{ group: string; desc: string; names: string[]; phrases: string[] }> = [
  { group: "包管理", desc: "安装/运行/管理项目依赖（npm/yarn/pnpm/bun）", names: ["npm", "yarn", "pnpm", "bun", "npx", "node", "deno", "corepack", "npm-run", "pnpm-dlx"], phrases: ["npm run", "npm install", "npm i", "npm ci", "npm start", "npm test", "npm publish", "yarn add", "yarn install", "yarn dev", "yarn build", "pnpm install", "pnpm add", "pnpm dev", "pnpm build", "pnpm test", "pnpm run", "pnpm dlx", "bun install", "bun run", "bunx", "corepack enable", "npm exec"] },
  { group: "构建/前端", desc: "构建/测试/前端工具链（make/tsc/vite/jest）", names: ["make", "mvn", "gradle", "cargo", "go", "rustc", "tsc", "tsx", "vite", "next", "webpack", "eslint", "prettier", "jest", "vitest", "playwright", "cypress"], phrases: ["npm run build", "pnpm run build", "yarn build", "cargo build", "cargo run", "cargo test", "go build", "go run", "go test", "go mod tidy", "tsc --noEmit", "vite dev", "next dev", "next build", "eslint --fix", "prettier --write", "vitest run", "jest --watch"] },
  { group: "版本控制", desc: "代码版本管理（Git）", names: ["git", "gh"], phrases: ["git status", "git add", "git stash", "git diff", "git log", "git commit", "git push", "git pull", "git clone", "git branch", "git checkout", "git merge", "git rebase", "git reset", "git clean", "git fetch", "git rm", "git mv", "git stash pop", "git config", "git init", "git remote", "git tag", "git show", "git blame", "git cherry-pick", "git switch", "git restore", "git worktree", "gh pr", "gh repo", "gh issue"] },
  { group: "系统/文件", desc: "Linux 系统与文件操作", names: ["sudo", "su", "ls", "cd", "pwd", "cat", "tail", "head", "grep", "find", "ps", "kill", "pkill", "top", "htop", "free", "df", "du", "uptime", "uname", "whoami", "date", "sleep", "clear", "echo", "env", "export", "which", "type", "alias", "history", "touch", "mkdir", "cp", "mv", "rm", "chmod", "chown", "ln", "tar", "zip", "unzip", "tree", "wc", "sort", "uniq", "cut", "tr", "sed", "awk", "tee", "xargs", "watch", "less", "more", "stat", "file", "diff", "patch", "locate", "updatedb"], phrases: ["sudo apt", "sudo systemctl", "ls -la", "tail -f", "grep -r", "find .", "ps aux", "ps -ef", "df -h", "du -sh", "free -h", "chmod +x", "tar -xzf", "tar -czf", "unzip -o", "rm -rf", "mkdir -p", "cp -r", "mv -f", "chown -R", "ln -s", "wc -l", "sort -n", "uniq -c", "sed -i", "xargs -I", "watch -n", "kill -9"] },
  { group: "网络", desc: "网络诊断/传输（curl/ssh/rsync）", names: ["curl", "wget", "ping", "ip", "ss", "netstat", "ssh", "scp", "rsync", "nslookup", "dig", "traceroute", "nc", "telnet", "ufw", "iptables", "firewall-cmd"], phrases: ["curl -s", "curl -L", "wget -O", "ping -c", "ssh -L", "ssh -R", "scp -r", "rsync -av", "ip addr", "ip link", "ss -tlnp", "netstat -tlnp", "dig +short", "traceroute -n", "nc -l"] },
  { group: "容器/编排", desc: "容器与编排（Docker/K8s）", names: ["docker", "docker-compose", "kubectl", "helm", "podman", "minikube", "kind"], phrases: ["docker ps", "docker ps -a", "docker images", "docker run", "docker exec", "docker logs", "docker build", "docker pull", "docker push", "docker rm", "docker rmi", "docker-compose up", "docker-compose down", "docker-compose logs", "docker-compose build", "kubectl get", "kubectl logs", "kubectl describe", "kubectl apply", "kubectl delete", "kubectl exec", "kubectl port-forward", "helm install", "helm upgrade", "helm list"] },
  { group: "数据库", desc: "数据库客户端（MySQL/Postgres/Redis）", names: ["mysql", "psql", "sqlite3", "mongosh", "redis-cli"], phrases: ["mysql -u", "mysql -e", "psql -c", "psql -d", "sqlite3", "redis-cli", "mongosh"] },
  { group: "进程/后台/服务", desc: "进程管理/后台运行/系统服务", names: ["nohup", "setsid", "disown", "bg", "fg", "jobs", "wait", "killall", "pgrep", "strace", "ltrace", "gdb", "timeout", "nice", "renice", "pm2", "systemctl", "journalctl", "service", "daemonize", "taskset", "ulimit"], phrases: ["nohup ... &", "systemctl status", "systemctl start", "systemctl stop", "systemctl restart", "systemctl enable", "journalctl -f", "journalctl -u", "service restart", "service status", "pm2 start", "pm2 logs", "pm2 restart", "pm2 stop", "pm2 list", "strace -f", "gdb --batch", "timeout 10"] },
  { group: "云/基础设施", desc: "云平台与 IaC（AWS/GCP/Terraform）", names: ["gcloud", "aws", "az", "terraform"], phrases: ["gcloud compute", "aws s3", "aws ec2", "aws lambda", "terraform init", "terraform plan", "terraform apply", "az login", "az group"] },
  { group: "编辑器/查看", desc: "编辑器/文本处理/查看工具", names: ["vim", "nano", "code", "open", "xdg-open", "man", "rg", "ag", "jq", "yq"], phrases: ["code .", "code --goto", "jq .", "rg -n", "man ls"] },
];

// 扁平：命令名集合 + 多词短语（长优先）
const DICT_NAMES = new Set<string>();
const DICT_PHRASES: string[] = [];
for (const g of COMMAND_DICT) {
  for (const n of g.names) DICT_NAMES.add(n);
  for (const p of g.phrases) if (!DICT_PHRASES.includes(p)) DICT_PHRASES.push(p);
}
DICT_PHRASES.sort((a, b) => b.length - a.length);

// ---------------- 一次性交替正则（加载时构建，一次 matchAll 全命中） ----------------
function escRe(s: string) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function buildMasterRegex(phrases: string[], names: string[]): RegExp {
  const all = [...phrases, ...names].sort((a, b) => b.length - a.length);
  return new RegExp("(^|[^\\w./-])(" + all.map(escRe).join("|") + ")(?=$|[^\\w./-])", "g");
}
const BUILTIN_MASTER_RE = buildMasterRegex(DICT_PHRASES, [...DICT_NAMES]);
const BUILTIN_PHRASE_SET = new Set(DICT_PHRASES);
let userReCache: { sig: string; re: RegExp | null } = { sig: "", re: null };
function getUserRegex(dict: UserDict): RegExp | null {
  const sig = JSON.stringify(dict.extra);
  if (userReCache.sig === sig) return userReCache.re;
  const phrases: string[] = [];
  const names: string[] = [];
  for (const e of dict.extra) {
    const parts = e.trim().split(/\s+/);
    if (parts.length === 1) names.push(parts[0]);
    else phrases.push(e.trim());
  }
  userReCache = { sig, re: phrases.length || names.length ? buildMasterRegex(phrases, names) : null };
  return userReCache.re;
}

// ---------------- 用户自定义词库（data dir dict.json） ----------------
export interface UserDict { extra: string[] }
export function loadUserDict(configDir: string): UserDict {
  try {
    const f = path.join(configDir, "dict.json");
    if (!fs.existsSync(f)) return { extra: [] };
    const d = JSON.parse(fs.readFileSync(f, "utf8"));
    return { extra: Array.isArray(d.extra) ? d.extra.map(String).filter(Boolean) : [] };
  } catch { return { extra: [] }; }
}
export function saveUserDict(configDir: string, extra: string[]): UserDict {
  const f = path.join(configDir, "dict.json");
  fs.mkdirSync(configDir, { recursive: true });
  const clean = Array.from(new Set(extra.map((s) => String(s).trim()).filter(Boolean)));
  fs.writeFileSync(f, JSON.stringify({ extra: clean }, null, 2) + "\n", { mode: 0o600 });
  return { extra: clean };
}

// ---------------- 命令有效性校验（现成方案 command-exists：跨平台 which/where，含 builtin） ----------------
const existsCache = new Map<string, boolean>();
/** cwd 下 node_modules/.bin 兜底（command-exists 只查 PATH，不含项目本地 bin） */
function localBinLookup(first: string, cwd: string): boolean {
  const exts = process.platform === "win32" ? ["", ".exe", ".cmd", ".bat"] : [""];
  for (const e of exts) {
    try { fs.accessSync(path.join(cwd, "node_modules", ".bin", first + e), fs.constants.X_OK); return true; } catch {}
  }
  return false;
}
/** 校验命令存在（PATH via command-exists + cwd 相对路径 + 项目本地 bin），带缓存 */
export async function commandExists(name: string, cwd?: string): Promise<boolean | undefined> {
  const base = String(name || "").trim();
  if (!base) return undefined;
  const first = base.split(/[\s;&|]+/)[0] || "";
  if (!first) return undefined;
  if (first.includes("/") || first.startsWith(".")) {
    if (!cwd) return undefined;
    try { fs.accessSync(path.resolve(cwd, first), fs.constants.X_OK); return true; } catch { return false; }
  }
  const key = first + "|" + (cwd || "");
  if (existsCache.has(key)) return existsCache.get(key);
  let ok = await cmdExists(first);
  if (!ok && cwd) ok = localBinLookup(first, cwd);
  existsCache.set(key, ok);
  if (existsCache.size > 500) existsCache.clear();
  return ok;
}
/** 批量校验（Promise.all + 缓存），供全文扫描一次收集 */
export async function verifyCommands(names: string[], cwd?: string): Promise<Map<string, boolean>> {
  const uniq = [...new Set(names.map((n) => String(n || "").trim()).filter(Boolean))];
  const out = new Map<string, boolean>();
  const entries = await Promise.all(uniq.map(async (n) => [n, await commandExists(n, cwd)] as const));
  for (const [n, ok] of entries) out.set(n, !!ok);
  return out;
}

// ---------------- 危险模式 → confirm:true ----------------
const DANGER_PATTERNS: Array<[RegExp, string]> = [
  [/rm\s+(-[a-z]*[rf][a-z]*\s+)*[\/~]?(?:\/|\.)\s*$/im, "rm 根目录/父级"],
  [/rm\s+-[a-z]*rf/im, "rm -rf"],
  [/mkfs\.|mkfs\s/im, "mkfs 格式化"],
  [/dd\s+.*of=\/dev\//im, "dd 写块设备"],
  [/>\s*\/dev\/sd[a-z]|>\s*\/dev\/nvm/im, "重定向到块设备"],
  [/\bsudo\b/im, "sudo"],
  [/curl\b.*\|\s*(?:ba)?sh\b/im, "curl|sh 管道执行"],
  [/wget\b.*\|\s*(?:ba)?sh\b/im, "wget|sh 管道执行"],
  [/chmod\s+[-+]?[0-7]{3,}\b/im, "chmod 权限变更"],
];

export interface RecognizedCommand {
  cmd: string;
  danger: string[];
  exists?: boolean;
  params: string[];
  label: string;
  /** 未安装时的安装建议（command not found 结合） */
  installSuggestion?: string;
  /** cd xxx && … 前缀提取的工作目录（运行命令时作为 cwd） */
  workdir?: string;
  /** 去掉 cd xxx && 前缀后的实际命令（纯 cd 或非 cd 前缀时等于 cmd） */
  action?: string;
}

// ---------------- 安装建议（command not found 结合：Linux 原生工具优先） ----------------
const NPMISH = new Set(["npm", "yarn", "pnpm", "bun", "npx", "tsx", "vite", "next", "jest", "vitest", "eslint", "prettier", "playwright", "cypress", "corepack", "ts-node", "nodemon", "esbuild", "tailwindcss"]);
const IS_WIN = process.platform === "win32";
const IS_MAC = process.platform === "darwin";
export async function suggestInstall(cmd: string): Promise<string | null> {
  const t = String(cmd || "").trim();
  const first = (firstToken(t) || "").replace(/^\.\//, "");
  if (!first) return null;
  if (t.startsWith("./")) return "相对脚本：检查 cwd 下文件是否存在且可执行（chmod +x）";
  // Linux：优先调 Ubuntu 原生 command-not-found（查 apt/snap 数据库，给准确包名/相近命令）
  if (!IS_WIN && !IS_MAC) {
    const native = nativeCommandNotFound(first);
    if (native) return native;
  }
  const pkg = () => IS_WIN ? "winget install " + first : (IS_MAC ? "brew install " + first : "sudo apt install " + first);
  if (NPMISH.has(first)) return "npm install -g " + first + "（或项目内 npm i -D " + first + "）";
  for (const g of COMMAND_DICT) {
    if (!g.names.includes(first)) continue;
    if (g.group === "容器/编排") {
      if (first === "docker") return "安装 Docker：https://docs.docker.com/engine/install/";
      if (first === "kubectl") return "安装 kubectl：https://kubernetes.io/docs/tasks/tools/";
      return pkg();
    }
    if (g.group === "云/基础设施") return first + "：按官方文档安装 CLI（gcloud/aws/az/terraform）";
    if (g.group === "构建/前端") return "npm install -g " + first;
    return pkg();
  }
  return "未找到安装建议：请确认该命令是否属于当前项目或需手动安装";
}
/** Linux 原生 command-not-found：查 apt/snap 数据库 → 准确安装包名/相近命令 */
let cnfCache = new Map<string, string>();
/** 异步 execFile（2026-09-12：command-not-found 5s 同步曾冻结事件循环；调用链 suggestInstall/checkCommand 均已 async 化） */
function cnfExec(first: string): Promise<string> {
  return new Promise((resolve) => {
    import("node:child_process").then(({ execFile }) => {
      execFile("/usr/lib/command-not-found", [first], { encoding: "utf8", timeout: 5000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
        resolve(String((err ? ((err as any).stdout || "") + ((err as any).stderr || "") : stdout) || ""));
      });
    }).catch(() => resolve(""));
  });
}
async function nativeCommandNotFound(first: string): Promise<string | null> {
  if (cnfCache.has(first)) return cnfCache.get(first) || null;
  let text = "";
  try {
    text = await cnfExec(first);
  } catch (e) {
    text = String((e as { stdout?: string; stderr?: string })?.stdout || "") + String((e as { stderr?: string })?.stderr || "");
  }
  if (!text.trim()) return null;
  let out: string | null = null;
  const install = text.match(/can be installed with:\s*([^\n]+)/i);
  if (install) out = install[1].trim();
  else {
    const meant = text.match(/did you mean:\s*\n?\s*command '(\S+)'/i);
    if (meant) out = "相近命令: " + meant[1];
    else out = text.split("\n")[0].trim();
  }
  cnfCache.set(first, out || "");
  if (cnfCache.size > 200) cnfCache.clear();
  return out;
}

// ---------------- 命令描述（管理面板识别：首命令 → 分类/描述/相关短语） ----------------
export interface CommandDescription {
  found: boolean;
  name?: string;
  group?: string;
  desc?: string;
  related?: string[];
  peers?: string[];
}
export function describeCommand(cmd: string): CommandDescription {
  const t = String(cmd || "").trim();
  const first = (firstToken(t) || "").replace(/^\.\//, "");
  if (!first) return { found: false };
  for (const g of COMMAND_DICT) {
    if (g.names.includes(first)) {
      return {
        found: true,
        name: first,
        group: g.group,
        desc: g.desc,
        related: g.phrases.filter((p) => p.split(/\s+/)[0] === first).slice(0, 12),
        peers: g.names.filter((n) => n !== first).slice(0, 12),
      };
    }
  }
  return { found: false };
}

// ---------------- 工具函数 ----------------
/** shell 词法解析取首 token（shell-quote：正确处理引号/转义，不执行） */
export function firstToken(cmd: string): string | null {
  const t = String(cmd || "").trim();
  if (!t) return null;
  try {
    const toks = shellParse(t);
    const first = toks[0];
    if (typeof first === "string" && first) return first;
    return null;
  } catch { return null; }
}

/** 判断一段文本是否像 shell 命令（行首/整行口径） */
export function looksLikeCommand(text: string): boolean {
  const t = String(text || "").trim();
  if (!t || t.length > 500) return false;
  if (/[。！？!?，,]$/u.test(t)) return false;
  if (/\p{Script=Han}/u.test(t)) {
    const first = t.split(/\s+/)[0] || "";
    if (!/^[\w./~-]+$/.test(first)) return false;
    // 中文说明句（命令词开头的解释，如 "pnpm install 是安装依赖的命令"）排除
    if (/^[\w./~-]+(?:\s+\S+){0,3}\s+\S*[是的了]/.test(t)) return false;
  }
  if (/^\$\s+\S/.test(t)) return true;
  const first = firstToken(t);
  if (!first) return false;
  if (first.startsWith("./")) return true;
  return DICT_NAMES.has(first.replace(/^\.\//, ""));
}

// 常见参数词（命令后跟的"参数样式"词：子命令/环境/动作）；不在表内且非 flag/路径/数字的裸英文词视为叙述词 → 停
const PARAM_WORDS = new Set([
  "dev", "build", "test", "start", "stop", "restart", "status", "logs", "up", "down", "run", "watch", "fix", "install", "add", "commit", "push", "pull", "fetch", "merge", "rebase", "check", "list", "get", "set", "rm", "mv", "cp", "edit", "new", "open", "clean", "init", "reset", "clone", "branch", "tag", "stash", "diff", "log", "show", "remote", "config", "stage", "publish", "version", "ci", "release", "preview", "production", "staging", "main", "develop", "origin", "upstream", "force", "verbose", "global", "local", "recursive", "interactive", "quiet", "all", "latest", "next", "prod", "default",
  // K8s/Docker 资源
  "pods", "pod", "deployments", "deployment", "services", "service", "containers", "container", "images", "image", "namespaces", "namespace", "configmaps", "configmap", "secrets", "secret", "volumes", "volume", "replicasets", "jobs", "cronjobs", "statefulsets", "daemonsets", "nodes", "node",
]);

// ---------------- 贪婪尾参数：这些短语后跟的几乎必然是操作对象名（systemd 单元 / git 分支 / 容器 / 包名） ----------------
// 默认 isArgToken 只认 flag/路径/数字/已知参数词/命令名——裸操作对象（如 "systemctl restart pi-web" 的 pi-web、
// "git merge main" 的 main 之类普通词）会被误当叙述词停掉。这些短语的下一 token 放宽：形态为单词（\w./-）即截取；
// 但常见英文功能词（the/to/and…）仍停止，避免英文叙述把命令带歪。
const GREEDY_TAILS = new Set([
  // systemd / 服务管理（下一 token = 单元/服务名）
  "sudo systemctl", "systemctl status", "systemctl start", "systemctl stop", "systemctl restart", "systemctl enable", "systemctl disable", "systemctl reload", "systemctl is-active", "systemctl mask", "systemctl unmask",
  "service start", "service stop", "service restart", "service status",
  "pm2 start", "pm2 stop", "pm2 restart", "pm2 delete", "pm2 logs", "pm2 describe", "pm2 show",
  // git（下一 token = 分支/目标）
  "git checkout", "git switch", "git merge", "git rebase", "git cherry-pick", "git show", "git blame", "git tag", "git restore",
  // docker / k8s / helm（下一 token = 容器/资源名）
  "docker run", "docker exec", "docker logs", "docker stop", "docker start", "docker restart", "docker rm", "docker attach",
  "kubectl logs", "kubectl describe", "kubectl delete", "kubectl exec", "kubectl get", "kubectl apply", "kubectl port-forward", "kubectl rollout",
  "helm install", "helm upgrade", "helm uninstall",
  // 包管理（下一 token = 包名）
  "npm install", "npm i", "npm ci", "yarn add", "yarn install", "pnpm add", "pnpm install", "bun install", "bun add", "apt install", "apt-get install", "brew install", "sudo apt",
  // 命令链常用（下一 token = 操作对象，裸词也截取）：
  //   cd（路径 → workdir 提取）、git 子命令（文件/分支/远程）、npm/pnpm/yarn/bun run（脚本名）
  "cd",
  "git add", "git rm", "git mv", "git stash", "git commit", "git push", "git pull", "git fetch", "git log", "git diff", "git status", "git clone", "git remote", "git config", "git init", "git branch", "git reset", "git clean", "git blame", "git cherry-pick",
  "npm run", "npm exec", "npx", "pnpm run", "pnpm dlx", "yarn run", "bun run", "bunx",
  "docker build", "docker compose", "kubectl port-forward", "kubectl rollout",
]);
const GREEDY_STOP = new Set("the a an to of and or in on for with from by is are was be it this that then now after before when while but so if as at we you they i he she".split(" "));
/** 参数样式判定：flag(-x/--xx) / 路径(含 / . ~ =) / 纯数字 / 已知参数词 / 词库命令名（nohup pnpm dev）→ 可截；否则停（叙述词） */
function isArgToken(tok: string): boolean {
  if (!tok) return false;
  if (tok.startsWith("-")) return true;                        // flag
  if (/[\/\\~=]/.test(tok) || /\.\w+$/.test(tok)) return true;  // 路径/键值/带扩展名
  if (/^\d+$/.test(tok)) return true;                          // 数字（端口/数量）
  if (PARAM_WORDS.has(tok.toLowerCase())) return true;
  return DICT_NAMES.has(tok);                                  // 命令名作参数（nohup pnpm dev / docker run node）
}

// ---------------- 命令链贪婪捕获（&& || | ; & 后继续吞，组成完整命令） ----------------
// 不包含 > < 重定向（重定向后是文件不是命令，吞入会误把文件名当命令）。
const CHAIN_CONNECTOR = /^\s*(?:&&|\|\||[|;&])\s*/;
const ARG_TOKEN = "[\\w./~{}-]+";
const argRe = new RegExp("^\\s+(" + ARG_TOKEN + ")(?=\\s|$|[，。；！？,;!?])");
const QUOTED_ARG = /^\s*(?:"([^"]*)"|'([^']*)')/;

/**
 * 贪婪命令链捕获：从命中词开始向后吞参数（flag/路径/数字/已知参数词/词库命令/引号串），
 * 遇连接符（&& || | ; &）且下一词形似命令时继续吞下一段（≤4 段 ≤8 参/段 ≤300 字符）。
 * 返回整条命令链字符串（与原文子串基本对齐，hover 高亮可用）。
 */
function captureChain(t: string, idx: number, cmd: string): string {
  const parts = [cmd];
  let rest = t.slice(idx + cmd.length);
  let greedy = GREEDY_TAILS.has(cmd);
  for (let seg = 0; seg < 4; seg++) {
    let n = 0;
    while (n < 8) {
      const qm = rest.match(QUOTED_ARG);
      if (qm) { parts.push(qm[0].trim()); rest = rest.slice(qm[0].length); n++; continue; } // 引号原样保留（hover 高亮与原文对齐）
      const am = rest.match(argRe);
      if (!am) break;
      if (greedy && !GREEDY_STOP.has(am[1].toLowerCase())) {
        parts.push(am[1]); rest = rest.slice(am[0].length); n++; continue;
      }
      if (!isArgToken(am[1])) break;
      parts.push(am[1]); rest = rest.slice(am[0].length); n++;
    }
    // 连接符后接命令词才继续；词必须是词库命中 / 相对脚本（./x）/ 含路径层级，非功能词
    const cm = rest.match(CHAIN_CONNECTOR);
    if (!cm) break;
    const nextRest = rest.slice(cm[0].length);
    const nm = nextRest.match(/^([\w./~-]+)/);
    if (!nm) break;
    const nextWord = nm[1];
    if (GREEDY_STOP.has(nextWord.toLowerCase())) break;
    const nextFirst = nextWord.replace(/^\.\//, "").split("/")[0] || nextWord;
    const plausible = DICT_NAMES.has(nextFirst) || nextWord.startsWith("./") || (nextWord.includes("/") && nextWord.split("/").length <= 3);
    if (!plausible) break;
    parts.push(cm[0].trim()); // 保留连接符（&&/|/;…），链文本与原文对齐（hover 高亮可精确匹配）
    parts.push(nextWord);
    rest = nextRest.slice(nextWord.length);
    // 连接符后已是命令语境（词已通过命令词校验）：后续段贪婪吞裸操作对象（如 systemctl restart pi-web 的 pi-web）
    greedy = true;
  }
  let full = parts.join(" ");
  if (full.length > 300) full = full.slice(0, 300).replace(/(?:&&|\|\||[|;&])\s*$/, "");
  return full;
}

/** 命令链各段首命令词（去重，保留顺序）；"cd x && npm i" → ["cd","npm"] */
export function chainCommandWords(cmd: string): string[] {
  const segs = String(cmd || "").split(/\s*(?:&&|\|\||[|;&])\s*/).filter(Boolean);
  const out: string[] = [];
  for (const s of segs) {
    const f = firstToken(s);
    if (f && !out.includes(f)) out.push(f);
  }
  return out;
}

/** 命令链整体存在性：全部段命令存在 → true；任一缺失 → false；有未知 → undefined */
async function chainExistence(cmd: string, cwd?: string): Promise<{ words: string[]; exists: boolean | undefined }> {
  const words = chainCommandWords(cmd);
  if (!words.length) return { words, exists: undefined };
  const results = await verifyCommands(words, cwd);
  const vals = words.map((w) => results.get(w));
  let exists: boolean | undefined;
  if (vals.every((v) => v === true)) exists = true;
  else if (vals.some((v) => v === false)) exists = false;
  return { words, exists };
}

/** cd 前缀拆分："cd /a && npm i" → { workdir:"/a", action:"npm i" }；纯 "cd /a" 无后续动作不提取 */
export function splitCdPrefix(cmd: string): { workdir?: string; action?: string } {
  const t = String(cmd || "").trim();
  const m = t.match(/^cd\s+(?:"([^"]*)"|'([^']*)'|([^\s;&|]+))(?:\s*(?:&&|\|\||[|;&])\s*)?(.*)$/);
  if (!m) return {};
  const workdir = (m[1] ?? m[2] ?? m[3] ?? "").trim();
  const action = m[4]?.trim();
  if (!action || !workdir || workdir === ".") return {};
  return { workdir, action };
}

/**
 * workdir 解析为绝对路径：~ → HOME；绝对路径原样；相对路径结合会话上下文 cwd 解析。
 * cwd 缺省（无上下文，如行内 code 场景）→ 保持相对路径原样，不臆造基准。
 */
export function resolveWorkdir(workdir: string | undefined, cwd?: string): string | undefined {
  if (!workdir) return undefined;
  const w = String(workdir).trim();
  if (!w) return undefined;
  const home = os.homedir();
  if (w === "~") return home;
  if (w.startsWith("~/")) return path.join(home, w.slice(2));
  if (path.isAbsolute(w)) return w;
  if (cwd) return path.resolve(cwd, w);
  return w;
}

export async function checkCommand(cmd: string, cwd?: string): Promise<RecognizedCommand> {
  const t = String(cmd || "").trim();
  const danger = DANGER_PATTERNS.filter(([re]) => re.test(t)).map(([, label]) => label);
  const params = extractParams(t);
  const { workdir: rawWd, action } = splitCdPrefix(t);
  // workdir 结合会话上下文 cwd 解析为绝对路径（cd xxx 的 xxx 相对当前会话目录）
  const workdir = resolveWorkdir(rawWd, cwd);
  let exists: boolean | undefined;
  let installSuggestion: string | undefined;
  const { words, exists: chainExists } = await chainExistence(t, cwd);
  exists = chainExists;
  // 安装建议：第一个缺失命令词（cd 等 builtin 恒存在会自然跳过）
  if (chainExists === false && words.length) {
    for (const w of words) {
      const ok = await commandExists(w, cwd);
      if (ok === false) { installSuggestion = await suggestInstall(w); break; }
    }
  }
  const label = t.length > 60 ? t.slice(0, 60) + "…" : t;
  return { cmd: t, danger, exists, params, label, installSuggestion, workdir, action };
}

/**
 * 裸命令上下文判定：命中词在原文中是否处于"命令语境"（行首 / $ 提示符 / ;&| 命令链边界）。
 * 仅单命令名且未截到参数时使用——不在命令语境则视为普通词（如页面元素信息 "<button> ＋ file" 里的 file），排除。
 */
export function isCommandContext(text: string, idx: number): boolean {
  let i = idx - 1;
  // 只跳空格/tab/全角空格——换行是行首边界，不能跳过（否则"a\nb"里 b 的前置字符变成 a，误判非命令语境）
  while (i >= 0 && /[ \t\u3000]/.test(text[i])) i--;
  if (i < 0) return true;               // 文本开头
  const c = text[i];
  if (c === "\n") return true;         // 行首
  if (c === "$") {                     // $ 提示符（"$ file"）；排除变量引用（"echo $file" 中 $ 前有非空白）
    let j = i - 1;
    while (j >= 0 && /[ \t\u3000]/.test(text[j])) j--;
    return j < 0 || text[j] === "\n";
  }
  return ";&|".includes(c);            // 命令链边界（; && || | &）
}

/**
 * 词库全文扫描：从段落文本提取所有命中命令（一次交替正则 matchAll → 批量校验）。
 */
export async function extractCommandsFromText(configDir: string, text: string, cwd?: string): Promise<RecognizedCommand[]> {
  const t = String(text || "").slice(0, 50000);
  const userDict = loadUserDict(configDir);

  // 一次 matchAll 扫描（内置主正则 + 用户词库正则，均为加载/变更时构建）
  const hits = new Map<string, number>(); // 词 -> 起始位置
  const collect = (re: RegExp) => {
    for (const m of t.matchAll(re)) {
      const word = m[2];
      const start = m.index + (m[1] ? m[1].length : 0);
      if (!hits.has(word)) hits.set(word, start);
      if (hits.size >= 12) break;
    }
  };
  collect(BUILTIN_MASTER_RE);
  const userRe = getUserRegex(userDict);
  if (userRe) collect(userRe);

  // 预批量校验：command-exists 填缓存（checkCommand 复用）
  const tokens = [...new Set(hits.keys().map((w) => firstToken(w) || "").filter(Boolean))];
  if (tokens.length) await verifyCommands(tokens, cwd);

  // 贪婪命令链捕获：命中词 → 吞参数（flag/路径/数字/已知参数词/引号串）→
  // 遇连接符（&& || | ; &）且下一词形似命令则继续吞下一段；
  // 普通英文叙述词（to/and/stage 等）与中文词同样自动停——英文文本不会把叙述词带进命令
  const results: RecognizedCommand[] = [];
  const seen = new Set<string>();
  for (const [cmd, idx] of hits) {
    const full = captureChain(t, idx, cmd);
    if (seen.has(full)) continue;
    seen.add(full);

    // 裸命令排除：单命令名命中且未截到任何参数/连接符，且不在命令语境（行首 / $ 提示符 / ;&| 命令链）
    // ——如页面元素信息 "<button> ＋ file" 里的 file 只是普通词，识别为命令无意义
    if (!full.includes(" ") && !isCommandContext(t, idx)) continue;

    const c = await checkCommand(full, cwd);
    // 未安装（command not found）不过滤——保留并带 ❌ 标记 + 安装建议
    results.push(c);
  }
  // 重叠去重：长命令优先（"nohup pnpm dev" 覆盖 "pnpm dev"）
  results.sort((a, b) => b.cmd.length - a.cmd.length);
  const kept: RecognizedCommand[] = [];
  for (const r of results) {
    const sub = kept.some((k) => k.cmd.includes(r.cmd) && k.cmd !== r.cmd);
    if (!sub) kept.push(r);
  }
  // 按原文出现顺序（去重后）
  kept.sort((a, b) => t.indexOf(a.cmd) - t.indexOf(b.cmd));
  return kept.slice(0, 8);
}
