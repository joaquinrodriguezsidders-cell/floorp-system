# FLOORP SYSTEM — PLAN VIVO (BOOT 06 → 12)

> **Documento actualizado a la realidad del proyecto (post-BOOT 07).**
> Este plan reemplaza al original: refleja lo que realmente se construyó,
> las decisiones tomadas en el camino y los BOOTS que faltan, adaptados
> a lo que ya existe.

---

## 1. ESTADO REAL DEL SISTEMA (dónde estamos)

```
BOOT 01  ✅  userChrome.css — tema oscuro técnico de la UI nativa
BOOT 02  ✅  Home del sistema (boot sequence, status bar, workspace bar)
BOOT 03  ✅  Terminal funcional (input invisible, cursor, smart focus)
BOOT 04  ✅  Smart terminal UI (autoscroll, dedup history, Ctrl+L/C)
BOOT 05  ✅  Command engine + history + aliases + mkcmd + TAB autocomplete
BOOT 06  ✅  Extensión WebExtension + workspace engine real
             + 06.5: integración NATIVA con workspaces de Floorp vía OS Server
BOOT 07  ✅  Tab manager por COMANDOS (decisión de diseño: sin panel visual)
             + pulido de diseño completo (hairlines, dot leaders, HUD brackets)
BOOT 08  ⬜  Command Palette (Ctrl+K)          ← PRÓXIMO
BOOT 09  ⬜  Search integrado en el entorno
BOOT 10  ⬜  AI CORE (Ollama local primero)
BOOT 11  ⬜  Integración, estabilidad, performance
BOOT 12  ⬜  Paquete público (higienización + distribución)
```

**Arquitectura en producción hoy:**

```
┌──────────────────────────────────────────────────────────┐
│ FLOORP SYSTEM EXTENSION (v0.7.1, temporary add-on)       │
│                                                          │
│  newtab/index.html      ← la home (UI completa)          │
│  newtab/js/core.js      ← command engine + terminal      │
│  newtab/js/bridge.js    ← puente con degradación LOCAL   │
│  background/main.js     ← router privilegiado            │
│  background/workspaces.js ← engine + cliente OS Server   │
│  background/state.js    ← estado persistente             │
└──────────────────────────────────────────────────────────┘
         ↕ (runtime.sendMessage, misma extensión)
   Floorp: tabs reales · workspaces nativos (OS Server 58261)
```

**Modos de operación (degradación elegante, verificada):**

| Modo | Cuándo | Qué funciona |
|---|---|---|
| **NATIVO** | OS Server ON (`floorp.os.enabled=true`) | `workspace n` cambia los workspaces REALES de Floorp |
| **SESIONES** | Extensión sin OS Server | Workspaces propios: guarda/restaura tabs por contexto |
| **LOCAL** | Sin extensión (copia file://) | Terminal completa, aliases, customs, history; `ws`/`tab` avisan cómo activar el bridge |

---

## 2. DECISIONES DE DISEÑO YA TOMADAS (no revisitar)

1. **La extensión es el cerebro.** La home vive en `moz-extension://`; la copia
   `file://` es plano B de rollback. Puentе directo `runtime.sendMessage`
   (no content script: la home ES una página de la extensión).
2. **Persistencia unificada:** aliases/customs/history en `storage.local` del
   background (independiente del origen) + localStorage como respaldo.
3. **Tab manager = solo comandos.** Sin panel visual de tabs (decisión del
   usuario). Los atajos `Alt+←/→` sí se mantienen.
4. **Los workspaces nativos de Floorp son la meta.** Se descubrió que Floorp 12
   trae un OS Server local (`floorp.os.enabled`, puerto 58261, loopback-only)
   con API REST de workspaces. Es la vía oficial; las sesiones propias son fallback.
5. **Una sola fuente de verdad:** CommandEngine único para terminal, palette
   (futura) y shortcuts. Sin `eval`. Mensajes del router solo de la propia extensión.
6. **Seguridad de alias:** validación `^[a-z][a-z0-9_-]*$`, sanitización al
   arrancar, defaults sembrados (`g → google`).
7. **Estética: hairlines estructurales + acento solo para estados.** Superficies
   planas, cero gradientes/glow/radius. Sin polling: eventos o nada.

---

## 3. BOOT 08 — COMMAND PALETTE (Ctrl+K)  ← PRÓXIMO

**Objetivo:** palette que reutiliza el MISMO CommandEngine (axioma inquebrantable).

**Diseño concreto:**
- `palette.js` nuevo archivo en `newtab/js/` (modular, no engordar core.js).
- Overlay centrado arriba (estilo launcher): input + lista de resultados.
- Fuente de datos: `CommandEngine.registry` + aliases + customs (mismo `resolve`).
- **Fuzzy subsecuencia** (~30 líneas, sin librerías): "wor" → `workspace`.
- **Enter** ejecuta `CommandEngine.execute(línea)`. Si el comando necesita
  argumento (tiene `<` en usage), la palette escribe el comando + espacio en la
  terminal y hace focus (así `workspace ` queda listo para el argumento).
- **ESC** cierra. **↑↓** navega. El resultado se imprime en la terminal (feedback
  unificado: toda acción vive en la terminal).
- Atajo: `Ctrl+K` dentro de la home. **No** registrar `browser.commands` global
  todavía (requiere firmado; se evalúa en BOOT 12).
- CSS: `#palette` con las variables existentes, animación `bootIn` (120ms),
  `sel` idéntico al widget de sugerencias de la terminal (coherencia visual).

**Pruebas de aceptación:**
- `Ctrl+K` → "wor" → Enter → terminal con `workspace ` y foco.
- `Ctrl+K` → "g" → muestra nativos + alias `g` + customs que coincidan.
- La palette NO duplica comandos: los toma del registry en vivo (crear un alias
  y abrir palette lo muestra sin recargar).
- Terminal, TAB autocomplete y shortcuts siguen intactos (regresión).

---

## 4. BOOT 09 — SEARCH INTEGRADO (sin abrir Google afuera)

**Objetivo:** `google minecraft` muestra resultados sin destruir la inmersión.

**Realidad técnica (validada en el plan original, sigue vigente):**
- iframe a Google: bloqueado por X-Frame-Options. **No viable, no intentar.**
- **Vía A (default):** motor que no bloquea framing (DuckDuckGo Lite / SearXNG
  público) en `tab new` vía el bridge. La terminal queda viva en la newtab.
- **Vía B (inmersión total):** la extensión hace `fetch` a la API HTML de DDG
  Lite desde el background (sin CORS para extensiones con permiso host) y la home
  renderiza los resultados como lista propia en un tile SEARCH. Es la experiencia
  objetivo: resultados DENTRO del entorno, con enlace que abre `tab new`.
- Elección de motor: `settings search ddg|searx|google` (google = Vía A por
  tab, comportamiento actual, queda como fallback honesto).

**Pasos:** 1) settings de motor en storage; 2) `search.js` con renderer de
resultados (título + URL + snippet, click → tab.new); 3) `google`/`search`
pasan por el pipeline según settings; 4) tile SEARCH en la home (aparece solo
con resultados, estilo terminal tile).

**Pruebas:** `google minecraft` pinta resultados dentro de la home; click abre
la tab real; con bridge OFF cae a Vía A (tab nueva) sin romperse.

---

## 5. BOOT 10 — AI CORE

**Objetivo:** `ai summarize`, `ai search <q>`, `ai explain` con contexto real.

**Arquitectura (sin cambios respecto al plan original, sigue siendo la correcta):**
```
ai <acción> → background: contexto (content script: selección o innerText ~8k)
            → provider interface única
            → respuesta en la terminal (texto plano)
```

**Providers en orden:** 1) Ollama local `127.0.0.1:11434` (gratis, privado,
default si responde); 2) API con clave del usuario (opt-in, storage local);
3) sin IA → mensaje claro `AI CORE: OFFLINE — iniciá Ollama o configurá una API`.
Nada fake. Nada sale de la máquina sin comando `ai` explícito.

**Nuevo requisito descubierto:** el manifest necesitará permiso `host_permissions`
para `127.0.0.1:11434/*` (Ollama) y los dominios de API opt-in. Documentar en el
README que el content script de contexto se agrega en este BOOT (primera vez que
se usa uno — el manifest ya está preparado conceptualmente en la sección 2 del
plan original, pero hoy no existe: crear `content/extractor.js` mínimo).

**Pruebas:** con Ollama: resumen real de la página activa. Sin Ollama: error
claro y accionable. La home nunca se bloquea (timeout + mensaje).

---

## 6. BOOT 11 — INTEGRACIÓN, ESTÉTICA Y ESTABILIDAD

**Checklist (adaptado a lo real):**
1. **Unión visual:** palette + tile search + terminal comparten hairlines y
   acento; transiciones ≤120ms solo en foco/estado (ya es el estándar del CSS).
2. **Performance budget:** listeners de tabs desactivados cuando la home no es
   visible (`document.visibilityState`), debounce en storage writes (hoy: solo
   localStorage sync + bridge async, aceptable), animaciones transform/opacity only.
3. **Regresión automatizada ligera:** script manual de 20 comandos (lista en
   README) ejecutable en 2 minutos tras cada cambio. Considerar un `selftest`
   command que ejecute asserts internos y reporte PASS/FAIL — barato y muy útil.
4. **Modo a prueba de fallos:** ya existe (LOCAL + timeouts de bridge). Agregar:
   si `system.status` tarda >500ms en 3 intentos, mostrar `BRIDGE: OFFLINE —
   recargá la extensión` una vez, no en cada comando.
5. **Bugs a vigilar:** focus tras palette; restauración de sesión con muchas
   tabs (keep-alive tab ya implementado); Alt+digit en layouts de teclado no-US.

---

## 7. BOOT 12 — FINALIZACIÓN Y PAQUETE PÚBLICO

**Sin cambios estructurales. Resumen operativo:**
1. `dist/` solo con: extensión + `chrome/` (tema) + README + LICENSE.
2. **Instalador de 3 pasos** para no-devs (extensión temporal o firmada en AMO;
   `toolkit.legacyUserProfileCustomizations.stylesheets`; copiar `chrome/`).
3. `web-ext build` → zip firmable. Screenshots + GIF del boot + tabla de comandos.
4. CHANGELOG.md por BOOT (datos para el changelog: sección 1 de este documento).
5. **Auditoría de privacidad obligatoria antes de publicar:**
   - `grep -r "joaqu\|yob6wicw\|AppData\|8613" dist/` → 0 resultados
   - Sin storage personal en el zip; sin claves API; sin rutas personales.
   - La extensión NO pide permisos que no usa (revisar manifest final).

---

## 8. ORDEN Y REGLAS (vigentes)

```
BOOT 08 (palette)  ✅ HECHO (v0.7.0: palette.js, fuzzy, args en terminal)
   └→ BOOT 09.5 (SO bridge) ✅ HECHO (v0.8.0: fsys-bridge + apps/archivos)
   └→ BOOT 09 (search)   ← siguiente: requiere tile system + settings
       └→ BOOT 10 (AI)   ← requiere content script + host permissions
           └→ BOOT 11 (integración)  ← pulir con todo presente

Nota de auditoría (v0.7.1): revisión boot-por-boot. Corregidos: clave de
puerto del OS client (fsys.osPort), doble definición de saveStore,
keyboard-first vs palette, permiso sessions sin uso (eliminado), syscheck
via Bus, feedback de clear, cursor en urlbar, modo privado en userChrome.

BOOT 09.5 — PUENTE CON EL SISTEMA OPERATIVO (HECHO, v0.8.0)

Objetivo (axioma final de la spec): controlar el SO desde la terminal —
abrir apps y gestionar archivos — sin ejecutar jamás shell arbitraria.

Arquitectura (documentada en fsys-bridge/ARCHITECTURE.md):
  Terminal → extensión → fsys-bridge (Python stdlib, loopback+token)
           → allowlist cerrada → SO (Popen con ruta literal, sin shell)

Entregado y verificado EN MÁQUINA REAL:
· Detección por computadora: 8/11 apps del catálogo detectadas (code,
  discord, steam, calc, terminal...); spotify/vlc/telegram correctly OFF.
· Solo apps instaladas se registran como comandos (desaparecen de
  TAB/palette si no están) — compatibles con aliases sin código extra.
· add-app/rm-app con validación de ruta y catálogo protegido.
· file list/write/open limitado al workspace del sistema (traversal → 400).
· Seguridad probada: 401 sin token, 404 app desconocida, 409 no instalada.
· Degradación: sin bridge, los comandos explican cómo activarlo; nada explota.

Nota: el bridge es OPCIONAL y nace apagado — el sistema completo funciona
sin él (es la filosofía de degradación elegante del proyecto).
               └→ BOOT 12 (paquete)  ← al final, cuando nada cambie más
```

- Un BOOT por vez. No romper lo anterior. La copia `file://` es siempre el plano B.
- Cada BOOT: sincronizar extensión ↔ `chrome/FLOORP-SYSTEM/` (paridad por hash,
  como se hace hoy) y bump de versión del manifest.
- Si una decisión nueva contradice la sección 2, actualizar este documento
  primero, después el código. El plan vive.
