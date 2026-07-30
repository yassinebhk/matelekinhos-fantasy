#!/usr/bin/env bash
# Publica la carpeta web/ en Cloudflare Pages.
#
# Primera vez (interactivo, abre el navegador para autorizar):
#   npm i -g wrangler
#   wrangler login
#   CF_PROJECT=matelekinhos-fantasy ./deploy.sh        # crea el proyecto la 1a vez
#
# Desatendido (para el cron): exporta un API token y el account id y no pide navegador:
#   export CLOUDFLARE_API_TOKEN=xxxxx
#   export CLOUDFLARE_ACCOUNT_ID=xxxxx
#   export CF_PROJECT=matelekinhos-fantasy
#   ./deploy.sh
set -euo pipefail
cd "$(dirname "$0")"
# launchd/cron traen un PATH mínimo; aseguramos que wrangler/node estén disponibles
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
PROJECT="${CF_PROJECT:-matelekinhos-fantasy}"
WR="$(command -v wrangler || true)"
[ -n "$WR" ] || WR="npx --yes wrangler@latest"
echo "→ Desplegando web/ a Cloudflare Pages (proyecto: $PROJECT)…"
$WR pages deploy web \
    --project-name "$PROJECT" \
    --commit-dirty=true \
    --branch=main
echo "✓ Publicado. Recuerda proteger el proyecto con Cloudflare Access (Zero Trust)."
