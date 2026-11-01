"""Serveur du formulaire MDPH vocal (partie B)."""
import hmac
import json
import logging
import os
from io import BytesIO
from pathlib import Path

from flask import Flask, Response, jsonify, request, send_file, send_from_directory

import llm
import pdf_cerfa
import tts

BASE = Path(__file__).parent
STATIC = BASE / "static"
FORM = json.loads((STATIC / "form-b.json").read_text(encoding="utf-8"))
QUESTIONS = {q["id"]: q for q in FORM["questions"]}

MAX_UTTERANCE = 4000

logging.basicConfig(level=logging.INFO)
# pypdf signale des détails sans conséquence de la structure du Cerfa officiel.
logging.getLogger("pypdf").setLevel(logging.ERROR)
app = Flask(__name__, static_folder=None)
app.config["MAX_CONTENT_LENGTH"] = 256 * 1024


@app.before_request
def access_password():
    """Accès protégé par identifiant et mot de passe, si ACCES_IDENTIFIANT et ACCES_MOT_DE_PASSE
    sont définis dans .env (tests à distance) : le quota Albert n'est utilisable que par les testeurs."""
    user = os.environ.get("ACCES_IDENTIFIANT")
    password = os.environ.get("ACCES_MOT_DE_PASSE")
    if not (user and password):
        return None
    auth = request.authorization
    ok = auth is not None and auth.type == "basic" \
        and hmac.compare_digest((auth.username or "").encode(), user.encode()) \
        and hmac.compare_digest((auth.password or "").encode(), password.encode())
    if ok:
        return None
    return Response(
        "Accès réservé aux personnes invitées au test.", 401,
        {"WWW-Authenticate": 'Basic realm="Formulaire MDPH - test", charset="UTF-8"'},
        mimetype="text/plain",
    )


@app.after_request
def security_headers(resp):
    resp.headers["X-Content-Type-Options"] = "nosniff"
    resp.headers["Referrer-Policy"] = "no-referrer"
    resp.headers["Permissions-Policy"] = "microphone=(self)"
    if resp.mimetype == "application/pdf":
        # Pas de CSP sur le PDF : elle peut empêcher l'affichage par le lecteur PDF du navigateur.
        resp.headers["Cache-Control"] = "no-store"
        return resp
    resp.headers["Content-Security-Policy"] = (
        "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; "
        "font-src 'self'; script-src 'self'; connect-src 'self'; media-src 'self' blob:; frame-ancestors 'none'"
    )
    # Données de santé : jamais de cache des réponses API.
    if request.path.startswith("/api/"):
        resp.headers["Cache-Control"] = "no-store"
    return resp


@app.get("/")
def index():
    return send_from_directory(STATIC, "index.html")


@app.get("/accessibilite")
def accessibilite():
    return send_from_directory(STATIC, "accessibilite.html")


@app.get("/mentions-legales")
def mentions_legales():
    return send_from_directory(STATIC, "mentions-legales.html")


@app.get("/donnees-personnelles")
def donnees_personnelles():
    return send_from_directory(STATIC, "donnees-personnelles.html")


@app.get("/<path:path>")
def static_files(path):
    return send_from_directory(STATIC, path)


@app.get("/api/status")
def status():
    return jsonify({
        "llm": llm.configured(), "provider": llm.PROVIDER, "model": llm.MODEL,
        "tts": tts.available_voices(),
        # Panneau de débogage de la mémoire : en développement seulement (MEMOIRE_DEBUG=1).
        "debug_memoire": os.environ.get("MEMOIRE_DEBUG", "").strip().lower() in ("1", "true", "oui"),
    })


@app.post("/api/tts")
def speech():
    """Lecture à voix haute avec une voix Piper locale : renvoie un WAV."""
    body = request.get_json(silent=True) or {}
    text = str(body.get("text") or "").strip()
    if not text:
        return jsonify({"error": "texte_vide"}), 400
    if not tts.available_voices():
        return jsonify({"error": "tts_indisponible"}), 503
    try:
        rate = float(body.get("rate") or 1)
    except (TypeError, ValueError):
        rate = 1.0
    wav = tts.synthesize(text, voice=str(body.get("voice") or tts.DEFAULT_VOICE), rate=rate)
    return send_file(BytesIO(wav), mimetype="audio/wav")


def option_question(question, option):
    """Question oui / non pour une seule option d'une question « oneByOne »."""
    vq = {
        "id": f"{question['id']}.{option['id']}",
        "type": "yesno",
        "label": f"{question['label']} Proposition : « {option['label']} ». Est-ce que vous le souhaitez ?",
        "consigne": (
            "L'assistant lit les propositions une par une : réponds seulement pour celle-ci, par oui ou par non. "
            "Si l'usager répond, laisse \"message\" vide : le site enchaîne sur la proposition suivante."
        ),
    }
    if option["id"] in ("autre", "autres"):
        vq["label"] = f"{question['label']} Avez-vous une autre attente ?"
        vq["consigne"] += (
            " Si l'usager répond oui en décrivant son attente, mets aussi cette description, courte et fidèle, dans \"text\"."
        )
    return vq


MAX_FACTS_MEMOIRE = 200


def history_from(body):
    """Échange déjà eu sur la question en cours : [{role, text}] nettoyé."""
    history = body.get("history")
    if not isinstance(history, list):
        return []
    return [
        {"role": str(h.get("role", ""))[:20], "text": str(h.get("text", ""))[:MAX_UTTERANCE]}
        for h in history if isinstance(h, dict)
    ]


def memoire_from(body):
    """Mémoire envoyée par le navigateur (faits déjà notés) : [{id, qid, text}] nettoyée."""
    items = body.get("memoire")
    if not isinstance(items, list):
        return []
    return [
        {
            "id": str(m.get("id") or "")[:20],
            "qid": str(m["qid"]) if m.get("qid") in QUESTIONS else None,
            "text": str(m.get("text") or "")[:300],
        }
        for m in items[-MAX_FACTS_MEMOIRE:]
        if isinstance(m, dict) and m.get("id")
    ]


@app.post("/api/interpret")
def interpret():
    body = request.get_json(silent=True) or {}
    question = QUESTIONS.get(body.get("question_id"))
    utterance = (body.get("utterance") or "").strip()
    if question is None:
        return jsonify({"error": "question_inconnue"}), 400
    if not utterance:
        return jsonify({"error": "reponse_vide"}), 400
    option_id = body.get("option_id")
    if option_id and question.get("oneByOne"):
        option = next((o for o in question["options"] if o["id"] == option_id), None)
        if option is None:
            return jsonify({"error": "option_inconnue"}), 400
        question = option_question(question, option)

    context = {
        "utterance": utterance[:MAX_UTTERANCE],
        "history": history_from(body),
        "draft": str(body.get("draft") or "")[:MAX_UTTERANCE * 2],
        "current_value": body.get("current_value"),
        "concerne": body.get("concerne"),
        "memoire": memoire_from(body),
        "pending": str(body.get("pending") or "").strip()[:MAX_UTTERANCE],
    }
    try:
        result = llm.interpret(FORM, question, context)
    except llm.LLMUnavailable as e:
        return jsonify({"error": "llm_indisponible", "reason": str(e)}), 503
    return jsonify(result)


@app.post("/api/extract")
def extract():
    """Pendant que l'usager parle : réponse provisoire à la question en cours et informations pour les
    autres questions (mémoire). Rien n'est conservé : la mémoire vit dans le navigateur."""
    body = request.get_json(silent=True) or {}
    question = QUESTIONS.get(body.get("question_id"))
    segment = str(body.get("segment") or "").strip()
    if question is None:
        return jsonify({"error": "question_inconnue"}), 400
    if not segment:
        return jsonify({"error": "segment_vide"}), 400
    context = {
        "segment": segment[:MAX_UTTERANCE],
        "turn_text": str(body.get("turn_text") or "").strip()[:MAX_UTTERANCE],
        "history": history_from(body),
        "memoire": memoire_from(body),
        "concerne": body.get("concerne"),
    }
    try:
        return jsonify(llm.extract(FORM, question, context))
    except llm.LLMUnavailable as e:
        return jsonify({"error": "llm_indisponible", "reason": str(e)}), 503


@app.post("/api/navigate")
def navigate():
    """Retrouve la question que l'usager veut revoir (« la question sur le logement »)."""
    body = request.get_json(silent=True) or {}
    utterance = str(body.get("utterance") or "").strip()[:MAX_UTTERANCE]
    candidates = [
        {
            "numero": c.get("numero"),
            "id": str(c.get("id")),
            "question": QUESTIONS[str(c.get("id"))]["label"],
            "reponse": str(c.get("reponse") or "")[:300],
        }
        for c in (body.get("questions") or [])
        if isinstance(c, dict) and str(c.get("id")) in QUESTIONS
    ]
    if not utterance or not candidates:
        return jsonify({"error": "requete_incomplete"}), 400
    try:
        return jsonify(llm.find_question(candidates, utterance))
    except llm.LLMUnavailable as e:
        return jsonify({"error": "llm_indisponible", "reason": str(e)}), 503


@app.post("/api/cerfa-partie-b.pdf")
def cerfa_pdf():
    """Cerfa 15692*01 partie B rempli avec les réponses. Rien n'est conservé sur le serveur."""
    raw = request.form.get("answers") or "{}"
    try:
        answers = json.loads(raw)
    except json.JSONDecodeError:
        return jsonify({"error": "reponses_invalides"}), 400
    if not isinstance(answers, dict):
        return jsonify({"error": "reponses_invalides"}), 400
    # On ne garde que les réponses aux questions connues.
    answers = {k: v for k, v in answers.items() if k in QUESTIONS}
    pdf = pdf_cerfa.fill(answers)
    return send_file(
        BytesIO(pdf),
        mimetype="application/pdf",
        as_attachment=request.form.get("mode") == "download",
        download_name="demande-mdph-cerfa-15692-partie-b.pdf",
    )


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8000"))
    app.run(host="127.0.0.1", port=port, debug=bool(os.environ.get("DEBUG")))
