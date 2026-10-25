# -*- coding: utf-8 -*-
"""
configure.py — Configura el canal de distribucion con UN comando.

Escribe 'pages_base_url' (y opcionalmente 'repo') en release.config.json.
No inventa nada: si no le pasas datos, te los pregunta de forma simple.

Uso:
  python tools/configure.py --github-user joaquin
  python tools/configure.py --base-url https://joaquin.github.io/floorp-system
  python tools/configure.py --show
"""
import argparse
import json
import re
from pathlib import Path

import _console  # noqa: F401  (salida UTF-8 en Windows)

ROOT = Path(__file__).resolve().parent.parent
CONFIG = ROOT / "release.config.json"


def load():
    return json.loads(CONFIG.read_text(encoding="utf-8"))


def save(cfg):
    CONFIG.write_text(json.dumps(cfg, ensure_ascii=False, indent=2) + "\n",
                      encoding="utf-8")


def main():
    ap = argparse.ArgumentParser(description="Configura el canal de actualizaciones")
    ap.add_argument("--github-user", help="tu usuario de GitHub (ej: joaquin)")
    ap.add_argument("--repo-name", default="floorp-system",
                    help="nombre del repositorio (default: floorp-system)")
    ap.add_argument("--base-url", help="URL HTTPS completa de GitHub Pages")
    ap.add_argument("--show", action="store_true", help="muestra la config actual")
    ap.add_argument("--clear", action="store_true", help="borra el canal (volver a pendiente)")
    a = ap.parse_args()

    cfg = load()

    if a.clear:
        cfg["pages_base_url"] = ""
        cfg["repo"] = ""
        save(cfg)
        print("canal borrado: las actualizaciones automaticas quedan pendientes")
        return 0

    if a.show or not (a.github_user or a.base_url):
        base = cfg.get("pages_base_url") or "(sin configurar)"
        print("\ncanal de actualizaciones")
        print(f"  id del addon    {cfg['addon_id']}")
        print(f"  canal AMO       {cfg['channel']}")
        print(f"  repo            {cfg.get('repo') or '(sin configurar)'}")
        print(f"  pages_base_url  {base}")
        print(f"\n  update_url resultante: "
              f"{base}/updates.json" if cfg.get("pages_base_url") else
              "\n  update_url resultante: (ninguna — las actualizaciones no funcionaran)")
        print("\nPara configurarlo:")
        print("  python tools/configure.py --github-user TU-USUARIO\n")
        return 0

    if a.base_url:
        base = a.base_url.strip().rstrip("/")
        if not base.startswith("https://"):
            raise SystemExit("la URL debe empezar con https://")
        cfg["pages_base_url"] = base
        m = re.match(r"https://([^.]+)\.github\.io/([^/]+)", base)
        if m:
            cfg["repo"] = f"{m.group(1)}/{m.group(2)}"
    else:
        user = a.github_user.strip().lower()
        if not re.match(r"^[a-z0-9](?:[a-z0-9-]{0,38})$", user):
            raise SystemExit(f"usuario de GitHub invalido: {user}")
        repo = a.repo_name.strip()
        cfg["pages_base_url"] = f"https://{user}.github.io/{repo}"
        cfg["repo"] = f"{user}/{repo}"

    save(cfg)
    print("\nconfigurado:")
    print(f"  pages_base_url  {cfg['pages_base_url']}")
    print(f"  repo            {cfg['repo']}")
    print(f"  update_url      {cfg['pages_base_url']}/updates.json")
    print("\nAhora: python tools/release.py\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
