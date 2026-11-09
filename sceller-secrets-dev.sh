#!/usr/bin/env bash
# Chiffre les secrets de l'environnement de développement de la fabrique (cluster OVH dev) en
# SealedSecret : .kontinuous/env/dev/templates/app.sealed-secret.yaml (versionnable, illisible sans le cluster).
#
# Les valeurs viennent de .env (ou de l'environnement) et ne sont jamais affichées :
#   OPENAI_API_KEY, ACCES_IDENTIFIANT, ACCES_MOT_DE_PASSE
#
# Prérequis : kubectl, kubeseal (brew install kubeseal), curl. Aucun accès au cluster n'est nécessaire.
set -euo pipefail
cd "$(dirname "$0")"

# Contrôleur sealed-secrets du cluster OVH dev, celui que la CI (kontinuous) utilise pour vérifier.
KUBESEAL_URL="${KUBESEAL_URL:-https://kubeseal.ovh.fabrique.social.gouv.fr}"
SORTIE=.kontinuous/env/dev/templates/app.sealed-secret.yaml
CLES=(OPENAI_API_KEY ACCES_IDENTIFIANT ACCES_MOT_DE_PASSE)

command -v kubectl >/dev/null || { echo "kubectl introuvable." >&2; exit 1; }
command -v kubeseal >/dev/null || { echo "kubeseal introuvable : brew install kubeseal" >&2; exit 1; }

# Les variables déjà définies l'emportent sur .env (comme pour l'application).
if [[ -f .env ]]; then
  while IFS= read -r ligne || [[ -n "$ligne" ]]; do
    [[ "$ligne" =~ ^[[:space:]]*([A-Z_][A-Z0-9_]*)=(.*)$ ]] || continue
    cle="${BASH_REMATCH[1]}"; valeur="${BASH_REMATCH[2]}"
    valeur="${valeur%\"}"; valeur="${valeur#\"}"; valeur="${valeur%\'}"; valeur="${valeur#\'}"
    [[ -z "${!cle:-}" ]] && export "$cle=$valeur"
  done < .env
fi

for cle in "${CLES[@]}"; do
  [[ -n "${!cle:-}" ]] || { echo "$cle est vide (dans .env ou l'environnement)." >&2; exit 1; }
done

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
chmod 700 "$tmp"

# Certificat public du contrôleur (aucune donnée sensible). Ne pas le prendre par le proxy de service
# Rancher (kubectl get --raw …/proxy/v1/cert.pem) : il renvoie un autre certificat, refusé par la CI.
curl -fsS "$KUBESEAL_URL/v1/cert.pem" -o "$tmp/cert.pem"

# Fichier d'environnement temporaire (lisible par soi seul) : les valeurs ne passent pas en argument.
( umask 077; for cle in "${CLES[@]}"; do printf '%s=%s\n' "$cle" "${!cle}"; done > "$tmp/secret.env" )

kubectl create secret generic app-sealed-secret --dry-run=client -o yaml --from-env-file="$tmp/secret.env" \
  | kubeseal --cert "$tmp/cert.pem" --scope cluster-wide --format yaml > "$tmp/sealed.yaml"

# Même vérification que la CI : le contrôleur doit savoir déchiffrer (seul le texte chiffré est envoyé).
code="$(curl -sS -o /dev/null -w '%{http_code}' -X POST --data-binary @"$tmp/sealed.yaml" "$KUBESEAL_URL/v1/verify")"
[[ "$code" == 200 ]] || { echo "Vérification refusée par $KUBESEAL_URL (HTTP $code) : fichier non écrit." >&2; exit 1; }

mv "$tmp/sealed.yaml" "$SORTIE"
echo "Écrit : $SORTIE (clés : ${CLES[*]})"
