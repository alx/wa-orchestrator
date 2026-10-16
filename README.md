# wa-orchestrator

**Un processus, un compte WhatsApp, N groupes, un cerveau par groupe.**

wa-orchestrator est un bot WhatsApp multi-groupes : un client
[whatsapp-web.js](https://github.com/pedroslopez/whatsapp-web.js) (Chromium +
Xvfb) écoute des groupes enregistrés et délègue chaque demande à un **cerveau
= agent [pi](https://pi.dev) 1.2.0 exécuté dans un conteneur Docker
sandboxé**, avec modèle LLM verrouillé.

L'orchestrateur est extensible par construction : **ajouter un groupe = une
entrée dans le registre**, ajouter une capacité = un profil de cerveau.

```
 WhatsApp ──wwebjs──▶ index.js ──par groupe──▶ brain.js ──docker──▶ conteneur
  (1 compte)          registre                docker run            agent pi
                                              wa-orchestrator-      ├── beads (lecture seule)
                                              sandbox               ├── tools (git, hugo, …)
                                                                    └── 1 cerveau ≠ 1 groupe
```

## Cerveaux (profils)

| profil | free-text `pi …` | run modes |
|---|---|---|
| `ai-slop` | beads du projet AI Slop | `pi run <bead>` → exécute le bead, artefacts → branche `task/<id>` |
| `cpo` | beads du Centre de la Photographie Ordinaire (base vivante Dolt, arborescences scopées) | `pi edit <instruction>` → édite le site, build Hugo, **commit + push** sur `origin/main` |

Le cerveau est choisi **par groupe** (champ `brain` du registre) — pas par
message, pas par serveur.

## Démarrage rapide

Prérequis : `docker`, `xvfb` (`xvfb-run`), Chromium système, node ≥ 22.

```bash
npm install
# 1. Image sandbox (pi 1.2.0, bd, jq, hugo_extended — voir sandbox/Dockerfile)
bash sandbox/build.sh
# 2. Config : partir du template, remplir JIDs + chemins
cp config.template.json config.json
#    JID d'un groupe : le log de la 1re message du groupe le montre,
#    ou `xvfb-run -a node discover.js` pendant une fenêtre de maintenance
# 3. Services (unités fournies, user-scoped)
cp wa-orchestrator.service wa-orchestrator-dashboard.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now wa-orchestrator wa-orchestrator-dashboard
```

La session WhatsApp vit dans `sessions/` (LocalAuth). **Un seul client par
compte** : ne jamais lancer deux instances (ni l'ancienne `ai-slop-wa`) en
même temps.

## Extension

### Ajouter un groupe
1. Récupérer le JID (message entrant ou `discover.js`).
2. Ajouter `{"jid": "...@g.us", "name": "Mon groupe", "brain": "cpo"}` dans
   `config.json` → `groups[]`.
3. Redémarrer le service. C'est tout.

### Ajouter un cerveau
Ajouter un profil dans `config.json` → `brains{}` (répertoire beads, prompt,
run modes) et le pointer depuis une entrée du registre.

## Sécurité

- **Tous les membres d'un groupe enregistré peuvent commander** (pas d'auth
  par membre) — par conception héritée.
- Les run modes qui écrivent (ex. `pi edit` → push production) sont
  **scopés dans le prompt** du conteneur : édits minimaux, build obligatoire
  avant push, jamais de force-push, jamais de fichier `.github/`.
- Les credentials git des run modes sont **matérialisées dans le conteneur**
  (`sandbox/git-home/`), jamais dans le repo.
- Tout est tracé : `activity/activity.jsonl` (asks, replies, run modes) +
  dashboard `:8093`.
- Le repo ne contient **aucun secret** : `config.json` est gitignored, seul
  `config.template.json` (placeholders) est publié.

## Exploitation

```bash
systemctl --user status wa-orchestrator wa-orchestrator-dashboard
journalctl --user -f -u wa-orchestrator
curl -s localhost:8093/healthz          # → ok
node test-brain.js --profile cpo "Quels beads ouverts ?"
# Self-test complet (env) : le bot s'évalue dans chaque groupe listé
SELFTEST_GROUP="AI Slop,C-dl-PO" node index.js
```

**Rollback** : arrêter `wa-orchestrator`, relancer l'ancienne unité
(`ai-slop-wa`) — même compte, même session, aucun re-QR.

## Développeurs

- `npm pack` prépare le paquet ; publication depuis une machine avec token
  npm (`npm publish`). Paquet distribué comme **pi package** (keyword
  `pi-package`, manifest `pi`) : `pi install npm:wa-orchestrator` installe le
  daemon + la skill d'exploitation.
- Docs statiques : `docs/` → publiée sur GitHub Pages par
  `.github/workflows/deploy-docs.yml` (branche `gh-pages`).
