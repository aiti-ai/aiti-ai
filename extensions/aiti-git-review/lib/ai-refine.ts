/**
 * ai-refine · 提交分组 AI 精修的纯函数面（git-ops 融合方案 M4 遗留项落地）。
 *
 * 通道：folder 请求 → 本扩展 spawn 一个 prompt 会话（agent/new，与预审同款）→
 * `server.agent.onAgentSettled` 事件送达最终回答 → 解析 JSON 契约回填计划。
 * 等待为**事件驱动**（settle 事件 resolve + 单个超时 deadline），非轮询——红线合规。
 */

export interface RefineInput {
  cwd: string;
  groups: { key: string; message: string; files: string[] }[];
  excluded: string[];
}

export interface RefineResult {
  groups: { key: string; message: string; files: string[]; note?: string }[];
  excluded: string[];
  notes?: string;
}

export function buildRefinePrompt(input: RefineInput): string {
  const lines: string[] = [];
  lines.push("你是 git 提交分组助手。以下是当前仓库待提交文件的启发式分组（目录/类型规则生成）。");
  lines.push("仓库：" + input.cwd);
  lines.push("当前分组 JSON：");
  lines.push(JSON.stringify({ groups: input.groups, excluded: input.excluded }));
  lines.push("请审核并修订分组，规则：");
  lines.push("1. 同主题/同模块文件聚为一组；组消息用 conventional commits（中文描述，如 feat(模块): 描述）");
  lines.push("2. 锁文件与生成物剔除到 excluded；无关变更单独成组或剔除");
  lines.push("3. 每组可附一句 note（⚠ 风险提示或 ✓ 通过说明，可为空串）");
  lines.push("只输出一个 JSON 对象，不要任何解释或代码围栏，格式：");
  lines.push('{"groups":[{"key":"保持原 key 或新 key","message":"...","files":["..."],"note":""}],"excluded":["..."],"notes":"一句话总结"}');
  return lines.join("\n");
}

/** 从 AI 回答中提取 JSON 契约（容忍 ```json 围栏、前后闲话、单引号尾逗号等常见污染） */
export function parseRefineJson(text: string): RefineResult | null {
  if (!text) return null;
  let raw = String(text).trim();
  // 去围栏
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) raw = fence[1].trim();
  // 取首个 { 到最后一个 }
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let body = raw.slice(start, end + 1);
  const tryParse = (s: string): any => {
    try { return JSON.parse(s); } catch { return null; }
  };
  let obj = tryParse(body);
  if (!obj) {
    // 宽松修复：尾逗号
    body = body.replace(/,(\s*[}\]])/g, "$1");
    obj = tryParse(body);
  }
  if (!obj || !Array.isArray(obj.groups)) return null;
  const groups = obj.groups
    .filter((g: any) => g && Array.isArray(g.files) && g.files.length > 0)
    .map((g: any, i: number) => ({
      key: String(g.key ?? `ai-${i}`),
      message: String(g.message ?? "").slice(0, 200),
      files: g.files.map((f: any) => String(f)).slice(0, 500),
      note: g.note ? String(g.note).slice(0, 300) : undefined,
    }));
  if (groups.length === 0) return null;
  return {
    groups,
    excluded: Array.isArray(obj.excluded) ? obj.excluded.map((f: any) => String(f)).slice(0, 500) : [],
    notes: obj.notes ? String(obj.notes).slice(0, 500) : undefined,
  };
}

/** 单次精修请求的额度上限（防呆）：组数/文件总量 */
export function sanitizeRefineInput(input: RefineInput): RefineInput {
  const groups = (input.groups ?? []).slice(0, 20).map((g) => ({
    key: String(g.key ?? "").slice(0, 80),
    message: String(g.message ?? "").slice(0, 200),
    files: (g.files ?? []).slice(0, 500).map(String),
  }));
  return { cwd: String(input.cwd || ""), groups, excluded: (input.excluded ?? []).slice(0, 500).map(String) };
}
