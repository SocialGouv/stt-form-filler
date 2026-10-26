"""Image de la page 6 du Cerfa rempli (réponses fictives) pour la documentation (serveur sur le port 8000).

Usage : python cerfa.py DOSSIER_IMAGES   (macOS : la page est convertie en PNG par « sips »)
"""
import io
import json
import subprocess
import sys
import tempfile
import urllib.parse
import urllib.request
from pathlib import Path

from pypdf import PdfReader, PdfWriter

D = Path(sys.argv[1])
REPONSES = {
    "concerne": "moi", "vit_avec": ["seul"], "lieu_vie": "logement_independant", "statut_logement": "locataire",
    "accidents": ["aucun"], "aides_recues": ["aah"], "revenus_12mois": ["ij"], "ij_du": "01/03/2026",
    "pension_invalidite": "cat2", "pension_invalidite_depuis": "15/06/2019", "autres_pensions": ["aucun"],
    "aide_technique": ["aides_techniques"], "aides_techniques_details": "Déambulateur",
    "aide_personne": ["famille"],
    "frais": [{"frais": "Protections", "frequence": "Chaque mois", "montant_total": "45", "montant_rembourse": "10", "precisions": ""}],
}
data = urllib.parse.urlencode({"answers": json.dumps(REPONSES), "mode": "view"}).encode()
pdf = urllib.request.urlopen("http://127.0.0.1:8000/api/cerfa-partie-b.pdf", data).read()

# Page 6 du Cerfa = deuxième page du PDF produit (pages 5 à 8).
writer = PdfWriter()
writer.add_page(PdfReader(io.BytesIO(pdf)).pages[1])
with tempfile.TemporaryDirectory() as tmp:
    page = Path(tmp) / "page6.pdf"
    with page.open("wb") as f:
        writer.write(f)
    subprocess.run(["sips", "-s", "format", "png", "-Z", "1600", str(page), "--out", str(D / "16_cerfa.png")],
                   check=True, capture_output=True)
print("16_cerfa.png écrite")
