#!/usr/bin/env bash
# Chiffre les secrets de l'environnement de développement de la fabrique (cluster OVH dev) en
# SealedSecret : .kontinuous/env/dev/templates/app.sealed-secret.yaml (versionnable, illisible sans le cluster).
#
# Les valeurs viennent de .env (ou de l'environnement) et ne sont jamais affichées :
#   OPENAI_API_KEY, ACCES_IDENTIFIANT, ACCES_MOT_DE_PASSE → app.sealed-secret.yaml (lu par l'application)
#   GIT_AUTH_TOKEN (facultatif) → git-auth.sealed-secret.yaml : jeton GitHub en lecture seule sur ce dépôt,
#   utilisé par la construction de l'image dans le cluster (dépôt privé ; voir gitAuthSecretName dans
#   .kontinuous/config.yaml).
#
# Prérequis : kubectl, kubeseal (brew install kubeseal), curl. Aucun accès au cluster n'est nécessaire.
set -euo pipefail
cd "$(dirname "$0")"

# Contrôleur sealed-secrets du cluster OVH dev, celui que la CI (kontinuous) utilise pour vérifier.
KUBESEAL_URL="${KUBESEAL_URL:-https://kubeseal.ovh.fabrique.social.gouv.fr}"
DOSSIER=.kontinuous/env/dev/templates
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

# sceller NOM_DU_SECRET FICHIER CLÉ... : chiffre les clés, vérifie comme la CI, puis écrit le fichier.
sceller() {
  local nom="$1" sortie="$DOSSIER/$2"; shift 2
  # Fichier d'environnement temporaire (lisible par soi seul) : les valeurs ne passent pas en argument.
  ( umask 077; for cle in "$@"; do printf '%s=%s\n' "$cle" "${!cle}"; done > "$tmp/$nom.env" )
  kubectl create secret generic "$nom" --dry-run=client -o yaml --from-env-file="$tmp/$nom.env" \
    | kubeseal --cert "$tmp/cert.pem" --scope cluster-wide --format yaml > "$tmp/$nom.yaml"
  # Même vérification que la CI : le contrôleur doit savoir déchiffrer (seul le texte chiffré est envoyé).
  local code
  code="$(curl -sS -o /dev/null -w '%{http_code}' -X POST --data-binary @"$tmp/$nom.yaml" "$KUBESEAL_URL/v1/verify")"
  [[ "$code" == 200 ]] || { echo "Vérification refusée par $KUBESEAL_URL (HTTP $code) : $sortie non écrit." >&2; exit 1; }
  mv "$tmp/$nom.yaml" "$sortie"
  echo "Écrit : $sortie (clés : $*)"
}

sceller app-sealed-secret app.sealed-secret.yaml "${CLES[@]}"
if [[ -n "${GIT_AUTH_TOKEN:-}" ]]; then
  sceller stt-form-filler-git-auth git-auth.sealed-secret.yaml GIT_AUTH_TOKEN
fi
