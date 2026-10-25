# -*- coding: utf-8 -*-
"""
bump_version.py — Sube la version en TODOS los lugares a la vez.

La version vive en tres archivos y tienen que coincidir siempre:
  floorp-system-extension/manifest.json   (la que usa el navegador)
  package.json                            (la del proyecto)
  floorp-system-extension/newtab/js/core.js  (la que muestra la terminal)

Uso:
  python tools/bump_version.py patch        # 0.19.0 -> 0.19.1  (arreglo)
  python tools/bump_version.py minor        # 0.19.0 -> 0.20.0  (funcion nueva)
  python tools/bump_version.py major        # 0.19.0 -> 1.0.0   (cambio grande)
  python tools/bump_version.py --set 0.19.2 # numero exacto
  python tools/bump_version.py --show
"""
import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MANIFEST = ROOT / "floorp-system-extension" / "manifest.json"
PKG = ROOT / "package.json"
CORE = ROOT / "floorp-system-extension" / "newtab" / "js" / "core.js"


def read_version():
    return json.loads(MANIFEST.read_text(encoding="utf-8"))["version"]


def write_version(new):
    # manifest (preservando el formato)
    m = json.loads(MANIFEST.read_text(encoding="utf-8"))
    m["version"] = new
    MANIFEST.write_text(json.dumps(m, ensure_ascii=False, indent=2) + "\n",
                        encoding="utf-8")

    # package.json
    if PKG.exists():
        p = json.loads(PKG.read_text(encoding="utf-8"))
        p["version"] = new
        PKG.write_text(json.dumps(p, ensure_ascii=False, indent=2) + "\n",
                       encoding="utf-8")

    # core.js (const VERSION = "x.y.z")
    if CORE.exists():
        txt = CORE.read_text(encoding="utf-8")
        new_txt, n = re.subn(r'(const VERSION\s*=\s*")[^"]+(")',
                             r"\g<1>" + new + r"\g<2>", txt, count=1)
        if n:
            CORE.write_text(new_txt, encoding="utf-8")

    # copia del home (chrome/FLOORP-SYSTEM), si existe
    home_core = ROOT / "chrome" / "FLOORP-SYSTEM" / "js" / "core.js"
    if home_core.exists():
        txt = home_core.read_text(encoding="utf-8")
        new_txt, n = re.subn(r'(const VERSION\s*=\s*")[^"]+(")',
                             r"\g<1>" + new + r"\g<2>", txt, count=1)
        if n:
            home_core.write_text(new_txt, encoding="utf-8")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("part", nargs="?", default="patch",
                    choices=["patch", "minor", "major"])
    ap.add_argument("--set", dest="exact")
    ap.add_argument("--show", action="store_true")
    a = ap.parse_args()

    cur = read_version()
    if a.show:
        print(f"version actual: {cur}")
        return 0

    if a.exact:
        if not re.match(r"^\d+\.\d+\.\d+$", a.exact):
            raise SystemExit("formato invalido, tiene que ser X.Y.Z")
        new = a.exact
    else:
        major, minor, patch = (int(x) for x in cur.split("."))
        if a.part == "major":
            new = f"{major + 1}.0.0"
        elif a.part == "minor":
            new = f"{major}.{minor + 1}.0"
        else:
            new = f"{major}.{minor}.{patch + 1}"

    if new == cur:
        raise SystemExit("la version nueva es igual a la actual")
    write_version(new)
    print(f"version: {cur} -> {new}")
    print("\nsiguiente:")
    print(f"  python tools/validate.py")
    print(f'  git add -A && git commit -m "chore: v{new}"')
    print(f"  git tag v{new} && git push origin main --tags")
    return 0


if __name__ == "__main__":
    sys.exit(main())
