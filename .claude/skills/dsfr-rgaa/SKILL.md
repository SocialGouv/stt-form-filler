---
name: dsfr-rgaa
description: Règles obligatoires pour tout développement du projet mdph-vocal - interface 100 % conforme au DSFR (Système de design de l'État) sans réécriture ni surcouche, 100 % conforme au RGAA 4.1 (accessibilité), et autocritique du design avant chaque réponse. À charger avant toute modification de HTML, CSS ou JavaScript dans static/, toute nouvelle page, tout nouveau composant, message, fenêtre, formulaire ou interaction, et avant toute revue ou correction d'interface.
---

# DSFR et RGAA : règles du projet

Trois exigences non négociables pour toute l'interface (`static/`) :

1. **DSFR à 100 %, tel quel** : uniquement les composants, la grille, les utilitaires, les icônes et l'API JavaScript du DSFR, sans réécriture ni surcouche.
2. **RGAA 4.1 à 100 %** : chaque développement respecte les 106 critères applicables.
3. **Autocritique du design avant de répondre** : ne jamais rendre une proposition d'interface sans l'avoir regardée et critiquée (section 4).

Référence : https://www.systeme-de-design.gouv.fr/version-courante/fr/premiers-pas/vous-etes-developpeur
Version utilisée : **DSFR 1.15.3**, dans `static/vendor/dsfr/`. Le balisage doit correspondre à la documentation de **cette** version.

## 0. Lire la documentation officielle avant d'écrire du code

Le site systeme-de-design.gouv.fr bloque les robots (Cloudflare, erreur 403) : ne pas essayer de le lire. Pour chaque composant touché, lire sa documentation DSFR 1.15.3 dans le dépôt officiel SocialGouv/dsfr-mcp, avant d'écrire du code :

- Si le serveur MCP `dsfr` est disponible, utiliser ses outils : `get_component_code`, `get_component_doc`, `get_component_accessibility`, `search_components`, `search_icons`, `get_color_tokens`.
- Sinon, lire les fichiers bruts avec `curl -sS <url>` :
  - code, API JavaScript et événements : `https://raw.githubusercontent.com/SocialGouv/dsfr-mcp/main/docs/component/<composant>/code.md` (par exemple `modal`, `toggle`, `select`, `button`) ;
  - accessibilité (clavier, lecteur d'écran, critères RGAA) : `…/docs/component/<composant>/accessibility.md` ;
  - fondamentaux (`grid`, `spacing`, `color`, `icon`, `typography`…) : `…/docs/core/<nom>/overview.md` ;
  - modèles de formulaires (`forms`, `date`, `email`, `name`, `tel`…) : `…/docs/layout/pattern/<nom>/overview.md` ;
  - liste complète : `…/docs/index.json`.
- Vérifier dans `…/docs/meta.json` que la documentation est bien celle de la version 1.15.3.

La documentation ne suffit pas : toujours tester le comportement réel, car il peut s'en écarter. Exemple : d'après la documentation, la modale rend le focus à la fermeture, mais `dsfr(modal).modal.conceal()` ne le fait pas. Il faut appeler ensuite `dsfr(bouton).modalButton.focus()`.

## 1. DSFR sans réécriture ni surcouche

### Interdit

- Modifier les fichiers de `static/vendor/dsfr/`.
- Redéfinir ou surcharger une classe `fr-*` dans `static/css/app.css` ou ailleurs, utiliser `!important` sur un composant DSFR, ou cibler sa structure interne (`.fr-modal__body > div`…).
- Mettre des attributs `style=""`, des couleurs, polices, tailles, marges ou ombres en dur. On utilise les classes utilitaires (`fr-mt-2w`, `fr-text--sm`, `fr-hidden`…) et les variables de couleur du DSFR.
- Créer un composant maison (bouton, fenêtre, onglets, accordéon, alerte, interrupteur, liste déroulante, fil d'Ariane, notice…) quand le DSFR en propose un.
- Réécrire en JavaScript le comportement d'un composant DSFR (ouverture, fermeture, focus, états). On passe par l'API `dsfr(element).<composant>` (par exemple `dsfr(modal).modal.disclose()` / `.conceal()`) et ses événements (`dsfr.disclose`, `dsfr.conceal`…).
- Ajouter une autre bibliothèque d'interface (Bootstrap, Tailwind, jeu d'icônes externe, police externe).
- Utiliser une icône qui n'est pas une classe `fr-icon-*` du DSFR.

### Obligatoire

- Reprendre le balisage **exact** de l'exemple officiel du composant : classes, attributs ARIA, `aria-controls`, `data-fr-*`, ordre des éléments et fermeture correcte des balises.
- Charger les scripts comme le DSFR le prévoit (`dsfr.module.min.js` en `type="module"` et `dsfr.nomodule.min.js` en `nomodule`, en fin de `body`). Garder `data-fr-scheme` sur `<html>` et la fenêtre « Paramètres d'affichage ».
- Mettre en page avec la grille (`fr-container`, `fr-grid-row`, `fr-col-*`) et les espacements avec les utilitaires (`fr-m*-Nw`, `fr-p*-Nw`).
- Composer les formulaires avec `fr-input-group`, `fr-select-group`, `fr-fieldset`, `fr-toggle`, `fr-radio-group`, `fr-checkbox-group` et les messages `fr-messages-group` / `fr-message--error`, avec leurs états `--error` / `--valid`.

### Quand le DSFR n'a pas d'équivalent

`static/css/app.css` ne contient que deux règles, chacune justifiée « faute d'équivalent dans le système de design ». Avant d'en ajouter une autre, ou d'ajouter un comportement JavaScript qui touche un composant DSFR :

1. Chercher la solution DSFR la plus proche (composant, variante, utilitaire, API).
2. Si elle n'existe pas, **s'arrêter et demander à l'utilisateur**, en présentant le besoin, l'option DSFR la plus proche et l'écart minimal proposé.
3. Une fois l'écart accepté, il cible une classe propre au projet (jamais une classe `fr-*`) et il est documenté en commentaire avec sa justification.

### Quand le DSFR contredit le RGAA

Le RGAA l'emporte. On n'écrase pas le DSFR : on ajoute le correctif le plus petit possible, en passant par l'API DSFR. On l'explique en commentaire et on le signale à l'utilisateur.

Exemple dans le projet : le DSFR ignore la touche Échap quand le focus est sur un champ d'une fenêtre (piège au clavier, critère 12.9). Dans `static/js/main.js`, un gestionnaire d'Échap ferme la fenêtre avec `dsfr(modal).modal.conceal()`, puis remet le focus sur le bouton qui l'a ouverte avec `dsfr(bouton).modalButton.focus()`.

## 2. RGAA 4.1 à 100 %

Chaque modification est vérifiée sur les 13 thématiques. Points de contrôle prioritaires pour ce projet :

- **Structure (thèmes 8 et 9)** : `lang="fr"` sur `<html>` et `lang` sur tout passage dans une autre langue ; un `<title>` propre à chaque page ou étape ; une hiérarchie de titres sans saut (un seul `h1` par vue, y compris dans les fenêtres) ; les repères `header` / `main` / `footer` / `nav` ; des liens d'évitement `fr-skiplinks` ; du HTML valide (pas de balise mal fermée ni d'`id` en double).
- **Formulaires (thème 11)** : chaque champ a un `<label for>` visible ; les groupes ont un `fieldset` + `legend` ; les aides et erreurs sont reliées par `aria-describedby` ; une erreur indique comment corriger ; `autocomplete` est renseigné sur les champs concernant l'usager (critère 11.13) ; les champs obligatoires sont signalés.
- **Clavier et focus (thèmes 7 et 12)** : tout fonctionne au clavier, sans piège ; l'ordre de tabulation est logique ; le focus reste visible (ne jamais retirer l'`outline` du DSFR) ; dans une fenêtre, le focus entre à l'ouverture, Échap ferme toujours et le focus revient au déclencheur ; quand le contenu change (question suivante, erreur), le focus est déplacé de façon prévisible.
- **Messages dynamiques (critère 7.5)** : l'état du micro, l'écoute, la réflexion de l'assistant, les erreurs et les confirmations sont annoncés par une zone `aria-live` (`polite`, ou `assertive` pour les erreurs), sans doublon avec la voix de synthèse.
- **Couleurs et contrastes (thème 3)** : uniquement les couleurs du DSFR ; aucune information transmise par la seule couleur ; vérifier en thème clair **et** sombre.
- **Présentation (thème 10)** : le contenu reste lisible et utilisable avec le texte agrandi à 200 % et à 320 px de large sans défilement horizontal ; le texte reste lisible avec un espacement modifié (10.12) ; un contenu affiché au survol ou au focus peut être fermé et reste en place (10.13) ; les mouvements respectent `prefers-reduced-motion`.
- **Images, icônes et liens (thèmes 1 et 6)** : une icône décorative a `aria-hidden="true"` ; un bouton qui n'a qu'une icône a un intitulé (texte masqué ou `title` + `aria-label` cohérents) ; un lien a un intitulé explicite ; un lien qui ouvre une nouvelle fenêtre le signale (`title` « … - nouvelle fenêtre »).
- **Multimédia et voix (thème 4)** : la voix n'est jamais le seul moyen. Tout ce qui est lu à voix haute est aussi affiché en texte, et toute réponse orale peut être saisie au clavier. La lecture vocale peut être arrêtée et ne gêne pas les lecteurs d'écran (réglage « Lire les questions à voix haute »).
- **Consultation (thème 13)** : pas de limite de temps sans possibilité de la prolonger ; pas de changement de contexte imprévu.
- **Déclaration d'accessibilité** : mettre `static/accessibilite.html` à jour si une modification change l'état de conformité ou ajoute une dérogation.

## 3. Vérifier avant d'annoncer que c'est terminé

1. Relire le balisage modifié et le comparer à l'exemple DSFR du composant : classes, ARIA, structure, balises bien fermées.
2. Vérifier que `static/css/app.css` n'a reçu aucune règle non validée et qu'aucun fichier de `vendor/` n'a changé.
3. Tester dans un vrai navigateur (Playwright avec le Chrome installé, serveur `.venv/bin/python app.py` sur le port 8000) :
   - parcours au clavier seul (Tab, Maj+Tab, Entrée, Espace, Échap) sur la zone modifiée ;
   - affichage à 320 px de large et avec un zoom de 200 % ;
   - analyse automatique axe-core (injecté depuis cdnjs ou jsdelivr) sur la page, sans aucune violation ;
   - thèmes clair et sombre.
4. Dans le compte rendu, dire ce qui a été vérifié et comment, et ce qui demande encore une vérification manuelle (restitution par un lecteur d'écran comme NVDA ou VoiceOver, pertinence des textes). Ne jamais affirmer « conforme RGAA » sur la seule base des tests automatiques.

## 4. Autocritique du design avant de rendre la réponse

Le public du site (personnes handicapées, aidants, personnes peu à l'aise avec l'écrit ou le numérique) ne pardonne pas un écran confus. Avant d'annoncer une modification d'interface :

1. **Regarder le résultat** : captures réelles (Playwright) à 1280 px, 390 px et 320 px, en thème clair et sombre, dans l'état vide, rempli, en erreur et avec la voix active si c'est pertinent. Ne jamais juger sur le code seul.
2. **Passer la grille de critique** et noter honnêtement chaque défaut :
   - **Un seul endroit où regarder** : l'œil sait-il immédiatement où agir ? Une seule action principale par écran ?
   - **Charge** : combien de champs, de boutons, de blocs visibles d'un coup ? Peut-on en montrer moins (afficher au fur et à mesure, n'ouvrir que le nécessaire) ?
   - **Hauteur et défilement** : combien d'écrans de haut sur mobile ? Aucun défilement horizontal de la page.
   - **Hiérarchie et lisibilité** : titres, regroupements, alignements, espacements réguliers ; libellés compréhensibles sans jargon ni sigle ; exemples quand une saisie est ambiguë.
   - **Cohérence** : mêmes composants et mêmes mots pour les mêmes choses, dans tout le parcours.
   - **Retour à l'usager** : après chaque action, voit-il (et entend-il) ce qui s'est passé ?
   - **Mobile d'abord** : la version 320 px est-elle aussi claire que la version ordinateur, et pas seulement « qui tient » ?
   - **Défauts visuels** : éléments qui se chevauchent, décalés, collés, conteneurs imbriqués (fond dans un fond dans un fond), éléments qui sautent quand l'état change.
3. **Corriger** ce qui peut l'être dans le cadre DSFR + RGAA, puis reprendre les captures. Comparer au moins une alternative quand le choix n'est pas évident.
4. **Dans la réponse** : une courte autocritique (ce qui est bien, ce qui reste perfectible et pourquoi), les compromis faits, et les choix qui reviennent à l'utilisatrice. Ne pas présenter comme abouti un écran dont on connaît les défauts.

