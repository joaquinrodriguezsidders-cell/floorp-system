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
| `AMO_API_KEY` | el *JWT issuer* (empieza con `jwt_`) |
| `AMO_API_SECRET` | el *JWT secret* |

Para firmar en tu propia computadora, en lugar de GitHub:

```bash
export AMO_API_KEY='jwt_...'
export AMO_API_SECRET='...'
```

(o guardalos en `tools/amo_keys.txt` con el formato `key=...` / `secret=...`;
ese archivo ya está excluido del repositorio).

---

## Publicar una versión (esto es el día a día)

```bash
# 1. subir el número de version
python tools/bump_version.py patch     # arreglo           0.19.0 -> 0.19.1
python tools/bump_version.py minor     # función nueva     0.19.0 -> 0.20.0
python tools/bump_version.py major     # cambio grande     0.19.0 -> 1.0.0

# 2. comprobar que todo está bien
python tools/validate.py

# 3. commit y tag
git add -A
git commit -m "chore: v0.19.1"
git tag v0.19.1
git push origin main --tags
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

1. Instalá una versión (ver `docs/MIGRATION.md`).
2. Publicá una versión mayor con un cambio visible.
3. En Floorp: `about:support` → sección **Extensiones** → mirá la versión.
4. Podés forzar la comprobación con `about:addons` → engranaje →
   **Buscar actualizaciones**.

Si la versión no cambia: mirá `about:addons` → FLOORP SYSTEM → debería decir
"Actualizaciones automáticas" y la URL del manifiesto.

---

## Qué NO hace el sistema

- No actualiza solo los paquetes instalados **antes** de que existiera el canal
  (no tienen `update_url` guardado). Ver `docs/MIGRATION.md`.
- No publica en el catálogo público de Mozilla (canal *unlisted*).
- No borra ni reinicia tus datos: el `storage` del navegador se conserva entre
  versiones.
