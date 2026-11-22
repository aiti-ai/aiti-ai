import { test } from "node:test";
import assert from "node:assert/strict";
import { aggregateInjections, resolveInjection, getInjectRegistry } from "./inject-registry.ts";

test("注入注册点：多注册者聚合（prepend + head 并存）", () => {
  getInjectRegistry().register("src-a", {
    label: "A",
    scriptFor() {
      return { html: "<script>A</script>", position: "prepend" };
    },
  });
  getInjectRegistry().register("src-b", {
    label: "B",
    scriptFor() {
      return "<script>B</script>"; // string → head
    },
  });
  const out = aggregateInjections(8080, "http://x/", "GET");
  assert.ok(out);
  assert.ok(out.prepend?.includes("A"));
  assert.ok(out.head?.includes("B"));
  // 兼容单段契约：prepend 优先
  const single = resolveInjection(out);
  assert.equal(single?.position, "prepend");
  assert.ok(single?.html.includes("A"));
});

test("注入注册点：scriptFor 抛错不影响其他注册者", () => {
  getInjectRegistry().register("boom", {
    label: "Boom",
    scriptFor() {
      throw new Error("boom");
    },
  });
  getInjectRegistry().register("ok", {
    label: "Ok",
    scriptFor() {
      return { html: "<script>ok</script>", position: "head" };
    },
  });
  const out = aggregateInjections(8080, "http://x/", "GET");
  assert.ok(out?.head?.includes("ok"));
  // 清理
  for (const id of ["src-a", "src-b", "boom", "ok"]) getInjectRegistry().providers().delete(id);
});

test("注入注册点：无注册者 → null（零开销）", () => {
  for (const id of [...getInjectRegistry().providers().keys()]) getInjectRegistry().providers().delete(id);
  assert.equal(aggregateInjections(8080, "http://x/", "GET"), null);
  assert.equal(resolveInjection(null), null);
});

test("注入注册点：非 GET 请求可被 scriptFor 拒绝", () => {
  getInjectRegistry().register("get-only", {
    label: "GetOnly",
    scriptFor(_p, _u, method) {
      return method === "GET" ? "<script>g</script>" : null;
    },
  });
  assert.equal(aggregateInjections(8080, "http://x/", "POST"), null);
  assert.ok(aggregateInjections(8080, "http://x/", "GET")?.head?.includes("g"));
  getInjectRegistry().providers().delete("get-only");
});

test("注入白名单：只聚合 allowedIds 列出的源", () => {
  getInjectRegistry().register("a", { label: "A", scriptFor: () => "<script>A</script>" });
  getInjectRegistry().register("b", { label: "B", scriptFor: () => "<script>B</script>" });
  const all = aggregateInjections(8080, "http://x/", "GET");
  assert.ok(all?.head?.includes("A"));
  assert.ok(all?.head?.includes("B"));
  // 白名单只 b
  const onlyB = aggregateInjections(8080, "http://x/", "GET", ["b"]);
  assert.ok(!onlyB?.head?.includes("<script>A</script>"));
  assert.ok(onlyB?.head?.includes("<script>B</script>"));
  // 白名单为空数组 → 不注入
  assert.equal(aggregateInjections(8080, "http://x/", "GET", []), null);
  for (const id of ["a", "b"]) getInjectRegistry().providers().delete(id);
});
