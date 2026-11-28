// 测试共享工具：free port、假上游、断言计数器
import http from "node:http";
import net from "node:net";

/** 拿一个真实可用空闲端口（listen(0) → close → 复用） */
export const freeP = () =>
  new Promise((r) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => r(p)); });
  });

/** 假 LLM 上游：handler(req, res)，req body 已收集完成 */
export function makeUpstream(handler) {
  const s = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => { req.rawBody = Buffer.concat(chunks); handler(req, res); }); // rawBody 供断言读取请求体
  });
  return new Promise((r) => s.listen(0, "127.0.0.1", () => r(s)));
}

/** 断言计数器：ok(name, cond) 累计，finish(label) 输出并 exit(失败时 1) */
export function Tester() {
  let pass = 0, fail = 0;
  const ok = (name, cond, extra = "") => {
    if (cond) { pass++; console.log("  ✅ " + name + (extra ? "  " + extra : "")); }
    else { fail++; console.log("  ❌ " + name + (extra ? "  " + extra : "")); }
  };
  return {
    ok,
    finish(label) {
      console.log(`\n==== ${label}：${pass} 通过 / ${fail} 失败 ====`);
      // Node24 win32：fetch/AbortSignal 句柄在退出期 teardown 竞态触发 libuv 断言
      // （async.c:76，lessons §4）——置 exitCode 后等 keep-alive 排空自然退出，
      // 4s 兜底强杀（此时结果已打印、exitCode 已定，不影响判定）。
      process.exitCode = fail ? 1 : 0;
      const t = setTimeout(() => process.exit(process.exitCode || 0), 4000);
      if (t.unref) t.unref();
    },
  };
}
