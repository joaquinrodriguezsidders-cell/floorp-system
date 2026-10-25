# FLOORP SYSTEM INITIALIZED

> **"Linux si reencarnara en un navegador."**
> Floorp transformado en un entorno operativo: terminal como centro de control,
> workspaces reales, tab manager por comandos, estética window manager.

**Estado: BOOT 07 completado** — sistema estable en producción diaria.

---

## Arquitectura (lo que existe hoy)

```
chrome/                        ← tema UI + home standalone (plano B, file://)
├── userChrome.css             ← BOOT 01: tema oscuro de la UI nativa
└── FLOORP-SYSTEM/
    ├── index.html             ← misma home, servida por file://
    ├── css/core.css           ← sistema de diseño (hairlines + acento de estado)
    ├── js/ core.js + bridge.js
    ├── PLAN-BOOTS-06-12.md    ← plan vivo (estado real + diseño de BOOT 08-12)
    └── README.md              ← este archivo

floorp-system-extension/       ← EL CEREBRO (BOOT 06+)
├── manifest.json              ← v0.10.1 · newtab override · tabs/storage + loopback del bridge
├── background/
│   ├── main.js                ← router privilegiado (solo mensajes de la extensión)
│   ├── workspaces.js          ← workspace engine + cliente OS Server de Floorp
│   ├── apps.js                ← cliente del fsys-bridge (apps y archivos del SO)
│   └── state.js               ← estado persistente
└── newtab/

fsys-bridge/                   ← EL PUENTE CON EL SISTEMA OPERATIVO (BOOT 09.5)
├── ARCHITECTURE.md            ← reglas, seguridad, jerarquía (LEER PRIMERO)
├── fsys_bridge.py             ← servidor local: detección de apps, lanzamiento, archivos
├── start-bridge.bat / .sh     ← doble click y listo
└── data/                      ← token + catálogo de apps + workspace de archivos
    ├── index.html             ← LA home del sistema
    ├── css/core.css           ← idéntico a la copia file:// (paridad por hash)
    └── js/ core.js + bridge.js
```

**Tres modos de operación** (degradación elegante — nada se rompe):

| Modo | Requiere | Te da |
|---|---|---|
| **NATIVO** | `floorp.os.enabled=true` | `workspace 2` cambia los workspaces REALES de Floorp |
| **SESIONES** | solo la extensión | workspaces propios: guarda/restaura tabs por contexto |
| **LOCAL** | nada (copia file://) | terminal completa; `ws`/`tab` te dicen cómo activar el bridge |

---

## Instalación (orden recomendado)

### PASO 1 — Extensión (el cerebro)

```
about:debugging#/runtime/this-firefox → Load Temporary Add-on…
→ floorp-system-extension/manifest.json
```

> Es *temporary add-on*: se descarga al cerrar Floorp. Recargala al volver
> (troubleshooting más abajo). El firmado permanente llega en BOOT 12.

### PASO 2 — Tema de la UI nativa (userChrome)

1. `about:config` → aceptá el riesgo.
2. `toolkit.legacyUserProfileCustomizations.stylesheets` → **true**.

### PASO 3 — Workspaces nativos de Floorp (recomendado)

1. `about:config` → `floorp.os.enabled` → **true**.
2. Reiniciá Floorp y recargá la extensión.
3. Nueva tab → la terminal muestra `OS SERVER DE FLOORP: ONLINE`.

> Con esto `Alt+1..9` y `workspace n` cambian los workspaces del propio
> Floorp (los del botón de la toolbar). Sin esto: modo SESIONES.
>
> Seguridad: el servidor escucha solo en 127.0.0.1 (loopback).

### PASO 4 — Resetear el pref viejo (solo si hiciste el BOOT 02)

Si existe `floorp.newtab.overrides.newtaburl` en `about:config` → **Reset**
para que gane la extensión.

### PASO 5 — Reiniciar Floorp y abrir una tab nueva

Boot (~1s) → home → header de la terminal: **`BRIDGE: ONLINE`**.

---

## Comandos (checklist de prueba)

### Sistema
| Comando | Efecto |
|---|---|
| `help` | Lista nativos + aliases + customs |
| `system` | **Task manager real**: CPU (núcleos + carga UI), heap JS real, storage/cuota, red con tipo y velocidad, tareas = tabs de la ventana |
| `date` | **Reloj analógico ASCII en tiempo real** — se congela con el próximo comando (queda como historial) |
| `about` / `echo <txt>` | Básicos |
| `clear` o `Ctrl+L` | Limpia la terminal |
| `Ctrl+C` | Cancela la línea (`^C`, como shell real) |

### Web
| Comando | Efecto |
|---|---|
| `google/yt/gh/wiki <query>` | Búsqueda en nueva tab (prototipo → BOOT 09 lo integra) |
| `open <url>` | Abre URL |
| `tab new [url]` | Nueva tab (funciona también sin bridge) |

### Workspaces
| Comando | Efecto |
|---|---|
| `workspace <n\|nombre>` | Cambia de workspace (NATIVO o SESIONES según modo) |
| `ws list` | Lista con modo, activo (❯) y tabs guardadas |
| `ws save <n>` / `ws add <n> <url>` / `ws rename <n> <nombre>` | Gestión de sesiones |
| `ws next` / `ws prev` | Cicla workspaces |
| `Alt+1..9` | Salto directo (estilo Hyprland) |
| `Ctrl+Alt+←/→` | Workspace prev/next |

### Tabs (requieren BRIDGE: ONLINE, salvo `tab new`)
| Comando | Efecto |
|---|---|
| `tab next` / `tab prev` | Tab siguiente/anterior (circular) |
| `tab go <n>` | Salta a la tab n |
| `tab close [n]` | Cierra la activa o la n |
| `tab reload` / `tab pin` | Recarga / fija la activa |
| `Alt+←` / `Alt+→` | Tab prev/next |

### Sistema operativo (requiere fsys-bridge: `fsys-bridge/start-bridge.bat`)

| Comando | Efecto |
|---|---|
| `bridge` | Estado del puente con el SO |
| `apps` | Apps detectadas EN TU computadora: instaladas (✓) generan comandos |
| `open-app <app>` | Lanza una app permitida (ej: `open-app code`) |
| `<app>` directo | Cada app instalada es un comando: `spotify`, `code`, `steam`... |
| `add-app <nombre> <ruta-exe>` | Registra TU ejecutable → comando nuevo |
| `rm-app <nombre>` | Quita una app tuya |
| `file list / open / write` | Archivos del workspace del sistema |
| `system` | **Task manager REAL**: CPU%, RAM del SO, discos, uptime (con bridge) |
| `ps` / `kill <pid>` | Procesos de tu máquina + kill con confirmación de 2 pasos |
| `notify <txt>` | Toast de notificación del SO |
| `clip <txt>` | Portapapeles del sistema |
| `folder` | Abre el workspace en el explorador |
| `alias sp spotify` | Los comandos de SO aceptan aliases como cualquier otro |

### Shell personalizable
| Comando | Efecto |
|---|---|
| `alias <nombre> <cmd+args>` | Crea alias (sin args: lista). `alias g google` |
| `aliases` / `unalias <nombre>` | Lista / elimina |
| `mkcmd <nombre> <cmd\|url\|texto>` | Crea comando custom |
| `mkcmd` (sin args) | **Guía con plantillas** — doc completa en `docs/custom-commands.md` |
| `commands` / `rmcmd <nombre>` | Lista / elimina customs |
| `TAB` | Autocomplete con widget (nativos + aliases + customs) |
| `↑` / `↓` | Historial persistente |
| *typo* | `¿quisiste decir 'google'?` — fuzzy sobre TODOS los comandos |

Todo persiste entre sesiones (storage del navegador, independiente del origen).

**Crear tus propios comandos sin cagarla:** `mkcmd` sin argumentos muestra la
guía rápida en la terminal; la documentación completa (tipos de acción,
estructura interna, límites de seguridad y recetas) vive en
[`docs/custom-commands.md`](docs/custom-commands.md).

---

## La terminal

- **Tile** con borde que habla del estado: hairline en reposo → acento con foco.
- Input invisible estilo terminal real: `user@floorp:~$ █` con caret que
  también refleja el foco.
- **Smart focus:** hover sobre el tile da foco; cualquier tecla escribe en la
  terminal (keyboard-first). Nunca roba el foco de otro input.
- Header: `FLOORP SYSTEM // TERMINAL · BRIDGE: <estado> · FOCUS: <estado>`.

---

## Troubleshooting

**BRIDGE: LOCAL / "tab necesita el bridge"**
La extensión temporal se descargó (pasa al cerrar Floorp):
```
about:debugging#/runtime/this-firefox → Load Temporary Add-on… → manifest.json
→ nueva tab → BRIDGE: ONLINE
```

**`workspace n` no cambia los workspaces de Floorp**
Estás en modo SESIONES. Activá el OS Server (PASO 3) y recargá la extensión.

**Escribí un subcomando mal** (`tab netx`): el sistema sugiere el más cercano.

**La home abre la versión vieja / sin bridge:** el pref
`floorp.newtab.overrides.newtaburl` puede estar ganándole a la extensión —
resetealo (PASO 4).

---

## Roadmap

- ✅ **BOOT 01-05** — tema, home, terminal, command engine completo
- ✅ **BOOT 06** — extensión + workspaces reales (+06.5 nativos vía OS Server)
- ✅ **BOOT 07** — tab manager por comandos + pulido de diseño completo
- ⬜ **BOOT 08** — Command Palette (Ctrl+K), mismo engine
- ⬜ **BOOT 09** — search integrado (resultados dentro del entorno)
- ⬜ **BOOT 10** — AI CORE (Ollama local primero)
- ⬜ **BOOT 11** — integración/performance/regresión
- ⬜ **BOOT 12** — paquete público (higienización + firmado)

📋 **Diseño detallado de lo que viene:** [`PLAN-BOOTS-06-12.md`](PLAN-BOOTS-06-12.md)

---

## Principios (no negociables)

1. Funcionalidad > fluidez > inmersión > estética > complejidad.
2. Una sola fuente de verdad: un solo CommandEngine (terminal/palette/shortcuts).
3. Velocidad antes que decoración: sin polling, sin loops, animaciones ≤120ms
   solo si comunican estado.
4. Nada fake: si algo está offline, lo dice y te dice cómo activarlo.
5. La estética es consecuencia del sistema, no su sustituto.
