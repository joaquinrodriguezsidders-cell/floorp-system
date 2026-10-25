#!/usr/bin/env bash
# ============================================================
# FLOORP SYSTEM - INSTALADOR DEFINITIVO (Linux / macOS)
#   Una vez por computadora, sin permisos de administrador.
#   Detecta el perfil de Floorp solo, copia el tema, deja la
#   home permanente y sideloada el XPI si hay firmado en dist/.
# ============================================================
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PID_MANIFEST="$ROOT/floorp-system-extension/manifest.json"

MODE=$(grep -o '"id":[[:space:]]*"[^"]*"' "$PID_MANIFEST" | head -1 | sed 's/.*"\(.*\)".*/\1/')

PROFILE_DIRS=()
for r in "$HOME/.floorp/profiles" "$HOME/.floorp" "$HOME/floorp/profiles"; do
  [ -d "$r" ] || continue
  for d in "$r"/*/; do
    [ -f "$d/prefs.js" ] && PROFILE_DIRS+=("$d")
  done
done

if [ ${#PROFILE_DIRS[@]} -eq 0 ]; then
  echo "  x No encontre perfiles de Floorp. Abri Floorp una vez, cerralo y volvé."
  exit 1
fi
echo "  ok - perfil(es): ${PROFILE_DIRS[*]}"

STAMP="$(date +%Y%m%d-%H%M%S)"
XPI_SIGNED="$ROOT/dist/floorp-system-signed.xpi"
XPI_FALLBACK="$(ls "$ROOT"/dist/floorp-system@*.xpi 2>/dev/null | head -1 || true)"

for p in ${PROFILE_DIRS[@]+"${PROFILE_DIRS[@]}"}; do
  echo "== $p"
  cp "$p/prefs.js" "$p/prefs.js.fsys-backup-$STAMP"
  echo "   backup prefs.js hecho"

  cp -r "$ROOT/chrome/." "$p/chrome/" 2>/dev/null || { mkdir -p "$p/chrome" && [ -d "$ROOT/chrome" ] && cp -r "$ROOT/chrome/." "$p/chrome/" || true; }
  echo "   tema copiado a chrome/"

  URL="file://$(realpath "$p/chrome/FLOORP-SYSTEM/index.html")"
  grep -v "floorp\.newtab\.overrides\.newtaburl" "$p/prefs.js" > "$p/prefs.js.tmp" || true
  echo "user_pref(\"floorp.newtab.overrides.newtaburl\", \"$URL\");" >> "$p/prefs.js.tmp"
  sed -i.bak -e '/extensions\.autoDisableScopes/d' -e '/toolkit\.legacyUserProfileCustomizations\.stylesheets/d' "$p/prefs.js.tmp"
  { echo 'user_pref("extensions.autoDisableScopes", 0);'
    echo 'user_pref("toolkit.legacyUserProfileCustomizations.stylesheets", true);'
  } >> "$p/prefs.js.tmp"
  mv "$p/prefs.js.tmp" "$p/prefs.js"
  rm -f "$p/prefs.js.tmp.bak"
  echo "   nueva tab -> FLOORP SYSTEM"

  XPI="$XPI_SIGNED"; [ -f "$XPI" ] || XPI="$XPI_FALLBACK"
  if [ -n "$XPI" ] && [ -f "$XPI" ]; then
    mkdir -p "$p/extensions"
    cp "$XPI" "$p/extensions/$MODE.xpi"
    echo "   extension PERMANENTE sideloada -> extensions/$MODE.xpi"
  else
    echo "   (sin XPI firmado: la extension queda temporal - ver pasos de abajo)"
  fi
done

echo ""
echo "  listo. Cerra Floorp antes, si estaba abierto; abris y nueva tab = FLOORP SYSTEM."
if [ -z "${XPI:-}" ] || [ ! -f "${XPI}" ]; then
  echo ""
  echo "  Para la extension PERMANENTE (vault auto tabs):"
  echo "   1) cuenta gratis en addons.mozilla.org"
  echo "   2) api keys: addons.mozilla.org/es/developers/addon/api/key/"
  echo "   3) python3 tools/sign_amo.py   (con AMO_API_KEY / AMO_API_SECRET)"
  echo "   4) vuelve a correr este script"
fi
echo ""
