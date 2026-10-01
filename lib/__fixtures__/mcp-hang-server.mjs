// An MCP stdio server that never answers, for tests that a connection is
// stopped on time. It reads stdin and ignores every message, stays alive
// after stdin closes, and with PI_WEB_FIXTURE_IGNORE_TERM set ignores SIGTERM
// too, so only SIGKILL ends it. It writes its pid to PI_WEB_FIXTURE_PID_FILE
// and a line to stderr, so a test can check the process and its stderr tail.
import { writeFileSync } from "node:fs";

if (process.env.PI_WEB_FIXTURE_PID_FILE) writeFileSync(process.env.PI_WEB_FIXTURE_PID_FILE, String(process.pid));
if (process.env.PI_WEB_FIXTURE_IGNORE_TERM) process.on("SIGTERM", () => {});
process.stderr.write("hang fixture waiting\n");
process.stdin.on("data", () => {});
process.stdin.on("end", () => {});
setInterval(() => {}, 1_000);
