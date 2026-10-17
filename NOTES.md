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
  discovery that works regardless is message-based: `node dist/discover.js`
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

## herdr (host)
- User unit `herdr.service` (template `herdr.service` in repo root): guard runs
  `herdr status server | grep '^status: running'` — already running → prints a
  note and exits 0 (unit: inactive/exited, no duplicate); not running →
  `exec herdr server` so systemd tracks the real process (Restart=on-failure).
  Enabled via `systemctl --user enable herdr.service` (lingering user).
- The herdr CLI honors `HERDR_SOCKET_PATH` for both client and server; tested
  the not-running branch against a throwaway `/tmp/herdr-test.sock` so the live
  server/panes were never touched.

## Integration probes (org-lsv8.17, 2026-10-17)
- **Per-group workspaces**: brain cwd is now the group's OWN dir
  (`brain.workspaceDir`, mounted at /workspace, e.g. `workspaces/<brain>`),
  NEVER a shared project repo. The beads repo is a separate /beads mount with
  `BEADS_DIR=/beads/.beads` so bare `bd` resolves from any cwd. (User decision
  17/10: no group brain operates inside /home/alx/org or similar.)
- **pi-subagents dynamic tool activation**: default `toolActivation:"auto"`
  HIDES the `subagent` tool in any session with history — it relies on the
  model calling the `subagents_enable` loader tool first (fresh/empty sessions
  get the tool eagerly; resumed group sessions don't). Verified live: same
  image + flags, fresh `--no-session` → tool visible; resumed group session →
  model correctly reports no `subagent`. Fix: materialized config now sets
  `{ asyncByDefault:false, toolActivation:"eager" }`.
- **herdr spawn from sandbox: FIXED (org-5mdy.1, 17/10 evening)**. Two
  container-only paths were crossed into host panes; both now use HOST-EQUAL
  paths (host dir bind-mounted onto itself):
  1. **Agent dir**: pi-herdr seeds the child session file under
     `<agentDir>/sessions/<cwd-encoded>`; container `/home/node/.pi/agent` is
     unresolvable on the host → EACCES. Fix: runSandbox mounts
     `piConfigDir` onto itself and sets `PI_CODING_AGENT_DIR` to it.
  2. **Child extension**: the launch plan injects `<pkg>/src/child.ts`;
     the image-baked `/usr/local/lib/node_modules/@andrewjacop/pi-herdr` does
     not exist on the host. Fix: install pi-herdr once on the host in a
     self-contained dir (its tarball bundles deps):
     `mkdir -p ~/.local/share/wa-orchestrator/pi-herdr && cd $_ && npm init -y
     && npm i @andrewjacop/pi-herdr@0.6.0`; config key `herdrPkgDir` makes
     brain.ts mount it onto itself and point the pi packages list at
     `<dir>/node_modules/@andrewjacop/pi-herdr` instead of /opt/pi-herdr.
  Verified end-to-end: brain → herdr_spawn_agent → child pane on host (wa-bot
  workspace) → child pi runs to `done` → session file seeded at the
  host-equal `sandbox/pi-config/sessions/--workspace--/` → harvest returned.
  Known surface: the child pi runs as the HOST user with the HOST
  `~/.pi/agent` config (real provider creds), model pinned to the brain's
  locked model; child cwd defaults to the parent's cwd (the group workspace
  host dir) and has no BEADS_DIR — give host-path beads instructions
  explicitly in the spawn prompt.
- **Pane persistence**: host-owned panes survive `docker --rm` brain runs
  (probe panes from container runs still present hours later); the probe
  child pane `w4:p2` from the fixed run is still alive after the brain exited.
- **Home pane moved**: the original `w2` (wa-bot) workspace was lost (server
  state); recreated as **w4** — config `herdrSpawnPane: "w4:p1"`.
  `herdr workspace create` takes the SERVER's cwd, not the client's.
- **Debug note**: the model's "subagent not in my tool list" self-reports
  were TRUE (not hallucination) — the registration was session-dependent
  (auto activation), not process-level. Reproduced deterministically by
  varying one docker flag at a time before changing anything.
