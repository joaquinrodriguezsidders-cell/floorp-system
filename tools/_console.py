# -*- coding: utf-8 -*-
"""
_console.py — Salida UTF-8 en cualquier consola.

Windows escribe la salida de Python con la codificación local (cp1252), que
rompe los acentos y las flechas y hace fallar los scripts con
UnicodeEncodeError. Importar este módulo una vez al principio de cada
herramienta fuerza UTF-8 en stdout/stderr.

Uso:
    import _console  # noqa: F401
"""
import sys

for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
