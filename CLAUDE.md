# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# mdph-vocal

Site qui aide à remplir la **partie B « Votre vie quotidienne »** du formulaire de demande MDPH (Cerfa 15692*01) en conversant à la voix avec un assistant (Flask + DSFR, pas de build front, pas de base de données — tout est stateless côté serveur).

Avant toute modification de l'interface (HTML, CSS ou JavaScript dans `static/`), ou toute revue d'interface, charger le skill `dsfr-rgaa` et l'appliquer : DSFR à 100 % sans réécriture ni surcouche, RGAA 4.1 à 100 %.

## Commandes

Pas de linter. Tests (pytest, extraction et vérification des faits) : `.venv/bin/pip install -r requirements-dev.txt && .venv/bin/pytest tests`.

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python -m piper.download_voices --data-dir voices fr_FR-siwis-medium fr_FR-tom-medium   # voix naturelles, facultatif
.venv/bin/python app.py                     # serveur de développement, http://127.0.0.1:8000
```

- `ALBERT_API_KEY=... .venv/bin/python llm.py models` — liste les modèles Albert disponibles (pour choisir `ALBERT_MODEL`).
- `./tester-a-distance.sh` — lance le serveur s'il ne tourne pas et ouvre un tunnel Cloudflare HTTPS pour faire tester à distance (voir avertissements dans le README : données fictives uniquement, fermer le tunnel après chaque session).
- Génération de la documentation technique (`docs/`) : voir [docs/generateur/LISEZMOI.md](docs/generateur/LISEZMOI.md).

Configuration via `.env` (copié depuis `.env.example`, jamais versionné) : `LLM_PROVIDER` (`albert` ou `anthropic`), clés API, `ACCES_IDENTIFIANT`/`ACCES_MOT_DE_PASSE` pour protéger un tunnel de test. Les variables d'environnement définies au lancement l'emportent sur `.env`.

## Architecture

**Le questionnaire est entièrement déclaratif.** `static/form-b.json` est le seul fichier à modifier pour faire évoluer les questions : `sections`/`steps` (regroupement et parcours), `questions` (un schéma par question : `type` — `single`/`multi`/`yesno`/`date`/`number`/`text`/`longtext`/`table` —, `options`, `synonyms`, `when` pour l'affichage conditionnel, `simple` pour la reformulation sans IA), `acronyms` (glossaire des sigles lus et reconnus à la voix).

**Flux d'une réponse vocale :**
1. Le navigateur (Web Speech API, `static/js/voice.js`) transcrit la phrase et l'envoie à `POST /api/interpret` avec la question en cours, l'historique et le brouillon éventuel (`app.py`).
2. `llm.py` construit un prompt (consignes + schéma complet du formulaire en préfixe mis en cache, question posée en suffixe) et appelle le modèle configuré (Albert API ou Claude), en contraignant la sortie par un schéma JSON (`RESPONSE_SCHEMA`). `_sanitize()` ne garde que des valeurs cohérentes avec le type de la question avant de répondre.
3. Si l'API est indisponible (`LLMUnavailable`), le front bascule sur `static/js/local-nlu.js` (mots-clés, oui/non, dates, nombres, sans IA) — mode à préserver pour toute nouvelle question.
4. `static/js/main.js` pilote la conversation (étapes, navigation, relances), `static/js/form.js` rend le formulaire en DSFR et évalue les conditions `when`.
5. **Mémoire « le dire une fois »** (`static/js/memory.js`, transcription + faits avec citation) : pendant que l'usager parle, chaque morceau de phrase définitif (`Listener.onSegment`) est envoyé à `POST /api/extract` quand l'usager reprend la parole (`onResume`), un appel à la fois ; le dernier morceau passe par `/api/interpret`, qui renvoie aussi des `facts`. `llm.sanitize_facts` rejette les faits dont la citation n'a pas été dite ou dont la valeur est invalide. Les faits pré-remplissent les questions suivantes (confirmation oui / non, `askPrefilled`) ; une contradiction avec une réponse déjà donnée est vérifiée avec l'usager avant la question suivante (`askConflict`). Panneau de débogage (`static/js/debug-memory.js`) si `MEMOIRE_DEBUG=1`. Conception : `docs/plan-memoire.md`.
6. `POST /api/navigate` retrouve une question déjà posée que l'usager veut revoir (« la question sur le logement ») via `llm.find_question`.
7. En fin de parcours, `POST /api/cerfa-partie-b.pdf` (`pdf_cerfa.py`) remplit le Cerfa officiel (`pdf/cerfa_15692-01.pdf`) à partir des réponses et ne renvoie que les pages 5 à 8, en élaguant l'arbre de structure du PDF plutôt qu'en copiant les pages (pour préserver le balisage d'accessibilité, RGAA 13.3). **Toute nouvelle question destinée au Cerfa doit être ajoutée à la correspondance (`CHECKS`/`TEXTS`/`DATES`/...) de `pdf_cerfa.py`**, sinon elle n'apparaît pas dans le PDF produit.
8. `tts.py` sert la synthèse vocale naturelle (Piper, modèles dans `voices/`, non versionnés) via `POST /api/tts` ; sans modèle disponible, le front retombe sur la voix du navigateur.

**Rien n'est conservé côté serveur** : pas de base de données, pas de session utilisateur, pas de cache des réponses de `/api/*` (`Cache-Control: no-store`). Les réponses, la mémoire et la transcription ne vivent que dans le navigateur (`localStorage`, effacées 7 jours après la dernière activité ou par « Effacer toutes mes réponses »).

**Deux fournisseurs de LLM** interchangeables par `LLM_PROVIDER` (`llm.py`) : `anthropic` (Claude, sortie contrainte par schéma JSON natif) et toute autre valeur (`openai` par convention) pour un fournisseur **compatible avec l'API OpenAI** (chat completions) — Albert API de l'État par défaut (`OPENAI_BASE_URL`/`OPENAI_API_KEY`/`OPENAI_MODEL`), ou n'importe quelle autre passerelle compatible (par exemple LiteLLM) en changeant seulement ces trois variables, sans toucher au code ; bascule automatique vers le mode « objet JSON » si le modèle refuse la sortie par schéma.

**Interface** : DSFR 1.15.3 vendored dans `static/vendor/dsfr/`, sans framework front ni étape de build — pages HTML statiques servies directement par Flask (`send_from_directory`), JS vanilla modulaire par responsabilité (`voice.js`, `form.js`, `main.js`, `local-nlu.js`). Toute modification d'interface suit les règles du skill `dsfr-rgaa` (`.claude/skills/dsfr-rgaa/SKILL.md`) : composants DSFR tels quels, conformité RGAA 4.1, autocritique du design avant de répondre.

**Sécurité** (`app.py`) : en-têtes (`CSP`, `Permissions-Policy: microphone=(self)`, pas de cache sur les pages et les API), auth HTTP Basic optionnelle (`ACCES_IDENTIFIANT`/`ACCES_MOT_DE_PASSE`) pour limiter l'accès lors des tests à distance. Ce projet traite potentiellement des données de santé : voir « Avant une mise en production » dans le README avant tout déploiement réel (AIPD, hébergement HDS, audit RGAA).
