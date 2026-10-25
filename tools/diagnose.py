# -*- coding: utf-8 -*-
"""
diagnose.py — ¿Esta instalación de Floorp puede recibir actualizaciones?

Responde con hechos leídos de ESTE perfil, no con suposiciones:
  1. ¿La extensión está registrada como instalación administrada por Floorp?
  2. ¿Está correctamente firmada y activa?
  3. ¿El canal de actualizaciones está configurado y responde por HTTPS?
  4. ¿Qué versión tenés instalada frente a la publicada?

No modifica nada: solo lee. De extensions.json y prefs.js únicamente
extrae las claves relacionadas con extensiones (nunca vuelca el archivo,
que puede contener datos privados).

Uso:
  python tools/diagnose.py
  python tools/diagnose.py --profile "C:\\ruta\\al\\perfil"
"""
import argparse
import json
import os
import re
import ssl
import sys
import urllib.error
import urllib.request
from pathlib import Path

import _console  # noqa: F401  (salida UTF-8 en Windows)

ROOT = Path(__file__).resolve().parent.parent
CONFIG = ROOT / "release.config.json"

SIGNED_STATE = {0: "desconocido", 1: "SIN FIRMA", 2: "firmada (correcto)",
                3: "del sistema", 4: "privilegiada"}

INSTALL_LOCATIONS = {
    "app-profile": "perfil (instalación administrada por el navegador)",
    "app-global": "instalación global",
    "app-system-share": "compartida del sistema",
    "app-system-user": "del sistema (usuario)",
    "app-builtin": "integrada en Floorp",
}

# Preferencias que afectan a la instalación y a las actualizaciones.
PREFS = [
    "extensions.update.enabled",
    "extensions.update.autoUpdateDefault",
    "extensions.autoDisableScopes",
    "xpinstall.signatures.required",
    "extensions.langpacks.signatures.required",
    "extensions.sideloadScopes",
]


def find_profiles():
    """Devuelve los perfiles de Floorp/Firefox encontrados en este equipo."""
    home = Path.home()
    cands = []
    roaming = os.environ.get("APPDATA")
    if roaming:
        cands.append(Path(roaming) / "Floorp" / "Profiles")
        cands.append(Path(roaming) / "Mozilla" / "Firefox" / "Profiles")
    cands += [
        home / ".floorp",
        home / "Library" / "Application Support" / "Floorp" / "Profiles",
        home / ".config" / "floorp",
    ]
    found = []
    for base in cands:
        if base.is_dir():
            for p in sorted(base.iterdir()):
                if (p / "extensions.json").exists() or (p / "prefs.js").exists():
                    found.append(p)
    return found


def looks_like_profile(p):
    return (p / "extensions.json").exists() or (p / "prefs.js").exists()


def read_installed(profile, addon_id):
    f = profile / "extensions.json"
    if not f.exists():
        return None
    try:
        data = json.loads(f.read_text(encoding="utf-8", errors="replace"))
    except Exception as e:
        print(f"  ! no pude leer extensions.json: {e}")
        return None
    for a in data.get("addons", []):
        if a.get("id") == addon_id:
            return a
    # a veces el id está en el manifest anidado
    for a in data.get("addons", []):
        mid = ((a.get("manifest") or {}).get("browser_specific_settings")
               or {}).get("gecko", {}).get("id")
        if mid == addon_id:
            return a
    return None


def read_prefs(profile):
    f = profile / "prefs.js"
    out = {}
    if not f.exists():
        return out
    wanted = tuple(f'user_pref("{p}"' for p in PREFS)
    for line in f.read_text(encoding="utf-8", errors="replace").splitlines():
        s = line.strip()
        if not s.startswith(wanted):
            continue
        m = re.match(r'user_pref\("([^"]+)",\s*(.+?)\);', s)
        if m:
            out[m.group(1)] = m.group(2)
    return out


def http_get(url, timeout=12):
    ctx = ssl.create_default_context()
    req = urllib.request.Request(url, headers={"User-Agent": "fsys-diagnose/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=ctx) as r:
            return r.status, r.read(200_000), dict(r.headers)
    except urllib.error.HTTPError as e:
        return e.code, b"", {}
    except Exception as e:
        return None, str(e).encode(), {}


def ver_tuple(v):
    try:
        return tuple(int(x) for x in v.split("."))
    except Exception:
        return (0,)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--profile")
    a = ap.parse_args()

    cfg = {}
    if CONFIG.exists():
        cfg = json.loads(CONFIG.read_text(encoding="utf-8"))
    addon_id = cfg.get("addon_id", "floorp-system@fsys.system")
    base = (cfg.get("pages_base_url") or "").strip().rstrip("/")

    print("\nFLOORP SYSTEM // diagnose")
    print(f"  id a buscar  {addon_id}\n")

    # ---------------------------------------------------- perfil
    if a.profile:
        profile = Path(a.profile).expanduser()
        if not looks_like_profile(profile):
            print(f"  ! '{profile}' no parece un perfil de Floorp")
            return 2
    else:
        profile = ROOT if looks_like_profile(ROOT) else None
        if profile is None:
            profiles = find_profiles()
            if not profiles:
                print("  ! no encontré ningún perfil de Floorp en este equipo")
                print("    pasá la ruta a mano: python tools/diagnose.py --profile RUTA")
                return 2
            profile = profiles[0]

    print(f"  perfil      {profile}")

    problems, pending = [], []

    # ---------------------------------------------------- instalación
    entry = read_installed(profile, addon_id)
    print("\n[1] instalación en el perfil")
    if not entry:
        print("  RESULTADO: la extensión NO figura como instalación administrada")
        xpi = profile / "extensions" / f"{addon_id}.xpi"
        if xpi.exists():
            print(f"  hay un archivo en extensions/{xpi.name} "
                  f"({xpi.stat().st_size/1024:.0f} KB), pero Floorp no lo registró")
            pending.append(
                "El XPI está copiado en la carpeta pero Floorp no lo registró como "
                "instalación. Instalalo desde about:addons (⚙ → Instalar complemento "
                "desde archivo) para que quede administrado y pueda actualizarse.")
        else:
            problems.append(
                "No está instalada en este perfil. Instalala una vez desde about:addons "
                "y desde ahí recibirá las actualizaciones.")
        installed_version = None
    else:
        loc = entry.get("location")
        state = entry.get("signedState")
        active = entry.get("active")
        version = entry.get("version")
        installed_version = version
        print(f"  versión     {version}")
        print(f"  ubicación   {loc}  ({INSTALL_LOCATIONS.get(loc, 'otra')})")
        print(f"  firmada     {SIGNED_STATE.get(state, state)}")
        print(f"  activa      {'sí' if active else 'NO'}")
        if entry.get("appDisabled"):
            problems.append("Floorp la desactivó (appDisabled=true): suele ser por "
                            "incompatibilidad o firma no válida.")
        if entry.get("userDisabled"):
            problems.append("La desactivaste manualmente (userDisabled=true). "
                            "Activala en about:addons para recibir actualizaciones.")
        if state == 1:
            problems.append("La copia instalada no tiene firma válida de Mozilla: "
                            "Floorp no la actualizará.")
        if loc == "app-profile" and state == 2 and active:
            print("  -> instalación administrada y firmada: puede recibir "
                  "actualizaciones automáticas")

    # ---------------------------------------------------- canal
    print("\n[2] canal de actualizaciones (desde este proyecto)")
    if not base:
        print("  pages_base_url: (sin configurar)")
        pending.append(
            "El canal todavía no está configurado. Sin una URL pública no hay "
            "actualizaciones automáticas: hay que publicar el repositorio en GitHub "
            "y correr tools/configure.py (ver README).")
        published_version = None
    else:
        url = base + "/updates.json"
        print(f"  endpoint    {url}")
        status, body, _ = http_get(url)
        published_version = None
        if status is None:
            print(f"  RESULTADO: no responde ({body.decode('utf-8', 'replace')[:120]})")
            pending.append(
                f"El endpoint {url} no es accesible todavía. Es normal si el "
                "repositorio aún no está publicado en GitHub Pages.")
        elif status != 200:
            print(f"  RESULTADO: HTTP {status}")
            pending.append(
                f"El endpoint {url} responde HTTP {status}. Revisá que GitHub Pages "
                "esté activado (Settings → Pages → Source: GitHub Actions).")
        else:
            try:
                data = json.loads(body)
                entries = data.get("addons", {}).get(addon_id, {}).get("updates", [])
                if not entries:
                    print("  RESULTADO: el manifiesto no tiene entradas para este id")
                    pending.append("El manifiesto publicado no incluye esta extensión.")
                else:
                    last = entries[-1]
                    published_version = last.get("version")
                    print(f"  publicado   v{published_version}")
                    print(f"  descarga    {last.get('update_link')}")
                    link = last.get("update_link") or ""
                    if link.startswith("https://"):
                        s2, b2, _ = http_get(link)
                        if s2 == 200 and len(b2) > 1024:
                            print(f"  el paquete responde y pesa "
                                  f"{len(b2)/1024:.0f} KB")
                            if b2[:2] != b"PK":
                                problems.append("El enlace de descarga no devuelve "
                                                "un archivo XPI válido.")
                        else:
                            problems.append(
                                f"El enlace de descarga no responde bien (HTTP {s2}). "
                                "El manifiesto anuncia un paquete que no se puede bajar.")
                    else:
                        problems.append("El enlace de descarga no es HTTPS.")
            except Exception as e:
                print(f"  RESULTADO: el manifiesto no es JSON válido ({e})")
                problems.append("El updates.json publicado está mal formado.")

    # ---------------------------------------------------- prefs
    print("\n[3] preferencias que afectan a las actualizaciones")
    prefs = read_prefs(profile)
    for k in PREFS:
        print(f"  {k:45s} {prefs.get(k, '(valor por defecto)')}")
    upd = prefs.get("extensions.update.enabled")
    if upd == "false":
        problems.append("extensions.update.enabled = false: las actualizaciones "
                        "automáticas de extensiones están apagadas en este perfil. "
                        "Ponelo en true (about:config).")
    if prefs.get("xpinstall.signatures.required") == "false":
        print("  nota: las firmas están desactivadas en este perfil; las "
              "actualizaciones igual funcionan, pero no es lo recomendable.")

    # ---------------------------------------------------- veredicto
    print("\n[4] veredicto")
    if installed_version and published_version:
        if ver_tuple(published_version) > ver_tuple(installed_version):
            print(f"  tenés v{installed_version} y hay v{published_version} publicada")
            if entry and entry.get("location") == "app-profile" and entry.get("active"):
                print("  -> Floorp debería actualizarla sola en las próximas horas")
            else:
                print("  -> pero esta instalación no está administrada por Floorp: "
                      "no se actualizará sola")
        else:
            print(f"  estás al día (v{installed_version})")

    if problems:
        print("\n  PROBLEMAS:")
        for i, p in enumerate(problems, 1):
            print(f"   {i}. {p}")
    if pending:
        print("\n  PENDIENTE (requiere publicación o una acción tuya):")
        for i, p in enumerate(pending, 1):
            print(f"   {i}. {p}")
    if not problems and not pending:
        print("  Todo en orden.")

    print()
    return 0 if not problems else 1


if __name__ == "__main__":
    sys.exit(main())
