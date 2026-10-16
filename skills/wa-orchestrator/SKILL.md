# wa-orchestrator — exploitation

Daemon WhatsApp multi-groupes : un processus, un compte WhatsApp, N groupes
enregistrés, un cerveau (agent pi sandboxé dans docker) par groupe.
`pi install npm:wa-orchestrator` donne à l'agent ce guide et les sources.

## Prérequis hôte
- docker, `xvfb-run` (xvfb), Chromium système, node ≥ 20.
- Une image sandbox : `bash sandbox/build.sh` (pi 1.2.0, bd, jq, hugo_extended).

## Installer / lancer
1. `npm install` (si pas déjà fait dans le paquet).
2. `cp config.template.json config.json` puis remplir :
   - `groups[]` : `{jid, name, brain}` — JID = premier message d'un groupe,
     ou `npm run discover` pendant une fenêtre où AUCUN autre client n'est
     connecté au compte.
   - `brains{}` : chemins absolus (dossiers beads, site, git-home), image
     `sandboxImage`, modèle verrouillé.
3. Services (user-scoped, fichiers fournis) :
   `wa-orchestrator.service` + `wa-orchestrator-dashboard.service`
   (`systemctl --user enable --now …`), ou au foreground :
   `SELFTEST_GROUP="NomGroupe" xvfb-run -a node index.js`.

## Règles dures
- **UN seul client par compte WhatsApp** : jamais deux instances (ni un
  autre bot sur la même session `sessions/`) en même temps.
- La session vit dans `sessions/` (LocalAuth) — la déplacer = pas de re-QR,
  la perdre = re-scan QR obligatoire.
- Le dashboard écoute sur `:8093` (`/healthz` → `ok`).
- Journal d'activité : `activity/activity.jsonl` (asks, replies, run modes).

## Étendre
- **Nouveau groupe** : ajouter une entrée `groups[]` + redémarrer.
- **Nouveau cerveau** : ajouter un profil `brains{}` (dossier beads scopé,
  prompt, run modes) et le pointer depuis le registre.

## Dépanner
- `group enumeration failed` au démarrage : inoffensif sur les builds récents
  de WA Web (WWebCollections disparue) ; le fonctionnement n'en dépend pas.
- `disconnected` + QR : la session a été supplantée — vérifier qu'aucun
  autre client n'est connecté, relancer, re-scanner si besoin.
- Run mode `pi edit` : vérifier le push (`git log origin/main` dans le repo
  cible) et le journal `activity/` ; le diff est affiché dans le groupe.
