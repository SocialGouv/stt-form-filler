#!/usr/bin/env bash
# Chiffre les secrets de l'environnement de développement de la fabrique (cluster OVH dev) en
# SealedSecret : .kontinuous/env/dev/templates/app.sealed-secret.yaml (versionnable, illisible sans le cluster).
#
# Les valeurs viennent de .env (ou de l'environnement) et ne sont jamais affichées :
#   OPENAI_API_KEY, ACCES_IDENTIFIANT, ACCES_MOT_DE_PASSE
#
# Prérequis : kubectl, kubeseal (brew install kubeseal), accès Rancher fabrique.
# Contexte kubectl : KUBE_CONTEXT (par défaut ovh-dev ; jamais ovh-prod).
set -euo pipefail
cd "$(dirname "$0")"

KUBE_CONTEXT="${KUBE_CONTEXT:-ovh-dev}"
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

# Certificat public du contrôleur sealed-secrets du cluster (aucune donnée sensible).
kubectl --context "$KUBE_CONTEXT" get --raw \
  /api/v1/namespaces/sealed-secrets-system/services/http:sealed-secrets-controller:8080/proxy/v1/cert.pem \
  > "$tmp/cert.pem"

# Fichier d'environnement temporaire (lisible par soi seul) : les valeurs ne passent pas en argument.
( umask 077; for cle in "${CLES[@]}"; do printf '%s=%s\n' "$cle" "${!cle}"; done > "$tmp/secret.env" )

kubectl create secret generic app-sealed-secret --dry-run=client -o yaml --from-env-file="$tmp/secret.env" \
  | kubeseal --cert "$tmp/cert.pem" --scope cluster-wide --format yaml > "$tmp/sealed.yaml"

mv "$tmp/sealed.yaml" "$SORTIE"
echo "Écrit : $SORTIE (clés : ${CLES[*]})"
