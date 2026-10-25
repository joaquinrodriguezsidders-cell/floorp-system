# -*- coding: utf-8 -*-
"""Sync de las copias del proyecto + zip de distribucion (version del manifest)."""
import hashlib, shutil, zipfile, os
from pathlib import Path

ROOT = Path(".").resolve()
EXT = "floorp-system-extension"

FILES = {
    f"{EXT}/newtab/js/core.js": [
        "chrome/FLOORP-SYSTEM/js/core.js",
        f"dist/{EXT}/newtab/js/core.js",
        "dist/chrome/FLOORP-SYSTEM/js/core.js",
    ],
    f"{EXT}/newtab/js/palette.js": [
        "chrome/FLOORP-SYSTEM/js/palette.js",
        f"dist/{EXT}/newtab/js/palette.js",
        "dist/chrome/FLOORP-SYSTEM/js/palette.js",
    ],
    f"{EXT}/newtab/js/bridge.js": [
        "chrome/FLOORP-SYSTEM/js/bridge.js",
        f"dist/{EXT}/newtab/js/bridge.js",
        "dist/chrome/FLOORP-SYSTEM/js/bridge.js",
    ],
    f"{EXT}/newtab/index.html": [
        "chrome/FLOORP-SYSTEM/index.html",
        f"dist/{EXT}/newtab/index.html",
        "dist/chrome/FLOORP-SYSTEM/index.html",
    ],
    f"{EXT}/newtab/css/core.css": [
        "chrome/FLOORP-SYSTEM/css/core.css",
        f"dist/{EXT}/newtab/css/core.css",
        "dist/chrome/FLOORP-SYSTEM/css/core.css",
    ],
    f"{EXT}/manifest.json": [
        f"dist/{EXT}/manifest.json",
    ],
    f"{EXT}/background/main.js": [
        f"dist/{EXT}/background/main.js",
    ],
    f"{EXT}/background/workspaces.js": [
        f"dist/{EXT}/background/workspaces.js",
    ],
    f"{EXT}/background/state.js": [
        f"dist/{EXT}/background/state.js",
    ],
    f"{EXT}/background/vault.js": [
        f"dist/{EXT}/background/vault.js",
    ],
    f"{EXT}/background/auto.js": [
        f"dist/{EXT}/background/auto.js",
    ],
    f"{EXT}/background/apps.js": [
        f"dist/{EXT}/background/apps.js",
    ],
    "fsys-bridge/fsys_bridge.py": [
        "dist/fsys-bridge/fsys_bridge.py",
    ],
}

def sha(p):
    return hashlib.sha256(Path(p).read_bytes()).hexdigest()[:12]

def sync(src, dsts):
    s = ROOT / src
    for d in dsts:
        t = ROOT / d
        t.parent.mkdir(parents=True, exist_ok=True)
        if not t.exists() or sha(t) != sha(s):
            shutil.copyfile(s, t)
            print(f"  copiado  {d}")
        else:
            print(f"  igual    {d}")

print("== SYNC ==")
for src, dsts in FILES.items():
    print(src)
    sync(src, dsts)

print("\n== PARIDAD ==")
bad = 0
for src, dsts in FILES.items():
    h = sha(ROOT / src)
    for d in dsts:
        if sha(ROOT / d) != h:
            print(f"  MISMATCH {d}")
            bad += 1
print("  paridad OK" if not bad else f"  {bad} mismatches")

import json
VER = json.loads((ROOT / EXT / "manifest.json").read_text(encoding="utf-8"))["version"]
print(f"\n== ZIP v{VER} ==")
ZIP = ROOT / f"floorp-system-initialized-v{VER}.zip"
if ZIP.exists():
    ZIP.unlink()
count = 0
with zipfile.ZipFile(ZIP, "w", zipfile.ZIP_DEFLATED) as z:
    for top in ("floorp-system-extension", "chrome", "fsys-bridge"):
        base = ROOT / "dist" / top
        for f in sorted(base.rglob("*")):
            if f.is_file() and "data" not in f.parts[len(base.parts):] and f.suffix != ".pyc":
                if "__pycache__" in f.parts:
                    continue
                z.write(f, f.relative_to(ROOT / "dist"))
                count += 1
    for extra in ("LEEME.md", "README.md"):
        p = ROOT / "dist" / extra
        if p.exists():
            z.write(p, extra)
            count += 1
print(f"  {ZIP.name}: {count} archivos, {ZIP.stat().st_size // 1024} KB")
print("  sha256:", hashlib.sha256(ZIP.read_bytes()).hexdigest()[:16])
