#!/usr/bin/env bash
# Wrapper del cron: carga .env (credenciales Cloudflare) y ejecuta el exportador.
cd "$(dirname "$0")"
set -a; [ -f .env ] && . ./.env; set +a
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
exec .venv/bin/python -m exporter.run
