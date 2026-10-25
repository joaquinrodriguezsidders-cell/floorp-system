# Publicar una versión nueva

Guía corta. Todo lo de abajo son comandos que podés pegar tal cual.

---

## Antes de la primera publicación (una sola vez)

### 1. Crear el repositorio en GitHub

1. Entrá a <https://github.com/new>
2. **Repository name**: `floorp-system`
3. Marcá **Private** (o Public, da igual para las actualizaciones)
4. **NO** marques "Add a README" ni ".gitignore" (ya los tenemos)
5. Clic en **Create repository**

### 2. Subir el código

```bash
git remote add origin https://github.com/TU-USUARIO/floorp-system.git
git branch -M main
git push -u origin main
```

Si te pide autenticación, usá el botón de GitHub Desktop o un token personal
(Settings → Developer settings → Personal access tokens). Nunca escribas la
contraseña en el chat.

### 3. Configurar el canal de actualizaciones

```bash
python tools/configure.py --github-user TU-USUARIO
```

Eso escribe la dirección pública (`https://TU-USUARIO.github.io/floorp-system`).

### 4. Activar GitHub Pages

En el repo: **Settings → Pages → Source: GitHub Actions**.
Sin esto el endpoint `updates.json` no existe y las actualizaciones no llegan.

### 5. Cargar la variable del canal

En el repo: **Settings → Secrets and variables → Actions → pestaña Variables
→ New repository variable**

| Nombre | Valor |
|---|---|
| `UPDATE_BASE_URL` | `https://TU-USUARIO.github.io/floorp-system` |

No es un secreto: es una dirección pública, por eso va como *variable*.

### 6. Obtener las credenciales de Mozilla (firma)

1. Entrá a <https://addons.mozilla.org/developers/addon/api/key/>
2. Iniciá sesión (o creá la cuenta gratis, solo hay que confirmar el mail)
3. Clic en **Generate new credentials**
4. Te muestra dos valores: **JWT issuer** y **JWT secret**

Cargalos en el repo: **Settings → Secrets and variables → Actions → Secrets
→ New repository secret**

| Nombre | Valor |
|---|---|
| `AMO_API_KEY` | el *JWT issuer*, con esta forma: `user:12345678:90` |
| `AMO_API_SECRET` | el *JWT secret* (una cadena larga) |

> La API de Mozilla **no** acepta usuario y contraseña: exige un token JWT
> firmado con HMAC-SHA256, que las herramientas de este proyecto generan solas
> a partir de esos dos valores. Por eso hay que cargar los dos exactamente como
> los muestra Mozilla, sin recortarlos ni agregar espacios.

Para firmar en tu propia computadora, en lugar de GitHub:

```bash
export AMO_API_KEY='user:12345678:90'
export AMO_API_SECRET='...'
```

(o guardalos en `tools/amo_keys.txt` con el formato `key=...` / `secret=...`;
ese archivo ya está excluido del repositorio).

---

## Publicar una versión (esto es el día a día)

Un solo comando:

```bash
python tools/publicar.py patch     # arreglo           0.19.0 -> 0.19.1
python tools/publicar.py minor     # función nueva     0.19.0 -> 0.20.0
python tools/publicar.py major     # cambio grande     0.19.0 -> 1.0.0
python tools/publicar.py --set 0.19.7   # número exacto
```

Qué hace, en orden, y dónde se detiene si algo está mal:

1. comprueba que el repositorio esté conectado a GitHub (si no, te dice qué falta)
2. valida el proyecto entero → **si falla, no sigue**
3. sube el número de versión en `manifest.json`, `package.json` y `core.js`
4. vuelve a validar con la versión nueva → si falla, revierte el número
5. muestra los archivos que va a incluir y **pide confirmación**
6. crea el commit `chore: vX.Y.Z` y el tag `vX.Y.Z`
7. sube commit y tag → GitHub Actions hace el resto

Si preferís hacerlo a mano, es equivalente:

```bash
python tools/bump_version.py patch
python tools/validate.py
git add -A && git commit -m "chore: v0.19.1"
git tag v0.19.1 && git push origin --tags
```

Al subir el tag, GitHub Actions hace solo:

1. valida manifest, permisos, assets y busca secretos filtrados
2. comprueba que el tag coincide con la versión del `manifest.json`
3. empaqueta el XPI (con `update_url` ya inyectado)
4. lo firma en Mozilla (canal unlisted: **no** aparece en el catálogo público)
5. crea el Release con el `.xpi` y su `SHA256SUMS.txt`
6. **verifica que el archivo se pueda descargar** (espera hasta ~3 minutos)
7. recién entonces publica `updates.json` en GitHub Pages

Si cualquier paso falla, no se publica el manifiesto: nunca se anuncia una
versión que no existe o que el navegador va a rechazar.

---

## Probarlo en tu propia computadora (sin GitHub)

```bash
python tools/configure.py --github-user TU-USUARIO
python tools/release.py
```

Ese único comando: valida → empaqueta → firma → genera `site/updates.json`
y lo verifica al final. Si no hay credenciales de Mozilla, se detiene antes
de firmar y te dice exactamente qué falta.

---

## Comprobar que las actualizaciones funcionan de verdad

Primero, el diagnóstico automático (lee tu perfil y dice qué falta):

```bash
python tools/diagnose.py
```

Después, la prueba real:

1. Instalá una versión (ver `docs/MIGRATION.md`).
2. Publicá una versión mayor con un cambio visible.
3. En Floorp: `about:support` → sección **Extensiones** → mirá la versión.
4. Podés forzar la comprobación con `about:addons` → engranaje →
   **Buscar actualizaciones**.

Si la versión no cambia: mirá `about:addons` → FLOORP SYSTEM → debería decir
"Actualizaciones automáticas" y la URL del manifiesto.

---

## Si algo sale mal (recuperación)

Regla general: **una versión publicada no se reemplaza, se corrige con una
versión mayor.** Firefox compara números: si republicás el mismo número, muchos
navegadores no vuelven a descargar nada. Un rollback "hacia atrás" tampoco
funciona (una versión menor se ignora).

| Situación | Qué se puede hacer |
|---|---|
| La versión nueva trae un bug | Publicá `patch` con el arreglo. Es el único camino fiable. Mantené la versión rota descargable unos días para no romper instalaciones a mitad de camino. |
| Me equivoqué de número | Si **todavía no subiste el tag**: `python tools/bump_version.py --set X.Y.Z` y volvé a empezar. Si ya se publicó: publicá un número **mayor** con el correcto. El tag viejo se deja, no se borra. |
| Falló la firma | El canal no se actualiza (la etapa de Pages depende de la firma). Arreglá el motivo — credenciales vencidas, error de validación de Mozilla — y volvé a correr. Reintentar con el mismo tag es seguro: el release falla si el archivo ya existe, así que si hace falta, borrá ese release **desde la web de GitHub** y reintentá el workflow. |
| El archivo no se puede descargar | El workflow ya lo comprueba antes de publicar el manifiesto y aborta solo. Si pasó igual, republicá el canal: `Actions → Release → Run workflow` sobre el tag existente no hace falta; corregí y publicá un `patch`. |
| El manifiesto anuncia una URL equivocada | Cambiá `UPDATE_BASE_URL` (Settings → Variables) y volvé a correr el workflow del tag con **Re-run all jobs**. |
| GitHub Pages no está disponible | El paquete del release sigue descargable a mano; las actualizaciones automáticas se pausan hasta que Pages vuelva. No hace falta publicar nada nuevo. |
| Las credenciales de firma dejaron de andar | Generá credenciales nuevas en <https://addons.mozilla.org/developers/addon/api/key/>, reemplazá los dos secretos en GitHub y publicá un `patch`. |
| Se filtró un token | **Primero revocalo** en la web de Mozilla (o de GitHub), después cargá el nuevo. Sacarlo del repositorio no alcanza: sigue en el historial. |
| Una versión no es compatible con el Floorp del usuario | Los navegadores ignoran actualizaciones incompatibles: el usuario queda en la versión anterior, sin romperse. Si el problema es `strict_min_version`, subilo y publicá un `patch` para el resto. |
| Un usuario no recibe la actualización | Corré `python tools/diagnose.py`. Casi siempre es: no está instalada como add-on administrado, tiene `extensions.update.enabled=false`, o está en una versión anterior a la que introdujo el canal. |

Lo que **no** se pierde nunca con una actualización: los datos de `storage` de la
extensión, porque el ID no cambia.

---

## Qué NO hace el sistema

- No actualiza solo los paquetes instalados **antes** de que existiera el canal
  (no tienen `update_url` guardado). Ver `docs/MIGRATION.md`.
- No publica en el catálogo público de Mozilla (canal *unlisted*).
- No borra ni reinicia tus datos: el `storage` del navegador se conserva entre
  versiones.
