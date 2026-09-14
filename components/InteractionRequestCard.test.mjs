import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const card = await readFile(new URL("./InteractionRequestCard.tsx", import.meta.url), "utf8");
const useAgentSession = await readFile(new URL("../hooks/useAgentSession.ts", import.meta.url), "utf8");

// omp login open_url 专用卡（aiti-pi-family-multi-fork-rpc-plan.md §8.6）：
// 单向登录卡——打开登录页 / 复制短链 / 关闭，无接受/拒绝（agent 轮询授权自动继续）。

test("open_url card renders dedicated login actions with safe window.open", () => {
  assert.match(card, /"plan_approval" \| "ask_user" \| "permission" \| "open_url" \| "generic"/);
  assert.match(card, /isOpenUrl && \(openUrlTarget \?\? copyUrlTarget\)/);
  // 打开登录页：完整 URL 优先 + noopener 防反向标签劫持
  assert.match(card, /openUrlTarget = request\.url \?\? request\.launchUrl/);
  assert.match(card, /window\.open\(openUrlTarget, "_blank", "noopener,noreferrer"\)/);
  // 复制链接：本机短链优先（长 OAuth URL 手抄易截断）+ 瞬时反馈
  assert.match(card, /copyUrlTarget = request\.launchUrl \?\? request\.url/);
  assert.match(card, /navigator\.clipboard\?\.writeText\(copyUrlTarget\)/);
  assert.match(card, /已复制 ✓/);
  // 单向卡：关闭走 respond accept（handle 返回 false 不抛错，仅本端清卡）
  assert.match(card, /title="仅清掉本卡；agent 检测到授权完成会自动继续"/);
  assert.match(card, /isOpenUrl && \(\s*<>\s*<button[\s\S]*复制链接[\s\S]*关闭[\s\S]*打开登录页/);
});

test("open_url fields flow through useAgentSession whitelist", () => {
  assert.match(useAgentSession, /event\.kind === "open_url"/);
  assert.match(useAgentSession, /url: typeof event\.url === "string" \? event\.url : undefined/);
  assert.match(useAgentSession, /launchUrl: typeof event\.launchUrl === "string" \? event\.launchUrl : undefined/);
});
