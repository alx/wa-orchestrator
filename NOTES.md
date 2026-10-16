# AI Slop WA bot — SPIKE findings (org-72rw.1)

Date: 2026-10-16. All verified empirically against live WhatsApp Web via wwebjs 1.34.7 (npm latest).

## Accounts & targets
- **Bot account = the owner's personal account** (confirmed by owner):
  - pushname "Alex 🇻🇳", `84378022537@c.us`, LID form `11481169031293@lid` (same identity, two forms).
  - Consequence: owner's asks AND bot replies are both `fromMe:true` from the same JID. **`fromMe` cannot be the own-message filter.**
- **Target chat: "AI Slop" GROUP (not a channel)**: `120363430580200766@g.us`. Bot account is already a member. (The `whatsapp.com/channel/...` URL was a red herring; group invite link not needed.)
- Owner requirement: bot posts are prefixed **`🤖 `** so they are visually distinguishable in-group.

## What WORKS (verified)
1. **Auth/session**: LocalAuth with `./sessions` — QR scanned once, session persists across runs. Headful Chromium under `xvfb-run` on system `/usr/bin/chromium` (150.x).
2. **Inbound events**: `message_create` fires for (a) messages sent to the group from the owner's phone (captured: `{"body":"pi hello","from":"11481169031293@lid"}`) and (b) the bot's own API sends (captured full event: `fromMe:true`, full `id{remote,id,participant}` object, `ack:0`).
3. **Outbound**: `client.sendMessage('120363430580200766@g.us', text)` — messages **arrive in the group** (owner confirmed receipt). Return value is unreliable: may be `undefined` (return-model lookup misses) or throw a benign late error ("reading 'id'") after the send already went out. **Never treat a throw as send-failure; verify via the `message_create` echo or sent-ID bookkeeping.**
4. **Raw store reads** (bypass library query layer): `window.WWebCollections.Chat.getModelsArray()` → 107 chats, groups carry `notify` (JID) + `groupMetadata.subject` (name). This is the reliable enumeration path.
5. `window.WWebJS.sendMessage(chatModel, body, opts)` called directly with the raw chat model: resolves without throwing.

## What's BROKEN in wwebjs 1.34.7 vs current WA Web build (version skew)
- `client.getChats()` / `getChatModel` → throws or returns models with `id: undefined` (serialization drift). **Do not use.**
- Plain `message` event **never fires** (only `message_create`). Wire the bot to `message_create`.
- `getChannels()`/channel-invite APIs → broken internals (`getRoleByIdentifier is not a function`). Irrelevant now (target is a group, not a channel).
- `acceptInvite`/join path → broken (`joinGroupViaInvite` undefined). Irrelevant (already in group).

## Bot design (settled)
- **Inbound**: `message_create` only.
- **Skip** if chat ≠ `120363430580200766@g.us` (configurable to allow DMs later).
- **Skip own messages**: body starts with `🤖 ` (stateless, primary) + rolling set of sent remote-msg-IDs (~200, secondary).
- **Trigger**: trimmed body === `pi` or starts with `pi ` (case-insensitive).
- **All bot output** to the group is prefixed `🤖 `.
- Brain: `pi --mode rpc --no-session` (provider/model per project rules), hard-locked model.
- Beads ops via `bd` CLI, label `ai-slop`.

## Ops notes
- Run under `xvfb-run -a node …` (headful required; headless breaks WA Web).
- Session dir `./sessions`; if `session/` Chromium profile locks remain, delete `sessions/session` + stray `node`/`xvfb` procs before relaunch.
- `pkill -f` self-match hazard: pattern text in the calling shell's cmdline kills the shell (exit 143). Kill by PID via /proc cmdline scans.
- Timestamps in logs are UTC; host displays CEST (+2).
