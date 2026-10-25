#!/usr/bin/env python3
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "dist" / "floorp-system-v0.18.0.zip"

# Files/folders to include
INCLUDE = [
    "floorp-system-extension",
    "chrome", 
    "fsys-bridge",
    "installer",
    "tools",
    "dist/LEEME.md",
]

with zipfile.ZipFile(OUT, 'w', zipfile.ZIP_DEFLATED) as z:
    for item in INCLUDE:
        p = ROOT / item
        if p.is_file():
            z.write(p, item)
        elif p.is_dir():
            for f in p.rglob('*'):
                if f.is_file():
                    # skip pycache
                    if '__pycache__' in f.parts:
                        continue
                    rel = f.relative_to(ROOT)
                    z.write(f, str(rel).replace('\\', '/'))
    # Also include LEEME in root
    z.write(ROOT / "dist" / "LEEME.md", "LEEME.md")

print(f"Created {OUT}")
