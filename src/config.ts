/**
 * config.ts — typed config loading.
 *
 * Config path resolution (important after compiling to dist/):
 *   1. process.env.WO_CONFIG — explicit override (tests, dashboards on scratch
 *      ports, demo renders).
 *   2. <project root>/config.json — the deployment root, i.e. the directory
 *      ABOVE this module at runtime (dist/ -> root). Never __dirname: that
 *      would be dist/ itself.
 */
import * as fs from 'fs';
import * as path from 'path';

export const PROJECT_ROOT = path.resolve(__dirname, '..');

export interface GroupEntry {
  jid?: string;
  name: string;
  brain: string;
}

export interface BrainProfile {
  kind: 'beads' | 'cpo';
  botName?: string;
  // beads profile
  beadsRepoDir?: string;
  beadsLabel?: string;
  beadsParentEpic?: string;
  artifactRepoDir?: string;
  runCmd?: string;
  defaultAsk?: string;
  // cpo profile
  epics?: string[];
  siteDir?: string;
  siteBuildCmd?: string;
  siteLiveUrl?: string;
  [key: string]: unknown;
}

export interface Config {
  groups: GroupEntry[];
  brains: Record<string, BrainProfile>;
  triggerPrefix?: string;
  botPrefix?: string;
  ackMessage?: string;
  dryRun?: boolean;
  sessionsDir: string;
  wwebjsCacheDir?: string;
  chromiumPath?: string;
  activityLog?: string;
  activityMaxBytes?: number;
  replyTimeoutMs?: number;
  runTimeoutMs?: number;
  sandboxImage?: string;
  modelLock?: string;
  provider?: string;
  promptsFile?: string;
  hostPiAgentDir?: string;
  piConfigDir?: string;
  workDir?: string;
  gitHomeDir?: string;
  hostGitCredentials?: string;
  gitIdentity?: { name: string; email: string };
  [key: string]: unknown;
}

let cached: Config | null = null;

export function configPath(): string {
  return process.env.WO_CONFIG || path.join(PROJECT_ROOT, 'config.json');
}

export function loadConfig(): Config {
  if (cached) return cached;
  const p = configPath();
  const raw = fs.readFileSync(p, 'utf8');
  cached = JSON.parse(raw) as Config;
  return cached;
}

/** Test hook: drop the cached config (WO_CONFIG must be set BEFORE first load). */
export function _resetConfig(): void {
  cached = null;
}
