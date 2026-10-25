# FLOORP SYSTEM — ARQUITECTURA DE INTEGRACIÓN CON EL SISTEMA OPERATIVO

> El axioma final de la spec: *"Un entorno operativo que utiliza un navegador
> como su motor."* Para controlar el SO hace falta un componente fuera del
> navegador. Este documento define esa pieza y sus reglas.
> **Leelo antes de tocar cualquier archivo de esta capa.**

---

## 1. LA REGLA DE ORO (spec, sección 19)

```
NUNCA:    JavaScript → shell arbitraria del SO

SIEMPRE:  Terminal FLOORP SYSTEM
             ↓
          Extensión (background.js, permisos mínimos)
             ↓
          fsys-bridge (proceso local del usuario, allowlist cerrada)
             ↓
          Sistema Operativo
```

El bridge es un servidor HTTP **loopback-only** escrito en Python estándar
(sin dependencias: Windows trae Python o se instala con un click; en Linux
viene de serie). Nace apagado: si no está corriendo, el navegador muestra
`BRIDGE DE SISTEMA: OFFLINE` y los comandos de SO explican cómo activarlo.
Nada explota, nada se inventa.

## 2. SEGURIDAD (no negociable)

| Regla | Implementación |
|---|---|
| Solo procesos locales | el bridge escucha en `127.0.0.1`, nunca `0.0.0.0` |
| Solo el navegador del usuario | header `X-FSYS-TOKEN` con token aleatorio guardado en `%USERPROFILE%/.fsys/token.txt` |
| Solo apps permitidas | **allowlist cerrada**: catálogo (`apps.json`) + agregados del usuario (`custom_apps.json`). `open-app` rechaza todo lo demás |
| Sin inyección de comandos | el bridge NO pasa strings a shell. Cada app tiene su lista de rutas candidatas y se lanza con `subprocess.Popen([ruta])` — argumentos imposibles |
| Archivos: solo rutas dedicadas | `file open/list` solo accede a `~/.fsys/workspace/` (y rutas absolutas que el usuario agregue a `allowed_dirs.json`) |
| Sin escritura fuera del workspace | `file write` solo en el workspace dedicado |

## 3. JERARQUÍA DE ARCHIVOS (la estructura que evita líos)

```
fsys-bridge/                      ← EN LA RAÍZ DEL PROYECTO (componente SO)
├── ARCHITECTURE.md               ← este documento
├── fsys_bridge.py                ← EL SERVIDOR (archivo único, stdlib pura)
├── start-bridge.bat              ← inicio en Windows (doble click)
├── start-bridge.sh               ← inicio en Linux
└── data/                         ← TODO lo que el bridge escribe vive acá
    ├── token.txt                 ← generado en el primer arranque
    ├── apps.json                 ← catálogo de apps conocidas (editables)
    ├── custom_apps.json          ← agregadas por el usuario (add-app)
    └── workspace/                ← el "home" de archivos del sistema
        └── (tus archivos)
```

Capas del navegador (ya existen, solo se conectan):

```
floorp-system-extension/
├── background/apps.js            ← NUEVO: cliente del bridge + catálogo
├── background/main.js            ← handlers app.* y bridge.* (ruteo nomás)
└── newtab/js/core.js             ← comandos: apps, open-app, add-app, rm-app,
                                    bridge, file (UX de terminal)
```

**Regla de capas:** `core.js` nunca sabe rutas de apps; `apps.js` nunca toca
DOM; el bridge nunca confía en el contenido de los mensajes (valida todo).

## 4. CATÁLOGO DE APPS — detección por plataforma

`apps.json` define, por app, sus rutas candidatas por SO. El bridge marca
`installed: true/false` chequeando existencia de archivos al arrancar (y en
cada `apps.list`). Un comando que no esté instalado **no se registra**:

```json
{
  "spotify": {
    "name": "Spotify",
    "win":  ["%APPDATA%\\Spotify\\Spotify.exe"],
    "linux":["/usr/bin/spotify", "/snap/bin/spotify"]
  },
  "discord": { "win": ["%LOCALAPPDATA%\\Discord\\Update.exe --processStart Discord.exe"], "...": "..." }
}
```

> `discord` usa su launcher especial; el bridge soporta `args` opcionales por
> entrada, siempre literales (nunca input del usuario).

Catálogo inicial: spotify, discord, steam, code (VS Code), telegram, whatsapp,
vlc, calculator (calc de Windows / gnome-calculator), notepad, explorer
(archivos), terminal (wt / gnome-terminal), taskmgr.

## 5. COMANDOS DEL SISTEMA (lo que ve el usuario)

| Comando | Efecto |
|---|---|
| `bridge` | Estado del bridge + cómo activarlo si está offline |
| `apps` | Lista las apps: instaladas (✓) y no (·). Las instaladas generan comandos |
| `open-app <app>` | Lanza la app (solo allowlist) |
| `add-app <nombre> <ruta>` | Registra tu propio ejecutable → comando nuevo |
| `rm-app <nombre>` | Quita una app agregada por vos |
| `file list` | Archivos del workspace del sistema |
| `file open <n>` | Abre un archivo del workspace con la app del SO |
| `file write <n> <texto>` | Crea/sobrescribe un archivo del workspace |
| `system` | Task manager REAL: CPU% (delta kernel), RAM del SO, discos, uptime |
| `ps` | Top 15 procesos de la máquina por RAM (tasklist/ps) |
| `kill <pid>` | Termina un proceso — **confirm de 2 pasos** (`kill <pid> confirm`) |
| `notify <txt>` | Toast de notificación del SO (balloon Windows / notify-send Linux) |
| `clip <txt>` | Copia al portapapeles del sistema |
| `folder` | Abre el workspace en el explorador del SO |

**Jerarquía de comunicación (v0.9.0):**

```
terminal:  system · ps · kill · notify · clip · folder · file · apps
   ↓ runtime.sendMessage (misma extensión, validado)
background: BridgeOS (apps.js) — fetch loopback con token + TTL
   ↓ http://127.0.0.1:58230  X-FSYS-TOKEN
bridge:     /sys · /processes · /processes/kill · /notify
            /clipboard/write · /folder/open · /apps · /files
   ↓ stdlib: ctypes (Win) · /proc (Linux) · tasklist/ps · PowerShell balloons
SO real:    CPU · RAM · discos · procesos · toasts · portapapeles
```

**Compatible con aliases gratis:** los comandos de app pasan por el mismo
CommandEngine, así que `alias sp spotify`, `alias spot open-app spotify` o
`alias vs code` funcionan sin código extra. Además, cada app instalada se
registra como comando propio: escribir `spotify` directamente también lanza.

## 6. FLUJO DE ARRANQUE (detección automática por computadora)

1. La home arranca → `Bridge.hello()` (extensión).
2. El background sondea `127.0.0.1:<puerto>/health` con el token (TTL 15s).
3. Si responde: descarga `apps.list` → las instaladas se registran como
   comandos dinámicos → `system` y la status bar reportan `APPS: n`.
4. Si no: los comandos de SO existen pero explican cómo activar el bridge.
   Todo lo demás (terminal, workspaces, tabs, palette, reloj) sigue intacto.

## 7. PUERTO Y PROCESO

- Puerto por defecto: **58230** (lejos del 58261 del OS Server de Floorp).
- Cambiable en `apps.js` (`BridgeOS.PORT`) y en el bridge (`--port`).
- El bridge es un proceso del usuario: se inicia con el .bat/.sh o al inicio
  de sesión (el README del futuro BOOT 12 lo documenta para no-devs).
- Apagarlo = cerrar la ventana/terminal del proceso. Sin servicios ni drivers.

## 8. POR QUÉ ESTA FORMA Y NO OTRA

| Alternativa | Veredicto |
|---|---|
| Native Messaging | requiere registro por-app en el SO y claves en el registry; overkill y frágil para Win+Linux |
| Ejecutar comandos desde la página | PROHIBIDO por la spec (sección 19): agujero de seguridad |
| **HTTP loopback + token + allowlist** | ✓ stdlib pura, cero instalación, control total del perímetro, matable con un click |
