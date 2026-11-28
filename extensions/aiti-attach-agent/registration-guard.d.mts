/** Type declarations for registration-guard.mjs (runtime module is plain ESM). */

export declare const PI_PLUGIN_NAMES: Set<string>;
export declare const GUARD_FORCE_ENV: string;

export declare function defaultSettingsFiles(opts?: { agentDir?: string; cwd?: string }): string[];
export declare function defaultAgentDir(env?: Record<string, string | undefined>): string;
export declare function npmSpecName(source: string): string;
export declare function resolvePluginRoot(fromPath: string): { dir: string; meta: Record<string, unknown> | null };
export declare function findPluginEntry(opts?: {
  settingsFiles?: string[];
  agentDir?: string;
}): { source: string; dir: string | null; settingsFile: string } | null;
export declare function isGeneratedLegacyDir(dir: string): boolean;
export declare function checkDuplicateRegistration(opts: {
  selfUrl: string;
  settingsFiles?: string[];
  agentDir?: string;
  force?: boolean;
  env?: Record<string, string | undefined>;
}): { standDown: boolean; selfDir: string; winner: string | null; reason: string | null };
