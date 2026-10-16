'use strict';
/**
 * discover.js — log the JID of ANY chat that sends a message.
 * Used to discover a group's JID (WA Web internals are version-skewed).
 * Run during a maintenance window: xvfb-run -a node discover.js
 */
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const CFG = require('./config.json');
const client = new Client({
  authStrategy: new LocalAuth({ dataPath: CFG.sessionsDir }),
  puppeteer: { executablePath: CFG.chromiumPath, headless: false, args: ['--no-sandbox','--disable-setuid-sandbox','--disable-gpu'] },
});
client.on('qr', (qr) => { console.error('QR NEEDED:'); qrcode.generate(qr, { small: true }); });
client.on('ready', () => console.log(new Date().toISOString(), 'READY — waiting for messages (send one from any group)…'));
client.on('message_create', (m) => {
  const jid = (m.chat && m.chat.id && m.chat.id._serialized) || (m.id && m.id.remote) || '?';
  const name = (m.chat && (m.chat.name || (m.chat.groupMetadata && m.chat.groupMetadata.subject))) || '';
  console.log(JSON.stringify({ ts: new Date().toISOString(), jid, name, from: m.from, body: String(m.body || '').slice(0, 80) }));
});
client.initialize().catch((e) => { console.error('INIT ERROR:', e.message); process.exit(1); });
