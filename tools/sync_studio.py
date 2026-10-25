# -*- coding: utf-8 -*-
"""Sync STUDIO v0.17.0: copias del proyecto + zip de distribucion."""
import hashlib, shutil, zipfile, os
from pathlib import Path

ROOT = Path(".").resolve()

# (origen) -> [destinos]
FILES = {
    "floorp-system-extension/newtab/js/core.js": [
        "chrome/FLOORP-SYSTEM/js/core.js",
        "dist/floorp-system-extension/newtab/js/core.js",
        "dist/chrome/FLOORP-SYSTEM/js/core.js",
    ],
    "floorp-system-extension/newtab/css/core.css": [
        "chrome/FLOORP-SYSTEM/css/core.css",
        "dist/floorp-system-extension/newtab/css/core.css",
        "dist/chrome/FLOORP-SYSTEM/css/core.css",
    ],
    "floorp-system-extension/newtab/index.html": [
        "chrome/FLOORP-SYSTEM/index.html",
        "dist/floorp-system-extension/newtab/index.html",
        "dist/chrome/FLOORP-SYSTEM/index.html",
    ],
}

def sha(p):
    return hashlib.sha256(Path(p).read_bytes()).hexdigest()[:16]

ok = True
for src, dsts in FILES.items():
    for dst in dsts:
        d = Path(dst)
        if d.parent.name and not d.parent.exists():
            d.parent.mkdir(parents=True, exist_ok=True)
        if not d.exists() or sha(src) != sha(dst):
            shutil.copyfile(src, dst)
        if sha(src) != sha(dst):
            print(f"FAIL {dst}")
            ok = False
print("paridad:", "OK" if ok else "CON DIFERENCIAS")

# zip de distribucion
ZIPS = sorted(ROOT.glob("floorp-system-initialized-v*.zip"))
for z in ZIPS:
    z.unlink()
    print("zip viejo eliminado:", z.name)

ZNAME = "floorp-system-initialized-v0.17.0.zip"
zpath = ROOT / ZNAME
with zipfile.ZipFile(zpath, "w", zipfile.ZIP_DEFLATED) as zf:
    for base in ["floorp-system-extension", "chrome", "fsys-bridge", "docs"]:
        b = ROOT / base
        if not b.exists():
            continue
        for f in sorted(b.rglob("*")):
            if f.is_file() and "__pycache__" not in f.parts:
                zf.write(f, f.relative_to(ROOT))
    for extra in ["LEEME.md", "README.md"]:
        p = ROOT / "dist" / extra
        if p.exists():
            zf.write(p, extra)

with zipfile.ZipFile(zpath) as zf:
    bad = zf.testzip()
    n = len(zf.namelist())
print(f"{ZNAME}: {n} archivos, integridad {'OK' if bad is None else 'FALLO: ' + bad}")
