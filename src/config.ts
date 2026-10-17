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
  /**
   * Group's own working dir, mounted at /workspace (org-lsv8.17): one per
   * group, OUTSIDE shared project repos (never e.g. /home/alx/org). The
   * beads repo stays mounted at /beads (BEADS_DIR), so `bd` works from
   * /workspace too. Unset = legacy: beadsRepoDir doubles as /workspace.
   */
  workspaceDir?: string;
  beadsLabel?: string;
  beadsParentEpic?: string;
  artifactRepoDir?: string;
  runCmd?: string;
  defaultAsk?: string;
  // cpo profile
  epics?: string[];
  /** host root for per-group pi conversation session dirs (org-1v4b) */
  conversationDir?: string;
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
  /** Deadline for a group to answer one of the brain's clarifying questions (ms). Default 30 min. */
  questionTimeoutMs?: number;
  runTimeoutMs?: number;
  sandboxImage?: string;
  /**
   * Host herdr server socket, bind-mounted into the sandbox so in-container
   * herdr CLIs reach the host server (org-5mdy). Panes spawned via pi-herdr
   * are host-owned: they survive brain runs; the human sees them in herdr.
   */
  herdrSocketPath?: string;
  /**
   * Dedicated "home" pane the brain presents as its own (HERDR_PANE_ID): the
   * split target for herdr_spawn_agent. Point it at a dedicated workspace
   * (e.g. the "wa-bot" workspace) so spawned agents stay out of the
   * operator's live work. Empty/omitted = herdr tools degrade (no --current).
   */
  herdrSpawnPane?: string;
  /**
   * Host install root of the pi-herdr package (org-5mdy.1): the pi-herdr
   * launch plan injects `<pkg>/src/child.ts` into the child pi, which runs in
   * a HOST pane — so the package must be loadable from a host-equal path.
   * brain.ts bind-mounts this dir onto itself and points the pi packages
   * list at `<dir>/node_modules/@andrewjacop/pi-herdr` instead of the
   * image-baked /opt/pi-herdr. Omit = image-baked fallback (in-sandbox herdr
   * children cannot start).
   */
  herdrPkgDir?: string;
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
