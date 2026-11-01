"""Interprétation des réponses orales par un modèle de langage.

Une seule opération : pour la question en cours, on envoie au modèle le schéma de la
question, l'échange déjà eu sur cette question et la dernière phrase de l'usager.
Le modèle renvoie un JSON structuré (valeurs à remplir + message à dire à l'usager).

Deux fournisseurs, choisis par LLM_PROVIDER :
- "anthropic" (défaut) : Claude, clé ANTHROPIC_API_KEY ;
- tout autre valeur (par exemple "openai") : n'importe quel fournisseur compatible avec l'API
  OpenAI (chat completions) — Albert API de l'État par défaut, ou une autre passerelle comme
  LiteLLM. Réglages : OPENAI_API_KEY, OPENAI_MODEL, OPENAI_BASE_URL.

Lancé directement (`python llm.py models`), liste les modèles disponibles chez ce fournisseur.
"""
import datetime
import json
import logging
import os
import re
import sys
import unicodedata

import anthropic
import httpx

log = logging.getLogger(__name__)


def _load_env_file(path=os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env")):
    """Charge le fichier .env (CLE=valeur) sans écraser les variables déjà définies."""
    try:
        with open(path, encoding="utf-8") as f:
            lines = f.read().splitlines()
    except FileNotFoundError:
        return
    for line in lines:
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip().removeprefix("export ").strip()
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        if key and value:
            os.environ.setdefault(key, value)


_load_env_file()

PROVIDER = os.environ.get("LLM_PROVIDER", "anthropic").strip().lower()

MODEL_CLAUDE = os.environ.get("MDPH_CLAUDE_MODEL", "claude-opus-5")
# Conversation vocale : on privilégie la réactivité.
EFFORT = os.environ.get("MDPH_CLAUDE_EFFORT", "low")

# Fournisseur compatible OpenAI (chat completions) : Albert API de l'État par défaut, mais
# OPENAI_BASE_URL peut pointer vers n'importe quelle passerelle compatible (LiteLLM...).
OPENAI_BASE_URL = os.environ.get("OPENAI_BASE_URL", "https://albert.api.etalab.gouv.fr/v1").rstrip("/")
OPENAI_MODEL = os.environ.get("OPENAI_MODEL", "albert-large")

MODEL = MODEL_CLAUDE if PROVIDER == "anthropic" else OPENAI_MODEL


def configured():
    """Vrai si une clé est fournie pour le fournisseur choisi."""
    if PROVIDER == "anthropic":
        return bool(os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN"))
    return bool(os.environ.get("OPENAI_API_KEY"))


_client = None


def client():
    global _client
    if _client is None:
        _client = anthropic.Anthropic(max_retries=2, timeout=60.0)
    return _client


SYSTEM_PROMPT = """Tu es l'assistant vocal d'un site public qui aide les personnes en situation de handicap, ou leurs proches, à remplir la partie B (« Votre vie quotidienne ») du formulaire de demande à la MDPH (Cerfa 15692*01).

L'usager te parle à la voix : ses phrases sont transcrites automatiquement et peuvent contenir des erreurs de reconnaissance, des hésitations ou des phrases incomplètes. Interprète-les avec bienveillance et bon sens.

L'usager décrit sa situation avec ses mots, rarement avec ceux du formulaire : pense au sens, pas seulement aux mots. Par exemple, « je travaille dans une entreprise pour personnes handicapées » ou « dans un atelier protégé » désigne un ESAT ; « j'ai du mal à me laver » désigne l'hygiène corporelle. Certaines options ont des "synonyms" : ce sont des expressions de la vie courante qui désignent cette option. Si l'usager emploie l'une d'elles, ou une expression de même sens, choisis cette option. En cas de vrai doute entre deux options, pose une question de précision courte plutôt que de choisir au hasard.

Tes messages (champ "message") sont lus à voix haute par une synthèse vocale et affichés à l'écran. Règles d'écriture :
- Français, vouvoiement, ton chaleureux et respectueux, jamais infantilisant.
- Phrases courtes (15 mots maximum), un seul sujet par phrase, mots du quotidien.
- Pas d'écriture inclusive : jamais « retraité(e) », « concerné(e) » ni point médian, car la synthèse vocale les lit mal. Tu ne connais pas le genre de la personne : préfère une tournure neutre (« vous êtes à la retraite depuis le… », « cela vous concerne »).
- Pas de sigle sans l'expliquer. Pas de markdown, pas de listes à puces, pas d'émoji : le texte est lu à voix haute.
- 1 à 3 phrases, sauf pour lire un texte rédigé à valider.
- Adapte-toi à la personne concernée : si le formulaire est rempli pour un enfant, parle de « votre enfant ».

Reformulation en langage simple : quand l'usager ne comprend pas, demande de l'aide, ou répond à côté, reformule la question avec des mots simples et concrets, phrases très courtes, un exemple concret tiré de la vie quotidienne, pas de négation si possible, pas de métaphore. Puis repose la question simplement.

Tu reçois la question en cours au format JSON. Selon son "type" :
- "single" : un seul choix. Mets l'identifiant ("id") de l'option dans "selected" (un seul élément).
- "multi" : plusieurs choix possibles. Mets tous les identifiants reconnus dans "selected". Si l'usager dit clairement qu'aucune option ne le concerne et que "allowNone" est vrai, laisse "selected" vide et mets "none_apply" à true.
- "yesno" : mets "oui" ou "non" dans "yes_no".
- "date" : mets la date au format JJ/MM/AAAA dans "date". Si l'usager ne donne que le mois et l'année, utilise le 01 comme jour et dis-le. Si la période n'est pas terminée, ou si l'usager ne sait pas, laisse "date" à null et explique dans "text". La date du jour est donnée dans "date_du_jour" : sers-t'en pour les dates relatives (« l'an dernier », « il y a deux ans »). Si la question a "beforeToday" à true, la date doit être strictement avant la date du jour : si l'usager donne aujourd'hui ou une date future, laisse "date" à null, "intent" = "clarify", "complete" = false, et explique-lui avec douceur que la date doit être passée, puis redemande-la.
- "number" : mets le nombre dans "number". Si l'usager dit « non », « aucun » ou « zéro » pour une question d'heures, mets 0.
- "text" : réponse courte. Mets dans "text" une reformulation propre et fidèle, à la première personne du point de vue de la personne concernée, sans inventer.
- "table" : mets chaque ligne dans "rows" (objets dont les clés sont les "id" des colonnes). Respecte "maxRows". Laisse vide ("") une cellule inconnue. Si l'usager n'a rien à déclarer, "rows" vide et "none_apply" à true. Si une colonne a des "options", écris exactement l'une d'elles (par exemple « tous les mois » → « Chaque mois »). Si une colonne a "kind": "money", écris seulement le montant en euros entiers, en chiffres, arrondi à l'euro le plus proche (par exemple « 46 » pour 45 euros 50), sans le signe €.
- "longtext" : texte libre à rédiger. Voir plus bas.

Sigles : l'usager peut désigner une option par son libellé complet, une partie, ou seulement un sigle, prononcé ou épelé (« l'AAH », « le RSA », « en ESAT », « l'ARE » pour l'allocation chômage, « a a h »). Le glossaire des sigles est donné après le schéma. Un sigle désigne l'option qui le contient, ou dont il abrège le libellé. Quand tu cites une option dans "message", écris le libellé complet suivi du sigle entre parenthèses, exactement comme dans le schéma : le site lit les sigles en toutes lettres.

Précisions des options : certaines options ont un champ de précision (voir "options_avec_precision" dans la requête). Quand tu coches une de ces options et que l'usager a donné un détail, mets ce détail dans "precisions" : un objet {"option": id de l'option, "text": détail court, fidèle, sans inventer}. Par exemple, pour « j'ai un déambulateur », coche "aides_techniques" et ajoute {"option": "aides_techniques", "text": "Déambulateur"}. Le site remplit alors directement le champ de précision, sans reposer la question. Sans détail donné, n'ajoute rien pour cette option : la question de précision suivra.

Les options « Autre » existent : si l'usager décrit une situation qui ne correspond à aucune option, sélectionne l'option "autre" (ou "autres") quand elle existe, et mets ce qu'il a décrit dans "precisions" pour cette option (par exemple {"option": "autre", "text": "Pour m'occuper de mon animal"}). Si la réponse mélange des options de la liste et autre chose, coche les options correspondantes et "autre", avec seulement la partie hors liste en précision. Dans "message", rappelle les précisions notées.

Champ "intent" :
- "answer" : l'usager a répondu. Remplis les valeurs. "complete" = true si la réponse suffit pour passer à la suite.
- "clarify" : réponse ambiguë, incomplète ou incohérente. Pose UNE question de précision courte. "complete" = false. Tu peux remplir ce qui est déjà sûr.
- "help" : l'usager ne comprend pas, demande une explication ou répond à côté. Reformule en langage simple. "complete" = false.
- "skip" : l'usager veut passer la question, ne veut pas répondre, ou dit qu'il ne sait pas (« je ne sais pas », « aucune idée », « je ne me souviens plus »…). "complete" = true, aucune valeur. S'il ne sait pas, "message" le rassure en une phrase : « Ce n'est pas grave. On passe à la suite, vous pourrez y revenir plus tard. »
- "next" : l'usager a fini de répondre à cette question et demande de passer à la suite (« c'est tout », « c'est tout ce que j'ai à dire », « passons à la suite », « question suivante », « on continue »). Remplis aussi les valeurs s'il en donne dans la même phrase (« j'ai un fauteuil, passons à la suite »). "complete" = true. "message" vide ou très court.
- "back" : l'usager veut revenir à la question précédente.
- "goto" : l'usager veut revenir à une autre question que la précédente, ou corriger une réponse donnée plus tôt (« revenir à la question 5 », « je me suis trompé pour le logement »). Mets dans "navigation" le numéro de la question ou les mots qui la décrivent (« 5 », « logement », « AAH »). Sinon, "navigation" = null.
- "next_step" / "prev_step" : l'usager veut passer à l'étape suivante, ou revenir à l'étape précédente (les questions sont regroupées en étapes).
- "list" : l'usager veut entendre les réponses possibles (« lis-moi les réponses », « quels sont les choix ? »).
- "repeat" : l'usager veut réentendre la question.
- "pause" : l'usager veut faire une pause ou arrêter pour l'instant.
- "finish" : l'usager veut aller à la fin du questionnaire, pour imprimer ou enregistrer le formulaire.
Commandes vocales : l'usager pilote le site à la voix. Tu PEUX déclencher ces actions : dès qu'il demande l'une d'elles, même au milieu d'une phrase ou avec d'autres mots, choisis l'"intent" correspondant ; le site l'exécute. Ne lui dis jamais que tu ne peux pas le faire.
Pour "skip", "next", "back", "next_step", "prev_step", "list", "repeat", "pause" et "finish", "message" peut être vide.

Quand "complete" est true avec "intent" = "answer", le "message" confirme brièvement ce que tu as noté, avec des mots simples (par exemple : « C'est noté : vous vivez seul, dans un logement dont vous êtes locataire. »). N'annonce pas la question suivante : le site s'en charge.

Questions de type "longtext" (rédaction assistée) :
1. Écoute ce que la personne raconte. Si c'est trop vague pour la MDPH, pose une ou deux questions de relance concrètes (les difficultés précises, la fréquence, l'aide nécessaire, les conséquences, les projets). "intent" = "clarify", "complete" = false. Pas plus de 3 relances au total : respecte la fatigue de la personne. Si elle dit que c'est tout, passe à l'étape 2.
2. Quand tu as assez d'informations, rédige dans "text" un texte clair, structuré en courts paragraphes, à la première personne (ou « mon enfant… » si le formulaire concerne un enfant), fidèle à ce qui a été dit, sans rien inventer ni exagérer, dans un registre adapté à un dossier administratif. Mets "awaiting_validation" à true, "complete" à false, et dans "message" lis le texte puis demande si cela convient ou s'il faut changer quelque chose.
3. Si un texte a déjà été proposé ("draft" non vide) : si la personne valide, recopie ce texte dans "text", "complete" = true, "awaiting_validation" = false. Si elle demande une modification, applique-la, renvoie le nouveau texte complet dans "text", "awaiting_validation" = true, et relis-le.

Mémoire : "memoire" liste les informations que l'usager a déjà données ailleurs dans la conversation ({id, qid : question visée ou null, text}). Sers-t'en pour comprendre sa réponse (« comme je vous l'ai dit »), sans lui faire répéter ce qu'il a déjà dit.

Champ "facts" : l'usager donne souvent, en répondant, des informations qui répondent à D'AUTRES questions du formulaire (« je vis seul depuis que j'ai l'AAH »). Liste-les dans "facts", seulement celles qui viennent du texte "texte_a_extraire" (ou, à défaut, de "derniere_phrase_usager"), un fait par question. Pour chaque fait : "qid" = identifiant de la question visée (null si l'information ne correspond à aucune question mais sera utile plus tard) ; "fact" = une phrase courte qui résume l'information (« Vit seul », « Perçoit l'AAH depuis mars 2021 ») ; la valeur selon le type de la question visée, dans "selected" (pour une question à choix, TOUJOURS l'"id" de l'option : sans lui, le fait est ignoré), "none_apply", "yes_no", "date" (JJ/MM/AAAA), "number" ou "text", les autres champs vides ou null ; "quote" = le plus court extrait EXACT des mots de l'usager qui justifie cette information (quelques mots, recopiés tels quels, pas toute la phrase) ; "replaces" = l'"id" du fait de "memoire" que cette information corrige, sinon null. Une même phrase répond souvent à plusieurs questions : passe en revue TOUTES les questions du schéma, y compris celles qui ne s'affichent que sous condition ("when"). Ajoute aussi ce qui se DÉDUIT avec quasi-certitude de ce qui est dit : par exemple, « je vis chez mes parents » répond aussi à « Où vivez-vous ? » (hébergé au domicile de quelqu'un) et à « Chez qui vivez-vous ? » (de vos parents) ; la citation est alors les mots qui permettent la déduction (« chez mes parents »). Pas de supposition seulement probable : « je vis avec mes parents » ne dit pas à qui est le logement. N'invente rien. Pas de fait sur la question en cours (sa réponse va dans les autres champs). Pas de fait déjà en mémoire avec la même valeur. Sinon, "facts" vide.

Ne donne jamais de conseil médical ou juridique, et ne promets jamais qu'un droit sera accordé : c'est la MDPH qui décide. Si la personne exprime une détresse ou un danger immédiat, réponds avec empathie et indique le 15 (urgences médicales), le 112 ou le 3114 (prévention du suicide), puis propose de continuer plus tard.

Voici le schéma complet de la partie B, pour le contexte (les questions sont posées une par une) :
"""

# Information donnée par l'usager pour une AUTRE question que celle en cours (mémoire « le dire une fois »).
FACT_SCHEMA = {
    "type": "object",
    "properties": {
        "qid": {"type": ["string", "null"]},
        "fact": {"type": "string"},
        "selected": {"type": "array", "items": {"type": "string"}},
        "none_apply": {"type": "boolean"},
        "yes_no": {"type": "string", "enum": ["oui", "non", "inconnu"]},
        "date": {"type": ["string", "null"]},
        "number": {"type": ["number", "null"]},
        "text": {"type": ["string", "null"]},
        "quote": {"type": "string"},
        "replaces": {"type": ["string", "null"]},
    },
    "required": ["qid", "fact", "selected", "none_apply", "yes_no", "date", "number", "text", "quote", "replaces"],
    "additionalProperties": False,
}

RESPONSE_SCHEMA = {
    "type": "object",
    "properties": {
        "intent": {
            "type": "string",
            "enum": ["answer", "clarify", "help", "skip", "next", "back", "goto", "next_step", "prev_step",
                     "list", "repeat", "pause", "finish"],
        },
        "selected": {"type": "array", "items": {"type": "string"}},
        "none_apply": {"type": "boolean"},
        "yes_no": {"type": "string", "enum": ["oui", "non", "inconnu"]},
        "date": {"type": ["string", "null"]},
        "number": {"type": ["number", "null"]},
        "text": {"type": ["string", "null"]},
        "rows": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "cells": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "column": {"type": "string"},
                                "value": {"type": "string"},
                            },
                            "required": ["column", "value"],
                            "additionalProperties": False,
                        },
                    }
                },
                "required": ["cells"],
                "additionalProperties": False,
            },
        },
        "complete": {"type": "boolean"},
        "awaiting_validation": {"type": "boolean"},
        "navigation": {"type": ["string", "null"]},
        "precisions": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "option": {"type": "string"},
                    "text": {"type": "string"},
                },
                "required": ["option", "text"],
                "additionalProperties": False,
            },
        },
        "message": {"type": "string"},
        "facts": {"type": "array", "items": FACT_SCHEMA},
    },
    "required": [
        "intent", "selected", "none_apply", "yes_no", "date", "number",
        "text", "rows", "complete", "awaiting_validation", "precisions", "navigation", "message", "facts",
    ],
    "additionalProperties": False,
}


class LLMUnavailable(Exception):
    """Claude n'a pas pu répondre : le front bascule sur son mode sans IA."""


def _system_text(form):
    """Consignes + schéma du formulaire : préfixe stable, mis en cache chez Claude."""
    schema_json = json.dumps(form["questions"], ensure_ascii=False)
    schema_json += "\n\nGlossaire des sigles :\n" + json.dumps(form.get("acronyms", {}), ensure_ascii=False)
    return SYSTEM_PROMPT + schema_json


def interpret(form, question, context):
    """Interprète la réponse de l'usager à `question`.

    context : {utterance, history: [{role, text}], draft, current_value, concerne,
               memoire: [{id, qid, text}], pending: texte pas encore passé par extract()}
    Renvoie aussi "facts" (informations pour d'autres questions, vérifiées) et "rejected".
    """
    memoire = context.get("memoire") or []
    pending = context.get("pending") or ""
    payload = {
        "formulaire_rempli_pour": context.get("concerne") or "inconnu",
        "date_du_jour": datetime.date.today().strftime("%d/%m/%Y"),
        "question": question,
        "valeur_actuelle": context.get("current_value"),
        "echanges_sur_cette_question": context.get("history", [])[-12:],
        "draft": context.get("draft") or "",
        "memoire": memoire,
        "derniere_phrase_usager": context["utterance"],
    }
    if pending:
        payload["texte_a_extraire"] = pending
        payload["consigne_facts"] = (
            "Relis \"texte_a_extraire\" phrase par phrase : chaque information qui répond à une AUTRE question "
            "du formulaire (logement, ressources, aides, difficultés, besoins...) DOIT être dans \"facts\", avec sa citation exacte."
        )
    with_precision = _options_with_precision(form, question)
    if with_precision:
        payload["options_avec_precision"] = with_precision
        payload["consigne_precisions"] = (
            "Si tu coches une option de \"options_avec_precision\" et que l'usager a donné un détail "
            "(ou décrit quelque chose hors de la liste pour « autre »), tu DOIS l'ajouter dans \"precisions\"."
        )
    user_text = (
        "Interprète la dernière phrase de l'usager pour la question en cours.\n"
        + json.dumps(payload, ensure_ascii=False, indent=1)
    )

    data = _complete(_system_text(form), user_text, RESPONSE_SCHEMA, cache=True)
    result = _sanitize(question, data)
    # Citation cherchée dans toute la réponse : une information peut commencer avant "texte_a_extraire".
    facts, rejected = sanitize_facts(
        form, question["id"], data.get("facts"), context["utterance"], {m["id"] for m in memoire})
    result["facts"] = facts
    result["rejected"] = rejected
    return result


# ---------- Extraction en direct (pendant que l'usager parle) ----------

EXTRACT_INSTRUCTIONS = """Tâche différente de d'habitude : extraction en direct. L'usager est EN TRAIN de parler, il n'a pas fini sa réponse. Ne lui réponds pas.
Tu reçois la question en cours, tout ce qu'il a dit depuis le début de sa réponse ("texte_du_tour"), le dernier morceau qu'il vient de dire ("nouveau_segment") et la mémoire des informations déjà notées ("memoire").
1. "current" : la réponse à la question en cours d'après TOUT "texte_du_tour", avec les mêmes règles que d'habitude selon le type de la question ("selected", "none_apply", "yes_no", "date", "number", "text", "precisions"). Ne remplis que ce qui est dit clairement ; sinon laisse vide ou null. "complete" = true seulement si la réponse à la question en cours est complète et sans ambiguïté.
2. "facts" : les informations de "texte_du_tour" qui répondent à d'autres questions du formulaire et ne sont pas déjà dans "memoire", avec les règles habituelles du champ "facts" ("quote" recopiée de "texte_du_tour"). Regarde surtout "nouveau_segment" : une phrase peut être coupée entre deux morceaux, relis-la en entier dans "texte_du_tour".
Réponds uniquement avec l'objet JSON demandé."""

EXTRACT_SCHEMA = {
    "type": "object",
    "properties": {
        "current": {
            "type": "object",
            "properties": {
                key: RESPONSE_SCHEMA["properties"][key]
                for key in ("selected", "none_apply", "yes_no", "date", "number", "text", "precisions", "complete")
            },
            "required": ["selected", "none_apply", "yes_no", "date", "number", "text", "precisions", "complete"],
            "additionalProperties": False,
        },
        "facts": {"type": "array", "items": FACT_SCHEMA},
    },
    "required": ["current", "facts"],
    "additionalProperties": False,
}


def extract(form, question, context):
    """Extraction pendant que l'usager parle : valeur provisoire de la question en cours (d'après tout
    le tour) et faits pour les autres questions (d'après le dernier segment seulement).

    context : {segment, turn_text, memoire: [{id, qid, text}], concerne}
    Le serveur ne garde rien : les faits déjà notés reviennent dans `memoire` (pas de doublon).
    Renvoie {"current": même forme que interpret() (sans message), "facts": [...], "rejected": [...]}.
    """
    memoire = context.get("memoire") or []
    payload = {
        "formulaire_rempli_pour": context.get("concerne") or "inconnu",
        "date_du_jour": datetime.date.today().strftime("%d/%m/%Y"),
        "question": question,
        "memoire": memoire,
        "texte_du_tour": context.get("turn_text") or context["segment"],
        "nouveau_segment": context["segment"],
    }
    user_text = EXTRACT_INSTRUCTIONS + "\n" + json.dumps(payload, ensure_ascii=False, indent=1)
    data = _complete(_system_text(form), user_text, EXTRACT_SCHEMA, cache=True)
    current = data.get("current") if isinstance(data.get("current"), dict) else {}
    result = _sanitize(question, {**current, "intent": "answer"})
    result["message"] = ""
    # Citation cherchée dans tout le tour : une information peut être à cheval sur deux morceaux.
    source = context.get("turn_text") or context["segment"]
    facts, rejected = sanitize_facts(form, question["id"], data.get("facts"), source, {m["id"] for m in memoire})
    return {"current": result, "facts": facts, "rejected": rejected}


MAX_FACTS = 12
DATE_RE = re.compile(r"^\d{2}/\d{2}/\d{4}$")


def _normalize(text):
    """Texte comparable : minuscules, sans accents ni ponctuation, espaces simples."""
    text = unicodedata.normalize("NFD", str(text or "").lower())
    text = "".join(c for c in text if not unicodedata.combining(c))
    return " ".join(re.sub(r"[^\w]+", " ", text).split())


def _fact_value(question, s):
    """Valeur utile d'un fait déjà nettoyé par _sanitize, ou None s'il n'en a pas."""
    qtype = question["type"]
    if qtype in ("single", "multi"):
        if s["selected"]:
            return s["selected"]
        return True if qtype == "multi" and s["none_apply"] and question.get("allowNone") else None
    if qtype == "yesno":
        return s["yes_no"]
    if qtype == "date":
        return s["date"] if isinstance(s["date"], str) and DATE_RE.match(s["date"]) else None
    if qtype == "number":
        return s["number"] if isinstance(s["number"], (int, float)) and not isinstance(s["number"], bool) else None
    if qtype in ("text", "longtext"):
        return (s["text"] or "").strip() or None
    return None  # tableaux : pas d'extraction (pour l'instant)


def sanitize_facts(form, current_qid, facts, source_text, known_ids):
    """Ne garde que des faits vérifiables : question connue (autre que la question en cours), valeur
    valide pour son type, citation présente dans `source_text` (ce que l'usager a vraiment dit).
    Renvoie (faits gardés, refus [{reason, qid, quote}]) ; les refus servent au panneau de débogage."""
    questions = {q["id"]: q for q in form["questions"]}
    source = _normalize(source_text)
    kept, rejected = [], []
    for raw in (facts or [])[:MAX_FACTS * 2]:
        if not isinstance(raw, dict):
            continue
        qid = raw.get("qid") or None
        quote = str(raw.get("quote") or "").strip()[:300]
        fact_text = str(raw.get("fact") or "").strip()[:200]

        def refuse(reason):
            rejected.append({"reason": reason, "qid": qid, "quote": quote, "fact": fact_text})

        if qid is not None and qid not in questions:
            refuse("question_inconnue")
            continue
        if qid == current_qid:
            refuse("question_en_cours")
            continue
        norm_quote = _normalize(quote)
        if not norm_quote or norm_quote not in source:
            refuse("citation_absente")
            continue
        fact = {
            "qid": qid, "fact": fact_text, "quote": quote,
            "replaces": raw.get("replaces") if raw.get("replaces") in known_ids else None,
            "selected": [], "none_apply": False, "yes_no": None, "date": None, "number": None, "text": None,
        }
        if qid is None:
            if not fact_text:
                refuse("vide")
                continue
        else:
            question = questions[qid]
            s = _sanitize(question, {**raw, "intent": "answer"})
            if _fact_value(question, s) is None:
                refuse("valeur_invalide")
                continue
            for key in ("selected", "none_apply", "yes_no", "date", "number", "text"):
                fact[key] = s[key]
            if question["type"] in ("single", "multi"):
                fact["none_apply"] = bool(s["none_apply"] and not s["selected"])
            if not fact["fact"]:
                fact["fact"] = question.get("short") or question["label"]
        if len(kept) >= MAX_FACTS:
            refuse("trop_de_faits")
            continue
        kept.append(fact)
    return kept + _implied_by_conditions(questions, kept, current_qid), rejected


def _implied_by_conditions(questions, facts, current_qid):
    """Déductions sûres tirées du formulaire lui-même : une question qui ne s'affiche que sous condition
    ("when") n'a de réponse que si cette condition est remplie. « Chez qui vivez-vous ? : vos parents »
    implique donc « Où vivez-vous ? : hébergé au domicile de quelqu'un ». Même citation que le fait
    d'origine ; rien n'est ajouté pour la question en cours ni pour une question déjà renseignée."""
    have = {f["qid"] for f in facts if f["qid"]}
    implied = []
    pending = list(facts)
    while pending:
        f = pending.pop()
        when = (questions.get(f["qid"]) or {}).get("when") or {}
        parent = questions.get(when.get("q"))
        if not parent or parent["id"] in have or parent["id"] == current_qid:
            continue
        value = {"selected": [], "none_apply": False, "yes_no": None, "date": None, "number": None, "text": None}
        option = when.get("eq") if parent["type"] == "single" else when.get("includes") if parent["type"] == "multi" else None
        if option and any(o["id"] == option for o in parent.get("options", [])):
            value["selected"] = [option]
            label = next(o["label"] for o in parent["options"] if o["id"] == option)
        elif parent["type"] == "yesno" and when.get("eq") in ("oui", "non"):
            value["yes_no"] = label = when["eq"]
        else:
            continue
        fact = {"qid": parent["id"], "fact": f"{parent.get('short') or parent['label']} : {label}",
                "quote": f["quote"], "replaces": None, **value}
        have.add(parent["id"])
        implied.append(fact)
        pending.append(fact)  # condition de la condition (questions imbriquées)
    return implied


NAVIGATION_PROMPT = """Tu aides un site vocal qui fait remplir la partie B du formulaire de demande à la MDPH.
L'usager veut revenir à une question déjà posée. Tu reçois la liste des questions (numéro, identifiant, intitulé,
réponse actuelle) et ce que l'usager a dit pour désigner la question.
Trouve la question visée : par son numéro, par un mot ou un sujet de l'intitulé, ou par sa réponse (« celle où j'ai dit
que je vivais seul »). Les sigles peuvent être utilisés (AAH, RSA, ESAT…).
- Une seule question correspond clairement : mets son identifiant dans "id", et "candidats" vide.
- Plusieurs correspondent : "id" = null et mets leurs identifiants dans "candidats" (3 au plus, les plus probables d'abord).
- Aucune : "id" = null et "candidats" vide.
Ne réponds que par l'objet JSON."""

NAVIGATION_SCHEMA = {
    "type": "object",
    "properties": {
        "id": {"type": ["string", "null"]},
        "candidats": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["id", "candidats"],
    "additionalProperties": False,
}


def find_question(candidates, utterance):
    """Question visée par l'usager parmi `candidates` ([{numero, id, question, reponse}]).

    Renvoie {"id": id ou None, "candidats": [ids]} (ids vérifiés).
    """
    user_text = json.dumps({"questions": candidates, "phrase_usager": utterance}, ensure_ascii=False, indent=1)
    data = _complete(NAVIGATION_PROMPT, user_text, NAVIGATION_SCHEMA)
    valid = {c["id"] for c in candidates}
    target = data.get("id") if data.get("id") in valid else None
    others = [c for c in (data.get("candidats") or []) if c in valid and c != target][:3]
    return {"id": target, "candidats": [] if target else others}


def _complete(system_text, user_text, schema, cache=False):
    """Appelle le modèle configuré et renvoie sa réponse JSON (dict)."""
    if PROVIDER == "anthropic":
        text = _call_claude(system_text, user_text, schema, cache)
    else:
        text = _call_openai(system_text, user_text, schema)
    try:
        data = json.loads(_strip_fences(text))
    except json.JSONDecodeError as e:
        log.error("Réponse JSON invalide : %r", text[:500])
        raise LLMUnavailable("bad_json") from e
    if not isinstance(data, dict):
        log.error("Réponse JSON inattendue : %r", text[:500])
        raise LLMUnavailable("bad_json")
    return data


def _options_with_precision(form, question):
    """Options de `question` qui ouvrent une question de précision (texte) : {id option: libellé du champ}."""
    result = {}
    for f in form["questions"]:
        w = f.get("when") or {}
        if w.get("q") != question["id"] or f["type"] not in ("text", "longtext"):
            continue
        for opt in [w.get("includes"), w.get("eq"), *(w.get("in") or [])]:
            if opt:
                result[opt] = f["label"]
    return result


def _strip_fences(text):
    """Retire un éventuel bloc ```json … ``` autour de la réponse."""
    m = re.search(r"```(?:json)?\s*(.*?)\s*```", text, re.S)
    return m.group(1) if m else text.strip()


def _call_claude(system_text, user_text, schema, cache=False):
    system = [{"type": "text", "text": system_text}]
    if cache:
        # Préfixe stable (consignes + schéma du formulaire) mis en cache d'une requête à l'autre.
        system[0]["cache_control"] = {"type": "ephemeral"}
    try:
        response = client().beta.messages.create(
            model=MODEL,
            max_tokens=4000,
            betas=["server-side-fallback-2026-07-01"],
            fallbacks="default",
            system=system,
            messages=[{"role": "user", "content": user_text}],
            output_config={
                "effort": EFFORT,
                "format": {"type": "json_schema", "schema": schema},
            },
        )
    except anthropic.AuthenticationError as e:
        log.error("Clé API Claude invalide : %s", e)
        raise LLMUnavailable("auth") from e
    except TypeError as e:
        # Levée par le SDK quand aucun identifiant n'est configuré.
        if "authentication" not in str(e):
            raise
        log.error("Aucun identifiant Claude configuré (ANTHROPIC_API_KEY).")
        raise LLMUnavailable("auth") from e
    except anthropic.RateLimitError as e:
        log.warning("Limite de débit Claude atteinte : %s", e)
        raise LLMUnavailable("rate_limit") from e
    except anthropic.APIStatusError as e:
        log.error("Erreur API Claude %s : %s", e.status_code, e)
        raise LLMUnavailable("api_error") from e
    except anthropic.APIConnectionError as e:
        log.error("Connexion à l'API Claude impossible : %s", e)
        raise LLMUnavailable("connection") from e

    if response.stop_reason == "refusal":
        raise LLMUnavailable("refusal")
    if response.stop_reason == "max_tokens":
        raise LLMUnavailable("max_tokens")

    return "".join(b.text for b in response.content if b.type == "text")


# Fournisseur compatible OpenAI (Albert, LiteLLM...) : consignes et schéma dans le message
# système. Sortie contrainte par schéma si le modèle l'accepte ; sinon on retombe sur le mode
# « objet JSON » (le schéma, rappelé dans le prompt, guide alors la réponse).
def _json_reminder(schema):
    return ("\n\nRéponds uniquement avec un objet JSON valide, sans texte autour, conforme à ce schéma :\n"
            + json.dumps(schema, ensure_ascii=False))


_openai_format = {"mode": "json_schema"}
_http = None


def _openai_post(path, body):
    global _http
    if _http is None:
        _http = httpx.Client(base_url=OPENAI_BASE_URL, timeout=60.0)
    key = os.environ.get("OPENAI_API_KEY")
    if not key:
        log.error("Aucune clé configurée (OPENAI_API_KEY).")
        raise LLMUnavailable("auth")
    headers = {"Authorization": f"Bearer {key}"}
    try:
        if body is None:
            return _http.get(path, headers=headers)
        return _http.post(path, headers=headers, json=body)
    except httpx.HTTPError as e:
        log.error("Connexion au fournisseur OpenAI impossible : %s", e)
        raise LLMUnavailable("connection") from e


def _response_format(mode, schema):
    if mode == "json_schema":
        return {"type": "json_schema",
                "json_schema": {"name": "reponse", "schema": schema, "strict": True}}
    return {"type": "json_object"}


def _call_openai(system_text, user_text, schema):
    body = {
        "model": OPENAI_MODEL,
        "messages": [
            {"role": "system", "content": system_text + _json_reminder(schema)},
            {"role": "user", "content": user_text},
        ],
        "max_tokens": 4000,
        "temperature": 0.2,
        "response_format": _response_format(_openai_format["mode"], schema),
    }
    resp = _openai_post("/chat/completions", body)
    if resp.status_code in (400, 422) and _openai_format["mode"] == "json_schema":
        log.warning("Le fournisseur refuse la sortie par schéma (%s) : mode objet JSON.", resp.text[:300])
        _openai_format["mode"] = "json_object"
        body["response_format"] = _response_format("json_object", schema)
        resp = _openai_post("/chat/completions", body)

    if resp.status_code in (401, 403):
        log.error("Clé refusée : %s", resp.text[:300])
        raise LLMUnavailable("auth")
    if resp.status_code == 429:
        log.warning("Limite de débit atteinte : %s", resp.text[:300])
        raise LLMUnavailable("rate_limit")
    if resp.status_code != 200:
        log.error("Erreur API %s : %s", resp.status_code, resp.text[:500])
        raise LLMUnavailable("api_error")

    try:
        choice = resp.json()["choices"][0]
        text = choice["message"]["content"] or ""
    except (ValueError, KeyError, IndexError, TypeError) as e:
        log.error("Réponse inattendue : %r", resp.text[:500])
        raise LLMUnavailable("bad_json") from e
    if choice.get("finish_reason") == "length":
        raise LLMUnavailable("max_tokens")
    return text


def openai_models():
    """Identifiants des modèles de génération de texte disponibles chez ce fournisseur."""
    resp = _openai_post("/models", None)
    resp.raise_for_status()
    return [m["id"] for m in resp.json().get("data", []) if m.get("type", "text-generation") == "text-generation"]


def _cell(question, column_id, value):
    """Valeur d'une cellule de tableau : un montant ne garde que le nombre, à l'euro près (« 45,50 € » → « 46 »)."""
    value = str(value or "").strip()
    column = next((c for c in question["columns"] if c["id"] == column_id), {})
    if column.get("kind") == "money":
        match = re.search(r"\d+(?:[.,]\d+)?", value.replace("\u202f", "").replace(" ", ""))
        # Arrondi à l'euro le plus proche (0,5 vers le haut, comme on l'attend en français).
        return str(int(float(match.group(0).replace(",", ".")) + 0.5)) if match else ""
    return value


def _sanitize(question, data):
    """Ne garde que des valeurs cohérentes avec la question."""
    qtype = question["type"]
    valid_ids = {o["id"] for o in question.get("options", [])}
    selected = [s for s in (data.get("selected") or []) if s in valid_ids]
    if qtype == "single":
        selected = selected[:1]

    rows = []
    if qtype == "table":
        col_ids = [c["id"] for c in question["columns"]]
        for row in (data.get("rows") or [])[: question.get("maxRows", 3)]:
            if not isinstance(row, dict):
                continue
            cells = {c.get("column"): c.get("value", "") for c in (row.get("cells") or []) if isinstance(c, dict)}
            rows.append({cid: _cell(question, cid, cells.get(cid, "")) for cid in col_ids})

    return {
        "intent": data.get("intent", "clarify"),
        "selected": selected,
        "none_apply": bool(data.get("none_apply")),
        "yes_no": data.get("yes_no") if data.get("yes_no") in ("oui", "non") else None,
        "date": data.get("date"),
        "number": data.get("number"),
        "text": data.get("text"),
        "rows": rows,
        "complete": bool(data.get("complete")),
        "awaiting_validation": bool(data.get("awaiting_validation")),
        "navigation": (str(data.get("navigation") or "").strip() or None) if data.get("intent") == "goto" else None,
        "precisions": [
            {"option": p["option"], "text": str(p.get("text") or "").strip()}
            for p in (data.get("precisions") or [])
            if isinstance(p, dict) and p.get("option") in selected and str(p.get("text") or "").strip()
        ],
        "message": (data.get("message") or "").strip(),
    }


if __name__ == "__main__":
    # Liste des modèles du fournisseur compatible OpenAI, pour choisir OPENAI_MODEL.
    if sys.argv[1:] == ["models"]:
        for model_id in openai_models():
            print(model_id)
    else:
        print("Usage : python llm.py models")
