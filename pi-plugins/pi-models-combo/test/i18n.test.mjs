// i18n 多语测试：双语言典完整性 / 插值 / 功能锚点保留 / env 语言检测 / 回退
import { execFileSync } from "node:child_process";
import { t, getLang, setLang } from "../src/i18n.ts";
import { Tester } from "./util.mjs";

const { ok, finish } = Tester();

// ---------- 双语言典完整性 / 内容抽查 ----------
{
  // 默认语言现在是环境相关（无 PMC/LANG 声明时走 ICU：裸机 en，中文区域 zh-CN）——只锁二值
  const def = getLang();
  ok("默认语言 ∈ {zh-CN, en}（环境相关）", def === "zh-CN" || def === "en", `(${def})`);
  setLang("zh-CN");
  ok("中文文案", t("pool.deadline.log", { s: 300 }).includes("池级硬截止"));
  setLang("en");
  ok("切英文", getLang() === "en");
  ok("英文文案", t("pool.deadline.log", { s: 300 }).includes("pool deadline"));
  setLang("zh-CN");
}

// ---------- 功能锚点：quota exceeded 在所有语言下保留（pi-ai NON_RETRYABLE 依赖） ----------
{
  const zhMsg = t("sat.terminal.err", { what: "x", min: 3 });
  setLang("en");
  const enMsg = t("sat.terminal.err", { what: "x", min: 3 });
  setLang("zh-CN");
  ok("终态 400 锚点 zh 保留 [quota exceeded]", zhMsg.includes("[quota exceeded: all upstream members unavailable]"));
  ok("终态 400 锚点 en 保留 [quota exceeded]", enMsg.includes("[quota exceeded: all upstream members unavailable]"));
}

// ---------- 插值与回退 ----------
{
  ok("{x} 插值", t("rpm.wait", { k: "a/b", s: 12 }).includes("a/b") === false ? false : true);
  ok("未知 key → 返回 key 本身（开发期可见）", t("no.such.key") === "no.such.key");
}

// ---------- env 语言检测（子进程：locale 进程级一次性判定） ----------
{
  // 基准环境：抹掉系统 locale 干扰，逐案显式指定
  const base = { ...process.env, PMC_LANG: "", PMC_LOCALE: "", LC_ALL: "", LC_MESSAGES: "", LANG: "" };
  const probe = (env) => execFileSync(process.execPath, ["--experimental-strip-types", "-e",
    `const { t, getLang } = await import("${new URL("../src/i18n.ts", import.meta.url).pathname}");
     console.log(getLang() + "|" + t("cancelled"));`,
  ], { env: { ...base, ...env }, encoding: "utf8" }).trim();
  // 全链无声明 → 走 ICU 默认 locale（机器相关：裸 Linux/英文系统 → en-US；中文区域 → zh-CN），只锁二值
  const undeclared = probe({});
  ok("全链无声明 → ICU 兑底（en 或 zh-CN，机器相关）", undeclared === "en|Cancelled" || undeclared === "zh-CN|已取消", `(${undeclared})`);
  ok("PMC_LANG=en → en", probe({ PMC_LANG: "en" }) === "en|Cancelled");
  ok("PMC_LANG=en_US.UTF-8 → en（去 codeset）", probe({ PMC_LANG: "en_US.UTF-8" }).startsWith("en|"));
  ok("PMC_LANG=zh-TW → zh-CN（zh* 归并）", probe({ PMC_LANG: "zh-TW" }).startsWith("zh-CN|"));
  ok("PMC_LANG=fr → en（不受支持的真实语言 → 国际兑底）", probe({ PMC_LANG: "fr" }).startsWith("en|"));
  ok("LANG=zh_CN.UTF-8 → zh-CN（读系统 locale）", probe({ LANG: "zh_CN.UTF-8" }).startsWith("zh-CN|"));
  ok("LANG=en_GB.UTF-8 → en（读系统 locale）", probe({ LANG: "en_GB.UTF-8" }).startsWith("en|"));
  ok("LC_ALL=C + LANG=zh_CN.UTF-8 → zh-CN（C 跳过沿链）", probe({ LC_ALL: "C", LANG: "zh_CN.UTF-8" }).startsWith("zh-CN|"));
  // C/POSIX 独存 → 无声明 → 走 ICU 兜底（机器相关：en 或 zh-CN）
  const cOnly = probe({ LC_ALL: "C", LANG: "C" });
  ok("LC_ALL=C 独存 → ICU 兑底（en 或 zh-CN）", cOnly === "en|Cancelled" || cOnly === "zh-CN|已取消", `(${cOnly})`);
  ok("PMC_LANG 优先于 LANG（PMC_LANG=en + LANG=zh_CN → en）", probe({ PMC_LANG: "en", LANG: "zh_CN.UTF-8" }).startsWith("en|"));
  ok("LC_MESSAGES=de_DE → en（不受支持 → 兑底）", probe({ LC_MESSAGES: "de_DE@euro", LANG: "C" }).startsWith("en|"));
}

finish("i18n");
