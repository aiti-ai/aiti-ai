// 热更新 / body 超时 深度审核测试
// 覆盖：
//  H1: updateEntries 槽位替换 → 新请求打到新槽位、被移除槽位不再命中、旧冷却/粘性指针清理
//  H2: 竞态——请求重试窗口内 updateEntries 减少槽位 → 旧 ctx.groupIdxs 越界不应崩溃（进程存活）
//  H3: body 接收超时（bodyTimeoutMs 可配）→ 客户端发不完整 body 卡住 → 408 并关闭连接
import http from "node:http";
import { randomBytes } from "node:crypto";
import { ProxyServer } from "../src/proxy.ts";
import { freeP, makeUpstream, Tester } from "./util.mjs";

const { ok, finish } = Tester();
const token = () => "sk-" + randomBytes(8).toString("hex");
function slot(pid, kn, key, port, model) {
  return { name: `${pid}/${kn}`, key, upstream: `http://127.0.0.1:${port}`, model, vision: false, group: "fast", member: `${pid}/${model}` };
}

// ---------- H1：updateEntries 槽位替换 ----------
{
  const hits = [];
  const upA = await makeUpstream((req, res) => { hits.push("A"); res.writeHead(200); res.end("{}"); });
  const upB = await makeUpstream((req, res) => { hits.push("B"); res.writeHead(200); res.end("{}"); });
  const upC = await makeUpstream((req, res) => { hits.push("C"); res.writeHead(200); res.end("{}"); });
  const upD = await makeUpstream((req, res) => { hits.push("D"); res.writeHead(200); res.end("{}"); });
  const tk = token();
  const c = new ProxyServer({
    provider: "hot1", upstream: "http://combo.pmc.invalid/", api: "openai-completions",
    authToken: tk, port: await freeP(), stickyKeys: false,
    apiKeys: [
      slot("provA", "a", "sk-a", upA.address().port, "ma"),
      slot("provB", "b", "sk-b", upB.address().port, "mb"),
      slot("provC", "c", "sk-c", upC.address().port, "mc"),
    ],
  });
  await c.start();
  const go = () => fetch(`http://127.0.0.1:${c.port}/c`, { method: "POST", body: JSON.stringify({ model: "fast", messages: [] }), headers: { authorization: "Bearer " + tk } });
  await go();
  ok("热更新前：命中旧槽位 A", hits.includes("A"), `(hits=${hits.join(",")})`);

  // 原地替换：3 槽 → 1 槽（换成完全不同的 D），端口不变
  const portBefore = c.port;
  const removed = c.updateEntries({ entries: [slot("provD", "d", "sk-d", upD.address().port, "md")] });
  ok("updateEntries 返回被移除槽位名", removed.join(",") === "provA/a,provB/b,provC/c", `(removed=${removed.join(",")})`);
  ok("updateEntries 端口不变（原地热更新）", c.port === portBefore, `(port=${c.port})`);

  hits.length = 0;
  await go();
  await go();
  ok("热更新后：只命中新槽位 D（旧 A/B/C 不再命中）", hits.length === 2 && hits.every((h) => h === "D"), `(hits=${hits.join(",")})`);
  c.stop(); upA.close(); upB.close(); upC.close(); upD.close();
}

// ---------- H2：竞态——请求重试窗口内 updateEntries 减槽 → 不崩溃 ----------
{
  let n = 0;
  let c;
  const upAll = await makeUpstream((req, res) => {
    n++;
    if (n === 1) {
      // 首次请求 429 → 触发代理 backoff 重试；重试前（50ms）热更新把槽位 3→1
      setTimeout(() => {
        try {
          c.updateEntries({ entries: [slot("provA", "a", "sk-a", upAll.address().port, "ma")] });
          console.log("  [H2] 热更新 3→1 完成（重试窗口内）");
        } catch (e) { console.log("  [H2] updateEntries 抛错:", e.message); }
      }, 50);
      res.writeHead(429, { "retry-after": "1" }); res.end("{}");
      return;
    }
    res.writeHead(200); res.end("{}");
  });
  const tk = token();
  c = new ProxyServer({
    provider: "hot2", upstream: "http://combo.pmc.invalid/", api: "openai-completions",
    authToken: tk, port: await freeP(), stickyKeys: false,
    apiKeys: [
      slot("provA", "a", "sk-a", upAll.address().port, "ma"),
      slot("provB", "b", "sk-b", upAll.address().port, "mb"),
      slot("provC", "c", "sk-c", upAll.address().port, "mc"),
    ],
  });
  await c.start();
  let outcome = "";
  try {
    const r = await fetch(`http://127.0.0.1:${c.port}/c`, { method: "POST", body: JSON.stringify({ model: "fast", messages: [] }), headers: { authorization: "Bearer " + tk } });
    outcome = `status=${r.status}`;
    await r.text();
  } catch (e) { outcome = `error=${e.message}`; }
  // 关键断言：请求正常结束（429/502 快速失败皆可），进程未因越界崩溃
  ok("竞态：重试窗口内热更新减槽 → 请求快速失败不崩溃", /status=(429|502)/.test(outcome), `(${outcome})`);
  c.stop(); upAll.close();
}

// ---------- H3：body 接收超时（可配 bodyTimeoutMs）→ 408 ----------
{
  const up = await makeUpstream((req, res) => { res.writeHead(200); res.end("{}"); });
  const tk = token();
  const c = new ProxyServer({
    provider: "hot3", upstream: `http://127.0.0.1:${up.address().port}`,
    apiKeys: [{ name: "k1", key: "sk-a" }],
    port: await freeP(), authToken: tk,
    timeouts: { bodyTimeoutMs: 200 }, // 缩短便于测试
  });
  await c.start();
  // 发 headers（content-length 10000）+ 部分 body，然后停住不 end —— 模拟客户端卡在发 body
  const sock = http.request({ host: "127.0.0.1", port: c.port, path: "/c", method: "POST",
    headers: { "content-type": "application/json", "content-length": "10000", authorization: "Bearer " + tk } });
  sock.write('{"model":"fast"}');
  sock.on("error", () => {});
  const code = await new Promise((res) => {
    let done = false;
    sock.on("response", (r) => { done = true; res(r.statusCode); r.resume(); });
    sock.on("error", () => { if (!done) res("err"); });
    setTimeout(() => { if (!done) res("timeout"); }, 3000);
  });
  ok("body 超时 → 408（不再永久挂起）", code === 408, `(code=${code})`);
  c.stop(); up.close();
}

finish("hot-update 深度审核");
