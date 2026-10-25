# -*- coding: utf-8 -*-
"""Balanceo de brackets fuera de strings/comentarios para los JS del proyecto."""
import re, sys

FILES = [
    "floorp-system-extension/background/state.js",
    "floorp-system-extension/background/workspaces.js",
    "floorp-system-extension/background/vault.js",
    "floorp-system-extension/background/apps.js",
    "floorp-system-extension/background/main.js",
    "floorp-system-extension/newtab/js/bridge.js",
    "floorp-system-extension/newtab/js/core.js",
    "floorp-system-extension/newtab/js/palette.js",
]

def strip_src(src):
    out = []
    i, n = 0, len(src)
    while i < n:
        c = src[i]
        if c == "/" and i + 1 < n and src[i + 1] == "*":
            j = src.find("*/", i + 2)
            i = n if j < 0 else j + 2
            continue
        if c == "/" and i + 1 < n and src[i + 1] == "/":
            j = src.find("\n", i)
            i = n if j < 0 else j
            continue
        if c in ("'", '"', "`"):
            q = c
            j = i + 1
            while j < n:
                if src[j] == "\\":
                    j += 2
                    continue
                if src[j] == q:
                    break
                j += 1
            out.append(" " * max(0, j - i))  # conserva saltos de linea
            i = j + 1
            continue
        out.append(c)
        i += 1
    return "".join(out)

ok = True
for f in FILES:
    src = strip_src(open(f, encoding="utf-8").read())
    counts = {p: (src.count(p[0]), src.count(p[1])) for p in ("{}", "()", "[]")}
    bad = [f"{p}: {a} vs {b}" for p, (a, b) in counts.items() if a != b]
    if bad:
        ok = False
        print("FAIL", f, "|", "; ".join(bad))
    else:
        print("OK  ", f)
sys.exit(0 if ok else 1)
