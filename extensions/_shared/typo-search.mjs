/**
 * 错字容忍搜索（typo-tolerant matching）。
 *
 * 场景：扩展搜索框输入 servcie / sevice 等错字也要命中 service-tunnels。
 * 设计：
 *   - OSA 距离（Damerau-Levenshtein 受限版）：相邻转置算 1 步——servcie→service=1、
 *     sevice→service=1（纯 Levenshtein 转置=2，短词阈值会漏）。
 *   - 阈值按 query 长度自适应（typo-tolerance 惯例）：≤3 字符不启用模糊（噪音大），
 *     4-7 允 1 错，8+ 允 2 错。
 *   - 只对无空格短 query 启用；候选文本切成 token（字母数字/中文段）逐个比距离，
 *     长度差剪枝 + 超长 token（中文长句整段）跳过。
 * 纯函数无依赖：client bundle（vite）与 node --test 直接跑同一份实现。
 */

/** OSA（optimal string alignment）编辑距离。 */
export function osaDistance(a, b) {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev2 = null;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        v = Math.min(v, prev2[j - 2] + 1);
      }
      cur[j] = v;
    }
    prev2 = prev;
    prev = cur;
  }
  return prev[n];
}

/** query 允许的错字数（按长度自适应；≤3 返回 0 = 不启用模糊）。 */
export function typoThreshold(q) {
  const len = [...String(q)].length;
  if (len <= 3) return 0;
  if (len <= 7) return 1;
  return 2;
}

const TOKEN_SPLIT = /[^a-z0-9\u4e00-\u9fa5]+/;
const MAX_TOKEN_LEN = 24; // 超长 token（无分隔的中文长句等）不做模糊：DP 开销与误命中噪音都不划算

function* candidateTokens(text) {
  for (const tok of String(text || "").toLowerCase().split(TOKEN_SPLIT)) {
    if (tok && tok.length <= MAX_TOKEN_LEN) yield tok;
  }
}

/**
 * 错字容忍命中判断：query 为无空格短词时，对候选文本的 token 逐个比 OSA 距离。
 * 除常规 token 外还检查「去分隔符形态」（service-tunnels → servicetunnels），
 * 让漏连字符/错连字符的 query 也能命中。不满足启用条件（多词/超短）一律返回
 * false，调用方回退精确 includes 行为（本函数不含 includes 语义）。
 */
export function typoMatch(q, text) {
  const query = String(q || "").trim().toLowerCase();
  if (!query || /\s/.test(query)) return false;
  const threshold = typoThreshold(query);
  if (threshold <= 0) return false;
  const raw = String(text || "");
  for (const src of [raw, raw.replace(/[-_/]/g, "")]) {
    for (const tok of candidateTokens(src)) {
      if (Math.abs(tok.length - query.length) > 2) continue; // 长度差剪枝（上限 2：为双错漏字放宽保留）
      const d = osaDistance(query, tok);
      if (d <= threshold) return true;
      // 漏字场景放宽到 2 错（sevic→service 删 r+删尾 e=2、tunel→tunnels=2），
      // 但要求首字符一致（错字通常不在首位，锚定防误报：zzvic 不命中 service）
      if (d <= 2 && query[0] === tok[0]) return true;
    }
  }
  return false;
}
