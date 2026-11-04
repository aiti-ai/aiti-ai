# aiti-configs 加密存储 + 跨服务器分发 方案（V6 · 黑名单制 + 深审修正 + 安全缺陷修复 · 终稿）

> 状态：**边界已确认，已实施，V6 深审发现 3 处待修缺陷**
> 作者：aiti-ai · 日期：2026-08-31
> 范围：`aiti-configs` 扩展（core.cjs / index.ts / filter.mjs + 运行时 ai-configs.json ×2）

---

## 0. 核心哲学（黑名单制）

> **includes 用目录级通配（`**`）默认全量收根；凡未被 `excludes` 明确剔除的（可重建物 / 运行时 / 下载物）一律进仓。**
> **效果：用户新增任何扩展、任意配置自动受保护，绝不丢失。**（白名单会漏，黑名单不丢）

- **进仓**：源码 + 依赖声明(package.json/lock) + 配置 + 涉密加密
- **排除**：`node_modules`、db/sqlite、cache、wasm/pwarc、大二进制、下载物
- **通用**：不特判具体实验目录（黑名单根含一切，除 `*-dev` 通配）

---

## 0.5 深度审核发现（V4→V5 修正项）

前置实测表明，原 V4 有四处在黑名单制下**跑不通或会破坏目标**，均已并入本方案：

| # | 类型 | 问题 | 修正（V5） |
|---|---|---|---|
| 1 | 🔴 致命 | 通配匹配的**调用侧**把 `expandPath` 后的**绝对路径**传给了 `matchesAny`/`globToRe`，而后者假定输入为**相对路径**——`/home/pi/.pi/agent/auth.json` 这类绝对路径匹配失败。实测 `core.globToRe` 对相对路径（`agent/auth.json`、深层扩展路径、`**/auth.json`）全部正确。所以 `globToRe` 无需重写 | **调用侧规范化**（git 同款）：`syncToRepo` 对每个 walk 到的文件计算**相对源根**的路径（`path.relative(sourceRoot, file)`），用它做收录判断与 excludes 匹配；`globToRe`/`expandPath` 保持不动（前者本就正确，后者只负责 `~`/`{HOME}`→绝对路径供 fs 访问，不掺和匹配） |
| 2 | 🟠 逻辑 | `syncOne` 的 `sizeLimitKB=512` 会误杀大 `package-lock.json`/`yarn.lock`→ `npm install` 即用前提被破坏 | **依赖声明豁免（已确认：收）**：`package.json`/`package-lock.json`/`npm-shrinkwrap.json`/`yarn.lock`/`pnpm-lock.yaml` **无条件进仓、不受 sizeLimit 限制**；sizeLimit 只约束二进制/普通大文件 |
| 3 | 🟠 逻辑 | `restore` 第 510 行 `if (path.includes("*")) continue` — 黑名单根全是 `**` 通配 → 恢复时写回源全部跳过，「后悔药」失效 | **restore 通配反向映射**：为 `**` 根重建「仓内每个 dest 文件 → 对应源路径」映射（记录 file→src 索引），恢复逐文件写回 |
| 4 | 🟡 逻辑 | `encrypt.patterns: ["pi/agent/**"]` 会整目录加密（过度加密 + 破坏 `portablize` 明文 diff）；且 `scanSensitive` 判定在加密判定前，未先命中 pattern 的涉密文件会被 `sensitive:` 拦截 | **加密按文件粒度**：`encrypt.patterns` 改精确文件匹配（`pi/agent/auth.json` 等）；`isEncryptedPath` 命中即加密该文件，未命中正常明文 + `portablize`；`syncOne` 内先判 `willEnc`，命中则 `scanSensitive` 返回空 |

---

## 0.6 深度审核发现（V5→V6 · 实施后实测 3 处缺陷，待修）

V5 代码已按方案实施并实测，黑名单根全量收（`agent/**` 127 项、`web/**` 1103 项）、依赖声明豁免、加密按文件粒度、二进制拦截（`bin/fd`3.9MB、`bin/rg`5.2MB 被 `binary:big` 拦下）、`*-dev` 排除、db/sqlite/zip 全命中均 ✅。但发现 3 处真实缺陷：

| # | 级别 | 问题 | 修复（V6） |
|---|---|---|---|
| 1 | 🔴 安全 | `syncOne` 判定加密用 `isEncryptedPath \|\| isProtectedFile`；但 `ensureGitFilter` 只把 `encrypt.patterns` 写进 `.gitattributes`。→ **`protected` 命中但 `encrypt.patterns` 未列的项**（如 `agent/bridge-registry.json`、`agent/package-trust-audit.jsonl`、`web/.expose-preset.key`）会被 syncOne 当密文处理、写明文副本，但 .gitattributes 无 filter → **明文入库、密钥泄漏** | **`ensureGitFilter` 的 pats 合并 `protected`**：`.gitattributes` 覆盖全部将被加密项（`encrypt.patterns` + `protected` 并集），并显式保护 `.gitattributes` 自身不加密 |
| 2 | 🟠 重要 | 真实 `agent/npm/.gitignore` = `*`（只留 `.gitignore`）。黑名单根把 `npm/package.json`+lock 拷进仓副本，但**仓内该 .gitignore 让 git add 忽略 `npm/*`** → 依赖声明仍不入 HEAD（前测 `package-lock.json 在HEAD:false`）| **`gitCommit` 对 `isManifest` 目标 `git add -f` 强制**（无视仓内 `*` ignore）；或同步时将源 `npm/.gitignore` 改写为允许依赖声明 |
| 3 | 🟡 中等 | `selfcheck` 对黑名单根 `~/.pi/agent/**`（目录）直接 `fs.readFileSync` 读目录 → 报错，selfcheck 假坏 | **通配根不做 JSON 单文件校验**：黑名单根/`**` 通配项跳过 JSON 解析校验（只校验目标目录/源存在），仅对具体 `.json` 文件做 JSON 校验 |

### V6 验证要点（逐项对应）

1. **修复 #1（安全）**：`ensureGitFilter` 后 `.gitattributes` 含 `bridge-registry.json`、`package-trust-audit.jsonl`、`.expose-preset.key`；对象库 `git show HEAD:pi/agent/bridge-registry.json` 为 `ENC1:` 密文。
2. **修复 #2（依赖声明）**：`gitCommit` 后 `git ls-files` 含 `pi/agent/npm/package.json`+`package-lock.json`（不受 `.gitignore *` 影响）。
3. **修复 #3（selfcheck）**：`selfcheck` 对黑名单根不报 `JSON 解析失败`；只报真实的 json 解析错误。

---

## 1. 目标

1. 涉密文件（`auth.json` 等）从「硬排除」改为「**加密保护入仓**」。
2. 进仓 = 能在新机器 `npm install` 启用的完整环境（源码 + 依赖声明 + 设置）。
3. 跨服务器通用：路径 `{HOME}` 占位 + 内容级绝对路径转写（`/home/pi/...` ⇄ `{HOME}`）。
4. **黑名单制**：用户扩展/配置全量自动进仓，不丢。
5. 运行时/下载物不入仓。
6. 密钥独立于仓外（`.git/configs-key`），绝不随仓分发；涉密未开启加密则阻断。

---

## 2. 现状诊断

### 2.1 `hardExcludes` 把涉密文件全排除了
`core.cjs` 默认 `hardExcludes` 含 `**/auth.json, **/credentials*, **/*.key, **/*.pem, **/*token*`，`syncToRepo` 命中即 `skip`。
→ `~/.pi/agent/auth.json`（核心配置）被丢弃；`pi-session-manager/auth_tokens.json`、`service-tunnels/*` 鉴权配置全部进不了仓。不是加密，是被排除。

### 2.2 includes 是文件白名单，未覆盖核心目录 & 会漏新扩展
原 includes 仅 3 项（settings/models/aiti-ai-created）。白名单制下**用户新增的任何扩展都不在列表 → 丢失**。这是致命缺陷，黑名单制（全量根）解决。

### 2.3 路径写死 `~/.pi` + 内容含绝对路径，跨服务器失效
- `includes.path` 全是 `~/.pi/...`；
- `settings.json` 的 `packages` 写 `/home/pi/workspace/...` 绝对路径，换机器全错。

### 2.4 依赖声明被误排
`excludes` 误含 `npm/**`，把 `agent/npm/package.json`+`lock`（依赖声明根）排掉 → 新机器 `npm install` 无从装起。黑名单制下依赖声明天然保留（只要不排除非 node_modules 文件）。

---

## 3. 设计（7 块）

### 块 A：路径 & 内容层 `{HOME}` 转写 + 相对路径匹配（修正 #1）
- **相对路径匹配（修正 #1，git 同款）**：`syncToRepo` 对每个 walk 到的文件计算**相对源根**路径（`path.relative(sourceRoot, file)`），用它做收录判断与 excludes 匹配。`globToRe`/`expandPath` 保持不动（前者本就正确的相对 glob；后者只把 `~`/`{HOME}` 展开成绝对路径供 fs 访问）。
- 支持 `{HOME}` / `${HOME}` 展开。
- 新增 `portablize(text)`（`os.homedir()`→`{HOME}`）、`localize(text)`（`{HOME}`→`os.homedir()`），导出。
- `syncOne` 读源后 `portablize` 再写仓副本；`restore` 写回源前 `localize`。
- 仅对**严格 JSON 文本**启用。

### 块 B：includes（黑名单式，目录级通配全量收）
```
~/.pi/agent/**                    → pi/agent/
~/.pi/pi-session-manager/**     → pi/pi-session-manager/
~/.pi/service-tunnels/**        → pi/service-tunnels/
~/.pi/mcp-profiles/**           → pi/mcp-profiles/
~/.pi/aiti-bridge/**            → pi/aiti-bridge/
~/.pi/web/**                    → web/          # web 主目录全量（运行时靠 excludes 剔除）
```
- **依赖声明统一豁免 sizeLimit（修正 #2）**：`package.json`/`package-lock.json`/`npm-shrinkwrap.json`/`yarn.lock`/`pnpm-lock.yaml` 永远进仓（无论大小），保证 `npm install` 即用。
- 含 `.pi/agent/npm/package.json`+`lock`（依赖声明自动进仓，不受 `node_modules/**` 排除影响——它们不是 node_modules）。
- 含 `web/extensions/**` 全部扩展源码（新扩展自动受保护）。
- 涉密文件（auth.json 等）由 `protected` + 加密保护，不排除。

### 块 C：加密强化 —— 涉密「要么加密、要么阻断」（按文件粒度，修正 #4）
- 新增 `protected`：`["**/auth.json","**/credentials*","**/*.key","**/*.pem","**/*token*","**/.configs-key","**/*.p12","**/*.jks","**/*.asc"]`
- **加密按文件判定**：`encrypt.patterns` 默认精确文件列表（如 `pi/agent/auth.json`、`pi/agent/models.json`、`pi/agent/models-store.json`、`pi/pi-session-manager/auth_tokens.json`、`pi/service-tunnels/*.json`），**避免 `pi/agent/**` 整目录加密**。
- `syncOne` 判定顺序：先判 `willEnc = isProtected(src) || matchesAny(destRel, encrypt.patterns)`；
  - `isProtected && !encrypt.enabled` → `skip "protected:encrypt-off"`（不静默明文入库）；
  - `willEnc` → `scanSensitive` 直接返回空（不拦截，最终密文入对象库）；
  - 未命中 → 正常明文 + `portablize`。
- **是否加密与是否扫描敏感解耦**：加密文件不做 sensitive 扫描；非加密文件命中则拦。

### 块 D：密钥管理
- 密钥默认 `{repo}/.git/configs-key`（git 层天然不跟踪），AES-256-GCM + 确定性 IV（`filter.mjs`/`encryptText` 已实现，`ENC1:<iv>:<tag>:<ct>`）。
- **绝不随仓分发**；跨服务器需目标机 `configs_key generate` 或安全通道拷贝；公开仓 push 安全；密钥丢失无法恢复。

### 块 E：db/sqlite 全家 + 运行时数据（excludes 唯一依据）
```gitignore
# 依赖/构建（npm install 可重建；package.json/lock 无条件保留，豁免 sizeLimit）
**/node_modules/  **/dist/  **/build/  **/.next/  **/.cache/  **/.vite/  **/.turbo/
**/__pycache__/  *.tsbuildinfo  **/.gradle/  **/target/
# db/sqlite 全家（运行时）—— 用 ** 前缀保证任意层级命中（* 不跨 /）
**/*.db  **/*.db-wal  **/*.db-shm  **/*.sqlite  **/*.sqlite3  **/*-wal  **/*-shm
# 下载/二进制大文件（运行时自动下载）
**/*.zip  **/*.tar  **/*.gz  **/*.tgz  **/*.7z  **/*.rar  **/*.wasm  **/*.pwarc  **/monaco/
**/bin/cc-connect  **/*.pack  **/.git/  **/.aiti-trace/
# 运行时数据/日志/缓存/会话
**/sessions/**  **/*.jsonl  **/logs/**  **/tmp/**  **/*.log
**/tool-output-artifacts/**  **/missions/index/**  **/model-usage/**  **/*.bak*
**/mcp-cache.json  **/*-cache.json  **/run-history.jsonl
# 开发副本（*.pi/*-dev）
**/*-dev/**
```

### 块 F：二进制大文件「commit 前预扫描 + 自动写 .gitignore」（兜底防误收）
1. `syncOne` 读内容后 NUL 检测；**二进制** && 大小 > 阈值（`512KB→2048KB`）→ `skipped "binary:big"`。**依赖声明与纯文本源码不受此限**（文本再大也进，防误杀）。
2. 新增 `scanStaged`：`gitCommit`/`snapshot` 前 `git ls-files` 检测二进制/超大/异常文件名，输出审计清单（并入 status/selfcheck）。新增 MCP 工具 `configs_scan`。
3. 命中「大二进制/超预算」→ 自动追加写 `repo/.gitignore`（`# aiti-configs auto-block` 注释块，幂等）→ 再 `add -A`。
4. 默认排除清单吸收 git-trace `BUILTIN_EXCLUDES_V1`（Node/Python/JVM/日志/IDE 分类注释）。

### 块 G：`*.pi/*-dev` 排除（黑名单制通用）
```gitignore
**/*-dev/**
```
> `web-crash-exp`/`web-wt-defork` 不特判——黑名单根含 `web/**`，但它们不含 `*-dev`，会被收进仓（很小，几十 KB，可接受）；如需不计，可加精确排除或依赖白名单兜底。

---

## 4. `.git` 体积预估（V4 黑名单）

- 加密项：~450 KB（base64 密文，压不动）
- 明文源码+声明（黑名单全收，剔除运行时后）：`web`(≤12MB) + `agent`(1MB) + session-manager/service-tunnels/mcp-profiles + 依赖声明 ≈ **13–16 MB 明文 → git 压缩 ~4–6 MB**
- **首 commit `.git` ≈ 5–6 MB**

> 若把 `web/**` 全量收，`web/data` 大 sqlite 由 excludes 剔除，源码部分可控。

**长期**：加密文件改动 = 全新 blob（无 delta 去重），需 `git gc`（auto）+ 定期 `configs_gc`（借鉴 git-trace：`--prune=now`+`reflog expire`）。

---

## 5. 改动清单（实施顺序 · 含审修项）

| # | 文件 | 改动（含修正 #1-#4） |
|---|---|---|
| 1 | `core.cjs` | **调用侧相对路径规范化（#1，不重写 globToRe）**；`expandPath` 支持 `{HOME}`；**依赖声明豁免 sizeLimit（#2，收）**；`protected` 双层防护 + **加密按文件粒度（#4）**；`portablize`/`localize`；`syncOne` 二进制检测；`scanStaged`；**restore 通配反向映射（#3）**；`gitCommit` 接预扫描+自动 .gitignore；sizeLimit 512→2048；**bug1: ensureGitFilter 合并 protected；bug2: gitCommit 对 manifest git add -f；bug3: selfcheck 通配根跳过 JSON 校验**；导出 |
| 2 | `index.ts` | 默认模板：黑名单根 includes（块 B）、`protected` + `encrypt.patterns` 文件粒度（块 C）、excludes（块 E/G/F，含 `**/*.db` 系列）、`configs_scan` 工具 |
| 3 | 运行时 `ai-configs.json` ×2 | 按新模板更新，`encrypt.enabled:true` |
| 4 | 验证 | `configs_key generate` → `configs_snapshot` → 核对：黑名单根全量匹配（#1）/ 依赖声明保留（#2）/ restore 写回源工作（#3）/ 仅涉密文件加密且明文 diff 可读（#4）/ 转写 / 拦截 / 新扩展自动收 |
| 5 | 总结 | 改动清单 / 验证结果 / 遗留事项 |

---

## 5.5 验证要点（逐项对应修正）

1. **通配根匹配（#1）**：`node -e` 断言 `globToRe("~/.pi/agent/**")` 匹配 `auth.json`、深层扩展路径；`web/**` 同理。
2. **依赖声明豁免（#2）**：构造 >512KB 的伪 `package-lock.json`，断言仍进仓。
3. **restore 写回源（#3）**：快照 → 改源 → 恢复 → 断言源文件还原。
4. **加密粒度（#4）**：断言 `pi/agent/auth.json` 密文、`pi/agent/extensions/**` 明文；`git diff` 对加密文件走 textconv 可读明文。
5. **黑名单自动收新扩展**：临时在 `web/extensions/` 放一个新目录，断言快照收进。
6. **跨服务器转写**：断言仓内 `settings.json` 无 `/home/pi`（已被 `{HOME}` 替换）；`localize` 还原正确。

---

## 6. 已确认边界

1. 涉密文件 = 加密 or 阻断；`encrypt.enabled=true`
2. `{HOME}` 转写仅对严格 JSON 文本
3. 二进制阈值 2048KB + 自动写 repo/.gitignore
4. db/sqlite/zip/运行时数据排除（cache 不要）
5. **黑名单制：`**` 目录通配全量收，用户扩展不丢**
6. `*.pi/*-dev` 排除
7. cache 目录整体不入仓（service-tunnels-cache 含 npm 依赖 → 排除）
8. 唯一排除依据 = excludes（可重建/运行时/下载物）

---

## 7. 参考

- 既有设计：`docs/aiti-configs-extension-plan.md`
- 经验来源：`/home/pi/workspace/aiti-ai/pi-web-ext/aiti-git-trace`
  - `trace-core.ts`：`BUILTIN_EXCLUDES_V1`、`countFilesWithBudget`、`looseDecision`
  - `index.ts`：`trace.maxFileKB=2048`、`trace.autoInitMaxFiles=2000`
