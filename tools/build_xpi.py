# -*- coding: utf-8 -*-
"""
build_xpi.py — Empaquetado reproducible del XPI.

- Construye un ZIP con manifest.json en la raiz (formato XPI).
- INYECTA browser_specific_settings.gecko.update_url leido de
  release.config.json, SOLO dentro del paquete: el manifest de origen
  queda limpio, sin URLs inventadas.
- Zip determinista: mismo contenido -> mismo sha256 (timestamps fijos).
- Verifica el paquete antes de darlo por bueno.
- Escribe dist/build-info.json con version, id, sha256 y lista de archivos.

Salida:
  dist/floorp-system-unsigned.xpi            <- para firmar (tools/amo_sign.py)
  dist/floorp-system-<version>-unsigned.xpi  <- copia inmutable por version
  dist/floorp-system@fsys.system.xpi         <- nombre que espera extensions/
  dist/build-info.json

Uso:
  python tools/build_xpi.py
  python tools/build_xpi.py --check-only      # no escribe, solo verifica
"""
import hashlib
import json
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
EXT = ROOT / "floorp-system-extension"
DIST = ROOT / "dist"
CONFIG = ROOT / "release.config.json"

FIXED_DATE = (1980, 1, 1, 0, 0, 0)  # zip determinista


def load_config():
    return json.loads(CONFIG.read_text(encoding="utf-8"))


def _write(zf, name, data):
    info = zipfile.ZipInfo(name, date_time=FIXED_DATE)
    info.compress_type = zipfile.ZIP_DEFLATED
    info.external_attr = 0o644 << 16
    zf.writestr(info, data)


def build_bytes(base_url=""):
    """Devuelve (bytes_del_xpi, manifest_efectivo, lista_de_archivos)."""
    src_manifest_path = EXT / "manifest.json"
    if not src_manifest_path.exists():
        raise SystemExit("falta floorp-system-extension/manifest.json")

    manifest = json.loads(src_manifest_path.read_text(encoding="utf-8"))
    gecko = manifest.setdefault("browser_specific_settings", {}).setdefault("gecko", {})

    base = (base_url or "").strip().rstrip("/")
    if base:
        if not base.startswith("https://"):
            raise SystemExit(f"base_url debe ser HTTPS: {base}")
        gecko["update_url"] = base + "/updates.json"
    else:
        gecko.pop("update_url", None)

    files = sorted(p for p in EXT.rglob("*") if p.is_file()
                   and ".git" not in p.parts and "__pycache__" not in p.parts)

    import io
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        _write(zf, "manifest.json",
               json.dumps(manifest, ensure_ascii=False, indent=2).encode("utf-8"))
        for f in files:
            if f.name == "manifest.json" and f.parent == EXT:
                continue  # ya escrito (posiblemente con update_url inyectado)
            _write(zf, f.relative_to(EXT).as_posix(), f.read_bytes())

    data = buf.getvalue()

    # ---- verificacion del paquete recien construido
    with zipfile.ZipFile(io.BytesIO(data)) as zf:
        names = zf.namelist()
        if names.count("manifest.json") != 1:
            raise SystemExit("XPI invalido: manifest.json duplicado o ausente")
        inner = json.loads(zf.read("manifest.json"))
        if inner.get("version") != manifest.get("version"):
            raise SystemExit("XPI invalido: la version no coincide")
        gid = (inner.get("browser_specific_settings", {})
                   .get("gecko", {}).get("id"))
        if gid != load_config()["addon_id"]:
            raise SystemExit(f"XPI invalido: id '{gid}' no coincide con la config")
        for s in (inner.get("background", {}).get("scripts") or []):
            if s not in names:
                raise SystemExit(f"XPI invalido: falta el script de fondo {s}")
        ov = (inner.get("chrome_url_overrides") or {}).get("newtab")
        if ov and ov not in names:
            raise SystemExit(f"XPI invalido: falta {ov}")

    return data, manifest, names


def main():
    check_only = "--check-only" in sys.argv
    cfg = load_config()
    base = (cfg.get("pages_base_url") or "").strip()

    data, manifest, names = build_bytes(base)
    version = manifest["version"]
    addon_id = manifest["browser_specific_settings"]["gecko"]["id"]
    sha = hashlib.sha256(data).hexdigest()
    has_update_url = "update_url" in manifest["browser_specific_settings"]["gecko"]

    print(f"\nFLOORP SYSTEM // build  v{version}")
    print(f"  id          {addon_id}")
    print(f"  archivos    {len(names)}")
    print(f"  tamano      {len(data)/1024:.1f} KB")
    print(f"  sha256      {sha}")
    print(f"  update_url  {manifest['browser_specific_settings']['gecko'].get('update_url', '(no inyectado)')}")

    if check_only:
        print("\n  --check-only: no se escribio nada.\n")
        return 0

    DIST.mkdir(exist_ok=True)
    unsigned = DIST / "floorp-system-unsigned.xpi"
    versioned = DIST / f"floorp-system-{version}-unsigned.xpi"
    sideload = DIST / f"{addon_id}.xpi"
    for p in (unsigned, versioned, sideload):
        p.write_bytes(data)

    info = {
        "addon_id": addon_id,
        "version": version,
        "sha256": sha,
        "size": len(data),
        "update_url": manifest["browser_specific_settings"]["gecko"].get("update_url"),
        "files": names,
        "artifact": versioned.name,
    }
    (DIST / "build-info.json").write_text(
        json.dumps(info, ensure_ascii=False, indent=2), encoding="utf-8")

    print(f"\n  -> {unsigned.relative_to(ROOT)}")
    print(f"  -> {versioned.relative_to(ROOT)}")
    print(f"  -> {sideload.relative_to(ROOT)}   (copia para <perfil>/extensions/)")
    if not has_update_url:
        print("\n  AVISO: sin update_url las actualizaciones automaticas NO funcionan.")
        print("         Configura el canal: python tools/configure.py\n")
    else:
        print("\n  siguiente: python tools/sign_amo.py   (firma oficial de Mozilla)\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
