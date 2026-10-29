"""Captures d'écran du site pour la documentation (serveur lancé sur le port 8000).

Usage : python captures.py DOSSIER_IMAGES
Le micro est simulé (Chrome sans affichage n'en a pas) ; la voix est coupée pour aller vite.
"""
import sys
from pathlib import Path
from playwright.sync_api import sync_playwright

D = Path(sys.argv[1])
URL = "http://127.0.0.1:8000/"
PREFS = "localStorage.setItem('mdph-preferences-v1', JSON.stringify({speak: %s, handsfree: %s}))"
# Micro simulé : chaque écoute « entend » la phrase posée dans window.__dire, une seule fois.
MICRO = """window.__dire = null;
class R { start(){ const t = window.__dire; window.__dire = null; setTimeout(() => this.onstart && this.onstart(), 50);
  if (t) setTimeout(() => this.onresult && this.onresult({ results: [[{ transcript: t }]] }), 300);
  setTimeout(() => this.fin(), 700) }
  stop(){ this.fin() } abort(){ this.fin() } fin(){ if (this.f) return; this.f = 1; setTimeout(() => this.onend && this.onend(), 20) } }
window.SpeechRecognition = R; window.webkitSpeechRecognition = R;"""
# Voix simulée (lecture instantanée) : la ligne « Lecture terminée / Réécouter la question » s'affiche.
VOIX = """const synth = { cur: null, getVoices() { return []; }, addEventListener() {},
  speak(u) { this.cur = u; setTimeout(() => { this.cur = null; u.onend && u.onend(); }, 50); },
  cancel() { const u = this.cur; this.cur = null; u && u.onend && u.onend(); } };
Object.defineProperty(window, 'speechSynthesis', { value: synth });"""


def page(b, w=1280, h=900, voix=False):
    ctx = b.new_context(viewport={"width": w, "height": h}, device_scale_factor=2, bypass_csp=True, locale="fr-FR")
    ctx.add_init_script(MICRO)
    if voix:
        ctx.add_init_script(VOIX)
    ctx.add_init_script("if (!sessionStorage.x) { sessionStorage.x = 1; %s }" % (PREFS % (("true", "true") if voix else ("false", "false"))))
    pg = ctx.new_page()
    pg.route("**/api/tts", lambda r: r.abort())  # voix du navigateur simulée ci-dessus
    pg.goto(URL)
    pg.wait_for_timeout(900)
    return ctx, pg


def start(pg):
    """Accueil → « Avant de commencer » → première question."""
    pg.click("#btn-start")
    pg.wait_for_timeout(900)
    pg.click("#btn-commencer")
    pg.wait_for_timeout(1000)


def suivante(pg):
    pg.click("#btn-suivant")
    pg.wait_for_timeout(500)


def etape_suivante(pg):
    pg.click("#btn-etape-suiv")
    pg.wait_for_timeout(700)


def aller(pg, qid):
    """Avance avec « Question suivante » jusqu'à la question `qid`."""
    for _ in range(30):
        if pg.is_visible(f"#q-{qid}"):
            return
        suivante(pg)
    raise RuntimeError(f"question {qid} introuvable")


def net(pg):
    pg.mouse.move(1, 1)
    pg.wait_for_timeout(300)


with sync_playwright() as p:
    b = p.chromium.launch(channel="chrome", headless=True)

    # Accueil, réglages, « Avant de commencer », reprise
    ctx, pg = page(b)
    pg.screenshot(path=D / "01_accueil.png", full_page=True)
    pg.click("#btn-reglages")
    pg.wait_for_timeout(800)
    pg.locator("#modal-reglages .fr-modal__body").screenshot(path=D / "02_reglages.png")
    pg.keyboard.press("Escape")
    pg.wait_for_timeout(400)
    pg.click("#btn-start")
    pg.wait_for_timeout(900)
    net(pg)
    pg.screenshot(path=D / "04_avant.png", full_page=True)
    pg.click("#btn-commencer")
    pg.wait_for_timeout(1000)
    pg.check("#concerne__moi", force=True)
    suivante(pg)
    pg.goto(URL)
    pg.wait_for_timeout(900)
    pg.locator("#accueil > div").first.screenshot(path=D / "03_reprise.png")
    ctx.close()

    # Écran des questions (ordinateur)
    ctx, pg = page(b)
    start(pg)
    pg.check("#concerne__moi", force=True)
    suivante(pg)
    # Champ de précision sous « Autre »
    pg.check("#vit_avec__autre", force=True)
    pg.fill("#field-vit_avec_autre", "Avec mon frère")
    pg.dispatch_event("#field-vit_avec_autre", "change")
    net(pg)
    pg.locator("#q-vit_avec").screenshot(path=D / "06_precision.png")
    suivante(pg)
    # Question de suivi, dans la même carte : « Propriétaire ou locataire » sous « Où vivez-vous ? »
    pg.check("#lieu_vie__logement_independant", force=True)
    pg.wait_for_timeout(400)
    net(pg)
    pg.locator("#q-lieu_vie").screenshot(path=D / "07_suivi.png")
    aller(pg, "accidents")
    # Infobulle (version simplifiée de la question)
    pg.click("#titre-accidents button")
    pg.wait_for_timeout(400)
    # Cadre : l'infobulle (au-dessus ou au-dessous du titre) et le début de la question.
    t = pg.locator("#infobulle-accidents").bounding_box()
    q = pg.locator("#q-accidents").bounding_box()
    y0 = min(t["y"], q["y"]) - 16
    y1 = max(t["y"] + t["height"], q["y"] + 140) + 16
    pg.screenshot(path=D / "08_infobulle.png", clip={"x": q["x"] - 8, "y": y0, "width": q["width"] + 16, "height": y1 - y0})
    pg.keyboard.press("Escape")
    # Étape suivante, avec des questions restées sans réponse : bandeau orange
    etape_suivante(pg)
    net(pg)
    pg.evaluate("scrollTo(0, 0)")
    pg.screenshot(path=D / "05_questions.png", full_page=True)
    # Date en trois champs, avec une erreur (question de suivi des indemnités journalières)
    aller(pg, "revenus_12mois")
    pg.check("#revenus_12mois__ij", force=True)
    pg.wait_for_timeout(400)
    pg.fill("#ij_du__jour", "15")
    pg.fill("#ij_du__annee", "2024")
    # Sans Tab : le focus irait sur l'infobulle de la question suivante, qui s'ouvrirait sur la capture.
    pg.dispatch_event("#ij_du__annee", "change")
    pg.evaluate("document.activeElement.blur()")
    net(pg)
    pg.locator("#q-ij_du").screenshot(path=D / "09_date.png")
    # Frais : un bloc par frais
    etape_suivante(pg)
    aller(pg, "frais")
    pg.fill("#frais__0__frais", "Protections")
    pg.fill("#frais__0__frequence", "Chaque mois")
    pg.fill("#frais__0__montant_total", "45")
    pg.fill("#frais__0__montant_rembourse", "10")
    pg.click("[data-ajouter=frais]")
    pg.keyboard.type("Séances de psychologue")
    pg.keyboard.press("Tab")
    net(pg)
    pg.locator("#q-frais").screenshot(path=D / "10_frais.png")
    ctx.close()

    # Écoute (micro simulé) : bouton « J'ai fini de parler », transcription, lecteur de la voix
    ctx, pg = page(b, voix=True)
    pg.evaluate("window.__dire = 'on commence'")
    pg.click("#btn-start")
    pg.wait_for_selector("#espace:not([hidden])", timeout=30000)
    pg.wait_for_function("document.getElementById('btn-mic').textContent.includes('fini')", timeout=60000)
    pg.evaluate("window.__dire = 'c’est pour moi'")
    pg.wait_for_function("!document.getElementById('transcription').hidden", timeout=30000)
    net(pg)
    pg.locator("#espace").screenshot(path=D / "11_ecoute.png")
    ctx.close()

    # Mobile : écran des questions
    ctx, pg = page(b, 390, 844)
    start(pg)
    pg.check("#concerne__moi", force=True)
    suivante(pg)
    net(pg)
    pg.evaluate("scrollTo(0, 0)")
    pg.screenshot(path=D / "12_mobile_questions.png")
    ctx.close()

    # Fin : « Imprimer ou enregistrer » avec des questions restantes, puis effacement
    ctx, pg = page(b)
    start(pg)
    pg.check("#concerne__moi", force=True)
    suivante(pg)
    for _ in range(5):
        etape_suivante(pg)
    pg.wait_for_selector("#recap:not([hidden])")
    net(pg)
    pg.screenshot(path=D / "13_fin.png")
    pg.click("#btn-effacer")
    pg.wait_for_timeout(800)
    net(pg)
    pg.locator("#modal-effacer .fr-modal__body").screenshot(path=D / "14_effacer.png")
    pg.click("#btn-effacer-oui")
    pg.wait_for_timeout(800)
    net(pg)
    pg.locator("#contenu").screenshot(path=D / "15_efface.png")
    ctx.close()
    b.close()
print("captures écrites dans", D)
