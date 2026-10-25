/* ============================================================
   FLOORP SYSTEM INITIALIZED — core.js (BOOT 06-10, pulido v0.10.2)
   terminal + command engine + history + aliases + custom
   commands + autocomplete + WORKSPACE ENGINE REAL (vía bridge).
   Si no hay extensión (modo file://), degrada a LOCAL sin romper.
   ============================================================ */
"use strict";  const VERSION = "0.19.0";   /* visible en 'about', el header del tile y el MOTD */

/* ============ 1. ESTADO GLOBAL (una sola fuente de verdad) ============ */
const FSYS = {
  settings: {
    user: "user",
    host: "floorp",
    bootAnimation: true,
  },
  /* workspaces: [{id, name, tabs?}] — LOCAL usa los defaults; con bridge, el background manda */
  workspaces: [
    { id: 1, name: "DEV" },
    { id: 2, name: "SCHOOL" },
    { id: 3, name: "MEDIA" },
    { id: 4, name: "GAMING" },
    { id: 5, name: "RANDOM" },
  ],
  activeWorkspace: 1,
  history: [],
  historyIndex: -1,
  aliases: {},        // { g: "google", ... }
  customCommands: {}, // { matrix: { actions: [...] } }
  pendingKill: null,  // confirmación de 2 pasos para kill
  config: {           // personalización persistente (config / theme / accent)
    accent: "green",  // green | amber | cyan | red
    aiModel: null,    // modelo Ollama preferido (ai use <modelo>)
    /* STUDIO (v0.17): el escritorio como lienzo. Todo token, todo
       persistido, todo desactivable con 'perf low' (spec §23). */
    studio: null,     // tokens extra: {font, radius, scan, grid}
    wall: null,       // {data (dataURL), dim, blur}
    blurTerm: 0,      // backdrop-filter de la terminal (0-20px)
    blurWidget: 0,    // backdrop-filter de los widgets
    /* Widgets v2: size s|m|l|xl, accent hex opcional, título custom */
    widgets: [],      // [{id, type, arg, x, y, size?, accent?, title?}]
    dashes: {},
  },
};

/* Persistencia local (history/aliases/cmds — los workspaces reales viven en el background) */
const STORE_KEYS = {
  hist: "fsys.history",
  aliases: "fsys.aliases",
  cmds: "fsys.commands",
  cfg: "fsys.config",
};
function loadStore(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (e) { return fallback; }
}
FSYS.history        = loadStore(STORE_KEYS.hist, []);
FSYS.aliases        = loadStore(STORE_KEYS.aliases, {});
FSYS.customCommands = loadStore(STORE_KEYS.cmds, {});
FSYS.config         = { ...FSYS.config, ...loadStore(STORE_KEYS.cfg, {}) };
/* prompt personalizado persistido (config user/host) → settings en vivo */
if (FSYS.config.user) FSYS.settings.user = FSYS.config.user;
if (FSYS.config.host) FSYS.settings.host = FSYS.config.host;

/* Alias por defecto (solo si el usuario nunca creó ese alias) */
const FSYS_DEFAULT_ALIASES = { g: "google" };

/* saveStore: escribe en localStorage (modo LOCAL) y, si hay bridge,
   también en storage.local del background (persiste entre orígenes
   y entre sesiones de la extensión). loadStore hace el camino inverso:
   bridge primero, localStorage como fallback. */
function saveStore(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* modo privado */ }
  const short = key.replace("fsys.", "");
  Bridge.storeSet(short, value);
}
async function loadStoreHydrate() {
  /* Sanitización: descarta aliases con nombre inválido (p.ej. URLs
     creadas por error) o con destino vacío. */
  const validName = (n) => /^[a-z][a-z0-9_-]*$/i.test(n);
  const sanitize = (obj) => Object.fromEntries(
    Object.entries(obj || {}).filter(([k, v]) => validName(k) && typeof v === "string" && v.trim())
  );

  const aliases = await Bridge.storeGet("aliases", null);
  if (aliases && typeof aliases === "object") {
    FSYS.aliases = { ...FSYS_DEFAULT_ALIASES, ...sanitize(aliases) };
  } else {
    /* Primera vez en este origen: defaults + lo local válido */
    FSYS.aliases = { ...FSYS_DEFAULT_ALIASES, ...sanitize(FSYS.aliases) };
    saveStore(STORE_KEYS.aliases, FSYS.aliases);
  }
  const cmds = await Bridge.storeGet("commands", null);
  if (cmds && typeof cmds === "object") FSYS.customCommands = cmds;
  const hist = await Bridge.storeGet("history", null);
  if (Array.isArray(hist)) FSYS.history = hist;
}

/* ============ 2. EVENT BUS ============ */
const Bus = {
  listeners: {},
  on(evt, fn) { (this.listeners[evt] ||= []).push(fn); },
  emit(evt, data) { (this.listeners[evt] || []).forEach((fn) => fn(data)); },
};

/* ============ 3. MOTOR DE COMANDOS ============ */
/* Cada comando: { name, description, usage, type, run(args, ctx) } */
const CommandEngine = {
  registry: new Map(),

  register(cmd) { this.registry.set(cmd.name, cmd); },
  get(name) { return this.registry.get(name); },

  /* Resolve: custom → alias → nativo. Un solo sistema para
     terminal, sugerencias y futura command palette. */
  resolve(name) {
    const custom = FSYS.customCommands[name];
    if (custom) return { kind: "custom", name, def: custom };
    if (FSYS.aliases[name]) return { kind: "alias", name, target: FSYS.aliases[name] };
    if (this.registry.has(name)) return { kind: "native", name, cmd: this.registry.get(name) };
    return null;
  },

  execute(rawLine) {
    const line = rawLine.trim();
    if (!line) return;

    const parts = line.split(/\s+/);
    const name = parts[0];
    const args = parts.slice(1);

    const resolved = this.resolve(name);
    if (!resolved) {
      Term.printErr(`COMANDO DESCONOCIDO: ${name}`);
      /* Sugerencia fuzzy sobre TODOS los comandos (nativos + aliases + custom) */
      const all = [...this.registry.keys(), ...Object.keys(FSYS.aliases), ...Object.keys(FSYS.customCommands)];
      let best = null, bestD = Infinity;
      for (const c of all) {
        const d = lev(name, c);
        if (d < bestD) { bestD = d; best = c; }
      }
      if (best && bestD <= Math.max(2, Math.floor(best.length / 2)))
        Term.printOut(`¿quisiste decir '${best}'?`, "dim");
      else
        Term.printOut(`Ejecutá 'help' para ver los comandos disponibles.`, "dim");
      return;
    }

    /* Alias → re-ejecutar con el destino */
    if (resolved.kind === "alias") {
      const target = FSYS.aliases[name];
      const rest = args.join(" ");
      Bus.emit("COMMAND_EXECUTED", { line, kind: "alias", name });
      this.execute(target + (rest ? " " + rest : ""));
      return;
    }

    /* Custom command → secuencia declarativa de acciones */
    if (resolved.kind === "custom") {
      Bus.emit("COMMAND_EXECUTED", { line, kind: "custom", name });
      stopLiveWidgets();
      CustomCommands.run(resolved.def, args);
      return;
    }

    /* Nativo */
    Bus.emit("COMMAND_EXECUTED", { line, kind: "native", name });
    /* Widgets vivos (reloj, timer, top, matrix): el próximo comando los congela. */
    stopLiveWidgets();
    try {
      resolved.cmd.run(args, { Term, FSYS, Bus });
    } catch (e) {
      Term.printErr(`ERROR EN '${name}': ${e.message}`);
    }
  },
};

/* ============ 4. COMANDOS CUSTOM (datos, no funciones) ============ */
const CustomCommands = {
  /* Acciones declarativas. Cada tipo es seguro: no evalúa JS. */
  run(def, args) {
    for (const action of def.actions || []) {
      const value = this.interpolate(action.value, args);
      switch (action.type) {
        case "echo":   Term.printOut(value, "ok"); break;
        case "open":   window.open(value, "_blank"); break;
        case "search": CommandEngine.execute(`google ${value}`); break;
        case "command": CommandEngine.execute(value); break;
        case "workspace": {
          const n = parseInt(value, 10);
          if (n >= 1 && n <= FSYS.workspaces.length) Workspaces.switchTo(n);
          else Term.printErr(`workspace inválido: ${value}`);
          break;
        }
        /* STUDIO: acciones que ofrece el wizard de mkcmd — delegan en
           el comando nativo (una sola implementación, cero duplicación) */
        case "vault":  CommandEngine.execute(`vault load ${value}`); break;
        case "radio":  CommandEngine.execute(`radio ${value}`); break;
        case "pane":   CommandEngine.execute(`pane ${value}`); break;
        case "dash":   CommandEngine.execute(`dash ${value}`); break;
        default:
          Term.printErr(`acción desconocida: ${action.type}`);
      }
    }
  },

  /* Sustituye $1 $2 $@ por argumentos (sin eval) */
  interpolate(str, args) {
    return str
      .replace(/\$\@/g, args.join(" "))
      .replace(/\$(\d+)/g, (m, n) => args[parseInt(n, 10) - 1] ?? "");
  },

  create(name, commandLine) {
    if (!/^[a-z][a-z0-9-]*$/i.test(name)) {
      Term.printErr(`nombre inválido: ${name} (usá letras, números, guiones)`);
      return;
    }
    const _clash = CommandEngine.resolve(name);
    if (_clash) {
      const kind = _clash.kind === "custom" ? "comando custom"
                 : _clash.kind === "alias" ? "alias" : "comando nativo";
      Term.printErr(`'${name}' ya existe como ${kind}.`);
      if (_clash.kind === "custom") Term.printOut(`borralo primero: rmcmd ${name}`, "dim");
      if (_clash.kind === "alias") Term.printOut(`borralo primero: unalias ${name}`, "dim");
      return;
    }
    /* Multi-acción: 'cmd1 && cmd2 && open url && workspace 2' (spec §10).
       Cada eslabón se clasifica por su primer token — sin eval, siempre. */
    const CHAIN_SEP = /\s*&&\s*/;
    if (CHAIN_SEP.test(commandLine)) {
      const chain = commandLine.split(CHAIN_SEP).map((s) => s.trim()).filter(Boolean);
      if (chain.length > 1 && chain.every((step) => CommandEngine.resolve(step.split(/\s+/)[0]))) {
        FSYS.customCommands[name] = { name, actions: chain.map((step) => ({ type: "command", value: step })) };
        saveStore(STORE_KEYS.cmds, FSYS.customCommands);
        Term.printOut(`comando creado: ${name}  (${chain.length} acciones encadenadas)`, "ok");
        return;
      }
      if (chain.length > 1) {
        Term.printErr("algún eslabón del && no es un comando conocido — revisalo:");
        chain.forEach((s, i) => {
          const okk = !!CommandEngine.resolve(s.split(/\s+/)[0]);
          Term.printOut(`  ${okk ? "ok " : "?? "} ${i + 1}. ${s}`, okk ? "dim" : "err");
        });
        return;
      }
    }
    const parts = commandLine.split(/\s+/);
    const head = parts[0];
    const rest = parts.slice(1).join(" ");

    let actions;
    if (/^https?:\/\//.test(head) || /^[\w-]+(\.[\w-]+)+/.test(head)) {
      actions = [{ type: "open", value: head + (rest ? " " + rest : "") }];
    } else if (CommandEngine.resolve(head) && rest) {
      actions = [{ type: "command", value: commandLine }];
    } else {
      actions = [{ type: "echo", value: commandLine || `${name} ejecutado` }];
    }

    FSYS.customCommands[name] = { name, actions };
    saveStore(STORE_KEYS.cmds, FSYS.customCommands);
    Term.printOut(`comando creado: ${name}`, "ok");
  },

  remove(name) {
    if (FSYS.customCommands[name]) {
      delete FSYS.customCommands[name];
      saveStore(STORE_KEYS.cmds, FSYS.customCommands);
      Term.printOut(`comando eliminado: ${name}`, "ok");
    } else {
      Term.printErr(name ? `no existe el comando custom: ${name}`
                         : "uso: rmcmd <nombre>   ('commands' lista los tuyos)");
    }
  },

  list() {
    const names = Object.keys(FSYS.customCommands);
    if (!names.length) { Term.printOut("(sin comandos custom — usá mkcmd)", "dim"); return; }
    for (const n of names) {
      const def = FSYS.customCommands[n];
      const desc = def.actions.map((a) => `${a.type}: ${a.value}`).join("  |  ");
      Term.printOut(`  ${n.padEnd(12)} ${desc}`, "out");
    }
  },

  /* Guía de creación: plantillas + doc completa en custom-commands.md */
  guide() {
    Term.printOut("CREAR COMANDOS CUSTOM — GUÍA RÁPIDA", "ok");
    Term.printOut("");
    Term.printOut("PLANTILLAS (copiá y reemplazá):", "out");
    Term.printOut("  mkcmd <nombre> <url>            → abre la URL");
    Term.printOut("     mkcmd git https://github.com");
    Term.printOut("  mkcmd <nombre> <comando>        → ejecuta un comando existente");
    Term.printOut("     mkcmd dev workspace 1");
    Term.printOut("  mkcmd <nombre> <texto>          → imprime un mensaje");
    Term.printOut("     mkcmd banner echo MATRIX ONLINE");
    Term.printOut("");
    Term.printOut("ARGUMENTOS (en el comando, se sustituyen al ejecutar):", "out");
    Term.printOut("  $1 $2 ...  = argumento n     $@ = todos los argumentos");
    Term.printOut("     mkcmd g2 google \"$@\"     →  g2 gatos busca 'gatos'");
    Term.printOut("");
    Term.printOut("CADENAS (varias acciones en un comando, con &&):", "out");
    Term.printOut("     mkcmd dev ws next && open github.com && top");
    Term.printOut("     mkcmd focus clear && workspace 1 && note sesion dev");
    Term.printOut("  → los customs se guardan y persisten; lista con 'commands'");
    Term.printOut("");
    Term.printOut("DOC COMPLETA (tipos de acción, límites, ejemplos):", "out");
    Term.printOut("  docs/custom-commands.md  → en la carpeta del sistema", "dim");
    Term.printOut("  \"¿cómo programar mis propios comandos sin cagarla?\": ahí está", "dim");
  },
};

/* ============ 5. WORKSPACES (BOOT 06: puente primero, LOCAL como fallback) ============ */
const Workspaces = {
  activeId: 1,

  activeLabel() {
    const ws = FSYS.workspaces[this.activeId - 1];
    if (!ws) return "01 —";
    const num = String(ws.id ?? this.activeId).padStart(2, "0");
    return `${num} ${ws.name}`;
  },

  renderBar() {
    /* La barra se construye desde el engine: los workspaces reales
       (nativos o de sesión) son la única fuente de verdad. */
    const bar = document.getElementById("workspacebar");
    bar.innerHTML = "";
    FSYS.workspaces.forEach((ws, i) => {
      const id = ws.id ?? i + 1;
      const btn = document.createElement("button");
      btn.className = "ws";
      btn.dataset.ws = String(id);
      btn.textContent = `${String(id).padStart(2, "0")} ${ws.name}`;
      if (id === this.activeId) btn.classList.add("active");
      btn.addEventListener("click", () => Workspaces.switchTo(id));
      bar.appendChild(btn);
    });
    /* Badge de modo: NATIVO = workspaces reales de Floorp */
    const modeEl = document.getElementById("sb-wsmode");
    if (modeEl) {
      const native = this.mode === "NATIVE";
      modeEl.textContent = native ? "NATIVO" : "SESIONES";
      modeEl.title = native ? "cambiás los workspaces reales de Floorp"
                            : "sesiones propias por workspace — 'ws enable' activa los nativos";
      modeEl.classList.toggle("native", native);
    }
    document.getElementById("sb-workspace").textContent = this.activeLabel();
  },

  async syncFromBridge() {
    const res = await Bridge.call("ws.list");
    if (res && res.ok) {
      this.mode = res.data.mode || "SESSIONS";
      FSYS.workspaces = res.data.workspaces.map((w) => ({
        id: w.id, name: w.name, tabs: w.tabs, isSelected: w.isSelected,
      }));
      this.activeId = res.data.active || 1;
    }
  },

  /* ==== Sync en vivo (v0.14): si cambiás el workspace desde la UI de
     Floorp, la barra y la status bar se enteran solas. ==== */
  _live: null,
  _liveTick: false,
  startLiveSync() {
    if (this._live || !Bridge.available) return;
    this._live = setInterval(async () => {
      if (this._liveTick || document.hidden) return;  /* pestaña oculta: cero red */
      this._liveTick = true;
      try {
        const res = await Bridge.call("ws.current", {}, 4000);
        if (res && res.ok) {
          const d = res.data;
          if (d.mode === "NATIVE" && d.id && d.id !== this.activeId) {
            this.activeId = d.id;
            this.renderBar();
            Bus.emit("WORKSPACE_CHANGED", { workspace: d.id });
          }
        }
      } catch (e) { /* bridge offline: el próximo tick reintenta */ }
      this._liveTick = false;
    }, 10000);
  },

  async switchTo(n) {
    if (n < 1 || n > FSYS.workspaces.length) {
      Term.printErr(`workspace inválido: ${n} (1-${FSYS.workspaces.length})`);
      return;
    }

    /* ---- MODO BRIDGE: nativo si hay OS Server, sesiones si no ---- */
    if (Bridge.available) {
      Term.printOut(`> switching workspace ${n}...`, "dim");
      const res = await Bridge.call("ws.switch", { id: n }, 10000);
      if (!res || !res.ok) {
        Term.printErr(`BRIDGE ERROR: ${(res && res.error) || "sin respuesta"}`);
        return;
      }
      const d = res.data;
      await this.syncFromBridge().catch(() => {});
      this.renderBar();
      if (d.mode === "NATIVE") {
        Term.printOut(`WORKSPACE NATIVO // ${String(d.index).padStart(2, "0")} ${d.name}`, "ok");
      } else {
        Term.printOut(
          `WORKSPACE // ${String(n).padStart(2, "0")} ${d.name}  (sesiones: guardadas ${d.saved}, restauradas ${d.restored})`,
          "ok"
        );
      }
      Bus.emit("WORKSPACE_CHANGED", { workspace: n });
      return;
    }

    /* ---- MODO LOCAL (sin extensión): estado solo en la home ---- */
    this.activeId = n;
    this.renderBar();
    Bus.emit("WORKSPACE_CHANGED", { workspace: n });
    Term.printOut(`WORKSPACE // ${this.activeLabel()}  (modo LOCAL)`, "ok");
  },

  init() {
    /* Los listeners de click los crea renderBar (los botones son dinámicos). */
    this.renderBar();
  },
};

/* ============ 6. COMANDOS NATIVOS ============ */
/* Categorías de help agrupado. Lo no mapeado cae en SISTEMA. */
const CAT_OF = {
  help: "SHELL", about: "SHELL", clear: "SHELL", history: "SHELL", hist: "SHELL",
  echo: "SHELL", config: "SHELL", alias: "SHELL", aliases: "SHELL", unalias: "SHELL",
  mkcmd: "SHELL", commands: "SHELL", rmcmd: "SHELL", note: "SHELL", notes: "SHELL",
  system: "SISTEMA", ps: "SISTEMA", kill: "SISTEMA", date: "SISTEMA", calc: "SISTEMA",
  timer: "SISTEMA", top: "SISTEMA", matrix: "SISTEMA",
  google: "WEB", yt: "WEB", gh: "WEB", wiki: "WEB", open: "WEB",
  workspace: "NAVEGACIÓN", ws: "NAVEGACIÓN", tab: "NAVEGACIÓN",
  bridge: "OS", apps: "OS", "open-app": "OS", "add-app": "OS", "rm-app": "OS",
  file: "OS", folder: "OS", notify: "OS", clip: "OS",
  ai: "AI",
  vault: "FLUJO", focus: "FLUJO", pin: "FLUJO", startup: "FLUJO", auto: "FLUJO",
  snip: "DATOS", cliplog: "DATOS", webapp: "DATOS", search: "DATOS",
  radio: "MEDIA", widget: "MEDIA", dash: "MEDIA",
  theme: "MEDIA", wall: "MEDIA", blur: "MEDIA", perf: "MEDIA",
  weather: "WEB", news: "WEB", crypto: "WEB", ip: "WEB", dict: "WEB",
};

function reg(name, description, usage, run) {
  CommandEngine.register({
    name, description, usage, type: "native",
    cat: CAT_OF[name] || "SISTEMA",
    run,
  });
}

/* Único punto que renderiza el prompt (config user/host lo actualiza) */
function updatePrompt() {
  const p = document.getElementById("term-prompt");
  if (p) p.textContent = `${FSYS.settings.user}@${FSYS.settings.host}:~$`;
}

/* ---- SISTEMA ---- */
reg("help", "Comandos por grupo, o detalle de uno", "help | help <comando>", (args) => {
  const q = (args[0] || "").toLowerCase();
  /* help <comando> → detalle: descripción + usage (alias/custom también) */
  if (q) {
    const r = CommandEngine.resolve(q);
    if (!r) { Term.printErr(`no existe: ${q}`); return; }
    if (r.kind === "alias") {
      Term.printOut(`${q} → ${r.target}`, "ok");
      Term.printOut(`(es un alias — 'help ${r.target.split(" ")[0]}' muestra el comando real)`, "dim");
      return;
    }
    if (r.kind === "custom") {
      Term.printOut(`${q} (comando custom)`, "ok");
      (r.def.actions || []).forEach((a) => Term.printOut(`  ${a.type}: ${a.value}`, "out"));
      return;
    }
    Term.printOut(`${r.cmd.name} — ${r.cmd.description}`, "ok");
    Term.printOut(`uso: ${r.cmd.usage || r.cmd.name}`, "out");
    return;
  }
  /* Agrupado por categoría — escaneable, no una lista plana */
  const groups = new Map();
  for (const c of CommandEngine.registry.values()) {
    const cat = c.cat || "SISTEMA";
    if (!groups.has(cat)) groups.set(cat, []);
    groups.get(cat).push(c);
  }
  const CATS = ["SISTEMA", "WEB", "MEDIA", "NAVEGACIÓN", "OS", "AI", "FLUJO", "DATOS", "APPS", "SHELL"];
  for (const cat of CATS) {
    const list = groups.get(cat);
    if (!list || !list.length) continue;
    Term.printOut(cat, "ok");
    for (const c of list.slice().sort((a, b) => a.name.localeCompare(b.name)))
      Term.printOut(`  ${c.name.padEnd(12)} ${c.description}`, "out");
  }
  const al = Object.keys(FSYS.aliases);
  if (al.length) {
    Term.printOut("ALIASES", "ok");
    for (const a of al.sort()) Term.printOut(`  ${a.padEnd(12)} → ${FSYS.aliases[a]}`, "out");
  }
  const cc = Object.keys(FSYS.customCommands);
  if (cc.length) {
    Term.printOut("CUSTOM", "ok");
    for (const c of cc.sort()) Term.printOut(`  ${c.padEnd(12)} (custom)`, "out");
  }
  Term.printOut("detalle de uno: help <comando>", "dim");
});

reg("about", "Acerca de FLOORP SYSTEM", "about", () => {
  Term.printOut(`FLOORP SYSTEM INITIALIZED — v${VERSION}`, "ok");
  Term.printOut("Linux si reencarnara en un navegador.", "out");
  Term.printOut("Motor: Floorp · Capa de entorno: FLOORP SYSTEM", "dim");
  Term.printOut("'config' personaliza tema, prompt y boot", "dim");
});

/* ---- SYSTEM = task manager + rendimiento (todo real, nada inventado) ----
   CPU: navigator.hardwareConcurrency (núcleos) + estimación de carga UI
        midiendo el propio event loop (rAF delta vs 60fps).
   RAM: performance.memory (Chromium/Floorp: heap JS real del navegador).
   TAREAS: las tabs reales de la ventana (vía bridge, como el task manager).
   STORAGE: estimación cuota/uso del origen (navigator.storage.estimate).
   RED: tipo efectivo de conexión (navigator.connection) + estado. */
const SystemReport = {
  loopLag: null,

  /* Mide 12 frames: si el event loop tarda más de lo esperado,
     hay carga en la UI. Es la misma idea del about:performance.
     Con guardia anti-cuelgue: si la tab pierde el foco, rAF no
     dispara y la promesa nunca resolvería → timeout de 600ms. */
  measureUILoad() {
    return new Promise((resolve) => {
      const deltas = [];
      let last = performance.now();
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        if (!deltas.length) return resolve(0);   /* sin muestras: honesto 0 */
        const avg = deltas.reduce((a, b) => a + b, 0) / deltas.length;
        const lag = Math.max(0, avg - 16.7);
        resolve(Math.min(99, Math.round(lag / 5 * 10)));
      };
      const tick = (now) => {
        deltas.push(now - last);
        last = now;
        if (deltas.length < 12) requestAnimationFrame(tick);
        else finish();
      };
      requestAnimationFrame(tick);
      setTimeout(finish, 600);
    });
  },

  bar(pct, width = 20) {
    const filled = Math.round((pct / 100) * width);
    return "█".repeat(filled) + "░".repeat(width - filled);
  },

  async render() {
    const kb = (n) => `${(n / 1048576).toFixed(1)} MB`;
    const pad = (s, n) => String(s).padEnd(n, " ");

    Term.printOut("SYSTEM // RENDIMIENTO Y TAREAS", "ok");
    Term.printOut("");

    /* ---- CPU ---- */
    const cores = navigator.hardwareConcurrency || "?";
    const uiLoad = await this.measureUILoad();
    Term.printOut(`CPU
  núcleos lógicos   ${cores}
  carga UI (frame)  ${this.bar(uiLoad)} ${String(uiLoad).padStart(2)}%`, "out");

    /* ---- MEMORIA (heap real del navegador, si está expuesta) ---- */
    if (performance.memory) {
      const m = performance.memory;
      const used = m.usedJSHeapSize, total = m.jsHeapSizeLimit;
      const pct = Math.round((used / total) * 100);
      Term.printOut(`MEM
  heap JS en uso    ${this.bar(pct)} ${pct}%
  heap real         ${kb(used)} / límite ${kb(total)}`
        + (performance.memory && m.totalJSHeapSize ? `\n  heap asignado     ${kb(m.totalJSHeapSize)}` : ""), "out");
    } else {
      Term.printOut(`MEM
  heap JS           (no expuesta en este modo — disponible como extensión)`, "dim");
    }

    /* ---- STORAGE (cuota real del origen) ---- */
    try {
      const est = await navigator.storage.estimate();
      if (est && est.quota) {
        const pct = Math.min(100, Math.round((est.usage / est.quota) * 100));
        Term.printOut(`STORAGE
  cuota del origen  ${this.bar(pct)} ${pct}%
  en uso            ${kb(est.usage)} / ${kb(est.quota)}`, "out");
      }
    } catch (e) { /* sin estimación disponible */ }

    /* ---- RED (tipo efectivo, como el admin de rendimiento) ---- */
    const conn = navigator.connection;
    Term.printOut(`RED
  estado            ${navigator.onLine ? "ONLINE" : "OFFLINE"}`,
                navigator.onLine ? "out" : "err");
    if (conn) {
      const parts = [];
      if (conn.effectiveType) parts.push(conn.effectiveType.toUpperCase());
      if (conn.downlink) parts.push(`~${conn.downlink} Mb/s`);
      if (conn.rtt) parts.push(`rtt ${conn.rtt}ms`);
      if (parts.length) Term.printOut(`  conexión          ${parts.join(" · ")}`, "out");
    }

    /* ---- TAREAS (tabs reales de la ventana, vía bridge) ---- */
    let tasks = null;
    if (Bridge.available) {
      try { tasks = (await Bridge.call("tab.list")).data; } catch (e) { /* sin bridge */ }
    }
    Term.printOut(`TAREAS (${tasks ? tasks.length : "?"} tabs de la ventana)`, "ok");
    if (tasks) {
      for (const t of tasks) {
        const flag = t.active ? "❯" : " ";
        const pin = t.pinned ? " [#]" : "";
        const title = t.title.length > 52 ? t.title.slice(0, 51) + "…" : t.title;
        Term.printOut(` ${flag} ${pad(title, 54)}${pin}`, t.active ? "ok" : "out");
      }
    } else {
      Term.printOut("  (bridge offline — cargá la extensión para ver las tabs reales)", "dim");
    }

    /* ---- SHELL ---- */
    const appsInfo = Bridge.appsOnline ? `${Bridge.appsCount} apps del sistema listas` : "fsys-bridge offline (apps de SO apagadas)";
    Term.printOut(`SHELL
  workspace         ${Workspaces.activeLabel()}
  bridge            ${Bridge.available ? "ONLINE" : "LOCAL"}
  fsys-bridge       ${appsInfo}
  history           ${FSYS.history.length} entradas · aliases ${Object.keys(FSYS.aliases).length} · customs ${Object.keys(FSYS.customCommands).length}`, "out");
    Term.printOut("");
    Term.printOut("todo medido en vivo en tu máquina — nada simulado", "dim");
  },
};

reg("system", "Task manager: CPU, RAM, discos, uptime y tareas", "system", async () => {
  Term.printOut("SYSTEM // RENDIMIENTO Y TAREAS", "ok");
  Term.printOut("");

  /* ---- MÁQUINA REAL (vía fsys-bridge, si está) ---- */
  let sysData = null;
  if (Bridge.available) {
    const res = await Bridge.call("sys.metrics", {}, 6000).catch(() => null);
    if (res && res.ok) sysData = res.data;
  }
  const bar = (pct, w = 20) => {
    const f = Math.round((Math.min(100, pct) / 100) * w);
    return "█".repeat(f) + "░".repeat(w - f);
  };

  if (sysData) {
    const c = sysData.cpu || {};
    Term.printOut(`CPU
  uso real          ${bar(c.percent ?? 0)} ${c.percent ?? "?"}%
  núcleos           ${c.cores ?? "?"}`, "out");
    const m = sysData.mem;
    if (m) Term.printOut(`MEMORIA
  RAM               ${bar(m.percent)} ${m.percent}%
  en uso            ${m.used_mb} / ${m.total_mb} MB`, "out");
    if (Array.isArray(sysData.disks) && sysData.disks.length) {
      const rows = sysData.disks.map((d) => `  ${d.mount.padEnd(10)} ${bar(d.percent, 14)} ${d.percent}%  (${d.used_gb}/${d.total_gb} GB)`).join("\n");
      Term.printOut(`DISCOS
${rows}`, "out");
    }
    const up = sysData.uptime_s;
    if (up) Term.printOut(`SISTEMA
  uptime            ${Math.floor(up / 3600)}h ${Math.floor((up % 3600) / 60)}m encendida
  (puente python    ${sysData.python})`, "out");
  } else {
    /* Sin bridge: lo que el navegador sí puede medir, con honestidad */
    const cores = navigator.hardwareConcurrency || "?";
    const uiLoad = await SystemReport.measureUILoad();
    Term.printOut(`CPU
  núcleos lógicos   ${cores}
  carga UI (frame)  ${bar(uiLoad)} ${uiLoad}%`, "out");
    if (performance.memory) {
      const m = performance.memory;
      const pct = Math.round((m.usedJSHeapSize / m.jsHeapSizeLimit) * 100);
      Term.printOut(`MEMORIA (heap del navegador)
  heap JS           ${bar(pct)} ${pct}%
  en uso            ${(m.usedJSHeapSize / 1048576).toFixed(1)} MB`, "out");
    }
    Term.printOut("  (métricas de máquina completas: iniciá fsys-bridge → 'bridge')", "dim");
  }

  /* ---- RED ---- */
  const conn = navigator.connection;
  Term.printOut(`RED
  estado            ${navigator.onLine ? "ONLINE" : "OFFLINE"}`, navigator.onLine ? "out" : "err");
  if (conn) {
    const parts = [];
    if (conn.effectiveType) parts.push(conn.effectiveType.toUpperCase());
    if (conn.downlink) parts.push(`~${conn.downlink} Mb/s`);
    if (conn.rtt) parts.push(`rtt ${conn.rtt}ms`);
    if (parts.length) Term.printOut(`  conexión          ${parts.join(" · ")}`, "out");
  }

  /* ---- TAREAS: tabs de la ventana (bridge de extensión) ---- */
  let tasks = null;
  if (Bridge.available) {
    try { tasks = (await Bridge.call("tab.list")).data; } catch (e) { /* sin bridge */ }
  }
  Term.printOut(`TAREAS — TABS (${tasks ? tasks.length : "?"} en la ventana)`, "ok");
  if (tasks) {
    for (const t of tasks) {
      const flag = t.active ? "❯" : " ";
      const pin = t.pinned ? " [#]" : "";
      const title = t.title.length > 52 ? t.title.slice(0, 51) + "…" : t.title;
      Term.printOut(` ${flag} ${title.padEnd(54)}${pin}`, t.active ? "ok" : "out");
    }
  } else {
    Term.printOut("  (bridge offline — cargá la extensión para ver las tabs reales)", "dim");
  }

  /* ---- SHELL ---- */
  const appsInfo = Bridge.appsOnline ? `${Bridge.appsCount} apps del sistema listas` : "fsys-bridge offline (apps de SO apagadas)";
  Term.printOut(`SHELL
  workspace         ${Workspaces.activeLabel()}
  bridge            ${Bridge.available ? "ONLINE" : "LOCAL"}
  fsys-bridge       ${appsInfo}
  history           ${FSYS.history.length} entradas · aliases ${Object.keys(FSYS.aliases).length} · customs ${Object.keys(FSYS.customCommands).length}`, "out");
  Term.printOut("");
  Term.printOut(sysData ? "cpu/ram/disco medidos en tu máquina real — nada simulado" : "todo medido en vivo — nada simulado", "dim");
});

/* ---- ps / kill: procesos reales de la máquina (via fsys-bridge) ---- */
reg("ps", "Top procesos por RAM de tu máquina", "ps", async () => {
  if (!Bridge.available) { AppsSys.needBridge(); return; }
  const res = await Bridge.call("sys.processes", {}, 8000).catch(() => null);
  if (!res) { AppsSys.needBridge(); return; }
  if (!res.ok) { Term.printErr(AppsSys.humanError(res)); return; }
  Term.printOut(`PROCESOS // top ${res.data.processes.length} por RAM`, "ok");
  for (const p of res.data.processes) {
    Term.printOut(`  ${String(p.pid).padStart(7)}  ${p.name.padEnd(28)} ${String(p.mem_mb).padStart(8)} MB`, "out");
  }
  Term.printOut("matar uno: kill <pid>  (pide confirmación)", "dim");
});

reg("kill", "Termina un proceso por PID (pide confirmación)", "kill <pid>", (args) => {
  const pid = parseInt(args[0], 10);
  if (!pid) { Term.printErr("uso: kill <pid>   ('ps' lista los procesos)"); return; }
  /* Confirm de 2 pasos: kill <pid> confirm — proteger de dedos rápidos */
  if (args[1] !== "confirm") {
    Term.printOut(`> vas a TERMINAR el proceso ${pid}`, "err");
    Term.printOut(`  confirmá: kill ${pid} confirm   (o espera 15s y expira)`, "dim");
    FSYS.pendingKill = { pid, at: Date.now() };
    return;
  }
  const pend = FSYS.pendingKill;
  if (!pend || pend.pid !== pid || Date.now() - pend.at > 15000) {
    Term.printErr("confirmación expirada o inexistente — escribí kill <pid> de nuevo");
    return;
  }
  FSYS.pendingKill = null;
  (async () => {
    if (!Bridge.available) { AppsSys.needBridge(); return; }
    const res = await Bridge.call("sys.kill", { pid }, 8000).catch(() => null);
    if (!res) { AppsSys.needBridge(); return; }
    if (res.ok) Term.printOut(`proceso ${pid} terminado`, "ok");
    else Term.printErr(AppsSys.humanError(res));
  })();
});

reg("notify", "Notificación del sistema operativo (toast)", "notify <texto>", (args) => {
  const text = args.join(" ");
  if (!text) { Term.printErr("uso: notify <texto>"); return; }
  (async () => {
    if (!Bridge.available) { AppsSys.needBridge(); return; }
    const res = await Bridge.call("sys.notify", { title: "FLOORP SYSTEM", text }, 6000).catch(() => null);
    if (!res) { AppsSys.needBridge(); return; }
    if (res.ok) Term.printOut(`toast enviado: "${text}"`, "ok");
    else Term.printErr(AppsSys.humanError(res));
  })();
});

reg("clip", "Copia texto al portapapeles del SO (queda en cliplog)", "clip <texto>", (args) => {
  const text = args.join(" ");
  if (!text) { Term.printErr("uso: clip <texto>"); return; }
  (async () => {
    if (!Bridge.available) { AppsSys.needBridge(); return; }
    const res = await Bridge.call("sys.clip", { text }, 6000).catch(() => null);
    if (!res) { AppsSys.needBridge(); return; }
    if (res.ok) {
      /* Historial de portapapeles: máx 30 entradas */
      const log = JSON.parse(localStorage.getItem("fsys.cliplog") || "[]");
      log.unshift({ text, at: Date.now() });
      localStorage.setItem("fsys.cliplog", JSON.stringify(log.slice(0, 30)));
      Term.printOut(`en el portapapeles: "${text}"`, "ok");
    }
    else Term.printErr(AppsSys.humanError(res));
  })();
});

reg("folder", "Abre el workspace del sistema en el explorador", "folder", async () => {
  if (!Bridge.available) { AppsSys.needBridge(); return; }
  const res = await Bridge.call("sys.folder", {}, 6000).catch(() => null);
  if (!res) { AppsSys.needBridge(); return; }
  if (res.ok) Term.printOut("workspace abierto en el explorador", "ok");
  else Term.printErr(AppsSys.humanError(res));
});

/* ---- Widgets vivos: congelar TODOS con el próximo comando.
     Cada widget nuevo se registra acá — un solo lugar. ---- */
function stopLiveWidgets() {
  if (typeof LiveClock !== "undefined") LiveClock.stop();
  if (typeof LiveTimer !== "undefined") LiveTimer.stop();
  if (typeof TopMonitor !== "undefined") TopMonitor.stop();
  if (typeof MatrixRain !== "undefined") MatrixRain.stop();
}

/* Los widgets viven antes de stopLiveWidgets (hoisting de function):
   este archivo se carga completo antes de ejecutar cualquier comando. */

/* ============ AI CORE (BOOT 10) ============
   Ollama local vía fsys-bridge: sin claves, sin nube, sin costos.
   Sin Ollama → estado honesto y guía de setup; nada se rompe. */
const AI = {
  models: [],
  online: false,
  checked: false,

  currentModel() {
    return FSYS.config.aiModel || this.models[0] || null;
  },

  async refresh() {
    if (!Bridge.available) { this.online = false; this.checked = true; return this; }
    const res = await Bridge.call("ai.status", {}, 4500).catch(() => null);
    if (res && res.ok && res.data.ai) {
      this.online = res.data.ai.online;
      this.models = res.data.ai.models || [];
    } else {
      this.online = false;
    }
    this.checked = true;
    return this;
  },

  /* Badge del status bar: AI ● verde si hay Ollama, tenue si no. */
  async badge() {
    await this.refresh();
    const sb = document.getElementById("sb-ai");
    const chk = document.getElementById("chk-ai");
    if (sb) {
      sb.textContent = this.online ? "AI ●" : "AI ○";
      sb.style.color = this.online ? "var(--accent)" : "var(--dimmer)";
    }
    if (chk) {
      if (this.online) {
        chk.textContent = this.models.length ? `OLLAMA (${this.models.length} modelo${this.models.length === 1 ? "" : "s"})` : "OLLAMA";
        chk.className = "ok";
      } else {
        chk.textContent = "STANDBY";
        chk.className = "";
      }
    }
  },

  async ask(prompt) {
    const model = this.currentModel();
    if (!model) {
      Term.printErr("no hay modelos — instalá Ollama y bajá uno:");
      Term.printOut("  https://ollama.com/download   →  ollama pull llama3.2:1b", "dim");
      return;
    }
    Term.printOut(`AI CORE // ${model} // pensando...`, "dim");
    const t0 = performance.now();
    const res = await Bridge.call("ai.generate", { model, prompt }, 125000).catch(() => null);
    if (!res) { Term.printErr("sin respuesta del background — ¿está la extensión?"); return; }
    if (!res.ok) { Term.printErr(AI.humanError(res)); return; }
    const secs = ((performance.now() - t0) / 1000).toFixed(1);
    Term.printOut((res.response || "(respuesta vacía)").trimEnd(), "out");
    Term.printOut(`— ${model} · ${secs}s${res.eval_count ? ` · ${res.eval_count} tokens` : ""}`, "dim");
  },

  humanError(res) {
    const e = String(res && res.error || "");
    if (e.includes("BRIDGE_OFFLINE")) return "el AI CORE va por el fsys-bridge — iniciá start-bridge.bat";
    if (e.includes("connection") || e.includes("Connection")) return "Ollama no responde — ¿está corriendo? (ollama serve)";
    if (e.includes("model")) return "modelo no encontrado — 'ai models' lista los bajados";
    return e || "sin respuesta";
  },
};

reg("ai", "AI CORE local (Ollama): status/ask/models/use", "ai <status|models|ask <pregunta>|use <modelo>>", (args) => {
  const sub = (args[0] || "status").toLowerCase();
  (async () => {
    if (sub === "status") {
      await AI.refresh();
      if (!AI.online) {
        Term.printOut("AI CORE: OFFLINE — Ollama local no detectado", "dim");
        Term.printOut("  setup en 2 pasos:", "out");
        Term.printOut("  1. instalá Ollama → https://ollama.com/download", "out");
        Term.printOut("  2. bajá un modelo → ollama pull llama3.2:1b", "out");
        Term.printOut("  después 'ai models' acá y listo. 100% local, gratis, sin cuentas.", "dim");
        return;
      }
      Term.printOut(`AI CORE: ONLINE (ollama) · ${AI.models.length} modelo(s)`, "ok");
      Term.printOut(`modelo activo: ${AI.currentModel() || "(ninguno)"}`, "out");
      Term.printOut("usalo: ai ask <pregunta>", "dim");
    } else if (sub === "models") {
      await AI.refresh();
      if (!AI.models.length) { Term.printOut("(sin modelos — 'ai status' tiene la guía)", "dim"); return; }
      const cur = AI.currentModel();
      for (const m of AI.models) {
        const mark = m === cur ? "❯" : " ";
        Term.printOut(` ${mark} ${m}`, m === cur ? "ok" : "out");
      }
      Term.printOut("cambiar: ai use <nombre>", "dim");
    } else if (sub === "use") {
      const model = args.slice(1).join(" ").trim();
      if (!model) { Term.printErr("uso: ai use <modelo>   ('ai models' lista)"); return; }
      await AI.refresh();
      if (!AI.models.includes(model)) {
        Term.printErr(`modelo no descargado: ${model}`);
        Term.printOut(`bajalo primero: ollama pull ${model}`, "dim");
        return;
      }
      FSYS.config.aiModel = model;
      saveStore(STORE_KEYS.cfg, FSYS.config);
      Term.printOut(`modelo activo: ${model}`, "ok");
    } else if (sub === "ask") {
      const q = args.slice(1).join(" ").trim();
      if (!q) { Term.printErr("uso: ai ask <pregunta>"); return; }
      await AI.refresh();
      await AI.ask(q);
    } else {
      Term.printErr(`subcomando desconocido: ${sub}  (status | models | use | ask)`);
    }
  })();
});

reg("clear", "Limpia la terminal", "clear", () => {
  Term.clear();
  Term.printOut("> terminal limpia", "dim");   /* feedback mínimo, como una shell */
});

reg("history", "Muestra el historial de comandos", "history", () => {
  if (!FSYS.history.length) { Term.printOut("(vacío)", "dim"); return; }
  FSYS.history.forEach((h, i) => Term.printOut(`  ${String(i + 1).padStart(3)}  ${h}`, "out"));
});

/* hist <texto>: grep del historial — la memoria de la shell. */
reg("hist", "Busca en el historial", "hist <texto>", (args) => {
  const q = args.join(" ").toLowerCase();
  if (!q) { Term.printErr("uso: hist <texto>"); return; }
  if (!FSYS.history.length) { Term.printOut("(historial vacío)", "dim"); return; }
  const hits = FSYS.history.filter((h) => h.toLowerCase().includes(q));
  if (!hits.length) { Term.printOut(`sin coincidencias para '${q}'`, "dim"); return; }
  Term.printOut(`HISTORIAL // ${hits.length} coincidencia(s)`, "ok");
  hits.forEach((h) => Term.printOut(`  ${h}`, "out"));
});

/* ============ CONFIG (tema y acento, persistente) ============
   Paletas propias del sistema — superficies planas, acento único. */
const THEMES = {
  green: { label: "TERMINAL VERDE",  accent: "#63ff9b", border: "#1f633b" },
  amber: { label: "AMBER RETRO",     accent: "#ffb454", border: "#6b4a1f" },
  cyan:  { label: "CYAN Y2K",        accent: "#5fe8ff", border: "#1f5a63" },
  red:   { label: "ALERTA ROJA",     accent: "#ff6b6b", border: "#6b2530" },
};

function applyTheme(name) {
  const t = THEMES[name];
  if (!t) return false;
  const root = document.documentElement;
  root.style.setProperty("--accent", t.accent);
  root.style.setProperty("--border", t.border);
  return true;
}

reg("config", "Personalización: paleta, prompt, boot, STUDIO", "config [accent <tema|hex> | studio <clave> <valor> | wall ... | user/host/boot ...]", (args) => {
  const sub = (args[0] || "").toLowerCase();
  if (!sub) {
    Term.printOut("CONFIG // PERSONALIZACIÓN", "ok");
    const t = FSYS.config.studio || {};
    Term.printOut(`  accent   ${FSYS.config.accent}${THEMES[FSYS.config.accent] ? "  (" + THEMES[FSYS.config.accent].label + ")" : "  (paleta tuya/gen)"}`, "out");
    Term.printOut(`  prompt   ${FSYS.settings.user}@${FSYS.settings.host}:~$`, "out");
    Term.printOut(`  boot     ${FSYS.config.bootMode || "auto"}  (auto = secuencia solo tras >4h)`, "out");
    Term.printOut(`  aiModel  ${FSYS.config.aiModel || "(auto: primero de 'ai models')"}`, "out");
    Term.printOut(`  studio   font:${t.font || "system"} · radius:${t.radius || 0} · scan:${t.scan ? "on" : "off"} · grid:${t.grid ? "on" : "off"}`, "out");
    Term.printOut(`  wall     ${FSYS.config.wall ? "on" : "off"} · blur term:${FSYS.config.blurTerm || 0} · widgets:${FSYS.config.blurWidget || 0}`, "out");
    Term.printOut("cambiar:  config accent <tema|#hex> · config studio font <nombre> · theme gen <hex> · wall set", "dim");
    return;
  }
  if (sub === "accent") {
    const name = (args[1] || "").toLowerCase();
    if (!name) { Term.printErr("uso: config accent <tema> — 'theme' lista todos"); return; }
    if (STUDIO.isHex(name)) { reg("theme").run(["gen", name]); return; }
    const userThemes = FSYS.config.userThemes || {};
    if (!THEMES[name] && !userThemes[name]) {
      Term.printErr(`paleta desconocida: ${name} — disponibles: ${[...Object.keys(THEMES), ...Object.keys(userThemes)].join(" · ")} — o un hex directo`);
      return;
    }
    if (THEMES[name]) { if (!applyTheme(name)) { Term.printErr("no se pudo aplicar"); return; } }
    else STUDIO.gen(userThemes[name]);
    FSYS.config.accent = name;
    saveStore(STORE_KEYS.cfg, FSYS.config);
    Term.printOut(`accent → ${name}${THEMES[name] ? " (" + THEMES[name].label + ")" : " (tuya)"}  · persiste entre sesiones`, "ok");
    return;
  }
  /* STUDIO (v0.17): tokens de apariencia — todo validado, nada de CSS libre */
  if (sub === "studio") {
    const k = (args[1] || "").toLowerCase();
    const v = (args[2] || "").toLowerCase();
    const t = FSYS.config.studio || (FSYS.config.studio = {});
    if (!k) { Term.printErr("uso: config studio <font|radius|scan|grid> <valor>"); return; }
    if (k === "font") {
      if (v && !STUDIO.FONTS[v]) { Term.printErr(`fuente desconocida: ${v} — disponibles: ${Object.keys(STUDIO.FONTS).join(" · ")}`); return; }
      t.font = v || null;
      STUDIO.save();
      Term.printOut(`fuente → ${v || "system (Cascadia)"}`, "ok");
      return;
    }
    if (k === "radius") {
      const n = parseInt(v, 10);
      if (isNaN(n) || n < 0 || n > 16) { Term.printErr("uso: config studio radius <0-16>   (0 = flat CachyOS)"); return; }
      t.radius = n;
      STUDIO.save();
      Term.printOut(`radius → ${n}px`, "ok");
      return;
    }
    if (k === "scan" || k === "grid") {
      t[k] = v !== "off";
      STUDIO.save();
      Term.printOut(`${k} → ${t[k] ? "on" : "off"}${k === "grid" && !FSYS.config.wall ? "  (necesita wallpaper: 'wall set')" : ""}`, "ok");
      return;
    }
    Term.printErr(`clave studio desconocida: ${k} — font · radius · scan · grid`);
    return;
  }
  /* wallpaper y blurs: comandos dedicados 'wall' y 'blur' */
  if (sub === "wall") { reg("wall").run(args.slice(1)); return; }
  if (sub === "blur") { reg("blur").run(args.slice(1)); return; }
  if (sub === "perf") { reg("perf").run(args.slice(1)); return; }
  /* watchdog: umbral de aviso (50-99%) */
  if (sub === "watchdog") {
    const n = parseInt(args[1], 10);
    if (!n || n < 50 || n > 99) { Term.printErr("uso: config watchdog <50-99>   (default 90)"); return; }
    FSYS.config.watchdogMax = n;
    saveStore(STORE_KEYS.cfg, FSYS.config);
    Term.printOut(`watchdog → avisa a los ${n}%`, "ok");
    return;
  }
  /* user/host: prompt personalizado (spec §26), en vivo y persistente */
  if (sub === "user" || sub === "host") {
    const v = args[1];
    if (!v || !/^[\w-]{1,16}$/.test(v)) {
      Term.printErr(`uso: config ${sub} <nombre>  (letras/números/_/- , máx 16)`);
      return;
    }
    FSYS.config[sub] = v;
    FSYS.settings[sub] = v;
    saveStore(STORE_KEYS.cfg, FSYS.config);
    updatePrompt();
    Term.printOut(`prompt → ${FSYS.settings.user}@${FSYS.settings.host}:~$`, "ok");
    return;
  }
  /* boot: secuencia de arranque (spec §22) */
  if (sub === "boot") {
    const v = (args[1] || "").toLowerCase();
    if (!["auto", "on", "off"].includes(v)) {
      Term.printErr("uso: config boot <auto|on|off>   (auto = solo si pasaron >4h)");
      return;
    }
    FSYS.config.bootMode = v;
    saveStore(STORE_KEYS.cfg, FSYS.config);
    Term.printOut(`boot → ${v}${v === "auto" ? "  (secuencia solo si pasaron >4h)" : ""}`, "ok");
    return;
  }
  Term.printErr(`subcomando desconocido: ${sub}`);
});

/* Tema guardado se aplica AL INSTANTE (antes del boot) */
applyTheme(FSYS.config.accent);

/* ============ STUDIO (v0.17): el escritorio como lienzo ============
   Motor de tokens: TODO lo visual son CSS variables persistidas.
   Los valores se VALIDAN — la config jamás inyecta CSS arbitrario. */
const STUDIO = {
  FONTS: {
    system: null,                                                     // la de core.css
    cascadia: '"Cascadia Mono", Consolas, monospace',
    jetbrains: '"JetBrains Mono", "Fira Code", monospace',
    firacode: '"Fira Code", monospace',
    iosevka: '"Iosevka", "Fira Code", Consolas, monospace',
    monaco: "Monaco, Menlo, monospace",
    gohufont: '"GohuFont", "Unifont", monospace',
    terminus: '"Terminus TTF", "Unifont", monospace',
  },
  /* Token whitelists: validación estricta — nada de CSS por inyección */
  isHex: (s) => /^#[0-9a-f]{6}$/i.test(s),
  clamp: (v, a, b) => Math.max(a, Math.min(b, v)),

  /* hex → {h, s, l} (HSL 0-360 / 0-100 / 0-100) */
  hexToHsl(hex) {
    const n = parseInt(hex.slice(1), 16);
    const r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const l = (max + min) / 2;
    if (max === min) return { h: 0, s: 0, l: l * 100 };
    const d = max - min;
    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    let h;
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0));
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    return { h: h * 60, s: s * 100, l: l * 100 };
  },
  hsl(h, s, l) { return `hsl(${Math.round(h)} ${Math.round(s)}% ${Math.round(l)}%)`; },

  /* UN color genera la paleta COMPLETA (coherencia por construcción) */
  gen(accentHex) {
    const { h, s, l } = this.hexToHsl(accentHex);
    const r = document.documentElement.style;
    r.setProperty("--accent", accentHex);
    r.setProperty("--border", this.hsl(h, Math.min(s, 60), Math.max(16, l - 28)));
    r.setProperty("--accent-dim", this.hsl(h, Math.min(s, 70), Math.max(30, l - 20)));
    r.setProperty("--line", this.hsl(h, Math.min(s, 45), 10));
    r.setProperty("--surface", this.hsl(h, Math.min(s, 30), 5));
    r.setProperty("--raised", this.hsl(h, Math.min(s, 32), 7));
    r.setProperty("--dim", this.hsl(h, Math.min(s, 28), 38));
    r.setProperty("--dimmer", this.hsl(h, Math.min(s, 22), 24));
    r.setProperty("--text", this.hsl(h, Math.min(s, 40), 83));
  },

  applyTokens() {
    const root = document.documentElement;
    const t = FSYS.config.studio || {};
    const f = this.FONTS[t.font];
    root.style.setProperty("--mono", f || '"Cascadia Mono", "JetBrains Mono", "Fira Code", Consolas, "Courier New", monospace');
    root.style.setProperty("--radius", (t.radius | 0) + "px");
    document.body.classList.toggle("scanlines", !!t.scan);
    const gridOn = !!(t.grid && FSYS.config.wall && FSYS.config.wall.data);
    document.body.classList.toggle("wall-grid", gridOn);
    /* Blur por superficie: atributo + variable — el CSS hace el color-mix */
    const term = document.getElementById("terminal");
    if (term) {
      if (FSYS.config.blurTerm > 0) { term.dataset.blur = "1"; term.style.setProperty("--blur-amt", FSYS.config.blurTerm + "px"); }
      else { delete term.dataset.blur; term.style.removeProperty("--blur-amt"); }
    }
    const pane = document.getElementById("pane");
    if (pane) {
      if (FSYS.config.blurTerm > 0) { pane.dataset.blur = "1"; pane.style.setProperty("--blur-amt", FSYS.config.blurTerm + "px"); }
      else { delete pane.dataset.blur; pane.style.removeProperty("--blur-amt"); }
    }
  },

  /* 'theme' y 'wall' y 'perf low' terminan aquí para persistir y repintar */
  save() { saveStore(STORE_KEYS.cfg, FSYS.config); this.applyTokens(); },

  /* Kill switch (spec §23): flat CachyOS en un comando */
  perfLow() {
    FSYS.config.wall = null;
    FSYS.config.blurTerm = 0;
    FSYS.config.blurWidget = 0;
    const t = FSYS.config.studio;
    if (t) { t.scan = false; t.grid = false; }
    Wall.apply();
    this.save();
    Term.printOut("PERF LOW — wallpaper, blurs, scanlines y grid desactivados\nel resto (paleta, fuente, radius) queda como esté", "ok");
  },
};

/* ==== THEME: paletas extendidas + generadas + propias (STUDIO) ==== */
reg("theme", "Paletas: fijas, generadas de UN color o propias", "theme [gen <hex> | make <n> <hex> | list | rm <n>]  · config accent <tema>", (args) => {
  const sub = (args[0] || "").toLowerCase();
  const userThemes = FSYS.config.userThemes || (FSYS.config.userThemes = {});
  const applyNamed = (name) => {
    if (THEMES[name]) { applyTheme(name); return THEMES[name].label; }
    const u = userThemes[name];
    if (u) { STUDIO.gen(u); return u + " (tuyo)"; }
    return null;
  };
  if (!sub) {
    Term.printOut("THEMES // PALETAS", "ok");
    for (const [k, t] of Object.entries(THEMES)) Term.printOut(`  ${k.padEnd(12)} ${t.label}`, "out");
    for (const [k, v] of Object.entries(userThemes)) Term.printOut(`  ${k.padEnd(12)} ${v} (tuyo — theme rm ${k})`, "out");
    Term.printOut(`activo: ${FSYS.config.accent}`, "dim");
    Term.printOut("nuevo: theme gen #5fe8ff genera la paleta COMPLETA de un color", "dim");
    return;
  }
  if (sub === "gen") {
    const hex = (args[1] || "").toLowerCase();
    if (!STUDIO.isHex(hex)) { Term.printErr("uso: theme gen #5fe8ff   (hex de 6 dígitos)"); return; }
    STUDIO.gen(hex);
    FSYS.config.accent = hex; STUDIO.save();
    Term.printOut(`paleta generada de ${hex} — bg, líneas, dim y texto derivan del mismo tono`, "ok");
    return;
  }
  if (sub === "make") {
    const name = (args[1] || "").toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 16);
    const hex = (args[2] || "").toLowerCase();
    if (!name || !STUDIO.isHex(hex)) { Term.printErr("uso: theme make miami #ff2e88"); return; }
    userThemes[name] = hex; STUDIO.gen(hex);
    FSYS.config.accent = name; STUDIO.save();
    Term.printOut(`paleta '${name}' guardada — config accent ${name} para volver`, "ok");
    return;
  }
  if (sub === "list") { reg("theme").run([]); return; }
  if (sub === "rm") {
    const n = (args[1] || "").toLowerCase();
    if (!userThemes[n]) { Term.printErr(`no existe la paleta tuya: ${n || "(vacío)"}`); return; }
    delete userThemes[n]; STUDIO.save();
    Term.printOut(`paleta eliminada: ${n}`, "ok");
    return;
  }
  const lbl = applyNamed(sub);
  if (!lbl) { Term.printErr(`paleta desconocida: ${sub} — 'theme' lista`); return; }
  FSYS.config.accent = sub; STUDIO.save();
  Term.printOut(`accent → ${lbl}`, "ok");
});

/* WMO/CRYPTO: helpers compartidos por comando y widgets v2 (se definen
   junto a su comando; los widgets solo los consumen en runtime). */
const CRYPTO_IDS = { btc: "bitcoin", eth: "ethereum", sol: "solana", doge: "dogecoin" };
const CRYPTO_SYM = { bitcoin: "$", ethereum: "Ξ", solana: "S", dogecoin: "Ð" };

/* calc: evaluador matemático puro — 0 eval, 0 Function.
   Shunting-yard: números, + - * / % ^, paréntesis, funciones
   seguras y constantes. Cualquier otra cosa → rechazo. */
const Calc = {
  FUNCS: {
    sqrt: Math.sqrt, sin: Math.sin, cos: Math.cos, tan: Math.tan,
    abs: Math.abs, log: Math.log, log10: Math.log10, round: Math.round,
    floor: Math.floor, ceil: Math.ceil,
  },
  CONSTS: { pi: Math.PI, e: Math.E },

  tokenize(src) {
    const toks = [];
    let i = 0;
    while (i < src.length) {
      const ch = src[i];
      if (/\s/.test(ch)) { i++; continue; }
      if (/[0-9.]/.test(ch)) {
        let j = i;
        while (j < src.length && /[0-9.]/.test(src[j])) j++;
        const n = parseFloat(src.slice(i, j));
        if (Number.isNaN(n)) throw new Error(`número inválido en '${src.slice(i, j)}'`);
        toks.push({ t: "num", v: n });
        i = j;
        continue;
      }
      if (/[a-z]/i.test(ch)) {
        let j = i;
        while (j < src.length && /[a-z0-9]/i.test(src[j])) j++;
        const w = src.slice(i, j).toLowerCase();
        if (w in this.FUNCS) toks.push({ t: "fn", v: w });
        else if (w in this.CONSTS) toks.push({ t: "num", v: this.CONSTS[w] });
        else throw new Error(`símbolo desconocido: '${w}'`);
        i = j;
        continue;
      }
      if ("+-*/%^()".includes(ch)) {
        /* - unario: inicio, tras operador o tras ( */
        if (ch === "-" && (toks.length === 0 || ["op", "lp"].includes(toks[toks.length - 1].t) || toks[toks.length - 1].t === "fn")) {
          toks.push({ t: "op", v: "u-" });
        } else if (ch === "(") toks.push({ t: "lp", v: ch });
        else if (ch === ")") toks.push({ t: "rp", v: ch });
        else toks.push({ t: "op", v: ch });
        i++;
        continue;
      }
      throw new Error(`carácter no permitido: '${ch}'`);
    }
    return toks;
  },

  PREC: { "u-": 4, "^": 3, "*": 2, "/": 2, "%": 2, "+": 1, "-": 1 },
  RIGHT: { "^": true },

  eval(toks) {
    const out = [], ops = [];
    for (const tk of toks) {
      if (tk.t === "num") out.push(tk.v);
      else if (tk.t === "fn") ops.push(tk);
      else if (tk.t === "op") {
        while (ops.length) {
          const top = ops[ops.length - 1];
          if (top.t !== "op") break;
          const p1 = this.PREC[tk.v], p2 = this.PREC[top.v];
          if (p2 > p1 || (p2 === p1 && !this.RIGHT[tk.v])) out.push(this.popOp(ops));
          else break;
        }
        ops.push(tk);
      } else if (tk.t === "lp") ops.push(tk);
      else if (tk.t === "rp") {
        while (ops.length && ops[ops.length - 1].t !== "lp") out.push(this.popOp(ops));
        if (!ops.length) throw new Error("paréntesis desbalanceados");
        ops.pop();
        if (ops.length && ops[ops.length - 1].t === "fn") out.push(this.popOp(ops));
      }
    }
    while (ops.length) {
      const top = ops.pop();
      if (top.t === "lp") throw new Error("paréntesis desbalanceados");
      out.push(this.popOp([top]));
    }
    const st = [];
    for (const v of out) {
      if (typeof v === "number") st.push(v);
      else if (v === "u-") { const a = st.pop(); st.push(-a); }
      else if (v === "+") { const b = st.pop(), a = st.pop(); st.push(a + b); }
      else if (v === "-") { const b = st.pop(), a = st.pop(); st.push(a - b); }
      else if (v === "*") { const b = st.pop(), a = st.pop(); st.push(a * b); }
      else if (v === "/") { const b = st.pop(), a = st.pop(); st.push(a / b); }
      else if (v === "%") { const b = st.pop(), a = st.pop(); st.push(a % b); }
      else if (v === "^") { const b = st.pop(), a = st.pop(); st.push(Math.pow(a, b)); }
      else if (typeof v === "string") { const a = st.pop(); st.push(Calc.FUNCS[v](a)); }
    }
    if (st.length !== 1 || typeof st[0] !== "number") throw new Error("expresión inválida");
    return st[0];
  },

  popOp(ops) {
    const op = ops.pop();
    if (op.t === "op") return op.v;
    if (op.t === "fn") return op.v;   /* la aplicación ocurre en el stack final */
    throw new Error("operador inesperado");
  },
};

reg("calc", "Calculadora: + - * / % ^, sqrt sin cos log…", "calc <expresión>", (args) => {
  const src = args.join("");
  if (!src) { Term.printErr("uso: calc <expresión>   ej: calc (2+3)*sqrt(16)"); return; }
  try {
    const r = Calc.eval(Calc.tokenize(src));
    if (!Number.isFinite(r)) throw new Error("resultado no finito");
    const pretty = Number.isInteger(r) ? String(r) : String(parseFloat(r.toFixed(10)));
    Term.printOut(`= ${pretty}`, "ok");
  } catch (e) {
    Term.printErr(`calc: ${e.message}`);
  }
});

/* note/notes: bloc de notas del sistema sobre el workspace del bridge. */
reg("note", "Guarda una nota", "note <texto>", (args) => {
  const text = args.join(" ").trim();
  if (!text) { Term.printErr("uso: note <texto>   ('notes' lista las tuyas)"); return; }
  (async () => {
    const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");
    const line = `[${stamp}] ${text}`;
    /* Fuente de verdad local (lectura instantánea, sin dependencias) */
    const notes = JSON.parse(localStorage.getItem("fsys.notes") || "[]");
    notes.unshift(line);
    localStorage.setItem("fsys.notes", JSON.stringify(notes.slice(0, 100)));
    /* Espejo en disco real si hay bridge: append a notas.txt */
    if (Bridge.available) {
      const prev = await Bridge.call("files.read", { name: "notas.txt" }, 5000).catch(() => null);
      const old = prev && prev.ok ? prev.text : "";
      const res = await Bridge.call("files.write", { name: "notas.txt", text: old + `${line}\n` }, 5000).catch(() => null);
      if (res && res.ok) { Term.printOut(`nota guardada → notas.txt (workspace del sistema): "${text}"`, "ok"); return; }
    }
    Term.printOut(`nota guardada (local): "${text}"`, "ok");
  })();
});

/* Las notas viven en localStorage (lectura instantánea) y, con bridge,
   se APENDAN también a notas.txt del workspace (archivo real en tu disco).
   El espejo en disco es cortesía; la fuente de verdad es local. */
reg("notes", "Lista tus notas", "notes [filtro]", (args) => {
  const filter = args.join(" ").toLowerCase();
  /* Tolerante al formato viejo {t}: migra a strings plano */
  const raw = JSON.parse(localStorage.getItem("fsys.notes") || "[]");
  const notes = raw.map((n) => (typeof n === "string" ? n : String(n.t || ""))).filter(Boolean);
  const shown = filter ? notes.filter((l) => l.toLowerCase().includes(filter)) : notes;
  if (!shown.length) { Term.printOut(filter ? `sin notas con '${filter}'` : "(sin notas — 'note <texto>' crea la primera)", "dim"); return; }
  Term.printOut(`NOTAS // ${shown.length}`, "ok");
  shown.forEach((n, i) => Term.printOut(` ${String(i + 1).padStart(3)}  ${n}`, "out"));
  if (Bridge.available) Term.printOut("(también en fsys-bridge/data/workspace/notas.txt)", "dim");
});

/* ---- Reloj analógico ASCII en tiempo real (comando date) ----
   Widget vivo: un interval de 1s redibuja el reloj mientras está
   activo; el próximo comando lo congela (performance budget). */
const LiveClock = {
  timer: null,
  el: null,

  /* Dibuja el reloj para una hora dada. Grid 31×15 (ratio 2:1 de
     terminal: rx = 2*ry). Manecillas escaladas en Y por 0.5. */
  render(d) {
    const hh = d.getHours(), mm = d.getMinutes(), ss = d.getSeconds();
    const hA = ((hh % 12) + mm / 60) * 30;   // 30° por hora
    const mA = mm * 6 + ss * 0.1;            // 6° por minuto + avance suave
    const sA = ss * 6;

    const grid = Array.from({ length: 15 }, () => Array(31).fill(" "));
    const plot = (x, y, ch = "█") => {
      const xi = Math.round(x), yi = Math.round(y);
      if (xi >= 0 && xi < 31 && yi >= 0 && yi < 15) grid[yi][xi] = ch;
    };

    // círculo
    const cx = 15, cy = 7, rx = 14, ry = 7;
    for (let a = 0; a < 360; a += 3) {
      const rad = (a * Math.PI) / 180;
      plot(cx + rx * Math.cos(rad), cy + ry * Math.sin(rad), "·");
    }
    // marcas 12/3/6/9 (un solo carácter para no romper el ancho)
    grid[0][cx] = "╫";   grid[14][cx] = "╪";
    grid[cy][30] = "╡";  grid[cy][0] = "╞";
    // manecillas (eje Y del grid ya está en proporción 2:1 → *0.5)
    const hand = (ang, len, ch) => {
      const rad = ((ang - 90) * Math.PI) / 180;
      for (let r = 1; r <= len; r++) {
        plot(cx + Math.cos(rad) * r, cy + Math.sin(rad) * r * 0.5, ch);
      }
    };
    hand(hA, 4.5, "█");
    hand(mA, 6.5, "▓");
    hand(sA, 6.8, "░");
    plot(cx, cy, "+");

    const pad = (n) => String(n).padStart(2, "0");
    const DIAS = ["DOM", "LUN", "MAR", "MIÉ", "JUE", "VIE", "SÁB"];
    const MESES = ["ENE", "FEB", "MAR", "ABR", "MAY", "JUN", "JUL", "AGO", "SEP", "OCT", "NOV", "DIC"];
    const fecha = `${DIAS[d.getDay()]} ${pad(d.getDate())} ${MESES[d.getMonth()]} ${d.getFullYear()}`;
    const hora = `${pad(hh)}:${pad(mm)}:${pad(ss)}`;

    return { clock: grid.map((row) => row.join("")), fecha, hora };
  },

  start() {
    this.stop();
    this.el = document.createElement("div");
    this.el.className = "live-clock";
    Term.out.appendChild(this.el);
    const draw = () => {
      if (!this.el || !this.el.isConnected) { this.stop(); return; }
      const { clock, fecha, hora } = this.render(new Date());
      this.el.textContent = clock.join("\n") + `\n     ${fecha}  ·  ${hora}`;
      /* Autoscroll solo si el usuario está al fondo: no yankear el
         scroll mientras lee el historial. */
      const o = Term.out;
      if (o.scrollHeight - o.scrollTop - o.clientHeight < 40) {
        o.scrollTop = o.scrollHeight;
      }
    };
    draw();
    this.timer = setInterval(draw, 1000);
    /* Si la tab muere (nueva carga, cierre), matar el interval YA.
       Sin esto, Floorp acumula intervals de tabs descargadas. */
    if (!window.__fsysUnloadBound) {
      window.addEventListener("beforeunload", () => LiveClock.stop());
      window.__fsysUnloadBound = true;
    }
  },

  /* Congela el reloj: deja de consumir CPU y queda como historial. */
  stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (this.el) { this.el.classList.add("frozen"); this.el = null; }
  },
};

reg("date", "Reloj analógico en tiempo real", "date", () => LiveClock.start());

/* ---- timer <minutos> [nombre]: cuenta regresiva VIVA en la terminal,
   con notificación del SO al terminar (si hay bridge). Congelable como
   el reloj: el próximo comando lo detiene. ---- */
const LiveTimer = {
  timer: null,
  el: null,

  fmt(ms) {
    const s = Math.max(0, Math.ceil(ms / 1000));
    return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
  },

  bar(msLeft, total) {
    const pct = total > 0 ? msLeft / total : 0;
    const w = 28, f = Math.round(pct * w);
    return "█".repeat(f) + "░".repeat(w - f);
  },

  start(minutes, label) {
    this.stop();
    const total = minutes * 60000;
    const end = Date.now() + total;
    this.el = document.createElement("div");
    this.el.className = "live-clock";
    Term.out.appendChild(this.el);
    const draw = () => {
      if (!this.el || !this.el.isConnected) { this.stop(); return; }
      const left = end - Date.now();
      if (left <= 0) {
        const name = label ? ` (${label})` : "";
        this.el.textContent = `TIMER${name} → ¡TIEMPO!`;
        this.el.classList.add("frozen");
        this.timer = null; this.el = null;
        if (Bridge.available) {
          Bridge.call("sys.notify", { title: "FLOORP SYSTEM", text: `Timer${name} terminado` }, 5000).catch(() => {});
        }
        return;
      }
      const name = label ? ` ${label}` : "";
      this.el.textContent = `TIMER${name}\n  ${this.fmt(left)}  ${this.bar(left, total)}`;
      const o = Term.out;
      if (o.scrollHeight - o.scrollTop - o.clientHeight < 40) o.scrollTop = o.scrollHeight;
    };
    draw();
    this.timer = setInterval(draw, 500);
    Term.printOut(`timer de ${minutes} min${label ? ` — ${label}` : ""} iniciado (se congela con tu próximo comando)`, "dim");
  },

  stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (this.el) { this.el.classList.add("frozen"); this.el = null; }
  },
};

reg("timer", "Cuenta regresiva con aviso", "timer <minutos> [nombre]", (args) => {
  const m = parseFloat(args[0]);
  if (!m || m <= 0 || m > 600) { Term.printErr("uso: timer <minutos> [nombre]   ej: timer 25 pomodoro"); return; }
  LiveTimer.start(m, args.slice(1).join(" ") || null);
});

/* ---- top: monitor de CPU/RAM en vivo (3s de refresco, congelable). ---- */
const TopMonitor = {
  timer: null,
  el: null,

  start() {
    if (!Bridge.available) { AppsSys.needBridge(); return; }
    this.stop();
    this.el = document.createElement("div");
    this.el.className = "live-clock";
    Term.out.appendChild(this.el);
    let busy = false;
    const draw = async () => {
      if (!this.el || !this.el.isConnected) { this.stop(); return; }
      if (busy) return;   /* nunca pisar mediciones: la CPU no se estresa */
      busy = true;
      try {
        const res = await Bridge.call("sys.metrics", {}, 5000).catch(() => null);
        if (!this.el || !this.el.isConnected) return;
        if (res && res.ok) {
          const c = res.data.cpu || {}, m = res.data.mem || {};
          const bar = (p, w = 20) => "█".repeat(Math.round((p / 100) * w)) + "░".repeat(w - Math.round((p / 100) * w));
          this.el.textContent = `TOP // EN VIVO\n  CPU ${bar(c.percent ?? 0)} ${c.percent ?? "?"}%\n  RAM ${bar(m.percent ?? 0)} ${m.percent ?? "?"}%  (${m.used_mb ?? "?"}/${m.total_mb ?? "?"} MB)\n  (se congela con tu próximo comando)`;
        } else {
          this.el.textContent = "TOP // bridge sin respuesta";
        }
      } finally {
        busy = false;
      }
    };
    draw();
    this.timer = setInterval(draw, 3000);
  },

  stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (this.el) { this.el.classList.add("frozen"); this.el = null; }
  },
};

reg("top", "CPU y RAM en vivo", "top", () => TopMonitor.start());

/* ---- matrix: lluvia digital (estética del sistema, no screensaver
   idiota: es compacta, congelable y con los colores del tema). ---- */
const MatrixRain = {
  timer: null,
  el: null,
  ROWS: 14, COLS: 62, CHARS: "アイウエオカキクケコサシスセソ01",

  start() {
    this.stop();
    const cols = Math.max(20, Math.min(this.COLS, Math.floor(Term.out.clientWidth / 8) || this.COLS));
    /* Buffer persistente con TRAIL: cada tick escribe solo la cabeza de
       cada gota y borra su cola (~28 operaciones vs ~870 randoms).
       Misma lluvia, una fracción de la CPU (spec §23). */
    const grid = Array.from({ length: this.ROWS }, () => Array(cols).fill(" "));
    const rnd = () => this.CHARS[Math.floor(Math.random() * this.CHARS.length)];
    const drops = Array.from({ length: this.ROWS }, () => Math.floor(Math.random() * cols));
    const TRAIL = 6;
    this.el = document.createElement("div");
    this.el.className = "live-clock";
    Term.out.appendChild(this.el);
    const draw = () => {
      if (!this.el || !this.el.isConnected) { this.stop(); return; }
      for (let r = 0; r < this.ROWS; r++) {
        const d = drops[r];
        grid[r][d] = rnd();                       /* cabeza */
        grid[r][(d - TRAIL + cols) % cols] = " "; /* cola */
        drops[r] = (d + 1 + Math.floor(Math.random() * 2)) % cols;
      }
      this.el.textContent = grid.map((row) => row.join("")).join("\n");
      const o = Term.out;
      if (o.scrollHeight - o.scrollTop - o.clientHeight < 40) o.scrollTop = o.scrollHeight;
    };
    draw();
    this.timer = setInterval(draw, 200);
  },

  stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (this.el) { this.el.classList.add("frozen"); this.el = null; }
  },
};

reg("matrix", "Lluvia digital (estética del sistema)", "matrix", () => MatrixRain.start());

reg("echo", "Imprime texto", "echo <texto>", (args) => Term.printOut(args.join(" ") || "", "out"));

/* ---- WEB ---- */
function searchEngineCmd(name, description, urlTemplate) {
  reg(name, description, `${name} <query>`, (args) => {
    const q = args.join(" ");
    if (!q) { Term.printErr(`uso: ${name} <query>`); return; }
    const url = urlTemplate.replace("%s", encodeURIComponent(q));
    Term.printOut(`abriendo ${url}`, "dim");
    window.open(url, "_blank");
  });
}
searchEngineCmd("google", "Buscar en Google", "https://www.google.com/search?q=%s");
searchEngineCmd("yt", "Buscar en YouTube", "https://www.youtube.com/results?search_query=%s");
searchEngineCmd("gh", "Buscar en GitHub", "https://github.com/search?q=%s");
searchEngineCmd("wiki", "Buscar en Wikipedia", "https://es.wikipedia.org/w/index.php?search=%s");

reg("open", "Abrir una URL", "open <url>", (args) => {
  let url = args[0];
  if (!url) { Term.printErr("uso: open <url>"); return; }
  if (!/^https?:\/\//.test(url)) url = "https://" + url;
  Term.printOut(`abriendo ${url}`, "dim");
  window.open(url, "_blank");
});

/* ---- WORKSPACE ENGINE (nativo de Floorp vía OS Server, fallback sesiones) ---- */
reg("workspace", "Cambiar de workspace", "workspace <n|nombre>", (args) => {
  const target = (args[0] || "").toLowerCase();
  if (!target) { Term.printErr("uso: workspace <n|nombre>"); return; }
  let id = -1;
  if (/^\d+$/.test(target)) {
    const n = parseInt(target, 10);
    if (n >= 1 && n <= FSYS.workspaces.length) id = n;
  } else {
    const idx = FSYS.workspaces.findIndex((w) => w.name.toLowerCase().startsWith(target));
    if (idx !== -1) id = FSYS.workspaces[idx].id ?? (idx + 1);
  }
  if (id === -1) { Term.printErr(`workspace no encontrado: ${target}`); return; }
  Workspaces.switchTo(id);
});

reg("ws", "Workspaces REALES de Floorp (list/next/prev/enable/doctor/create/close...)", "ws <list|next|prev|enable|doctor|create <nombre>|close <n>|add <n> <url>|save|rename <n> <nombre>>", (args) => {
  const sub = (args[0] || "list").toLowerCase();
  if (!Bridge.available) {
    Term.printErr("ws requiere la extensión FLOORP SYSTEM (about:debugging)");
    return;
  }
  (async () => {
    if (sub === "enable") {
      /* Setup guiado del OS Server real de Floorp — punto único de verdad */
      const res = await Bridge.call("ws.enableInfo");
      if (!res || !res.ok) { Term.printErr((res && res.error) || "sin respuesta"); return; }
      const d = res.data;
      Term.printOut("ACTIVAR LOS WORKSPACES REALES DE FLOORP", "ok");
      if (d.bridgeOn) Term.printOut("[ok] fsys-bridge corriendo", "out");
      else Term.printOut("[!!] fsys-bridge offline — ejecutá fsys-bridge/start-bridge.bat", "err");
      if (d.osServer) { Term.printOut("[ok] OS Server de Floorp ya responde", "ok"); return; }
      Term.printOut("", "out");
      for (const s of d.steps) Term.printOut(s, "out");
      Term.printOut("", "out");
      Term.printOut("esto conecta la terminal con los MISMOS workspaces de la barra de Floorp", "dim");
      return;
    }
    if (sub === "doctor") {
      const res = await Bridge.call("ws.doctor");
      if (!res || !res.ok) { Term.printErr((res && res.error) || "sin respuesta"); return; }
      const d = res.data;
      Term.printOut("DIAGNÓSTICO DE LA CADENA", "ok");
      Term.printOut(`  extensión ....... CONECTADA`, "ok");
      Term.printOut(`  fsys-bridge ..... ${d.bridge ? "ONLINE" : "offline"}`, d.bridge ? "ok" : "err");
      Term.printOut(`  OS Server ....... ${d.osServer ? "ONLINE (" + d.workspaces + " workspaces)" : "offline"}`, d.osServer ? "ok" : "err");
      if (d.osServer && d.names) Term.printOut(`  workspaces ...... ${d.names.join(" · ")}`, "out");
      if (d.reason) Term.printOut(`  → ${d.reason}`, "dim");
      Term.printOut(d.osServer ? "modo NATIVO: cambias los workspaces de verdad" : "sin NATIVO: 'ws enable' muestra cómo activarlo", "dim");
      return;
    }
    if (sub === "next" || sub === "prev") {
      const res = await Bridge.call("ws.step", { dir: sub === "next" ? 1 : -1 });
      if (!res || !res.ok) { Term.printErr((res && res.error) || "sin respuesta"); return; }
      const d = res.data;
      await Workspaces.syncFromBridge().catch(() => {});
      Workspaces.renderBar();
      Term.printOut(
        d.mode === "NATIVE" ? `WORKSPACE NATIVO // ${String(d.index).padStart(2, "0")} ${d.name}` : `WORKSPACE // ${d.name}`,
        "ok"
      );
      return;
    }
    if (sub === "add") {
      /* ws add <n> <url> (sesión guardada) | ws add here (tab actual → sesión) */
      if ((args[1] || "").toLowerCase() === "here") {
        const res = await Bridge.call("tab.list");
        if (!res || !res.ok || !res.data.length) { Term.printErr("sin tabs para agregar"); return; }
        const cur = res.data.find((t) => t.active) || res.data[0];
        const add = await Bridge.call("ws.addTab", { id: Workspaces.activeId, url: cur.url });
        if (!add || !add.ok) { Term.printErr((add && add.error) || "sin respuesta"); return; }
        Term.printOut(add.data.dup ? `ya estaba en la sesión del workspace ${Workspaces.activeId}`
                                   : `tab actual → sesión del workspace ${Workspaces.activeId} (${add.data.total} tabs)`, "ok");
        return;
      }
      const id = parseInt(args[1], 10);
      let url = args[2];
      if (!id || !url) { Term.printErr("uso: ws add <n> <url>   |   ws add here"); return; }
      if (!/^https?:\/\//.test(url)) url = "https://" + url;
      const res = await Bridge.call("ws.add", { id, url });
      if (!res || !res.ok) { Term.printErr((res && res.error) || "sin respuesta"); return; }
      Term.printOut(`agregada a workspace ${id} (total: ${res.data.total})`, "ok");
      return;
    }
    if (sub === "save") {
      const id = parseInt(args[1], 10) || Workspaces.activeId;
      const res = await Bridge.call("ws.save", { id });
      if (!res || !res.ok) { Term.printErr((res && res.error) || "sin respuesta"); return; }
      Term.printOut(`sesión guardada en workspace ${id}: ${res.data.saved} tabs`, "ok");
      return;
    }
    if (sub === "create" || sub === "close") {
      /* create/close operan sobre los workspaces propios. El background
         los niega en NATIVO con la razón exacta (honestidad primero). */
      if (sub === "create") {
        const name = args.slice(1).join(" ");
        if (!name) { Term.printErr("uso: ws create <nombre>"); return; }
        const res = await Bridge.call("ws.create", { name });
        if (!res || !res.ok) { Term.printErr((res && res.error) || "sin respuesta"); return; }
        Term.printOut(`workspace ${String(res.data.id).padStart(2, "0")} ${res.data.name} creado (modo SESIONES)`, "ok");
        await Workspaces.syncFromBridge().catch(() => {});
        Workspaces.renderBar();
        return;
      }
      const target = args[1];
      if (!target) { Term.printErr("uso: ws close <n|nombre>   (nunca el último, nunca el activo)"); return; }
      const asNum = parseInt(target, 10);
      let closeId = Number.isFinite(asNum) ? asNum : FSYS.workspaces.find((w) => w.name.toLowerCase().startsWith(target.toLowerCase()));
      if (closeId && typeof closeId === "object") closeId = closeId.id;
      if (!closeId) { Term.printErr(`workspace no encontrado: ${target}`); return; }
      const res = await Bridge.call("ws.close", { id: closeId });
      if (!res || !res.ok) { Term.printErr((res && res.error) || "sin respuesta"); return; }
      Term.printOut(`workspace ${res.data.removed} cerrado · quedan ${res.data.count}`, "ok");
      await Workspaces.syncFromBridge().catch(() => {});
      Workspaces.renderBar();
      return;
    }
    if (sub === "rename") {
      const id = parseInt(args[1], 10);
      const name = args.slice(2).join(" ");
      if (!id || !name) { Term.printErr("uso: ws rename <n> <nuevo-nombre>   (en modo NATIVO renombrá desde la UI de Floorp)"); return; }
      const res = await Bridge.call("ws.rename", { id, name });
      if (!res || !res.ok) { Term.printErr((res && res.error) || "sin respuesta"); return; }
      Term.printOut(`workspace ${id} renombrado a ${res.data.name}`, "ok");
      await Workspaces.syncFromBridge().catch(() => {});
      Workspaces.renderBar();
      return;
    }
    /* default: list */
    const res = await Bridge.call("ws.list");
    if (!res || !res.ok) { Term.printErr((res && res.error) || "sin respuesta"); return; }
    const d = res.data;
    Term.printOut(`modo: ${d.mode === "NATIVE" ? "NATIVO — son los workspaces reales de Floorp" : "SESIONES — activá los nativos: 'ws enable'"}`, d.mode === "NATIVE" ? "ok" : "dim");
    for (const w of d.workspaces) {
      const tabs = w.tabs === null || w.tabs === undefined ? "" : `  ${w.tabs} tabs`;
      const mark = (w.isSelected || w.id === d.active) ? "❯" : " ";
      Term.printOut(` ${mark} ${String(w.id).padStart(2, "0")} ${w.name.padEnd(16)}${tabs}`, w.isSelected ? "ok" : "out");
    }
  })();
});

/* ==== SISTEMA OPERATIVO: apps + archivos (BOOT 09.5, vía fsys-bridge) ====
   La detección es POR COMPUTADORA: cada app del catálogo se chequea al
   arrancar el bridge; solo las instaladas se registran como comandos.
   Todo pasa por la allowlist cerrada del bridge (nunca shell arbitraria). */
const AppsSys = {
  registered: new Set(),   // ids registrados como comandos dinámicos

  needBridge() {
    Term.printErr("esto necesita el fsys-bridge (proceso local)");
    Term.printOut("→ ejecutá fsys-bridge/start-bridge.bat (o .sh en Linux)", "dim");
    Term.printOut("→ dejalo abierto; después probá 'bridge' acá", "dim");
  },

  /* Errores crudos del bridge → mensajes humanos */
  humanError(res) {
    const map = {
      BRIDGE_OFFLINE: "el fsys-bridge no está corriendo (start-bridge.bat)",
      SIN_RESPUESTA: "sin respuesta del bridge — ¿se cerró la ventana?",
      UNAUTHORIZED: "token inválido — borra fsys-bridge/data/token.txt y reinicia",
    };
    return map[res && res.error] || (res && res.error) || "sin respuesta";
  },

  /* Registra cada app instalada como comando propio (spotify → lanza).
     Compatible con aliases gratis: pasa por el mismo CommandEngine. */
  registerDynamic(apps) {
    for (const a of apps) {
      if (!a.installed || this.registered.has(a.id)) continue;
      this.registered.add(a.id);
      CommandEngine.register({
        name: a.id,
        description: `Abrir ${a.name} (app del sistema)`,
        usage: a.id,
        type: "native",
        cat: "APPS",
        run: () => this.launch(a.id),
      });
    }
    /* Apps desinstaladas: unregister para que no aparezcan en TAB/palette */
    for (const a of apps) {
      if (!a.installed && this.registered.has(a.id)) {
        this.registered.delete(a.id);
        CommandEngine.registry.delete(a.id);
      }
    }
  },

  async launch(id) {
    if (!Bridge.available) { this.needBridge(); return; }
    const res = await Bridge.call("app.launch", { id }, 5000).catch(() => null);
    if (!res) { this.needBridge(); return; }
    if (res.ok) Term.printOut(`lanzando ${id} → ${res.exe || "OK"}`, "ok");
    else Term.printErr(this.humanError(res));
  },

  async syncAtBoot() {
    if (!Bridge.available) return;
    const res = await Bridge.call("bridge.status", {}, 4000).catch(() => null);
    if (res && res.ok && res.data.online) {
      this.registerDynamic(res.data.apps);
      Bridge.appsOnline = true;
      Bridge.appsCount = res.data.installedCount;
    } else {
      Bridge.appsOnline = false;
    }
  },
};

reg("bridge", "Estado del puente con el sistema operativo", "bridge", async () => {
  if (!Bridge.available) {
    Term.printOut("BRIDGE DE EXTENSIÓN: OFFLINE (cargá la extensión)", "dim");
    return;
  }
  const res = await Bridge.call("bridge.status", {}, 4000).catch(() => null);
  if (!res || !res.ok) { Term.printErr("sin respuesta del background"); return; }
  const d = res.data;
  if (d.online) {
    Term.printOut(`FSYS-BRIDGE: ONLINE (127.0.0.1:${d.port})`, "ok");
    Term.printOut(`apps instaladas: ${d.installedCount} → comandos activos. 'apps' para verlas.`, "out");
  } else {
    Term.printOut("FSYS-BRIDGE: OFFLINE", "dim");
    Term.printOut("→ ejecutá fsys-bridge/start-bridge.bat y dejalo abierto", "dim");
    Term.printOut("→ funciones de SO deshabilitadas; todo lo demás funciona", "dim");
  }
});

reg("apps", "Lista apps detectadas en esta computadora", "apps", async () => {
  if (!Bridge.available) { AppsSys.needBridge(); return; }
  const res = await Bridge.call("apps.list", {}, 4000).catch(() => null);
  if (!res) { AppsSys.needBridge(); return; }
  if (!res.ok) { Term.printErr(AppsSys.humanError(res)); return; }
  AppsSys.registerDynamic(res.data);
  const inst = res.data.filter((a) => a.installed);
  Term.printOut(`APPS // ${inst.length} instaladas de ${res.data.length} en el catálogo`, "ok");
  for (const a of res.data) {
    const mark = a.installed ? "✓" : "·";
    const cmd = a.installed ? `  → comando '${a.id}' activo` : "";
    const custom = a.custom ? " [tuya]" : "";
    Term.printOut(` ${mark} ${a.id.padEnd(12)} ${a.name}${custom}${cmd}`, a.installed ? "out" : "dim");
  }
  Term.printOut("agregá las tuyas: add-app <nombre> <ruta-del-exe>", "dim");
});

reg("open-app", "Lanza una app permitida", "open-app <app>", (args) => {
  const id = (args[0] || "").toLowerCase();
  if (!id) { Term.printErr("uso: open-app <app>   ('apps' lista las disponibles)"); return; }
  AppsSys.launch(id);
});

reg("add-app", "Registra tu propio ejecutable como comando", "add-app <nombre> <ruta-del-exe>", (args) => {
  if (args.length < 2) {
    Term.printErr("uso: add-app <nombre> <ruta-del-exe>");
    Term.printOut("ejemplo: add-app minecraft C:\\Minecraft\\launcher.exe", "dim");
    return;
  }
  const name = args[0].toLowerCase();
  const exe = args.slice(1).join(" ");
  /* El nombre de la app se vuelve un comando: no puede pisar nativos
     ni colisionar con aliases existentes. */
  if (CommandEngine.registry.has(name)) {
    Term.printErr(`'${name}' ya es un comando del sistema — elegí otro nombre`);
    return;
  }
  if (FSYS.aliases[name]) {
    Term.printErr(`'${name}' ya es un alias — borralo primero (unalias ${name})`);
    return;
  }
  (async () => {
    if (!Bridge.available) { AppsSys.needBridge(); return; }
    const res = await Bridge.call("app.add", { name, exe }, 4000).catch(() => null);
    if (!res) { AppsSys.needBridge(); return; }
    if (!res.ok) { Term.printErr(res.error || "no se pudo agregar"); return; }
    AppsSys.registered.delete(name);   // fuerza re-registro
    const st = await Bridge.call("apps.list", {}, 4000).catch(() => null);
    if (st && st.ok) AppsSys.registerDynamic(st.data);
    Term.printOut(`app registrada: '${name}' → ya podés ejecutarla como comando`, "ok");
    Term.printOut(`alias incluido gratis: alias <corto> ${name}`, "dim");
  })();
});

reg("rm-app", "Quita una app agregada por vos", "rm-app <nombre>", (args) => {
  const name = (args[0] || "").toLowerCase();
  if (!name) { Term.printErr("uso: rm-app <nombre>"); return; }
  (async () => {
    if (!Bridge.available) { AppsSys.needBridge(); return; }
    const res = await Bridge.call("app.remove", { name }, 4000).catch(() => null);
    if (!res) { AppsSys.needBridge(); return; }
    if (!res.ok) { Term.printErr(res.error || "no se pudo quitar"); return; }
    AppsSys.registered.delete(name);
    CommandEngine.registry.delete(name);
    Term.printOut(`app quitada: ${name}`, "ok");
  })();
});

reg("file", "Archivos del workspace del sistema", "file <list|open <n>|write <n> <texto>>", (args) => {
  const sub = (args[0] || "list").toLowerCase();
  (async () => {
    if (!Bridge.available) { AppsSys.needBridge(); return; }
    if (sub === "list") {
      const res = await Bridge.call("files.list", {}, 4000).catch(() => null);
      if (!res) { AppsSys.needBridge(); return; }
      if (!res.ok) { Term.printErr(res.error || "bridge offline"); return; }
      if (!res.data.files.length) { Term.printOut("(workspace vacío — file write <n> <texto> crea archivos)", "dim"); return; }
      res.data.files.forEach((f, i) =>
        Term.printOut(` ${String(i + 1).padStart(2)}  ${f.name.padEnd(28)} ${f.size} bytes`, "out"));
      Term.printOut(`dir: ${res.data.dir}`, "dim");
    } else if (sub === "write") {
      const name = args[1];
      const text = args.slice(2).join(" ");
      if (!name) { Term.printErr("uso: file write <nombre> <texto>"); return; }
      const res = await Bridge.call("files.write", { name, text }, 4000).catch(() => null);
      if (!res) { AppsSys.needBridge(); return; }
      if (!res.ok) { Term.printErr(AppsSys.humanError(res)); return; }
      Term.printOut(`escrito: ${res.wrote} (${res.bytes} bytes)`, "ok");
    } else if (sub === "open") {
      const n = parseInt(args[1], 10);
      if (!n) { Term.printErr("uso: file open <número>   ('file list' muestra los números)"); return; }
      const res = await Bridge.call("files.list", {}, 4000).catch(() => null);
      if (!res || !res.ok) { Term.printErr("bridge offline"); return; }
      const f = res.data.files[n - 1];
      if (!f) { Term.printErr(`no existe el archivo ${n} (hay ${res.data.files.length})`); return; }
      const op = await Bridge.call("files.open", { name: f.name }, 5000).catch(() => null);
      if (!op) { AppsSys.needBridge(); return; }
      if (op.ok) Term.printOut(`abriendo ${f.name} con la app del sistema`, "ok");
      else Term.printErr(AppsSys.humanError(op));
    } else {
      Term.printErr(`file: subcomando desconocido '${sub}' (list | write | open)`);
    }
  })();
});

/* ==== BÓVEDA DE SESIONES + MODO FOCO (BOOT 11) ====
   Snapshots con nombre de la ventana completa. Sin bridge de
   extensión → mensaje honesto; todo lo demás sigue funcionando. */
reg("vault", "Bóveda: guarda/restaura sesiones completas", "vault <save <nombre> | load <nombre> | list | rm <nombre>>", (args) => {
  const sub = (args[0] || "list").toLowerCase();
  (async () => {
    if (!Bridge.available) { Tabs.needBridge(); return; }
    if (sub === "save" || sub === "load" || sub === "rm") {
      const name = args[1];
      if (!name) { Term.printErr(`uso: vault ${sub} <nombre>   ('vault list' muestra las tuyas)`); return; }
      const res = await Bridge.call(`vault.${sub === "rm" ? "rm" : sub}`, { name }, 8000).catch(() => null);
      if (!res) { Term.printErr("sin respuesta del background"); return; }
      if (!res.ok) {
        const msg = { NO_EXISTE: `no existe la sesión '${name}' (vault list)`, NOMBRE_INVALIDO: "nombre inválido (letras, números, _ -)" }[res.error] || res.error;
        Term.printErr(msg);
        return;
      }
      if (sub === "save") Term.printOut(`bóveda '${res.data.name}' guardada: ${res.data.tabs} tabs${res.data.overwrote ? " (sobrescrita)" : ""}`, "ok");
      else if (sub === "load") Term.printOut(`bóveda '${name}' restaurada: ${res.data.restored} tabs · cerradas ${res.data.closed}`, "ok");
      else Term.printOut(`bóveda eliminada: ${res.data.name}`, "ok");
    } else if (sub === "list") {
      const res = await Bridge.call("vault.list", {}, 6000).catch(() => null);
      if (!res || !res.ok) { Term.printErr("sin respuesta del background"); return; }
      if (!res.data.length) { Term.printOut("(bóveda vacía — 'vault save <nombre>' guarda la ventana actual)", "dim"); return; }
      Term.printOut(`BÓVEDA // ${res.data.length} sesión(es)`, "ok");
      for (const s of res.data) {
        const ago = Math.round((Date.now() - s.savedAt) / 60000);
        const when = ago < 60 ? `${ago}m` : `${Math.floor(ago / 60)}h`;
        Term.printOut(`  ${s.name.padEnd(16)} ${String(s.tabs).padStart(3)} tabs  hace ${when}`, "out");
      }
    } else {
      Term.printErr("vault: subcomando desconocido (save | load | list | rm)");
    }
  })();
});

/* Modo foco: guarda tu sesión, limpia el escritorio, timer. Al terminar
   (o con 'focus off') TODO vuelve solo. */
reg("focus", "Modo foco: guarda tu sesión y arranca un timer", "focus <minutos> [etiqueta] | focus off", (args) => {
  (async () => {
    if (!Bridge.available) { Tabs.needBridge(); return; }
    if ((args[0] || "").toLowerCase() === "off") {
      const res = await Bridge.call("focus.stop", {}, 8000).catch(() => null);
      if (!res || !res.ok) { Term.printErr(res && res.error === "FOCUS_INACTIVO" ? "no hay foco activo" : "sin respuesta"); return; }
      Term.printOut(`foco terminado → ${res.data.restored} tabs restauradas`, "ok");
      return;
    }
    const m = parseFloat(args[0]);
    if (!m || m <= 0 || m > 480) { Term.printErr("uso: focus <minutos> [etiqueta]   ej: focus 45 tesis  · terminar antes: focus off"); return; }
    const chk = await Bridge.call("focus.check", {}, 5000).catch(() => null);
    if (chk && chk.ok && chk.data.active) { Term.printErr("ya hay un foco activo — 'focus off' para terminarlo"); return; }
    const res = await Bridge.call("focus.start", { minutes: m, label: args.slice(1).join(" ") }, 8000).catch(() => null);
    if (!res || !res.ok) { Term.printErr(res && res.error === "FOCUS_ACTIVO" ? "ya hay un foco activo — 'focus off' para terminarlo" : "sin respuesta"); return; }
    Term.printOut(`FOCO // ${m} minutos${args.length > 1 ? " · " + args.slice(1).join(" ") : ""}`, "ok");
    Term.printOut(`  tu sesión (${res.data.tabs} tabs) está a salvo — se cierra TODO y al terminar vuelve solo`, "out");
    Term.printOut("  cortar antes: focus off", "dim");
  })();
});

/* Recordatorio fijado en la status bar (persistente) */
reg("pin", "Fija un recordatorio en la status bar", "pin <texto> | pin off", (args) => {
  const el = document.getElementById("sb-pin");
  if (!el) return;
  const text = args.join(" ").trim();
  if (!text || text.toLowerCase() === "off") {
    if (FSYS.config.pin) { FSYS.config.pin = null; saveStore(STORE_KEYS.cfg, FSYS.config); el.textContent = ""; Term.printOut("recordatorio quitado", "ok"); }
    else Term.printErr("uso: pin <texto>   (se muestra en la status bar hasta que hagas 'pin off')");
    return;
  }
  if (text.length > 48) { Term.printErr("máximo 48 caracteres — que entre en la barra"); return; }
  FSYS.config.pin = text;
  saveStore(STORE_KEYS.cfg, FSYS.config);
  el.textContent = `@ ${text}`;
  Term.printOut(`fijado: "${text}"  (pin off lo quita)`, "ok");
});

/* ============ SETUP (v0.18): identidad, cuentas y respaldo ============
   La primera vez de verdad: ordena el perfil con un checklist y deja
   tu sistema portable — 'setup backup' exporta TODO y en otra máquina
   'setup restore' lo monta. Nada de este sistema depende de esto: es
   encima, en la misma terminal. */
const Setup = {
  fields() {
    return [
      ["nombre", FSYS.config.user,  "setup name tu_nombre"],
      ["host",   FSYS.config.host,  "setup host tu_host (ej: casa, lap)"],
      ["email",  FSYS.config.email, "setup email tu@correo.com"],
      ["github", FSYS.config.github,"setup github tu_usuario"],
      ["ciudad", FSYS.config.city,  "setup city tu_ciudad"],
    ];
  },
  set(k, v) { FSYS.config[k] = v; saveStore(STORE_KEYS.cfg, FSYS.config); },
};

const PROVIDERS = [
  [/gmail\.com|googlemail\.com$/i, "https://mail.google.com"],
  [/outlook\.com$|hotmail\.com$|live\.com$/i, "https://outlook.live.com/mail"],
  [/yahoo\.com$/i, "https://mail.yahoo.com"],
  [/proton\.me$|protonmail\.com$/i, "https://mail.proton.me"],
];

reg("setup", "Primera vez: identidad, cuentas, respaldo y diagnóstico", "setup [name|host|email|github|city <valor> | backup | restore [json] | doctor | done]", async (args) => {
  const sub = (args[0] || "").toLowerCase();
  const val = args.slice(1).join(" ").trim();

  /* --- status (sin subcomando) --- */
  if (!sub) {
    Term.printOut("SETUP // tu perfil (persiste entre sesiones y máquinas)", "ok");
    for (const [label, v, uso] of Setup.fields())
      Term.printOut(`  [${v ? "x" : " "}] ${label.padEnd(7)} ${v ?? "(pendiente)"}`.padEnd(52) + (v ? "" : ` → ${uso}`), v ? "out" : "dim");
    Term.printOut(`  [${Setup.done() ? "x" : " "}] done`, Setup.done() ? "out" : "dim");
    const missing = Setup.fields().filter(([, v]) => !v).length;
    if (!missing && !Setup.done()) Term.printOut("todo cargado — 'setup done' para cortar el aviso del arranque", "ok");
    Term.printOut("exp/imp: setup backup (al portapapeles) · setup restore (desde JSON)", "dim");
    Term.printOut("revisar: setup doctor", "dim");
    return;
  }

  /* --- identity: name/host comparten reglas de config user/host --- */
  if (sub === "name" || sub === "host") {
    if (!val || !/^[\w-]{1,16}$/.test(val)) { Term.printErr(`uso: setup ${sub} <nombre>  (letras/números/_/- , máx 16)`); return; }
    const key = sub === "name" ? "user" : "host";
    Setup.set(key, val);
    FSYS.settings[key] = val;
    updatePrompt();
    Setup.set("setupDone", true);
    Term.printOut(`prompt → ${FSYS.settings.user}@${FSYS.settings.host}:~$`, "ok");
    return;
  }

  /* --- email: guarda el tuyo + crea el webapp 'mail' del proveedor --- */
  if (sub === "email") {
    if (!val || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(val)) { Term.printErr("uso: setup email tu@correo.com"); return; }
    Setup.set("email", val);
    Setup.set("setupDone", true);
    const apps = WebApps.all();
    if (!apps.mail && !CommandEngine.resolve("mail")) {
      const hit = PROVIDERS.find(([re]) => re.test(val));
      apps.mail = hit ? hit[1] : `mailto:${val}`;
      WebApps.save(apps); WebApps.register(apps);
      Term.printOut(`comando 'mail' creado → ${apps.mail}`, "ok");
    }
    Term.printOut(`email → ${val}`, "ok");
    return;
  }

  /* --- github: tu usuario + el webapp 'gh' que abre tu perfil --- */
  if (sub === "github" || sub === "ghuser") {
    if (!val || !/^(?!.*--)[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(val)) { Term.printErr("uso: setup github <usuario>  (letras, números y -)"); return; }
    Setup.set("github", val);
    Setup.set("setupDone", true);
    const apps = WebApps.all();
    if (!apps.gh && !CommandEngine.resolve("gh")) {
      apps.gh = `https://github.com/${val}`;
      WebApps.save(apps); WebApps.register(apps);
      Term.printOut("comando 'gh' creado → tu perfil de GitHub", "ok");
    }
    Term.printOut(`github → ${val}`, "ok");
    return;
  }

  /* --- ciudad: la default de 'weather' --- */
  if (sub === "city") {
    if (!val) { Term.printErr("uso: setup city tu_ciudad   ej: setup city buenos aires"); return; }
    Setup.set("city", val);
    Term.printOut(`ciudad → ${val}  · 'weather' solo ya usa esta`, "ok");
    return;
  }

  /* --- backup: TODO tu sistema al portapapeles como JSON --- */
  if (sub === "backup") {
    const data = {
      magic: "FSYS-BACKUP", v: VERSION, when: new Date().toISOString(),
      config: FSYS.config,
      aliases: FSYS.aliases,
      customCommands: FSYS.customCommands,
      webapps: WebApps.all(),
      notes: (() => { try { return JSON.parse(localStorage.getItem("fsys.notes") || "[]"); } catch (e) { return []; } })(),
      snippets: Snips.all(),
    };
    const json = JSON.stringify(data);
    const kb = Math.round(json.length / 1024);
    try {
      if (Bridge.available) reg("clip").run([json]);
      else { navigator.clipboard.writeText(json); Term.printOut("copiado al portapapeles del navegador", "ok"); }
    } catch (e) { Term.printErr(`backup: no pude escribir el portapapeles (${e.message})`); return; }
    Term.printOut(`BACKUP LISTO → portapapeles (${kb} KB · ${new Date().toISOString()})`, "ok");
    Term.printOut("pegalo donde quieras guardarlo. En otra máquina: 'setup restore'", "dim");
    if (kb > 1024) Term.printOut("aviso: el wallpaper hace el JSON grande — si pesa mucho, 'wall off' y volvé a hacer el backup", "dim");
    return;
  }

  /* --- restore: desde un JSON pegado o del portapapeles --- */
  if (sub === "restore") {
    let json = val;
    if (!json && navigator.clipboard && navigator.clipboard.readText) {
      try { json = await navigator.clipboard.readText(); } catch (e) { /* sin permiso */ }
    }
    if (!json) { Term.printErr("uso: setup restore <json>   (o pegalo en el portapapeles y corré 'setup restore')"); return; }
    let d;
    try { d = JSON.parse(json); } catch (e) { Term.printErr(`JSON inválido: ${e.message}`); return; }
    if (!d || d.magic !== "FSYS-BACKUP") { Term.printErr("esto no es un backup de FLOORP SYSTEM (falta la marca FSYS-BACKUP)"); return; }
    if (d.config) {
      const tWall = FSYS.config.wall; FSYS.config = { ...FSYS.config, ...d.config };
      FSYS.config.wall = FSYS.config.wall || tWall;
      if (FSYS.config.user) FSYS.settings.user = FSYS.config.user;
      if (FSYS.config.host) FSYS.settings.host = FSYS.config.host;
      saveStore(STORE_KEYS.cfg, FSYS.config);
      try { applyTheme(FSYS.config.accent); } catch (e) {}
      try { STUDIO.applyTokens(); } catch (e) {}
      try { Wall.apply(); } catch (e) {}
    }
    if (d.aliases) { FSYS.aliases = { ...FSYS_DEFAULT_ALIASES, ...d.aliases }; saveStore(STORE_KEYS.aliases, FSYS.aliases); }
    if (d.customCommands) { FSYS.customCommands = d.customCommands; saveStore(STORE_KEYS.cmds, FSYS.customCommands); }
    if (d.webapps) { WebApps.save(d.webapps); WebApps.register(d.webapps); }
    if (Array.isArray(d.notes)) localStorage.setItem("fsys.notes", JSON.stringify(d.notes));
    if (d.snippets) { const s = Snips.all(); Object.assign(s, d.snippets); Snips.save(s); }
    Term.printOut("RESTORE LISTO — pedales, paleta, aliases, comandos y snippets en su lugar", "ok");
    Term.printOut("recargá la tab (F5) para ver todo montado", "dim");
    return;
  }

  /* --- done: corta el aviso de primera vez --- */
  if (sub === "done") {
    Setup.set("setupDone", true);
    Term.printOut("primer arranque confirmado — no vuelve el aviso", "ok");
    return;
  }

  /* --- doctor: diagnóstico del modo de instalación --- */
  if (sub === "doctor") {
    Term.printOut("SETUP DOCTOR //", "ok");
    const ext = !!(window.browser && browser.runtime && browser.runtime.id);
    Term.printOut(`  extensión      ${ext ? "cargada" : "no (home 100% igual — sin tabs/vault/auto nativos)"}`, ext ? "out" : "dim");
    Term.printOut(`  bridge         ${Bridge.appsOnline ? "online (apps/archivos del SO)" : "offline"}`, "out");
    try { localStorage.setItem("fsys.probe", "1"); localStorage.removeItem("fsys.probe"); Term.printOut("  almacenamiento persistente   ok", "out"); }
    catch (e) { Term.printOut("  almacenamiento persistente   FALLO (¿modo privado?)", "err"); }
    Term.printOut(`  wallpaper      ${FSYS.config.wall ? "on" : "off"} · widgets ${FSYS.config.widgets.length}`, "out");
    Term.printOut("instalación permanente: carpeta 'installer/' del paquete (para siempre, sin admin)", "dim");
    return;
  }

  Term.printErr(`subcomando desconocido: ${sub} — name · host · email · github · city · backup · restore · done · doctor`);
});

/* Cadena de arranque: comandos que corren solos al iniciar (BOOT 11) */
reg("startup", "Cadena de arranque: comandos que corren solos al iniciar", "startup <add <cmd> | list | rm <n> | run | clear>", (args) => {
  const sub = (args[0] || "list").toLowerCase();
  const st = FSYS.config.startup || (FSYS.config.startup = []);
  if (sub === "add") {
    const cmd = args.slice(1).join(" ").trim();
    if (!cmd) { Term.printErr("uso: startup add <comando>   ej: startup add vault load trabajo"); return; }
    if (!CommandEngine.resolve(cmd.split(/\s+/)[0])) { Term.printErr(`'${cmd.split(/\s+/)[0]}' no es un comando conocido`); return; }
    if (st.length >= 8) { Term.printErr("máximo 8 comandos de arranque — sacá alguno (startup rm <n>)"); return; }
    st.push(cmd);
    saveStore(STORE_KEYS.cfg, FSYS.config);
    Term.printOut(`arranque ${st.length}: ${cmd}`, "ok");
  } else if (sub === "list") {
    if (!st.length) { Term.printOut("(vacío — 'startup add <comando>' agrega)", "dim"); return; }
    st.forEach((c, i) => Term.printOut(` ${i + 1}. ${c}`, "out"));
    Term.printOut("corren solos al iniciar · probarlos ya: startup run", "dim");
  } else if (sub === "rm") {
    const n = parseInt(args[1], 10);
    if (!n || !st[n - 1]) { Term.printErr("uso: startup rm <número>   ('startup list' muestra los números)"); return; }
    const gone = st.splice(n - 1, 1)[0];
    saveStore(STORE_KEYS.cfg, FSYS.config);
    Term.printOut(`quitado: ${gone}`, "ok");
  } else if (sub === "clear") {
    FSYS.config.startup = [];
    saveStore(STORE_KEYS.cfg, FSYS.config);
    Term.printOut("cadena de arranque vaciada", "ok");
  } else if (sub === "run") {
    if (!st.length) { Term.printOut("(vacío)", "dim"); return; }
    (async () => {
      for (const cmd of st) { Term.printCmd(cmd); CommandEngine.execute(cmd); await new Promise((s) => setTimeout(s, 250)); }
    })();
  } else Term.printErr("startup: subcomando desconocido (add | list | rm | run | clear)");
});

/* ==== AUTOMATIZACIONES (v0.15) ====
   Reglas pequeñas y SIEMPRE desactivables: 'auto on/off <regla>'.
   La lógica vive en el background (auto.js): sigue activa aunque
   cierres la home, y notifica vía el sistema operativo. ==== */
const AUTO_RULES = {
  vault: "snapshot 'auto-trabajo' cada 2h (lo restaurás con vault load)",
  break: "aviso de descanso cada 50 min (notificación del SO)",
  battery: "guarda sesión en 'auto-bateria' al cruzar el 25% (one-shot)",
  downloads: "aviso cuando una descarga termina",
  flush: "semanal: archiva tabs con +7 días sin abrir en 'flush-<fecha>'",
};
reg("auto", "Automatizaciones: reglas que trabajan por vos", "auto <status | on <regla> | off <regla> | run>", (args) => {
  const sub = (args[0] || "status").toLowerCase();
  const rule = (args[1] || "").toLowerCase();
  if (!Bridge.available) {
    Term.printErr("auto requiere la extensión FLOORP SYSTEM (about:debugging)");
    return;
  }
  (async () => {
    if (sub === "status" || sub === "list") {
      const res = await Bridge.call("auto.status");
      if (!res || !res.ok) { Term.printErr((res && res.error) || "sin respuesta"); return; }
      Term.printOut("AUTOMATIZACIONES", "ok");
      for (const r of res.data) {
        Term.printOut(` ${r.on ? "[x]" : "[ ]"} ${r.id.padEnd(10)} ${AUTO_RULES[r.id] || r.desc || ""}`, r.on ? "ok" : "out");
        if (r.on) Term.printOut(`      apagar: auto off ${r.id}`, "dim");
      }
      Term.printOut("activar: auto on <regla>", "dim");
      return;
    }
    if (sub === "on" || sub === "off") {
      if (!rule) { Term.printErr(`uso: auto ${sub} <${Object.keys(AUTO_RULES).join("|")}>`); return; }
      if (!AUTO_RULES[rule]) { Term.printErr(`regla desconocida: ${rule} — válidas: ${Object.keys(AUTO_RULES).join(", ")}`); return; }
      const arg = args.slice(2).join(" ");
      const res = await Bridge.call("auto.set", { rule, on: sub === "on", arg });
      if (!res || !res.ok) { Term.printErr((res && res.error) || "sin respuesta"); return; }
      Term.printOut(`${rule} ${sub === "on" ? "ACTIVADO" : "DESACTIVADO"} — ${AUTO_RULES[rule]}`, sub === "on" ? "ok" : "out");
      return;
    }
    if (sub === "run") {
      const res = await Bridge.call("auto.run");
      if (!res || !res.ok) { Term.printErr((res && res.error) || "sin respuesta"); return; }
      const f = res.data.fired;
      Term.printOut(f.length ? `disparado ahora: ${f.join(", ")}` : "nada pendiente — las reglas corren solas en el background", f.length ? "ok" : "dim");
      return;
    }
    Term.printErr("auto: subcomando desconocido (status | on | off | run)");
  })();
});

/* ==== SNIPPETS / PORTAPAPELES / WEBAPPS / BÚSQUEDA (BOOT 12) ==== */
const Snips = {
  all() { try { return JSON.parse(localStorage.getItem("fsys.snips") || "{}"); } catch (e) { return {}; } },
  save(o) { localStorage.setItem("fsys.snips", JSON.stringify(o)); },
};

reg("snip", "Snippets de texto: plantillas con nombre al portapapeles", "snip <add <n> <texto> | <n> | list | rm <n>>", (args) => {
  const sub = (args[0] || "list").toLowerCase();
  const snips = Snips.all();
  if (sub === "add") {
    const name = (args[1] || "").toLowerCase();
    const text = args.slice(2).join(" ");
    if (!name || !text || !/^[a-z][a-z0-9_-]*$/i.test(name)) { Term.printErr("uso: snip add <nombre> <texto>"); return; }
    if (snips[name]) { Term.printErr(`'${name}' ya existe — rm primero: snip rm ${name}`); return; }
    if (text.length > 500) { Term.printErr("máximo 500 caracteres"); return; }
    snips[name] = text;
    Snips.save(snips);
    Term.printOut(`snippet '${name}' guardado → 'snip ${name}' lo copia al portapapeles`, "ok");
  } else if (sub === "list") {
    const names = Object.keys(snips);
    if (!names.length) { Term.printOut("(sin snippets — 'snip add <n> <texto>')", "dim"); return; }
    for (const n of names) Term.printOut(`  ${n.padEnd(14)} ${snips[n].length > 60 ? snips[n].slice(0, 59) + "…" : snips[n]}`, "out");
  } else if (sub === "rm") {
    const name = (args[1] || "").toLowerCase();
    if (!snips[name]) { Term.printErr(`no existe: ${name || "(vacío)"}`); return; }
    delete snips[name];
    Snips.save(snips);
    Term.printOut(`snippet eliminado: ${name}`, "ok");
  } else if (snips[sub]) {
    /* 'snip firma' → copia al portapapeles del SO (bridge) */
    (async () => {
      if (!Bridge.available) {
        /* Sin bridge: mostramos el texto (copiable de la terminal).
           El clipboard API del navegador puede quedar esperando permiso
           para siempre — no vale el riesgo de colgar la terminal. */
        Term.printOut(`snip '${sub}' (copiá de acá — o usá el bridge para portapapeles del SO):`, "out");
        Term.printOut(`  ${snips[sub]}`, "ok");
        return;
      }
      const res = await Bridge.call("sys.clip", { text: snips[sub] }, 6000).catch(() => null);
      if (res && res.ok) Term.printOut(`'${sub}' al portapapeles (${snips[sub].length} chars)`, "ok");
      else Term.printErr(AppsSys.humanError(res || {}));
    })();
  } else {
    Term.printErr(`no existe el snippet: ${sub}   ('snip list' muestra los tuyos)`);
  }
});

reg("cliplog", "Historial del portapapeles", "cliplog [copy <n> | clear]", (args) => {
  const sub = (args[0] || "").toLowerCase();
  const log = JSON.parse(localStorage.getItem("fsys.cliplog") || "[]");
  if (sub === "clear") { localStorage.setItem("fsys.cliplog", "[]"); Term.printOut("historial vaciado", "ok"); return; }
  if (sub === "copy") {
    const n = parseInt(args[1], 10);
    const item = log[n - 1];
    if (!item) { Term.printErr(`no existe la entrada ${n} (hay ${log.length})`); return; }
    (async () => {
      if (Bridge.available) { const res = await Bridge.call("sys.clip", { text: item.text }, 6000).catch(() => null); if (res && res.ok) { Term.printOut(`entrada ${n} al portapapeles: "${item.text.slice(0, 60)}"`, "ok"); return; } }
      if (!Bridge.available) { Term.printOut(`entrada ${n}: ${item.text}`, "out"); return; }
    })();
    return;
  }
  if (!log.length) { Term.printOut("(vacío — cada 'clip <texto>' queda registrado)", "dim"); return; }
  Term.printOut(`CLIPLOG // ${log.length}`, "ok");
  log.forEach((it, i) => Term.printOut(` ${String(i + 1).padStart(2)}  ${it.text.length > 70 ? it.text.slice(0, 69) + "…" : it.text}`, "out"));
  if (log.length) Term.printOut("recuperar: cliplog copy <n>", "dim");
});

const WebApps = {
  all() { try { return JSON.parse(localStorage.getItem("fsys.webapps") || "{}"); } catch (e) { return {}; } },
  save(o) { localStorage.setItem("fsys.webapps", JSON.stringify(o)); },
};

/* webapp add notion notion.so → nace el comando 'notion' (spec §18).
   Compatible con aliases y TAB gratis: pasa por el CommandEngine. */
reg("webapp", "Webapps como comandos", "webapp <add <n> <url> | list | rm <n>>", (args) => {
  const sub = (args[0] || "list").toLowerCase();
  const apps = WebApps.all();
  if (sub === "add") {
    const name = (args[1] || "").toLowerCase();
    let url = args[2];
    if (!name || !url || !/^[a-z][a-z0-9-]*$/i.test(name)) { Term.printErr("uso: webapp add <nombre> <url>   ej: webapp add notion notion.so"); return; }
    if (CommandEngine.resolve(name)) { Term.printErr(`'${name}' ya existe como comando — elegí otro nombre`); return; }
    if (!/^https?:\/\//.test(url)) url = "https://" + url;
    apps[name] = url;
    WebApps.save(apps);
    WebApps.register(apps);
    Term.printOut(`webapp '${name}' → ya existe el comando (abre ${url})`, "ok");
  } else if (sub === "list") {
    const names = Object.keys(apps);
    if (!names.length) { Term.printOut("(sin webapps — 'webapp add <n> <url>')", "dim"); return; }
    for (const n of names) Term.printOut(`  ${n.padEnd(14)} → ${apps[n]}`, "out");
  } else if (sub === "rm") {
    const name = (args[1] || "").toLowerCase();
    if (!apps[name]) { Term.printErr(`no existe: ${name || "(vacío)"}`); return; }
    delete apps[name];
    WebApps.save(apps);
    CommandEngine.registry.delete(name);
    Term.printOut(`webapp eliminada: ${name}`, "ok");
  } else Term.printErr("webapp: subcomando desconocido (add | list | rm)");
});

/* Registro dinámico de webapps como comandos (al boot y tras add) */
WebApps.register = function(apps) {
  for (const [n, url] of Object.entries(apps || WebApps.all())) {
    if (CommandEngine.registry.has(n)) continue;
    CommandEngine.register({
      name: n,
      description: `Abrir ${url} (webapp)`,
      usage: n,
      type: "native",
      cat: "DATOS",
      run: () => { Term.printOut(`abriendo ${url}`, "dim"); window.open(url, "_blank"); },
    });
  }
};
WebApps.register();

/* Búsqueda unificada (spec §9): lo tuyo primero, la web después */
reg("search", "Busca en TU sistema: historial, notas, snippets, webapps", "search <texto>", (args) => {
  const q = args.join(" ").toLowerCase();
  if (!q) { Term.printErr("uso: search <texto>   (busca en tu historial, notas, snippets y webapps)"); return; }
  const hits = [];
  for (const h of FSYS.history) if (h.toLowerCase().includes(q)) hits.push(["hist ", h]);
  for (const n of JSON.parse(localStorage.getItem("fsys.notes") || "[]")) { const s = typeof n === "string" ? n : String(n.t || ""); if (s.toLowerCase().includes(q)) hits.push(["note ", s]); }
  for (const [n, t] of Object.entries(Snips.all())) if (n.includes(q) || t.toLowerCase().includes(q)) hits.push(["snip ", `${n}: ${t}`]);
  for (const [n, u] of Object.entries(WebApps.all())) if (n.includes(q) || u.toLowerCase().includes(q)) hits.push(["open ", `${n} → ${u}`]);
  if (hits.length) {
    Term.printOut(`SEARCH // ${hits.length} coincidencia(s) en tu sistema`, "ok");
    hits.slice(0, 12).forEach(([src, txt]) => Term.printOut(`  [${src.trim().padEnd(6)}] ${txt.length > 66 ? txt.slice(0, 65) + "…" : txt}`, "out"));
    Term.printOut("ejecutar el que quieras: escribí el comando de la columna", "dim");
  } else Term.printOut(`sin coincidencias en tu sistema para '${q}'`, "dim");
  Term.printOut("buscar en la web: google <q> · yt <q> · gh <q> · wiki <q>", "dim");
});

/* ==== TILING v1 (BOOT 13): panel de contenido + layout split ==== */
const Pane = {
  el: null, out: null, title: null,

  init() {
    this.el = document.getElementById("pane");
    this.out = document.getElementById("pane-out");
    this.title = document.getElementById("pane-title");
    const close = document.getElementById("pane-close");
    if (close) close.addEventListener("click", () => this.close());
  },

  show(title) {
    if (!this.el) return false;
    this.view = title;   /* dash save lo guarda para restaurar el set */
    this.title.textContent = title.toUpperCase().slice(0, 40);
    this.out.innerHTML = "";
    this.el.hidden = false;
    document.body.dataset.pane = "split";
    return true;
  },

  close() {
    if (!this.el) return;
    this.el.hidden = true;
    delete this.view;
    this.out.innerHTML = "";
    delete document.body.dataset.pane;
    Term.focus({ preventScroll: true });
  },

  /* Renderiza una vista de solo-lectura al panel */
  render(kind, arg) {
    const P = (t, c) => Term.printTo("pane", t, c);
    if (kind === "notes") {
      const raw = JSON.parse(localStorage.getItem("fsys.notes") || "[]");
      const notes = raw.map((n) => (typeof n === "string" ? n : String(n.t || ""))).filter(Boolean);
      if (!notes.length) P("(sin notas — 'note <texto>' crea la primera)", "dim");
      notes.slice(0, 40).forEach((n, i) => P(` ${String(i + 1).padStart(3)}  ${n}`, "out"));
    } else if (kind === "vault") {
      (async () => {
        const res = await Bridge.call("vault.list", {}, 6000).catch(() => null);
        if (!res || !res.ok) { P("bóveda no disponible (necesita la extensión)", "err"); return; }
        if (!res.data.length) { P("(bóveda vacía — 'vault save <nombre>')", "dim"); return; }
        for (const s of res.data) {
          const ago = Math.round((Date.now() - s.savedAt) / 60000);
          P(`  ${s.name.padEnd(16)} ${String(s.tabs).padStart(3)} tabs  hace ${ago < 60 ? ago + "m" : Math.floor(ago / 60) + "h"}`, "out");
        }
      })();
    } else if (kind === "tabs") {
      (async () => {
        if (!Bridge.available) { P("tabs reales necesitan la extensión", "err"); return; }
        const res = await Bridge.call("tab.list", {}, 6000).catch(() => null);
        if (!res || !res.ok) { P("sin respuesta", "err"); return; }
        for (const t of res.data) {
          const flag = t.active ? "❯" : " ";
          const title = t.title.length > 56 ? t.title.slice(0, 55) + "…" : t.title;
          P(` ${flag} ${title}${t.pinned ? " [#]" : ""}`, t.active ? "ok" : "out");
        }
      })();
    } else if (kind === "help") {
      const groups = new Map();
      for (const c of CommandEngine.registry.values()) {
        const cat = c.cat || "SISTEMA";
        if (!groups.has(cat)) groups.set(cat, []);
        groups.get(cat).push(c);
      }
      for (const cat of ["SISTEMA", "WEB", "MEDIA", "NAVEGACIÓN", "OS", "AI", "FLUJO", "DATOS", "APPS", "SHELL"]) {
        const list = groups.get(cat);
        if (!list || !list.length) continue;
        P(cat, "ok");
        for (const c of list.slice().sort((a, b) => a.name.localeCompare(b.name)))
          P(`  ${c.name.padEnd(12)} ${c.description}`, "out");
      }
    } else if (kind === "top") {
      (async () => {
        const res = await Bridge.call("sys.metrics", {}, 6000).catch(() => null);
        if (!res || !res.ok) { P("métricas necesitan el fsys-bridge (start-bridge.bat)", "err"); return; }
        const c = res.data.cpu || {}, m = res.data.mem || {};
        const bar = (p, w = 24) => "█".repeat(Math.round((p / 100) * w)) + "░".repeat(w - Math.round((p / 100) * w));
        P(`CPU ${bar(c.percent ?? 0)} ${c.percent ?? "?"}%`, "ok");
        P(`RAM ${bar(m.percent ?? 0)} ${m.percent ?? "?"}%  (${m.used_mb ?? "?"}/${m.total_mb ?? "?"} MB)`, "out");
        const up = res.data.uptime_s;
        if (up) P(`uptime ${Math.floor(up / 3600)}h ${Math.floor((up % 3600) / 60)}m`, "dim");
      })();
    } else {
      P(`vista desconocida: ${kind}`, "err");
    }
  },
};

reg("layout", "Tiling: panel de contenido junto a la terminal", "layout <split [vista] | full>   vistas: notes vault tabs help top", (args) => {
  const sub = (args[0] || "").toLowerCase();
  if (sub === "full" || sub === "off") { Pane.close(); Term.printOut("layout → full (solo terminal)", "ok"); return; }
  if (sub !== "split" && sub !== "") { Term.printErr("uso: layout split [notes|vault|tabs|help|top]  ·  layout full"); return; }
  const view = args[1] || "notes";
  if (!["notes", "vault", "tabs", "help", "top"].includes(view)) { Term.printErr(`vista desconocida: ${view}  (notes | vault | tabs | help | top)`); return; }
  if (!Pane.show(view)) { Term.printErr("panel no disponible"); return; }
  Pane.render(view);
  Term.printOut(`layout → split · panel: ${view}   (layout full para cerrar)`, "ok");
});

reg("pane", "Control del panel de contenido", "pane <notes|vault|tabs|help|top|off>", (args) => {
  const v = (args[0] || "notes").toLowerCase();
  if (v === "off" || v === "close") { Pane.close(); return; }
  if (!["notes", "vault", "tabs", "help", "top"].includes(v)) { Term.printErr("uso: pane <notes|vault|tabs|help|top|off>"); return; }
  if (!Pane.show(v)) { Term.printErr("panel no disponible"); return; }
  Pane.render(v);
});

/* ==== VIGILANTE DE SALUD (opt-in, spec §23: nada de polling si no lo pedís) ==== */
const Watchdog = {
  timer: null,

  async start() {
    if (this.timer) { Term.printOut("watchdog ya está activo", "dim"); return; }
    if (!Bridge.available) { Term.printErr("watchdog necesita la extensión + fsys-bridge (start-bridge.bat)"); return; }
    const threshold = FSYS.config.watchdogMax || 90;
    Term.printOut(`watchdog ON — avisa si CPU o RAM pasan de ${threshold}% (cada 5 min)`, "ok");
    const tick = async () => {
      if (!Bridge.available) { this.stop(false); return; }
      const res = await Bridge.call("sys.metrics", {}, 8000).catch(() => null);
      if (!res || !res.ok) return;
      const cpu = res.data.cpu?.percent ?? 0;
      const ram = res.data.mem?.percent ?? 0;
      if (cpu >= threshold || ram >= threshold) {
        Term.printOut(`WATCHDOG // CPU ${Math.round(cpu)}% · RAM ${Math.round(ram)}% — por encima de ${threshold}%`, "err");
        Bridge.call("sys.notify", { title: "FLOORP SYSTEM // watchdog", text: `CPU ${Math.round(cpu)}% · RAM ${Math.round(ram)}%` }, 6000).catch(() => {});
      }
    };
    this.timer = setInterval(tick, 300000);
    tick();
  },

  stop(say = true) {
    if (this.timer) { clearInterval(this.timer); this.timer = null; if (say) Term.printOut("watchdog OFF", "ok"); }
    else if (say) Term.printOut("watchdog ya estaba apagado", "dim");
  },
};

reg("watchdog", "Vigilante de recursos (opt-in): avisa si la máquina se satura", "watchdog <on | off | status>", (args) => {
  const sub = (args[0] || "status").toLowerCase();
  if (sub === "on") Watchdog.start();
  else if (sub === "off") Watchdog.stop();
  else Term.printOut(`watchdog: ${Watchdog.timer ? "ON" : "OFF"} · umbral ${FSYS.config.watchdogMax || 90}%  (cambiar: config watchdog <50-99>)`, "out");
});

/* ============================================================
   RADIO FLOORP (BOOT 14): streams en vivo desde la tab del sistema.
   Espectro con AnalyserNode — REAL si el stream manda CORS
   (archivos locales: siempre real) · visual honesto si no.
   ============================================================ */
function pipeTo(args) {
  if (args.length >= 2 && args[args.length - 1] === "pane" && args[args.length - 2] === ">") {
    args.splice(args.length - 2, 2);
    if (typeof Pane !== "undefined" && Pane.el && Pane.show("salida")) return (t, c) => Term.printTo("pane", t, c);
  }
  return null;
}
const P_of = (args) => pipeTo(args) || ((t, c) => Term.printOut(t, c || "out"));

const WMO = (code) => {
  const m = {
    0: ["☀", "despejado"], 1: ["🌤", "mayormente despejado"], 2: ["⛅", "parcialmente nublado"], 3: ["☁", "nublado"],
    45: ["≡", "niebla"], 48: ["≡", "niebla con escarcha"],
    51: ["☂", "llovizna leve"], 53: ["☂", "llovizna"], 55: ["☂", "llovizna intensa"],
    61: ["☂", "lluvia leve"], 63: ["☂", "lluvia"], 65: ["☂", "lluvia fuerte"],
    66: ["☂", "lluvia helada"], 67: ["☂", "lluvia helada fuerte"],
    71: ["❄", "nieve leve"], 73: ["❄", "nieve"], 75: ["❄", "nieve fuerte"], 77: ["❄", "granos de nieve"],
    80: ["☂", "chubascos leves"], 81: ["☂", "chubascos"], 82: ["☂", "chubascos violentos"],
    85: ["❄", "chubascos de nieve"], 86: ["❄", "chubascos de nieve fuertes"],
    95: ["⚡", "tormenta"], 96: ["⚡", "tormenta con granizo"], 99: ["⚡", "tormenta fuerte con granizo"],
  };
  return { icon: (m[code] || m[3])[0], txt: (m[code] || m[3])[1] };
};

const Radio = {
  audio: null, ctx: null, src: null, analyser: null,
  playing: false, station: null, label: "", graphed: false,

  PRESETS: {
    lofi:      { name: "Groove Salad",    url: "https://ice1.somafm.com/groovesalad-128-mp3" },
    jazz:      { name: "Sonic Universe",  url: "https://ice1.somafm.com/sonicuniverse-128-mp3" },
    techno:    { name: "The Trip",        url: "https://ice1.somafm.com/thetrip-128-mp3" },
    synthwave: { name: "Underground 80s", url: "https://ice1.somafm.com/u80s-128-mp3" },
    classical: { name: "Cinematic",       url: "https://ice1.somafm.com/cinematic-128-mp3" },
    space:     { name: "Space Station",   url: "https://ice1.somafm.com/spacestation-128-mp3" },
  },

  badge() {
    const el = document.getElementById("sb-radio");
    if (el) el.textContent = this.playing ? `♪ ${this.label}` : "";
  },

  _ensureAudio() {
    if (this.audio) return;
    this.audio = new Audio();
    this.audio.preload = "none";
    this.audio.addEventListener("playing", () => { this.playing = true; this.badge(); });
    this.audio.addEventListener("pause", () => { this.playing = false; this.badge(); });
    const fi = document.getElementById("radio-file");
    if (fi && !fi.dataset.bound) {
      fi.addEventListener("change", () => {
        const f = fi.files && fi.files[0];
        if (!f) return;
        const url = URL.createObjectURL(f);
        this.play("file", url, f.name.replace(/\.[^.]+$/, "").slice(0, 22)).then((ok) => {
          if (ok.error) Term.printErr("radio: " + ok.error);
          else Term.printOut(`♪ ON AIR: ${f.name} — 'radio bars' para el espectro (REAL, sin CORS)`, "ok");
        });
        fi.value = "";
      });
      fi.dataset.bound = "1";
    }
  },

  /* Engancha el elemento al grafo de audio SOLO si el contexto corre
     (con contexto suspendido, el elemento se silenciaría). */
  _hook() {
    if (this.graphed) return !!(this.ctx && this.ctx.state === "running");
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC || !this.audio) return false;
    if (!this.ctx) { try { this.ctx = new AC(); } catch (e) { return false; } }
    if (this.ctx.state !== "running") {
      this.ctx.resume().catch(() => {});
      if (this.ctx.state !== "running") return false;
    }
    try {
      this.src = this.ctx.createMediaElementSource(this.audio);
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 512;
      this.analyser.smoothingTimeConstant = 0.82;
      this.src.connect(this.analyser);
      this.analyser.connect(this.ctx.destination);
      this.graphed = true;
      return true;
    } catch (e) { return false; }
  },

  _attempt(url) {
    return new Promise((resolve, reject) => {
      const a = this.audio;
      const clean = () => { a.removeEventListener("error", onErr); a.removeEventListener("playing", onOk); clearTimeout(t); };
      const onErr = () => { clean(); reject(new Error("stream no responde")); };
      const onOk = () => { clean(); resolve(); };
      const t = setTimeout(() => { clean(); reject(new Error("stream no responde (timeout)")); }, 12000);
      a.addEventListener("error", onErr);
      a.addEventListener("playing", onOk);
      a.src = url;
      a.play().catch((e) => { clean(); reject(new Error("el navegador bloqueó la reproducción — tocá la página y probá de nuevo")); });
    });
  },

  async play(key, url, label) {
    this._ensureAudio();
    this.stop(false);
    /* Intento 1: con CORS (permite espectro REAL si el server manda ACAO).
       Algunos servers fallan con crossOrigin → intento 2 sin él. */
    let err = null;
    this.audio.crossOrigin = "anonymous";
    try { await this._attempt(url); }
    catch (e1) {
      this.audio.removeAttribute("crossorigin");
      try { await this._attempt(url); }
      catch (e2) { err = e2.message; }
    }
    if (err) { this.playing = false; this.badge(); return { error: err }; }
    this.audio.volume = (FSYS.config.radioVol ?? 80) / 100;
    this.station = key; this.label = label;
    this._hook();
    this.badge();
    return { label };
  },

  setVol(v) {
    if (!this.audio) return false;
    this.audio.volume = Math.min(1, Math.max(0, v / 100));
    FSYS.config.radioVol = Math.round(v);
    saveStore(STORE_KEYS.cfg, FSYS.config);
    return true;
  },

  stop(clearVisual = true) {
    if (this.audio) { try { this.audio.pause(); this.audio.removeAttribute("src"); this.audio.load(); } catch (e) {} }
    this.playing = false; this.station = null; this.label = "";
    if (clearVisual && typeof RadioVisual !== "undefined") RadioVisual.detachAll();
    this.badge();
  },

  /* ¿El analizador recibe datos de verdad? (streams sin CORS → 0s) */
  realSpectrum() {
    if (!this.graphed || !this.analyser || !this.playing) return false;
    const d = new Uint8Array(this.analyser.frequencyBinCount);
    this.analyser.getByteFrequencyData(d);
    return d.some((v) => v > 0);
  },

  bars() {
    this._ensureAudio();
    this._hook();
    const el = document.createElement("div");
    el.className = "live-clock";
    Term.out.appendChild(el);
    RadioVisual.attach(el, 1);
    const o = Term.out;
    if (o.scrollHeight - o.scrollTop - o.clientHeight < 60) o.scrollTop = o.scrollHeight;
    Term.printOut("espectro en vivo (se congela con tu próximo comando)", "dim");
  },
};

const RadioVisual = {
  els: [], raf: null, phase: 0,
  BARS: "▁▂▃▄▅▆▇█",
  attach(el, rows) { this.detachEl(el); el.__fswRows = rows || 1; this.els.push(el); this.start(); },
  detachEl(el) { const i = this.els.indexOf(el); if (i >= 0) this.els.splice(i, 1); },
  detachAll() { this.els.length = 0; this.stop(); },
  start() {
    if (this.raf) return;
    const tick = () => {
      if (!this.els.length) { this.raf = null; return; }
      this.draw();
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  },
  stop() { if (this.raf) { cancelAnimationFrame(this.raf); this.raf = null; } },

  _bands(real, data) {
    const N = 16, out = new Array(N).fill(0);
    if (real && data) {
      const per = Math.floor(Math.min(data.length, 240) / N);
      for (let b = 0; b < N; b++) {
        let s = 0;
        for (let k = 0; k < per; k++) s += data[b * per + k];
        out[b] = Math.min(1, (s / per / 255) * 1.35);
      }
      return { vals: out, real: true };
    }
    /* Visual sincronizado al estado playing — etiquetado como visual */
    this.phase += 0.09;
    for (let b = 0; b < N; b++) {
      const w = Radio.playing ? 1 : 0.06;
      out[b] = Math.max(0, Math.min(1, w * (0.42 + 0.38 * Math.sin(this.phase + b * 0.62) + 0.18 * Math.sin(this.phase * 1.7 + b * 1.9) + (Math.random() - 0.5) * 0.18)));
    }
    return { vals: out, real: false };
  },

  draw() {
    const real = Radio.realSpectrum();
    let data = null;
    if (real) { data = new Uint8Array(Radio.analyser.frequencyBinCount); Radio.analyser.getByteFrequencyData(data); }
    const { vals, real: isReal } = this._bands(real, data);
    for (const el of this.els) {
      if (!el.isConnected) { this.detachEl(el); continue; }
      el.textContent = this.render(el.__fswRows || 1, vals, isReal);
    }
  },

  render(rows, vals, isReal) {
    const lines = [];
    for (let r = rows; r >= 1; r--) {
      let line = "";
      for (let b = 0; b < vals.length; b++) {
        const v = vals[b] * rows;
        line += v >= r - 0.5 ? "█" : (rows === 1 ? this.BARS[Math.max(1, Math.round(v * 8))] : " ");
      }
      lines.push(line);
    }
    if (rows > 2) lines.push((isReal ? "ESPECTRO REAL" : "ESPECTRO (visual)") + (Radio.playing ? "" : " — radio off"));
    else lines.push(isReal ? "" : " ◦");
    return lines.join("\n");
  },
};

reg("radio", "Radio en vivo + espectro ASCII", "radio [<preset|url> | file | vol <0-100> | bars | status | stop]", (args) => {
  const sub = (args[0] || "status").toLowerCase();
  if (sub === "stop") { Radio.stop(); Term.printOut("radio apagada", "ok"); return; }
  if (sub === "vol") {
    const v = parseInt(args[1], 10);
    if (isNaN(v) || v < 0 || v > 100) { Term.printErr("uso: radio vol <0-100>"); return; }
    if (!Radio.audio) { Term.printErr("no hay radio reproduciéndose"); return; }
    Radio.setVol(v);
    Term.printOut(`vol → ${v}%`, "ok");
    return;
  }
  if (sub === "bars") { Radio.bars(); return; }
  if (sub === "file") { Radio._ensureAudio(); document.getElementById("radio-file").click(); return; }
  if (sub === "status") {
    Term.printOut(`RADIO // ${Radio.playing ? "♪ ON AIR: " + Radio.label + " (" + Math.round((Radio.audio ? Radio.audio.volume : 0.8) * 100) + "%)" : "OFF"}`, Radio.playing ? "ok" : "out");
    Term.printOut(`presets: ${Object.keys(Radio.PRESETS).join(" · ")}`, "out");
    Term.printOut("radio lofi · radio <url> · radio file (mp3 local, espectro real) · radio vol 70 · radio bars", "dim");
    return;
  }
  const preset = Radio.PRESETS[sub];
  const url = preset ? preset.url : (/^https?:\/\//.test(args[0] || "") ? args[0] : null);
  if (!url) { Term.printErr(`preset desconocido: ${sub || "(vacío)"} — ${Object.keys(Radio.PRESETS).join(" · ")} — o una URL http(s)`); return; }
  Term.printOut(`radio // conectando ${preset ? preset.name : "stream"}...`, "dim");
  Radio.play(sub, url, preset ? preset.name.toLowerCase() : "stream").then((ok) => {
    if (ok.error) Term.printErr("radio: " + ok.error);
    else {
      Term.printOut(`♪ ON AIR: ${ok.label}`, "ok");
      Term.printOut("suena desde esta tab mientras navegás · 'radio bars' espectro · 'radio stop' apaga", "dim");
    }
  });
});

/* ==== WEB EN VIVO (BOOT 14): datos reales en la terminal, sin claves.
   Todo acepta '> pane' para mandar la salida al panel del tiling. ==== */
reg("weather", "Clima actual (Open-Meteo, sin clave)", "weather <ciudad> [> pane]", (args) => {
  const P = P_of(args);
  const city = args.join(" ").trim() || FSYS.config.city || "";
  if (!city) { Term.printErr("uso: weather <ciudad>   ej: weather buenos aires  · o guarda la tuya: setup city tu_ciudad"); return; }
  (async () => {
    try {
      Term.printOut(`weather // ${city}...`, "dim");
      const g = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=es&format=json`).then((r) => r.json());
      const loc = g.results && g.results[0];
      if (!loc) { Term.printErr(`ciudad no encontrada: ${city}`); return; }
      const w = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${loc.latitude}&longitude=${loc.longitude}&current=temperature_2m,apparent_temperature,wind_speed_10m,weather_code&timezone=auto`).then((r) => r.json());
      const c = w.current || {};
      const { icon, txt } = WMO(c.weather_code);
      P(`CLIMA // ${loc.name}${loc.admin1 ? ", " + loc.admin1 : ""} (${loc.country})`, "ok");
      P(`  ${icon} ${txt}`);
      P(`  temp      ${c.temperature_2m}°C  (sensación ${c.apparent_temperature}°C)`);
      P(`  viento    ${c.wind_speed_10m} km/h`);
    } catch (e) { Term.printErr("weather: sin respuesta — ¿hay red?"); }
  })();
});

const NewsStore = { items: [] };
reg("news", "Titulares de Hacker News", "news [open <n>] [> pane]", (args) => {
  if ((args[0] || "").toLowerCase() === "open") {
    const n = parseInt(args[1], 10);
    const it = NewsStore.items[n - 1];
    if (!it) { Term.printErr("no existe esa entrada — corré 'news' primero"); return; }
    window.open(it.url || `https://news.ycombinator.com/item?id=${it.id}`, "_blank");
    Term.printOut(`abriendo: ${it.title}`, "ok");
    return;
  }
  const P = P_of(args);
  (async () => {
    try {
      Term.printOut("news // HN top...", "dim");
      const ids = await fetch("https://hacker-news.firebaseio.com/v0/topstories.json").then((r) => r.json());
      const items = await Promise.all(ids.slice(0, 10).map((id) => fetch(`https://hacker-news.firebaseio.com/v0/item/${id}.json`).then((r) => r.json())));
      NewsStore.items = items.filter(Boolean);
      P(`NEWS // HACKER NEWS top ${NewsStore.items.length}`, "ok");
      NewsStore.items.forEach((it, i) => {
        P(` ${String(i + 1).padStart(2)}  ${(it.title || "").slice(0, 72)}`, "out");
        P(`      ${it.score} pts · ${it.descendants ?? 0} comentarios`, "dim");
      });
      P("abrir una: news open <n>", "dim");
    } catch (e) { Term.printErr("news: sin respuesta — ¿hay red?"); }
  })();
});

/* wiki se re-registra: además de búsqueda, 'wiki -t' imprime el resumen */
reg("wiki", "Wikipedia: búsqueda o resumen real (-t)", "wiki <tema> | wiki -t <tema> [> pane]", (args) => {
  if ((args[0] || "").toLowerCase() === "-t") {
    const P = P_of(args);
    const tema = args.slice(1).join("_").replace(/\s+/g, "_");
    if (!tema.replace(/_/g, "")) { Term.printErr("uso: wiki -t <tema>"); return; }
    (async () => {
      try {
        const d = await fetch(`https://es.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(tema)}`).then((r) => r.json());
        if (!d || !d.extract) { Term.printErr(`sin artículo: ${tema.replace(/_/g, " ")}`); return; }
        P(`WIKI // ${d.title}`, "ok");
        P(d.extract, "out");
        if (d.content_urls) P(`  ${d.content_urls.desktop.page}`, "dim");
      } catch (e) { Term.printErr("wiki: sin respuesta — ¿hay red?"); }
    })();
    return;
  }
  const q = args.join(" ");
  if (!q) { Term.printErr("uso: wiki <tema>   ·  wiki -t <tema> imprime el resumen"); return; }
  const url = `https://es.wikipedia.org/w/index.php?search=${encodeURIComponent(q)}`;
  Term.printOut(`abriendo ${url}`, "dim");
  window.open(url, "_blank");
});

reg("crypto", "Precios crypto (CoinGecko público)", "crypto [btc,eth,...] [> pane]", (args) => {
  const P = P_of(args);
  const MAP = { btc: "bitcoin", eth: "ethereum", sol: "solana", doge: "dogecoin", ltc: "litecoin", ada: "cardano", xrp: "ripple", bnb: "binancecoin" };
  const raw = (args.length ? args.join(",") : "btc,eth").toLowerCase().split(",").map((s) => s.trim()).filter(Boolean);
  const ids = raw.map((s) => MAP[s] || s);
  (async () => {
    try {
      const d = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${ids.join(",")}&vs_currencies=usd&include_24hr_change=true`).then((r) => r.json());
      P("CRYPTO // USD", "ok");
      for (const [id, v] of Object.entries(d)) {
        const chg = v.usd_24h_change ?? 0;
        const mark = chg >= 0 ? "+" : "";
        P(`  ${id.padEnd(12)} $${v.usd.toLocaleString("en-US")}  ${mark}${chg.toFixed(1)}% 24h`, chg >= 0 ? "ok" : "err");
      }
    } catch (e) { Term.printErr("crypto: sin respuesta — ¿hay red?"); }
  })();
});

reg("ip", "Tu IP pública", "ip [> pane]", (args) => {
  const P = P_of(args);
  (async () => {
    try { const d = await fetch("https://api.ipify.org?format=json").then((r) => r.json()); P(`IP PÚBLICA // ${d.ip}`, "ok"); }
    catch (e) { Term.printErr("ip: sin respuesta — ¿hay red?"); }
  })();
});

reg("dict", "Definición (Wikcionario ES)", "dict <palabra> [> pane]", (args) => {
  const P = P_of(args);
  const word = args.join(" ").trim();
  if (!word) { Term.printErr("uso: dict <palabra>"); return; }
  (async () => {
    try {
      const d = await fetch(`https://es.wiktionary.org/api/rest_v1/page/definition/${encodeURIComponent(word)}`).then((r) => r.json());
      const es = d && (d.es || d[Object.keys(d)[0]]);
      if (!es || !es.length) { Term.printErr(`sin definición: ${word}`); return; }
      P(`DICT // ${word}`, "ok");
      let n = 0;
      for (const entry of es) {
        for (const def of (entry.definitions || []).slice(0, 3)) {
          if (n >= 5) break;
          const text = String(def.definition || "").replace(/\s+/g, " ").trim();
          if (text) { P(`  (${entry.partOfSpeech || "—"}) ${text.slice(0, 120)}`, "out"); n++; }
        }
        if (n >= 5) break;
      }
    } catch (e) { Term.printErr("dict: sin respuesta — ¿hay red?"); }
  })();
});

/* Dígitos 3x5 para el bigclock (fuente propia del sistema, 0 librerías) */
const DIGITS = {
  "0": "███\n█ █\n█ █\n█ █\n███", "1": "  █\n  █\n  █\n  █\n  █", "2": "███\n  █\n███\n█\n███",
  "3": "███\n  █\n███\n  █\n███", "4": "█ █\n█ █\n███\n  █\n  █", "5": "███\n█\n███\n  █\n███",
  "6": "█\n█\n███\n█ █\n███", "7": "███\n  █\n  █\n  █\n  █", "8": "███\n█ █\n███\n█ █\n███",
  "9": "███\n█ █\n███\n  █\n  █", ":": "\n █\n \n █\n",
};

/* ==== WALLPAPER + BLURS (STUDIO v0.17) — el escritorio como lienzo.
   La imagen se guarda como dataURL JPEG comprimido (RAM/storage acotados,
   sobrevive reinicios sin files temporales). Defaults OFF: flat primero. ==== */
const Wall = {
  DIM_DEFAULT: 55,
  el: null,
  img: null,
  MAX_DIM: 900000,   /* ~900KB tras compresión — presupuesto honesto */

  apply() {
    if (!this.el) this.el = document.getElementById("wallpaper");
    if (!this.el) return;
    const w = FSYS.config.wall;
    if (!w || !w.data) { this.el.hidden = true; this.el.style.backgroundImage = ""; return; }
    this.el.hidden = false;
    this.el.style.backgroundImage = `url("${w.data}")`;
    this.el.style.opacity = String(this.clampDim(w.dim ?? this.DIM_DEFAULT) / 100);
    this.el.style.filter = `blur(${STUDIO.clamp(w.blur || 0, 0, 30)}px)`;
  },
  clampDim(v) { return STUDIO.clamp(Math.round(v) || 0, 0, 85); },

  /* Archivo local → JPEG comprimido a máx 1600px (canvas, sin librerías) */
  fromFile(file, cb) {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      const scale = Math.min(1, 1600 / Math.max(img.width, img.height));
      const c = document.createElement("canvas");
      c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      const data = c.toDataURL("image/jpeg", 0.82);
      if (data.length > this.MAX_DIM) { Term.printErr(`imagen muy pesada (${Math.round(data.length / 1024)}KB tras comprimir) — probá una más chica`); return; }
      cb(data);
    };
    img.onerror = () => { URL.revokeObjectURL(url); Term.printErr("no se pudo leer la imagen"); };
    img.src = url;
  },

  setFromUrl(u) {
    FSYS.config.wall = { ...(FSYS.config.wall || {}), data: u, dim: FSYS.config.wall?.dim ?? this.DIM_DEFAULT, blur: FSYS.config.wall?.blur || 0 };
    this.apply(); STUDIO.save();
    Term.printOut("wallpaper aplicado — 'wall dim <0-85>' velo · 'wall blur <0-30>' desenfoque · 'perf low' apaga todo", "ok");
  },
};

reg("wall", "Wallpaper del escritorio", "wall [set | set <url> | dim <0-85> | blur <0-30> | off]", (args) => {
  const sub = (args[0] || "").toLowerCase();
  if (sub === "set") {
    const u = args[1];
    if (u && /^https?:\/\//.test(u)) { Wall.setFromUrl(u); return; }
    if (u) { Term.printErr("para archivo local: 'wall set' sin args abre el selector"); return; }
    const inp = document.getElementById("wall-file");
    if (!inp) { Term.printErr("input de wallpaper no disponible"); return; }
    inp.onchange = () => {
      const f = inp.files && inp.files[0];
      inp.value = "";                      /* re-seleccionar el mismo archivo funciona */
      if (!f) return;
      Wall.fromFile(f, (data) => Wall.setFromUrl(data));
    };
    inp.click();
    return;
  }
  if (sub === "dim") {
    const n = parseInt(args[1], 10);
    if (isNaN(n) || n < 0 || n > 85) { Term.printErr("uso: wall dim <0-85>"); return; }
    if (!FSYS.config.wall) { Term.printErr("no hay wallpaper — 'wall set' primero"); return; }
    FSYS.config.wall.dim = n; Wall.apply(); STUDIO.save();
    Term.printOut(`velo → ${n}%`, "ok");
    return;
  }
  if (sub === "blur") {
    const n = parseInt(args[1], 10);
    if (isNaN(n) || n < 0 || n > 30) { Term.printErr("uso: wall blur <0-30>"); return; }
    if (!FSYS.config.wall) { Term.printErr("no hay wallpaper — 'wall set' primero"); return; }
    FSYS.config.wall.blur = n; Wall.apply(); STUDIO.save();
    Term.printOut(`blur del fondo → ${n}px`, "ok");
    return;
  }
  if (sub === "off") {
    if (!FSYS.config.wall) { Term.printOut("(sin wallpaper)", "dim"); return; }
    FSYS.config.wall = null; Wall.apply(); STUDIO.save();
    Term.printOut("wallpaper quitado — fondo plano", "ok");
    return;
  }
  const w = FSYS.config.wall;
  if (!w) { Term.printOut("(sin wallpaper — 'wall set' abre el selector · 'wall set <url>')", "dim"); return; }
  Term.printOut(`WALL // ${w.data.startsWith("data:") ? "archivo local" : "URL"} · velo ${w.dim ?? Wall.DIM_DEFAULT}% · blur ${w.blur || 0}px`, "out");
  Term.printOut("wall dim <0-85> · wall blur <0-30> · wall off", "dim");
});

reg("blur", "Desenfoque por superficie (cuesta GPU)", "blur [terminal <0-20> | widgets <0-20> | off]", (args) => {
  const sub = (args[0] || "").toLowerCase();
  if (sub === "off") { FSYS.config.blurTerm = 0; FSYS.config.blurWidget = 0; STUDIO.save(); Term.printOut("blurs de superficie desactivados", "ok"); return; }
  if (sub === "terminal" || sub === "widgets") {
    const n = parseInt(args[1], 10);
    if (isNaN(n) || n < 0 || n > 20) { Term.printErr(`uso: blur ${sub} <0-20>`); return; }
    if (sub === "terminal") FSYS.config.blurTerm = n; else FSYS.config.blurWidget = n;
    STUDIO.save();
    Term.printOut(`blur ${sub} → ${n}px${n > 12 ? "  (ojo: puede costar FPS en hardware modesto)" : ""}`, "ok");
    return;
  }
  Term.printOut(`BLUR // terminal ${FSYS.config.blurTerm || 0}px · widgets ${FSYS.config.blurWidget || 0}px`, "out");
  Term.printOut("blur terminal <0-20> · blur widgets <0-20> · blur off", "dim");
});

reg("perf", "Kill switch visual: todo flat en un comando", "perf [low | status]", (args) => {
  const sub = (args[0] || "status").toLowerCase();
  if (sub === "low") { STUDIO.perfLow(); return; }
  const heavy = !!(FSYS.config.wall) || FSYS.config.blurTerm > 0 || FSYS.config.blurWidget > 0 || !!(FSYS.config.studio && FSYS.config.studio.scan) || !!(FSYS.config.studio && FSYS.config.studio.grid);
  Term.printOut(`PERF // ${heavy ? "efectos pesados ACTIVOS (wallpaper/blurs/scan/grid)" : "flat — cero coste extra"}`, heavy ? "out" : "ok");
  if (heavy) Term.printOut("'perf low' apaga todo de un golpe", "dim");
});

/* ==== WIDGETS FLOTANTES (BOOT 14): tiles arrastrables con estado
   persistido. Cada widget corre su intervalo solo si está en pantalla. ==== */
const WidgetLayer = {
  MAX: 8,
  TYPES: ["clock", "sysmon", "weather", "radio", "notes", "bigclock", "countdown", "crypto", "news", "quote", "calendar", "battery", "net", "img", "text", "habit"],
  SIZES: ["s", "m", "l", "xl"],
  live: new Map(),
  root: null,

  all() { return FSYS.config.widgets || (FSYS.config.widgets = []); },
  persist() { saveStore(STORE_KEYS.cfg, FSYS.config); },
  _snapped() { return !!(FSYS.config.studio && FSYS.config.studio.grid); },
  /* grid on: cuantiza a 20px — tiling ligero, la posición sigue siendo libre */
  snap(v) { return this._snapped() ? Math.round(v / 20) * 20 : v; },

  add(type, arg) {
    if (!this.root) this.root = document.getElementById("widgets");
    if (!this.TYPES.includes(type)) { Term.printErr(`widget desconocido: ${type} — tipos: ${this.TYPES.join(" · ")}`); return; }
    const list = this.all();
    if (list.length >= this.MAX) { Term.printErr(`máximo ${this.MAX} widgets — sacá alguno: widget rm <id>`); return; }
    if (list.some((w) => w.type === type && (w.arg || "") === (arg || ""))) { Term.printErr("ese widget ya está en pantalla"); return; }
    if (type === "weather" && arg) FSYS.config.wCity = arg;
    if (type === "text" && !arg) { Term.printErr("text necesita contenido: widget add text tu texto"); return; }
    if (type === "countdown" && !arg) { Term.printErr("countdown necesita fecha: widget add countdown 2026-12-31"); return; }
    const n = list.length;
    const cfg = { id: `${type}-${Math.random().toString(36).slice(2, 6)}`, type, arg: arg || null, x: this.snap(60 + (n % 3) * 216), y: this.snap(60 + Math.floor(n / 3) * 180), size: "m", accent: null, title: null };
    list.push(cfg);
    this.persist();
    this.mount(cfg);
    Term.printOut(`widget ${cfg.id} agregado — arrastralo por su cabecera · 'widget rm ${cfg.id}' lo saca`, "ok");
  },

  removeById(id, say = true) {
    const list = this.all();
    const i = list.findIndex((w) => w.id === id);
    if (i === -1) { if (say) Term.printErr(`no existe: ${id}  ('widget list')`); return; }
    const w = this.live.get(id);
    if (w) { if (w.timer) clearInterval(w.timer); if (w.raf) { RadioVisual.detachEl(w.raf); } if (w.el) w.el.remove(); this.live.delete(id); }
    list.splice(i, 1);
    this.persist();
    if (say) Term.printOut(`widget quitado: ${id}`, "ok");
  },

  reset() { for (const id of [...this.live.keys()]) this.removeById(id, false); FSYS.config.widgets = []; this.persist(); Term.printOut("escritorio limpio", "ok"); },

  restore() {
    if (!this.root) this.root = document.getElementById("widgets");
    for (const cfg of this.all()) this.mount(cfg);
  },

  mount(cfg) {
    if (!this.root) this.root = document.getElementById("widgets");
    const el = document.createElement("div");
    el.className = "fsw" + (cfg.size && cfg.size !== "m" ? " fsw-" + cfg.size : "");
    if (cfg.accent) el.style.setProperty("--accent", cfg.accent);   /* acento propio: hereda a todo el subtree */
    if (cfg.blur > 0) { el.dataset.blur = "1"; el.style.setProperty("--blur-amt", STUDIO.clamp(cfg.blur, 0, 20) + "px"); }
    el.style.left = cfg.x + "px"; el.style.top = cfg.y + "px";
    const head = document.createElement("div");
    head.className = "fsw-head";
    const title = document.createElement("b");
    title.textContent = cfg.title || cfg.type.toUpperCase() + (cfg.arg ? " · " + cfg.arg : "");
    const x = document.createElement("span");
    x.className = "fsw-x"; x.textContent = "[x]";
    x.addEventListener("click", () => this.removeById(cfg.id));
    head.appendChild(title); head.appendChild(x);
    const body = document.createElement("div");
    body.className = "fsw-body";
    el.appendChild(head); el.appendChild(body);
    this.root.appendChild(el);
    const rec = { cfg, el, body, timer: null, raf: null };
    this.live.set(cfg.id, rec);

    /* Drag por la cabecera: mouse posiciona, al soltar persiste */
    head.addEventListener("mousedown", (e) => {
      if (e.target === x) return;
      const dx = e.clientX - cfg.x, dy = e.clientY - cfg.y;
      const move = (ev) => {
        cfg.x = this.snap(Math.max(0, Math.min(window.innerWidth - 100, ev.clientX - dx)));
        cfg.y = this.snap(Math.max(0, Math.min(window.innerHeight - 50, ev.clientY - dy)));
        el.style.left = cfg.x + "px"; el.style.top = cfg.y + "px";
      };
      const up = () => { document.removeEventListener("mousemove", move); document.removeEventListener("mouseup", up); this.persist(); };
      document.addEventListener("mousemove", move);
      document.addEventListener("mouseup", up);
      e.preventDefault();
    });

    const T = cfg.type;
    if (T === "clock") {
      const draw = () => {
        if (!el.isConnected) { if (rec.timer) clearInterval(rec.timer); return; }
        const d = new Date();
        const p = (n) => String(n).padStart(2, "0");
        body.innerHTML = "";
        const big = document.createElement("div"); big.className = "fsw-big";
        big.textContent = `${p(d.getHours())}:${p(d.getMinutes())}`;
        const sub = document.createElement("div"); sub.className = "fsw-sub";
        sub.textContent = `${p(d.getDate())}/${p(d.getMonth() + 1)} · ${p(d.getSeconds())}s`;
        body.appendChild(big); body.appendChild(sub);
      };
      draw(); rec.timer = setInterval(draw, 1000);
    } else if (T === "sysmon") {
      if (!Bridge.available) { body.textContent = "necesita fsys-bridge\n(start-bridge.bat)"; return; }
      const hist = [];
      const draw = async () => {
        if (!el.isConnected) { if (rec.timer) clearInterval(rec.timer); return; }
        const res = await Bridge.call("sys.metrics", {}, 6000).catch(() => null);
        if (!res || !res.ok) { body.textContent = "bridge sin respuesta"; return; }
        const c = res.data.cpu || {}, m = res.data.mem || {};
        hist.push(c.percent ?? 0); if (hist.length > 22) hist.shift();
        const spark = hist.map((v) => "▁▂▃▄▅▆▇█"[Math.min(7, Math.round(v / 100 * 7))]).join("");
        body.textContent = `CPU ${String(Math.round(c.percent ?? 0)).padStart(3)}%  ${spark}\nRAM ${String(Math.round(m.percent ?? 0)).padStart(3)}%  (${m.used_mb ?? "?"}/${m.total_mb ?? "?"}MB)`;
      };
      draw(); rec.timer = setInterval(draw, 5000);
    } else if (T === "weather") {
      const city = cfg.arg || FSYS.config.wCity;
      if (!city) { body.textContent = "sin ciudad\nwidget rm + add con ciudad"; return; }
      const draw = async () => {
        if (!el.isConnected) { if (rec.timer) clearInterval(rec.timer); return; }
        try {
          const g = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=es&format=json`).then((r) => r.json());
          const loc = g.results && g.results[0];
          if (!loc) { body.textContent = "ciudad no encontrada"; return; }
          const w = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${loc.latitude}&longitude=${loc.longitude}&current=temperature_2m,weather_code&timezone=auto`).then((r) => r.json());
          const c = w.current || {};
          const { icon, txt } = WMO(c.weather_code);
          body.innerHTML = "";
          const big = document.createElement("div"); big.className = "fsw-big";
          big.textContent = `${Math.round(c.temperature_2m ?? 0)}° ${icon}`;
          const sub = document.createElement("div"); sub.className = "fsw-sub";
          sub.textContent = `${loc.name} · ${txt}`;
          body.appendChild(big); body.appendChild(sub);
        } catch (e) { body.textContent = "sin red"; }
      };
      draw(); rec.timer = setInterval(draw, 600000);
    } else if (T === "radio") {
      body.textContent = "radio off\n'radio lofi' prende";
      rec._radioSync = setInterval(() => {
        if (!el.isConnected) { clearInterval(rec._radioSync); return; }
        if (Radio.playing && !rec.raf) { body.textContent = ""; RadioVisual.attach(body, 4); rec.raf = body; }
      }, 2000);
    } else if (T === "notes") {
      const draw = () => {
        if (!el.isConnected) { if (rec.timer) clearInterval(rec.timer); return; }
        const raw = JSON.parse(localStorage.getItem("fsys.notes") || "[]");
        const notes = raw.map((nn) => (typeof nn === "string" ? nn : String(nn.t || ""))).filter(Boolean).slice(0, 5);
        body.textContent = notes.length ? notes.join("\n") : "(sin notas)";
      };
      draw(); rec.timer = setInterval(draw, 30000);
    } else if (T === "bigclock") {
      const draw = () => {
        if (!el.isConnected) { if (rec.timer) clearInterval(rec.timer); return; }
        const d = new Date();
        const p = (n) => String(n).padStart(2, "0");
        /* Componer glifos 3x5 dígito a dígito: cada char aporta sus 5 filas */
        const stamp = `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
        const rows = ["", "", "", "", ""];
        for (const ch of stamp) {
          const g = (DIGITS[ch] || "   \n   \n   \n   \n   ").split("\n");
          for (let r2 = 0; r2 < 5; r2++) rows[r2] += (g[r2] || "   ") + " ";
        }
        body.innerHTML = "";
        const pre = document.createElement("div");
        pre.className = "fsw-clock";
        pre.textContent = rows.join("\n");
        body.appendChild(pre);
      };
      draw(); rec.timer = setInterval(draw, 1000);
    } else if (T === "countdown") {
      const target = new Date(cfg.arg || "").getTime();
      if (isNaN(target)) { body.textContent = "fecha inválida\nwidget rm + add con fecha"; return; }
      const draw = () => {
        if (!el.isConnected) { if (rec.timer) clearInterval(rec.timer); return; }
        const ms = target - Date.now();
        if (ms <= 0) { body.textContent = "¡LLEGÓ EL DÍA!"; if (rec.timer) clearInterval(rec.timer); return; }
        const dd = Math.floor(ms / 864e5), hh = Math.floor((ms % 864e5) / 36e5), mm = Math.floor((ms % 36e5) / 6e4), ss = Math.floor((ms % 6e4) / 1e3);
        body.textContent = `${dd}d ${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
      };
      draw(); rec.timer = setInterval(draw, 1000);
    } else if (T === "crypto") {
      const draw = async () => {
        if (!el.isConnected) { if (rec.timer) clearInterval(rec.timer); return; }
        try {
          const ids = (cfg.arg ? cfg.arg.split(",") : ["bitcoin", "ethereum"]).map((s) => CRYPTO_IDS[s.trim()] || s.trim());
          const d = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${ids.join(",")}&vs_currencies=usd&include_24hr_change=true`).then((r) => r.json());
          body.textContent = Object.entries(d).map(([id, v]) => `${(CRYPTO_SYM[id] || "")}${v.usd.toLocaleString("en-US")} ${v.usd_24h_change >= 0 ? "+" : ""}${(v.usd_24h_change ?? 0).toFixed(1)}%`).join("\n");
        } catch (e) { body.textContent = "sin red"; }
      };
      draw(); rec.timer = setInterval(draw, 120000);
    } else if (T === "news") {
      const draw = async () => {
        if (!el.isConnected) { if (rec.timer) clearInterval(rec.timer); return; }
        try {
          const ids = await fetch("https://hacker-news.firebaseio.com/v0/topstories.json").then((r) => r.json());
          const items = await Promise.all(ids.slice(0, 5).map((id) => fetch(`https://hacker-news.firebaseio.com/v0/item/${id}.json`).then((r) => r.json())));
          body.textContent = items.filter(Boolean).map((it, i) => `${i + 1}. ${it.title.slice(0, 44)}`).join("\n");
        } catch (e) { body.textContent = "sin red"; }
      };
      draw(); rec.timer = setInterval(draw, 600000);
    } else if (T === "quote") {
      const draw = async () => {
        if (!el.isConnected) { if (rec.timer) clearInterval(rec.timer); return; }
        try {
          const d = await fetch("https://api.quotable.io/random?maxLength=110").then((r) => r.json());
          body.textContent = `“${d.content}”\n— ${d.author}`;
        } catch (e) { body.textContent = "sin red"; }
      };
      draw(); rec.timer = setInterval(draw, 900000);
    } else if (T === "calendar") {
      const draw = () => {
        if (!el.isConnected) { if (rec.timer) clearInterval(rec.timer); return; }
        const now = new Date(), y = now.getFullYear(), m = now.getMonth();
        const first = new Date(y, m, 1).getDay(), days = new Date(y, m + 1, 0).getDate();
        const MON = ["DO", "LU", "MA", "MI", "JU", "VI", "SA"];
        let out = MON.join(" ") + "\n";
        out += "   ".repeat(first);
        for (let dd = 1; dd <= days; dd++) {
          const cell = String(dd).padStart(2, " ");
          out += (dd === now.getDate() ? `[${String(dd).padStart(2, "0")}]` : ` ${cell}`) + (new Date(y, m, dd).getDay() === 6 ? "\n" : " ");
        }
        body.innerHTML = "";
        const pre = document.createElement("div"); pre.className = "fsw-clock"; pre.textContent = out;
        body.appendChild(pre);
      };
      draw(); rec.timer = setInterval(draw, 3600000);
    } else if (T === "battery" || T === "net") {
      if (!Bridge.available) { body.textContent = "necesita fsys-bridge"; return; }
      const draw = async () => {
        if (!el.isConnected) { if (rec.timer) clearInterval(rec.timer); return; }
        const res = await Bridge.call("sys.metrics", {}, 6000).catch(() => null);
        if (!res || !res.ok) { body.textContent = "bridge sin respuesta"; return; }
        if (T === "battery") {
          const b = res.data.battery;
          const pct = Math.round((b ?? 0) * 100);
          const bars = 8, fill = Math.round(pct / 100 * bars);
          body.textContent = `BATERÍA ${"█".repeat(fill)}${"░".repeat(bars - fill)} ${pct}%`;
        } else {
          const n = res.data.net || {};
          body.textContent = `PING ${n.ping ?? "--"}ms\nDOWN ${n.down ?? "--"} Mbps\nUP ${n.up ?? "--"} Mbps`;
        }
      };
      draw(); rec.timer = setInterval(draw, 60000);
    } else if (T === "img") {
      if (!cfg.arg) { body.textContent = "sin URL\nwidget rm + add con url"; return; }
      body.innerHTML = "";
      const im = document.createElement("img");
      im.src = cfg.arg; im.alt = ""; im.className = "fsw-img";
      im.onerror = () => { body.textContent = "imagen no disponible"; };
      body.appendChild(im);
    } else if (T === "text") {
      body.textContent = cfg.arg || "";
    } else if (T === "habit") {
      const KEY = `fsys.habit.${cfg.id}`;
      const draw = () => {
        if (!el.isConnected) return;
        const rec2 = JSON.parse(localStorage.getItem(KEY) || "{}");
        const today = new Date().toDateString();
        if (!rec2.days) rec2.days = [];
        if (rec2.days.length && rec2.days[rec2.days.length - 1] !== today) {
          const last = new Date(rec2.days[rec2.days.length - 1]);
          if (Math.round((new Date(today) - last) / 864e5) > 1) rec2.streak = 0;
        }
        body.innerHTML = "";
        const b = document.createElement("div");
        b.className = "fsw-big";
        b.textContent = `${rec2.days.length || 0} días`;
        const s = document.createElement("div");
        s.className = "fsw-sub";
        s.textContent = rec2.done === today ? "✓ hoy — racha " + (rec2.streak || 0) : "click para marcar hoy";
        body.appendChild(b); body.appendChild(s);
      };
      el.addEventListener("click", (e) => {
        if (e.target.closest(".fsw-head") || e.target.closest(".fsw-x")) return;
        const rec2 = JSON.parse(localStorage.getItem(KEY) || "{}");
        const today = new Date().toDateString();
        if (rec2.done !== today) {
          rec2.done = today; rec2.days = (rec2.days || []).concat([today]);
          const yesterday = new Date(Date.now() - 864e5).toDateString();
          rec2.streak = (rec2.done === yesterday ? (rec2.streak || 0) : 0) + 1;
          localStorage.setItem(KEY, JSON.stringify(rec2));
          draw();
        }
      });
      draw();
    }
  },
};

reg("widget", "Widgets flotantes arrastrables", "widget <add <tipo> [arg] | cfg <id> <clave> <valor> | rm <id> | list | reset>", (args) => {
  const sub = (args[0] || "list").toLowerCase();
  if (sub === "add") {
    const type = (args[1] || "").toLowerCase();
    if (!type) { Term.printErr(`uso: widget add <${WidgetLayer.TYPES.join("|")}> [arg]`); return; }
    WidgetLayer.add(type, args.slice(2).join(" ") || null);
  } else if (sub === "cfg") {
    const q = (args[1] || "").toLowerCase();
    const hit = [...WidgetLayer.live.keys()].find((id) => id === q || id.startsWith(q));
    if (!hit) { Term.printErr(`no existe: ${q || "(vacío)"}  ('widget list')`); return; }
    const cfg = WidgetLayer.all().find((w) => w.id === hit);
    const k = (args[2] || "").toLowerCase();
    const v = args[3];
    if (!k) { Term.printErr("uso: widget cfg <id> <size s|m|l|xl | accent <hex|off> | title <texto|off> | blur <0-20>>"); return; }
    if (k === "size") {
      if (!WidgetLayer.SIZES.includes(v)) { Term.printErr(`tamaño inválido: ${v || "(vacío)"} — ${WidgetLayer.SIZES.join(" · ")}`); return; }
      cfg.size = v;
    } else if (k === "accent") {
      if (v === "off" || !v) { cfg.accent = null; }
      else if (!STUDIO.isHex(v.toLowerCase())) { Term.printErr("accent debe ser hex: widget cfg <id> accent #ff6ec7"); return; }
      else cfg.accent = v.toLowerCase();
    } else if (k === "title") {
      const txt = args.slice(3).join(" ");
      cfg.title = txt && txt !== "off" ? txt.slice(0, 24) : null;
    } else if (k === "blur") {
      const n = parseInt(v, 10);
      if (isNaN(n) || n < 0 || n > 20) { Term.printErr("uso: widget cfg <id> blur <0-20>"); return; }
      cfg.blur = n;
    } else { Term.printErr(`clave desconocida: ${k} — size · accent · title · blur`); return; }
    /* Re-mount limpio: removeById saca de la lista → re-insertar ANTES de
       persistir, o el widget desaparecería al recargar. */
    WidgetLayer.removeById(hit, false);
    const wlist = WidgetLayer.all();
    if (!wlist.some((w) => w.id === hit)) wlist.push(cfg);
    WidgetLayer.mount(cfg);
    WidgetLayer.persist();
    Term.printOut(`cfg aplicada: ${hit} ${k}${v ? " " + v : ""}`, "ok");
  } else if (sub === "rm") {
    const q = (args[1] || "").toLowerCase();
    const hit = [...WidgetLayer.live.keys()].find((id) => id === q || id.startsWith(q));
    if (!hit) { Term.printErr(`no existe: ${q || "(vacío)"}  ('widget list')`); return; }
    WidgetLayer.removeById(hit);
  } else if (sub === "reset") WidgetLayer.reset();
  else {
    const list = WidgetLayer.all();
    if (!list.length) { Term.printOut(`(sin widgets — 'widget add <${WidgetLayer.TYPES.join("|")}>' agrega)`, "dim"); return; }
    list.forEach((w) => Term.printOut(`  ${w.id.padEnd(16)} en (${Math.round(w.x)}, ${Math.round(w.y)})${w.arg ? " · " + w.arg : ""}`, "out"));
    Term.printOut("arrastralos por la cabecera · widget reset limpia", "dim");
  }
});

/* ==== DASHBOARDS (BOOT 14): tu set completo, reproducible ==== */
reg("dash", "Dashboards: guarda y restaura widgets+radio+panel", "dash <save <n> | <n> | list | rm <n>>", (args) => {
  const dashes = FSYS.config.dashes || (FSYS.config.dashes = {});
  const sub = (args[0] || "list").toLowerCase();
  const name = (args[1] || "").toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 16);
  if (sub === "save") {
    if (!name) { Term.printErr("uso: dash save <nombre>"); return; }
    dashes[name] = {
      widgets: JSON.parse(JSON.stringify(FSYS.config.widgets || [])),
      radio: Radio.playing ? { key: Radio.station, label: Radio.label, vol: Math.round((Radio.audio ? Radio.audio.volume : 0.8) * 100) } : null,
      pane: Pane.view || null,
      /* STUDIO: el dash congela el look completo (paleta, fuente, radius, wall) */
      look: { accent: FSYS.config.accent, studio: JSON.parse(JSON.stringify(FSYS.config.studio || {})) },
      at: Date.now(),
    };
    saveStore(STORE_KEYS.cfg, FSYS.config);
    Term.printOut(`dash '${name}' guardado (${(dashes[name].widgets || []).length} widgets${dashes[name].radio ? " + radio" : ""}${dashes[name].pane ? " + panel" : ""})`, "ok");
  } else if (dashes[sub]) {
    const d = dashes[sub];
    WidgetLayer.reset();
    for (const w of d.widgets || []) { FSYS.config.widgets.push(w); WidgetLayer.mount(w); }
    WidgetLayer.persist();
    /* STUDIO: si el dash trae look propio, se aplica en vivo.
       Hex directo → STUDIO.gen (theme gen guarda hex, no nombres). */
    if (d.look && d.look.accent) {
      FSYS.config.accent = d.look.accent;
      if (THEMES[d.look.accent]) applyTheme(d.look.accent);
      else if (FSYS.config.userThemes && FSYS.config.userThemes[d.look.accent]) STUDIO.gen(FSYS.config.userThemes[d.look.accent]);
      else if (STUDIO.isHex(d.look.accent)) STUDIO.gen(d.look.accent);
      FSYS.config.studio = d.look.studio || {};
      Wall.apply(); STUDIO.applyTokens();
      saveStore(STORE_KEYS.cfg, FSYS.config);
    }
    if (d.pane) { Pane.show(d.pane); Pane.render(d.pane); }
    if (d.radio && d.radio.key) {
      const preset = Radio.PRESETS[d.radio.key];
      if (preset) Radio.play(d.radio.key, preset.url, d.radio.label).then(() => Radio.setVol(d.radio.vol || 80));
    }
    Term.printOut(`dash '${sub}' restaurado — ${(d.widgets || []).length} widgets${d.radio ? " + " + d.radio.label : ""}${d.pane ? " + panel " + d.pane : ""}`, "ok");
  } else if (sub === "list") {
    const names = Object.keys(dashes);
    if (!names.length) { Term.printOut("(sin dashes — armá tu escritorio y 'dash save <n>')", "dim"); return; }
    for (const n of names) {
      const d = dashes[n];
      Term.printOut(`  ${n.padEnd(14)} ${(d.widgets || []).length} widgets${d.radio ? " · ♪ " + d.radio.label : ""}${d.pane ? " · panel " + d.pane : ""}`, "out");
    }
  } else if (sub === "rm") {
    if (!dashes[name]) { Term.printErr(`no existe el dash: ${name || "(vacío)"}`); return; }
    delete dashes[name];
    saveStore(STORE_KEYS.cfg, FSYS.config);
    Term.printOut(`dash eliminado: ${name}`, "ok");
  } else if (sub === "export") {
    if (!name || !dashes[name]) { Term.printErr("uso: dash export <nombre>   ('dash list' para ver)"); return; }
    const d = dashes[name];
    /* Los wallpapers dataURL pesan — un rice exportable no arrastra megas */
    const clean = { v: 1, from: "FLOORP SYSTEM " + VERSION, widgets: d.widgets, radio: d.radio, pane: d.pane, look: { accent: d.look?.accent, studio: { ...(d.look?.studio || {}), grid: undefined } } };
    const json = JSON.stringify(clean);
    navigator.clipboard.writeText(json).then(() => {
      Term.printOut(`dash '${name}' → portapapeles (${Math.round(json.length / 1024)}KB) — pegalo donde quieras compartirlo`, "ok");
    }).catch(() => {
      Term.printOut("(no pude usar el portapapeles — copiá esto a mano):", "dim");
      Term.printOut(json, "out");
    });
  } else if (sub === "import") {
    navigator.clipboard.readText().then((raw) => {
      try {
        const d = JSON.parse(raw);
        if (!d || !Array.isArray(d.widgets)) { Term.printErr("el portapapeles no contiene un dash válido"); return; }
        const nn = name || ("importado-" + Math.random().toString(36).slice(2, 5));
        dashes[nn] = { ...d, look: d.look || {}, at: Date.now() };
        saveStore(STORE_KEYS.cfg, FSYS.config);
        Term.printOut(`dash '${nn}' importado (${d.widgets.length} widgets) — '${nn}' lo monta`, "ok");
      } catch (e) { Term.printErr("JSON inválido en el portapapeles"); }
    }).catch(() => Term.printErr("no pude leer el portapapeles — copiá el JSON primero"));
  } else Term.printErr("uso: dash <save <n> | <n> | list | rm <n> | export <n> | import [n]>");
});

/* ---- TAB MANAGER (BOOT 07) — solo comandos, sin panel visual.
   Todo opera sobre las tabs reales de Floorp vía el bridge. ---- */

/* Distancia Levenshtein para sugerir el subcomando correcto ante typos */
function lev(a, b) {
  const m = a.length, n = b.length;
  const d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] !== b[j - 1] ? 1 : 0));
  return d[m][n];
}

const Tabs = {
  TAB_SUBS: ["next", "prev", "go", "new", "close", "reload", "pin"],

  /* Mensaje de bridge offline: accionable en 2 líneas */
  needBridge() {
    Term.printErr("tab necesita el bridge ( extensión FLOORP SYSTEM )");
    Term.printOut("→ about:debugging#/runtime/this-firefox → Load Temporary Add-on → manifest.json", "dim");
  },

  async action(type, payload) {
    const res = await Bridge.call(type, payload).catch(() => null);
    if (!res || !res.ok) { Term.printErr(`BRIDGE: ${(res && res.error) || "sin respuesta"}`); return null; }
    return res;
  },

  async step(dir) {
    if (!Bridge.available) { this.needBridge(); return; }
    const res = await this.action("tab.step", { dir });
    if (res) Term.printOut(res.data.moved ? `tab activa → ${res.data.title}` : "(solo hay una tab)", "ok");
  },

  /* Atajo global: Alt+←/→ → tab prev/next (keyboard-first) */
  bindShortcuts() {
    document.addEventListener("keydown", (e) => {
      if (!e.altKey || e.ctrlKey || e.shiftKey) return;
      if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
      e.preventDefault();
      this.step(e.key === "ArrowRight" ? 1 : -1);
    });
  },
};

reg("tab", "Gestión de tabs reales ( comando tab next )", "tab <next|prev|go <n>|new [url]|close [n]|reload|pin>", (args) => {
  const sub = (args[0] || "").toLowerCase();

  if (!sub) { Term.printErr("uso: tab <next|prev|go <n>|new [url]|close [n]|reload|pin>"); return; }

  /* Primero validamos el subcomando (así el typo se sugiere siempre,
     haya bridge o no); después exigimos el bridge para ejecutar. */
  if (!Tabs.TAB_SUBS.includes(sub)) {
    let best = null, bestD = Infinity;
    for (const s of Tabs.TAB_SUBS) {
      const d = lev(sub, s);
      if (d < bestD) { bestD = d; best = s; }
    }
    Term.printErr(`tab: subcomando desconocido '${sub}'`);
    if (best && bestD <= Math.max(2, Math.floor(best.length / 2)))
      Term.printOut(`¿quisiste decir 'tab ${best}'?`, "dim");
    else
      Term.printOut(`subcomandos: ${Tabs.TAB_SUBS.join(" · ")}`, "dim");
    return;
  }

  /* new no requiere bridge: window.open es suficiente */
  if (sub === "new") {
    let url = args[1];
    if (url && !/^https?:\/\//.test(url)) url = "https://" + url;
    if (Bridge.available) {
      Tabs.action("tab.new", { url }).then((res) => {
        if (res) Term.printOut(`nueva tab abierta${url ? " → " + url : ""}`, "ok");
      });
    } else {
      window.open(url || "about:blank", "_blank");
      Term.printOut("nueva tab abierta", "ok");
    }
    return;
  }

  /* Todo lo demás requiere el bridge */
  if (!Bridge.available) { Tabs.needBridge(); return; }

  (async () => {
    if (sub === "next" || sub === "prev") {
      await Tabs.step(sub === "next" ? 1 : -1);
    } else if (sub === "go") {
      const n = parseInt(args[1], 10);
      if (!n || n < 1) { Term.printErr("uso: tab go <número>"); return; }
      const res = await Bridge.call("tab.list");
      if (!res || !res.ok) { Term.printErr((res && res.error) || "sin respuesta"); return; }
      const t = res.data[n - 1];
      if (!t) { Term.printErr(`no existe la tab ${n} (hay ${res.data.length})`); return; }
      await Bridge.call("tab.activate", { id: t.id });
      Term.printOut(`tab activa → ${t.title}`, "ok");
    } else if (sub === "close") {
      const resList = await Bridge.call("tab.list");
      if (!resList || !resList.ok) { Term.printErr((resList && resList.error) || "sin respuesta"); return; }
      let target;
      if (args[1]) {
        const n = parseInt(args[1], 10);
        target = resList.data[n - 1];
        if (!target) { Term.printErr(`no existe la tab ${n} (hay ${resList.data.length})`); return; }
      } else {
        target = resList.data.find((t) => t.active);
        if (!target) { Term.printErr("no hay tab activa"); return; }
      }
      await Bridge.call("tab.close", { id: target.id });
      Term.printOut(`tab cerrada → ${target.title}`, "ok");
    } else if (sub === "reload") {
      const resList = await Bridge.call("tab.list");
      if (!resList || !resList.ok) { Term.printErr((resList && resList.error) || "sin respuesta"); return; }
      const act = resList.data.find((t) => t.active);
      if (!act) { Term.printErr("no hay tab activa"); return; }
      await Bridge.call("tab.reload", { id: act.id });
      Term.printOut(`recargando → ${act.title}`, "ok");
    } else if (sub === "pin") {
      const resList = await Bridge.call("tab.list");
      if (!resList || !resList.ok) { Term.printErr((resList && resList.error) || "sin respuesta"); return; }
      const act = resList.data.find((t) => t.active);
      if (!act) { Term.printErr("no hay tab activa"); return; }
      const res = await Bridge.call("tab.pin", { id: act.id, pinned: !act.pinned });
      if (!res || !res.ok) { Term.printErr((res && res.error) || "sin respuesta"); return; }
      Term.printOut(res.data.pinned ? "tab fijada [#]" : "tab desfijada", "ok");
    } else {
      Term.printErr(`tab: subcomando desconocido '${sub}'`);
      Term.printOut(`subcomandos: ${Tabs.TAB_SUBS.join(" · ")}`, "dim");
    }
  })();
});

/* ---- ALIASES / CUSTOM ---- */
reg("alias", "Crear alias (sin args: lista)", "alias [<nombre> <comando+args>]", (args) => {
  /* Sin argumentos → listar, como una shell real */
  if (args.length === 0) {
    const names = Object.keys(FSYS.aliases);
    if (!names.length) { Term.printOut("(sin aliases)", "dim"); return; }
    for (const n of names) Term.printOut(`  ${n.padEnd(16)} → ${FSYS.aliases[n]}`, "out");
    return;
  }
  if (args.length < 2) {
    Term.printErr("uso: alias <nombre> <comando+args>");
    Term.printOut(`ejemplo: alias g google`, "dim");
    return;
  }
  const [name, ...rest] = args;
  /* Validación del nombre: evita aliases-URL u otros basura */
  if (!/^[a-z][a-z0-9_-]*$/i.test(name)) {
    Term.printErr(`nombre de alias inválido: '${name}' (usá letras, números, _ o -)`);
    return;
  }
  if (CommandEngine.registry.has(name)) {
    Term.printErr(`'${name}' es un comando nativo — elegí otro nombre`);
    return;
  }
  if (FSYS.customCommands[name]) {
    Term.printErr(`'${name}' ya es un comando custom — rmcmd ${name} primero`);
    return;
  }
  FSYS.aliases[name] = rest.join(" ");
  saveStore(STORE_KEYS.aliases, FSYS.aliases);
  Term.printOut(`alias creado: ${name} → ${FSYS.aliases[name]}`, "ok");
});

reg("aliases", "Lista los aliases", "aliases", () => {
  const names = Object.keys(FSYS.aliases);
  if (!names.length) { Term.printOut("(sin aliases)", "dim"); return; }
  for (const n of names) Term.printOut(`  ${n.padEnd(12)} → ${FSYS.aliases[n]}`, "out");
});

reg("unalias", "Elimina un alias", "unalias <nombre>", (args) => {
  if (FSYS.aliases[args[0]]) {
    delete FSYS.aliases[args[0]];
    saveStore(STORE_KEYS.aliases, FSYS.aliases);
    Term.printOut(`alias eliminado: ${args[0]}`, "ok");
  } else Term.printErr(args[0] ? `no existe el alias: ${args[0]}` : "uso: unalias <nombre>   ('alias' lista los tuyos)");
});

reg("mkcmd", "Crea un comando custom (sin args: guía)", "mkcmd [<nombre> <comando|url|texto>]", (args) => {
  /* Sin argumentos → guía con plantillas (cómo programar tus comandos) */
  if (args.length === 0) {
    CustomCommands.guide();
    return;
  }
  if (args.length < 2) {
    Term.printErr("uso: mkcmd <nombre> <comando|url|texto>   (o 'mkcmd' solo para la guía)");
    return;
  }
  CustomCommands.create(args[0], args.slice(1).join(" "));
});

reg("commands", "Lista los comandos custom", "commands", () => CustomCommands.list());

reg("rmcmd", "Elimina un comando custom", "rmcmd <nombre>", (args) => {
  if (!args[0]) { Term.printErr("uso: rmcmd <nombre>   ('commands' lista los tuyos)"); return; }
  CustomCommands.remove(args[0]);
});

/* ============ 7. AUTOCOMPLETE ============ */
const Autocomplete = {
  visible: false,
  items: [],
  selected: 0,
  _cache: { at: 0, items: [] },   /* snapshot de nombres — la lista cambia poco */

  /* Snapshot en vivo de nativos + aliases + customs */
  _all() {
    const now = Date.now();
    if (this._cache.at && now - this._cache.at < 4000) return this._cache.items;
    const items = [];
    for (const c of CommandEngine.registry.values()) items.push({ name: c.name, desc: c.description, type: "native" });
    for (const [a, target] of Object.entries(FSYS.aliases)) items.push({ name: a, desc: `→ ${target}`, type: "alias" });
    for (const [n] of Object.entries(FSYS.customCommands)) items.push({ name: n, desc: "(custom)", type: "custom" });
    this._cache = { at: now, items };
    return items;
  },

  forPrefix(prefix) {
    const p = prefix.toLowerCase();
    return this._all().filter((it) => it.name.startsWith(p));
  },

  show(items) {
    this.items = items;
    this.selected = 0;
    this.visible = true;
    const esc = (s) => String(s).replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));
    const box = document.getElementById("suggestions");
    box.innerHTML =
      `<div class="sug-head">COMMAND SUGGESTIONS</div>` +
      items.map((it, i) =>
        `<div class="sug${i === 0 ? " sel" : ""}" data-i="${i}">
           <span class="name">${esc(it.name)}</span>
           <span class="type">${esc(it.type)}</span>
           <span>${esc(it.desc)}</span>
         </div>`).join("");
    box.hidden = false;
    /* Delegación: UN solo listener en el contenedor (permanente),
       no uno por fila en cada render (fuga de listeners). */
    if (!box.dataset.bound) {
      box.addEventListener("mousedown", (e) => {
        const row = e.target.closest(".sug");
        if (!row) return;
        e.preventDefault();
        Autocomplete.pick(parseInt(row.dataset.i, 10));
      });
      box.dataset.bound = "1";
    }
  },

  hide() {
    this.visible = false;
    document.getElementById("suggestions").hidden = true;
  },

  move(dir) {
    if (!this.visible) return;
    this.selected = (this.selected + dir + this.items.length) % this.items.length;
    const els = document.querySelectorAll("#suggestions .sug");
    els.forEach((el, i) => el.classList.toggle("sel", i === this.selected));
    /* El scroll del widget acompaña a la selección */
    const selEl = els[this.selected];
    if (selEl && selEl.scrollIntoView) selEl.scrollIntoView({ block: "nearest" });
  },

  apply() {
    const item = this.items[this.selected];
    if (!item) return;
    /* Nivel 2 (item.tail definido): reconstruye head+sub+args — los
       argumentos que el usuario ya escribió se conservan intactos. */
    if (item.tail !== undefined) Term.setInput(item.name + (item.tail ? " " + item.tail : ""));
    else Term.setInput(item.name + " ");
    this.hide();
  },

  pick(i) { this.selected = i; this.apply(); },
};

/* Subcomandos para el TAB de segundo nivel (spec §7):
   'tab ' + TAB sugiere next/prev/go…, 'ai ' sugiere status/ask… */
const SUBCOMMANDS = {
  tab: ["next", "prev", "go", "new", "close", "reload", "pin"],
  ws: ["list", "next", "prev", "save", "add", "rename", "enable", "doctor", "create", "close"],
  ai: ["status", "ask", "models", "use"],
  config: ["accent", "studio", "wall", "blur", "perf", "user", "host", "boot", "watchdog"],
  file: ["list", "write", "open"],
  auto: ["status", "on", "off", "run"],
  vault: ["save", "load", "list", "rm"],
  startup: ["add", "list", "rm", "run", "clear"],
  snip: ["add", "list", "rm"],
  webapp: ["add", "list", "rm"],
  layout: ["full", "split"],
  watchdog: ["on", "off", "status"],
  pane: ["notes", "vault", "tabs", "help", "top", "off"],
  radio: ["lofi", "jazz", "techno", "synthwave", "classical", "space", "file", "vol", "bars", "status", "stop"],
  weather: [], crypto: ["btc", "eth", "sol", "doge"], dict: [], ip: [], news: ["open"],
  widget: ["add", "cfg", "rm", "list", "reset"], dash: ["save", "list", "rm", "export", "import"],
  theme: ["gen", "make", "list", "rm"], wall: ["set", "dim", "blur", "off"],
  blur: ["terminal", "widgets", "off"], perf: ["low", "status"],
};

/* ============ 8. TERMINAL (UI) ============ */
const Term = {
  input: null, mirror: null, caret: null, out: null, line: null,

  init() {
    this.input  = document.getElementById("term-input");
    this.mirror = document.getElementById("term-mirror");
    this.caret  = document.getElementById("term-caret");
    this.out    = document.getElementById("term-out");
    this.line   = document.getElementById("term-line");
    this.tile   = document.getElementById("terminal");
    updatePrompt();

    /* Smart focus: hover entra con focus preventivo; click entra y
       saca el foco de otro input si lo hubiera. El foco NO se roba
       mientras el usuario escribe en otro campo (mouseleave no hace blur). */
    const term = this.tile;
    term.addEventListener("mouseenter", () => {
      /* Guard anti-robo-de-foco: si el usuario está escribiendo en la
         palette (u otro input), el hover NO toca el foco. */
      const other = document.activeElement;
      const busy = other && other !== document.body &&
                   (other.tagName === "INPUT" || other.tagName === "TEXTAREA" ||
                    other.isContentEditable);
      if (busy) { this.setFocused(false); return; }
      this.focus({ preventScroll: true });
      this.setFocused(document.activeElement === this.input);
    });
    term.addEventListener("click", (e) => {
      if (!e.target.closest("#suggestions")) this.input.focus({ preventScroll: true });
    });

    /* Al escribir: espejo + si aparece un espacio (ya se tipea el argumento)
       o se vacía, el widget de sugerencias se cierra. Evita que un TAB
       posterior reemplace una línea a mitad de escritura. */
    this.input.addEventListener("input", () => {
      this.render();
      const v = this.input.value;
      if (Autocomplete.visible && (/\s/.test(v) || v === "")) Autocomplete.hide();
    });
    this.input.addEventListener("focus", () => this.setFocused(true));
    this.input.addEventListener("blur", () => this.setFocused(false));
    this.input.addEventListener("keydown", (e) => this.onKey(e));

    /* Keyboard-first: cualquier tecla imprimible va a la terminal.
       EXCEPCIÓN: si la command palette está abierta, es SU momento. */
    document.addEventListener("keydown", (e) => {
      const other = document.activeElement;
      const busy = other && other !== document.body &&
                   (other.tagName === "INPUT" || other.tagName === "TEXTAREA" ||
                    other.isContentEditable);
      const paletteOpen = typeof Palette !== "undefined" && Palette.open;
      if (busy || paletteOpen || e.ctrlKey || e.altKey || e.metaKey) return;
      if (e.key.length === 1 || e.key === "Backspace" || e.key === "Enter") {
        if (document.activeElement !== this.input) this.focus();
      }
      if (e.key === "Escape") Autocomplete.hide();
    });

    this.render();
  },

  /* Atajos globales de la home (BOOT 06/07): workspaces y tabs */
  _bindShortcuts() {
    document.addEventListener("keydown", (e) => {
      /* Alt+1..9 → workspace n (estilo Hyprland) */
      if (e.altKey && !e.ctrlKey && !e.shiftKey && e.key >= "1" && e.key <= "9") {
        const n = parseInt(e.key, 10);
        if (n <= FSYS.workspaces.length) {
          e.preventDefault();
          Workspaces.switchTo(n);
        }
        return;
      }
      /* Ctrl+Alt+←/→ → workspace prev/next */
      if (e.ctrlKey && e.altKey && (e.key === "ArrowRight" || e.key === "ArrowLeft")) {
        e.preventDefault();
        if (Bridge.available) {
          Bridge.call("ws.step", { dir: e.key === "ArrowRight" ? 1 : -1 }).then((res) => {
            if (res && res.ok) {
              Workspaces.syncFromBridge().catch(() => {});
              Workspaces.renderBar();
            }
          });
        } else {
          const n = FSYS.workspaces.length;
          const dir = e.key === "ArrowRight" ? 1 : -1;
          Workspaces.switchTo(((Workspaces.activeId - 1 + dir + n) % n) + 1);
        }
      }
    });
  },

  focus(opts = { preventScroll: true }) { this.input.focus(opts); },

  setFocused(on) {
    this.tile.classList.toggle("focused", on);
  },

  render() {
    this.mirror.textContent = this.input.value;
    /* El texto acompaña al cursor: sin esto, un comando más ancho que el
       tile se corta por la izquierda y el caret desaparece de la vista. */
    this.line.scrollLeft = this.line.scrollWidth;
  },

  setInput(v) {
    this.input.value = v;
    this.render();
    this.input.focus({ preventScroll: true });
  },

  printOut(text, cls = "out") {
    this._emit(div => { div.className = cls; div.textContent = text; });
  },

  printCmd(line) {
    this._emit(div => {
      div.className = "cmd";
      const b = document.createElement("b");
      b.textContent = `${FSYS.settings.user}@${FSYS.settings.host}:~$ `;
      div.appendChild(b);
      div.appendChild(document.createTextNode(line));
    });
  },

  printErr(text) { this.printOut(text, "err"); },

  /* Emisión a un panel destino ("term" | "pane") — BOOT 13 tiling.
     Mismo pipeline (auto-scroll inteligente + cap FIFO) por panel. */
  printTo(pane, text, cls = "out") {
    const target = pane === "pane" && typeof Pane !== "undefined" && Pane.out ? Pane.out : this.out;
    const div = document.createElement("div");
    div.className = cls;
    div.textContent = text;
    target.appendChild(div);
    const atBottom = target.scrollHeight - target.scrollTop - target.clientHeight < 60;
    if (atBottom) target.scrollTop = target.scrollHeight;
    while (target.childElementCount > 600) target.removeChild(target.firstElementChild);
  },

  /* Punto único de emisión: crea el nodo, lo agrega, auto-scroll
     inteligente y PODA FIFO. Una terminal activa acumula miles de
     nodos (reloj incluido) — sin cap, el layout crece sin límite
     y cada scroll de re-pintado cuesta más RAM y CPU. */
  _emit(fill) {
    const div = document.createElement("div");
    fill(div);
    this.out.appendChild(div);
    /* Auto-scroll solo si el usuario ya está al fondo: no yankear
       el scroll mientras lee el historial. */
    const o = this.out;
    const atBottom = o.scrollHeight - o.scrollTop - o.clientHeight < 60;
    if (atBottom) o.scrollTop = o.scrollHeight;
    /* Cap de nodos: FIFO, fuera los más viejos (el usuario nunca
       nota el recorte porque queda fuera del viewport). */
    while (o.childElementCount > 600) o.removeChild(o.firstElementChild);
  },

  clear() {
    if (typeof stopLiveWidgets === "function") stopLiveWidgets();
    this.out.innerHTML = "";
  },

  onKey(e) {
    /* Enter → ejecutar */
    if (e.key === "Enter") {
      e.preventDefault();
      const line = this.input.value;
      this.printCmd(line);
      if (line.trim()) {
        /* Dedup: si repite el último comando, no duplicar entrada */
        if (FSYS.history[FSYS.history.length - 1] !== line.trim()) {
          FSYS.history.push(line.trim());
          if (FSYS.history.length > 200) FSYS.history.shift();
          saveStore(STORE_KEYS.hist, FSYS.history);
        }
        CommandEngine.execute(line.trim());
      }
      this.setInput("");
      this.historyIndex = FSYS.history.length;
      Autocomplete.hide();
      return;
    }

    /* TAB → autocomplete (nivel 1: comandos · nivel 2: subcomandos/apps) */
    if (e.key === "Tab") {
      e.preventDefault();
      if (Autocomplete.visible) { Autocomplete.apply(); return; }
      const value = this.input.value;

      /* Nivel 2: "cmd " ya escrito → subcomandos del comando o apps.
         Los aliases resuelven a su destino: 't ' + TAB sugiere como 'tab'.
         Los ARGUMENTOS ya tipeados (tail) JAMÁS se destruyen:
         'tab g 3' + TAB → 'tab go 3' (completa en su lugar). */
      if (/\S\s/.test(value)) {
        const toks = value.trim().split(/\s+/);
        const head0 = toks[0].toLowerCase();
        const r = CommandEngine.resolve(head0);
        const head = (r && r.kind === "alias") ? FSYS.aliases[head0].split(/\s+/)[0].toLowerCase() : head0;
        let typed = toks[1] || "";
        let tail = toks.slice(2).join(" ");
        let mid = "";
        let subs = null, subDesc = `subcomando de ${head}`;
        /* Nivel 3: 'widget add ' / 'auto on ' + TAB sugiere el tercer token.
           El prefijo a completar vive en toks[2], no en toks[1]. */
        if (head === "widget" && typed === "add") {
          subs = WidgetLayer.TYPES.slice();
          subDesc = "tipo de widget";
          mid = "add";
          typed = toks[2] || "";
          tail = toks.slice(3).join(" ");
        }
        else if (head === "auto" && (typed === "on" || typed === "off")) {
          /* Nivel 3: 'auto on ' + TAB sugiere las reglas de automatización */
          subs = Object.keys(AUTO_RULES);
          subDesc = "regla de automatización";
          mid = typed;
          typed = toks[2] || "";
          tail = toks.slice(3).join(" ");
        }
        else if (SUBCOMMANDS[head]) subs = SUBCOMMANDS[head];
        else if (head === "open-app" || head === "rm-app") subs = [...AppsSys.registered].sort();
        else if (head === "unalias") { subs = Object.keys(FSYS.aliases).sort(); subDesc = "alias"; }
        else if (head === "rmcmd") {
          subs = Object.keys(FSYS.customCommands).sort();
          subDesc = "comando custom";
        } else if (head === "snip") {
          subs = Object.keys(Snips.all()).sort().concat(["add", "list", "rm"]);
          subDesc = "snippet";
        } else if (head === "help") {
          /* Dedup: si un alias/custom tapa a un nativo, un solo nombre */
          subs = [...new Set([...CommandEngine.registry.keys(),
                              ...Object.keys(FSYS.aliases),
                              ...Object.keys(FSYS.customCommands)])].sort();
          subDesc = "detalle de comando";
        }
        if (subs) {
          const matches = subs.filter((s) => s.startsWith(typed));
          /* mid: token intermedio de nivel 3 (add/on/off) — nunca se pierde.
             'auto on ba' + TAB → 'auto on battery ' (antes: 'auto battery'). */
          const build = (s) => `${head}${mid ? " " + mid : ""} ${s}${tail ? " " + tail : ""}`;
          const itemName = (s) => `${head}${mid ? " " + mid : ""} ${s}`;
          if (matches.length === 1) { Term.setInput(build(matches[0]) + (tail ? "" : " ")); return; }
          if (matches.length > 1) {
            Autocomplete.show(matches.map((s) => ({ name: itemName(s), desc: subDesc, type: "sub", tail })));
          }
        }
        return;
      }

      if (/\s/.test(value)) return;
      const items = Autocomplete.forPrefix(value);
      if (items.length === 1) { Term.setInput(items[0].name + " "); return; }
      if (items.length > 1) Autocomplete.show(items);
      return;
    }

    /* ↑ ↓ → historial o navegación de sugerencias */
    if (e.key === "ArrowUp") {
      e.preventDefault();
      if (Autocomplete.visible) { Autocomplete.move(-1); return; }
      if (!FSYS.history.length) return;
      if (this.historyIndex === -1) this.historyIndex = FSYS.history.length;
      if (this.historyIndex > 0) {
        this.historyIndex--;
        this.setInput(FSYS.history[this.historyIndex]);
      }
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (Autocomplete.visible) { Autocomplete.move(1); return; }
      if (this.historyIndex === -1) return;
      if (this.historyIndex < FSYS.history.length - 1) {
        this.historyIndex++;
        this.setInput(FSYS.history[this.historyIndex]);
      } else {
        this.historyIndex = FSYS.history.length;
        this.setInput("");
      }
      return;
    }

    /* Ctrl+L → limpiar terminal */
    if (e.ctrlKey && (e.key === "l" || e.key === "L")) {
      e.preventDefault();
      this.clear();
      return;
    }
    /* Ctrl+U → borrar la línea entera (estándar de toda shell) */
    if (e.ctrlKey && (e.key === "u" || e.key === "U")) {
      e.preventDefault();
      if (this.input.value) {
        this.printCmd(this.input.value + "^U");
        this.setInput("");
      }
      return;
    }
    /* Ctrl+C → cancelar línea (comportamiento de shell) */
    if (e.ctrlKey && (e.key === "c" || e.key === "C")) {
      e.preventDefault();
      if (this.input.value) {
        this.printCmd(this.input.value + "^C");
        this.setInput("");
      }
      this.historyIndex = FSYS.history.length;   /* ↓ no repite la línea cancelada */
      return;
    }

    /* ESC → cerrar sugerencias */
    if (e.key === "Escape") { Autocomplete.hide(); return; }
  },
};

/* ============ 9. BOOT SEQUENCE ============ */
const Boot = {
  lines: [
    "loading kernel interface...",
    "loading command engine...",
    "loading workspace manager...",
    "loading navigation...",
    "loading AI CORE...",
    "checking modules...",
  ],
  run() {
    const linesEl = document.getElementById("boot-lines");
    const okEl = document.getElementById("boot-ok");

    /* La vista activa la controla body[data-view] (CSS), nunca estilos inline. */
    const showHome = () => {
      document.body.dataset.view = "home";
      Term.focus();
    };

    /* Boot inteligente (spec §22): 'auto' = secuencia solo si pasaron
       >4h desde la última carga — cada Ctrl+T del día es inmediato.
       'on'/'off' fuerzan. Persistente: config boot <auto|on|off>. */
    const LAST = "fsys.lastBoot";
    const mode = FSYS.config.bootMode || "auto";
    const last = parseInt(localStorage.getItem(LAST) || "0", 10) || 0;
    const recent = Date.now() - last < 4 * 60 * 60 * 1000;
    try { localStorage.setItem(LAST, String(Date.now())); } catch (e) { /* privado */ }
    if (mode === "off" || (mode === "auto" && recent) || FSYS.settings.bootAnimation === false) {
      showHome();
      return false;
    }

    let i = 0;
    /* Rápido: ~120ms por línea, ~1s total */
    const t = setInterval(() => {
      if (i < this.lines.length) {
        const d = document.createElement("div");
        d.textContent = this.lines[i++];
        linesEl.appendChild(d);
      } else {
      clearInterval(t);
      okEl.classList.add("on");
      setTimeout(showHome, 450);
      }
    }, 130);
    return true;
  },
};

/* ============ 10. STATUS BAR (clock + net) ============ */
const StatusBar = {
  init() {
    const clock = document.getElementById("sb-clock");
    const net = document.getElementById("sb-net");
    const chkNet = document.getElementById("chk-net");
    const chkWs = document.getElementById("chk-ws");
    const chkTerm = document.getElementById("chk-term");

    const tick = () => {
      const d = new Date();
      clock.textContent =
        `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    };
    tick();
    setInterval(tick, 10000); /* cada 10s, no polling agresivo */

    const netUpdate = () => {
      const on = navigator.onLine;
      net.textContent = `NET ${on ? "●" : "○"}`;
      net.style.color = on ? "var(--accent)" : "var(--err)";
      /* El status bar refleja el estado real, nunca inventa */
      const state = document.getElementById("sb-state");
      if (on) { state.textContent = "SYSTEM ONLINE"; state.className = "ok"; }
      else    { state.textContent = "OFFLINE";      state.className = "bad"; }
      chkNet.textContent = on ? "ONLINE" : "OFFLINE";
      /* chk-ai lo administra AI.badge() — netUpdate no lo pisa */
      chkWs.textContent = Workspaces.activeLabel();
      chkTerm.textContent = "READY";
    };
    netUpdate();
    window.addEventListener("online", netUpdate);
    window.addEventListener("offline", netUpdate);

    /* Badge AI VIVO: re-chequeo cada 120s (1 llamada barata al background).
       Si el usuario abre Ollama DESPUÉS de cargar la tab, el badge
       prende solo — no hace falta recargar. */
    setInterval(() => { AI.badge(); }, 120000);

    /* Recordatorio fijado (pin): persistido, sobrevive recargas */
    const pinEl = document.getElementById("sb-pin");
    if (pinEl && FSYS.config.pin) pinEl.textContent = `@ ${FSYS.config.pin}`;

    /* Syscheck WORKSPACE siempre sincronizado, en TODOS los modos
       (LOCAL y bridge): un solo punto de actualización. */
    Bus.on("WORKSPACE_CHANGED", () => {
      chkWs.textContent = Workspaces.activeLabel();
    });
  },
};

/* ============ 11. INIT (handshake con el background antes de todo) ============ */
document.addEventListener("DOMContentLoaded", async () => {
  Term.init();
  StatusBar.init();
  Wall.apply();                 /* STUDIO: wallpaper persistido */
  STUDIO.applyTokens();         /* STUDIO: fuente/radius/scan/grid */

  /* BOOT 06: handshake con el cerebro de la extensión.
     Si no hay bridge, queda LOCAL y nada se rompe. */
  const sys = await Bridge.hello();
  const bridgeLabel = document.getElementById("term-bridge");
  if (bridgeLabel) bridgeLabel.textContent = `BRIDGE: ${Bridge.status}`;
  const vLabel = document.getElementById("term-version");
  if (vLabel) vLabel.textContent = `v${VERSION}`;
  if (sys) {
    Workspaces.mode = sys.mode || "SESSIONS";
    FSYS.workspaces = sys.workspaces.map((w) => ({ id: w.id, name: w.name, tabs: w.tabs, isSelected: w.isSelected }));
    Workspaces.activeId = sys.active;
  }
  if (sys && sys.osServer) {
    Term.printOut(`OS SERVER DE FLOORP: ONLINE (workspaces nativos integrados)`, "ok");
  }

  /* Detección de apps POR COMPUTADORA: el fsys-bridge reporta qué hay
     instalado y solo eso se registra como comando. */
  await AppsSys.syncAtBoot();
  if (Bridge.appsOnline) {
    Term.printOut(`FSYS-BRIDGE: ONLINE (${Bridge.appsCount} apps detectadas)`, "ok");
  }

  /* Hidratación de la shell (aliases/commands/history) desde el bridge;
     si es la primera vez, siembra los aliases por defecto (g → google). */
  await loadStoreHydrate();

  /* AI CORE: badge del status bar + estado honesto (sin bloquear el boot) */
  AI.badge();

  Term._bindShortcuts();
  Workspaces.init();
  Workspaces.startLiveSync();   /* v0.14: la barra sigue al workspace real de Floorp */
  Tabs.bindShortcuts();
  Pane.init();
  Palette.init();
  WidgetLayer.restore();   /* widgets flotantes persistidos (BOOT 14) */
  const animated = Boot.run();
  /* MOTD: bienvenida mínima que guía sin estorbar (spec §22) */
  setTimeout(() => {
    Term.printOut(`FLOORP SYSTEM v${VERSION} · sesión iniciada`, "dim");
    Term.printOut("'help' comandos por grupo · Ctrl+K palette · TAB autocompleta · ↑ historial", "dim");
    /* primera vez real: guía al 'setup' una sola vez (v0.18) */
    if (!FSYS.config.setupDone)
      Term.printOut("PRIMERA VEZ — 'setup' arma tu perfil: nombre, email, github, ciudad y backup", "ok");
    if (!Bridge.available)
      Term.printOut("modo LOCAL — workspaces y tabs reales necesitan la extensión (about:debugging)", "dim");
    else if (!Bridge.appsOnline)
      Term.printOut("fsys-bridge offline — 'start-bridge.bat' habilita apps, archivos y AI del SO", "dim");
  }, animated ? 1900 : 80);

  /* Cadena de arranque del usuario (spec BOOT 11): después del boot,
     sin bloquear la UI. Cada línea es un comando del engine. */
  setTimeout(async () => {
    const st = FSYS.config.startup || [];
    if (!st.length) return;
    Term.printOut(`STARTUP // ejecutando ${st.length} comando(s)`, "dim");
    for (const cmd of st) {
      Term.printCmd(cmd);
      try { CommandEngine.execute(cmd); } catch (e) { Term.printErr(`startup: ${e.message}`); }
      await new Promise((s) => setTimeout(s, 250));
    }
  }, animated ? 2200 : 400);

  /* Modo foco: si expiró mientras la tab estaba cerrada, restaurar YA */
  setTimeout(async () => {
    if (!Bridge.available) return;
    const chk = await Bridge.call("focus.check", {}, 5000).catch(() => null);
    if (chk && chk.ok && chk.data.expired) {
      Term.printOut(`FOCO TERMINADO${chk.data.label ? " (" + chk.data.label + ")" : ""} → ${chk.data.restored} tabs restauradas`, "ok");
      if (Bridge.available) Bridge.call("sys.notify", { title: "FLOORP SYSTEM", text: `Foco terminado — sesión restaurada` }, 5000).catch(() => {});
    }
  }, animated ? 2100 : 300);
});
