# Générateur de la documentation

Produit `docs/Formulaire-MDPH-partie-B_specifications-et-notice-technique.pdf`. Prérequis : serveur lancé (`.venv/bin/python app.py`), Playwright avec Chrome installé (`pip install playwright`), macOS (pour `sips`).

```bash
D=/chemin/vers/un/dossier/de/travail; mkdir -p $D/img
python captures.py $D/img                      # captures d'écran du site (port 8000), micro et voix simulés
../../.venv/bin/python cerfa.py $D/img         # page 6 du Cerfa rempli (réponses fictives), avec pypdf
../../.venv/bin/python build.py $D             # écrit $D/document.html (lit static/form-b.json)
python print.py $D/document.html ../Formulaire-MDPH-partie-B_specifications-et-notice-technique.pdf
```

`build.py` contient le texte du document : le mettre à jour quand le site change. `captures.py` décrit les écrans à capturer : l'adapter si les identifiants de la page changent.
