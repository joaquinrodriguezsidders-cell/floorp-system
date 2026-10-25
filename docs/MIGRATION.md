# Usuarios que ya tienen FLOORP SYSTEM instalado

## Por qué hace falta un paso manual (una sola vez)

Las actualizaciones automáticas de Firefox/Floorp funcionan así: la extensión
instalada guarda, dentro de su propio `manifest.json`, la dirección (`update_url`)
donde preguntar si hay una versión nueva.

Las versiones anteriores a **0.19.0** no tenían esa dirección. Un navegador no
puede agregarla a una extensión ya instalada desde afuera: la dirección viaja
firmada dentro del paquete. Por eso:

> **0.18.0 y anteriores no pueden actualizarse solas. Hay que instalar una vez
> la 0.19.0 (o posterior). Desde ahí, todas las siguientes llegan solas.**

No es una limitación de este proyecto: es cómo funciona el mecanismo de
actualizaciones de Firefox para add-ons distribuidos fuera de la tienda.

## A quién afecta cada caso

| Cómo lo tenés instalado | ¿Se actualiza solo? | Qué tenés que hacer |
|---|---|---|
| Carga temporal (`about:debugging`) | No, nunca: se descarga al cerrar el navegador | Instalar la versión firmada, una vez |
| XPI en la carpeta `extensions/` del perfil, versión ≤ 0.18.0 | No (no tiene `update_url`) | Instalar la 0.19.0 encima, una vez |
| XPI instalado desde archivo, versión ≤ 0.18.0 | No (no tiene `update_url`) | Instalar la 0.19.0 encima, una vez |
| Versión ≥ 0.19.0 firmada | **Sí**, automático | Nada |

## Cómo migrar (5 pasos, sin admin)

1. Descargá el `.xpi` firmado más nuevo (el instalador `installer/install.py`
   también lo copia al perfil, o usá la página del canal).
2. En Floorp: `about:addons` → engranaje ⚙ → **Instalar complemento desde archivo…**
3. Elegí el `.xpi`. Si pregunta por permisos, aceptá: son los mismos de siempre
   (`tabs`, `storage`, `notifications`, `downloads` y `127.0.0.1`).
4. **No desinstales antes la versión vieja**. Instalá encima: mismo ID
   (`floorp-system@fsys.system`) = misma extensión, y tus datos se conservan.
5. Comprobá en `about:addons` que la versión sea la nueva, y que en la ficha
   aparezca la línea de actualizaciones automáticas.

## ¿Se pierden mis datos?

No. Los comandos propios, aliases, notas, snippets, vaults y preferencias viven
en el almacenamiento de la extensión, que está indexado por el **ID** del add-on.
Al instalar encima con el mismo ID se conserva todo.

Lo único que se pierde es lo que estaba en la pestaña vieja **abierta** en el
momento de reemplazar: cerrá o guardá con `vault save` antes de migrar, por las
dudas.

## Cómo comprobar que la migración quedó bien

Primero, automático: `python tools/diagnose.py` lee tu perfil y responde si la
extensión está instalada como add-on administrado, si la firma es válida, si el
canal responde y si tenés la última versión.

A mano:

```
about:support  →  Extensiones  →  FLOORP SYSTEM
  versión:   0.19.0 (o mayor)
  ID:        floorp-system@fsys.system
  actualizaciones: automáticas
```

Después de la próxima publicación, esa versión debería subir sola.

> **Medido en este equipo:** al revisar el perfil actual, FLOORP SYSTEM no
> figuraba en `extensions.json` (solo existían el diccionario es-AR, el paquete
> de idioma y otra extensión). Es decir, en este perfil todavía no hay una
> instalación administrada que migrar: la primera instalación ya puede ser la
> versión con canal y no hará falta ningún paso extra.

## Si algo sale mal

- **"El complemento no se pudo verificar"** → el `.xpi` no está firmado. Usá el
  del Release oficial (el que genera el workflow), no el `-unsigned`.
- **Sigue la versión vieja** → se instaló en otro perfil de Floorp
  (`about:profiles` para ver cuál está activo).
- **Perdiste comandos o notas** → no desinstales: reinstalá el mismo ID y volvé
  a revisar. Si hiciste `setup backup`, recuperá con `setup restore <json>`.
- **Volver a la versión anterior** → Firefox no hace *downgrade* automático.
  Para volver atrás hay que instalar el `.xpi` viejo a mano y después publicar
  una versión nueva con número mayor que corrija el problema.
