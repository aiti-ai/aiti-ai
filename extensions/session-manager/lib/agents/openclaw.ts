/**
 * session-manager — OpenClaw adapter.
 *
 * OpenClaw runs on the pi agent core, so session artifacts are byte-compatible
 * pi v3 JSONL (~/.openclaw/agents/<agent>/sessions/<uuid>.jsonl) — verified
 * against a real local install. Parsing delegates to the shared
 * parseSessionFile; this adapter only owns discovery.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentAdapter, ExtSessionRef, ExtSourceProbe } from "./types.ts";
import { artifactPrimitives, artifactCapabilities } from "./archive-artifact.ts";
import { statFreshList } from "./fresh.ts";
import { parseSessionFile } from "../session-file.ts";

const ROOT = () => join(homedir(), ".openclaw", "agents");

function* sessionFiles(): Generator<string> {
  const root = ROOT();
  if (!existsSync(root)) return;
  let agents: string[] = [];
  try { agents = readdirSync(root); } catch { return; }
  for (const agent of agents) {
    const dir = join(root, agent, "sessions");
    if (!existsSync(dir)) continue;
    let files: string[] = [];
    try { files = readdirSync(dir); } catch { continue; }
    for (const f of files) {
      if (f.endsWith(".jsonl") && !f.endsWith(".trajectory.jsonl")) yield join(dir, f);
    }
  }
}

export function createOpenclawAdapter(): AgentAdapter {
  return {
    id: "openclaw",
    label: "OpenClaw",
    roots() {
      const r = ROOT();
      return existsSync(r) ? [r] : [];
    },

    probe(): ExtSourceProbe {
      let count = 0;
      let watermarkMs = 0;
      for (const f of sessionFiles()) {
        count++;
        try { watermarkMs = Math.max(watermarkMs, statSync(f).mtimeMs); } catch { /* raced */ }
      }
      return { ok: existsSync(ROOT()), count, watermarkMs };
    },

    listFresh() { return statFreshList(this.list()); },
    list(): ExtSessionRef[] {
      return [...sessionFiles()].map((path) => ({ sid: path.split("/").pop()!.replace(/\.jsonl$/, ""), path }));
    },

    ...artifactPrimitives(),
    capabilities: artifactCapabilities(),
    parse(ref) {
      try {
        return parseSessionFile(ref.path, readFileSync(ref.path, "utf8"));
      } catch {
        return null;
      }
    },
  };
}
