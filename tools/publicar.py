# -*- coding: utf-8 -*-
"""
publicar.py — Publicar una versión nueva con UN comando.

Hace, en orden, todo lo que hace falta para que GitHub Actions firme y
publique la versión:

  1. comprueba que el repositorio tenga remoto (si no, explica qué falta)
  2. valida el proyecto completo
  3. sube el número de versión en todos los archivos
  4. vuelve a validar (versión coherente en manifest/package/core.js)
  5. prepara el commit
  6. crea el tag vX.Y.Z
  7. sube el commit y el tag -> GitHub Actions hace el resto

Nunca fuerza nada: si el push falla, se detiene y no toca el historial.

Uso:
  python tools/publicar.py                    # sube el último número (0.19.0 -> 0.19.1)
  python tools/publicar.py minor               # 0.19.0 -> 0.20.0
  python tools/publicar.py major               # 1.0.0
  python tools/publicar.py --set 0.19.2        # número exacto
  python tools/publicar.py patch --si          # sin preguntar (para scripts)
  python tools/publicar.py patch --dry-run     # muestra qué haría y no toca nada
"""
import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

import _console  # noqa: F401  (salida UTF-8 en Windows)

ROOT = Path(__file__).resolve().parent.parent
PY = sys.executable or "python"
MANIFEST = ROOT / "floorp-system-extension" / "manifest.json"


def sh(args, check=False):
    p = subprocess.run(args, cwd=ROOT, capture_output=True, text=True)
    if check and p.returncode != 0:
        raise SystemExit(f"falló: {' '.join(args)}\n{(p.stderr or p.stdout)[:600]}")
    return p


def fail(msg):
    print(f"\n  DETENIDO: {msg}")
    return 1


def remote_url():
    p = sh(["git", "remote", "get-url", "origin"])
    return p.stdout.strip() if p.returncode == 0 else ""


def actions_url(remote):
    m = re.search(r"github\.com[:/]([^/]+)/([^/.]+?)(?:\.git)?$", remote)
    if not m:
        return ""
    return f"https://github.com/{m.group(1)}/{m.group(2)}/actions"


def pages_url(remote):
    m = re.search(r"github\.com[:/]([^/]+)/([^/.]+?)(?:\.git)?$", remote)
    if not m:
        return ""
    return f"https://{m.group(1)}.github.io/{m.group(2)}"


def tag_exists(tag):
    return sh(["git", "rev-parse", "--verify", f"refs/tags/{tag}"]).returncode == 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("part", nargs="?", default="patch",
                    choices=["patch", "minor", "major"])
    ap.add_argument("--set", dest="exact")
    ap.add_argument("--si", "--yes", dest="yes", action="store_true",
                    help="no pedir confirmación")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()

    print("\nFLOORP SYSTEM // publicar")

    # 1 ------------------------------------------------------------- git
    if sh(["git", "rev-parse", "--is-inside-work-tree"]).returncode != 0:
        return fail("esta carpeta no es un repositorio git")
    branch = sh(["git", "branch", "--show-current"]).stdout.strip() or "master"
    remote = remote_url()
    if not remote:
        print("\n  El repositorio todavía no está conectado a GitHub.")
        print("  Pasos (una sola vez):")
        print("    1) creá un repositorio vacío en https://github.com/new")
        print("       nombre sugerido: floorp-system   (sin README ni .gitignore)")
        print("    2) conectalo y subí lo que ya existe:")
        print("         git remote add origin https://github.com/TU-USUARIO/floorp-system.git")
        print(f"         git push -u origin {branch}")
        print("    3) volvé a correr: python tools/publicar.py")
        return 1
    if "github.com" not in remote:
        print(f"  AVISO: el remoto no es GitHub: {remote}")

    # 2 ---------------------------------------------------------- validar
    print(f"  repositorio  {remote}")
    print(f"  rama         {branch}")
    print("\n  [1/5] validando el proyecto...")
    if subprocess.run([PY, "tools/validate.py"], cwd=ROOT).returncode != 0:
        return fail("la validación falló. No se publica nada.\n"
                    "         Corregí los errores de arriba y volvé a intentar.")

    cur = json.loads(MANIFEST.read_text(encoding="utf-8"))["version"]
    if a.exact:
        new = a.exact
        if not re.match(r"^\d+\.\d+\.\d+$", new):
            return fail("el número de versión tiene que ser X.Y.Z (ej: 0.19.1)")
    else:
        major, minor, patch = (int(x) for x in cur.split("."))
        new = (f"{major + 1}.0.0" if a.part == "major" else
               f"{major}.{minor + 1}.0" if a.part == "minor" else
               f"{major}.{minor}.{patch + 1}")
    tag = f"v{new}"
    if tag_exists(tag):
        return fail(f"el tag {tag} ya existe. Elegí otro número "
                    f"(por ejemplo --set {new[:-1]}{int(new[-1]) + 1}).")

    print(f"\n  [2/5] versión {cur} -> {new}")
    if a.dry_run:
        print("\n  --dry-run: no se modificó ni se subió nada.")
        print("  Esto es lo que haría de verdad:")
        print(f"    - subir la versión a {new} en manifest.json, package.json y core.js")
        print("    - commit  \"chore: v{new}\"")
        print(f"    - tag     {tag}")
        print(f"    - push    origin {branch} --tags")
        return 0

    changed = sh(["git", "status", "--short"]).stdout.strip()
    if changed:
        print("\n  Archivos que se van a incluir en el commit:")
        for line in changed.splitlines()[:25]:
            print("    " + line)
        if len(changed.splitlines()) > 25:
            print(f"    ... y {len(changed.splitlines()) - 25} más")
    else:
        print("\n  No hay cambios de código: se publica la versión actual.")

    if not a.yes:
        print(f"\n  Se va a publicar la versión {new} y se va a subir a GitHub.")
        print("  GitHub Actions la firmará en Mozilla y la publicará sola.")
        ans = input("  ¿Seguir? escribí SI: ").strip().lower()
        if ans not in ("si", "sí", "s", "yes", "y"):
            print("  Cancelado. No se cambió nada.")
            return 1

    # 3 ------------------------------------------------------------ bump
    print(f"\n  [3/5] subiendo la versión...")
    p = subprocess.run([PY, "tools/bump_version.py", "--set", new], cwd=ROOT)
    if p.returncode != 0:
        return fail("no se pudo cambiar la versión")

    print("\n  [4/5] validando otra vez con la versión nueva...")
    if subprocess.run([PY, "tools/validate.py"], cwd=ROOT).returncode != 0:
        pc = subprocess.run([PY, "tools/bump_version.py", "--set", cur], cwd=ROOT)
        return fail("la versión nueva rompió la validación. Se revirtió el número.")

    # 4 ------------------------------------------------- commit + tag
    print(f"\n  [5/5] preparando commit y tag...")
    if sh(["git", "add", "-A"]).returncode != 0:
        return fail("no se pudieron preparar los cambios")
    msg = f"chore: v{new}"
    c = sh(["git", "commit", "-m", msg])
    if c.returncode != 0:
        print("  (no había nada nuevo que confirmar; se sigue con el tag)")
    if sh(["git", "tag", "-a", tag, "-m", f"FLOORP SYSTEM {new}"]).returncode != 0:
        return fail(f"no se pudo crear el tag {tag}")

    # 5 ------------------------------------------------------------ push
    print(f"  subiendo a {remote} ...")
    p1 = sh(["git", "push", "origin", branch])
    if p1.returncode != 0:
        return fail("no se pudo subir el commit:\n"
                    f"{(p1.stderr or p1.stdout)[:700]}\n"
                    "         (si falta iniciar sesión en GitHub, mirá el "
                    "README → GitHub paso a paso)")
    p2 = sh(["git", "push", "origin", tag])
    if p2.returncode != 0:
        return fail("el commit subió pero el tag no. Volvé a correr:\n"
                    f"         git push origin {tag}")

    url = actions_url(remote)
    canal = pages_url(remote)
    print(f"\n  LISTO. v{new} subida.")
    if url:
        print(f"  Seguí el progreso acá:  {url}")
    print("\n  Qué pasa ahora, solo:")
    print("    1. GitHub valida y firma la extensión en Mozilla (2-10 min).")
    print("    2. Publica el archivo .xpi en el release.")
    print("    3. Actualiza el canal de actualizaciones.")
    if canal:
        print(f"\n  Canal: {canal}/updates.json")
    print("\n  Si algo falla, el canal NO se actualiza: los usuarios siguen")
    print("  con la versión anterior hasta que lo arregles.\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
