import { NextResponse } from "next/server";
import { readSubagentEngineStatus } from "@/lib/subagent-settings";

export const dynamic = "force-dynamic";

// fork 语义：pi-web 的子代理引擎固定为 @aiti-ai/pi-subagents（pi settings.json packages
// 装载即启用，无独立开关）。上游「内置子代理」开关（readSubagentSettings 的
// builtInEnabled + PUT 写入）已随 Agents 页区块替换一并移除——恒禁用守护见
// lib/subagent-settings.ts isBuiltInSubagentsEnabled。
export async function GET() {
  try {
    return NextResponse.json({ engine: readSubagentEngineStatus() });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
