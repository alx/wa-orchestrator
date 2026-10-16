/**
 * discover.ts — log the JID of ANY chat that sends a message.
 * Used to discover a group's JID (WA Web internals are version-skewed).
 * Run during a maintenance window: xvfb-run -a node dist/discover.js
 */
import { Client, LocalAuth } from 'whatsapp-web.js';
import qrcode = require('qrcode-terminal');
import { loadConfig } from './config';

const CFG = loadConfig();

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: CFG.sessionsDir }),
  puppeteer: {
    executablePath: CFG.chromiumPath,
    headless: false,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu'],
  },
});

client.on('qr', (qr: string) => {
  console.error('QR NEEDED:');
  qrcode.generate(qr, { small: true });
});
client.on('ready', () =>
  console.log(new Date().toISOString(), 'READY — waiting for messages (send one from any group)…')
);
client.on('message_create', (m) => {
  // m.chat is populated at runtime but absent from the wwebjs type defs.
  const chat: any = (m as any).chat;
  const jid =
    (chat && chat.id && chat.id._serialized) || (m.id && m.id.remote) || '?';
  const name =
    (chat && (chat.name || (chat.groupMetadata && chat.groupMetadata.subject))) || '';
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      jid,
      name,
      from: m.from,
      body: String(m.body || '').slice(0, 80),
    })
  );
});

client.initialize().catch((e: Error) => {
  console.error('INIT ERROR:', e.message);
  process.exit(1);
});
