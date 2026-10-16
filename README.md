# wa-orchestrator

**One process, one WhatsApp account, N groups, one brain per group.**

wa-orchestrator is a multi-group WhatsApp bot: a
[whatsapp-web.js](https://github.com/pedroslopez/whatsapp-web.js) client
(Chromium + Xvfb) listens on registered groups and delegates every request to
a **brain = a [pi](https://pi.dev) 1.2.0 agent running inside a sandboxed
Docker container**, with a locked LLM model.

The orchestrator is extensible by construction: **adding a group = one
registry entry**, adding a capability = one brain profile.

Source is TypeScript in `src/` (compiled to `dist/` by `npm run build`);
all runtime entry points live in `dist/`.

```
 WhatsApp ──wwebjs──▶ index.js ──per group──▶ brain.js ──docker──▶ container
 (1 account)          registry                docker run            pi agent
                                              wa-orchestrator-     ├── beads (read-only)
                                              sandbox              ├── tools (git, hugo, …)
                                                                    └── 1 brain ≠ 1 group
```

## Brains (profiles)

| profile | free-text `pi …` | run modes |
|---|---|---|
| `beads-project` | list/create beads by label in a beads repo | `pi run <bead>` → executes the bead, artifacts → `task/<id>` branch |
| `site-project` | scoped read-only beads (a live Dolt DB, filtered to a set of epics) | `pi edit <instruction>` → edits the site checkout, verifies the build, **commit + push** to `origin/main` |

The brain is chosen **per group** (the `brain` field of the registry) — not
per message, not per server.

## Quickstart

Prereqs: `docker`, `xvfb` (`xvfb-run`), system Chromium, node ≥ 22.

```bash
npm install            # also runs `npm run build` (tsc → dist/)
# 1. Sandbox image (pi 1.2.0, bd, jq, hugo_extended — see sandbox/Dockerfile)
bash sandbox/build.sh
# 2. Config: start from the template, fill in JIDs + absolute paths
cp config.template.json config.json
#    (override the path with WO_CONFIG=/abs/path/config.json if needed)
#    A group's JID shows up in the log of its first message, or run
#    `npm run discover` (xvfb-run -a node dist/discover.js) in a maintenance window
# 3. Services (template units provided, user-scoped — fill <HOME>/<NODE_BIN>)
cp wa-orchestrator.service wa-orchestrator-dashboard.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now wa-orchestrator wa-orchestrator-dashboard
```

The WhatsApp session lives in `sessions/` (LocalAuth). **One client per
account**: never run two instances at the same time (a previous bot using the
same account included).

Prompts are loaded from `brain-prompts.json` (gitignored, per deployment);
start from `brain-prompts.template.json`. Without it the bot falls back to
minimal generic built-in prompts and logs a warning.

## Extending

### Adding a group
1. Get the JID (from an inbound message, or `npm run discover`).
2. Add `{"jid": "...@g.us", "name": "My group", "brain": "site-project"}` to
   `groups[]` in `config.json`.
3. Restart the service. That's it.

### Adding a brain
Add a profile to `brains{}` in `config.json` (repo paths, prompts file
entries, run mode) and point a registry entry at it.

## Security

- **Every member of a registered group can command the bot** (no per-member
  auth) — accepted by design.
- Write-capable run modes (e.g. `pi edit` → push to production) are **scoped
  in the in-container prompt**: minimal edits, mandatory build before push,
  never force-push, never touch `.github/`.
- Git credentials for run modes are **materialized inside the container**
  (`sandbox/git-home/`), never in the repo.
- Everything is traced: `activity/activity.jsonl` (asks, replies, run modes)
  + dashboard on `:8093`.
- The repo contains **no secrets**: `config.json` and `brain-prompts.json`
  are gitignored; only `config.template.json` and `brain-prompts.template.json`
  (placeholders) are published.

## Operations

```bash
systemctl --user status wa-orchestrator wa-orchestrator-dashboard
journalctl --user -f -u wa-orchestrator
curl -s localhost:8093/healthz          # → ok
npm run test-brain -- --profile site-project "Which beads are open?"
# Full self-test (env): the bot pings each listed group through itself
SELFTEST_GROUP="Group A,Group B" node dist/index.js
```

**Rollback**: stop `wa-orchestrator` and start the previous unit — same
account, same session, no re-QR.

## Developers

- **TypeScript**: sources in `src/` (`strict`, CommonJS output to `dist/`).
  `npm run build` after editing; `npm test` runs the `node:test` suite in
  `test/` against the compiled output.
- `npm pack` prepares the package; publishing happens from a machine holding
  an npm token (`npm publish`). It is distributed as a **pi package**
  (keyword `pi-package`, `pi` manifest): `pi install npm:wa-orchestrator`
  installs the daemon + the operations skill.
- Static docs: `docs/` → published to GitHub Pages by
  `.github/workflows/deploy-docs.yml` (branch `gh-pages`).
