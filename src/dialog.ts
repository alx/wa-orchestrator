/**
 * dialog.ts — pure mapping between WhatsApp replies and pi extension-UI
 * dialog responses (org-lsv8). Kept separate from index.ts (which
 * instantiates the WhatsApp client at module level and so can't be
 * imported in tests) and from brain.ts (which owns the docker/RPC plumbing).
 *
 * pi-ask-questions, over RPC, asks one dialog at a time:
 *   select — the `options` array holds the exact line strings the response
 *            must echo back ("1. Label: description", …, and finally the
 *            "Type something." row, which makes the extension follow up
 *            with an `input` dialog);
 *   input  — the raw reply text goes straight back as the value (the
 *            extension parses "1,3"-style multi-picks itself).
 */

/**
 * Map a member's reply for a `select` dialog.
 * - single valid option number => that exact option line
 * - free text and a "Type something." row exists => that row, with the text
 *   stashed as autoType so the follow-up `input` dialog is answered without
 *   a second round trip in the group
 * - otherwise => hint (ask the member again)
 */
export function mapSelectReply(
  options: string[], reply: string,
): { value?: string; hint?: string; autoType?: string } {
  const text = reply.trim();
  if (/^\d+$/.test(text)) {
    const n = Number(text);
    if (n >= 1 && n <= options.length) return { value: options[n - 1] };
    return { hint: `Reply with a number between 1 and ${options.length}.` };
  }
  const typedIdx = options.findIndex((l) => /^\d+\.\s*Type\s/.test(l));
  if (text !== '' && typedIdx >= 0) return { value: options[typedIdx], autoType: text };
  return {
    hint: `Reply with a number between 1 and ${options.length}`
      + (typedIdx >= 0 ? ' or type your own answer.' : '.'),
  };
}

/** Format an extension-UI request as a WhatsApp question message. */
export function formatQuestion(req: {
  method?: string; title?: string; options?: string[];
}): string {
  const title = String(req.title || '').trim();
  const opts = Array.isArray(req.options) ? (req.options as string[]).join('\n') : '';
  const tail = req.method === 'select'
    ? '\n\nReply with the number of your choice.'
    : '\n\nReply with your answer.';
  return (title + (opts ? '\n\n' + opts : '') + tail).slice(0, 3500);
}
