/**
 * trigger.ts — pure trigger/message parsing (no side effects; unit-testable).
 */

/**
 * Parse an inbound message body against the `pi` trigger.
 * Returns the ask text ('' for a bare "pi"), or null if not a trigger.
 */
export function parseAsk(body: string): string | null {
  const t = (body || '').trim();
  if (!t) return null;
  const m = t.match(/^pi(?:\s+([\s\S]+))?$/i);
  if (!m) return null;
  return m[1] ? m[1].trim() : '';
}

/**
 * Split a run-mode ask: "<runCmd> <rest>" → the rest, or null.
 * runCmd examples: "run" (beads), "edit" (site).
 */
export function parseRun(ask: string, runCmd: string): string | null {
  const m = ask.match(new RegExp(`^${runCmd}\\s+(\\S[\\s\\S]*)$`, 'i'));
  return m ? m[1].trim() : null;
}
