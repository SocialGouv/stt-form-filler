# Formulaire MDPH - Partie B

Site qui aide à remplir la **partie B « Votre vie quotidienne »** du formulaire de demande MDPH (Cerfa 15692*01) en conversant à la voix avec un assistant.

## Lancer en local

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python -m piper.download_voices --data-dir voices fr_FR-siwis-medium fr_FR-tom-medium   # voix naturelles (≈ 125 Mo)
.venv/bin/python app.py                     # http://127.0.0.1:8000
```

### Voix

- **Voix naturelles** : [Piper](https://github.com/OHF-Voice/piper1-gpl) (synthèse neuronale open source, licence GPL-3.0), exécuté sur le serveur : aucun texte ne part vers un service tiers. Voix françaises `fr_FR-siwis-medium` (féminine, par défaut) et `fr_FR-tom-medium` (masculine), dans `voices/` (non versionné). Vérifier la licence de chaque voix sur sa fiche avant une mise en production.
- Sans Piper ou sans les modèles, le site utilise la voix du navigateur (en choisissant sa voix la plus naturelle).
- Fenêtre « Réglages de la voix » : vitesse (très lente à rapide), lecture des questions à voix haute, écoute automatique (activée par défaut : le micro s'ouvre après chaque question et se ferme après 4 secondes de silence ; désactivé : « Parler » pour commencer, « J'ai fini de parler » pour terminer). La voix (féminine) et le silence avant la fin de l'écoute (4 secondes) sont fixes.
- Les sigles sont lus en toutes lettres puis épelés, grâce au glossaire `acronyms` de `static/form-b.json`. Un sigle dit par l'usager (« le RSA », « l'ARE ») coche l'option correspondante ; les sigles absents d'un libellé s'ajoutent aux `synonyms` de l'option.

### Choisir l'IA

La configuration se fait dans le fichier `.env` à la racine (jamais versionné, il contient la clé) : copiez `.env.example` en `.env`, puis renseignez votre clé. Vous pouvez aussi définir ces valeurs comme variables d'environnement, qui l'emportent sur le fichier. Sans clé, le site fonctionne en mode simplifié sans IA.

- **Tout fournisseur compatible API OpenAI** (chat completions) :
  ```
  LLM_PROVIDER=openai
  OPENAI_API_KEY=...
  OPENAI_MODEL=albert-large        # liste : .venv/bin/python llm.py models
  ```
  Par défaut, `OPENAI_BASE_URL` pointe vers **Albert API** (IA de l'État, hébergée en France : `https://albert.api.etalab.gouv.fr/v1`, clé à demander à Etalab). Pour utiliser une autre passerelle (par exemple une instance **LiteLLM**), changer `OPENAI_BASE_URL`, `OPENAI_API_KEY` et `OPENAI_MODEL` : aucun autre réglage ni changement de code n'est nécessaire. La réponse est contrainte par schéma JSON ; si le modèle ne l'accepte pas, le serveur bascule sur le mode « objet JSON ».
- **Claude** (Anthropic) : `LLM_PROVIDER=anthropic` et `ANTHROPIC_API_KEY=sk-ant-...`.

Les variables d'environnement définies au lancement l'emportent sur le fichier `.env`.

Utilisez Chrome, Edge ou Safari pour la reconnaissance vocale (Firefox : saisie écrite seulement).
Le micro exige `localhost` ou HTTPS.

Variables facultatives : `MDPH_CLAUDE_MODEL` (défaut `claude-opus-5`), `MDPH_CLAUDE_EFFORT` (défaut `low`, pour la réactivité), `PORT`.

## Faire tester à distance

```bash
./tester-a-distance.sh
```

Le script lance le serveur (s'il ne tourne pas déjà) et ouvre un tunnel Cloudflare : il affiche l'adresse en HTTPS (`https://….trycloudflare.com`) à envoyer aux testeurs. Laisser la fenêtre ouverte pendant les tests ; `Ctrl+C` ferme l'accès. Le Mac ne se met pas en veille tant que le tunnel est ouvert.

- La clé de l'IA reste dans `.env`, sur cet ordinateur : le navigateur des testeurs ne la reçoit jamais.
- Par défaut, l'accès est libre : **toute personne qui a le lien** peut utiliser le site, et donc le quota de l'IA configurée. Ne transmettre le lien qu'aux testeurs et fermer le tunnel après chaque session. Pour demander un identifiant et un mot de passe : remplir `ACCES_IDENTIFIANT` et `ACCES_MOT_DE_PASSE` dans `.env`, puis relancer le serveur.
- L'adresse change à chaque lancement du tunnel.
- Le trafic passe par Cloudflare : faire tester avec des **données fictives** (pas de vraies données de santé hors d'un hébergement conforme HDS).
- Prévu pour quelques testeurs à la fois (serveur de développement, voix synthétisée une phrase à la fois). Pour une campagne plus large, héberger le service (Scalingo, Clever Cloud…).
- `outils/cloudflared` est téléchargé depuis https://github.com/cloudflare/cloudflared/releases (non versionné).

## Fonctionnement

- `static/form-b.json` décrit la partie B : questions, options, versions simplifiées (`simple`), conditions d'affichage (`when`), étapes du parcours (`steps`, qui regroupent les sections) et intitulés courts du menu (`short`). **C'est le seul fichier à modifier pour faire évoluer le questionnaire.**
- L'écran des questions est découpé en étapes (indicateur d'étapes DSFR). À gauche, le menu latéral liste les étapes et leurs questions avec leur statut ; à droite, seule la question en cours est affichée. On y répond en cochant, en écrivant dans son champ ou en parlant (la voix coche et remplit la question).
- Le navigateur lit la question (synthèse vocale) puis écoute la réponse (Web Speech API).
- La phrase est envoyée à `/api/interpret`. Le modèle (fournisseur compatible OpenAI, Albert par défaut, ou Claude) renvoie un JSON structuré (sortie contrainte par schéma) : valeurs à cocher ou à remplir, intention (répondre, demander de l'aide, passer, revenir…) et message à lire.
- « Je ne comprends pas » : l'IA reformule la question en langage simple. Sans IA, la version simplifiée écrite dans le schéma (`simple`) est utilisée.
- Champs libres : Claude pose au maximum 3 relances, rédige un texte à la première personne, le relit et attend la validation.
- Si l'API ne répond pas, `static/js/local-nlu.js` prend le relais (mots-clés, oui/non, dates, nombres).
- À la fin, « Imprimer le Cerfa rempli » et « Enregistrer le Cerfa rempli (PDF) » produisent les pages 5 à 8 du Cerfa officiel, remplies avec les réponses (`/api/cerfa-partie-b.pdf`). Les champs restent modifiables dans un lecteur PDF. Rien n'est conservé sur le serveur. Une nouvelle question du formulaire doit être ajoutée à la correspondance de `pdf_cerfa.py` pour apparaître dans le PDF.
- Commandes rapides reconnues localement : « répète », « question précédente », « passer », « pause ».

## Structure

```
app.py               serveur Flask, en-têtes de sécurité, API
llm.py               prompt, schéma de réponse, appel au fournisseur compatible OpenAI (Albert par défaut) ou à Claude
tts.py               voix naturelles (Piper) : /api/tts
pdf_cerfa.py         remplissage de la partie B du Cerfa (correspondance questions → champs du PDF)
pdf/cerfa_15692-01.pdf  Cerfa 15692*01 officiel à champs remplissables (non servi tel quel)
.env                 configuration locale et clé API (non versionné)
static/form-b.json   définition de la partie B
static/js/main.js    déroulé de la conversation
static/js/form.js    rendu DSFR du formulaire, conditions
static/js/voice.js   synthèse et reconnaissance vocales
static/js/local-nlu.js  mode de secours sans IA
Dockerfile           image de déploiement (gunicorn, voix Piper incluses)
.kontinuous/         déploiement sur la fabrique (kontinuous), environnement dev
.github/workflows/   déploiement à chaque push, nettoyage des branches supprimées
sceller-secrets-dev.sh  chiffre les secrets de dev (SealedSecret) depuis .env
tests/               test de la sonde /healthz (pytest) : .venv/bin/pip install pytest && .venv/bin/pytest tests
static/vendor/dsfr   DSFR 1.15.3 hébergé localement
docs/                spécifications fonctionnelles et notice technique (PDF)
docs/generateur/     production du PDF : captures.py, cerfa.py, build.py, print.py (voir LISEZMOI.md)
.claude/skills/dsfr-rgaa/  règles de développement : DSFR sans surcouche, RGAA, autocritique du design
```

## Déployer en développement (fabrique)

Seul environnement en ligne : le cluster **OVH dev** de la fabrique (Rancher `rancher.fabrique.social.gouv.fr`), déployé par [kontinuous](https://github.com/SocialGouv/kontinuous) à chaque `push`. Chaque branche a son environnement (supprimé avec la branche ou à la fermeture de la PR) ; celui de `main` sert d'environnement de développement. Pas de préproduction ni de production.

- `Dockerfile` : gunicorn (1 processus, 8 fils ; `WEB_CONCURRENCY` pour en changer), voix Piper téléchargées à la construction, utilisateur non root, système de fichiers en lecture seule (sauf `/tmp`). Construite dans le cluster (`jobs.build-app`).
- `.kontinuous/values.yaml` : composant `app`, sonde `/healthz` (seule adresse sans mot de passe), délais d'ingress de 180 s pour les appels à l'IA.
- `.kontinuous/env/dev/templates/app.configmap.yaml` : fournisseur et modèle d'IA.
- `.kontinuous/env/dev/templates/app.sealed-secret.yaml` : `OPENAI_API_KEY`, `ACCES_IDENTIFIANT`, `ACCES_MOT_DE_PASSE`, chiffrés pour le cluster. Pour les changer : les mettre dans `.env`, puis `./sceller-secrets-dev.sh` (kubectl avec le contexte `ovh-dev`, `brew install kubeseal`) et versionner le fichier produit. Les valeurs ne sont jamais affichées.
- Prérequis côté fabrique (équipe SRE) : projet Rancher, espace `ci-stt-form-filler`, environnement GitHub `review-auto` avec le secret `KUBECONFIG` et les variables `KS_PROJECT_NAME` / `KS_CI_NAMESPACE`.
- Suivi : `kubectl --context ovh-dev get pods,ingress -n <espace de la branche>` (le contexte par défaut de `~/.kube/config` peut être la production : toujours préciser `--context`).

Comme pour le tunnel : **données fictives uniquement**, le cluster n'est pas hébergé HDS. L'accès est protégé par identifiant et mot de passe.

## Avant une mise en production

- **Audit RGAA** par un auditeur, puis mise à jour de `static/accessibilite.html` (statut, organisme, contact).
- **Données de santé** : les phrases partent vers l'API d'IA choisie (un fournisseur compatible OpenAI comme Albert, ou Claude) et, pour la reconnaissance vocale, vers les serveurs de Google (Chrome) ou d'Apple (Safari). Il faut une analyse d'impact (AIPD), une information claire des usagers, et vérifier les exigences d'hébergement de données de santé (HDS). Une reconnaissance vocale hébergée côté serveur (par exemple Whisper) supprimerait la dépendance au navigateur.
- **Marque de l'État** : le DSFR et le bloc « République française » sont réservés aux sites de l'administration. Un site privé doit retirer le bloc-marque.
- Tests avec des usagers (lecteur d'écran, troubles de la parole, déficience intellectuelle).
