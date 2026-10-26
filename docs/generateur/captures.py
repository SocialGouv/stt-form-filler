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
    pg.click("#btn-start")
    pg.wait_for_timeout(1200)


def menu(pg, etape, qid):
    """Ouvre une question par le menu latéral (sur mobile, le menu est d'abord déplié)."""
    if pg.is_visible("[aria-controls='menu-questions']"):
        pg.click("[aria-controls='menu-questions']")
        pg.wait_for_timeout(400)
    if pg.get_attribute(f"#menu-btn-{etape}", "aria-expanded") != "true":
        pg.click(f"#menu-btn-{etape}")
        pg.wait_for_timeout(500)
    pg.click(f"#menu-etape-{etape} a[data-qid={qid}]")
    pg.wait_for_timeout(700)


def suivante(pg):
    pg.click("#btn-suivant")
    pg.wait_for_timeout(500)


def net(pg):
    pg.mouse.move(1, 1)
    pg.wait_for_timeout(300)


def colonne(pg):
    """Colonne de droite de l'écran des questions."""
    return pg.locator("#espace .fr-col-md-8")


with sync_playwright() as p:
    b = p.chromium.launch(channel="chrome", headless=True)

    # Accueil, réglages, reprise
    ctx, pg = page(b)
    pg.screenshot(path=D / "01_accueil.png", full_page=True)
    pg.click("#btn-reglages")
    pg.wait_for_timeout(800)
    pg.locator("#modal-reglages .fr-modal__body").screenshot(path=D / "02_reglages.png")
    pg.keyboard.press("Escape")
    start(pg)
    pg.check("#concerne__moi", force=True)
    suivante(pg)
    pg.goto(URL)
    pg.wait_for_timeout(900)
    pg.locator("#accueil > div").first.screenshot(path=D / "03_reprise.png")
    ctx.close()

    # Écran des questions (ordinateur) : quelques réponses, menu à jour
    ctx, pg = page(b)
    start(pg)
    pg.check("#concerne__moi", force=True)
    suivante(pg)
    pg.check("#vit_avec__seul", force=True)
    suivante(pg)
    suivante(pg)  # « Où vivez-vous ? » passée sans réponse : signalée dans le menu
    net(pg)
    pg.screenshot(path=D / "04_questions.png", full_page=True)
    # Infobulle (version simplifiée de la question)
    pg.click("#titre-accidents button")
    pg.wait_for_timeout(400)
    r = pg.locator("#q-accidents").bounding_box()  # l'infobulle s'affiche au-dessus du titre
    pg.screenshot(path=D / "05_infobulle.png", clip={"x": r["x"] - 8, "y": r["y"] - 70, "width": r["width"] + 16, "height": 200})
    pg.keyboard.press("Escape")
    # Champ de précision sous « Autre »
    menu(pg, 0, "vit_avec")
    pg.check("#vit_avec__autre", force=True)
    pg.fill("#field-vit_avec_autre", "Avec mon frère")
    pg.dispatch_event("#field-vit_avec_autre", "change")
    net(pg)
    pg.locator("#q-vit_avec").screenshot(path=D / "06_precision.png")
    # Date en trois champs, avec une erreur
    menu(pg, 1, "revenus_12mois")
    pg.check("#revenus_12mois__ij", force=True)
    suivante(pg)
    pg.fill("#ij_du__jour", "15")
    pg.fill("#ij_du__annee", "2024")
    pg.keyboard.press("Tab")
    net(pg)
    pg.locator("#q-ij_du").screenshot(path=D / "07_date.png")
    # Frais : un bloc par frais
    menu(pg, 2, "frais")
    pg.fill("#frais__0__frais", "Protections")
    pg.fill("#frais__0__frequence", "Chaque mois")
    pg.fill("#frais__0__montant_total", "45")
    pg.fill("#frais__0__montant_rembourse", "10")
    pg.click("[data-ajouter=frais]")
    pg.keyboard.type("Séances de psychologue")
    pg.keyboard.press("Tab")
    net(pg)
    pg.locator("#q-frais").screenshot(path=D / "08_frais.png")
    ctx.close()

    # Écoute (micro simulé) : bouton « J'ai fini de parler », transcription, lecteur de la voix
    ctx, pg = page(b, voix=True)
    start(pg)
    pg.wait_for_function("document.getElementById('btn-mic').textContent.includes('fini')", timeout=60000)
    pg.evaluate("window.__dire = 'je vis avec ma fille et mon gendre'")
    pg.wait_for_function("!document.getElementById('transcription').hidden", timeout=30000)
    net(pg)
    colonne(pg).screenshot(path=D / "09_ecoute.png")
    ctx.close()

    # Mobile : écran des questions et menu déplié
    ctx, pg = page(b, 390, 844)
    start(pg)
    pg.check("#concerne__moi", force=True)
    suivante(pg)
    net(pg)
    pg.evaluate("scrollTo(0, 0)")
    pg.screenshot(path=D / "10_mobile_questions.png")
    pg.click("[aria-controls='menu-questions']")
    pg.wait_for_timeout(600)
    pg.locator("nav.fr-sidemenu").screenshot(path=D / "11_mobile_menu.png")
    ctx.close()

    # Fin : questions restantes, puis effacement (fenêtre de confirmation et message)
    ctx, pg = page(b)
    start(pg)
    pg.check("#concerne__moi", force=True)
    suivante(pg)
    pg.click("#menu-liste a[data-recap]")
    pg.wait_for_timeout(800)
    net(pg)
    pg.screenshot(path=D / "12_fin.png")
    pg.click("#btn-reprendre")
    pg.wait_for_timeout(800)
    net(pg)
    pg.locator("nav.fr-sidemenu").screenshot(path=D / "13_restantes.png")
    pg.click("#menu-liste a[data-recap]")
    pg.wait_for_timeout(800)
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
