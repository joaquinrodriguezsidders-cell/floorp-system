# -*- coding: utf-8 -*-
"""
publish_update.py — Genera el manifiesto de actualizaciones de Firefox
                    y deja listo el sitio que se publica en GitHub Pages.

Reglas de fiabilidad que aplica (y por que):
  1. El XPI debe estar FIRMADO por Mozilla (contiene META-INF/mozilla.rsa).
     Firefox en versiones release no instala/actualiza add-ons sin firma.
  2. La version del manifiesto sale del propio XPI, no de un archivo aparte.
     Asi nunca se anuncia una version distinta de la que se descarga.
  3. El hash sha256 se calcula del XPI real que se publica.
  4. Nunca se anuncia una version MENOR o IGUAL a la ya publicada
     (evita "actualizaciones" que en realidad son downgrades).
  5. El link debe ser HTTPS.

Salida:
  site/updates.json                        <- manifiesto que lee Firefox/Floorp
  site/floorp-system-<version>.xpi         <- copia descargable
  site/index.html                          <- pagina de instalacion (estatica)

Uso:
  python tools/publish_update.py --xpi dist/floorp-system-signed.xpi
  python tools/publish_update.py --xpi ... --download-url https://github.com/.../x.xpi
"""
import argparse
import hashlib
import json
import re
import shutil
import sys
import zipfile
from pathlib import Path

import _console  # noqa: F401  (salida UTF-8 en Windows)

ROOT = Path(__file__).resolve().parent.parent
CONFIG = ROOT / "release.config.json"
SITE = ROOT / "site"
SEMVER = re.compile(r"^(\d+)\.(\d+)\.(\d+)$")


def load_config():
    return json.loads(CONFIG.read_text(encoding="utf-8"))


def vertuple(v):
    m = SEMVER.match(v)
    if not m:
        raise SystemExit(f"version no valida: {v}")
    return tuple(int(x) for x in m.groups())


def is_signed(xpi):
    with zipfile.ZipFile(xpi) as zf:
        names = zf.namelist()
    return ("META-INF/mozilla.rsa" in names and
            ("META-INF/manifest.mf" in names or "META-INF/cose.manifest" in names))


def version_inside(xpi):
    with zipfile.ZipFile(xpi) as zf:
        m = json.loads(zf.read("manifest.json"))
    gid = (m.get("browser_specific_settings") or {}).get("gecko", {}).get("id")
    return m["version"], gid, m


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--xpi", default="dist/floorp-system-signed.xpi")
    ap.add_argument("--download-url",
                    help="URL HTTPS del XPI (si se aloja en GitHub Releases). "
                         "Si se omite, se publica dentro de Pages.")
    ap.add_argument("--allow-unsigned", action="store_true",
                    help="SOLO para pruebas locales: genera el manifiesto igual")
    a = ap.parse_args()

    cfg = load_config()
    base = (cfg.get("pages_base_url") or "").strip().rstrip("/")
    if not base:
        raise SystemExit(
            "canal sin configurar: corre  python tools/configure.py --github-user TU-USUARIO")

    xpi = (ROOT / a.xpi) if not Path(a.xpi).is_absolute() else Path(a.xpi)
    if not xpi.exists():
        raise SystemExit(f"no existe el XPI: {a.xpi}\n  construilo/firmalo primero")

    signed = is_signed(xpi)
    if not signed and not a.allow_unsigned:
        raise SystemExit(
            "el XPI NO esta firmado por Mozilla (falta META-INF/).\n"
            "  Firefox/Floorp no aplicara una actualizacion sin firma.\n"
            "  Firmalo: python tools/sign_amo.py\n"
            "  (o usa --allow-unsigned solo para probar el formato localmente)")
    if not signed:
        print("  AVISO: XPI sin firmar — manifiesto generado SOLO para prueba.\n")

    version, gid, _ = version_inside(xpi)
    if gid != cfg["addon_id"]:
        raise SystemExit(f"el XPI es del id '{gid}', no de '{cfg['addon_id']}'")

    # guarda anti-downgrade
    prev = SITE / "updates.json"
    if prev.exists():
        try:
            old = json.loads(prev.read_text(encoding="utf-8"))
            entries = old.get("addons", {}).get(cfg["addon_id"], {}).get("updates", [])
            if entries:
                last = entries[-1]["version"]
                if vertuple(version) < vertuple(last):
                    raise SystemExit(
                        f"la version {version} es MENOR que la publicada {last}.\n"
                        "  Firefox ignora versiones menores. Subi el numero de version.")
                if vertuple(version) == vertuple(last):
                    print(f"  AVISO: {version} ya figuraba en site/updates.json "
                          "(se reescribe igual)")
        except SystemExit:
            raise
        except Exception:
            pass

    sha = hashlib.sha256(xpi.read_bytes()).hexdigest()
    download = (a.download_url or "").strip() or f"{base}/floorp-system-{version}.xpi"
    if not download.startswith("https://"):
        raise SystemExit(f"el link de descarga debe ser HTTPS: {download}")

    SITE.mkdir(exist_ok=True)
    local_xpi = SITE / f"floorp-system-{version}.xpi"
    if not a.download_url:
        shutil.copy2(xpi, local_xpi)

    manifest = {
        "addons": {
            cfg["addon_id"]: {
                "updates": [
                    {
                        "version": version,
                        "update_link": download,
                        "update_hash": f"sha256:{sha}",
                    }
                ]
            }
        }
    }
    (SITE / "updates.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    print(f"\nFLOORP SYSTEM // manifiesto de actualizaciones")
    print(f"  id           {cfg['addon_id']}")
    print(f"  version      {version}")
    print(f"  firmado      {'si' if signed else 'NO (prueba)'}")
    print(f"  sha256       {sha}")
    print(f"  download     {download}")
    print(f"  publicado    updates.json -> {base}/updates.json")
    print(f"\n  Floorp leerA esa URL y ofrecera la {version} a quien tenga una version menor.\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
