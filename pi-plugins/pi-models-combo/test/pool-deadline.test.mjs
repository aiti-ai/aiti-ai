// 池级硬截止 + 超时降权测试
// 场景 1：免费池全拥堵（成员挨个 TTFB 超时）→ 池级硬截止到期 → 结构化 504（不再串行烧 N×TTFB）
// 场景 2：poolDeadlineMs:0 显式关闭 → 全成员错误冷却 → 走既有 502 api_error（不产 504）
// 场景 3：TTFB 超时 → 成员降权 ×1/2（status 可见）→ 冷却过后真实成功 → 降权解除权重恢复
import { randomBytes } from "node:crypto";
import { ProxyServer } from "../src/proxy.ts";
import { freeP, makeUpstream, Tester } from "./util.mjs";

const { ok, finish } = Tester();
const token = () => "sk-dummy-" + randomBytes(8).toString("hex");

/** 组合槽位（单成员/多成员共用；成员各自指向独立上游端口） */
function slot(pid, keyName, key, upPort, model, weight) {
  return {
    name: `${pid}/${keyName}`, key,
    upstream: `http://127.0.0.1:${upPort}`, model,
    vision: false, group: "fast", member: `${pid}/${model}`,
    ...(weight != null ? { weight } : {}),
  };
}

// ---------- 场景 1：池级硬截止 → 504（不再让客户端干等 N×TTFB） ----------
{
  const hang = await makeUpstream(() => { /* 永不响应：复刻免费上游拥堵 */ });
  const tk = token();
  const p = new ProxyServer({
    provider: "dl1", upstream: "http://combo.pmc.invalid/", api: "openai-completions",
    apiKeys: [slot("provA", "k", "sk-a", hang.address().port, "model-a"), slot("provB", "k", "sk-b", hang.address().port, "model-b")],
    port: await freeP(), authToken: tk,
    timeouts: { ttfbMs: 150, poolDeadlineMs: 700 },
  });
  await p.start();
  const t0 = Date.now();
  const r = await fetch(`http://127.0.0.1:${p.port}/chat/completions`, {
    method: "POST", body: JSON.stringify({ model: "fast", messages: [{ role: "user", content: "hi" }] }),
    headers: { authorization: "Bearer " + tk },
  });
  const dt = Date.now() - t0;
  const j = await r.json().catch(() => ({}));
  ok("成员挨个 TTFB 超时 → 池级截止到期 → 504", r.status === 504, `(status=${r.status})`);
  ok("504 为结构化 timeout 错误", j.error?.type === "timeout", `(type=${j.error?.type})`);
  ok("截止按时触发（<4s，而非串行烧 N×TTFB+重试）", dt < 4000, `(dt=${dt}ms)`);
  ok("status 暴露 poolDeadlineMs", p.status().poolDeadlineMs === 700);
  p.stop(); hang.close();
}

// ---------- 场景 2：poolDeadlineMs:0 显式关闭 → 保留既有全冷却 502 语义 ----------
{
  const hang = await makeUpstream(() => {});
  const tk = token();
  const p = new ProxyServer({
    provider: "dl2", upstream: "http://combo.pmc.invalid/", api: "openai-completions",
    apiKeys: [slot("provA", "k", "sk-a", hang.address().port, "model-a"), slot("provB", "k", "sk-b", hang.address().port, "model-b")],
    port: await freeP(), authToken: tk,
    timeouts: { ttfbMs: 100, poolDeadlineMs: 0 },
  });
  await p.start();
  const r = await fetch(`http://127.0.0.1:${p.port}/chat/completions`, {
    method: "POST", body: JSON.stringify({ model: "fast", messages: [{ role: "user", content: "hi" }] }),
    headers: { authorization: "Bearer " + tk },
  });
  const j = await r.json().catch(() => ({}));
  ok("截止关闭：全成员错误冷却 → 既有 502 api_error", r.status === 502 && j.error?.type === "api_error", `(status=${r.status})`);
  ok("未产 504（截止确实关闭）", r.status !== 504);
  p.stop(); hang.close();
}

// ---------- 场景 3：TTFB 超时 → 降权 ×1/2 → 真实成功后恢复 ----------
{
  let first = true;
  const up = await makeUpstream((req, res) => {
    if (first) { first = false; return; } // 首请求挂起 → TTFB 超时
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  const tk = token();
  const p = new ProxyServer({
    provider: "dl3", upstream: "http://combo.pmc.invalid/", api: "openai-completions",
    apiKeys: [slot("provA", "k", "sk-a", up.address().port, "model-a")],
    port: await freeP(), authToken: tk,
    timeouts: { ttfbMs: 150, poolDeadlineMs: 0 },
  });
  await p.start();
  const go = () => fetch(`http://127.0.0.1:${p.port}/chat/completions`, {
    method: "POST", body: JSON.stringify({ model: "fast", messages: [{ role: "user", content: "hi" }] }),
    headers: { authorization: "Bearer " + tk },
  });
  await go(); // 首请求：TTFB 超时 → 冷却 + 降权 → 无健康候选 → 502
  let st = p.status().entries[0];
  ok("TTFB 超时 → 成员被标记降权", st.timeoutPenalized === true, `(penalized=${st.timeoutPenalized})`);
  ok("有效权重减半（默认 10 → 5）", st.effectiveWeight === 5, `(effective=${st.effectiveWeight})`);
  await new Promise((res) => setTimeout(res, 8500)); // 等错误冷却（MIN_COOLDOWN 8s）到期
  const r2 = await go();
  ok("冷却到期后成功 → 200", r2.status === 200, `(status=${r2.status})`);
  st = p.status().entries[0];
  ok("真实成功 → 降权解除权重恢复", st.timeoutPenalized === undefined && st.effectiveWeight === 10, `(penalized=${st.timeoutPenalized}, effective=${st.effectiveWeight})`);
  p.stop(); up.close();
}

finish("pool-deadline");
