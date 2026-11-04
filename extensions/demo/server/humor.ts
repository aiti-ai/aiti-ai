/**
 * demo · 幽默彩蛋语料源
 *
 * 数据流（服务端拉取 → 本地缓存 → 随机派发）：
 *   1. 拉取：hitokoto（一言）免费公开接口（无需 key，c=j 幽默分类），
 *      批量取 = 并行 N 个单条请求（官方批量 num 参数不生效，实测只回 1 条）。
 *   2. 缓存：cacheDir/humor.json（cacheDir = ctx.cacheDir，可删重建） —— { items: [...], fetchedAt }。追加去重、上限裁剪。
 *   3. 派发：pickRandom() 服务端同步随机（注入 scriptFor 与 /humor/random API 共用）。
 *
 * 频率控制（HUMOR_FETCH_INTERVAL_MS）：距上次成功拉取不足间隔 → 不拉（缓存兜底）；
 * 每次拉 HUMOR_FETCH_BATCH 条；失败静默（不影响注入，兜底清单保证有货）。
 * 内嵌兜底清单：离线/首次/API 不可达时仍有幽默话可发。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const HITOKOTO_URL = "https://v1.hitokoto.cn/?encode=json&c=j"; // c=j 幽默分类
const FETCH_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6h 节流
const FETCH_BATCH = 5; // 每批 5 条（并行）
const MAX_CACHE = 120; // 缓存上限
const CACHE_FILE = "humor.json";

/** 内置兜底（约 20 条，伪随机也够用；API 不可达/首次启动时顶住）。 */
const FALLBACK = [
  "程序员的浪漫：我向你提交了一个 pull request，请合并我的心。",
  "Debugging 就是被自己刚写的代码开除又请回来。",
  "为什么程序员分不清万圣节和圣诞节？因为 Oct 31 == Dec 25。",
  "我写代码的速度取决于老板站在身后多久了。",
  "『能用就行』是通往生产环境最短的路。",
  "人生苦短，我用 Python；人生更短，用 JS 写正则。",
  "这台电脑运行飞快——除了跑我的代码时。",
  "我把 bug 藏在了变量名里，连我都找不到了。",
  "QA 说没问题，然后生产环境着火了。",
  "0.1 + 0.2 不等于 0.3，这就是为什么程序员不买菜。",
  "需求说『加个按钮』，结果加了 14 个配置项。",
  "我最擅长的快捷键是 Ctrl+Z，人生也是。",
  "通宵写的代码，第二天连注释都认不出我。",
  "『五分钟就好』是程序员对时间最大的误解。",
  "我的代码能跑，别问为什么，它自己也不知道。",
  "前端改 bug 三小时，后端改配置一分钟——然后前端被重写。",
  "每次部署成功，生产环境都会默哀三秒，然后开始抖。",
  "需求文档说得很清楚，但没说人话。",
  "一行注释的保质期是三个月，之后它就是都市传说。",
  "我写的不是代码，是给未来同事的恐怖故事。",
];

export function loadHumor(cacheDir) {
  try {
    const raw = readFileSync(join(cacheDir, CACHE_FILE), "utf8");
    const d = JSON.parse(raw);
    if (Array.isArray(d.items) && d.items.length) {
      return { items: d.items, fetchedAt: d.fetchedAt ?? null };
    }
  } catch { /* 无缓存/损坏 → 兜底 */ }
  return { items: [], fetchedAt: null };
}

function saveHumor(cacheDir, items, fetchedAt) {
  try {
    writeFileSync(
      join(cacheDir, CACHE_FILE),
      JSON.stringify({ items, fetchedAt }, null, 2),
    );
  } catch { /* 非致命 */ }
}

/** 拉取一批新语料（并行 N 条 hitokoto 单条请求），返回追加去重后的条目。 */
export async function fetchHumorBatch(cacheDir) {
  const cur = loadHumor(cacheDir);
  const existing = new Set(cur.items.map((i) => i.text));
  const urls = Array.from({ length: FETCH_BATCH }, () => `${HITOKOTO_URL}&_=${Date.now()}-${Math.random()}`);
  const results = await Promise.allSettled(
    urls.map((u) => fetch(u, { signal: AbortSignal.timeout(8000) }).then((r) => r.json())),
  );
  let added = 0;
  for (const r of results) {
    if (r.status !== "fulfilled") continue;
    const text = r.value?.hitokoto;
    if (typeof text === "string" && text.trim() && !existing.has(text)) {
      existing.add(text);
      cur.items.push({ text: text.trim(), from: r.value.from ?? null, source: "hitokoto" });
      added++;
    }
  }
  // 上限裁剪：保留最新（数组尾 = 最近拉的）
  if (cur.items.length > MAX_CACHE) cur.items = cur.items.slice(-MAX_CACHE);
  const fetchedAt = added > 0 ? Date.now() : cur.fetchedAt;
  if (added > 0) saveHumor(cacheDir, cur.items, fetchedAt);
  return { added, total: cur.items.length };
}

/** 节流拉取：距上次成功不足间隔 → 跳过（返回 {fetched:false}）。 */
export async function maybeFetchHumor(cacheDir, force = false) {
  const cur = loadHumor(cacheDir);
  const now = Date.now();
  if (!force && cur.fetchedAt && now - cur.fetchedAt < FETCH_INTERVAL_MS) {
    return { fetched: false, reason: "throttled" };
  }
  try {
    const r = await fetchHumorBatch(cacheDir);
    return { fetched: true, ...r };
  } catch {
    return { fetched: false, reason: "fetch-failed" };
  }
}

/** 随机取一条（缓存优先，空则兜底清单）。 */
export function pickRandomHumor(cacheDir) {
  const cur = loadHumor(cacheDir);
  const pool = cur.items.length ? cur.items : FALLBACK.map((text) => ({ text, source: "builtin" }));
  const pick = pool[Math.floor(Math.random() * pool.length)];
  return {
    text: pick.text,
    from: pick.from ?? null,
    source: pick.source ?? "builtin",
    total: pool.length,
  };
}

/** 全部缓存（管理用） */
export function listHumor(cacheDir) {
  return loadHumor(cacheDir);
}
