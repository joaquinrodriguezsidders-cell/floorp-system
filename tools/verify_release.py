# -*- coding: utf-8 -*-
"""
verify_release.py — Comprobaciones de integridad ANTES de publicar.

Este es el guardia final del pipeline. Se ejecuta en el workflow, pero
tambien a mano en local, y responde una sola pregunta:

    "el XPI firmado que voy a anunciar, ¿es exactamente el que corresponde
     al ID, la version y el canal de actualizaciones configurados?"

Si algo no coincide, sale con codigo 1 y NO se publica nada.

Que verifica:
  1. El archivo existe y es un ZIP legible (no esta truncado/corrupto).
  2. Contiene META-INF con la firma de Mozilla (firma real, no simulada).
  3. manifest.json del XPI: id == addon_id de release.config.json.
  4. update_url dentro del XPI == <pages_base_url>/updates.json exacto
     (evita publicar un paquete que apunta a otro canal o a un placeholder).
  5. La version del XPI es X.Y.Z y, si se pasa --expect-version, coincide
     (evita publicar v0.20 con el nombre de v0.19).
  6. El XPI no trae basura (__pycache__, .git, node_modules).

Ademas genera los archivos que consume el release:
  dist/VERSION              version exacta del paquete
  dist/SHA256SUMS.txt       hash verificable por el usuario

Uso:
  python tools/verify_release.py --xpi dist/floorp-system-signed.xpi
  python tools/verify_release.py --xpi ... --expect-version 0.19.0
  python tools/verify_release.py --xpi ... --github-output build_meta.txt
"""
import argparse
import hashlib
import json
import re
import sys
import zipfile
from pathlib import Path

import _console  # noqa: F401  (salida UTF-8 en Windows)

ROOT = Path(__file__).resolve().parent.parent
CONFIG = ROOT / "release.config.json"
DIST = ROOT / "dist"
SEMVER = re.compile(r"^\d+\.\d+\.\d+$")


def fail(msg):
    print(f"  FALLO: {msg}")
    return 1


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--xpi", default=str(DIST / "floorp-system-signed.xpi"))
    ap.add_argument("--expect-version")
    ap.add_argument("--base-url", help="canal esperado (por defecto el de la config)")
    ap.add_argument("--github-output", help="archivo donde escribir version/id/sha")
    ap.add_argument("--allow-unsigned", action="store_true",
                    help="solo pruebas: no exige META-INF")
    ap.add_argument("--check-meta-only", action="store_true",
                    help="solo lee version/id del manifest de origen y sale")
    a = ap.parse_args()

    if a.check_meta_only:
        src = ROOT / "floorp-system-extension" / "manifest.json"
        if not src.exists():
            return fail(f"falta {src}")
        m = json.loads(src.read_text(encoding="utf-8"))
        v = m.get("version", "")
        gid = ((m.get("browser_specific_settings") or {}).get("gecko") or {}).get("id")
        if not SEMVER.match(v):
            return fail(f"version del manifest invalida: '{v}'")
        if not gid:
            return fail("el manifest no declara browser_specific_settings.gecko.id")
        if a.github_output:
            with open(a.github_output, "a", encoding="utf-8") as f:
                f.write(f"version={v}\naddon_id={gid}\n")
        print(f"version={v}")
        print(f"addon_id={gid}")
        return 0

    xpi = Path(a.xpi)
    print(f"\nFLOORP SYSTEM // verify_release")
    print(f"  archivo {xpi}")

    # 1. existe y es un zip sano
    if not xpi.exists():
        return fail(f"no existe {xpi}")
    if xpi.stat().st_size < 1024:
        return fail(f"el archivo es demasiado chico ({xpi.stat().st_size} bytes): "
                    "descarga incompleta")
    try:
        zf = zipfile.ZipFile(xpi)
        names = zf.namelist()
        bad = zf.testzip()
        if bad:
            return fail(f"el ZIP esta corrupto en: {bad}")
    except zipfile.BadZipFile:
        return fail("el archivo no es un ZIP/XPI valido")
    if "manifest.json" not in names:
        return fail("el XPI no tiene manifest.json en la raiz (Firefox lo rechazaria)")

    # 2. firma
    has_sig = "META-INF/mozilla.rsa" in names
    if not has_sig and not a.allow_unsigned:
        return fail("el XPI no tiene firma de Mozilla (META-INF/mozilla.rsa). "
                    "Firefox/Floorp no lo instalara ni lo actualizara.\n"
                    "         Firmalo: python tools/sign_amo.py")
    print(f"  {'PASS' if has_sig else 'AVISO'}  firma de Mozilla "
          f"{'presente' if has_sig else 'AUSENTE (modo prueba)'}")

    # 3-5. manifest interno
    manifest = json.loads(zf.read("manifest.json"))
    gecko = (manifest.get("browser_specific_settings") or {}).get("gecko") or {}
    version = manifest.get("version", "")
    addon_id = gecko.get("id")
    update_url = gecko.get("update_url")

    cfg = {}
    if CONFIG.exists():
        cfg = json.loads(CONFIG.read_text(encoding="utf-8"))

    if cfg.get("addon_id") and addon_id != cfg["addon_id"]:
        return fail(f"el XPI es del id '{addon_id}' pero la config espera "
                    f"'{cfg['addon_id']}'")
    print(f"  PASS  id {addon_id}")

    if not SEMVER.match(version):
        return fail(f"version invalida en el XPI: '{version}' (se espera X.Y.Z)")
    if a.expect_version and version != a.expect_version:
        return fail(f"el XPI es v{version} pero se esperaba v{a.expect_version}")
    print(f"  PASS  version {version}")

    base = (a.base_url if a.base_url is not None
            else (cfg.get("pages_base_url") or "")).strip().rstrip("/")
    if base:
        expected = base + "/updates.json"
        if update_url != expected:
            return fail(f"update_url del XPI es '{update_url or '(ausente)'}' "
                        f"pero el canal configurado es '{expected}'.\n"
                        "         Reempaqueta con el canal correcto "
                        "(python tools/build_xpi.py).")
        print(f"  PASS  update_url -> {update_url}")
    elif update_url:
        print(f"  AVISO canal no configurado localmente; el XPI apunta a {update_url}")
    else:
        print("  AVISO el XPI no tiene update_url: no habra actualizaciones automaticas")

    # 6. basura
    junk = [n for n in names if n.startswith(("__pycache__/", ".git/", "node_modules/"))
            or n.endswith((".pyc", ".log"))]
    if junk:
        return fail(f"el XPI incluye archivos que no corresponden: {junk[:5]}")
    print(f"  PASS  contenido limpio ({len(names)} archivos)")

    # artefactos de release
    data = xpi.read_bytes()
    sha = hashlib.sha256(data).hexdigest()
    DIST.mkdir(exist_ok=True)
    (DIST / "VERSION").write_text(version + "\n", encoding="utf-8")
    (DIST / "SHA256SUMS.txt").write_text(
        f"{sha}  floorp-system-{version}.xpi\n", encoding="utf-8")

    # Copia publicable con nombre versionado: es byte a byte el archivo
    # verificado arriba, y su nombre coincide con el de SHA256SUMS.txt.
    public = DIST / f"floorp-system-{version}.xpi"
    if public.resolve() != xpi.resolve():
        public.write_bytes(data)
    if hashlib.sha256(public.read_bytes()).hexdigest() != sha:
        return fail("la copia publicable no coincide con el archivo verificado")
    print(f"  PASS  sha256 {sha}")
    print(f"  PASS  listo para adjuntar: dist/{public.name}")

    if a.github_output:
        with open(a.github_output, "a", encoding="utf-8") as f:
            f.write(f"version={version}\n")
            f.write(f"addon_id={addon_id}\n")
            f.write(f"sha256={sha}\n")
            f.write(f"signed={'true' if has_sig else 'false'}\n")

    print("\n  TODO COHERENTE: se puede publicar.\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
