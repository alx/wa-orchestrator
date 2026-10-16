# wa-orchestrator — operations

Multi-group WhatsApp daemon: one process, one WhatsApp account, N registered
groups, one brain (a pi agent sandboxed in Docker) per group.
`pi install npm:wa-orchestrator` gives the agent this guide plus the sources.

## Host prerequisites
- docker, `xvfb-run` (xvfb), system Chromium, node ≥ 20.
- A sandbox image: `bash sandbox/build.sh` (pi 1.2.0, bd, jq, hugo_extended).

## Install / start
1. `npm install` (if not already done in the package).
2. `cp config.template.json config.json`, then fill:
   - `groups[]`: `{jid, name, brain}` — JID = first message from a group, or
     `npm run discover` during a window where NO other client is connected to
     the account.
   - `brains{}`: absolute paths (beads repo, site checkout, git-home),
     `sandboxImage`, the locked model.
   - `cp brain-prompts.template.json brain-prompts.json`, then adapt the
     prompt templates to the project (language, labels, epics, URLs).
3. Services (user-scoped, files provided, fill `<HOME>`/`<NODE_BIN>`):
   `wa-orchestrator.service` + `wa-orchestrator-dashboard.service`
   (`systemctl --user enable --now …`), or foreground:
   `SELFTEST_GROUP="Group A" xvfb-run -a node index.js`.

## Hard rules
- **ONE client per WhatsApp account**: never two instances (nor another bot
  on the same `sessions/` session) at the same time.
- The session lives in `sessions/` (LocalAuth) — moving it = no re-QR,
  losing it = QR re-scan required.
- The dashboard listens on `:8093` (`/healthz` → `ok`).
- Activity log: `activity/activity.jsonl` (asks, replies, run modes).

## Extend
- **New group**: add a `groups[]` entry + restart.
- **New brain**: add a `brains{}` profile (scoped beads repo, prompt entries,
  run modes) and point a registry entry at it.

## Troubleshooting
- `group enumeration failed` at startup: harmless on recent WA Web builds
  (`WWebCollections` removed); nothing depends on it.
- `disconnected` + QR: the session was superseded — verify no other client is
  connected, restart, re-scan if needed.
- Run mode `pi edit`: verify the push (`git log origin/main` in the target
  repo) and the `activity/` log; the diff is shown in the group.
