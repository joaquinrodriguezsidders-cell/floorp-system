# -*- coding: utf-8 -*-
"""
sign_amo.py — Firma oficial de Mozilla (AMO, canal unlisted).

Firma el XPI con la API oficial de addons.mozilla.org. Un add-on firmado es
requisito de Firefox/Floorp en versiones release: sin firma no se instala de
forma permanente ni se actualiza solo.

AUTENTICACION (importante)
--------------------------
La API v5 de AMO NO acepta autenticacion basica (usuario/contrasena).
Exige un token JWT firmado con HS256 en la cabecera:

    Authorization: JWT <token>

con los claims: iss (tu issuer), jti (nonce unico), iat (ahora),
exp (como maximo 5 minutos despues de iat), y el secret como clave HMAC.
Este script arma el JWT con la libreria estandar de Python.
Referencia: https://mozilla.github.io/addons-server/topics/api/auth.html

Credenciales (una vez en la vida):
  1) Cuenta gratis en https://addons.mozilla.org  (solo confirmar el mail)
  2) https://addons.mozilla.org/developers/addon/api/key/
     -> "Generate new credentials"  (te da issuer + secret)
  3) Elegi UNA forma de pasarlas:
       a) variables de entorno (recomendado, no queda en disco):
            AMO_API_KEY=...  AMO_API_SECRET=...
       b) archivo local tools/amo_keys.txt  (esta en .gitignore):
            key=user:123456:78
            secret=abcdef...
     NUNCA las subas al repositorio ni las pegues en un chat.

Uso:
  python tools/sign_amo.py
  python tools/sign_amo.py --xpi dist/floorp-system-unsigned.xpi
  python tools/sign_amo.py --channel listed     # solo si algun dia publicás en el catálogo

Salida:
  dist/floorp-system-signed.xpi
  dist/sign-info.json   (version, id, sha256 del firmado)
"""
import argparse
import base64
import hashlib
import hmac
import json
import os
import secrets
import sys
import time
import urllib.error
import urllib.request
import uuid
import zipfile
from pathlib import Path

import _console  # noqa: F401  (salida UTF-8 en Windows)

ROOT = Path(__file__).resolve().parent.parent
DIST = ROOT / "dist"
CONFIG = ROOT / "release.config.json"
KEYS_FILE = ROOT / "tools" / "amo_keys.txt"
SIGNED = DIST / "floorp-system-signed.xpi"

# La base es configurable SOLO para poder probar contra un servidor local.
AMO = os.environ.get("FSYS_AMO_API", "https://addons.mozilla.org/api/v5").rstrip("/")
UA = "floorp-system-release/1.0 (+https://github.com/)"

TOKEN, SECRET = "", ""


# --------------------------------------------------------------- credenciales
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
        "       export AMO_API_KEY='user:123456:78'\n"
        "       export AMO_API_SECRET='...'\n"
        "  4) volve a correr: python tools/sign_amo.py\n"
        "  (en Windows: set AMO_API_KEY=...  y  set AMO_API_SECRET=...)\n")


# ----------------------------------------------------------------------- JWT
def _b64(raw):
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def make_jwt(issuer, secret, lifetime=60):
    """Token JWT HS256 tal como lo exige la API de AMO."""
    now = int(time.time())
    header = {"alg": "HS256", "typ": "JWT"}
    payload = {"iss": issuer, "jti": secrets.token_hex(16),
               "iat": now, "exp": now + lifetime}
    parts = (_b64(json.dumps(header, separators=(",", ":")).encode("utf-8")) + "." +
             _b64(json.dumps(payload, separators=(",", ":")).encode("utf-8")))
    digest = hmac.new(secret.encode("utf-8"), parts.encode("ascii"),
                      hashlib.sha256).digest()
    return parts + "." + _b64(digest)


def _headers():
    return {"Authorization": "JWT " + make_jwt(TOKEN, SECRET),
            "Accept": "application/json",
            "User-Agent": UA}


# ------------------------------------------------------------------ transporte
def _request(method, url, body=None, content_type=None):
    req = urllib.request.Request(url, data=body, method=method)
    for k, v in _headers().items():
        req.add_header(k, v)
    if content_type:
        req.add_header("Content-Type", content_type)
    try:
        with urllib.request.urlopen(req, timeout=180) as r:
            return json.loads(r.read().decode("utf-8") or "{}")
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")[:900]
        raise SystemExit(
            f"AMO respondio HTTP {e.code} ({method} {url})\n"
            f"  {detail}\n"
            + ("  -> Credenciales invalidas o vencidas: genera nuevas en\n"
               "     https://addons.mozilla.org/developers/addon/api/key/\n"
               if e.code in (401, 403) else ""))
    except urllib.error.URLError as e:
        raise SystemExit(f"no se pudo conectar con {url}: {e.reason}")


def upload(xpi):
    boundary = "----FLOORPSYSTEM" + uuid.uuid4().hex
    data = xpi.read_bytes()
    body = b"".join([
        f"--{boundary}\r\n".encode(),
        b'Content-Disposition: form-data; name="channel"\r\n\r\n',
        CHANNEL.encode() + b"\r\n",
        f"--{boundary}\r\n".encode(),
        (f'Content-Disposition: form-data; name="upload"; '
         f'filename="{xpi.name}"\r\n').encode(),
        b"Content-Type: application/x-xpinstall\r\n\r\n",
        data, b"\r\n",
        f"--{boundary}--\r\n".encode(),
    ])
    return _request("POST", f"{AMO}/addons/upload/", body,
                    f"multipart/form-data; boundary={boundary}")


def validation_details(resp):
    v = resp.get("validation") or resp
    return json.dumps(v.get("messages") or v, indent=2, ensure_ascii=False)[:1500]


def looks_signed(path):
    try:
        with zipfile.ZipFile(path) as zf:
            return "META-INF/mozilla.rsa" in zf.namelist()
    except Exception:
        return False


def download_signed(url, dest):
    req = urllib.request.Request(url)
    for k, v in _headers().items():
        req.add_header(k, v)
    try:
        with urllib.request.urlopen(req, timeout=300) as r, open(dest, "wb") as f:
            while True:
                chunk = r.read(65536)
                if not chunk:
                    break
                f.write(chunk)
    except urllib.error.HTTPError as e:
        raise SystemExit(f"no pude descargar el XPI firmado (HTTP {e.code}): {url}")
    except urllib.error.URLError as e:
        raise SystemExit(f"no pude descargar el XPI firmado: {e.reason}")


# ------------------------------------------------------------------------ main
CHANNEL = "unlisted"


def main():
    global TOKEN, SECRET, CHANNEL
    ap = argparse.ArgumentParser(description="Firma el XPI en AMO")
    ap.add_argument("--key", help="issuer de AMO (mejor usar AMO_API_KEY)")
    ap.add_argument("--secret", help="secret de AMO (mejor usar AMO_API_SECRET)")
    ap.add_argument("--xpi", default=str(DIST / "floorp-system-unsigned.xpi"))
    ap.add_argument("--channel", choices=["unlisted", "listed"])
    ap.add_argument("--timeout", type=int, default=360,
                    help="segundos maximos de espera a la validacion de AMO")
    a = ap.parse_args()

    if a.channel:
        CHANNEL = a.channel
    elif CONFIG.exists():
        CHANNEL = (json.loads(CONFIG.read_text(encoding="utf-8")).get("channel")
                   or "unlisted")

    TOKEN, SECRET = read_credentials(a.key, a.secret)
    unsigned = Path(a.xpi)
    if not unsigned.exists():
        raise SystemExit(f"no existe {unsigned}\n  generalo: python tools/build_xpi.py")

    with zipfile.ZipFile(unsigned) as zf:
        manifest = json.loads(zf.read("manifest.json"))
    version = manifest["version"]
    addon_id = manifest["browser_specific_settings"]["gecko"]["id"]
    if "update_url" not in manifest["browser_specific_settings"]["gecko"]:
        print("  AVISO: el XPI no contiene update_url: se firmaria sin canal de")
        print("         actualizaciones. Configura el canal y reempaqueta.\n")

    print(f"\nfirmando FLOORP SYSTEM v{version} en AMO (canal {CHANNEL})")
    print(f"  id {addon_id}")
    if CHANNEL == "unlisted":
        print("  se firma, NO se publica en el catalogo publico de Mozilla")

    print("\n  [1/3] subiendo...")
    up = upload(unsigned)
    upload_uuid = up.get("uuid")
    if not upload_uuid:
        raise SystemExit("AMO rechazo el envio:\n" +
                         json.dumps(up, indent=2, ensure_ascii=False)[:800])

    print("  [2/3] validando (esto puede tardar un par de minutos)...")
    data, deadline = {}, time.time() + a.timeout
    while time.time() < deadline:
        time.sleep(4)
        data = _request("GET", f"{AMO}/addons/upload/{upload_uuid}/")
        state = (data.get("processed") or "").lower()
        if state == "failed":
            raise SystemExit("la validacion de AMO fallo:\n" + validation_details(data))
        if state == "passed":
            break
        print("        ...")
    else:
        raise SystemExit(
            "AMO no termino de validar a tiempo.\n"
            "  La validacion sigue en su servidor; volve a correr el comando.\n"
            "  Si se repite, revisa el detalle en "
            "https://addons.mozilla.org/developers/addons/")

    url = data.get("download_url") or (data.get("validation") or {}).get("url_signed")
    if not url:
        raise SystemExit("valido pero no vino la URL firmada:\n" +
                         json.dumps(data, ensure_ascii=False)[:500])

    print("  [3/3] descargando el XPI firmado...")
    DIST.mkdir(exist_ok=True)
    if SIGNED.exists():
        SIGNED.unlink()
    download_signed(url, SIGNED)

    if not SIGNED.exists() or SIGNED.stat().st_size < 1024:
        raise SystemExit("el XPI firmado llego vacio o truncado; no lo uses")
    if not looks_signed(SIGNED):
        raise SystemExit("el archivo descargado no contiene la firma META-INF/ — "
                         "no lo uses, revisa la respuesta de AMO")

    with zipfile.ZipFile(SIGNED) as zf:
        inner = json.loads(zf.read("manifest.json"))
    if inner["version"] != version:
        raise SystemExit(f"AMO devolvio la version {inner['version']} pero se envio "
                         f"{version}: no publicar")

    sha = hashlib.sha256(SIGNED.read_bytes()).hexdigest()
    info = {"addon_id": addon_id, "version": version, "sha256": sha,
            "size": SIGNED.stat().st_size, "signed": True,
            "channel": CHANNEL}
    (DIST / "sign-info.json").write_text(
        json.dumps(info, ensure_ascii=False, indent=2), encoding="utf-8")

    print(f"\n  FIRMADO OK -> dist/{SIGNED.name} "
          f"({SIGNED.stat().st_size / 1024:.0f} KB)")
    print(f"  sha256 {sha}\n")
    print("  siguiente: python tools/publish_update.py\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
