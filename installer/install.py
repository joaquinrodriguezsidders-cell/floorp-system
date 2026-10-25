#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
FLOORP SYSTEM - INSTALADOR DEFINITIVO (v0.18)
Sin permisos de administrador. Todo se escribe en el perfil del usuario.
"""

import json
import os
import platform
import shutil
import sys
from pathlib import Path
from datetime import datetime
from urllib.parse import quote

def find_floorp_profiles():
    profiles = []
    home = Path.home()
    system = platform.system()
    
    if system == "Windows":
        appdata = os.environ.get('APPDATA')
        localappdata = os.environ.get('LOCALAPPDATA')
        if appdata:
            profiles.append(Path(appdata) / "Floorp" / "Profiles")
        if localappdata:
            profiles.append(Path(localappdata) / "Floorp" / "Profiles")
    else:  # Linux, macOS
        candidates = [
            home / ".floorp" / "profiles",
            home / ".floorp",
            home / "floorp" / "profiles",
            home / ".mozilla" / "floorp",  # sometimes shared
        ]
        profiles.extend(candidates)
    
    found = []
    for root in profiles:
        if root.exists() and root.is_dir():
            for d in root.iterdir():
                if d.is_dir():
                    prefs = d / "prefs.js"
                    if prefs.exists():
                        found.append(d)
    return found

def main():
    root = Path(__file__).parent.parent
    ext_dir = root / "dist"
    theme_dir = root / "chrome"
    
    print("\nFLOORP SYSTEM // INSTALLER DEFINITIVO (PYTHON)\n")
    
    profile_dirs = find_floorp_profiles()
    if not profile_dirs:
        print("  x No encontre perfiles de Floorp en esta PC.")
        print("    Abri Floorp una vez, cerrelo, y volvé a correr este script.")
        sys.exit(1)
    
    print(f"  ok - perfil(es): {', '.join(str(p) for p in profile_dirs)}")
    
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    xpi_signed = ext_dir / "floorp-system-signed.xpi"
    xpi_fallback = None
    for f in ext_dir.glob("floorp-system@*.xpi"):
        xpi_fallback = f
        break
    
    for p in profile_dirs:
        print(f"\n== {p}")
        
        # backup
        prefs_file = p / "prefs.js"
        backup = p / f"prefs.js.fsys-backup-{stamp}"
        shutil.copy2(prefs_file, backup)
        print(f"   backup prefs.js -> {backup.name}")
        
        # theme
        if theme_dir.exists():
            chrome_dest = p / "chrome"
            chrome_dest.mkdir(parents=True, exist_ok=True)
            for item in theme_dir.iterdir():
                dest = chrome_dest / item.name
                if item.is_dir():
                    if dest.exists():
                        shutil.rmtree(dest)
                    shutil.copytree(item, dest)
                else:
                    shutil.copy2(item, dest)
            print("   tema copiado a chrome\\")
        
        # home override
        home_html = p / "chrome" / "FLOORP-SYSTEM" / "index.html"
        if home_html.exists():
            url = home_html.as_uri()
            # read prefs
            with open(prefs_file, 'r', encoding='utf-8', errors='ignore') as f:
                prefs = f.readlines()
            # remove old override
            prefs = [l for l in prefs if 'floorp.newtab.overrides.newtaburl' not in l]
            prefs.append(f'user_pref("floorp.newtab.overrides.newtaburl", "{url}");\n')
            with open(prefs_file, 'w', encoding='ascii', errors='ignore') as f:
                f.writelines(prefs)
            print(f"   nueva tab -> FLOORP SYSTEM ({url})")
        
        # prefs
        with open(prefs_file, 'r', encoding='utf-8', errors='ignore') as f:
            prefs = f.readlines()
        prefs = [l for l in prefs if 'extensions.autoDisableScopes' not in l and 
                'toolkit.legacyUserProfileCustomizations.stylesheets' not in l]
        prefs.append('user_pref("extensions.autoDisableScopes", 0);\n')
        prefs.append('user_pref("toolkit.legacyUserProfileCustomizations.stylesheets", true);\n')
        with open(prefs_file, 'w', encoding='ascii', errors='ignore') as f:
            f.writelines(prefs)
        
        # xpi
        xpi = xpi_signed if xpi_signed.exists() else xpi_fallback
        if xpi and xpi.exists():
            ext_dest = p / "extensions"
            ext_dest.mkdir(parents=True, exist_ok=True)
            # get id from manifest
            manifest = root / "floorp-system-extension" / "manifest.json"
            try:
                with open(manifest) as f:
                    m = json.load(f)
                ext_id = m['browser_specific_settings']['gecko']['id']
                name = ext_id + ".xpi"
            except:
                name = "floorp-system@fsys.system.xpi"
            shutil.copy2(xpi, ext_dest / name)
            print(f"   extension PERMANENTE sideloada -> extensions\\{name}")
        else:
            print("   (sin XPI firmado: la extension queda temporal)")
    
    print("\n  listo. Abrí Floorp: nueva tab = FLOORP SYSTEM v permanente.\n")
    
    if not xpi_signed.exists():
        print("  Para dejar la extension PERMANENTE (tabs vault autos notif):")
        print("   1) cuenta gratis en addons.mozilla.org")
        print("   2) api keys en addons.mozilla.org/es/developers/addon/api/key/")
        print("   3) python tools/sign_amo.py   (con AMO_API_KEY / AMO_API_SECRET en el entorno)")
        print("   4) re-corre este installer\n")

if __name__ == '__main__':
    main()
