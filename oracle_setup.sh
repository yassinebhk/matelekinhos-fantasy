#!/usr/bin/env bash
# ============================================================================
#  Ejecutar EN la VM de Oracle (Ubuntu), dentro de la carpeta del proyecto ya
#  copiada por scp (con config.json y .token.json presentes).
#  Deja el exportador corriendo 24/7 y auto-publicando en Cloudflare Pages.
#
#  Uso:   chmod +x oracle_setup.sh && ./oracle_setup.sh
# ============================================================================
set -euo pipefail
cd "$(dirname "$0")"

echo "==> 1/5 Dependencias del sistema…"
sudo apt-get update -y
sudo apt-get install -y python3-venv python3-pip curl
if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
sudo npm i -g wrangler >/dev/null 2>&1 || true

echo "==> 2/5 Entorno Python…"
python3 -m venv .venv
.venv/bin/pip install --quiet --upgrade pip
.venv/bin/pip install --quiet -r exporter/requirements.txt

echo "==> 3/5 Fichero de credenciales (.env)…"
if [ ! -f .env ]; then
  cat > .env <<'EOF'
FF_DEPLOY=1
CF_PROJECT=matelekinhos-fantasy
CLOUDFLARE_API_TOKEN=PEGA_AQUI_TU_TOKEN
CLOUDFLARE_ACCOUNT_ID=PEGA_AQUI_TU_ACCOUNT_ID
EOF
  chmod 600 .env
  echo "    -> Creado .env. EDÍTALO: pon tu CLOUDFLARE_API_TOKEN y CLOUDFLARE_ACCOUNT_ID."
else
  echo "    -> .env ya existe, no lo toco."
fi
chmod +x run_cron.sh deploy.sh 2>/dev/null || true

echo "==> 4/5 Cron cada 2 min…"
LINE="*/2 * * * * cd $(pwd) && ./run_cron.sh >> exporter.log 2>&1"
( crontab -l 2>/dev/null | grep -v 'run_cron.sh' ; echo "$LINE" ) | crontab -

echo "==> 5/5 Comprobación (una ejecución ahora)…"
./run_cron.sh || true
echo ""
echo "======================================================================"
echo " LISTO. Si en exporter.log ves 'deploy Cloudflare Pages OK', funciona."
echo " Si ves error de Cloudflare, revisa CLOUDFLARE_API_TOKEN/ACCOUNT_ID en .env."
echo " El cron ya corre cada 2 min y publica cada ~20 min de forma automática."
echo "======================================================================"
