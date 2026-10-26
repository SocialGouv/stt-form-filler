"""Construit le document HTML (spécifications + notice technique), mis en page avec le DSFR."""
import html
import json
import sys
from pathlib import Path

PROJET = Path("/Users/mathilda/mdph-vocal")
DOC = Path(sys.argv[1])
DSFR = PROJET / "static/vendor/dsfr"
FORM = json.loads((PROJET / "static/form-b.json").read_text(encoding="utf-8"))
QUESTIONS = FORM["questions"]
BY_ID = {q["id"]: q for q in QUESTIONS}
SECTIONS = {s["id"]: s["title"] for s in FORM["sections"]}
STEPS = FORM["steps"]
STEP_OF = {sec: st["title"] for st in STEPS for sec in st["sections"]}

TYPES = {
    "single": "Choix unique", "multi": "Choix multiple", "yesno": "Oui / non", "date": "Date",
    "number": "Nombre", "text": "Texte court", "longtext": "Texte rédigé avec l'assistant", "table": "Liste (frais, établissements)",
}


def e(s):
    return html.escape(str(s))


def option_label(qid, oid):
    q = BY_ID.get(qid, {})
    for o in q.get("options", []):
        if o["id"] == oid:
            return o["label"]
    return {"oui": "Oui", "non": "Non", "moi": "Pour moi-même", "enfant": "Pour mon enfant"}.get(oid, oid)


def condition(c):
    if not c:
        return "Toujours posée"
    if "anyOf" in c:
        return " ou ".join(condition(x) for x in c["anyOf"])
    q = BY_ID[c["q"]]["label"]
    if "eq" in c:
        return f"Si « {option_label(c['q'], c['eq'])} » à « {q} »"
    if "ne" in c:
        return f"Sauf si « {option_label(c['q'], c['ne'])} » à « {q} »"
    if "includes" in c:
        return f"Si « {option_label(c['q'], c['includes'])} » coché à « {q} »"
    if "in" in c:
        return f"Si « {' » ou « '.join(option_label(c['q'], x) for x in c['in'])} » à « {q} »"
    if c.get("nonEmpty"):
        return f"Si une réponse à « {q} »"
    return ""


def parent_of(q):
    """Question à choix dont q est le champ de précision (affiché sous l'option), sinon None."""
    w = q.get("when") or {}
    p = BY_ID.get(w.get("q"))
    if p and q["type"] in ("text", "longtext") and p["type"] in ("single", "multi", "yesno") and ("includes" in w or "eq" in w):
        return p
    return None


def annexe_questions():
    rows, n, current = [], 0, None
    for q in QUESTIONS:
        n += 1
        step = STEP_OF[q["section"]]
        if step != current:
            current = step
            rows.append(f'<tr class="ligne-section"><td colspan="4">Étape « {e(current)} »</td></tr>')
        details = []
        if q.get("short") and not parent_of(q):
            details.append(f"Dans le menu : « {e(q['short'])} »")
        if parent_of(q):
            details.append(f"Champ de précision, affiché dans la question « {e(parent_of(q)['short'])} »")
        if q.get("optional"):
            details.append("Optionnelle")
        if q.get("options"):
            details.append("Réponses : " + " ; ".join(e(o["label"]) for o in q["options"]))
        if q.get("columns"):
            details.append(f"Jusqu'à {q.get('maxRows', 3)} éléments ; champs : " + " ; ".join(
                e(c["label"]) + (" (en €)" if c.get("kind") == "money" else "") + (" (optionnel)" if c.get("optional") else "") for c in q["columns"]))
        if q.get("allowNone"):
            details.append("« Je ne suis pas concerné(e) » possible")
        if q.get("beforeToday"):
            details.append("Date obligatoirement passée")
        if q.get("unit"):
            details.append(f"Unité : {e(q['unit'])}")
        rows.append(
            f"<tr><td>{n}</td><td><strong>{e(q['label'])}</strong>"
            + (f'<br><span class="petit">{"<br>".join(details)}</span>' if details else "")
            + f"</td><td>{TYPES[q['type']]}</td><td class=\"petit\">{e(condition(q.get('when')))}</td></tr>"
        )
    return "\n".join(rows)


def figure(img, legende, largeur="100%"):
    return (f'<figure class="figure"><img src="img/{img}" style="width:{largeur}" alt="{e(legende)}">'
            f'<figcaption>{legende}</figcaption></figure>')


def table(entetes, lignes, classe=""):
    head = "".join(f"<th>{h}</th>" for h in entetes)
    body = "".join("<tr>" + "".join(f"<td>{c}</td>" for c in l) + "</tr>" for l in lignes)
    return f'<table class="tableau {classe}"><thead><tr>{head}</tr></thead><tbody>{body}</tbody></table>'


nb_questions = len(QUESTIONS)
nb_cond = sum(1 for q in QUESTIONS if "when" in q)
nb_options = sum(len(q.get("options", [])) for q in QUESTIONS)
nb_syn = sum(1 for q in QUESTIONS for o in q.get("options", []) if o.get("synonyms"))
nb_sigles = len(FORM["acronyms"])
nb_prec = sum(1 for q in QUESTIONS if parent_of(q))
nb_opt = sum(1 for q in QUESTIONS if q.get("optional"))
documents = "".join(f"<li>{e(d)}</li>" for d in FORM["documents"])

css = """
@page { size: A4; margin: 20mm 16mm 18mm 16mm; }
html { font-size: 14px; }
body { background: #fff; color: var(--text-default-grey); }
.document { max-width: none; }
.saut { break-before: page; }
.garder { break-inside: avoid; }
h1, h2, h3, h4 { break-after: avoid; }
h2.partie { color: var(--text-title-blue-france); border-bottom: 3px solid var(--border-plain-blue-france); padding-bottom: .5rem; margin-top: 0; }
h3 { color: var(--text-title-blue-france); margin-top: 1.75rem; }
h4 { margin-top: 1.25rem; }
p, li { text-align: left; }
.petit { font-size: .82rem; line-height: 1.25rem; color: var(--text-mention-grey); }
/* Couverture */
.couverture { height: 255mm; display: flex; flex-direction: column; justify-content: space-between; }
.couverture .bandeau { border-top: 8px solid var(--border-plain-blue-france); padding-top: 2rem; }
.couverture h1 { font-size: 2.6rem; line-height: 3.1rem; color: var(--text-title-blue-france); margin: 3rem 0 1rem; }
.couverture .sous-titre { font-size: 1.35rem; line-height: 2rem; }
.couverture .meta { border-left: 4px solid var(--border-plain-red-marianne); padding-left: 1rem; }
.tricolore { display: flex; height: 6px; margin-top: 1.5rem; }
.tricolore span { flex: 1; } .tricolore span:nth-child(1) { background: #000091; } .tricolore span:nth-child(2) { background: #fff; } .tricolore span:nth-child(3) { background: #e1000f; }
/* Sommaire */
.sommaire ol { list-style: none; padding-left: 0; --ol-type: none; --ol-content: none; } .sommaire ol ol { padding-left: 1.5rem; } .sommaire li::marker, .sommaire li::before { content: none; }
.sommaire li { margin: .25rem 0; } .sommaire a { text-decoration: none; background: none; color: inherit; }
/* Tableaux */
table.tableau { width: 100%; border-collapse: collapse; margin: .75rem 0 1.25rem; font-size: .9rem; line-height: 1.35rem; }
table.tableau th { background: var(--background-contrast-blue-france); color: var(--text-title-blue-france); text-align: left; padding: .45rem .6rem; border-bottom: 2px solid var(--border-plain-blue-france); }
table.tableau td { padding: .45rem .6rem; border-bottom: 1px solid var(--border-default-grey); vertical-align: top; }
table.tableau tr { break-inside: avoid; }
table.tableau tr.ligne-section td { background: var(--background-alt-grey); font-weight: 700; color: var(--text-title-blue-france); }
table.tableau td:first-child { white-space: nowrap; }
table.annexe td:first-child { width: 2rem; }
/* Figures */
.figure { margin: 1rem 0 1.5rem; break-inside: avoid; text-align: center; }
.figure img { border: 1px solid var(--border-default-grey); max-height: 125mm; object-fit: contain; }
.figure figcaption { font-size: .82rem; color: var(--text-mention-grey); margin-top: .4rem; text-align: center; }
.cote-a-cote { display: flex; gap: 1rem; align-items: flex-start; break-inside: avoid; }
.cote-a-cote .figure { flex: 1; }
/* Encadrés */
.fr-callout { break-inside: avoid; margin: 1rem 0; }
.fr-highlight { margin: 1rem 0; }
code { font-size: .85em; background: var(--background-alt-grey); padding: 0 .25rem; }
pre { font-size: .8rem; line-height: 1.2rem; background: var(--background-alt-grey); padding: .75rem; white-space: pre-wrap; break-inside: avoid; }
/* Schéma d'architecture */
.schema { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: .75rem; align-items: stretch; margin: 1rem 0 1.5rem; break-inside: avoid; }
.schema .boite { border: 2px solid var(--border-plain-blue-france); padding: .75rem; font-size: .85rem; line-height: 1.25rem; }
.schema .boite h4 { margin: 0 0 .4rem; font-size: 1rem; color: var(--text-title-blue-france); }
.schema .boite ul { margin: 0; padding-left: 1rem; }
.schema .ext { border-style: dashed; }
.fleches { font-size: .8rem; text-align: center; color: var(--text-mention-grey); grid-column: 1 / -1; }
"""

sommaire = """
<nav class="sommaire saut" aria-label="Sommaire">
<h2 class="partie">Sommaire</h2>
<ol>
 <li><strong>Partie 1 — Spécifications fonctionnelles</strong>
  <ol>
   <li>1.1 Contexte, objectifs et publics</li><li>1.2 Parcours de l'usager</li><li>1.3 Écran d'accueil</li>
   <li>1.4 Écran « Répondre aux questions »</li><li>1.5 Dialogue vocal : lecture, écoute, compréhension</li>
   <li>1.6 Commandes vocales et navigation</li><li>1.7 Contenu du questionnaire</li><li>1.8 Écran de fin et formulaire Cerfa rempli</li>
   <li>1.9 Données personnelles et confidentialité</li><li>1.10 Accessibilité et design system</li><li>1.11 Limites connues et hors périmètre</li>
  </ol></li>
 <li><strong>Partie 2 — Notice technique</strong>
  <ol>
   <li>2.1 Architecture</li><li>2.2 Organisation du code</li><li>2.3 API du serveur</li><li>2.4 Choix techniques et bibliothèques</li>
   <li>2.5 Compréhension des réponses (IA)</li><li>2.6 Formulaire déclaratif (form-b.json)</li><li>2.7 Voix et écoute</li>
   <li>2.8 Génération du PDF Cerfa</li><li>2.9 Sécurité</li><li>2.10 Installation, configuration, tests à distance</li>
   <li>2.11 Vérifications réalisées</li><li>2.12 Pistes pour une mise en production</li>
  </ol></li>
 <li><strong>Annexe — Liste des questions</strong></li>
</ol>
</nav>
"""

partie1 = f"""
<section class="saut">
<h2 class="partie">Partie 1 — Spécifications fonctionnelles</h2>

<h3>1.1 Contexte, objectifs et publics</h3>
<p>Pour demander une aide ou une prestation à la Maison départementale des personnes handicapées (MDPH), il faut remplir le formulaire Cerfa n° 15692*01. Sa <strong>partie B « Votre vie quotidienne »</strong> (pages 5 à 8) décrit la situation de la personne : logement, ressources, aides déjà en place, frais, besoins dans la vie quotidienne et attentes. Elle est longue, utilise un vocabulaire administratif et de nombreux sigles, et se remplit difficilement pour beaucoup de personnes en situation de handicap.</p>
<p><strong>« Formulaire MDPH - Partie B »</strong> permet de remplir cette partie <strong>à la voix ou au clavier</strong> : les questions sont lues à voix haute, une par une ; l'usager répond avec ses mots, en cochant ou en écrivant directement dans la question, et chaque réponse comprise est cochée ou écrite sous ses yeux. À la fin, il imprime ou enregistre le Cerfa officiel, rempli.</p>
<div class="fr-callout"><h4 class="fr-callout__title">Publics visés</h4>
<ul class="fr-callout__text fr-text--md">
<li>Personnes en situation de handicap moteur, visuel ou cognitif, pour qui écrire ou lire un long formulaire est difficile.</li>
<li>Personnes peu à l'aise avec l'écrit ou le vocabulaire administratif (chaque question a une version en langage simple).</li>
<li>Proches aidants et parents qui remplissent la demande pour une autre personne.</li>
</ul></div>
<h4>Principes directeurs</h4>
<ul>
<li><strong>Parler naturellement :</strong> l'usager n'a pas à connaître les termes du formulaire ; l'intelligence artificielle interprète le sens (« je travaille dans un atelier protégé » → ESAT).</li>
<li><strong>Un seul endroit où regarder :</strong> une seule question affichée à la fois, avec tout ce qui sert à y répondre ; un menu pour se repérer.</li>
<li><strong>Réassurance :</strong> chaque réponse est visible dans la question, confirmée à voix haute et à l'écran, et cochée dans le menu.</li>
<li><strong>Accessibilité d'abord :</strong> utilisable au clavier, au lecteur d'écran, à la voix seule ou à l'écrit seul ; design system de l'État (DSFR) utilisé tel quel.</li>
<li><strong>Sobriété et confidentialité :</strong> rien n'est conservé sur le serveur ; les réponses restent dans le navigateur.</li>
</ul>

<h3>1.2 Parcours de l'usager</h3>
<p>Le service comporte trois écrans, dans une seule page web :</p>
{table(["Écran", "Titre de la page", "Rôle"], [
 ["1. Accueil", "Formulaire MDPH - Partie B", "Présenter le service (nombre de questions, durée), un seul bouton « Remplir le formulaire », reprendre une saisie en cours."],
 ["2. Questions", "Répondre aux questions", "Cinq étapes ; une question affichée à la fois ; menu latéral des étapes et des questions avec leur statut."],
 ["3. Fin (étape « Vérifier et imprimer »)", "Votre formulaire est prêt (ou « Votre formulaire » s'il reste des questions)", "Imprimer ou enregistrer le Cerfa rempli, répondre aux questions restantes, documents à joindre, effacer les réponses."],
])}
<ul>
<li>À chaque changement d'écran, la page revient en haut et le focus est placé sur le titre de la page. Le titre de l'onglet suit le format DSFR « Titre - Formulaire MDPH - Partie B » ; pendant les questions : « Vos ressources, question 2 sur 4 - Formulaire MDPH - Partie B ».</li>
<li><strong>Retour en arrière :</strong> lien « Retour à l'accueil » en haut de l'écran des questions ; le bouton « Précédent » du navigateur ramène à l'écran d'avant (fin → questions → accueil) au lieu de quitter le site. Revenir à l'accueil arrête la voix et le micro et garde les réponses.</li>
</ul>
</section>

<section>
<h3>1.3 Écran d'accueil</h3>
{figure("01_accueil.png", "Figure 1 — Écran d'accueil (ordinateur)", "80%")}
<ul>
<li><strong>Introduction</strong> sans jargon (« Le formulaire se remplit au fur et à mesure de vos réponses ») ; le mot « assistant » n'y est pas employé.</li>
<li><strong>Repères</strong> sur fond bleu : nombre de questions (calculé à partir du questionnaire, environ 19 pour un parcours type), durée (environ 20 minutes), sans création de compte.</li>
<li><strong>Un seul bouton : « Remplir le formulaire »</strong>, centré. Il démarre à l'oral si le navigateur sait écouter, sinon à l'écrit ; l'usager peut toujours répondre en cochant ou en écrivant.</li>
<li><strong>« Comment ça marche ? »</strong> en trois cartes : Écoutez la question, Répondez avec vos mots, Imprimez le formulaire.</li>
<li><strong>« Vos données »</strong> : les réponses restent sur l'appareil ; les phrases sont envoyées à « un programme informatique qui comprend le langage (une intelligence artificielle) ».</li>
<li><strong>Navigateur sans reconnaissance vocale</strong> (Firefox) : un message invite à répondre en écrivant ou à utiliser Chrome, Edge ou Safari.</li>
</ul>
<div class="cote-a-cote">
{figure("03_reprise.png", "Figure 2 — Reprise d'une saisie en cours")}
{figure("02_reglages.png", "Figure 3 — Fenêtre « Réglages de la voix »")}
</div>
<h4>Reprise d'une saisie</h4>
<p>Si l'usager avait commencé (même onglet), l'accueil propose « Reprendre où j'en étais » (avec le nombre de réponses gardées) ou « Recommencer depuis le début » (efface tout).</p>
<h4>Réglages de la voix</h4>
<p>Le bouton « Réglages de la voix », en haut de chaque écran, ouvre une fenêtre (modale DSFR). Les changements s'appliquent immédiatement et sont mémorisés sur l'appareil. Échap ferme la fenêtre, où que soit le focus.</p>
{table(["Réglage", "Valeurs", "Effet"], [
 ["Vitesse de la voix", "Très lente, Lente, Normale (défaut), Rapide", "Vitesse de lecture ; en lent, pauses plus longues entre les phrases."],
 ["Lire les questions à voix haute", "Activé (défaut) / désactivé", "À désactiver avec un lecteur d'écran : les messages lui sont alors annoncés."],
 ["Écoute automatique", "Activé (défaut) / désactivé", "Activé : le micro s'ouvre après chaque question et se ferme après 4 secondes de silence. Désactivé : « Parler » ouvre le micro, « J'ai fini de parler » le ferme (aucune limite de temps)."],
])}
<p class="petit">Non réglables, par choix de simplicité : la voix (naturelle féminine) et le temps de silence avant la fin de l'écoute (4 secondes).</p>
</section>

<section>
<h3>1.4 Écran « Répondre aux questions »</h3>
{figure("04_questions.png", "Figure 4 — Écran des questions sur ordinateur, après deux réponses et une question passée", "85%")}
<h4>Organisation de l'écran</h4>
<ul>
<li><strong>À gauche, le menu latéral « Vos réponses »</strong> (composant DSFR) : les cinq étapes, puis « Vérifier et imprimer ». L'étape en cours est dépliée sur ses questions (intitulés courts). Statut de chaque question : <strong>coche verte</strong> (réponse enregistrée), <strong>triangle orange</strong> (sans réponse, pour une question déjà passée), rien (à venir) ; la question en cours est marquée d'une barre bleue. Une étape terminée porte une coche, une étape avec des questions sans réponse un triangle. Chaque entrée est cliquable. Sur mobile, le menu se replie derrière « Toutes les questions ».</li>
<li><strong>À droite :</strong> l'indicateur d'étapes (« Étape 2 sur 6 — Vos ressources », étape suivante), la mention « Sauf mention contraire « (optionnel) » dans l'intitulé, toutes les questions sont obligatoires », la ligne de la voix, puis <strong>la question en cours, seule</strong>, sur fond bleu.</li>
<li><strong>La question en cours</strong> contient tout ce qui sert à y répondre : son numéro dans l'étape, son intitulé (avec « (optionnel) » si besoin) et une <strong>infobulle</strong> donnant la version simplifiée, ses réponses (cases à cocher, boutons radio, champs), le grand bouton <strong>« Parler »</strong> et la transcription « Vous avez dit : … ». En dessous : <strong>« Question suivante »</strong> (« Terminer et vérifier » à la dernière), et un rappel des commandes vocales.</li>
<li><strong>Retours à l'usager :</strong> bandeau vert « Réponse enregistrée — question : réponse » après une réponse comprise à l'oral ; message de fin d'étape (« Étape « Votre situation » terminée : 6 réponses enregistrées », ou le nombre de questions restées sans réponse) ; coches du menu ; bandeau orange « Mode simplifié » si l'IA ne répond pas.</li>
</ul>
<div class="cote-a-cote">
{figure("09_ecoute.png", "Figure 5 — Pendant l'écoute")}
{figure("05_infobulle.png", "Figure 6 — Infobulle : la question en langage simple")}
</div>
<h4>La voix et le micro, séparés</h4>
<ul>
<li><strong>Ligne de la voix</strong>, toujours au même endroit, au-dessus de la question : « Lecture en cours… » avec « Mettre en pause », « Lecture en pause » avec « Reprendre », « Lecture terminée » avec « Réécouter la question ». En pause, rien n'avance et le micro ne s'ouvre pas. Masquée si la lecture à voix haute est désactivée.</li>
<li><strong>Micro :</strong> « Parler » coupe la voix et ouvre l'écoute ; pendant l'écoute, le bouton devient « J'ai fini de parler » (style et icône différents) et « Écoute en cours… » s'affiche.</li>
</ul>
<h4>Répondre dans la question</h4>
<div class="cote-a-cote">
{figure("06_precision.png", "Figure 7 — Champ de précision sous « Autre situation »")}
{figure("07_date.png", "Figure 8 — Date en trois champs, avec une erreur")}
</div>
<ul>
<li><strong>Champs de précision</strong> (« Autre : précisez », nom de l'établissement, organisme d'indemnisation…) : affichés <strong>dans la question, sous l'option</strong> qui les fait apparaître. Une précision dite à l'oral s'y écrit sous les yeux de l'usager ; sans précision, la voix la demande sur le même écran.</li>
<li><strong>Dates</strong> : bloc DSFR « Date unique » (Jour, Mois, Année, avec un exemple chacun, clavier chiffré sur mobile). Erreurs affichées sur le groupe : champ manquant nommé (« Indiquez le mois. »), date inexistante, date future quand elle doit être passée.</li>
<li><strong>Frais restant à charge</strong> (et établissements identifiés) : un bloc par frais (« Frais 1 »…), avec « Ce que vous payez », « Fréquence », « Montant payé (en €) », « Montant remboursé (en €) », « Précisions (optionnel) » et des exemples. Un seul bloc au départ, « Ajouter un autre frais » en ouvre un de plus (trois au maximum, comme le Cerfa). Montants à l'euro près. « Je n'ai pas de frais à déclarer » grise et vide le bloc.</li>
<li><strong>Questions optionnelles</strong> : « (optionnel) » dans l'intitulé (règle DSFR) ; elles ne sont pas comptées comme manquantes.</li>
</ul>
<div class="cote-a-cote">
{figure("08_frais.png", "Figure 9 — Frais : un bloc par frais")}
</div>
<div class="cote-a-cote">
{figure("10_mobile_questions.png", "Figure 10 — Questions sur mobile", "70%")}
{figure("11_mobile_menu.png", "Figure 11 — Menu déplié sur mobile", "70%")}
</div>
</section>

<section>
<h3>1.5 Dialogue vocal : lecture, écoute, compréhension</h3>
<h4>Introduction</h4>
<p>Au premier démarrage, une présentation explique le fonctionnement : lecture une par une, réponse avec ses mots ou directement dans la question, bips d'écoute, et les commandes « répète », « reformule », « question suivante », « question précédente », « revenir à la question sur le logement ». La première question est affichée pendant la présentation : l'usager peut déjà y répondre ou passer à la suivante.</p>
<h4>Lecture des questions</h4>
<ul>
<li>La voix lit la question, l'aide éventuelle, puis les <strong>réponses possibles</strong>, séparées par un <strong>« tic » sonore</strong> ; pour les frais, les informations à donner. Une question optionnelle est annoncée comme facultative.</li>
<li><strong>Sigles lus en toutes lettres puis épelés</strong> : « Revenu de solidarité active, erre esse a » ; « en ESAT » → « en établissement et service d'aide par le travail, e esse a té » ({nb_sigles} sigles au glossaire).</li>
<li>Le contenu entre parenthèses est lu ; les ordinaux sont lus en toutes lettres (« 2e catégorie » → « deuxième catégorie ») ; les marques d'écriture inclusive ne sont pas prononcées.</li>
<li>Si une réponse existe déjà : « Votre réponse actuelle est : … Dites « suivante » pour la garder. »</li>
<li>Après chaque réponse comprise : confirmation (« C'est noté : … »), une seconde de silence, puis question suivante. Un changement d'étape est annoncé.</li>
</ul>
<h4>Écoute</h4>
<ul>
<li><strong>Bip montant</strong> à l'ouverture du micro, <strong>bip descendant</strong> à la fermeture.</li>
<li>Écoute automatique : l'écoute s'arrête après <strong>4 secondes de silence</strong> une fois que l'usager a commencé à parler (12 secondes s'il ne dit rien). Sans écoute automatique : aucune limite, l'usager termine avec « J'ai fini de parler ».</li>
<li>L'usager peut terminer plus tôt en appuyant sur « J'ai fini de parler » ou en le disant (ces mots sont retirés de la réponse).</li>
</ul>
<h4>Compréhension des réponses</h4>
<ul>
<li>Les réponses sont interprétées par une <strong>intelligence artificielle (Albert API, service de l'État)</strong>, qui comprend le sens : « ma fille passe tous les jours et une infirmière le matin » → Votre famille + Professionnel de soins à domicile. Les cases correspondantes se cochent dans la question.</li>
<li><strong>Sigles et formes développées</strong> reconnus (« l'ARE » → allocation chômage) ; <strong>synonymes du quotidien</strong> associés aux options ({nb_syn} options en ont : « bus » → transports en commun, « CAT » → ESAT…).</li>
<li><strong>Réponse hors liste</strong> : l'option « Autre » est cochée et la précision s'écrit dans le champ affiché sous l'option.</li>
<li><strong>Réponse ambiguë</strong> : question de précision courte. <strong>« Je ne comprends pas »</strong> : la voix lit une reformulation en langage simple ; l'intitulé affiché reste celui du Cerfa (la version simple est dans l'infobulle).</li>
<li><strong>« Je ne sais pas »</strong> (et équivalents) : « Ce n'est pas grave. On passe à la suite, vous pourrez y revenir plus tard. »</li>
<li><strong>Dates</strong> comprises sous forme libre (« le premier mars 2026 » → 01 / 03 / 2026) ; une date future est refusée quand elle doit être passée. <strong>Montants</strong> arrondis à l'euro (« 45 euros 50 » → 46).</li>
<li><strong>Frais</strong> : plusieurs frais dits en une phrase remplissent plusieurs blocs.</li>
<li><strong>Champ libre « Autres renseignements »</strong> : au plus trois questions de relance, puis un texte à la première personne, relu et validé par l'usager.</li>
<li><strong>Sans IA</strong> (panne ou absence de clé) : compréhension par mots-clés, synonymes et sigles, avec un bandeau « Mode simplifié ».</li>
</ul>
</section>

<section>
<h3>1.6 Commandes vocales et navigation</h3>
<p>Ces commandes fonctionnent à la voix, avec ou sans IA (hésitations en début de phrase tolérées : « euh », « bof »…). Au clic, le menu latéral et « Question suivante » offrent la même navigation.</p>
{table(["L'usager dit (exemples)", "Effet"], [
 ["« répète », « redis », « pardon »", "Relit la question (comme « Réécouter la question »)."],
 ["« reformule », « plus simplement », « je ne comprends pas », « explique »", "Lit la question en langage simple."],
 ["« question suivante », « passer »", "Passe à la question suivante sans répondre."],
 ["« je ne sais pas », « aucune idée », « je ne me souviens plus »", "Rassure et passe à la question suivante."],
 ["« question précédente », « revenir en arrière »", "Revient à la question précédente."],
 ["« revenir à la question sur le logement », « corriger ma réponse sur l'AAH »", "Retrouve la question par son sujet ou par la réponse donnée ; s'il y a plusieurs possibilités, les cite et demande laquelle."],
 ["« pause », « stop »", "Met la conversation en pause."],
 ["« aller au récapitulatif », « terminer le questionnaire »", "Va à l'écran de fin, même s'il reste des questions."],
 ["« j'ai fini de parler », « j'ai terminé »", "Termine l'écoute immédiatement."],
])}
<div class="fr-highlight"><p><strong>Retour automatique.</strong> Après être revenu à la voix corriger une question antérieure, l'usager est ramené là où il en était (« Nous reprenons où vous en étiez »). Quand il choisit lui-même une question dans le menu, il n'y a pas de retour automatique. Le passage à la question suivante n'est jamais automatique au clic : il faut appuyer sur « Question suivante ».</p></div>
</section>

<section>
<h3>1.7 Contenu du questionnaire</h3>
<p>Le questionnaire reprend fidèlement la partie B du Cerfa : <strong>{nb_questions} questions</strong>, dont <strong>{nb_cond} conditionnelles</strong> (posées seulement si elles s'appliquent) et {nb_prec} champs de précision affichés dans leur question ; {nb_opt} questions sont optionnelles. L'usager n'en voit en pratique qu'une vingtaine. Toutes ont une version en langage simple et un intitulé court pour le menu. La liste complète figure en annexe.</p>
{table(["Étape", "Questions", "Contenu"], [
 [e(st["title"]), str(sum(1 for q in QUESTIONS if q['section'] in st["sections"] and not parent_of(q))), d] for st, d in zip(STEPS, [
  "Pour qui le formulaire est rempli (adapte les questions), avec qui la personne vit, lieu de vie, accidents et indemnisation.",
  "Aides perçues (AAH, RSA, chômage, ASS), revenus, pensions, retraite.",
  "Aides techniques, aide humaine, présence auprès d'un enfant, frais restant à charge.",
  "Besoins pour la vie à domicile, les déplacements et la vie sociale.",
  "Attentes, établissements identifiés, autres renseignements.",
 ])
] + [["Vérifier et imprimer", "—", "Écran de fin."]])}
{table(["Type de question", "Nombre", "Saisie"], [
 [TYPES[t], str(sum(1 for q in QUESTIONS if q['type'] == t)), d] for t, d in [
  ("multi", "Cases à cocher, option « Je ne suis pas concerné(e) » si prévue (exclusive des autres)."),
  ("single", "Boutons radio."), ("yesno", "Oui ou non."), ("date", "Trois champs Jour / Mois / Année (bloc DSFR « Date unique »)."),
  ("number", "Nombre (heures, pourcentages)."), ("text", "Réponse courte, le plus souvent un champ de précision affiché sous une option."),
  ("table", "Un bloc par élément, ajouté à la demande ; montants à l'euro près."), ("longtext", "Texte libre, dicté ou rédigé avec l'IA."),
 ]
])}
</section>

<section>
<h3>1.8 Écran de fin et formulaire Cerfa rempli</h3>
<div class="cote-a-cote">
{figure("12_fin.png", "Figure 12 — Écran de fin, avec des questions sans réponse")}
{figure("16_cerfa.png", "Figure 13 — Page 6 du Cerfa produit (réponses fictives)", "80%")}
</div>
<ul>
<li><strong>Toutes les questions ont une réponse</strong> : titre « Votre formulaire est prêt » et alerte de succès (verte) « Toutes les questions ont une réponse ».</li>
<li><strong>S'il reste des questions</strong> : titre « Votre formulaire » et alerte d'avertissement (orange) « Il reste N questions sans réponse », avec « Répondre aux questions restantes ». Les questions optionnelles ne sont pas comptées ; « Je n'ai pas de frais à déclarer » compte comme une réponse.</li>
<li><strong>« Répondre aux questions restantes »</strong> : retour à la première question sans réponse ; dans le menu, toutes les questions sans réponse portent un triangle orange ; « Question suivante » mène directement à la prochaine question sans réponse.</li>
<li><strong>« Imprimer le formulaire »</strong> : ouvre le PDF dans un nouvel onglet (annoncé aux lecteurs d'écran). <strong>« Enregistrer le formulaire (PDF) »</strong> : télécharge <code>demande-mdph-cerfa-15692-partie-b.pdf</code>.</li>
<li>Le PDF est le <strong>Cerfa officiel</strong>, pages 5 à 8, cases cochées et champs remplis ; les champs restent modifiables dans un lecteur PDF. Nom et prénom ne sont pas demandés (confidentialité) : à compléter à la main.</li>
<li><strong>« Modifier mes réponses »</strong> : retour à l'écran des questions.</li>
<li><strong>Documents à joindre si possible</strong> ({len(FORM['documents'])} éléments, repris du Cerfa).</li>
</ul>
<h4>Effacer toutes les réponses</h4>
<div class="cote-a-cote">
{figure("13_restantes.png", "Figure 14 — Menu en mode « questions restantes »", "80%")}
{figure("14_effacer.png", "Figure 15 — Confirmation de l'effacement")}
</div>
{figure("15_efface.png", "Figure 16 — Après l'effacement", "80%")}
<ul>
<li>Action critique : « Effacer toutes mes réponses » ouvre une <strong>fenêtre de confirmation</strong> (modale DSFR) : « Effacer toutes vos réponses ? Vous ne pourrez pas les récupérer. », « Oui, effacer mes réponses » / « Non, garder mes réponses » (Échap et la croix n'effacent rien).</li>
<li>Après confirmation, la page s'intitule « Vos réponses ont été effacées » et une alerte annonce le retour à l'accueil dans 10 secondes, avec « Revenir à l'accueil maintenant » et « Rester sur cette page » (l'usager garde le contrôle de la limite de temps, critère RGAA 13.1).</li>
</ul>
<div class="fr-callout"><h4 class="fr-callout__title">Documents à joindre (repris du Cerfa)</h4><ul class="fr-callout__text fr-text--sm">{documents}</ul></div>
</section>

<section>
<h3>1.9 Données personnelles et confidentialité</h3>
{table(["Donnée", "Où elle se trouve", "Durée"], [
 ["Réponses, échanges sur la question en cours, question en cours", "Navigateur de l'usager (sessionStorage)", "Effacées à la fermeture de l'onglet (ou par « Effacer toutes mes réponses »)."],
 ["Réglages de la voix", "Navigateur (localStorage)", "Conservés sur l'appareil."],
 ["Phrases de l'usager et question en cours", "Envoyées au service d'IA Albert pour être comprises", "Non conservées par notre serveur."],
 ["Texte lu à voix haute", "Synthétisé sur notre serveur (voix Piper)", "Non conservé."],
 ["Réponses, pour produire le PDF", "Envoyées au serveur au moment de l'impression ou de l'enregistrement", "PDF produit à la demande, non conservé."],
 ["Voix de l'usager (reconnaissance vocale)", "Traitée par le navigateur : chez Google (Chrome) ou Apple (Safari)", "Selon le fournisseur du navigateur."],
])}
<ul>
<li>Aucune base de données, aucun compte, aucun cookie de suivi ; le journal du serveur ne contient que les adresses demandées, pas les réponses.</li>
<li>Le nom et le prénom ne sont pas demandés.</li>
<li>Les réponses envoyées pour retrouver une question (« revenir à la question sur le logement ») transitent aussi par l'IA.</li>
</ul>
<div class="fr-callout"><h4 class="fr-callout__title">Avant une ouverture au public</h4>
<p class="fr-callout__text fr-text--md">S'agissant de données de santé : analyse d'impact (AIPD), information des usagers, hébergement certifié HDS, et étude d'une reconnaissance vocale hébergée côté serveur pour ne plus dépendre de Google ou d'Apple.</p></div>

<h3>1.10 Accessibilité et design system</h3>
<ul>
<li><strong>Design system de l'État (DSFR 1.15.3)</strong> utilisé tel quel : menu latéral, indicateur d'étapes, modales, alertes, infobulle, cartes, interrupteurs, cases, boutons radio, bloc « Date unique », grille, utilitaires et icônes ; API JavaScript officielle. Une seule règle de style s'y ajoute (l'attribut <code>hidden</code> masque toujours).</li>
<li><strong>Clavier et lecteurs d'écran</strong> : tout est utilisable au clavier ; focus visible et déplacé sur le titre de la question quand l'usager navigue ; titres hiérarchisés ; statut de chaque question annoncé dans le menu ; messages annoncés quand la voix est coupée ; tout ce qui est lu à voix haute est aussi affiché.</li>
<li><strong>Information jamais portée par la couleur seule</strong> : statuts du menu distingués par la forme des icônes (coche, triangle) et par un texte pour les lecteurs d'écran ; boutons à libellé et icône différents selon l'état.</li>
<li><strong>Zoom et petits écrans</strong> : utilisable à 320 px de large, sans défilement horizontal ; texte agrandi à 200 %.</li>
<li><strong>Sons et temps</strong> : la voix démarre après une action de l'usager, peut être mise en pause et coupée ; l'écoute sans limite de temps est disponible (écoute automatique désactivée) ; la redirection après effacement peut être arrêtée ; aucune animation en boucle.</li>
<li><strong>Formulaires</strong> : libellés visibles, champs optionnels signalés (règle DSFR), erreurs de date reliées au groupe et annoncées, aucun changement de question au simple clic sur une réponse.</li>
<li><strong>PDF</strong> : le balisage du Cerfa officiel (structure lue par les lecteurs d'écran) est conservé, avec la langue du document.</li>
</ul>
<p class="petit">Vérifications automatiques (axe-core WCAG 2.0 et 2.1 A/AA et bonnes pratiques, clavier, 320 px, thèmes clair et sombre) : 0 défaut sur tous les écrans et états testés. Une déclaration de conformité RGAA suppose un audit par un auditeur et des tests avec des lecteurs d'écran (NVDA, VoiceOver) et des usagers ; la déclaration d'accessibilité indique « non conforme » en attendant.</p>

<h3>1.11 Limites connues et hors périmètre</h3>
<ul>
<li>Seule la partie B du Cerfa est couverte ; les autres parties se remplissent à part.</li>
<li>La reconnaissance vocale dépend du navigateur (non disponible dans Firefox) et peut écorcher les noms propres ; répondre en cochant ou en écrivant reste toujours possible.</li>
<li>Contraste au survol des boutons secondaires et tertiaires DSFR en thème sombre (3,96:1) : propre au DSFR, non surchargé.</li>
<li>Le DSFR n'a ni bouton « danger » ni « toast » : la confirmation d'effacement utilise un bouton principal et une alerte de succès.</li>
<li>Navigation à la voix par numéro (« revenir à la question 5 ») : elle suit la numérotation de l'ensemble du questionnaire, alors que l'écran numérote par étape ; la navigation par sujet est à privilégier.</li>
<li>Pas de bouton « Retirer ce frais » : pour annuler un frais, vider ses champs.</li>
<li>Prototype : serveur de développement, prévu pour quelques utilisateurs simultanés.</li>
</ul>
</section>
"""

partie2 = """
<section class="saut">
<h2 class="partie">Partie 2 — Notice technique</h2>
<h3>2.1 Architecture</h3>
<p>Une application web légère : une page HTML unique (sans framework) servie par un petit serveur Python. Le serveur détient les secrets (clé de l'IA), appelle les services externes et produit le PDF ; il ne stocke rien.</p>
<div class="schema">
 <div class="boite"><h4>Navigateur</h4><ul>
  <li>Page HTML + DSFR 1.15.3</li><li>JavaScript (modules ES), sans framework</li>
  <li>Reconnaissance vocale : Web Speech API</li><li>Lecture audio, bips (Web Audio)</li><li>Réponses dans sessionStorage</li></ul></div>
 <div class="boite"><h4>Serveur Flask (Python)</h4><ul>
  <li>Pages et fichiers statiques</li><li>/api/interpret, /api/navigate → IA</li>
  <li>/api/tts → voix Piper (locale)</li><li>/api/cerfa-partie-b.pdf → pypdf</li><li>Clé de l'IA dans .env</li></ul></div>
 <div class="boite ext"><h4>Services externes</h4><ul>
  <li>Albert API (État) — modèle gpt-oss-120b</li><li>ou Claude (Anthropic), en option</li>
  <li>Reconnaissance vocale du navigateur (Google / Apple)</li><li>Cloudflare Tunnel (tests à distance seulement)</li></ul></div>
 <p class="fleches">Navigateur ⇄ HTTPS / JSON ⇄ Serveur ⇄ HTTPS ⇄ Albert API &nbsp;·&nbsp; Le navigateur ne contacte jamais directement le service d'IA.</p>
</div>

<h3>2.2 Organisation du code</h3>
<table class="tableau"><thead><tr><th>Fichier</th><th>Rôle</th></tr></thead><tbody>
<tr><td><code>app.py</code></td><td>Serveur Flask : routes, en-têtes de sécurité, accès protégé optionnel, validation des requêtes.</td></tr>
<tr><td><code>llm.py</code></td><td>Consignes (prompt) et schéma de réponse de l'IA ; appels Albert (HTTP compatible OpenAI) ou Claude ; recherche d'une question (« revenir à… ») ; chargement de .env.</td></tr>
<tr><td><code>tts.py</code></td><td>Synthèse vocale locale avec Piper ; voix chargées une fois, une synthèse à la fois.</td></tr>
<tr><td><code>pdf_cerfa.py</code></td><td>Correspondance questions → champs du Cerfa ; remplissage ; conservation des pages 5 à 8 avec leur balisage.</td></tr>
<tr><td><code>static/index.html</code></td><td>Les trois écrans, la fenêtre de réglages et celle de confirmation d'effacement (balisage DSFR).</td></tr>
<tr><td><code>static/form-b.json</code></td><td>Définition déclarative du questionnaire : étapes, questions, intitulés courts, options, conditions, versions simplifiées, questions optionnelles, formats des listes, synonymes, sigles, documents.</td></tr>
<tr><td><code>static/js/main.js</code></td><td>Déroulé de la conversation, écrans et historique du navigateur, étapes, menu latéral et statuts, lecteur de la voix, préparation du texte lu (sigles, parenthèses, ordinaux), navigation, fin et effacement.</td></tr>
<tr><td><code>static/js/voice.js</code></td><td>Lecture (Piper ou voix du navigateur, découpage en phrases, « tic », pause et reprise), écoute (silences, relances, écoute sans limite), bips.</td></tr>
<tr><td><code>static/js/local-nlu.js</code></td><td>Compréhension sans IA : commandes, mots-clés, synonymes, sigles, dates, nombres, navigation.</td></tr>
<tr><td><code>static/js/form.js</code></td><td>Rendu DSFR de chaque question (infobulle, champs de précision sous les options, dates en trois champs, blocs de frais), lecture/écriture des valeurs, validation, conditions d'affichage, affichage de la seule question en cours.</td></tr>
<tr><td><code>static/css/app.css</code></td><td>Une règle en complément du DSFR.</td></tr>
<tr><td><code>pdf/cerfa_15692-01.pdf</code></td><td>Cerfa officiel à champs remplissables (non servi tel quel).</td></tr>
<tr><td><code>tester-a-distance.sh</code></td><td>Lance le serveur et un tunnel Cloudflare pour les tests à distance.</td></tr>
<tr><td><code>docs/generateur/</code></td><td>Production de ce document : captures d'écran, page du Cerfa, mise en page et PDF.</td></tr>
<tr><td><code>.claude/skills/dsfr-rgaa/</code></td><td>Règles de développement du projet (DSFR sans surcouche, RGAA, autocritique du design).</td></tr>
</tbody></table>

<h3>2.3 API du serveur</h3>
<table class="tableau"><thead><tr><th>Route</th><th>Entrée</th><th>Sortie</th></tr></thead><tbody>
<tr><td><code>GET /</code>, <code>/accessibilite</code></td><td>—</td><td>Pages HTML.</td></tr>
<tr><td><code>GET /api/status</code></td><td>—</td><td>IA configurée, fournisseur, modèle, voix disponibles.</td></tr>
<tr><td><code>POST /api/interpret</code></td><td>Question, phrase de l'usager, échanges sur la question, valeur actuelle</td><td>JSON : intention (answer, clarify, help, skip, back, goto, repeat, pause), valeurs, précisions, message à lire.</td></tr>
<tr><td><code>POST /api/navigate</code></td><td>Phrase, liste des questions visibles et réponses</td><td>Question visée ou candidates.</td></tr>
<tr><td><code>POST /api/tts</code></td><td>Texte (≤ 1 500 caractères), voix, vitesse</td><td>Audio WAV.</td></tr>
<tr><td><code>POST /api/cerfa-partie-b.pdf</code></td><td>Réponses (formulaire), mode affichage ou téléchargement</td><td>PDF du Cerfa, pages 5 à 8.</td></tr>
</tbody></table>
<p class="petit">Requêtes limitées à 256 Ko ; réponses de l'API jamais mises en cache (<code>Cache-Control: no-store</code>).</p>
</section>

<section>
<h3>2.4 Choix techniques et bibliothèques</h3>
<table class="tableau"><thead><tr><th>Besoin</th><th>Choix</th><th>Pourquoi</th></tr></thead><tbody>
<tr><td>Interface</td><td><strong>DSFR 1.15.3</strong> (CSS, JS, polices Marianne), hébergé localement</td><td>Obligatoire pour un service de l'État ; composants accessibles et audités ; pas de dépendance à un CDN.</td></tr>
<tr><td>Logique du navigateur</td><td><strong>JavaScript natif</strong> (modules ES), sans framework</td><td>Page unique et légère ; aucune étape de compilation ; compatible avec le mode « auto » de l'API DSFR.</td></tr>
<tr><td>Serveur</td><td><strong>Flask 3.1</strong> (Python 3.9)</td><td>Simple, lisible, suffisant pour quelques routes ; écosystème Python pour l'IA, la voix et le PDF.</td></tr>
<tr><td>Compréhension</td><td><strong>Albert API</strong> (DINUM), modèle <code>gpt-oss-120b</code>, appelé avec <strong>httpx</strong></td><td>IA de l'État hébergée en France ; compatible OpenAI ; sortie contrainte par schéma JSON (repli en mode « objet JSON » si besoin). Réponse en 2 à 3 secondes.</td></tr>
<tr><td>Compréhension (option)</td><td>SDK <strong>anthropic</strong> 0.125 (Claude)</td><td>Fournisseur alternatif, sélectionné par <code>LLM_PROVIDER</code>.</td></tr>
<tr><td>Reconnaissance vocale</td><td><strong>Web Speech API</strong> du navigateur</td><td>Gratuite, sans installation ; limites : absente de Firefox, voix traitée par Google ou Apple.</td></tr>
<tr><td>Synthèse vocale</td><td><strong>Piper</strong> 1.8 (GPL-3.0), voix <code>fr_FR-siwis-medium</code>, sur le serveur ; repli sur la voix du navigateur</td><td>Voix neuronale, plus naturelle que les voix des navigateurs ; rapide (moins d'une seconde pour 15 s de parole) ; aucun texte envoyé à un tiers.</td></tr>
<tr><td>Sons</td><td><strong>Web Audio API</strong></td><td>Bips et « tic » générés sans fichier son.</td></tr>
<tr><td>PDF</td><td><strong>pypdf</strong> 6.19</td><td>Remplit les champs du Cerfa officiel, élague les pages et l'arbre de structure sans perdre le balisage d'accessibilité.</td></tr>
<tr><td>Tests à distance</td><td><strong>Cloudflare Tunnel</strong> (cloudflared)</td><td>Adresse HTTPS publique en une commande (le micro exige HTTPS), sans ouvrir de port sur la machine.</td></tr>
<tr><td>Vérifications</td><td><strong>Playwright</strong> + Chrome, <strong>axe-core</strong>, validateur W3C</td><td>Captures, parcours automatisés, audits d'accessibilité (outils de développement, hors produit).</td></tr>
</tbody></table>
<p class="petit">Écartés : framework JavaScript (React, Vue) — inutile pour une page unique et moins compatible avec le DSFR « tel quel » ; voix des navigateurs seules — jugées trop robotiques ; IA appelée depuis le navigateur — exposerait la clé.</p>

<h3>2.5 Compréhension des réponses (IA)</h3>
<ul>
<li><strong>Une requête par phrase</strong> : consignes générales + schéma complet du formulaire + glossaire des sigles (préfixe stable), puis la question en cours, la valeur actuelle, les échanges sur cette question, la date du jour et la phrase de l'usager.</li>
<li><strong>Réponse structurée</strong> (schéma JSON imposé) : intention, options cochées, oui/non, date, nombre, texte, lignes de tableau, précisions par option, message à lire, navigation.</li>
<li><strong>Contrôle côté serveur</strong> : seules les options existantes sont gardées ; un choix unique ne garde qu'une option ; les précisions sont limitées aux options cochées ; les montants sont ramenés à un nombre entier d'euros.</li>
<li><strong>Côté navigateur</strong> : commandes (répète, passer, je ne sais pas, navigation…) reconnues localement avant tout appel ; vérification des dates (date impossible, date future) ; repli par mots-clés si l'IA ne répond pas, nouvel essai après 20 secondes.</li>
<li>Consignes de rédaction des messages : vouvoiement, phrases courtes, pas de sigle sans explication, pas d'écriture inclusive, pas de conseil médical ou juridique ; en cas de détresse, numéros d'urgence (15, 112, 3114).</li>
</ul>

<h3>2.6 Formulaire déclaratif (form-b.json)</h3>
<p>Le questionnaire est entièrement décrit dans <code>static/form-b.json</code>. Le faire évoluer ne demande pas de toucher au code, sauf pour reporter une nouvelle question dans le PDF (<code>pdf_cerfa.py</code>).</p>
<table class="tableau"><thead><tr><th>Propriété</th><th>Usage</th></tr></thead><tbody>
<tr><td><code>steps[] {id, title, sections}</code></td><td>Étapes du parcours, qui regroupent les sections du Cerfa.</td></tr>
<tr><td><code>id, section, type, label, short</code></td><td>Identité, section, type de saisie, intitulé, intitulé court du menu (voir annexe).</td></tr>
<tr><td><code>simple, hint, optional</code></td><td>Version en langage simple (infobulle et reformulation lue) ; aide affichée et lue ; question optionnelle.</td></tr>
<tr><td><code>options[] {id, label, synonyms}</code></td><td>Réponses possibles ; synonymes du quotidien reconnus (« bus », « CAT »).</td></tr>
<tr><td><code>when</code></td><td>Condition d'affichage : <code>eq</code>, <code>ne</code>, <code>includes</code>, <code>in</code>, <code>nonEmpty</code>, <code>anyOf</code>.</td></tr>
<tr><td><code>allowNone, beforeToday, unit</code></td><td>« Non concerné », date passée obligatoire, unité.</td></tr>
<tr><td><code>columns[] {id, label, hint, kind, options, optional, wide}, maxRows, rowLabel, noneLabel, addLabel</code></td><td>Listes (frais, établissements) : champs d'un élément (<code>kind: "money"</code> pour un montant en euros, <code>options</code> pour une liste de choix), nombre maximal d'éléments, libellés « Frais 1 », « Je n'ai pas de frais à déclarer », « Ajouter un autre frais ».</td></tr>
<tr><td><code>oneByOne</code></td><td>Lecture des options une par une avec oui/non (disponible, non utilisée actuellement).</td></tr>
<tr><td><code>acronyms</code>, <code>documents</code></td><td>Glossaire des sigles (lecture et compréhension) ; documents à joindre.</td></tr>
</tbody></table>
<p>Une question texte conditionnée sur une option d'une question à choix (« Autre », « Dans un établissement », « Oui »…) devient automatiquement son <strong>champ de précision</strong> : elle s'affiche dans la question, sous l'option, n'apparaît pas dans le menu, et n'est pas reposée si elle est déjà remplie.</p>
</section>

<section>
<h3>2.7 Voix et écoute</h3>
<ul>
<li><strong>Préparation du texte lu</strong> (<code>main.js</code>) : sigles développés et épelés avec le nom des lettres (« erre esse a »), parenthèses lues avec pauses, ordinaux en toutes lettres, écriture inclusive muette, séparateur invisible entre les réponses possibles (joué comme un « tic »).</li>
<li><strong>Lecture</strong> (<code>voice.js</code>) : texte découpé en phrases ; la phrase suivante est synthétisée pendant la lecture de la précédente ; pauses plus longues en vitesse lente ; repli automatique sur la voix du navigateur si Piper ne répond pas. La lecture audio est « débloquée » par le clic de démarrage (exigence de Safari).</li>
<li><strong>Écoute</strong> : enchaînement d'écoutes courtes (un objet de reconnaissance neuf à chaque fois, compatible avec tous les navigateurs) dont le texte est cumulé jusqu'à 4 s de silence ; fin garantie au plus tard 1,5 s après « J'ai fini de parler », même si le navigateur ne le signale pas.</li>
</ul>

<h3>2.8 Génération du PDF Cerfa</h3>
<ul>
<li>Le Cerfa officiel (20 pages, environ 640 champs) est ouvert ; les champs des pages 5 à 8 sont remplis selon une table de correspondance (cases à cocher, textes, dates découpées en jour/mois/année, tableau des frais, établissements).</li>
<li>Les autres pages sont retirées <strong>du document lui-même</strong>, en élaguant l'arbre de structure : le PDF reste <strong>balisé</strong> (lisible par les lecteurs d'écran), avec la langue française et le titre déclarés.</li>
<li>Le fichier Cerfa contenant d'anciennes copies de ses champs, la liste des champs est reconstruite à partir des pages conservées (sinon certains lecteurs PDF afficheraient des champs vides).</li>
</ul>

<h3>2.9 Sécurité</h3>
<ul>
<li><strong>Clé de l'IA uniquement sur le serveur</strong> (fichier <code>.env</code>, exclu du versionnement) ; jamais transmise au navigateur.</li>
<li><strong>Politique de sécurité du contenu (CSP)</strong> stricte : scripts, connexions et médias limités au site ; aucun affichage dans un cadre ; <code>nosniff</code>, <code>no-referrer</code>.</li>
<li>Textes de l'IA toujours insérés comme du texte (jamais comme du HTML) ; taille des requêtes et des textes limitée ; seules les réponses aux questions connues sont acceptées pour le PDF.</li>
<li>Serveur à l'écoute en local uniquement (127.0.0.1) ; mode débogage désactivé ; accès par identifiant et mot de passe disponible pour les tests à distance (<code>ACCES_IDENTIFIANT</code>, <code>ACCES_MOT_DE_PASSE</code>), désactivé actuellement.</li>
</ul>

<h3>2.10 Installation, configuration, tests à distance</h3>
<pre>python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python -m piper.download_voices --data-dir voices fr_FR-siwis-medium fr_FR-tom-medium
.venv/bin/python app.py                      # http://127.0.0.1:8000</pre>
<table class="tableau"><thead><tr><th>Variable (.env)</th><th>Rôle</th></tr></thead><tbody>
<tr><td><code>LLM_PROVIDER</code></td><td><code>albert</code> ou <code>anthropic</code>.</td></tr>
<tr><td><code>ALBERT_API_KEY</code>, <code>ALBERT_MODEL</code>, <code>ALBERT_BASE_URL</code></td><td>Clé, modèle (<code>gpt-oss-120b</code>), adresse de l'API Albert. Liste des modèles : <code>.venv/bin/python llm.py models</code>.</td></tr>
<tr><td><code>ANTHROPIC_API_KEY</code>, <code>MDPH_CLAUDE_MODEL</code>, <code>MDPH_CLAUDE_EFFORT</code></td><td>Configuration de Claude (option).</td></tr>
<tr><td><code>ACCES_IDENTIFIANT</code>, <code>ACCES_MOT_DE_PASSE</code></td><td>Accès protégé (vides : accès libre).</td></tr>
<tr><td><code>PORT</code></td><td>Port du serveur (8000 par défaut).</td></tr>
</tbody></table>
<p><strong>Tests à distance :</strong> <code>./tester-a-distance.sh</code> lance le serveur et un tunnel Cloudflare, affiche une adresse HTTPS à transmettre aux testeurs, et empêche la mise en veille du Mac ; <code>Ctrl+C</code> ferme l'accès. À utiliser avec des données fictives (le trafic transite par Cloudflare) et quelques testeurs à la fois.</p>

<h3>2.11 Vérifications réalisées</h3>
<ul>
<li>Audit automatisé dans Chrome (Playwright) des écrans et états (accueil, étapes, menu, écoute, pause, infobulle, précisions, dates, frais, fin complète et incomplète, questions restantes, effacement), à 1280, 390 et 320 px, thèmes clair et sombre : axe-core WCAG 2.0 et 2.1 A/AA et bonnes pratiques, parcours clavier et focus, défilement horizontal. Résultat : 0 défaut.</li>
<li>Parcours de bout en bout au clic et à l'oral avec Albert (micro simulé) : cases cochées par la voix, précisions écrites dans leur champ, frais en plusieurs blocs, dates, navigation par le menu et par l'historique du navigateur ; simulation d'une panne de l'IA ; simulations de l'écoute (pauses, coupures, fin forcée, pause de la voix).</li>
<li>Jeux de phrases du quotidien pour la compréhension (ESAT, sigles, synonymes, « je ne sais pas », navigation).</li>
</ul>

<h3>2.12 Pistes pour une mise en production</h3>
<ul>
<li>Hébergement certifié HDS en France (par exemple Scalingo, Clever Cloud, OVHcloud), clé en variable secrète, serveur de production (gunicorn ou Waitress), limitation du nombre de requêtes.</li>
<li>Reconnaissance vocale hébergée (par exemple Whisper) pour ne plus dépendre de Google ou d'Apple et couvrir Firefox.</li>
<li>Audit RGAA par un auditeur, tests avec lecteurs d'écran et usagers ; mise à jour de la déclaration d'accessibilité.</li>
<li>Vérification des licences des voix Piper ; mode « production » du DSFR déjà activé.</li>
<li>Écran de fin : récapitulatif des réponses par étape et liste des questions sans réponse (pistes identifiées).</li>
<li>Extension aux autres parties du Cerfa.</li>
</ul>
</section>
"""

annexe = f"""
<section class="saut">
<h2 class="partie">Annexe — Liste des questions</h2>
<p>Les {nb_questions} questions du questionnaire, dans l'ordre, avec leurs réponses possibles et leur condition d'affichage ({nb_options} options au total).</p>
<table class="tableau annexe"><thead><tr><th>N°</th><th>Question et réponses</th><th>Type</th><th>Posée…</th></tr></thead>
<tbody>{annexe_questions()}</tbody></table>
</section>
"""

couverture = """
<section class="couverture">
 <div class="bandeau">
  <p class="fr-logo">République<br>Française</p>
 </div>
 <div>
  <h1>Formulaire MDPH - Partie B</h1>
  <p class="sous-titre">Remplir la partie B « Votre vie quotidienne » de la demande à la MDPH (Cerfa n° 15692*01) en conversant avec un assistant vocal</p>
  <div class="tricolore" aria-hidden="true"><span></span><span></span><span></span></div>
  <p class="fr-text--lead fr-mt-4w">Spécifications fonctionnelles<br>Notice technique</p>
 </div>
 <div class="meta">
  <p class="fr-mb-1v"><strong>Version :</strong> prototype — 9 octobre 2026</p>
  <p class="fr-mb-1v"><strong>Statut :</strong> document de travail</p>
  <p class="fr-mb-0"><strong>Système de design :</strong> DSFR 1.15.3 &nbsp;·&nbsp; <strong>IA :</strong> Albert API</p>
 </div>
</section>
"""

page = f"""<!doctype html>
<html lang="fr" data-fr-scheme="light">
<head><meta charset="utf-8">
<title>Formulaire MDPH - Partie B — Spécifications fonctionnelles et notice technique</title>
<link rel="stylesheet" href="file://{DSFR}/dsfr.min.css">
<link rel="stylesheet" href="file://{DSFR}/utility/utility.min.css">
<style>{css}</style></head>
<body><main class="document">
{couverture}{sommaire}{partie1}{partie2}{annexe}
</main></body></html>"""

(DOC / "document.html").write_text(page, encoding="utf-8")
print("document.html écrit")
