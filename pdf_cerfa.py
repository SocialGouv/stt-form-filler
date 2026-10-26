"""Remplissage de la partie B du Cerfa 15692*01 à partir des réponses du site.

Le PDF officiel (pdf/cerfa_15692-01.pdf) contient des champs de formulaire : on les
remplit, puis on ne garde que les pages de la partie B (5 à 8). Les champs restent
modifiables dans un lecteur PDF. Rien n'est enregistré sur le serveur.

Accessibilité (RGAA 13.3) : le Cerfa officiel est un PDF balisé. On retire les autres pages
du document lui-même, en élaguant son arbre de structure, plutôt que de copier les pages
dans un nouveau PDF (ce qui perdrait le balisage lu par les lecteurs d'écran).
"""
from io import BytesIO
from pathlib import Path

from pypdf import PdfWriter
from pypdf.generic import (
    ArrayObject, BooleanObject, DictionaryObject, IndirectObject, NameObject, NumberObject, TextStringObject,
)

CERFA = Path(__file__).parent / "pdf" / "cerfa_15692-01.pdf"
PAGES_B = (4, 8)  # pages 5 à 8 (indices de début inclus, de fin exclus)

NONE = "aucun"

# Cases à cocher : question → {option → champ du PDF}.
CHECKS = {
    "vit_avec": {
        "seul": "Situation Seul",
        "couple": "Situation En couple",
        "parents": "Situation Avec un parent (ou les deux)",
        "enfants": "Situation Avec votre enfant (ou l'un d'entre eux)",
        "autre": "Autre situation",
    },
    "lieu_vie": {
        "logement_independant": "Vous avez un logement indépendant",
        "etablissement": "Vous êtes dans un établissement médico social",
        "autre": "Autre situation Lieu de vie",
    },
    "statut_logement": {
        "proprietaire": "Vous êtes propriétaire",
        "locataire": "Vous êtes locataire",
    },
    "hebergeur": {
        "parents": "Vous êtes hébergé au domicile de vos parents",
        "enfants": "Vous êtes hébergé au domicile de vos enfants",
        "ami": "Vous êtes hébergé au domicile d'un ami",
        "famille": "Vous êtes hébergé au domicile d'un autre membre de votre famille",
        "famille_accueil": "Vous êtes hébergé au domicile d'une famille d'accueil",
    },
    "accidents": {
        "tiers": "Accident causé par un tiers",
        "travail": "Accident du travail",
        "autre": "Autre type d'accident",
    },
    "aides_recues": {
        "aah": "Vous recevez l'AAH",
        "rsa": "Vous recevez le RSA",
        "chomage": "Vous recevez l'Allocation chômage",
        "ass": "Vous recevez l'ASS",
    },
    "revenus_12mois": {
        "activite": "Dans les 12 mois précédents vous avez perçu un revenu d'activité",
        "esat": "Dans les 12 mois précédents vous avez perçu un revenu d'activité en ESAT",
        # Les indemnités journalières n'ont pas de case : seules les dates sont reportées.
    },
    "pension_invalidite": {
        "cat1": "Pension d'invalidité 1re catégorie",
        "cat2": "Pension d'invalidité 2e catégorie",
        "cat3": "Pension d'invalidité 3e catégorie",
    },
    "autres_pensions": {
        "autres_pensions": "Autres pensions de ce type",
        "majoration_tierce": "Majoration tierce personne",
        "asi": "Allocation supplémentaire d'invalidité",
        "rente_at": "Rente d'accident ou maladie professionnelle",
        "pctp": "Prestation complémentaire de recours à tierce personne",
        "retraite_inaptitude": "Retraite pour inaptitude dans la fonction publique ou anticipée",
    },
    "retraite": {
        "pension_retraite": "Pension de retraite",
        "aspa": "Vous êtes bénéficiaire de l'ASPA",
        "demande_retraite": "Vous avez demandé une pension de retraite",
        "apa": "Vous êtes bénéficiaire de l'APA",
    },
    "aide_technique": {
        "amenagement_logement": "Aménagement de logement",
        "amenagement_vehicule": "Aménagement de véhicule",
        "aides_animalieres": "Aides animalières",
        "aides_techniques": "Aides techniques",
        "autres": "Autre aide technique",
    },
    "aide_personne": {
        "famille": "Votre famille",
        "pro_soins": "Professionnel de soins à domicile",
        "medico_social": "Un accompagnement médico-social",
        "autres": "Autre aide à la personne",
    },
    "besoins_domicile": {
        "depenses": "Besoin pour régler les dépenses courantes",
        "budget": "Besoin pour gérer son budget",
        "hygiene": "Besoin pour l'hygiène corporelle",
        "habiller": "Besoin pour s'habiller",
        "courses": "Besoin pour faire les courses",
        "preparer_repas": "Besoin pour préparer les repas",
        "prendre_repas": "Besoin pour prendre les repas",
        "menage": "Besoin pour faire le ménage",
        "sante": "Besoin pour prendre soin de sa santé",
        "autre": "Autre besoin",
    },
    "besoins_deplacement": {
        "domicile": "Pour se déplacer dans le domicile",
        "sortir": "Pour sortir du domicile ou y entrer",
        "exterieur": "Pour se déplacer à l'extérieur du domicile",
        "vehicule": "Pour utiliser un véhicule",
        "transports": "Pour utiliser les transports en commun",
        "vacances": "Pour partir en vacances",
        "autre": "Autre situation p7",
    },
    "besoins_vie_sociale": {
        "exprimer": "Pour s'exprimer, se faire comprendre",
        "loisirs": "Pour avoir des activités sportives",
        "relations": "Pour les relations avec les autres",
        "famille": "Pour s'occuper de sa famille",
        "citoyennete": "Pour être accompagné dans la vie citoyenne",
        "securite": "Pour assurer sa sécurité",
        "autre": "Autre besoin p7",
    },
    "attentes": {
        "domicile": "Vivre à domicile",
        "etablissement": "Vivre en établissement",
        "amenagement": "Un aménagement du lieu de vie",
        "aide_humaine": "Une aide humaine",
        "deplacement": "Une aide pour se déplacer",
        "materiel": "Du matériel ou équipement",
        "financiere_depenses": "Une aide financière pour des dépenses liées au handicap",
        "readaptation": "Un accompagnement pour l'adaptation / réadaptation à la vie quotidienne",
        "accueil_temporaire": "Un accueil temporaire en établissement",
        "animaliere": "Une aide animalière",
        "bilan": "Réaliser un bilan des capacités dans la vie quotidienne",
        "revenu_minimum": "Une aide financière afin d'assurer un revenu minimum "
                          "(dans ce cas compléter également la partie D)",
        "autre": "Autre attente",
    },
}

# Case « chapeau » cochée dès qu'une option de la question est choisie.
GROUP_CHECKS = {
    "aide_technique": "Aide technique",
    "aide_personne": "Aide à la personne",
}

# Questions oui / non : question → (case Oui, case Non).
YESNO = {
    "indemnisation": ("Suite accident Demande d'indemnisation ? Oui", "Suite accident Demande d'indemnisation ? Non"),
    "parent_activite_reduite": (
        "Oui, j'exerce une activité professionnelle à temps partiel ou j'ai dû renoncer à mon emploi "
        "du fait du handicap de mon enfant",
        "Non, je n'exerce pas une activité professionnelle à temps partiel ou je n'ai pas dû renoncer "
        "à mon emploi du fait du handicap de mon enfant",
    ),
    "transports_adaptes": ("Utilisez-vous les transports adaptés ? Oui", "Utilisez-vous les transports adaptés ? Non"),
    "etablissement_identifie": (
        "Oui, j'ai un établissement qui répondrait à mes attentes ?",
        "Non, je n'ai pas d'établissement qui répondrait à mes attentes ?",
    ),
}

# Champs texte et nombres : question → champ.
TEXTS = {
    "vit_avec_autre": "Autre situation Préciser",
    "etablissement_details": "Établissement médico social Préciser",
    "lieu_vie_autre": "Autre situation Lieu de vie Préciser",
    "accident_autre": "Autre type d'accident Préciser",
    "indemnisation_organisme": "Demande en cours auprès de quel organisme ?",
    "taux_ipp": "Votre taux d'IPP",
    "aides_techniques_details": "Aides techniques Préciser",
    "aide_technique_details": "Autre aide technique Préciser",
    "aide_personne_autres": "Autre aide à la personne Préciser",
    "tierce_heures_semaine": "Temps rémunéré",
    "tierce_heures_an": "Nombre d'heures par an travaillées",
    "parent_quotite": "Quotité de temps partiel",
    "besoins_domicile_autre": "Autre besoin Préciser",
    "besoins_deplacement_autre": "Autre situation Préciser p7",
    "besoins_vie_sociale_autre": "Autre besoin Préciser p7",
    "attentes_autre": "Autre attente Préciser p7",
    "autres_renseignements": "Autres renseignements concernant votre vie quotidienne",
}

# Dates JJ/MM/AAAA : question → préfixe des trois champs « … Jour », « … Mois », « … Année ».
DATES = {
    "ij_du": "Indemnités journalières Début",
    "ij_au": "Indemnités journalières Fin",
    "pension_invalidite_depuis": "Pension d'invalidité Depuis date",
    "retraite_inaptitude_depuis": "Retraite inaptitude ou anticipée Depuis date",
    "retraite_depuis": "Vous êtes retraité Depuis date",
}

FRAIS_COLUMNS = {
    "frais": "Frais engagés",
    "frequence": "Fréquence",
    "montant_total": "Montant total",
    "montant_rembourse": "Montant remboursé",
    "precisions": "Précisions",
}


def _as_list(value):
    if isinstance(value, list):
        return [v for v in value if v != NONE]
    return [value] if value not in (None, "", NONE) else []


def _text(value):
    if value is None:
        return ""
    if isinstance(value, float) and value.is_integer():
        value = int(value)
    return str(value).strip()


def _yes(value):
    return str(value or "").strip().lower().startswith("o")


def field_values(answers):
    """Réponses du site → (cases à cocher à activer, {champ texte: valeur})."""
    checks, texts = set(), {}

    for qid, mapping in CHECKS.items():
        for opt in _as_list(answers.get(qid)):
            if opt in mapping:
                checks.add(mapping[opt])
    for qid, field in GROUP_CHECKS.items():
        if _as_list(answers.get(qid)):
            checks.add(field)
    for qid, (yes_field, no_field) in YESNO.items():
        value = answers.get(qid)
        if value == "oui":
            checks.add(yes_field)
        elif value == "non":
            checks.add(no_field)

    for qid, field in TEXTS.items():
        value = _text(answers.get(qid))
        if value:
            texts[field] = value
    for qid, prefix in DATES.items():
        parts = _text(answers.get(qid)).split("/")
        if len(parts) == 3:
            for suffix, part in zip(("Jour", "Mois", "Année"), parts):
                texts[f"{prefix} {suffix}"] = part

    for i, row in enumerate((answers.get("frais") or [])[:3], start=1):
        for col, label in FRAIS_COLUMNS.items():
            value = _text(row.get(col)) if isinstance(row, dict) else ""
            if value:
                texts[f"Ligne {i} {label}"] = value
    for i, row in enumerate((answers.get("etablissements") or [])[:2], start=1):
        if not isinstance(row, dict):
            continue
        name = _text(row.get("nom"))
        if name:
            texts[f"Ligne {i} Préciser l'établissement qui répondrait à vos attentes {i}"] = name
        contact = _text(row.get("en_contact"))
        if contact:
            checks.add(f"Ligne {i} En contact ? {'Oui' if _yes(contact) else 'Non'}")

    return checks, texts


def _field_name(annot):
    name = annot.get("/T")
    if name is None and "/Parent" in annot:
        name = annot["/Parent"].get_object().get("/T")
    return str(name) if name is not None else None


def _on_state(annot):
    """Nom de l'état « coché » d'une case (par exemple /Oui ou /Proprietaire)."""
    states = annot.get("/AP", {}).get("/N", {})
    return next((k for k in states.keys() if k != "/Off"), "/Oui")


def fill(answers):
    """Renvoie le PDF de la partie B rempli (octets)."""
    checks, texts = field_values(answers)

    writer = PdfWriter(clone_from=str(CERFA))
    known = set()
    for page in writer.pages[PAGES_B[0]:PAGES_B[1]]:
        for ref in page.get("/Annots", []):
            annot = ref.get_object()
            if annot.get("/Subtype") != "/Widget":
                continue
            name = _field_name(annot)
            known.add(name)
            target = annot if "/T" in annot else annot["/Parent"].get_object()
            if target.get("/FT") == "/Btn":
                # On repart d'une case vide, puis on coche celles qui correspondent aux réponses.
                state = _on_state(annot) if name in checks else "/Off"
                target[NameObject("/V")] = NameObject(state)
                annot[NameObject("/AS")] = NameObject(state)
            elif target.get("/FT") == "/Tx":
                target[NameObject("/V")] = TextStringObject(texts.get(name, ""))
        page_texts = {k: v for k, v in texts.items()}
        writer.update_page_form_field_values(page, page_texts, auto_regenerate=False)

    missing = (checks | set(texts)) - known
    if missing:
        raise KeyError(f"Champs absents du Cerfa : {sorted(missing)}")

    # Les lecteurs PDF recalculent l'affichage des champs (accents, texte long sur plusieurs lignes).
    writer.set_need_appearances_writer(True)
    _keep_only_part_b(writer)
    out = BytesIO()
    writer.write(out)
    return out.getvalue()


def _keep_only_part_b(writer):
    """Retire les pages hors partie B en gardant le balisage (structure, langue, titre)."""
    keep = {writer.pages[i].indirect_reference.idnum for i in range(*PAGES_B)}
    root = writer._root_object

    # 1. Arbre de structure : on garde les éléments des pages conservées.
    tree = root.get("/StructTreeRoot")
    if tree is not None:
        tree = tree.get_object()
        kids = _prune(tree.get("/K"), None, keep)
        if kids is None:
            del root[NameObject("/StructTreeRoot")]
        else:
            tree[NameObject("/K")] = kids

    # 2. Liste des champs du formulaire, reconstruite à partir des widgets des pages conservées.
    #    (Le fichier Cerfa contient aussi d'anciennes copies des champs, jamais affichées : certains
    #    lecteurs PDF les liraient à la place des champs remplis.)
    fields, seen = [], set()
    for i in range(*PAGES_B):
        annots = writer.pages[i].get("/Annots")
        for ref in (annots.get_object() if annots is not None else []):
            if ref.get_object().get("/Subtype") != "/Widget":
                continue
            top = ref
            while "/Parent" in top.get_object():
                top = top.get_object().raw_get("/Parent")
            if top.idnum not in seen:
                seen.add(top.idnum)
                fields.append(top)
    form = root.get("/AcroForm")
    if form is not None:
        form.get_object()[NameObject("/Fields")] = ArrayObject(fields)

    # 3. Pages hors partie B.
    for i in reversed(range(len(writer.pages))):
        if not PAGES_B[0] <= i < PAGES_B[1]:
            writer.remove_page(i, clean=True)

    # 4. Informations exigées pour un PDF accessible : langue, titre affiché, document balisé.
    root[NameObject("/Lang")] = TextStringObject("fr-FR")
    root[NameObject("/MarkInfo")] = DictionaryObject({NameObject("/Marked"): BooleanObject(True)})
    root[NameObject("/ViewerPreferences")] = DictionaryObject({NameObject("/DisplayDocTitle"): BooleanObject(True)})
    writer.add_metadata({"/Title": "Demande MDPH — Cerfa 15692*01 — partie B « Votre vie quotidienne »"})
    writer.compress_identical_objects(remove_identicals=False, remove_orphans=True)


def _page_id(node, inherited):
    pg = node.get("/Pg") if isinstance(node, DictionaryObject) else None
    return pg.idnum if isinstance(pg, IndirectObject) else inherited


def _prune(obj, page, keep):
    """Élément de structure (ou liste, ou contenu marqué) élagué aux pages `keep` ; None s'il est vide."""
    if obj is None:
        return None
    node = obj.get_object() if isinstance(obj, IndirectObject) else obj
    if isinstance(node, (int, NumberObject)):  # contenu marqué (MCID) de la page héritée
        return obj if page in keep else None
    if isinstance(node, ArrayObject):
        kept = [k for k in (_prune(x, page, keep) for x in node) if k is not None]
        return ArrayObject(kept) if kept else None
    if isinstance(node, DictionaryObject):
        pg = _page_id(node, page)
        if node.get("/Type") in ("/MCR", "/OBJR") or "/K" not in node:
            return obj if pg in keep or pg is None else None
        kids = _prune(node["/K"], pg, keep)
        if kids is None:
            return None
        node[NameObject("/K")] = kids
        return obj
    return obj

