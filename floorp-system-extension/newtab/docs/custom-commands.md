# CREAR COMANDOS CUSTOM — guía completa

Los comandos custom son **datos declarativos**, no código JavaScript:
una lista de acciones seguras que el engine ejecuta en orden.
**No hay `eval`**: es imposible inyectar código por esta vía.

Dónde viven: `storage.local` del background (persisten entre sesiones
y entre orígenes). Comandos para gestionarlos:

```
mkcmd <nombre> <plantilla>   crea      commands      lista
rmcmd <nombre>               elimina   help          los incluye
```

---

## 1. Las 3 plantillas base

### A) Abrir una URL

```
mkcmd gh https://github.com
```

Al ejecutar `gh` abre la URL en una tab nueva. Si el texto parece una URL
(tiene dominio), el engine elige el tipo `open` automáticamente.

### B) Ejecutar un comando existente

```
mkcmd dev workspace 1
```

`dev` pasa a ser un atajo de `workspace 1`. Funciona con cualquier comando
del sistema (nativo, otro alias u otro custom).

### C) Imprimir un mensaje

```
mkcmd matrix echo MATRIX SYSTEM ONLINE
```

`matrix` imprime el mensaje en verde. Útil para scripts y feedback visual.

---

## 2. Argumentos: $1, $2 ... $@

Al ejecutar un custom, los argumentos que le pases sustituyen estos
marcadores dentro de la acción:

| Marcador | Significado |
|---|---|
| `$1` | primer argumento |
| `$2` | segundo argumento |
| `$@` | todos los argumentos juntos |

Ejemplos:

```
mkcmd g2 google $@
g2 gatos               →  google gatos

mkcmd wiki2 wiki $@
wiki2 linux            →  wiki linux

mkcmd saluda echo hola $1
saluda juan            →  imprime: hola juan
```

---

## 3. Cómo funciona por dentro (para programar sin cagarla)

Estructura real de un custom (así se guarda en storage):

```json
{
  "name": "matrix",
  "actions": [
    { "type": "echo", "value": "MATRIX SYSTEM ONLINE" }
  ]
}
```

Tipos de acción que el engine entiende hoy:

| type | value | efecto |
|---|---|---|
| `echo` | texto | imprime en la terminal (clase ok/verde) |
| `open` | URL | abre tab nueva (`window.open`) |
| `search` | query | ejecuta `google <query>` |
| `command` | línea | ejecuta cualquier comando del engine |
| `workspace` | número | cambia al workspace n (1-5) |

Reglas de convivencia (lo que NO se puede hacer, a propósito):

1. **El nombre no puede pisar un nativo.** `mkcmd help ...` es rechazado.
2. **El nombre debe ser `^[a-z][a-z0-9-]*$`** (letras, números, guiones;
   empieza con letra). URLs como nombre: rechazadas.
3. **Un alias puede apuntar a un custom** y un custom puede ejecutar un
   alias — se resuelven en el mismo engine (orden: custom → alias → nativo).
4. **No hay ejecución de código arbitrario**: si algún día querés lógica
   condicional, la forma correcta es extender `CustomCommands.run` con un
   nuevo tipo de acción declarativa (en `core.js`), no inyectar JS.

---

## 4. Scripts/multipasos (el futuro FLOORP SCRIPTS)

Hoy un custom guarda **una** acción (se crea con una sola línea), pero el
formato ya es una lista: `actions` acepta varias en secuencia. Un script
como `dev` sería:

```json
{
  "name": "dev",
  "actions": [
    { "type": "workspace", "value": "1" },
    { "type": "open", "value": "https://github.com" },
    { "type": "open", "value": "https://stackoverflow.com" },
    { "type": "echo", "value": "workspace DEV listo" }
  ]
}
```

Por ahora esa estructura se logra encadenando: `mkcmd dev workspace 1`
+ `alias dev2 open github.com` — o pidiendo que el próximo BOOT agregue
`mkcmd multi`. El formato ya está listo para eso.

---

## 5. Recetas rápidas

```
# atajos de búsqueda
mkcmd dd duckduckgo
alias dd2 https://duckduckgo.com

# contextos de trabajo
mkcmd dev workspace 1
mkcmd school workspace 2
mkcmd media workspace 3

# diversión
mkcmd matrix echo MATRIX SYSTEM ONLINE
mkcmd hack echo I AM IN.
```

Gestionar: `commands` (lista con sus acciones), `rmcmd <nombre>` (borrar),
`help` (todo junto). Los customs aparecen en TAB autocomplete y en la
command palette (Ctrl+K) automáticamente, marcados como `custom`.
