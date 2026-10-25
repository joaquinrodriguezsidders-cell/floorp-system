# -*- coding: utf-8 -*-
"""
sign_amo.py — Firma oficial de Mozilla (AMO, canal unlisted).

Firma el XPI con la API oficial de addons.mozilla.org. Un add-on firmado
es requisito de Firefox/Floorp en versiones release: sin firma no se
instala de forma permanente ni se actualiza solo.

Credenciales (una vez en la vida):
  1) Cuenta gratis en https://addons.mozilla.org  (solo confirmar el mail)
  2) https://addons.mozilla.org/developers/addon/api/key/
     -> "Generate new credentials"  (te da issuer + secret)
  3) Elegi UNA forma de pasarlas:
       a) variables de entorno (recomendado, no queda en disco):
            AMO_API_KEY=...  AMO_API_SECRET=...
       b) archivo local tools/amo_keys.txt  (esta en .gitignore):
            key=jwt_...
            secret=...
     NUNCA las subas al repositorio ni las pegues en un chat.

Uso:
  python tools/sign_amo.py
  python tools/sign_amo.py --xpi dist/floorp-system-unsigned.xpi

Salida:
  dist/floorp-system-signed.xpi
  dist/sign-info.json   (version, id, sha256 del firmado)
"""
import argparse
import hashlib
import json
import os
import subprocess
import sys
import time
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DIST = ROOT / "dist"
KEYS_FILE = ROOT / "tools" / "amo_keys.txt"
AMO = "https://addons.mozilla.org/api/v5"
SIGNED = DIST / "floorp-system-signed.xpi"

KEY, SECRET = "", ""


def read_credentials(explicit_key=None, explicit_secret=None):
    if explicit_key and explicit_secret:
        return explicit_key.strip(), explicit_secret.strip()

    env_key = os.environ.get("AMO_API_KEY") or os.environ.get("WEB_EXT_API_KEY")
    env_sec = os.environ.get("AMO_API_SECRET") or os.environ.get("WEB_EXT_API_SECRET")
    if env_key and env_sec:
        return env_key.strip(), env_sec.strip()

    if KEYS_FILE.exists():
        key = secret = None
        for line in KEYS_FILE.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line.startswith("key="):
                key = line[4:].strip()
            if line.startswith("secret="):
                secret = line[7:].strip()
        if key and secret:
            return key, secret
        raise SystemExit("tools/amo_keys.txt existe pero le falta 'key=...' o 'secret=...'")

    raise SystemExit(
        "faltan las credenciales de Mozilla.\n\n"
        "  1) entra a https://addons.mozilla.org/developers/addon/api/key/\n"
        "  2) boton 'Generate new credentials'\n"
        "  3) copia el issuer y el secret, y exportalos asi:\n"
        "       export AMO_API_KEY='jwt_...'\n"
        "       export AMO_API_SECRET='...'\n"
        "  4) volve a correr: python tools/sign_amo.py\n")


def curl_json(method, url, upload_path=None):
    """Habla con AMO sin exponer credenciales en la linea de comandos."""
    cmd = ["curl", "-sS", "--config", "-", "-X", method, "-H", "Accept: application/json"]
    if upload_path:
        cmd += ["-F", f"upload=@{upload_path}", "-F", "channel=unlisted"]
    cmd.append(url)

    # curl lee 'user = "key:secret"' por stdin: no queda en argv ni en ps
    cfg = f'user = "{KEY}:{SECRET}"\n'
    p = subprocess.run(cmd, input=cfg, capture_output=True, text=True)
    if p.returncode != 0:
        raise SystemExit(f"curl fallo: {p.stderr[:300]}")
    try:
        return json.loads(p.stdout)
    except Exception:
        raise SystemExit(f"respuesta no JSON (red o credenciales invalidas):\n{p.stdout[:600]}")


def validation_details(resp):
    v = resp.get("validation") or resp
    return json.dumps(v.get("messages") or v, indent=2, ensure_ascii=False)[:1500]


def looks_signed(path):
    try:
        with zipfile.ZipFile(path) as zf:
            return "META-INF/mozilla.rsa" in zf.namelist()
    except Exception:
        return False


def main():
    global KEY, SECRET
    ap = argparse.ArgumentParser(description="Firma el XPI en AMO (unlisted)")
    ap.add_argument("--key")
    ap.add_argument("--secret")
    ap.add_argument("--xpi", default=str(DIST / "floorp-system-unsigned.xpi"))
    a = ap.parse_args()

    KEY, SECRET = read_credentials(a.key, a.secret)
    unsigned = Path(a.xpi)
    if not unsigned.exists():
        raise SystemExit(f"no existe {unsigned}\n  generalo: python tools/build_xpi.py")

    with zipfile.ZipFile(unsigned) as zf:
        m = json.loads(zf.read("manifest.json"))
    print(f"\nfirmando FLOORP SYSTEM v{m['version']} en AMO (canal unlisted)")
    print("  se firma, NO se publica en el catalogo publico de Mozilla\n")

    print("  [1/3] subiendo...")
    up = curl_json("POST", f"{AMO}/addons/upload/", upload_path=unsigned)
    uuid = up.get("uuid")
    if not uuid:
        raise SystemExit("AMO rechazo el envio:\n" +
                         json.dumps(up, indent=2, ensure_ascii=False)[:800])

    print("  [2/3] validando...")
    data = {}
    for _ in range(90):
        time.sleep(4)
        try:
            data = curl_json("GET", f"{AMO}/addons/upload/{uuid}/")
        except SystemExit:
            continue
        state = (data.get("processed") or "").lower()
        if state == "failed":
            raise SystemExit("la validacion de AMO fallo:\n" + validation_details(data))
        if state == "passed":
            break
        print("        ...")
    else:
        raise SystemExit("AMO no termino a tiempo. Volve a correr el comando "
                         "(el envio previo queda cacheado).")

    url = data.get("download_url") or (data.get("validation") or {}).get("url_signed")
    if not url:
        raise SystemExit("valido pero no vino la URL firmada:\n" +
                         json.dumps(data, ensure_ascii=False)[:500])

    print("  [3/3] descargando el XPI firmado...")
    cmd = ["curl", "-sS", "-L", "--config", "-", "-o", str(SIGNED), url]
    p = subprocess.run(cmd, input=f'user = "{KEY}:{SECRET}"\n',
                       capture_output=True, text=True)
    if p.returncode != 0 or not SIGNED.exists() or SIGNED.stat().st_size < 1024:
        raise SystemExit("no pude descargar el XPI firmado:\n" + p.stderr[:300])

    if not looks_signed(SIGNED):
        raise SystemExit("el archivo descargado no contiene la firma META-INF/ — "
                         "no lo uses, revisa la respuesta de AMO")

    sha = hashlib.sha256(SIGNED.read_bytes()).hexdigest()
    info = {"addon_id": m["browser_specific_settings"]["gecko"]["id"],
            "version": m["version"], "sha256": sha,
            "size": SIGNED.stat().st_size, "signed": True}
    (DIST / "sign-info.json").write_text(
        json.dumps(info, ensure_ascii=False, indent=2), encoding="utf-8")

    print(f"\n  FIRMADO OK -> dist/{SIGNED.name} "
          f"({SIGNED.stat().st_size/1024:.0f} KB)")
    print(f"  sha256 {sha}\n")
    print("  siguiente: python tools/publish_update.py\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
