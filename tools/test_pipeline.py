# -*- coding: utf-8 -*-
"""
test_pipeline.py — Prueba de integracion del canal de publicacion.

Que hace de verdad (no simula el codigo bajo prueba):
  * Levanta un servidor HTTP local que imita la API de AMO.
  * Ese servidor VERIFICA POR SU CUENTA la firma HMAC del JWT recibido y
    los claims (iss, jti, iat, exp). Si el firmador usara autenticacion
    basica, o firmara mal el token, el servidor responde 401 y el test falla.
  * Ejecuta los scripts reales (build_xpi, sign_amo, publish_update,
    validate) como procesos separados en un directorio temporal.

Lo unico simulado es el CONTENIDO criptografico de la firma de Mozilla:
el servidor devuelve el XPI con un META-INF falso. Sirve para comprobar el
flujo completo, NO demuestra que Mozilla haya firmado nada.

Uso:
    python tools/test_pipeline.py            # todos los casos
    python tools/test_pipeline.py -v         # con detalle del servidor
"""
import base64
import hashlib
import hmac
import http.server
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import zipfile
from pathlib import Path

import _console  # noqa: F401  (salida UTF-8 en Windows)

ROOT = Path(__file__).resolve().parent.parent
PY = sys.executable or "python"
ISSUER = "user:424242:7"
SECRET = "s3cr3t-de-prueba-no-real-9f2a"

VERBOSE = "-v" in sys.argv
RESULTS = []


# ------------------------------------------------------------------ utilidades
def b64d(s):
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def verify_jwt(header_value):
    """Valida el token como lo haria AMO. Devuelve (ok, motivo, payload)."""
    if not header_value:
        return False, "sin cabecera Authorization", None
    if not header_value.startswith("JWT "):
        return False, f"esquema no valido: {header_value.split()[0]!r} (AMO exige JWT)", None
    parts = header_value[4:].split(".")
    if len(parts) != 3:
        return False, "token mal formado", None
    signing_input = (parts[0] + "." + parts[1]).encode("ascii")
    expected = base64.urlsafe_b64encode(
        hmac.new(SECRET.encode(), signing_input, hashlib.sha256).digest()
    ).rstrip(b"=").decode()
    if not hmac.compare_digest(parts[2], expected):
        return False, "firma HMAC incorrecta", None
    try:
        head = json.loads(b64d(parts[0]))
        payload = json.loads(b64d(parts[1]))
    except Exception:
        return False, "JSON invalido en el token", None
    if head.get("alg") != "HS256":
        return False, f"alg={head.get('alg')} (AMO exige HS256)", None
    for claim in ("iss", "jti", "iat", "exp"):
        if claim not in payload:
            return False, f"falta el claim {claim}", None
    if payload["iss"] != ISSUER:
        return False, f"iss inesperado: {payload['iss']}", None
    if payload["exp"] - payload["iat"] > 300:
        return False, "exp supera los 5 minutos permitidos por AMO", None
    if payload["exp"] < time.time():
        return False, "token vencido", None
    return True, "ok", payload


def parse_multipart(content_type, body):
    m = re.search(r"boundary=([^;]+)", content_type or "")
    if not m:
        raise ValueError("sin boundary")
    boundary = m.group(1).strip('"').encode()
    fields = {}
    for chunk in body.split(b"--" + boundary):
        if not chunk.strip(b"-\r\n"):
            continue
        if b"\r\n\r\n" not in chunk:
            continue
        head, data = chunk.split(b"\r\n\r\n", 1)
        name = re.search(rb'name="([^"]+)"', head)
        if not name:
            continue
        fields[name.group(1).decode()] = data.rstrip(b"\r\n")
    return fields


def sign_fake(xpi_bytes):
    """Devuelve el mismo XPI con un META-INF agregado (firma SIMULADA)."""
    import io
    out = io.BytesIO()
    with zipfile.ZipFile(io.BytesIO(xpi_bytes)) as src, \
            zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as dst:
        for item in src.infolist():
            dst.writestr(item, src.read(item.filename))
        dst.writestr("META-INF/manifest.mf", "Manifest-Version: 1.0\n")
        dst.writestr("META-INF/mozilla.rsa", b"FIRMA-SIMULADA-PARA-PRUEBAS" * 40)
    return out.getvalue()


# ------------------------------------------------------------- servidor falso
class State:
    mode = "ok"          # ok | reject
    uploads = {}
    polls = {}


class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        if VERBOSE:
            sys.stderr.write("    [amo] " + (a[0] % a[1:]) + "\n")

    def _send(self, code, payload=None, raw=None):
        body = raw if raw is not None else json.dumps(payload or {}).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _auth(self):
        ok, why, payload = verify_jwt(self.headers.get("Authorization"))
        if not ok:
            self._send(401, {"detail": why})
            return None
        return payload

    def do_POST(self):
        if not self.path.startswith("/api/v5/addons/upload/"):
            return self._send(404, {"detail": "no existe"})
        if self._auth() is None:
            return
        if State.mode == "reject":
            return self._send(400, {"detail": "demasiados permisos"})
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length)
        try:
            fields = parse_multipart(self.headers.get("Content-Type"), body)
        except Exception as e:
            return self._send(400, {"detail": f"multipart invalido: {e}"})
        if "upload" not in fields:
            return self._send(400, {"detail": "falta el campo upload"})
        uid = "up-1234"
        State.uploads[uid] = {"bytes": fields["upload"],
                              "channel": fields.get("channel", b"").decode()}
        State.polls[uid] = 0
        self._send(202, {"uuid": uid, "processed": False})

    def do_GET(self):
        if self.path.startswith("/api/v5/addons/upload/"):
            if self._auth() is None:
                return
            uid = self.path.rstrip("/").split("/")[-1]
            if uid not in State.uploads:
                return self._send(404, {"detail": "upload desconocido"})
            State.polls[uid] += 1
            if State.polls[uid] < 2:          # fuerza al cliente a esperar
                return self._send(200, {"processed": False})
            if State.mode == "failed_validation":
                return self._send(200, {
                    "processed": "failed",
                    "validation": {"messages": [
                        {"message": "permiso no declarado", "type": "error"}]}})
            port = self.server.server_address[1]
            return self._send(200, {
                "processed": "passed",
                "download_url": f"http://127.0.0.1:{port}/signed.xpi"})
        if self.path == "/signed.xpi":
            if self._auth() is None:
                return
            for up in State.uploads.values():
                return self._send(200, raw=sign_fake(up["bytes"]))
            return self._send(404, {"detail": "nada para firmar"})
        return self._send(404, {"detail": "no existe"})


# -------------------------------------------------------------------- andamiaje
def workspace():
    """Copia el proyecto a un directorio temporal: no toca dist/ real."""
    tmp = Path(tempfile.mkdtemp(prefix="fsys-test-"))
    for item in ("tools", "floorp-system-extension", "chrome", "site"):
        src = ROOT / item
        if src.exists():
            shutil.copytree(src, tmp / item,
                            ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
    for f in ("release.config.json", "package.json", ".gitignore"):
        if (ROOT / f).exists():
            shutil.copy2(ROOT / f, tmp / f)
    cfg = json.loads((tmp / "release.config.json").read_text(encoding="utf-8"))
    cfg["pages_base_url"] = "https://ejemplo-de-prueba.github.io/floorp-system"
    cfg["repo"] = "ejemplo-de-prueba/floorp-system"
    (tmp / "release.config.json").write_text(
        json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8")
    return tmp


def run(tmp, args, env_extra=None, expect_fail=False):
    env = dict(os.environ)
    env.pop("AMO_API_KEY", None)
    env.pop("AMO_API_SECRET", None)
    env.update(env_extra or {})
    p = subprocess.run([PY] + args, cwd=tmp, capture_output=True, text=True,
                       env=env, timeout=300)
    out = (p.stdout or "") + (p.stderr or "")
    if VERBOSE:
        print("    $ " + " ".join(args) + f"  -> {p.returncode}")
        for line in out.strip().splitlines()[-12:]:
            print("      " + line)
    return p.returncode, out


def check(name, fn):
    try:
        detail = fn()
        RESULTS.append((True, name, detail or ""))
        print(f"  PASS  {name}" + (f"  ({detail})" if detail else ""))
    except AssertionError as e:
        RESULTS.append((False, name, str(e)))
        print(f"  FAIL  {name}\n          -> {e}")
    except Exception as e:
        RESULTS.append((False, name, f"error: {e}"))
        print(f"  FAIL  {name}\n          -> error inesperado: {e}")


def main():
    tmp = workspace()
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    port = server.server_address[1]
    threading.Thread(target=server.serve_forever, daemon=True).start()
    api = f"http://127.0.0.1:{port}/api/v5"
    creds = {"AMO_API_KEY": ISSUER, "AMO_API_SECRET": SECRET, "FSYS_AMO_API": api}

    print(f"\nFLOORP SYSTEM // test_pipeline")
    print(f"  servidor AMO falso: {api}")
    print(f"  area de trabajo:    {tmp}\n")
    print("  --- flujo correcto ---")

    def t_build():
        rc, out = run(tmp, ["tools/build_xpi.py"])
        assert rc == 0, out[-600:]
        assert (tmp / "dist" / "floorp-system-unsigned.xpi").exists(), "no se creo el XPI"
        with zipfile.ZipFile(tmp / "dist" / "floorp-system-unsigned.xpi") as zf:
            m = json.loads(zf.read("manifest.json"))
        assert "update_url" in m["browser_specific_settings"]["gecko"], \
            "el XPI no lleva update_url"
        return m["browser_specific_settings"]["gecko"]["update_url"]

    check("empaquetado con update_url inyectado", t_build)

    def t_sign():
        rc, out = run(tmp, ["tools/sign_amo.py",
                            "--xpi", "dist/floorp-system-unsigned.xpi"], creds)
        assert rc == 0, out[-900:]
        signed = tmp / "dist" / "floorp-system-signed.xpi"
        assert signed.exists(), "no se genero el XPI firmado"
        with zipfile.ZipFile(signed) as zf:
            assert "META-INF/mozilla.rsa" in zf.namelist(), "el firmado no tiene META-INF"
        info = json.loads((tmp / "dist" / "sign-info.json").read_text(encoding="utf-8"))
        assert info["signed"] is True
        assert info["sha256"] == hashlib.sha256(signed.read_bytes()).hexdigest(), \
            "el sha256 registrado no corresponde al archivo"
        return f"v{info['version']}, canal {info['channel']}"

    check("firma contra AMO (JWT validado por el servidor)", t_sign)

    def t_channels():
        ups = list(State.uploads.values())
        assert ups, "el servidor no registro ningun envio"
        assert ups[0]["channel"] == "unlisted", f"canal enviado: {ups[0]['channel']}"
        return f"canal={ups[0]['channel']}"

    check("el envio declara el canal unlisted", t_channels)

    def t_manifest():
        rc, out = run(tmp, ["tools/publish_update.py",
                            "--xpi", "dist/floorp-system-signed.xpi",
                            "--download-url",
                            "https://github.com/u/r/releases/download/v/x.xpi"])
        assert rc == 0, out[-800:]
        upd = json.loads((tmp / "site" / "updates.json").read_text(encoding="utf-8"))
        entry = list(upd["addons"].values())[0]["updates"][-1]
        signed = (tmp / "dist" / "floorp-system-signed.xpi").read_bytes()
        assert entry["update_hash"] == "sha256:" + hashlib.sha256(signed).hexdigest(), \
            "el hash anunciado no corresponde al XPI firmado"
        assert entry["update_link"].startswith("https://")
        return f"v{entry['version']}"

    check("manifiesto de actualizaciones coherente", t_manifest)

    def t_verify_signed():
        rc, out = run(tmp, ["tools/verify_release.py",
                            "--xpi", "dist/floorp-system-signed.xpi"])
        assert rc == 0, out[-900:]
        sums = (tmp / "dist" / "SHA256SUMS.txt").read_text(encoding="utf-8")
        signed = (tmp / "dist" / "floorp-system-signed.xpi").read_bytes()
        assert hashlib.sha256(signed).hexdigest() in sums, "SHA256SUMS no coincide"
        assert (tmp / "dist" / "VERSION").exists(), "no se genero VERSION"
        return "hash y VERSION generados"

    check("verify_release acepta el paquete firmado", t_verify_signed)

    def t_verify_wrong_channel():
        rc, out = run(tmp, ["tools/verify_release.py",
                            "--xpi", "dist/floorp-system-signed.xpi",
                            "--base-url", "https://otro-canal.github.io/x"])
        assert rc != 0, "acepto un paquete que apunta a otro canal"
        assert "update_url" in out
        return "rechaza un update_url de otro canal"

    check("verify_release detecta canal equivocado", t_verify_wrong_channel)

    def t_validate_release():
        rc, out = run(tmp, ["tools/validate.py", "--release"])
        assert rc == 0, out[-900:]
        return "todos los checks en modo release"

    check("validacion en modo release", t_validate_release)

    print("\n  --- casos que DEBEN fallar ---")
    State.mode = "ok"

    def t_bad_secret():
        rc, out = run(tmp, ["tools/sign_amo.py",
                            "--xpi", "dist/floorp-system-unsigned.xpi"],
                      {"AMO_API_KEY": ISSUER, "AMO_API_SECRET": "secreto-incorrecto",
                       "FSYS_AMO_API": api})
        assert rc != 0, "firmo con un secret incorrecto (grave)"
        assert "401" in out or "credenciales" in out.lower(), \
            f"el error no explica el problema de credenciales: {out[-300:]}"
        return "rechaza credenciales invalidas"

    check("secret incorrecto -> se detiene", t_bad_secret)

    def t_bad_validation():
        State.mode = "failed_validation"
        rc, out = run(tmp, ["tools/sign_amo.py",
                            "--xpi", "dist/floorp-system-unsigned.xpi"], creds)
        State.mode = "ok"
        assert rc != 0, "siguio adelante con una validacion fallida"
        assert "fallo" in out.lower(), out[-300:]
        return "no continua si AMO rechaza la validacion"

    check("validacion de AMO fallida -> se detiene", t_bad_validation)

    def t_unsigned_manifest():
        build = tmp / "dist" / "floorp-system-unsigned.xpi"
        saved = (tmp / "site" / "updates.json").read_text(encoding="utf-8")
        rc, out = run(tmp, ["tools/publish_update.py",
                            "--xpi", str(build),
                            "--download-url", "https://example.com/x.xpi"])
        assert rc != 0, "genero manifiesto con un XPI SIN FIRMAR"
        (tmp / "site" / "updates.json").write_text(saved, encoding="utf-8")
        return "exige firma real"

    check("manifiesto con XPI sin firmar -> se niega", t_unsigned_manifest)

    def t_verify_unsigned_rejected():
        rc, out = run(tmp, ["tools/verify_release.py",
                            "--xpi", "dist/floorp-system-unsigned.xpi"])
        assert rc != 0, "acepto un paquete sin firma para publicar"
        assert "META-INF" in out, out[-300:]
        return "exige la firma de Mozilla"

    check("verify_release rechaza el paquete sin firma", t_verify_unsigned_rejected)

    def t_no_creds():
        rc, out = run(tmp, ["tools/sign_amo.py",
                            "--xpi", "dist/floorp-system-unsigned.xpi"])
        assert rc != 0, "firmo sin credenciales"
        assert "addons.mozilla.org/developers/addon/api/key" in out, \
            "no indica donde obtener las credenciales"
        return "mensaje con el enlace oficial"

    check("sin credenciales -> mensaje util", t_no_creds)

    server.shutdown()
    shutil.rmtree(tmp, ignore_errors=True)

    fails = [r for r in RESULTS if not r[0]]
    print()
    if fails:
        print(f"RESULTADO: {len(fails)} FALLO(S) de {len(RESULTS)} casos")
        return 1
    print(f"RESULTADO: {len(RESULTS)} CASOS OK\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
