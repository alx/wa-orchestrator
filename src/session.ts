/**
 * session.ts — per-group pi conversation sessions (org-1v4b).
 *
 * One conversation per GROUP (keyed by JID), persisted as a pi session file
 * on the host. Verified against pi 1.2.0 in the sandbox image:
 *   `pi --mode rpc --session-id <id> --session-dir <dir>` writes
 *   `<dir>/<created-utc>_<id>.jsonl` and RESUMES the same file on later
 *   runs with the same --session-id (flat layout, one file per session).
 * Session ids accept letters, numbers, `.`, `_`, `-` and must start/end
 * with a letter or number.
 */
import * as fs from 'fs';
import * as path from 'path';
import { BrainProfile } from './config';

/**
 * Group JID → pi-valid session id.
 * 120363412696556300@g.us → 120363412696556300-g.us
 */
export function groupSlug(jid: string): string {
  let s = String(jid || '').trim().toLowerCase();
  s = s.replace(/[^a-z0-9._-]+/g, '-');      // anything else → '-'
  s = s.replace(/-{2,}/g, '-');              // collapse runs
  s = s.replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, ''); // must start/end alnum
  return s;
}

/**
 * The per-group session directory (passed to pi as --session-dir /sessions).
 * Each group gets its own dir so a reset is a single directory rename.
 */
export function sessionHostDir(brain: BrainProfile, slug: string): string {
  const root = brain.conversationDir as string;
  if (!root) throw new Error(`brain profile has no conversationDir (org-1v4b)`);
  return path.join(root, slug);
}

/**
 * True if a session file for this slug exists in the group's session dir.
 * (Every *.jsonl in that dir belongs to this slug — one dir per group.)
 */
export function sessionExists(hostDir: string): boolean {
  let entries: string[];
  try {
    entries = fs.readdirSync(hostDir);
  } catch {
    return false;
  }
  return entries.some((f) => f.endsWith('.jsonl'));
}

/**
 * Rename the group's session dir out of the way (pi-new reset).
 * No-op (returns false) when there is nothing to reset.
 */
export function resetSession(hostDir: string): boolean {
  try {
    fs.renameSync(hostDir, `${hostDir}.reset-${Date.now()}`);
    return true;
  } catch {
    return false;
  }
}
