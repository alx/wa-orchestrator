#!/usr/bin/env node
/**
 * list-groups.ts — one-shot probe: list the WA account's groups (JID + name).
 *
 * Run DURING A MAINTENANCE WINDOW (bot stopped — only one
 * wwebjs client may hold the account at a time):
 *
 *   cd wa-orchestrator && xvfb-run -a node dist/list-groups.js
 *
 * Uses the raw Web store path (NOTES.md): window.WWebCollections.Chat.
 */
import { Client, LocalAuth } from 'whatsapp-web.js';
import qrcode = require('qrcode-terminal');
import { listAccountGroups } from './groups';
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
  console.error('QR NEEDED (session lost?) — scan:');
  qrcode.generate(qr, { small: true });
});
client.on('auth_failure', (m: unknown) => {
  console.error('AUTH FAILURE:', m);
  process.exit(1);
});
client.on('ready', async () => {
  try {
    const groups = await listAccountGroups(client);
    console.log(JSON.stringify(groups, null, 1));
  } catch (e) {
    console.error('enumeration failed:', (e as Error).message);
    process.exitCode = 1;
  }
  await client.destroy();
  process.exit(process.exitCode || 0);
});
client.initialize().catch((e: Error) => {
  console.error('INIT ERROR:', e.message);
  process.exit(1);
});
