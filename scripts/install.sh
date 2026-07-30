#!/usr/bin/env bash
# Instalador de un solo comando. Hace todo lo automatizable por ti.
# Uso:  bash scripts/install.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
PLIST_LABEL="com.laliga.fantasy.exporter"
PLIST_DST="$HOME/Library/LaunchAgents/$PLIST_LABEL.plist"

echo "==> Proyecto en: $ROOT"

# 1) Python + entorno virtual aislado
command -v python3 >/dev/null || { echo "Falta python3. Instálalo (brew install python)."; exit 1; }
echo "==> Creando entorno virtual (.venv) e instalando dependencias..."
python3 -m venv .venv
./.venv/bin/pip install --quiet --upgrade pip
./.venv/bin/pip install --quiet -r requirements.txt
PY="$ROOT/.venv/bin/python"

# 2) Config
if [ ! -f config.json ]; then
  cp config.example.json config.json
fi
if grep -q "TU_EMAIL_DE_LALIGA_FANTASY" config.json; then
  echo ""
  echo "*** ACCIÓN REQUERIDA ***"
  echo "Abre 'config.json' y pon tu email y contraseña de LaLiga Fantasy."
  echo "   -> $ROOT/config.json"
  echo "(Si entras con Google/Apple: deja email/password vacíos, guarda, y ejecuta"
  echo " una vez  $ROOT/.venv/bin/python -m exporter.login  antes de reejecutar esto.)"
  echo "Cuando lo guardes, vuelve a ejecutar:  bash scripts/install.sh"
  exit 0
fi

# 3) Primera ejecución (login + primer snapshot + primera web)
echo "==> Primera ejecución (login y primer volcado)..."
if "$PY" -m exporter.run --once-verbose; then
  echo "==> Export OK."
else
  echo ""
  echo "La primera ejecución falló. Suele ser por credenciales o por login social."
  echo "  - Si entras con Google/Apple: ejecuta   $PY -m exporter.login   una vez."
  echo "  - Si es email/contraseña: revisa config.json."
  echo "Puedes reintentar cuando quieras. El agente igualmente queda instalado abajo."
fi

# 4) Agente launchd: ejecuta el exporter cada 5 min (sin terminal)
echo "==> Instalando agente launchd (cada 5 min)..."
mkdir -p "$HOME/Library/LaunchAgents"
cat > "$PLIST_DST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>Label</key><string>$PLIST_LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$PY</string>
    <string>-m</string>
    <string>exporter.run</string>
  </array>
  <key>WorkingDirectory</key><string>$ROOT</string>
  <key>StartInterval</key><integer>300</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>$ROOT/exporter.log</string>
  <key>StandardErrorPath</key><string>$ROOT/exporter.log</string>
</dict>
</plist>
PLIST

launchctl unload "$PLIST_DST" 2>/dev/null || true
launchctl load "$PLIST_DST"
echo "==> Agente cargado. Logs en: $ROOT/exporter.log"

echo ""
echo "==> LISTO."
echo "    Abre el panel:  open \"$ROOT/web/index.html\""
echo "    Parar el agente: launchctl unload \"$PLIST_DST\""
