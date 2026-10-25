#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
FLOORP SYSTEM — fsys-bridge
Servidor local que le da al navegador poder sobre el SO, bajo reglas:
  · loopback-only (127.0.0.1)
  · token compartido (header X-FSYS-TOKEN, vive en data/token.txt)
  · allowlist cerrada de apps (data/apps.json + data/custom_apps.json)
  · lanzamiento de apps SIN shell: subprocess.Popen([ruta, *args_literales])
  · archivos limitados a data/workspace/ (escritura) y rutas permitidas (lectura)

Stdlib pura. Corre con:  python fsys_bridge.py
                         python fsys_bridge.py --port 58230
"""
import argparse
import json
import os
import shutil
import subprocess
import sys
import threading
import time
import urllib.request
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, quote, unquote, urlparse

# ---------------------------------------------------------------- rutas
BRIDGE_DIR = Path(__file__).resolve().parent
DATA_DIR = BRIDGE_DIR / "data"
WORKSPACE = DATA_DIR / "workspace"
TOKEN_FILE = DATA_DIR / "token.txt"
APPS_FILE = DATA_DIR / "apps.json"
CUSTOM_APPS_FILE = DATA_DIR / "custom_apps.json"

for d in (DATA_DIR, WORKSPACE):
    d.mkdir(parents=True, exist_ok=True)

# AI CORE: Ollama local (sin claves, sin nube). Si no está instalado,
# /ai/status responde online:false y el sistema entero sigue igual.
OLLAMA = "http://127.0.0.1:11434"

# FLOORP OS SERVER (v0.13): el server local del propio Floorp. Cuando el
# pref floorp.os.enabled está en true, expone los WORKSPACES REALES del
# navegador en 127.0.0.1:58261 y exige su token Bearer, que Floorp escribe
# en ~/.floorp/os-server-token. El bridge lo lee y lo reenvía — la web
# nunca ve el token (el bridge lo agrega server-side).
FLOORP_OS = "http://127.0.0.1:58261"
FLOORP_TOKEN_FILE = Path(os.path.expanduser("~")) / ".floorp" / "os-server-token"


def floorp_token():
    try:
        return FLOORP_TOKEN_FILE.read_text(encoding="utf-8").strip()
    except Exception:
        return ""


def floorp_proxy(path, method="GET", body=None, timeout=4):
    """Reenvía al OS Server de Floorp inyectando su token Bearer."""
    tok = floorp_token()
    req = urllib.request.Request(FLOORP_OS + path, method=method)
    req.add_header("Accept", "application/json")
    if tok:
        req.add_header("Authorization", "Bearer " + tok)
    data = None
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, data=data, timeout=timeout) as r:
            return json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        try:
            return json.loads(e.read().decode("utf-8"))
        except Exception:
            return {"ok": False, "error": "FLOORP_OS_HTTP_%d" % e.code}
    except Exception:
        return {"ok": False, "error": "FLOORP_OS_OFFLINE"}

# ---------------------------------------------------------------- catálogo
DEFAULT_APPS = {
    "spotify": {
        "name": "Spotify",
        "win": ["%APPDATA%\\Spotify\\Spotify.exe"],
        "linux": ["/usr/bin/spotify", "/snap/bin/spotify", "/opt/spotify/spotify"],
    },
    "discord": {
        "name": "Discord",
        "win": ["%LOCALAPPDATA%\\Discord\\Update.exe"],
        "win_args": ["--processStart", "Discord.exe"],
        "linux": ["/usr/bin/discord", "/snap/bin/discord", "/opt/discord/Discord"],
    },
    "steam": {
        "name": "Steam",
        "win": [
            "C:\\Program Files (x86)\\Steam\\steam.exe",
            "D:\\Steam\\steam.exe",
        ],
        "linux": ["/usr/bin/steam", "/usr/games/steam"],
    },
    "code": {
        "name": "VS Code",
        "win": ["%LOCALAPPDATA%\\Programs\\Microsoft VS Code\\Code.exe",
                "C:\\Program Files\\Microsoft VS Code\\Code.exe"],
        "linux": ["/usr/bin/code", "/snap/bin/code"],
    },
    "telegram": {
        "name": "Telegram",
        "win": ["%APPDATA%\\Telegram Desktop\\Telegram.exe"],
        "linux": ["/usr/bin/telegram-desktop", "/snap/bin/telegram-desktop"],
    },
    "vlc": {
        "name": "VLC",
        "win": ["C:\\Program Files\\VideoLAN\\VLC\\vlc.exe"],
        "linux": ["/usr/bin/vlc", "/snap/bin/vlc"],
    },
    "calculator": {
        "name": "Calculadora",
        "win": ["C:\\Windows\\System32\\calc.exe"],
        "linux": ["/usr/bin/gnome-calculator", "/usr/bin/kcalc"],
    },
    "notepad": {
        "name": "Bloc de notas",
        "win": ["C:\\Windows\\System32\\notepad.exe"],
        "linux": ["/usr/bin/gedit", "/usr/bin/kate", "/usr/bin/leafpad"],
    },
    "explorer": {
        "name": "Archivos",
        "win": ["C:\\Windows\\explorer.exe"],
        "linux": ["/usr/bin/nautilus", "/usr/bin/dolphin", "/usr/bin/thunar"],
    },
    "terminal": {
        "name": "Terminal",
        "win": ["C:\\Windows\\System32\\cmd.exe", "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"],
        "linux": ["/usr/bin/gnome-terminal", "/usr/bin/konsole", "/usr/bin/xterm"],
    },
    "taskmgr": {
        "name": "Administrador de tareas",
        "win": ["C:\\Windows\\System32\\taskmgr.exe"],
        "linux": ["/usr/bin/gnome-system-monitor", "/usr/bin/htop"],
    },
}


def expand(p: str) -> str:
    """Expande %ENV% y ~ en rutas de Windows/Linux."""
    return os.path.expandvars(os.path.expanduser(p))


def load_json(path: Path, fallback):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return fallback


def save_json(path: Path, data):
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")


TOKEN = None


def ensure_token():
    global TOKEN
    if TOKEN_FILE.exists():
        TOKEN = TOKEN_FILE.read_text(encoding="utf-8").strip()
    else:
        TOKEN = uuid.uuid4().hex
        TOKEN_FILE.write_text(TOKEN, encoding="utf-8")


def app_exe(app: dict):
    """Devuelve (exe_expandido, args) de la primera ruta que existe, o None."""
    if sys.platform.startswith("win"):
        cands, argkey = app.get("win", []), "win_args"
    else:
        cands, argkey = app.get("linux", []), "linux_args"
    for c in cands:
        exe = expand(c)
        if os.path.isfile(exe):
            return exe, app.get(argkey, [])
    return None


def all_apps() -> dict:
    apps = dict(DEFAULT_APPS)
    apps.update(load_json(CUSTOM_APPS_FILE, {}))
    return apps


def resolve_app(name: str):
    """Nombre → (key, def, exe) o (key, def, None) si no instalada."""
    apps = all_apps()
    key = name.lower().strip()
    if key not in apps:
        return None, None, None
    d = apps[key]
    return key, d, (app_exe(d) or (None, None))[0]


# ================================================================ SYS
# Métricas reales de la máquina, sin dependencias externas.
# ---- Batería (para la automatización auto-battery): 0.0-1.0 o None ----
# Sin dependencias: /sys/class/power_supply en Linux; WMI via PowerShell
# solo si está disponible en Windows (cache 60s, cero polling continuo).
_BAT_CACHE = {"t": 0, "v": None, "has": True}

def _battery_level():
    now = time.time()
    if now - _BAT_CACHE["t"] < 60:
        return _BAT_CACHE["v"]
    val = None
    try:
        if os.name == "nt":
            out = subprocess.run(
                ["powershell", "-NoProfile", "-Command",
                 "(Get-WmiObject Win32_Battery).EstimatedChargeRemaining"],
                capture_output=True, text=True, timeout=4,
            )
            txt = (out.stdout or "").strip()
            if txt and txt.replace(".", "", 1).isdigit():
                val = float(txt) / 100.0
        else:
            base = Path("/sys/class/power_supply")
            for bat in sorted(base.glob("BAT*")):
                p = bat / "capacity"
                if p.exists():
                    val = int(p.read_text().strip()) / 100.0
                    break
    except Exception:
        val = None
    _BAT_CACHE.update(t=now, v=val)
    return val

# Windows: GetSystemTimes/GlobalMemoryStatusEx vía ctypes.
# Linux: /proc/stat, /proc/meminfo, os.getloadavg.
# ================================================================ sys
class Sys:
    _last_cpu = None   # (idle, total) del muestreo anterior

    @staticmethod
    def _cpu_times():
        if sys.platform.startswith("win"):
            import ctypes
            class TS(ctypes.Structure):
                _fields_ = [("idle", ctypes.c_uint64), ("kernel", ctypes.c_uint64), ("user", ctypes.c_uint64)]
            ts_idle, ts_kernel, ts_user = TS(), TS(), TS()
            ctypes.windll.kernel32.GetSystemTimes(ctypes.byref(ts_idle), ctypes.byref(ts_kernel), ctypes.byref(ts_user))
            idle = ts_idle.idle
            total = ts_idle.idle + ts_kernel.idle + ts_user.idle
            return idle, total
        else:
            with open("/proc/stat") as f:
                parts = f.readline().split()[1:]
            vals = list(map(int, parts))
            idle = vals[3] + (vals[4] if len(vals) > 4 else 0)   # idle + iowait
            total = sum(vals)
            return idle, total

    @staticmethod
    def cpu_percent():
        """% de uso de CPU total: delta entre dos muestreos (100ms)."""
        try:
            idle1, total1 = Sys._cpu_times()
            time.sleep(0.1)
            idle2, total2 = Sys._cpu_times()
            dt = total2 - total1
            di = idle2 - idle1
            if dt <= 0:
                return None
            return round(min(100.0, max(0.0, (1 - di / dt) * 100)), 1)
        except Exception:
            return None

    @staticmethod
    def mem():
        """RAM del sistema: {total_mb, used_mb, percent} o None."""
        try:
            if sys.platform.startswith("win"):
                import ctypes
                class MS(ctypes.Structure):
                    _fields_ = [
                        ("dwLength", ctypes.c_uint32), ("dwMemoryLoad", ctypes.c_uint32),
                        ("ullTotalPhys", ctypes.c_uint64), ("ullAvailPhys", ctypes.c_uint64),
                        ("ullTotalPageFile", ctypes.c_uint64), ("ullAvailPageFile", ctypes.c_uint64),
                        ("ullTotalVirtual", ctypes.c_uint64), ("ullAvailVirtual", ctypes.c_uint64),
                        ("ullAvailExtendedVirtual", ctypes.c_uint64),
                    ]
                ms = MS()
                ms.dwLength = ctypes.sizeof(MS)
                ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(ms))
                total, avail = ms.ullTotalPhys, ms.ullAvailPhys
                used = total - avail
                return {"total_mb": round(total / 1048576), "used_mb": round(used / 1048576),
                        "percent": round(used / total * 100, 1) if total else 0}
            else:
                info = {}
                with open("/proc/meminfo") as f:
                    for line in f:
                        k, v = line.split(":")
                        info[k.strip()] = int(v.strip().split()[0])   # kB
                total = info.get("MemTotal", 0)
                avail = info.get("MemAvailable", info.get("MemFree", 0))
                used = total - avail
                return {"total_mb": round(total / 1024), "used_mb": round(used / 1024),
                        "percent": round(used / total * 100, 1) if total else 0}
        except Exception:
            return None

    @staticmethod
    def uptime_s():
        """Segundos encendida la máquina."""
        try:
            if sys.platform.startswith("win"):
                import ctypes
                return int(ctypes.windll.kernel32.GetTickCount64() / 1000)
            with open("/proc/uptime") as f:
                return int(float(f.read().split()[0]))
        except Exception:
            return None

    @staticmethod
    def disks():
        """Uso de disco por punto de montaje (donde se pueda)."""
        out = []
        try:
            if sys.platform.startswith("win"):
                import string
                for letter in string.ascii_uppercase:
                    root = f"{letter}:\\"
                    if os.path.exists(root):
                        try:
                            t, u, f = shutil.disk_usage(root)
                            out.append({"mount": root, "total_gb": round(t / 1073741824, 1),
                                        "used_gb": round(u / 1073741824, 1),
                                        "percent": round(u / t * 100, 1) if t else 0})
                        except Exception:
                            pass
            else:
                st = os.statvfs("/")
                t = st.f_blocks * st.f_frsize
                u = t - st.f_bavail * st.f_frsize
                out.append({"mount": "/", "total_gb": round(t / 1073741824, 1),
                            "used_gb": round(u / 1073741824, 1),
                            "percent": round(u / t * 100, 1) if t else 0})
        except Exception:
            pass
        return out

    @staticmethod
    def processes(limit=15):
        """Top procesos por RAM. Sin dependencias: tasklist (Win) / ps (Linux)."""
        procs = []
        try:
            if sys.platform.startswith("win"):
                raw = subprocess.run(["tasklist", "/FO", "CSV", "/NH"], capture_output=True,
                                     text=True, timeout=5).stdout
                import re as _re
                import csv as _csv
                for line in raw.splitlines():
                    parts = next(_csv.reader([line]), None)
                    if not parts or len(parts) < 5:
                        continue
                    name, pid = parts[0], parts[1]
                    # Windows localizado: "13.496 KB" / "13,496 K" → solo dígitos
                    digits = _re.sub(r"[^0-9]", "", parts[4])
                    try:
                        procs.append({"pid": int(pid), "name": name, "mem_mb": round(int(digits) / 1024, 1)})
                    except ValueError:
                        continue
            else:
                raw = subprocess.run(["ps", "-eo", "pid,comm,rss", "--sort=-rss"], capture_output=True,
                                     text=True, timeout=5).stdout
                for line in raw.splitlines()[1:]:
                    parts = line.split(None, 2)
                    if len(parts) < 3:
                        continue
                    try:
                        procs.append({"pid": int(parts[0]), "name": parts[1].split("/")[-1],
                                      "mem_mb": round(int(parts[2]) / 1024, 1)})
                    except ValueError:
                        continue
        except Exception:
            pass
        procs.sort(key=lambda p: -p["mem_mb"])
        return procs[:limit]

    @staticmethod
    def kill(pid: int):
        """Mata un proceso por PID (el confirm de 2 pasos vive en la terminal)."""
        try:
            if sys.platform.startswith("win"):
                r = subprocess.run(["taskkill", "/F", "/PID", str(pid)], capture_output=True, text=True, timeout=5)
                return r.returncode == 0
            r = subprocess.run(["kill", "-9", str(pid)], capture_output=True, text=True, timeout=5)
            return r.returncode == 0
        except Exception:
            return False


# ---------------------------------------------------------------- handlers
class Handler(BaseHTTPRequestHandler):
    server_version = "fsys-bridge/1.0"

    def log_message(self, fmt, *args):  # log mínimo
        sys.stderr.write("[fsys] %s\n" % (fmt % args))

    # -- utilidades de respuesta
    def _json(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "null")  # no CORS: solo la extensión via fetch con token
        self.end_headers()
        self.wfile.write(body)

    def _authed(self) -> bool:
        if not TOKEN:
            return False
        import hmac
        return hmac.compare_digest(self.headers.get("X-FSYS-TOKEN") or "", TOKEN)

    def _body(self):
        try:
            n = int(self.headers.get("Content-Length") or 0)
            return json.loads(self.rfile.read(n) or b"{}")
        except Exception:
            return {}

    # -- GET
    def do_GET(self):
        path = urlparse(self.path).path.rstrip("/")

        # Único endpoint SIN auth (bootstrap): la extensión se autentica con
        # su permiso de host; una página web normal no puede leer la respuesta
        # porque el bridge nunca envía cabeceras CORS.
        if path == "/token":
            return self._json({"ok": True, "token": TOKEN})

        if not self._authed():
            return self._json({"ok": False, "error": "UNAUTHORIZED"}, 401)

        if path == "/health":
            return self._json({"ok": True, "bridge": "fsys-bridge", "version": "1.0.0",
                               "platform": sys.platform, "workspace": str(WORKSPACE)})

        if path == "/apps":
            apps = []
            for key, d in sorted(all_apps().items()):
                exe, _ = app_exe(d) or (None, None)
                apps.append({"id": key, "name": d.get("name", key), "installed": bool(exe),
                             "custom": key in load_json(CUSTOM_APPS_FILE, {})})
            return self._json({"ok": True, "apps": apps})

        if path == "/files":
            items = []
            for p in sorted(WORKSPACE.iterdir()):
                if p.is_file():
                    items.append({"name": p.name, "size": p.stat().st_size,
                                  "mtime": int(p.stat().st_mtime)})
            return self._json({"ok": True, "files": items, "dir": str(WORKSPACE)})

        # ---- archivos: LEER (solo workspace, top 256KB) — notas y textos
        if path == "/files/read":
            qs = parse_qs(urlparse(self.path).query)
            name = str((qs.get("name") or [""])[0]).strip()
            target = WORKSPACE / name
            if (not name or "/" in name or "\\" in name or ".." in name
                    or not target.is_file() or WORKSPACE not in target.resolve().parents):
                return self._json({"ok": False, "error": "archivo no encontrado en el workspace"}, 404)
            data = target.read_text(encoding="utf-8", errors="replace")
            return self._json({"ok": True, "name": name, "text": data[:262144]})

        # ---- métricas del sistema (task manager real)
        if path == "/sys":
            return self._json({
                "ok": True,
                "cpu": {"percent": Sys.cpu_percent(), "cores": os.cpu_count()},
                "mem": Sys.mem(),
                "disks": Sys.disks(),
                "uptime_s": Sys.uptime_s(),
                "python": sys.version.split()[0],
                **({"battery": _battery_level()} if _battery_level() is not None else {}),
            })

        # ---- procesos: top por RAM
        if path == "/processes":
            return self._json({"ok": True, "processes": Sys.processes(15)})

        # ---- FLOORP OS: proxy al server local del navegador (v0.13) ----
        # El bridge inyecta el token Bearer de Floorp — la página nunca
        # ve el token y no puede tocar el server sin pasar por acá.
        if path == "/floorp/workspaces":
            d = floorp_proxy("/workspaces")
            if d.get("workspaces") is not None:
                return self._json({"ok": True, **d})
            return self._json(d, 502)
        if path == "/floorp/workspaces/current":
            d = floorp_proxy("/workspaces/current")
            if d.get("workspaceId") is not None or d.get("error") == "FLOORP_OS_OFFLINE":
                return self._json({"ok": True, **d})
            return self._json(d, 502)
        if path.startswith("/floorp/workspaces/") and path.endswith("/switch"):
            wid = unquote(path[len("/floorp/workspaces/"):-len("/switch")])
            d = floorp_proxy("/workspaces/%s/switch" % quote(wid, safe=""), method="POST", body={}, timeout=6)
            return self._json(d, 200 if d.get("success") else 502)
        if path == "/floorp/workspaces/next":
            d = floorp_proxy("/workspaces/next", method="POST", body={}, timeout=6)
            return self._json(d, 200 if d.get("success") else 502)
        if path == "/floorp/workspaces/previous":
            d = floorp_proxy("/workspaces/previous", method="POST", body={}, timeout=6)
            return self._json(d, 200 if d.get("success") else 502)

        # ---- AI CORE: estado de Ollama local (BOOT 10)
        if path == "/ai/status":
            try:
                with urllib.request.urlopen(OLLAMA + "/api/tags", timeout=2) as r:
                    tags = json.loads(r.read().decode("utf-8"))
                models = [m.get("name", "?") for m in tags.get("models", [])]
                return self._json({"ok": True, "ai": {"online": True, "backend": "ollama", "models": models}})
            except Exception:
                return self._json({"ok": True, "ai": {"online": False, "backend": "ollama", "models": []}})

        return self._json({"ok": False, "error": "NOT_FOUND"}, 404)

    # -- POST
    def do_POST(self):
        if not self._authed():
            return self._json({"ok": False, "error": "UNAUTHORIZED"}, 401)
        path = urlparse(self.path).path.rstrip("/")
        body = self._body()

        # ---- FLOORP OS: proxy POST (switch/next/previous) — v0.13
        if path == "/floorp/workspaces/next":
            d = floorp_proxy("/workspaces/next", method="POST", body={}, timeout=6)
            return self._json(d, 200 if d.get("success") else 502)
        if path == "/floorp/workspaces/previous":
            d = floorp_proxy("/workspaces/previous", method="POST", body={}, timeout=6)
            return self._json(d, 200 if d.get("success") else 502)
        if path.startswith("/floorp/workspaces/") and path.endswith("/switch"):
            wid = unquote(path[len("/floorp/workspaces/"):-len("/switch")])
            d = floorp_proxy("/workspaces/%s/switch" % quote(wid, safe=""), method="POST", body={}, timeout=6)
            return self._json(d, 200 if d.get("success") else 502)

        # ---- lanzar app (allowlist, sin shell)
        m = urlparse(self.path)
        if path.startswith("/apps/") and path.endswith("/launch"):
            key = unquote(path[len("/apps/"):-len("/launch")]).lower()
            _, d, exe = resolve_app(key)
            if d is None:
                return self._json({"ok": False, "error": f"app desconocida: {key}"}, 404)
            if not exe:
                return self._json({"ok": False, "error": f"{key} no está instalada en esta máquina"}, 409)
            exe2, args = app_exe(d) or (None, [])
            try:
                subprocess.Popen([exe2, *args], cwd=os.path.dirname(exe2) or None,
                                 stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                return self._json({"ok": True, "launched": key, "exe": exe2})
            except Exception as e:
                return self._json({"ok": False, "error": f"no se pudo lanzar: {e}"}, 500)

        # ---- registrar app del usuario
        if path == "/apps/add":
            name = str(body.get("name", "")).lower().strip()
            exe = str(body.get("exe", "")).strip()
            if not name or not exe:
                return self._json({"ok": False, "error": "name y exe son obligatorios"}, 400)
            if not name.isalnum():
                return self._json({"ok": False, "error": "usá un nombre alfanumérico (sin espacios)"}, 400)
            exe_exp = expand(exe)
            if not os.path.isfile(exe_exp):
                return self._json({"ok": False, "error": f"la ruta no existe: {exe_exp}"}, 409)
            custom = load_json(CUSTOM_APPS_FILE, {})
            custom[name] = {"name": name.capitalize(), "win": [exe] if sys.platform.startswith("win") else [],
                            "linux": [] if sys.platform.startswith("win") else [exe]}
            save_json(CUSTOM_APPS_FILE, custom)
            return self._json({"ok": True, "added": name, "exe": exe_exp})

        # ---- quitar app del usuario
        if path == "/apps/remove":
            name = str(body.get("name", "")).lower().strip()
            custom = load_json(CUSTOM_APPS_FILE, {})
            if name in custom:
                del custom[name]
                save_json(CUSTOM_APPS_FILE, custom)
                return self._json({"ok": True, "removed": name})
            if name in DEFAULT_APPS:
                return self._json({"ok": False, "error": "las apps del catálogo no se pueden quitar (solo las tuyas)"}, 403)
            return self._json({"ok": False, "error": f"no existe la app: {name}"}, 404)

        # ---- archivos: listar workspace
        if path == "/files":
            items = []
            for p in sorted(WORKSPACE.iterdir()):
                if p.is_file():
                    items.append({"name": p.name, "size": p.stat().st_size,
                                  "mtime": int(p.stat().st_mtime)})
            return self._json({"ok": True, "files": items, "dir": str(WORKSPACE)})

        # ---- archivos: escribir (solo workspace)
        WINDOWS_RESERVED = {"CON", "PRN", "AUX", "NUL",
                            *(f"COM{i}" for i in range(1, 10)),
                            *(f"LPT{i}" for i in range(1, 10))}
        if path == "/files/write":
            name = str(body.get("name", "")).strip()
            text = str(body.get("text", ""))
            stem = name.split(".")[0].upper()
            if (not name or "/" in name or "\\" in name or ".." in name
                    or stem in WINDOWS_RESERVED):
                return self._json({"ok": False, "error": "nombre de archivo inválido"}, 400)
            (WORKSPACE / name).write_text(text, encoding="utf-8")
            return self._json({"ok": True, "wrote": name, "bytes": len(text.encode("utf-8"))})

        # ---- archivos: abrir con la app del SO (solo workspace)
        # CRÍTICO: en Windows, Path(base) / "C:/x" REEMPLAZA la base.
        # Sin rechazar / y \, un nombre absoluto abriría archivos fuera
        # del workspace. Se validan los tres vectores.
        if path == "/files/open":
            name = str(body.get("name", "")).strip()
            target = (WORKSPACE / name)
            if (not name or "/" in name or "\\" in name or ".." in name
                    or not target.is_file() or WORKSPACE not in target.resolve().parents):
                return self._json({"ok": False, "error": "archivo no encontrado en el workspace"}, 404)
            try:
                if sys.platform.startswith("win"):
                    os.startfile(target)  # noqa
                elif sys.platform == "darwin":
                    subprocess.Popen(["open", str(target)])
                else:
                    subprocess.Popen(["xdg-open", str(target)])
                return self._json({"ok": True, "opened": name})
            except Exception as e:
                return self._json({"ok": False, "error": str(e)}, 500)

        # ---- kill por PID (confirm de 2 pasos en la terminal)
        if path == "/processes/kill":
            try:
                pid = int(body.get("pid", 0))
            except (TypeError, ValueError):
                return self._json({"ok": False, "error": "pid inválido"}, 400)
            if pid <= 0:
                return self._json({"ok": False, "error": "pid inválido"}, 400)
            if Sys.kill(pid):
                return self._json({"ok": True, "killed": pid})
            return self._json({"ok": False, "error": f"no se pudo matar el pid {pid} (¿permisos? ¿ya murió?)"}, 500)

        # ---- notificación del SO (toast)
        if path == "/notify":
            title = str(body.get("title", "FLOORP SYSTEM"))[:64]
            text = str(body.get("text", ""))[:256]
            try:
                if sys.platform.startswith("win"):
                    ps = ("[Windows.UI.Notifications.ToastNotificationManager, "
                          "Windows.UI.Notifications, ContentType = WindowsRuntime] | "
                          "Out-Null" )
                    # Camino simple y confiable: balloon tip de PowerShell
                    script = (
                        "Add-Type -AssemblyName System.Windows.Forms;"
                        "$n = New-Object System.Windows.Forms.NotifyIcon;"
                        "$n.Icon = [System.Drawing.SystemIcons]::Information;"
                        "$n.Visible = $true;"
                        f"$n.ShowBalloonTip(5000, '{title}', '{text}', "
                        "[System.Windows.Forms.ToolTipIcon]::Info);"
                        "Start-Sleep -Seconds 6; $n.Dispose()"
                    )
                    subprocess.Popen(["powershell", "-NoProfile", "-Command", script],
                                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                elif sys.platform == "darwin":
                    subprocess.Popen(["osascript", "-e",
                                      f'display notification "{text}" with title "{title}"'])
                else:
                    subprocess.Popen(["notify-send", title, text],
                                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                return self._json({"ok": True, "notified": title})
            except Exception as e:
                return self._json({"ok": False, "error": str(e)}, 500)

        # ---- portapapeles del sistema
        if path == "/clipboard/write":
            text = str(body.get("text", ""))
            if not text:
                return self._json({"ok": False, "error": "texto vacío"}, 400)
            try:
                if sys.platform.startswith("win"):
                    subprocess.run(["clip"], input=text.encode("utf-16le"), timeout=5, check=False)
                    # clip usa la codepage local; para unicode fiable usamos powershell
                    ps = f"Set-Clipboard -Value '{text.replace(chr(39), chr(39)*2)}'"
                    subprocess.Popen(["powershell", "-NoProfile", "-Command", ps],
                                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                elif sys.platform == "darwin":
                    subprocess.run(["pbcopy"], input=text.encode("utf-8"), timeout=5, check=False)
                else:
                    for c in (["xclip", "-selection", "clipboard"], ["xsel", "--clipboard", "--input"]):
                        try:
                            subprocess.run(c, input=text.encode("utf-8"), timeout=5, check=False)
                            break
                        except FileNotFoundError:
                            continue
                return self._json({"ok": True, "copied_chars": len(text)})
            except Exception as e:
                return self._json({"ok": False, "error": str(e)}, 500)

        # ---- AI CORE: generación local vía Ollama (sin claves, sin nube)
        if path == "/ai/generate":
            model = str(body.get("model", "")).strip()[:120]
            prompt = str(body.get("prompt", ""))[:4000]
            system = str(body.get("system", ""))[:2000]
            if not model or not prompt:
                return self._json({"ok": False, "error": "model y prompt son obligatorios"}, 400)
            payload = {"model": model, "prompt": prompt, "stream": False}
            if system:
                payload["system"] = system
            req = urllib.request.Request(
                OLLAMA + "/api/generate",
                data=json.dumps(payload).encode("utf-8"),
                headers={"Content-Type": "application/json"},
            )
            try:
                # timeout alto: los modelos locales piensan; el hilo es
                # threading, el bridge sigue atendiendo a otros clientes
                with urllib.request.urlopen(req, timeout=115) as r:
                    data = json.loads(r.read().decode("utf-8"))
                return self._json({
                    "ok": True, "model": model,
                    "response": data.get("response", ""),
                    "eval_count": data.get("eval_count"),
                })
            except Exception as e:
                return self._json({"ok": False, "error": f"ollama: {e}"}, 502)

        # ---- abrir carpeta del workspace en el explorador del SO
        if path == "/folder/open":
            try:
                if sys.platform.startswith("win"):
                    os.startfile(WORKSPACE)  # noqa
                elif sys.platform == "darwin":
                    subprocess.Popen(["open", str(WORKSPACE)])
                else:
                    subprocess.Popen(["xdg-open", str(WORKSPACE)])
                return self._json({"ok": True, "opened": str(WORKSPACE)})
            except Exception as e:
                return self._json({"ok": False, "error": str(e)}, 500)

        return self._json({"ok": False, "error": "NOT_FOUND"}, 404)


def main():
    ap = argparse.ArgumentParser(description="FLOORP SYSTEM bridge")
    ap.add_argument("--port", type=int, default=58230)
    args = ap.parse_args()

    # Consolas Windows (cp1252): sin esto, cualquier carácter no-ASCII muere.
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

    ensure_token()
    if not APPS_FILE.exists():
        save_json(APPS_FILE, DEFAULT_APPS)  # catálogo visible/editable

    httpd = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print("")
    print("  +------------------------------------------------+")
    print("  | FLOORP SYSTEM // fsys-bridge                    |")
    print(f"  |   escuchando   127.0.0.1:{args.port:<15}      |")
    print("  |   token        data/token.txt                   |")
    print("  |   workspace    data/workspace/                  |")
    print("  |   deje esta ventana abierta mientras usa el     |")
    print("  |   sistema. Cerrarla = bridge offline.           |")
    print("  +------------------------------------------------+")
    print("")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n[fsys] bridge apagado")


if __name__ == "__main__":
    main()
