# FLOORP SYSTEM INITIALIZED

> **"Linux si reencarnara en un navegador."**
> Tu Floorp convertido en un entorno operativo: terminal real, workspaces,
> tab manager, apps del sistema y estética window manager.

**Instalación: 5 minutos, sin conocimientos técnicos.**

---

## Lo que hay en este paquete

```
floorp-system-extension/   → el cerebro: terminal, workspaces, tabs, palette
chrome/                    → el tema oscuro de la interfaz nativa de Floorp
fsys-bridge/               → puente opcional con el SO: abrir apps, archivos
LEEME.md                   ← este archivo (esta leyéndolo)
```

Requisito único: **Floorp** (el navegador). Funciona en Windows y Linux.

---

## INSTALACIÓN RÁPIDA (4 pasos)

### PASO 1 · Cargar la extensión (2 minutos)

1. Abrí Floorp.
2. En la barra de direcciones escribí: `about:debugging` y Enter.
3. Clic en **"Load Temporary Add-on…"**
4. Navegá a esta carpeta → `floorp-system-extension/` → elegí **`manifest.json`**.
5. Abrí una **tab nueva (Ctrl+T)** → debería aparecer FLOORP SYSTEM con una
   secuencia de boot y la terminal abajo.

¿Ves `BRIDGE: ONLINE` en el header de la terminal? Perfecto, ya funciona.

> **Importante:** la extensión se descarga cuando cerrás Floorp. Es normal.
> Cuando vuelvas a abrir el navegador, repetí el paso 2-4 (30 segundos).
> (La versión permanente llega con el firmado del paquete, BOOT 12.)

### PASO 2 · Activar el tema oscuro (1 minuto)

1. En la barra de direcciones: `about:config` → botón "Accept the Risk".
2. Buscá: `toolkit.legacyUserProfileCustomizations.stylesheets`
3. Clic en el botón ⇄ para ponerlo en **true**.

### PASO 3 · Copiar el tema al perfil (1 minuto)

1. En Floorp, andá a `about:profiles`.
2. Buscá el perfil que diga **"Default"** y clic en **"Open Directory"**
   (se abre tu carpeta de perfil).
3. Copiá ahí adentro la carpeta **`chrome/`** de este paquete
   (si ya existía una carpeta `chrome/`, reemplazala).
4. **Reiniciá Floorp.**

### PASO 4 · Workspaces nativos (opcional, recomendado)

1. `about:config` → buscá `floorp.os.enabled` → **true**.
2. Reiniciá Floorp y recargá la extensión (PASO 1, 30 segundos).
3. Ahora `Alt+1..9` cambian los workspaces REALES de Floorp.

---

## OPCIONAL · Control de apps del sistema (5 minutos)

Para que la terminal pueda **abrir apps de tu computadora** (Spotify, VS Code,
Discord, Steam, archivos...) hace falta el bridge local:

**Windows:** doble click en `fsys-bridge/start-bridge.bat` y dejá la ventana abierta.
**Linux:** `sh fsys-bridge/start-bridge.sh` y dejá la terminal abierta.

Después en la terminal de FLOORP SYSTEM:

```
bridge          → debería decir FSYS-BRIDGE: ONLINE
apps            → detecta lo instalado EN tu PC
open-app code   → abre VS Code
add-app loquesea C:\ruta\programa.exe   → registrá tus propias apps
file write notas.txt hola   → archivos del workspace del sistema
```

Sin el bridge, todo lo demás funciona igual (es 100% opcional).

---

## PRIMEROS COMANDOS (probalos en orden)

| Escribí esto | Qué pasa |
|---|---|
| `help` | Comandos **agrupados** (SISTEMA, WEB, OS, AI...) · `help <comando>` da detalle |
| `about` | Info del sistema + versión actual |
| `date` | Reloj analógico ASCII en tiempo real 🕐 |
| `calc (2+3)*sqrt(16)` | Calculadora segura (sin eval) |
| `note` / `notes` | Bloc de notas (con espejo en disco si hay bridge) |
| `timer 25 pomodoro` | Cuenta regresiva viva con aviso del SO |
| `top` | CPU y RAM en vivo |
| `system` | Task manager: CPU, RAM, discos, uptime, tabs |
| `mkcmd` | Guía para crear tus propios comandos |
| `mkcmd dev ws next && open github.com` | Comando con **varias acciones encadenadas** (&&) |
| `vault save trabajo` | Guarda la ventana completa · `vault load trabajo` la restaura |
| `focus 45 tesis` | Modo foco: guarda tu sesion, limpia y al terminar TODO vuelve solo |
| `startup add vault load trabajo` | Comandos que corren solos al iniciar |
| `pin entregar tp` | Recordatorio fijado en la status bar |
| `snip add firma Juan Perez` | Snippets: `snip firma` los copia al portapapeles |
| `webapp add notion notion.so` | Crea el comando `notion` (webapps como comandos) |
| `search minecraft` | Busca en TU sistema: historial, notas, snippets, webapps |
| `radio lofi` | Radio ON AIR desde la propia tab · `radio bars` espectro en vivo |
| `radio file` | Tu MP3 local con espectro REAL (sin CORS) · `radio vol 70` |
| `weather london` | Clima actual (Open-Meteo) · añade `> pane` para el tiling |
| `news` / `news open 3` | Titulares de Hacker News, abrir al elegir |
| `wiki -t linux` | El resumen de Wikipedia impreso en la terminal |
| `crypto btc eth` | Precios con variación 24h |
| `widget add clock` | Widgets flotantes arrastrables (clock/sysmon/weather/radio/notes) |
| `dash save noche` | Guarda tu escritorio entero (widgets + radio + panel) y lo restaura |
| `layout split notes` | Tiling: panel de contenido junto a la terminal |
| `alias g google` | Crear atajo: `g zapatillas` = buscar |
| `tab ` + TAB | Sugerencias de subcomandos (next, go, close...) |
| `config accent amber` | Cambiar tema (green/amber/cyan/red, persiste) |
| `config user vos` | Tu prompt: `vos@floorp:~$` |
| `config boot off` | Sin secuencia de arranque nunca |
| `TAB` | Autocomplete (comandos y subcomandos) |
| `↑` | Historial · `hist <txt>` busca en él |
| `Ctrl+K` | Command palette (buscador de comandos) |
| `Ctrl+U` | Borrar la línea entera |
| `Ctrl+L` | Limpiar terminal |
| `Alt+2` | Cambiar al workspace 2 |

Novedades v0.12.0: **radio** con espectro ASCII real (SomaFM o tu MP3 local, el
analizador recibe frecuencia de verdad) · **web en vivo**: weather, news, wiki -t,
crypto, ip, dict — datos impresos en la terminal, con `> pane` para mandarlos al
tiling · **widgets flotantes arrastrables** que persisten entre sesiones ·
**dashboards**: guarda y restaura tu escritorio entero con un comando.
Novedades v0.11.0: vault de sesiones, modo foco, cadena de startup, pin, snippets,
cliplog, webapps como comandos, búsqueda unificada, tiling y watchdog.
Novedades v0.10.1: boot inteligente · MOTD · `help` agrupado · TAB de segundo nivel ·
prompt personalizable · Ctrl+U · mkcmd multi-acción · TAB dinámico (unalias/rmcmd/help sugieren sus argumentos).

Los datos (aliases, comandos custom, historial) **persisten** entre sesiones.

---

## PROBLEMAS FRECUENTES

**La tab nueva no muestra FLOORP SYSTEM**
→ La extensión no está cargada. Repetí el PASO 1.

**"BRIDGE: LOCAL" en el header**
→ Lo mismo: cargá la extensión (`about:debugging` → Load Temporary Add-on).

**Los comandos `apps` / `open-app` dicen "fsys-bridge offline"**
→ Normal si no iniciaste el bridge. Ejecutá `start-bridge.bat` (sección opcional).

**No veo el tema oscuro en la UI de Floorp**
→ Verificá el PASO 2 (pref en true) y que la carpeta `chrome/` esté DENTRO
de la carpeta del perfil (PASO 3), y reiniciaste.

**¿Es seguro el bridge?**
Sí: escucha solo en 127.0.0.1 (tu máquina), usa token, y solo lanza apps de
una lista cerrada que vos controlás. Nunca ejecuta comandos arbitrarios.

---

## Qué es esto exactamente

Un entorno operativo construido sobre el navegador: terminal como centro de
control, comandos como API humana, workspaces como modelo mental, y estética
de window manager. Versión actual: **v0.12.0** (BOOT 01 → 10 + puente SO completo
con apps, archivos, métricas, procesos, notificaciones y AI CORE local opcional,
+ radio en vivo, web en vivo, widgets flotantes y dashboards).

Filosofía: funcionalidad > fluidez > inmersión > estética > complejidad.
