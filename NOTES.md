# wa-orchestrator — SPIKE findings

Date: 2026-10-16. Verified empirically against live WhatsApp Web via wwebjs 1.34.7 (npm latest at the time). Concrete JIDs/numbers omitted here; they live in `config.json` (gitignored).

## Account & target
- **Bot account = the owner's personal account.** Consequence: owner's asks
  AND bot replies are both `fromMe:true` from the same JID. **`fromMe` cannot
  be the own-message filter.**
- **Target is a GROUP** (not a channel). The bot account must already be a
  member; no invite link needed.
- Bot posts are prefixed **`🤖 `** so they are visually distinguishable in-group.

## What WORKS (verified)
1. **Auth/session**: LocalAuth with `./sessions` — QR scanned once, session
   persists across runs. Headful Chromium under `xvfb-run` on system Chromium.
2. **Inbound events**: `message_create` fires for (a) messages sent to the
   group from the owner's phone and (b) the bot's own API sends (`fromMe:true`,
   full `id{remote,id,participant}` object, `ack:0`).
3. **Outbound**: `client.sendMessage('<JID>', text)` — messages **arrive in
   the group**. Return value is unreliable: may be `undefined` (return-model
   lookup misses) or throw a benign late error ("reading 'id'") after the send
   already went out. **Never treat a throw as send-failure; verify via the
   `message_create` echo or sent-ID bookkeeping.**
4. **Raw store reads** (bypass library query layer):
   `window.WWebCollections.Chat.getModelsArray()` → all chats; groups carry
   `notify` (JID) + `groupMetadata.subject` (name). This is the reliable
   enumeration path (when the build still ships `WWebCollections`).
5. `window.WWebJS.sendMessage(chatModel, body, opts)` called directly with the
   raw chat model: resolves without throwing.

## What's BROKEN in wwebjs vs current WA Web build (version skew)
- `client.getChats()` / `getChatModel` → throws or returns models with
  `id: undefined` (serialization drift). **Do not use.**
- Plain `message` event **never fires** (only `message_create`). Wire the bot
  to `message_create`.
- `getChannels()` / channel-invite APIs → broken internals. Irrelevant if the
  target is a group.
- `acceptInvite` / join path → broken. Irrelevant if already in the group.
- `window.WWebCollections` may be renamed/removed on newer WA Web builds —
  group auto-enumeration must fail **gracefully** (log + continue). JID
  discovery that works regardless is message-based: `node discover.js`
  (send a throwaway message to the target group, read the JID off the inbound
  event). 100% reliable, build-independent.

## Bot design (settled)
- **Inbound**: `message_create` only.
- **Skip** anything that is not a registered group (registry in `config.json`);
  DMs can be allowed later.
- **Skip own messages**: body starts with `🤖 ` (stateless, primary) + rolling
  set of sent remote-msg-IDs (~200, secondary).
- **Trigger**: trimmed body === `pi` or starts with `pi ` (case-insensitive).
- **All bot output** to the group is prefixed `🤖 `.
- Brain: `pi --mode rpc --no-session` (provider/model per deployment),
  hard-locked model via `modelLock`.
- Beads ops via `bd` CLI, scoped per brain profile.

## Ops notes
- Run under `xvfb-run -a node …` (headful required; headless breaks WA Web).
- Session dir `./sessions`; if `session/` Chromium profile locks remain, delete
  `sessions/session` + stray `node`/`xvfb` procs before relaunch.
- `pkill -f` self-match hazard: a pattern that appears in the calling shell's
  own cmdline kills the shell (exit 143). Kill by PID via /proc cmdline scans.
- Timestamps in logs are UTC; display them in local time in dashboards.
