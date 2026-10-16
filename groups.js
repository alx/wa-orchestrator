'use strict';
/**
 * groups.js — enumerate the WhatsApp account's groups via the raw Web store.
 *
 * RELIABLE path (verified in ai-slop-wa spike, NOTES.md):
 *   window.WWebCollections.Chat.getModelsArray()
 * → chats carry `notify` (the JID) and `groupMetadata.subject` (display name).
 * The wwebjs getChats() layer is broken against current WA Web builds —
 * never use it here.
 */

/**
 * @param {object} client  initialized wwebjs Client
 * @returns {Promise<Array<{jid:string, name:string, members?:number}>>}
 */
async function listAccountGroups(client) {
  const page = await client.pupPage;
  // WA Web injects its globals asynchronously — wait briefly. NOTE: on the
  // current WA Web build WWebCollections no longer exists (wwebjs version
  // skew); enumeration then fails gracefully and is logged. JID discovery
  // works via discover.js (message-based) instead.
  await page.waitForFunction('typeof window.WWebCollections !== "undefined"', { timeout: 8000 }).catch(() => {});
  return await page.evaluate(() => {
    const a = window.WWebCollections.Chat.getModelsArray();
    return a
      .filter((c) => c.notify && String(c.notify).endsWith('@g.us'))
      .map((c) => ({
        jid: c.notify,
        name: (c.groupMetadata && c.groupMetadata.subject) || '(unnamed)',
        members: c.groupMetadata && c.groupMetadata.size,
      }));
  });
}

module.exports = { listAccountGroups };
