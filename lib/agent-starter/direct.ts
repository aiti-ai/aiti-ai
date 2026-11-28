/**
 * DirectStarter — today's behavior, unchanged.
 *
 * `spawn` forwards every argument to node's child_process.spawn, so a provider
 * that already drives a child process sees a byte-identical result. This is
 * the fallback for: non-pipe stdio, node IPC (child.send), and any session
 * where detaching is switched off.
 */

import { spawn, type ChildProcess } from "node:child_process";
import type { AgentStarter, AgentStarterSpawnOptions } from "./types.ts";

export class DirectStarter implements AgentStarter {
  readonly kind = "direct" as const;

  async spawn(command: string, args: string[], options: AgentStarterSpawnOptions = {}): Promise<ChildProcess> {
    return spawn(command, args, {
      ...(options.cwd ? { cwd: options.cwd } : {}),
      ...(options.env ? { env: options.env as NodeJS.ProcessEnv } : {}),
      ...(options.shell !== undefined ? { shell: options.shell } : {}),
      ...(options.stdio !== undefined ? { stdio: options.stdio as never } : {}),
    });
  }
}
