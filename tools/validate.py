# -*- coding: utf-8 -*-
"""
validate.py — Validacion real del proyecto FLOORP SYSTEM.

No es una lista decorativa: cada check se ejecuta de verdad, construye el
XPI en memoria y lo inspecciona.

Uso:
    python tools/validate.py              # validacion normal (desarrollo)
    python tools/validate.py --release    # exige canal de publicacion configurado

Salida: PASS/FAIL por check. Exit code 1 si algo falla.
Solo libreria estandar (no requiere npm/node).
"""
import json
import re
import sys
import zipfile
from pathlib import Path

import _console  # noqa: F401  (salida UTF-8 en Windows)

ROOT = Path(__file__).resolve().parent.parent
EXT = ROOT / "floorp-system-extension"
CONFIG = ROOT / "release.config.json"
PKG = ROOT / "package.json"

OK = []
FAIL = []


def check(name, fn):
    try:
        detail = fn()
        OK.append((name, detail))
        print(f"  PASS  {name}" + (f"  ({detail})" if detail else ""))
    except Exception as e:
        FAIL.append((name, str(e)))
        print(f"  FAIL  {name}\n          -> {e}")


def load_config():
    if not CONFIG.exists():
        raise RuntimeError("falta release.config.json")
    return json.loads(CONFIG.read_text(encoding="utf-8"))


def load_manifest():
    p = EXT / "manifest.json"
    if not p.exists():
        raise RuntimeError("falta floorp-system-extension/manifest.json")
    return json.loads(p.read_text(encoding="utf-8"))


SEMVER = re.compile(r"^\d+\.\d+\.\d+$")


# ---------------------------------------------------------------- checks
def c_manifest_parses():
    m = load_manifest()
    for k in ("manifest_version", "name", "version"):
        if k not in m:
            raise RuntimeError(f"manifest sin campo obligatorio: {k}")
    return f"{m['name']} v{m['version']}"


def c_manifest_version():
    m, cfg = load_manifest(), load_config()
    if m["manifest_version"] != cfg["manifest_version"]:
        raise RuntimeError(
            f"manifest_version={m['manifest_version']} pero config dice "
            f"{cfg['manifest_version']}")
    return f"MV{m['manifest_version']}"


def c_semver():
    v = load_manifest()["version"]
    if not SEMVER.match(v):
        raise RuntimeError(f"version '{v}' no es X.Y.Z")
    return v


def c_id_stable():
    m, cfg = load_manifest(), load_config()
    gecko = (m.get("browser_specific_settings") or {}).get("gecko") or {}
    mid = gecko.get("id")
    if not mid:
        raise RuntimeError("manifest sin browser_specific_settings.gecko.id")
    if mid != cfg["addon_id"]:
        raise RuntimeError(f"id del manifest '{mid}' != config '{cfg['addon_id']}'")
    return mid


def c_version_consistency():
    v = load_manifest()["version"]
    if PKG.exists():
        pv = json.loads(PKG.read_text(encoding="utf-8")).get("version")
        if pv and pv != v:
            raise RuntimeError(f"package.json dice {pv}, manifest dice {v}")
    core = EXT / "newtab" / "js" / "core.js"
    if core.exists():
        txt = core.read_text(encoding="utf-8", errors="ignore")
        mm = re.search(r'const VERSION\s*=\s*"([^"]+)"', txt)
        if mm and mm.group(1) != v:
            raise RuntimeError(f"core.js VERSION={mm.group(1)} pero manifest={v}"
                               "  -> corre: python tools/bump_version.py --set " + v)
    return v


def c_permissions_not_elevated():
    m, cfg = load_manifest(), load_config()
    got = set(m.get("permissions") or [])
    base = set(cfg["permissions_baseline"])
    extra = got - base
    if extra:
        raise RuntimeError(f"permisos NUEVOS no aprobados: {sorted(extra)}"
                           "  (si son intencionales, agregalos a release.config.json)")
    got_h = set(m.get("host_permissions") or [])
    base_h = set(cfg["host_permissions_baseline"])
    extra_h = got_h - base_h
    if extra_h:
        raise RuntimeError(f"host_permissions NUEVOS: {sorted(extra_h)}")
    return f"{len(got)} permisos, {len(got_h)} hosts (sin elevacion)"


def c_background_scripts_exist():
    m = load_manifest()
    bg = m.get("background") or {}
    scripts = bg.get("scripts") or ([bg["service_worker"]] if bg.get("service_worker") else [])
    if not scripts:
        raise RuntimeError("manifest sin background.scripts")
    missing = [s for s in scripts if not (EXT / s).exists()]
    if missing:
        raise RuntimeError(f"background.scripts inexistentes: {missing}")
    return f"{len(scripts)} scripts"


def c_newtab_override():
    m = load_manifest()
    ov = (m.get("chrome_url_overrides") or {}).get("newtab")
    if not ov:
        raise RuntimeError("manifest sin chrome_url_overrides.newtab")
    if not (EXT / ov).exists():
        raise RuntimeError(f"chrome_url_overrides.newtab apunta a '{ov}' que no existe")
    return ov


def c_assets_exist():
    idx = EXT / "newtab" / "index.html"
    if not idx.exists():
        raise RuntimeError("falta newtab/index.html")
    html = idx.read_text(encoding="utf-8", errors="ignore")
    refs = re.findall(r'(?:src|href)="([^"#]+)"', html)
    local = [r for r in refs if not r.startswith(("http", "data:", "//"))]
    missing = [r for r in local if not (EXT / "newtab" / r).exists() and not (EXT / r).exists()]
    if missing:
        raise RuntimeError(f"index.html referencia archivos inexistentes: {missing}")
    return f"{len(local)} assets locales"


def c_update_url_https():
    m, cfg = load_manifest(), load_config()
    gecko = (m.get("browser_specific_settings") or {}).get("gecko") or {}
    url = gecko.get("update_url")
    base = (cfg.get("pages_base_url") or "").strip()
    if url:
        if not url.startswith("https://"):
            raise RuntimeError(f"update_url no es HTTPS: {url}")
        if base and not url.startswith(base):
            raise RuntimeError(f"update_url '{url}' no corresponde a base '{base}'")
        return url
    if base:
        return "ausente en origen (se inyecta al empaquetar)"
    return "no configurado aun (ver docs/RELEASING.md)"


def c_data_collection_declared():
    m = load_manifest()
    gecko = (m.get("browser_specific_settings") or {}).get("gecko") or {}
    dcp = gecko.get("data_collection_permissions")
    if not dcp:
        raise RuntimeError(
            "falta data_collection_permissions (obligatorio en AMO desde 2025-11-03)")
    return json.dumps(dcp, ensure_ascii=False)


SECRET_PATTERNS = [
    (re.compile(r"jwt_[A-Za-z0-9_\-]{10,}"), "token JWT de AMO"),
    (re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----"), "clave privada"),
    (re.compile(r"ghp_[A-Za-z0-9]{20,}"), "token GitHub"),
    (re.compile(r"github_pat_[A-Za-z0-9_]{20,}"), "token GitHub"),
]


def _tracked_files():
    """Archivos que formarian parte del repo (respeta .gitignore via git)."""
    import subprocess
    try:
        out = subprocess.run(["git", "ls-files", "-co", "--exclude-standard"],
                             cwd=ROOT, capture_output=True, text=True, timeout=60)
        if out.returncode == 0:
            return [ROOT / l for l in out.stdout.splitlines() if l.strip()]
    except Exception:
        pass
    # fallback sin git: solo carpetas del producto
    files = []
    for d in ("floorp-system-extension", "chrome", "tools", "installer", "fsys-bridge", "docs"):
        p = ROOT / d
        if p.exists():
            files += [f for f in p.rglob("*") if f.is_file()]
    return files


def c_no_secrets():
    hits = []
    for f in _tracked_files():
        if f.suffix.lower() in {".sqlite", ".db", ".png", ".jpg", ".zip", ".xpi", ".lz4"}:
            continue
        if f.name in {"token.txt"} or f.parent.name == "data":
            hits.append(f"{f}: archivo de datos/credenciales rastreado")
            continue
        try:
            txt = f.read_text(encoding="utf-8", errors="ignore")
        except Exception:
            continue
        for rx, label in SECRET_PATTERNS:
            if rx.search(txt):
                hits.append(f"{f.relative_to(ROOT)}: {label}")
    if hits:
        raise RuntimeError("posibles secretos:\n          " + "\n          ".join(hits))
    return f"{len(_tracked_files())} archivos limpios"


def c_xpi_integrity():
    """Construye el XPI en memoria y lo inspecciona (no escribe nada)."""
    import io
    m = load_manifest()
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for f in sorted(EXT.rglob("*")):
            if f.is_file():
                zf.write(f, f.relative_to(EXT).as_posix())
    buf.seek(0)
    with zipfile.ZipFile(buf) as zf:
        names = zf.namelist()
        if "manifest.json" not in names:
            raise RuntimeError("el XPI no tiene manifest.json en la raiz")
        inner = json.loads(zf.read("manifest.json"))
        if inner["version"] != m["version"]:
            raise RuntimeError("version dentro del XPI != manifest de origen")
        gid = inner["browser_specific_settings"]["gecko"]["id"]
        if gid != load_config()["addon_id"]:
            raise RuntimeError("id dentro del XPI no coincide")
        for bad in ("node_modules/", ".git/", "__pycache__/"):
            if any(n.startswith(bad) for n in names):
                raise RuntimeError(f"el XPI incluye basura: {bad}")
        bg = (inner.get("background") or {}).get("scripts") or []
        missing = [s for s in bg if s not in names]
        if missing:
            raise RuntimeError(f"el XPI no contiene {missing}")
    return f"{len(names)} archivos, {len(buf.getvalue())/1024:.0f} KB"


def c_update_manifest_format():
    p = ROOT / "site" / "updates.json"
    if not p.exists():
        return "sin generar todavia (se crea al publicar)"
    d = json.loads(p.read_text(encoding="utf-8"))
    if "addons" not in d:
        raise RuntimeError("updates.json sin clave 'addons'")
    cfg = load_config()
    if cfg["addon_id"] not in d["addons"]:
        raise RuntimeError(f"updates.json no tiene el id {cfg['addon_id']}")
    ups = d["addons"][cfg["addon_id"]].get("updates") or []
    if not ups:
        raise RuntimeError("updates.json sin entradas en updates[]")
    last = ups[-1]
    for k in ("version", "update_link"):
        if k not in last:
            raise RuntimeError(f"entrada de update sin '{k}'")
    if not last["update_link"].startswith("https://"):
        raise RuntimeError(f"update_link no es HTTPS: {last['update_link']}")
    if "update_hash" in last and not re.match(r"^sha256:[0-9a-f]{64}$", last["update_hash"]):
        raise RuntimeError("update_hash con formato invalido (sha256:<64 hex>)")
    if not SEMVER.match(last["version"]):
        raise RuntimeError(f"version en updates.json invalida: {last['version']}")
    return f"v{last['version']} publicado"


def c_workflows_sane():
    wf = ROOT / ".github" / "workflows"
    if not wf.exists():
        return "sin workflows"
    problems = []
    for f in sorted(wf.glob("*.yml")):
        txt = f.read_text(encoding="utf-8")
        # Regla de GitHub Actions: los secrets NO se pueden usar en `if:`.
        for i, line in enumerate(txt.splitlines(), 1):
            s = line.strip()
            if s.startswith("if:") and "secrets." in s:
                problems.append(f"{f.name}:{i} usa secrets.* dentro de if: (no permitido)")
            if s.startswith("if:") and "env." in s and "!= ''" in s:
                pass
        if "permissions:" not in txt:
            problems.append(f"{f.name}: sin bloque 'permissions:' (minimo privilegio)")
        if re.search(r"^\s*on:\s*pull_request_target", txt, re.M):
            problems.append(f"{f.name}: usa pull_request_target (riesgo con secretos)")
    if problems:
        raise RuntimeError("\n          ".join(problems))
    return f"{len(list(wf.glob('*.yml')))} workflows"


def c_release_channel_configured():
    cfg = load_config()
    base = (cfg.get("pages_base_url") or "").strip()
    if not base:
        raise RuntimeError(
            "canal de actualizaciones SIN configurar: completá 'pages_base_url' en "
            "release.config.json (o corre: python tools/configure.py)")
    if not base.startswith("https://"):
        raise RuntimeError(f"pages_base_url debe ser HTTPS: {base}")
    if base.endswith("/"):
        raise RuntimeError("pages_base_url no debe terminar en '/'")
    return base


# ---------------------------------------------------------------- main
def main():
    release = "--release" in sys.argv
    print("\nFLOORP SYSTEM // validate.py" + ("  [MODO RELEASE]" if release else ""))
    print(f"proyecto: {ROOT}\n")

    check("manifest.json se puede leer", c_manifest_parses)
    check("manifest_version coincide con la config", c_manifest_version)
    check("version es X.Y.Z", c_semver)
    check("ID estable y coincide con la config", c_id_stable)
    check("version consistente (manifest/package.json/core.js)", c_version_consistency)
    check("permisos no elevados", c_permissions_not_elevated)
    check("background.scripts existen", c_background_scripts_exist)
    check("chrome_url_overrides.newtab existe", c_newtab_override)
    check("assets de la newtab existen", c_assets_exist)
    check("update_url es HTTPS o esta pendiente", c_update_url_https)
    check("data_collection_permissions declarado", c_data_collection_declared)
    check("sin secretos en archivos versionados", c_no_secrets)
    check("integridad del XPI", c_xpi_integrity)
    check("formato de updates.json", c_update_manifest_format)
    check("workflows de GitHub Actions sanos", c_workflows_sane)
    if release:
        check("canal de publicacion configurado", c_release_channel_configured)

    print()
    if FAIL:
        print(f"RESULTADO: {len(FAIL)} FALLO(S), {len(OK)} OK")
        for n, e in FAIL:
            print(f"  x {n}: {e.splitlines()[0]}")
        print("\nNO publiques hasta arreglar esto.\n")
        return 1
    print(f"RESULTADO: TODO OK ({len(OK)} checks)\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
