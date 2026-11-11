#!/usr/bin/env bash
# TestAgent 2.0 全量 e2e 一键运行：120 断言（含 SQL 拦截增强）
# 前置：agent + testagent-spring 已构建（./tools/build-all.sh）
# 用法: ./run-all.sh   退出码: 0=全过 非0=有失败

set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
AGENT_JAR="${TESTAGENT_JAR:-$ROOT/TestAgent/TestAgent/target/testagent-1.0.jar}"
SPRING_JAR=$ROOT/TestAgent/extensions/testagent-spring/target/testagent-spring-1.0.jar
TOTAL_FAIL=0

[ -f "$AGENT_JAR" ] || { echo "缺少 agent jar，先: cd TestAgent && ./tools/build-all.sh"; exit 1; }
[ -f "$SPRING_JAR" ] && cp "$SPRING_JAR" "$(dirname "$AGENT_JAR")/"  # 确保适配 jar

echo "════════════════════════════════════════"
echo "  TestAgent 2.0 e2e 全量"
echo "════════════════════════════════════════"

run_one() {
  local name="$1" script="$2"
  echo; echo "────── $name ──────"
  bash "$script"
  local code=$?
  [ $code -ne 0 ] && TOTAL_FAIL=$((TOTAL_FAIL+1))
  return $code
}

run_one "Spring Boot 3（全功能）" "$HERE/e2e-test.sh" || true
run_one "MyBatis（XML/SQL/classwatch）" "$HERE/e2e-mybatis.sh" || true
run_one "Spring Boot 2（兼容）" "$HERE/e2e-spring2.sh" || true
run_one "非 Spring（零污染）" "$HERE/e2e-plain.sh" || true
run_one "eval readonly（安全）" "$HERE/e2e-readonly.sh" || true
run_one "MCP 协议层（工具映射）" "$HERE/e2e-mcp.sh" || true
run_one "attach 场景（agentmain 全链路）" "$HERE/e2e-attach.sh" || true
run_one "SQL 拦截（独立深度）" "$HERE/e2e-sql.sh" || true
run_one "SQL 增强（filter/inject/rewrite/simulate）" "$HERE/e2e-sql2.sh" || true
run_one "REST URL mock（接口返回值模拟）" "$HERE/e2e-restmock.sh" || true
run_one "MCP 启动工具（ta_run）" "$HERE/e2e-mcp-tools.sh" || true
run_one "多进程并存（发现机制）" "$HERE/e2e-multi.sh" || true
run_one "SpringBoot 开发模式（总开关/props/springops）" "$HERE/e2e-springdev.sh" || true

echo
echo "════════════════════════════════════════"
if [ $TOTAL_FAIL -eq 0 ]; then echo "✅ 全部场景通过";
else echo "❌ $TOTAL_FAIL 个场景失败"; fi
echo "════════════════════════════════════════"
exit $TOTAL_FAIL
