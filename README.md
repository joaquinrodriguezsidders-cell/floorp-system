# FLOORP SYSTEM

Entorno operativo sobre Floorp (Manifest V2): terminal, workspaces, tab manager,
apps del sistema y estética de window manager.

- **versión**: 0.19.0
- **ID del add-on**: `floorp-system@fsys.system`
- **manifest**: MV2 · `strict_min_version` 115.0
- **permisos**: `tabs`, `storage`, `notifications`, `downloads` + `http://127.0.0.1/*`

## Estructura

```
floorp-system-extension/   la extensión (esto es lo que se empaqueta)
chrome/                    tema de la UI + copia de la home (file://)
fsys-bridge/               puente local opcional (apps, archivos, métricas)
installer/                 instalador para dejar la extensión permanente
tools/                     validación, empaquetado, firma y publicación
site/                      página + manifiesto de actualizaciones (GitHub Pages)
docs/                      guías de release y migración
release.config.json        configuración del canal de distribución
```

## Desarrollo

Requiere **Python 3** (no hace falta `npm` ni `node`).

```bash
python tools/validate.py          # 15 comprobaciones reales del proyecto
python tools/build_xpi.py         # empaqueta dist/floorp-system-unsigned.xpi
python tools/build_xpi.py --check-only   # solo verifica, no escribe
```

Para probar la interfaz sin instalar nada: serví `floorp-system-extension/newtab`
con `python -m http.server` y abrí `index.html`. La terminal funciona; los
comandos que dependen de la extensión (tabs, workspaces reales) avisan que están
en modo LOCAL.

## Cómo funcionan las actualizaciones

Arquitectura: **firma oficial de Mozilla (AMO, canal *unlisted*) + manifiesto de
actualizaciones propio alojado en GitHub Pages**.

```
 código  →  GitHub Actions  →  XPI empaquetado  →  firmado por Mozilla (AMO)
                                                        │
                                        Release de GitHub (archivo + sha256)
                                                        │
     Floorp  ←── updates.json (GitHub Pages, HTTPS) ←───┘
```

- El `manifest.json` del paquete lleva
  `browser_specific_settings.gecko.update_url`, **inyectado al empaquetar**
  desde `release.config.json`. El manifest del repositorio queda limpio, sin
  direcciones inventadas.
- `updates.json` se genera **después** de firmar y **después** de comprobar que
  el archivo se puede descargar. Nunca anuncia algo que no existe.
- El XPI debe estar firmado por Mozilla: Firefox/Floorp en versión release no
  instala ni actualiza paquetes sin firma. La firma no la produce GitHub.

### Por qué *unlisted* y no el catálogo público

Ambos firman igual. La diferencia es la distribución: *listed* obliga a pasar
una revisión y a que los usuarios instalen desde la tienda; *unlisted* firma el
paquete y vos lo distribuís. Como la extensión ya se reparte fuera de la tienda,
*unlisted* evita la revisión y mantiene una sola vía de distribución.

## Publicar una versión

Ver **[docs/RELEASING.md](docs/RELEASING.md)**. Resumen:

```bash
python tools/bump_version.py patch
python tools/validate.py
git add -A && git commit -m "chore: v0.19.1"
git tag v0.19.1 && git push origin main --tags
```

## Usuarios que ya lo tienen instalado

Ver **[docs/MIGRATION.md](docs/MIGRATION.md)**. Resumen: las versiones ≤ 0.18.0
no tienen `update_url`, así que requieren **una** reinstalación manual; desde
0.19.0 en adelante se actualizan solas.

## Estado actual (honesto)

| Pieza | Estado |
|---|---|
| Validación automática (15 checks) | funcionando, ejecutada |
| Empaquetado reproducible + verificación del XPI | funcionando, ejecutado |
| Inyección de `update_url` | funcionando, ejecutado |
| Generación y validación de `updates.json` | funcionando, ejecutado |
| Guardas (rechazo de XPI sin firmar, anti-downgrade, tag vs versión) | funcionando, ejecutadas |
| Firma real en Mozilla | **no ejecutada** (faltan credenciales) |
| Publicación en GitHub / Pages | **no ejecutada** (el repo remoto no existe todavía) |
| Actualización automática comprobada en Floorp | **no verificada** (requiere las dos anteriores) |

## Pendientes antes de que haya actualizaciones automáticas

1. Crear el repositorio en GitHub y subir el código → `docs/RELEASING.md` paso 1-2
2. Cargar la variable `UPDATE_BASE_URL` y activar Pages con origen *GitHub Actions*
3. Cargar los secretos `AMO_API_KEY` / `AMO_API_SECRET`
4. Publicar el primer tag firmado
5. Instalar esa versión una vez (migración) y comprobar que la siguiente llega sola

Sin los pasos 2 y 3 el sistema **no puede** publicar ni firmar: son las únicas
cosas que nadie más que vos puede hacer, porque son tu cuenta.

## Licencia

Sin definir todavía. Si el repositorio va a ser público, elegí una licencia
(MIT o GPL-3.0 son las habituales para extensiones) y agregá el archivo
`LICENSE` antes de publicarlo.
