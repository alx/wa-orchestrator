/**
 * groups.ts — enumerate the WhatsApp account's groups via the raw Web store.
 *
 * RELIABLE path (verified during the build spike, NOTES.md):
 *   window.WWebCollections.Chat.getModelsArray()
 * → chats carry `notify` (the JID) and `groupMetadata.subject` (display name).
 * The wwebjs getChats() layer is broken against current WA Web builds —
 * never use it here.
 */
import type { Page } from 'puppeteer';

export interface AccountGroup {
  jid: string;
  name: string;
  members?: number;
}

/**
 * @param page  an initialized puppeteer page for the WA Web context
 *             (client.pupPage — typed `any` here: the code below runs inside
 *             the browser and pokes at WA Web internals)
 */
export async function listAccountGroups(client: { pupPage?: Promise<Page> } | any): Promise<AccountGroup[]> {
  const page: any = await (client as any).pupPage;
  // WA Web injects its globals asynchronously — wait briefly. NOTE: on the
  // current WA Web build WWebCollections no longer exists (wwebjs version
  // skew); enumeration then fails gracefully and is logged. JID discovery
  // works via discover.ts (message-based) instead.
  await page
    .waitForFunction('typeof window.WWebCollections !== "undefined"', { timeout: 8000 })
    .catch(() => {});
  // The evaluated function runs IN the browser — its globals are the page's.
  return await page.evaluate((): AccountGroup[] => {
    const w = globalThis as any;
    const a: any[] = w.WWebCollections.Chat.getModelsArray();
    return a
      .filter((c: any) => c.notify && String(c.notify).endsWith('@g.us'))
      .map((c: any) => ({
        jid: c.notify,
        name: (c.groupMetadata && c.groupMetadata.subject) || '(unnamed)',
        members: c.groupMetadata && c.groupMetadata.size,
      }));
  });
}
