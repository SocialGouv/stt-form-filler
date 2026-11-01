"""Extraction des faits (mémoire « le dire une fois ») : seuls des faits vérifiables sont gardés."""
import pytest

import app
import llm

FORM = app.FORM
SEGMENT = "je vis tout seul et je touche l'AAH depuis mars 2021, j'ai un chien"


def fact(**kw):
    base = {"qid": None, "fact": "", "selected": [], "none_apply": False, "yes_no": "inconnu",
            "date": None, "number": None, "text": None, "quote": "", "replaces": None}
    return {**base, **kw}


def sanitize(facts, current="concerne", source=SEGMENT, known=()):
    return llm.sanitize_facts(FORM, current, facts, source, set(known))


def test_fait_valide_garde():
    kept, rejected = sanitize([fact(qid="vit_avec", fact="Vit seul", selected=["seul"], quote="je vis tout seul")])
    assert rejected == []
    assert kept == [{"qid": "vit_avec", "fact": "Vit seul", "quote": "je vis tout seul", "replaces": None,
                     "selected": ["seul"], "none_apply": False, "yes_no": None, "date": None,
                     "number": None, "text": None}]


def test_citation_absente_refusee():
    kept, rejected = sanitize([fact(qid="vit_avec", selected=["couple"], quote="je vis avec ma femme")])
    assert kept == []
    assert rejected[0]["reason"] == "citation_absente"


def test_citation_comparee_sans_accents_ni_ponctuation():
    kept, _ = sanitize([fact(qid="vit_avec", selected=["seul"], quote="Je vis, TOUT seul !")])
    assert len(kept) == 1


def test_question_inconnue_refusee():
    kept, rejected = sanitize([fact(qid="pas_une_question", fact="x", quote="je vis tout seul")])
    assert kept == [] and rejected[0]["reason"] == "question_inconnue"


def test_option_invalide_retiree_et_fait_sans_valeur_refuse():
    kept, rejected = sanitize([fact(qid="vit_avec", selected=["chateau"], quote="je vis tout seul")])
    assert kept == [] and rejected[0]["reason"] == "valeur_invalide"
    kept, _ = sanitize([fact(qid="vit_avec", selected=["chateau", "seul"], quote="je vis tout seul")])
    assert kept[0]["selected"] == ["seul"]


def test_question_en_cours_refusee():
    kept, rejected = sanitize([fact(qid="vit_avec", selected=["seul"], quote="je vis tout seul")], current="vit_avec")
    assert kept == [] and rejected[0]["reason"] == "question_en_cours"


def test_replaces_inconnu_annule_et_connu_garde():
    f = fact(qid="vit_avec", selected=["seul"], quote="je vis tout seul", replaces="f9")
    assert sanitize([f])[0][0]["replaces"] is None
    assert sanitize([f], known={"f9"})[0][0]["replaces"] == "f9"


def test_fait_libre_sans_question():
    kept, _ = sanitize([fact(qid=None, fact="A un chien", quote="j'ai un chien")])
    assert kept[0]["qid"] is None and kept[0]["fact"] == "A un chien"
    kept, rejected = sanitize([fact(qid=None, fact="", quote="j'ai un chien")])
    assert kept == [] and rejected[0]["reason"] == "vide"


def test_date_mal_formee_refusee():
    date_q = next(q["id"] for q in FORM["questions"] if q["type"] == "date")
    kept, rejected = sanitize([fact(qid=date_q, date="mars 2021", quote="depuis mars 2021")])
    assert kept == [] and rejected[0]["reason"] == "valeur_invalide"
    kept, _ = sanitize([fact(qid=date_q, date="01/03/2021", quote="depuis mars 2021")])
    assert kept[0]["date"] == "01/03/2021"


def test_tableau_pas_extrait():
    table_q = next(q["id"] for q in FORM["questions"] if q["type"] == "table")
    kept, rejected = sanitize([fact(qid=table_q, fact="AAH", quote="je touche l'AAH")])
    assert kept == [] and rejected[0]["reason"] == "valeur_invalide"


def test_extract_renvoie_courant_et_faits(monkeypatch):
    seen = {}

    def fake(system_text, user_text, schema, cache=False):
        seen["schema"] = schema
        return {"current": {"selected": ["seul", "inconnue"], "none_apply": False, "yes_no": "inconnu",
                            "date": None, "number": None, "text": None, "precisions": [], "complete": True},
                "facts": [fact(qid="concerne", selected=["moi"], quote="je vis tout seul"),
                          fact(qid="vit_avec", selected=["seul"], quote="je vis tout seul")]}

    monkeypatch.setattr(llm, "_complete", fake)
    out = llm.extract(FORM, app.QUESTIONS["vit_avec"], {"segment": "je vis tout seul", "memoire": []})
    assert seen["schema"] is llm.EXTRACT_SCHEMA
    assert out["current"]["selected"] == ["seul"] and out["current"]["complete"] is True
    assert [f["qid"] for f in out["facts"]] == ["concerne"]
    assert out["rejected"][0]["reason"] == "question_en_cours"


@pytest.fixture
def client():
    app.app.config["TESTING"] = True
    return app.app.test_client()


def test_api_extract_requete_invalide(client):
    assert client.post("/api/extract", json={"question_id": "nope", "segment": "x"}).status_code == 400
    assert client.post("/api/extract", json={"question_id": "vit_avec", "segment": " "}).status_code == 400


def test_api_extract_llm_indisponible(client, monkeypatch):
    def down(*a, **k):
        raise llm.LLMUnavailable("connection")

    monkeypatch.setattr(llm, "_complete", down)
    res = client.post("/api/extract", json={"question_id": "vit_avec", "segment": "je vis seul"})
    assert res.status_code == 503 and res.get_json()["error"] == "llm_indisponible"


def test_api_memoire_nettoyee(client, monkeypatch):
    seen = {}

    def fake(system_text, user_text, schema, cache=False):
        seen["user_text"] = user_text
        return {"current": {}, "facts": []}

    monkeypatch.setattr(llm, "_complete", fake)
    res = client.post("/api/extract", json={
        "question_id": "vit_avec", "segment": "je vis seul",
        "memoire": [{"id": "f1", "qid": "inconnue", "text": "x"}, {"qid": "vit_avec"}, "bad"],
    })
    assert res.status_code == 200
    assert '"id": "f1"' in seen["user_text"] and '"qid": null' in seen["user_text"]


def test_interpret_renvoie_les_faits(client, monkeypatch):
    def fake(system_text, user_text, schema, cache=False):
        assert "texte_a_extraire" in user_text
        return {"intent": "answer", "selected": ["moi"], "complete": True, "message": "Noté.",
                "facts": [fact(qid="vit_avec", selected=["seul"], quote="je vis tout seul"),
                          fact(qid="vit_avec", selected=["seul"], quote="mot jamais dit")]}

    monkeypatch.setattr(llm, "_complete", fake)
    res = client.post("/api/interpret", json={
        "question_id": "concerne", "utterance": "pour moi, je vis tout seul", "pending": "je vis tout seul"})
    body = res.get_json()
    assert body["selected"] == ["moi"]
    assert [f["qid"] for f in body["facts"]] == ["vit_avec"]
    assert body["rejected"][0]["reason"] == "citation_absente"


def test_status_drapeau_debug(client, monkeypatch):
    monkeypatch.setenv("MEMOIRE_DEBUG", "1")
    assert client.get("/api/status").get_json()["debug_memoire"] is True
    monkeypatch.delenv("MEMOIRE_DEBUG")
    assert client.get("/api/status").get_json()["debug_memoire"] is False


def test_condition_deduite_d_une_question_conditionnelle():
    # « Chez qui vivez-vous ? » n'existe que si « Où vivez-vous ? » = hébergé.
    kept, _ = sanitize([fact(qid="hebergeur", fact="Chez ses parents", selected=["parents"], quote="je vis tout seul")],
                       current="vit_avec")
    assert [(f["qid"], f["selected"]) for f in kept] == [("hebergeur", ["parents"]), ("lieu_vie", ["heberge"])]
    assert kept[1]["quote"] == "je vis tout seul"


def test_condition_pas_deduite_pour_la_question_en_cours_ni_en_double():
    f = fact(qid="hebergeur", selected=["parents"], quote="je vis tout seul")
    assert [k["qid"] for k in sanitize([f], current="lieu_vie")[0]] == ["hebergeur"]
    other = fact(qid="lieu_vie", selected=["autre"], quote="je vis tout seul")
    kept, _ = sanitize([f, other], current="vit_avec")
    assert [(k["qid"], k["selected"]) for k in kept] == [("hebergeur", ["parents"]), ("lieu_vie", ["autre"])]


def test_condition_multi_et_texte():
    # Une précision « Autre situation » implique l'option « Autre » de la question à choix multiple.
    kept, _ = sanitize([fact(qid="vit_avec_autre", text="Avec mon oncle", quote="je vis tout seul")], current="concerne")
    assert [(k["qid"], k["selected"]) for k in kept] == [("vit_avec_autre", []), ("vit_avec", ["autre"])]


def test_extract_citation_a_cheval_sur_deux_morceaux(monkeypatch):
    # « je ne peux plus | monter les escaliers » : coupé entre deux envois, la citation est cherchée dans tout le tour.
    def fake(system_text, user_text, schema, cache=False):
        return {"current": {}, "facts": [fact(qid="besoins_deplacement", selected=["domicile"],
                                              quote="je ne peux plus monter les escaliers")]}

    monkeypatch.setattr(llm, "_complete", fake)
    out = llm.extract(FORM, app.QUESTIONS["vit_avec"], {
        "segment": "monter les escaliers", "turn_text": "je vis seul et je ne peux plus monter les escaliers", "memoire": []})
    assert [f["qid"] for f in out["facts"]] == ["besoins_deplacement"]


def test_interpret_citation_avant_le_texte_a_extraire(client, monkeypatch):
    def fake(system_text, user_text, schema, cache=False):
        return {"intent": "answer", "selected": ["moi"], "complete": True, "message": "",
                "facts": [fact(qid="besoins_deplacement", selected=["domicile"], quote="je ne peux plus monter les escaliers sans aide")]}

    monkeypatch.setattr(llm, "_complete", fake)
    body = client.post("/api/interpret", json={
        "question_id": "concerne", "utterance": "pour moi, je ne peux plus monter les escaliers sans aide donc voilà",
        "pending": "aide donc voilà"}).get_json()
    assert [f["qid"] for f in body["facts"]] == ["besoins_deplacement"]
