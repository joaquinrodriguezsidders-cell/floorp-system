# -*- coding: utf-8 -*-
"""
release.py — Publicar una version nueva, en orden y sin saltarse pasos.

Hace, en este orden:
  1. validar el proyecto              (tools/validate.py --release)
  2. empaquetar el XPI                (tools/build_xpi.py)
  3. firmar en Mozilla                (tools/sign_amo.py)  [si hay credenciales]
  4. generar el manifiesto de updates (tools/publish_update.py)
  5. verificar el resultado final

Si un paso falla, SE DETIENE y no genera el manifiesto de actualizaciones:
asi nunca se anuncia una version que en realidad no existe o no esta firmada.

Uso:
  python tools/release.py              # flujo completo
  python tools/release.py --no-sign    # hasta el XPI sin firmar (pruebas)
  python tools/release.py --dry-run    # solo validar, no escribe nada
"""
import argparse
import json
import subprocess
import sys
from pathlib import Path

import _console  # noqa: F401  (salida UTF-8 en Windows)

ROOT = Path(__file__).resolve().parent.parent
DIST = ROOT / "dist"
PY = sys.executable or "python"


def run(label, args, required=True):
    print(f"\n== {label}")
    p = subprocess.run([PY] + args, cwd=ROOT)
    if p.returncode != 0:
        if required:
            print(f"\n  DETENIDO: fallo '{label}'. No se publica nada mas.")
            raise SystemExit(p.returncode)
        print(f"  aviso: '{label}' no completo (continuo igual)")
        return False
    return True


def has_credentials():
    import os
    if os.environ.get("AMO_API_KEY") and os.environ.get("AMO_API_SECRET"):
        return True
    if os.environ.get("WEB_EXT_API_KEY") and os.environ.get("WEB_EXT_API_SECRET"):
        return True
    return (ROOT / "tools" / "amo_keys.txt").exists()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--no-sign", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()

    print("\nFLOORP SYSTEM // release")

    run("validacion", ["tools/validate.py"] + ([] if a.dry_run else ["--release"]))
    if a.dry_run:
        print("\n  --dry-run: validacion OK, no se genero ningun archivo.\n")
        return 0

    run("empaquetado", ["tools/build_xpi.py"])

    signed = False
    if a.no_sign:
        print("\n== firma\n  omitida (--no-sign): el XPI queda sin firmar")
    elif has_credentials():
        run("firma en Mozilla (AMO)", ["tools/sign_amo.py"])
        signed = True
    else:
        print("\n== firma\n  SIN credenciales de Mozilla todavia.")
        print("  El XPI se genero, pero Firefox/Floorp NO aplicara actualizaciones")
        print("  de un paquete sin firma. Cuando tengas las credenciales:")
        print("     export AMO_API_KEY='jwt_...'")
        print("     export AMO_API_SECRET='...'")
        print("     python tools/release.py")
        print("\n  No genero el manifiesto de actualizaciones (evita anunciar")
        print("  una version que el navegador va a rechazar).\n")
        return 0

    if not signed:
        print("\n  No firmado: no se genera manifiesto de actualizaciones.\n")
        return 0

    run("manifiesto de actualizaciones", ["tools/publish_update.py"])

    # verificacion final de coherencia
    info = json.loads((DIST / "sign-info.json").read_text(encoding="utf-8"))
    upd = json.loads((ROOT / "site" / "updates.json").read_text(encoding="utf-8"))
    entry = list(upd["addons"].values())[0]["updates"][-1]
    ok = (entry["version"] == info["version"] and
          entry["update_hash"].endswith(info["sha256"]))
    print("\n== verificacion final")
    print(f"  version firmada   {info['version']}")
    print(f"  version anunciada {entry['version']}")
    print(f"  hash coincide     {'si' if ok else 'NO'}")
    if not ok:
        raise SystemExit("  INCOHERENCIA: el manifiesto no coincide con el XPI firmado")

    print("\n  LISTO. Falta subir site/ a GitHub Pages (o deja que lo haga")
    print("  el workflow al crear el tag).\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
