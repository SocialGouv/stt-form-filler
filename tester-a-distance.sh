#!/bin/bash
# Rend le site accessible à des testeurs à distance, en HTTPS, via un tunnel Cloudflare.
# La clé Albert reste sur cet ordinateur (fichier .env) : les testeurs n'y ont jamais accès.
# Accès protégé par identifiant et mot de passe seulement si ACCES_IDENTIFIANT et
# ACCES_MOT_DE_PASSE sont remplis dans .env ; sinon, toute personne qui a le lien peut l'utiliser.
# Arrêt : Ctrl+C (le tunnel se ferme ; l'adresse ne fonctionne plus).
set -euo pipefail
cd "$(dirname "$0")"

PROTEGE=0
grep -q '^ACCES_MOT_DE_PASSE=.\+' .env && grep -q '^ACCES_IDENTIFIANT=.\+' .env && PROTEGE=1

# Serveur : lancé s'il ne tourne pas déjà.
if ! lsof -ti :8000 >/dev/null 2>&1; then
  echo "Démarrage du serveur…"
  .venv/bin/python app.py > serveur.log 2>&1 &
  SERVEUR=$!
  trap 'kill $SERVEUR 2>/dev/null' EXIT
  sleep 3
fi

echo "Ouverture du tunnel (l'adresse change à chaque lancement)…"
# caffeinate : le Mac ne se met pas en veille tant que le tunnel est ouvert.
caffeinate -i outils/cloudflared tunnel --no-autoupdate --url http://localhost:8000 2>&1 | while read -r ligne; do
  if [[ "$ligne" =~ (https://[a-z0-9-]+\.trycloudflare\.com) ]]; then
    echo
    echo "  Adresse à envoyer aux testeurs : ${BASH_REMATCH[1]}"
    if [ "$PROTEGE" = 1 ]; then
      echo "  Identifiant : $(grep '^ACCES_IDENTIFIANT=' .env | cut -d= -f2-)"
      echo "  Mot de passe : $(grep '^ACCES_MOT_DE_PASSE=' .env | cut -d= -f2-)"
    else
      echo "  Accès libre : toute personne qui a ce lien peut utiliser le site (et votre quota Albert)."
      echo "  Ne le transmettez qu'aux testeurs."
    fi
    echo
    echo "  Laissez cette fenêtre ouverte pendant les tests. Ctrl+C pour fermer l'accès."
  fi
done
