#!/usr/bin/env python3
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "dist" / "FLOORP-SYSTEM-ULTRA-SIMPLE.zip"

# Only what's needed
INCLUDE = [
    "floorp-system-extension",
    "chrome", 
    "fsys-bridge",
    "installer/install.py",
    "dist/LEEME.md",
]

with zipfile.ZipFile(OUT, 'w', zipfile.ZIP_DEFLATED) as z:
    for item in INCLUDE:
        p = ROOT / item
        if p.is_file():
            # skip any bat/cmd/ps1/sh
            if p.suffix.lower() in ['.bat', '.cmd', '.ps1', '.sh']:
                continue
            z.write(p, item)
        elif p.is_dir():
            for f in p.rglob('*'):
                if f.is_file():
                    if '__pycache__' in f.parts:
                        continue
                    if f.suffix.lower() in ['.bat', '.cmd', '.ps1', '.sh']:
                        continue
                    rel = f.relative_to(ROOT)
                    z.write(f, str(rel).replace('\\', '/'))
    # LEEME in root
    z.write(ROOT / "dist" / "LEEME.md", "LEEME.md")

print(f"Created {OUT}")
