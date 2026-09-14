import { NextResponse } from "next/server";
import { homedir } from "os";

export async function GET() {
  // 开页有多个消费面（session-manager store / aiti-folder / 编辑器移动对话框…）
  // 各拉一次；home 目录在进程生命周期内不变，private 短缓存让同页第二次 fetch
  // 直接命中内存缓存（不再重复打服务端）。
  return NextResponse.json({ home: homedir() }, {
    headers: { "cache-control": "private, max-age=300" },
  });
}
