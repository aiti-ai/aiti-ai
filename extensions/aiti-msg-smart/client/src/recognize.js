/**
 * aiti-msg-smart · 消息识别器（纯函数，无 DOM/网络依赖——可单测）。
 *
 * 输入是「渲染后段落纯文本」（DOM textContent）：markdown 语法已被渲染器消费，
 * 文本原样使用，不做字符剥离（PI_WEB_BASE_DOMAIN 的下划线、代码内 `*` 等必须原样保留）。
 *
 * 行为对齐剥离前的 core QuoteReplyPopover（de8c80f^ 原版）：
 *   - question：每段 → 选项按钮（是/否/A/B/好，X）或引用回复兜底（摘要）；整段兜底引用
 *   - file：提取路径（相对路径由 client 拼 cwd），存在性校验后显示打开/定位按钮
 *   - summarizeSegment：引用兜底按钮的“头部…尾部”摘要（多段弹层可区分）
 */

// ── 通用：截断 ─────────────────────────────────────────────
function truncate(s, n) {
  return s.length > n ? s.slice(0, n).trimEnd() + "…" : s;
}

/** 按 / 分段编码并保留分隔符（/api/files 路由按段解析，整体 encodeURIComponent 会把 / 变 %2F）。 */
export function encodeFilePathForApi(filePath) {
  return String(filePath).split("/").filter(Boolean).map(encodeURIComponent).join("/");
}

/** 引用兜底按钮的摘要：全角≈1 单位、半角≈0.55，预算 budget（默认 32）单位；超长取 头N…尾N 逐步扩展。
 *  budget 可由调用方按视口宽度动态传入（宽屏多显示，窄屏保守）。 */
function unitWidth(s) {
  let w = 0;
  for (const ch of s) w += /[\u3000-\u9FFF\uFF00-\uFFEF\u2014\u2018\u2019\u201C\u201D\u2026]/u.test(ch) ? 1 : 0.55;
  return w;
}
export function summarizeSegment(text, budget = 32) {
  const t = text.trim();
  const BUDGET = Number.isFinite(budget) && budget >= 8 ? budget : 32;
  if (unitWidth(t) <= BUDGET) return t;
  let head = 3;
  let tail = 3;
  while (head + tail < t.length) {
    const wHead = unitWidth(t.slice(0, head + 1)) + 1 + unitWidth(t.slice(-tail));
    const wTail = unitWidth(t.slice(0, head)) + 1 + unitWidth(t.slice(-(tail + 1)));
    if (wHead <= BUDGET && wTail <= BUDGET) {
      if (unitWidth(t[head] ?? "") <= unitWidth(t[t.length - tail - 1] ?? "")) head++;
      else tail++;
    } else if (wHead <= BUDGET) head++;
    else if (wTail <= BUDGET) tail++;
    else break;
  }
  return `${t.slice(0, head)}…${t.slice(-tail)}`;
}

// ── url 识别（段落内 http/https 链接 → 新窗口打开）──┐
export function extractUrls(text) {
  // 排除集含全角括号/书名号/引号等 CJK 标点：消息尾注「[发自: xxx · http://host/path（aiti-*：…）]」
  // 的全角（此前不在排除集会被吞进 url → window.open 打开脏地址 404，“无法打开选中的 url”）
  const re = /https?:\/\/[^\s"'<>\[\]{}()（）【】《》「」『』]+/gu;
  const seen = new Set();
  const out = [];
  for (const m of text.matchAll(re)) {
    let url = m[0].replace(/[），。、；：!！?？)>"'`]+$/u, "");
    if (!seen.has(url)) { seen.add(url); out.push(url); }
  }
  return out;
}
// ──────────────────────────────────────────────────────────────

// ── question 识别（从剥离的 quote-reply 原样搬入）──┐
export function splitQuestions(text) {
  const t = text.trim();
  if (!t) return [];
  // Sentence-final ？/? always splits. ASCII ";" is a separator only inside CJK
  // text — English uses it mid-sentence ("Shall I update the docs; or wait?"), and
  // splitting there would strand the first half of the choice.
  const out = [];
  for (const chunk of t.split(/(?<=[？?])/u)) {
    const c = chunk.trim();
    if (!c) continue;
    const sep = /\p{Script=Han}/u.test(c) ? /[；;]/u : /；/u;
    for (const s of c.split(sep)) {
      const v = s.trim();
      if (v) out.push(v);
    }
  }
  return out;
}

// English lead-in frames stripped from an option ("Would you prefer tabs" → "tabs"),
// mirroring the Chinese prefixes below. Longest alternatives first; frames can stack
// ("Do you want to use A" → "use A" → "A"), hence the repeated passes in cleanOption.
const EN_OPTION_PREFIX =
  /^(?:(?:do|would|will|should)\s+(?:i|we|you)\s+(?:want|like|need|prefer)\s+me\s+to\s+|(?:do|would|will)\s+you\s+(?:want|like|need|prefer)\s+to\s+|(?:do|would|will)\s+you\s+(?:want|like|need|prefer)\s+|(?:should|shall|do|does|can|could|would|will|may)\s+(?:i|we)\s+|(?:can|could|would|will|should|do)\s+you\s+|(?:are|is)\s+(?:we|you|i)\s+(?:using|going\s+with)\s+|i(?:'d|'ll|\s+would|\s+will)?\s+(?:want|need|like|prefer)\s+to\s+|me\s+to\s+|please\s+|use\s+|using\s+|choose\s+|pick\s+|go\s+with\s+|either\s+)/iu;

function cleanOption(s) {
  let out = String(s);
  // Repeat so stacked frames peel off one per pass; stop as soon as nothing changes.
  for (let i = 0; i < 3; i++) {
    const before = out;
    out = out
      .replace(/^(我要|我想我?|你想要?|你想我?|你想要?|想要?|需要|你来|你来?|用|使用|选|选择|我|你)\s*/u, "")
      .replace(EN_OPTION_PREFIX, "");
    if (out === before) break;
  }
  return out
    .replace(/[吗吧呢]?$/u, "")
    .replace(/[？?，,。.!！、;；]$/gu, "")
    .trim();
}

/** 识别段内选项；无清晰选项返回 null（调用方退回纯引用回复）。 */
export function detectOptions(seg, labelMax = 12) {
  const t = seg.trim();
  if (!t) return null;
  const maxL = Number.isFinite(labelMax) && labelMax >= 4 ? labelMax : 12;

  // 1) 显式选择："A 还是 B" / "A 或者 B" / "A or B"（\bor\b 防 store/word 内拆）。
  //    最长备选在前（或者还是 > 还是/或者），否则 "A 或者还是 B" 的 b 会解析成 "还是 B"。
  const choice = t.match(/^(.+?)\s*(?:或者还是|还是|或者|\bor\b)\s*(.+?)[？?]?\s*$/iu);
  if (choice) {
    const a = cleanOption(choice[1]);
    const b = cleanOption(choice[2]);
    if (a && b && a !== b) {
      return [
        { label: truncate(a, maxL), value: a },
        { label: truncate(b, maxL), value: b },
      ];
    }
  }

  // 2) 是非问（中文信号 + 尾 ？）。开放问（怎么做/哪个/什么/…）不在此列 → 退回纯引用。
  //    English open-ended set adds when/whose/whom plus request verbs ("Can you explain …")
  //    so imperative/wh-questions do not degrade into Yes/No buttons.
  const openEnded = /怎么|如何|怎样|哪个|哪些|什么|为什么|为何|谁|多少|几(个|点|时)?|\b(?:what|how|why|who|whose|whom|when|where|which)\b|\b(?:explain|describe|list|summari[sz]e|outline|show\s+me|tell\s+me|help\s+me|walk\s+me\s+through)\b/iu.test(t);
  // English subject-auxiliary inversion ("Should I proceed", "Do you want me to add tests")
  // is a yes/no question even without a trailing "?" — streaming text often drops it.
  const enInversion = /^\s*(?:should|shall|can|could|may|would|will|do|does|did|is|are|was|were|have|has)\s+(?:i|we|you|he|she|it|they|this|that|these|those|there)\b/iu.test(t);
  // "Let me know if you'd like me to <action>" is an explicit offer — treat it as a
  // yes/no question (wins over openEnded: the wh-word sits in the offered action itself).
  const enOffer = t.match(/\blet\s+me\s+know\s+(?:if|whether)\s+you(?:'d|\s+would)?\s+(?:like|want|need)\s+me\s+to\s+(.+)$/iu);
  const yesNo = !!enOffer || (!openEnded && (/[？?]\s*$/u.test(t) || /(?:吗|吧|呢)[？?]?\s*$/u.test(t) || /是否|要不要|能不能|可不可以|要不要我|需要我/u.test(t) || enInversion));
  if (yesNo) {
    const hasHan = /\p{Script=Han}/u.test(t);
    if (hasHan) {
      // "要我X吗" → "好，X": a concrete action label beats a bare yes/no pair. cjk-ok
      const action = t
        .replace(/^(要我|需要我|要不要我?|是否|能不能|可不可以|要不要|或者|还是|你能|你可以|请|麻烦)\s*/u, "")
        .replace(/[吗吧呢啊呀]?[？?]+$/u, "")
        .replace(/[吗吧呢啊呀]$/u, "")
        .trim();
      if (action && action.length > 0) {
        // Action label is CJK-only (English questions take the branch below);
        // label is truncated for display, value is the full prefill.
        return [
          { label: `好，${truncate(action, maxL)}`, value: "是的" },
          { label: "不用", value: "不用了" },
        ];
      }
      return [
        { label: "是", value: "是的" },
        { label: "否", value: "不用了" },
      ];
    }
    // English: known action frame → "Yes, <action>" (the counterpart of the CJK
    // "好，X" label); generic inversions such as "Is it done?" keep plain Yes/No. cjk-ok
    const frame = t.match(/^\s*(?:(?:should|shall)\s+(?:i|we)\s+|(?:do|would|will)\s+you\s+(?:want|like|need|prefer)\s+me\s+to\s+|(?:do|would|will)\s+you\s+(?:want|like|need|prefer)\s+to\s+|(?:can|may|could)\s+i\s+)/iu);
    const rawAction = enOffer ? enOffer[1] : frame ? t.slice(frame[0].length) : "";
    const enAction = rawAction.replace(/[?？!.]+\s*$/u, "").trim();
    if (enAction) {
      return [
        { label: `Yes, ${truncate(enAction, maxL)}`, value: "Yes" },
        { label: "No", value: "No" },
      ];
    }
    return [
      { label: "Yes", value: "Yes" },
      { label: "No", value: "No" },
    ];
  }

  // 3) 非封闭问 → 无选项
  return null;
}

/** 引用回复格式：每行 "> " 前缀；可选预填 answer 行（无则空行）→ 用户引用下输入。 */
export function formatQuote(seg, value) {
  const quote = seg
    .split("\n")
    .map((l) => `> ${l}`)
    .join("\n");
  return value ? `${quote}\n${value}` : `${quote}\n`;
}

/** 段落级解析：逐段 → { text, options }（弹层每段一行按钮用）。
 *  opts.labelMax：选项按钮 label 截断预算（缺省 12；宽屏调用方可传更大值多显示文本）。 */
export function parseParagraph(text, opts = {}) {
  const labelMax = opts && typeof opts === "object" ? opts.labelMax : undefined;
  return splitQuestions(text).map((seg) => ({ text: seg, options: detectOptions(seg, labelMax) }));
}

// ── 跨仓分辨根（aiti-git-trace 协作）──┐
// 场景：AI 把文件写到会话 cwd 之外的 git 仓（如 ~/workspace/pi-web），消息里却只说
// 相对路径（docs/x.md）——主 cwd 拼接 404，弹层不出文件按钮。aiti-git-trace 追踪了
// 这些外部仓（会话识别仓 state/<sid>.stores + workspace 关注路径 config.paths），
// 把它们作为补充分辨基，逐根拼接重试存在性校验即可命中。

/**
 * 合并外部分辨根：会话识别仓（stores[].root，主仓+副仓）+ workspace 关注路径（paths[].path）。
 * 去重、剥尾斜杠、剔除与 cwd 相同者、保序（会话识别仓优先——与本条消息的写入行为最相关）。
 * 主仓根可能是 cwd 的父级 repo root——cwd 在仓内子目录时，仓相对路径也能借此命中。
 */
export function mergeExternalRoots(cwd, sessionStores, watchPaths) {
  const roots = [];
  const push = (p) => {
    if (typeof p !== "string" || !p) return;
    let r = p.replace(/[\/\\]+$/, ""); // 尾分隔符（/ 与 \，Windows 根路径可能以 \ 结尾）
    r = r.replace(/\\/g, "/"); // 反斜杠归一化为 /（去重/与 cwd 比较/拼接统一形式；Windows fs 两种都认）
    // MSYS 盘符根（git-bash 环境的 watchPaths/stores 可能报 /d/foo 形式）归一化为 D:/foo
    const msys = r.match(/^\/([A-Za-z])\/(.+)$/);
    if (msys) r = msys[1].toUpperCase() + ":/" + msys[2];
    if (!r || r === cwd || roots.includes(r)) return;
    roots.push(r);
  };
  for (const st of Array.isArray(sessionStores) ? sessionStores : []) push(st && st.root);
  for (const wp of Array.isArray(watchPaths) ? watchPaths : []) push(wp && wp.path);
  return roots;
}

/**
 * 相对路径 → 外部根候选绝对路径（保序）。绝对路径（/ 开头、Windows 盘符、~/ 开头）
 * 不走外部根分辨（自身已定位，主流程 absOf 已处理）→ 返回 []。
 */
export function candidatesFromRoots(relPath, roots) {
  if (!Array.isArray(roots) || !roots.length) return [];
  let rel = String(relPath || "");
  if (!rel || rel.startsWith("/") || rel.startsWith("~/") || /^[a-zA-Z]:[\\/]/.test(rel)) return [];
  if (rel.startsWith("./")) rel = rel.slice(2);
  if (!rel) return [];
  return roots.map((r) => r + "/" + rel);
}

/**
 * 「自带名字」路径候选（自引用消歧）：
 * When an AI session cwd is inside X but the message writes a path starting with X's own name
 * (for example cwd=~/workspace/demo-repo, message says demo-repo/docs/x.md): a self-reference from
 * the parent view, which matters once a session touches directories outside its cwd. For each base
 * 单独调用：rel 首段 === 基的末段名 → 候选 = 基的父目录 + rel。
 * e.g. base=/home/pi/workspace/demo-repo, rel=demo-repo/docs/x.md -> /home/pi/workspace/demo-repo/docs/x.md;
 *     base=/home/pi/workspace/pi-web, rel=pi-web/docs/x.md → /home/pi/workspace/pi-web/docs/x.md。
 * 绝对/~ /盘符路径不走自引用（candidatesFromRoots 同款过滤）；基无父目录（根/盘符根）返回 []。
 * 反斜杠分隔（Windows 消息/基）统一归一化为 /（与 mergeExternalRoots 同策略）。
 */
export function selfNameCandidates(relPath, base) {
  let rel = String(relPath || "").replace(/\\/g, "/");
  if (!rel || rel.startsWith("/") || rel.startsWith("~/") || /^[a-zA-Z]:[\\/]/.test(rel)) return [];
  if (rel.startsWith("./")) rel = rel.slice(2);
  if (!rel) return [];
  let b = String(base || "");
  if (!b) return [];
  b = b.replace(/[\\/]+$/, "").replace(/\\/g, "/");
  const isAbs = b.startsWith("/");
  const parts = b.split("/").filter(Boolean);
  if (parts.length < 2) return []; // 根/盘符根无父目录——没有可剥的「名字段」
  const name = parts[parts.length - 1];
  if (rel !== name && !rel.startsWith(name + "/")) return [];
  return [(isAbs ? "/" : "") + parts.slice(0, -1).join("/") + "/" + rel];
}
// ──────────────────────────────────────────────────────────────

// ── file/folder 提取（从剥离的 quote-reply 原样搬入）──┐
// 裸文件名（无路径前缀）只认这些后缀：源码/文档 + 常见图片/附件/媒体。
// 图片类（png/jpg/svg/…）此前缺失——消息里如「viewer-new-layout.png 是已跟踪文件」
// 这类 git 操作/截图叙述含裸图片名，不补会被漏识别。
//
// Windows 路径（2026-09-09）：Windows 开发机（如 155）上 AI 消息高频出现
// 「Successfully wrote to D:\workspace\…\SKILL.md」——反斜杠分隔此前完全匹配不上
// （只捞到裸文件名 SKILL.md，拼 cwd 探测必 404）；D:/ 正斜杠形式也因盘符「D:」
// 进不了段迭代而丢前缀。段迭代因此扩充：分隔符同时认 / 与 \，新增盘符段
// （[A-Za-z]:[\/]）与 UNC 双段锚（\\host\share\）；提取后统一归一化为 /
// （下游 absOf/encodeFilePathForApi/openFile 标签全按 / 处理，Windows fs 两种分隔都认）。
// 注意：反斜杠相对路径（a\b\c.md）也顺带被认（与 Unix 相对路径同权）；
// 同理存在 and/or 类噪声候选（如正则示例 \d\w），由存在性探测自然过滤。
// MSYS 挂载形式（git-bash 输出 /d/foo）同样识别：单字母盘锚 /d/，归一化为盘符 D:/foo；
// /usr/ 等多字母首段不命中锚（避免吞 Linux 真实根路径），行为与旧版一致（丢首斜杠作相对候选）。
// 文件/目录名段字符补充：CJK（中日韩统一表意文字 + 平假名 + 片假名 + 韩文音节）+ 全角字母数字。
// Windows 中文开发机高频出现「安装记录.md」「操作手册.pdf」之类中文文件名，此前 \w 只含 ASCII，
// 含中文文件名的路径会在最后一个 ASCII 段的分隔符处被截断（D:\vms\win11arm\安装记录.md 只剩
// D:/vms/win11arm）。注入到路径段/末段文件名字符类后可完整命中；末段扩展名后的 \w+ 仍只认
// ASCII（扩展名一般是 ASCII）。注意：全角范围只取字母数字（\uFF10-19/\uFF21-3A/\uFF41-5A），
// 不含全角标点——全角冒号「：」（\uFF1A）等标点不是文件名合法字符，纳入会被分支2 当目录吞掉
// 「：D:\vms\win11arm\」这类前缀，反而把中文文件名挤出末段。
const CJK = "\\u4e00-\\u9fff\\u3040-\\u309f\\u30a0-\\u30ff\\uac00-\\ud7af\\uff10-\\uff19\\uff21-\\uff3a\\uff41-\\uff5a";

const BARE_FILE_EXTS =
  "ts|tsx|js|jsx|mjs|cjs|md|mdx|json|py|go|rs|css|scss|html|sh|yml|yaml|toml|lock|txt|sql|env" +
  "|png|jpg|jpeg|gif|webp|svg|ico|bmp|avif" +
  "|pdf|zip|tar|gz|tgz|7z|rar" +
  "|woff2|woff|ttf|otf" +
  "|mp4|webm|mov|avi|mkv|mp3|wav|flac|ogg";

// 路径段迭代：~/ .\ / 盘符（D:/ D:\）/ MSYS 盘锚（/d/）/ Unix 绝对根（/home/ 多字母段）/ UNC 双段锚（\\host\share\）/ 普通段，分隔符 / 与 \\ 均可
// Unix 绝对根锚（2026-09-16）：此前 /home/pi/… 这类多字母首段绝对路径匹配从 home 开始、
// 丢前导 / → 被当相对路径拼 cwd 探测必 404（write 工具行 "file_path": "/home/…" 实证不识别）。
// 锚放在 MSYS 盘锚之后——单字母首段（/d/）仍先命中盘锚归一化为 D:/；放最后兜底，
// 前面有普通段时（and/or/x.md）左端先在 'a' 命中普通段，行为不变。
const PATH_SEG =
  "(?:~[\\\\/]|\\.[\\\\/]|[A-Za-z]:[\\\\/]|/[A-Za-z][\\\\/]|\\\\\\\\[\\w." + CJK + "-]+[\\\\/][\\w.@" + CJK + "-]+[\\\\/]|[\\w." + CJK + "-]+[\\\\/]|/[\\w." + CJK + "-]+[\\\\/])";

export function extractFilePaths(text) {
  // 1) dir/name.ext、./dir/name.ext、~/dir/name.ext、D:\dir\name.ext（文件带路径，末段必须带扩展名）
  // 2) 带常见源码/文档/图片等后缀的裸文件名（后缀见 BARE_FILE_EXTS）
  // 3) 目录：至少一段路径（~/ ./ 盘符 UNC 隐藏段如 .pi/ 普通段均支持），末段可有可无扩展名、尾分隔符可选
  //    ——无尾分隔符的路径无法仅从文本判断文件/目录，isDir 由调用方（probe）修正
  const re = new RegExp(
    "(?:" + PATH_SEG + "+[\\w.@" + CJK + "-]+\\.\\w+" +
    "|" + PATH_SEG + "{1,}[\\w.@" + CJK + "-]*[\\\\/]?" +
    "|(?<![A-Za-z0-9_." + CJK + "-])[A-Za-z0-9_." + CJK + "-]+\\.(?:" + BARE_FILE_EXTS + ")\\b)",
    "gu"
  );
  const seen = new Set();
  const out = [];
  for (const m of text.matchAll(re)) {
    let p = m[0].replace(/[），。、；：!！?？)>"'`]$/u, "");
    p = p.replace(/\\/g, "/"); // Windows 反斜杠逐个替换为 /（不可用 \\+ 折叠 run——UNC 前导 \\\\ 会丢成一个 /）（下游按 / 处理；Windows fs 两种都认）
    // MSYS 盘符路径（git-bash 挂载形式）归一化为盘符：/d/foo、//d/foo → D:/foo；转换错也仅探测 404 不显按钮
    p = p.replace(/^\/+([A-Za-z])\//, (_, L) => L.toUpperCase() + ":/");
    const isDir = p.endsWith("/");
    if (isDir) p = p.slice(0, -1);
    if (p.length >= 3 && !seen.has(p)) {
      seen.add(p);
      out.push({ path: p, isDir });
    }
  }
  return out;
}
