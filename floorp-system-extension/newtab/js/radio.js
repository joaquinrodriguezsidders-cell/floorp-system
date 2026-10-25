/* ============================================================
   FLOORP SYSTEM — newtab/js/radio.js   (RADIO 2.0)

   La home NO reproduce audio: manda sobre el motor del background,
   que es el que suena mientras navegás. Si el background no está
   disponible, usa la copia local del motor (modo degradado).

   Incluye:
     · Radio          → puente hacia el motor
     · RadioVisual    → espectro ASCII v2 (log, picos, espejo)
     · RadioDock      → barra fijada en la home
     · RadioCommands  → comandos de la terminal
   ============================================================ */
"use strict";

/* Emisoras de fábrica: referencia para dashboards viejos y para
   'radio lofi' aunque la biblioteca esté vacía. */
const RADIO_PRESETS = {
  lofi:      { name: "Groove Salad",    url: "https://ice1.somafm.com/groovesalad-128-mp3" },
  jazz:      { name: "Sonic Universe",  url: "https://ice1.somafm.com/sonicuniverse-128-mp3" },
  techno:    { name: "The Trip",        url: "https://ice1.somafm.com/thetrip-128-mp3" },
  synthwave: { name: "Underground 80s", url: "https://ice1.somafm.com/u80s-128-mp3" },
  classical: { name: "Cinematic",       url: "https://ice1.somafm.com/cinematic-128-mp3" },
  space:     { name: "Space Station",   url: "https://ice1.somafm.com/spacestation-128-mp3" },
};

const Radio = {
  PRESETS: RADIO_PRESETS,
  _last: null,

  /* El motor real. Se prefiere el del background: mismo objeto, mismo audio. */
  eng() {
    try {
      const bg = browser.extension.getBackgroundPage();
      if (bg && bg.RadioEngine) return bg.RadioEngine;
    } catch (e) { /* sin background */ }
    return typeof RadioEngine !== "undefined" ? RadioEngine : null;
  },

  ok() { return !!this.eng(); },

  snap() {
    const e = this.eng();
    if (!e) {
      return { playing: false, paused: false, station: null, vol: 80, loop: "off", shuffle: false, sleep: 0, tracks: [], index: 0, count: 0, track: "", total: 0, dock: false, blocked: false, error: "motor no disponible" };
    }
    try { return e.snapshot(); }
    catch (err) { return { playing: false, paused: false, station: null, vol: 80, loop: "off", shuffle: false, sleep: 0, tracks: [], index: 0, count: 0, track: "", total: 0, dock: false, blocked: false, error: err.message }; }
  },

  /* Compatibilidad: el resto del código lee estas propiedades */
  get playing() { return !!this.snap().playing; },
  get station() { const s = this.snap(); return s.station ? s.station.id : null; },
  get label() { const s = this.snap(); return s.track || (s.station ? s.station.name : ""); },
  get audio() { const e = this.eng(); return e ? e.audio : null; },

  badge() {
    const el = document.getElementById("sb-radio");
    if (!el) return;
    const s = this.snap();
    if (!s.station) { el.textContent = ""; return; }
    const sleep = s.sleep > 0 ? ` ☾${Math.ceil(s.sleep / 60)}` : "";
    el.textContent = `${s.playing ? "♪" : s.paused ? "❙❙" : "○"} ${s.station.name}${sleep}`;
    el.style.color = s.playing ? "var(--accent)" : "var(--dim)";
  },

  /* --- transporte --- */
  async play(ref, url, label) {
    const e = this.eng();
    if (!e) return { error: "el motor de radio no está disponible (recargá la extensión)" };
    try {
      /* Firma vieja: play(clave, url, etiqueta) */
      const res = url ? await e.playUrl(url, label || ref) : await e.play(ref);
      this._last = res;
      this.badge(); RadioDock.refresh();
      return res;
    } catch (err) { return { error: err.message }; }
  },

  async toggle() { const e = this.eng(); if (!e) return null; try { return await e.toggle(); } catch (err) { return { error: err.message }; } },
  async next() { const e = this.eng(); if (!e) return null; try { return await e.next(false); } catch (err) { return { error: err.message }; } },
  async prev() { const e = this.eng(); if (!e) return null; try { return await e.prev(); } catch (err) { return { error: err.message }; } },
  stop() { const e = this.eng(); if (!e) return; e.stop(); RadioVisual.detachAll(); this.badge(); RadioDock.refresh(); },
  pause() { const e = this.eng(); if (e) e.pause(); RadioDock.refresh(); this.badge(); },
  resume() { const e = this.eng(); if (e) e.resume(); RadioDock.refresh(); this.badge(); },
  setVol(v) { const e = this.eng(); if (!e) return false; e.setVol(v); RadioDock.refresh(); return true; },
  mute(v) { const e = this.eng(); if (e) e.mute(v); RadioDock.refresh(); },

  realSpectrum() {
    const e = this.eng();
    if (!e) return false;
    try { return e.realSpectrum(); } catch (err) { return false; }
  },

  bands(n) {
    const e = this.eng();
    if (!e) return { vals: new Array(n || 16).fill(0), real: false };
    try { return e.bands(n); } catch (err) { return { vals: new Array(n || 16).fill(0), real: false }; }
  },

  /* --- espectro en la terminal --- */
  bars(rows, opts) {
    const el = document.createElement("div");
    el.className = "live-clock radio-bars";
    Term.out.appendChild(el);
    RadioVisual.attach(el, { rows: rows || 2, ...(opts || {}) });
    const o = Term.out;
    if (o.scrollHeight - o.scrollTop - o.clientHeight < 60) o.scrollTop = o.scrollHeight;
    Term.printOut("espectro en vivo (se congela con tu próximo comando)", "dim");
  },

  /* --- archivos locales --- */
  _pendingFiles: null,
  async addFiles(name) {
    const e = this.eng();
    if (!e) return { error: "el motor de radio no está disponible" };
    const input = document.getElementById("radio-file");
    if (!input) return { error: "falta el selector de archivos" };
    if (!input.dataset.bound) {
      input.addEventListener("change", async () => {
        const files = Array.from(input.files || []);
        const target = Radio._pendingFiles;
        input.value = "";
        if (!files.length || !target) return;
        try {
          const st = await Radio.eng().addFiles(target, files);
          Term.printOut(`♪ radio '${st.name}' guardada con ${st.tracks.length} archivo(s)`, "ok");
          Term.printOut("los archivos locales hay que volver a elegirlos si reiniciás el navegador", "dim");
          await Radio.play(st.id);
        } catch (err) { Term.printErr("radio: " + err.message); }
      });
      input.dataset.bound = "1";
    }
    this._pendingFiles = name;
    Term.printOut(`elegí los archivos para '${name}'…`, "dim");
    input.click();
    return { pending: true };
  },

  async init() {
    if (!this.ok()) return;
    try { await this.eng().ensure(); } catch (e) { /* sigue */ }
    this.badge();
    RadioDock.init();
    try {
      browser.runtime.onMessage.addListener((m) => {
        if (m && m.type === "radio.event") { this.badge(); RadioDock.refresh(); }
      });
    } catch (e) { /* modo archivo local */ }
    /* El motor avisa por mensaje en cada cambio real; este ticker es
       solo una red de seguridad (y el conteo del temporizador). */
    setInterval(() => { this.badge(); RadioDock.refresh(); }, 4000);
  },
};

/* ============================================================
   ESPECTRO ASCII v2
   - reparto logarítmico de frecuencias (los graves ya no se comen todo)
   - pico que baja solo, por columna
   - modo espejo (simétrico) y de 1 a 8 filas
   - arreglado el índice fuera de rango del render anterior
   ============================================================ */
const RadioVisual = {
  els: [], raf: null,
  CH: " ▁▂▃▄▅▆▇█",

  attach(el, opts) {
    const o = typeof opts === "number" ? { rows: opts } : (opts || {});
    this.detachEl(el);
    el.__fsv = {
      rows: Math.max(1, Math.min(8, o.rows || 1)),
      cols: Math.max(6, Math.min(64, o.cols || 16)),
      mirror: !!o.mirror,
      peaks: [],
    };
    el.style.whiteSpace = "pre";
    this.els.push(el);
    this.start();
  },

  /* Al soltar un elemento hay que borrar su estado (__fsv): si queda
     pegado, el elemento parece "enganchado" y no se vuelve a montar. */
  detachEl(el) {
    const i = this.els.indexOf(el);
    if (i >= 0) this.els.splice(i, 1);
    if (el && el.__fsv) delete el.__fsv;
  },

  detachAll() {
    for (const el of this.els) if (el && el.__fsv) delete el.__fsv;
    this.els.length = 0;
    this.stop();
  },

  start() {
    if (this.raf) return;
    const tick = () => {
      /* El id se limpia ANTES de dibujar: si un frame falla, el bucle
         no queda "vivo" con un id muerto (eso congelaba el espectro). */
      this.raf = null;
      if (!this.els.length) return;
      try { this.draw(); } catch (e) { /* un frame malo no mata el resto */ }
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  },

  stop() { if (this.raf) { cancelAnimationFrame(this.raf); this.raf = null; } },

  render(st, vals, real) {
    const { rows, cols, mirror, peaks } = st;
    const lines = [];
    for (let r = rows - 1; r >= 0; r--) {
      let line = "";
      for (let i = 0; i < cols; i++) {
        const v = (vals[i] || 0) * rows;
        const fill = v - r;                      /* cuánto de esta fila está lleno */
        if (fill >= 1) line += "█";
        else if (fill <= 0) {
          const pk = (peaks[i] || 0) * rows - r; /* el pico deja una marca tenue */
          line += pk >= 0.8 ? "▔" : " ";
        } else line += this.CH[Math.max(1, Math.min(7, Math.round(fill * 8)))];
      }
      lines.push(mirror ? line + [...line].reverse().join("") : line);
    }
    if (rows >= 3) lines.push((real ? "ESPECTRO REAL" : "ESPECTRO VISUAL") + (Radio.playing ? "" : " — radio off"));
    return lines.join("\n");
  },

  draw() {
    for (const el of this.els) {
      if (!el.isConnected) { this.detachEl(el); continue; }
      const st = el.__fsv;
      if (!st) { this.detachEl(el); continue; }
      const { vals, real } = Radio.bands(st.cols);
      if (!st.peaks.length) st.peaks = vals.slice();
      for (let i = 0; i < st.cols; i++) {
        st.peaks[i] = Math.max(vals[i] || 0, (st.peaks[i] || 0) - 0.018);
      }
      el.textContent = this.render(st, vals, real);
    }
  },
};

/* ============================================================
   BARRA FIJADA EN LA HOME ("pin")
   Vive sobre la vista home y se queda ahí hasta que la saques.
   ============================================================ */
const RadioDock = {
  el: null, barEl: null, ready: false,

  init() {
    this.el = document.getElementById("radio-dock");
    if (!this.el) return;
    if (!this.el.dataset.bound) {
      this.el.dataset.bound = "1";
      const $ = (id) => document.getElementById(id);
      $("rd-prev").addEventListener("click", async () => { await Radio.prev(); this.refresh(); });
      $("rd-toggle").addEventListener("click", async () => { await Radio.toggle(); this.refresh(); });
      $("rd-next").addEventListener("click", async () => { await Radio.next(); this.refresh(); });
      $("rd-win").addEventListener("click", () => RadioCommands.openWindow());
      $("rd-x").addEventListener("click", () => RadioCommands.unpin());
      $("rd-vol").addEventListener("input", (e) => { Radio.setVol(Number(e.target.value)); });
      this.barEl = $("rd-bars");
    }
    this.ready = true;
    const pinned = !!Radio.snap().dock;
    this.el.hidden = !pinned;
    document.body.classList.toggle("has-dock", pinned);
    if (pinned) this._attachBars();
    this.refresh();
  },

  _attachBars() {
    if (!this.barEl) return;
    RadioVisual.attach(this.barEl, { rows: 1, cols: 12 });
  },

  async pin(on) {
    const e = Radio.eng();
    if (!e) { Term.printErr("el motor de radio no está disponible"); return false; }
    e.prefs.dock = on === undefined ? true : !!on;
    e.savePrefsSoon();
    if (this.el) this.el.hidden = !e.prefs.dock;
    document.body.classList.toggle("has-dock", !!e.prefs.dock);
    if (e.prefs.dock) this._attachBars();
    else RadioVisual.detachAll();
    this.refresh();
    return e.prefs.dock;
  },

  refresh() {
    if (!this.el || this.el.hidden) return;
    /* Si alguien soltó el espectro (radio stop detachAll), se reengancha solo */
    if (this.barEl && !this.barEl.__fsv) this._attachBars();
    const s = Radio.snap();
    const $ = (id) => document.getElementById(id);
    const name = $("rd-name");
    if (name) {
      name.textContent = s.station
        ? `${s.station.name}${s.track && s.track !== s.station.name ? " · " + s.track : ""}`
        : "radio apagada";
      name.style.color = s.playing ? "var(--accent)" : "var(--dim)";
    }
    const t = $("rd-toggle");
    if (t) t.textContent = s.playing ? "⏸" : "▶";
    const v = $("rd-vol");
    if (v && document.activeElement !== v) v.value = s.muted ? 0 : s.vol;
  },
};

/* ============================================================
   COMANDOS
   ============================================================ */
const RadioCommands = {
  HELP: [
    "radio                       estado y qué está sonando",
    "radio list                  biblioteca de emisoras",
    "radio play <nombre|#>       sintoniza una emisora",
    "radio <nombre|#|url>        atajo de 'radio play' (o suena una URL suelta)",
    "radio next | prev           cambia de pista",
    "radio pause | resume        pausa / sigue",
    "radio toggle                play/pausa",
    "radio stop                  apaga",
    "radio vol <0-100>           volumen",
    "radio mute                  silencio",
    "radio seek <mm:ss|%>        salta a un punto (pistas locales)",
    "radio loop <off|all|one>    repetir",
    "radio shuffle [on|off]      aleatorio",
    "radio sleep <min|off>       se apaga solo",
    "radio bars [1-8|off]        espectro en la terminal",
    "radio bars mirror           espectro simétrico",
    "radio add <n> <url>         crea una emisora (stream o web)",
    "radio files <n>             elige archivos locales para una emisora",
    "radio rm <n> | rename | fav | favs",
    "radio win [s|m|l]           ventana flotante (suena en cualquier pestaña)",
    "radio win close             cierra la ventana",
    "radio pin | unpin           barra fija en la home",
  ],

  async openWindow(size) {
    const e = Radio.eng();
    if (!e) { Term.printErr("el motor de radio no está disponible"); return; }
    try {
      const r = await e.openWindow(size);
      if (r && r.focused) Term.printOut("ventana de radio ya abierta — la traje al frente", "ok");
      else Term.printOut("ventana flotante abierta — sigue sonando aunque cambies de pestaña", "ok");
    } catch (err) { Term.printErr("radio: " + err.message); }
  },

  async unpin() {
    await RadioDock.pin(false);
    Term.printOut("barra de radio sacada de la home", "ok");
  },

  async playRef(ref) {
    const res = await Radio.play(ref);
    if (!res) { Term.printErr("radio: motor no disponible"); return; }
    if (res.error) { Term.printErr("radio: " + res.error); return; }
    if (res.web) {
      Term.printOut(`♪ ${res.station} — emisora web, suena en la ventana flotante`, "ok");
      await this.openWindow("m");
      return;
    }
    Term.printOut(`♪ ON AIR: ${res.station}${res.track && res.track !== res.station ? " — " + res.track : ""}`, "ok");
    Radio.badge(); RadioDock.refresh();
  },

  async status() {
    const s = Radio.snap();
    if (!Radio.ok()) {
      Term.printErr("radio: el motor no está disponible (recargá la extensión en about:debugging)");
      return;
    }
    if (s.playing) {
      Term.printOut(`RADIO // ♪ ON AIR: ${s.station.name} — ${s.track || "(stream)"}  ${s.muted ? "MUDO" : s.vol + "%"}`, "ok");
    } else if (s.paused && s.station) {
      Term.printOut(`RADIO // ❙❙ EN PAUSA: ${s.station.name}  ${s.vol}%`, "out");
    } else {
      Term.printOut("RADIO // OFF", "out");
    }
    const flags = [s.loop !== "off" ? "loop " + s.loop : "", s.shuffle ? "aleatorio" : "", s.sleep > 0 ? `se apaga en ${Math.ceil(s.sleep / 60)}m` : "", s.dock ? "fijada en la home" : ""].filter(Boolean);
    Term.printOut(`${s.total} emisoras${flags.length ? " · " + flags.join(" · ") : ""}`, "dim");
    if (s.blocked) Term.printErr("el navegador bloqueó el audio: abrí la ventana con 'radio win' y dale play ahí");
    Term.printOut("'radio help' lista todo · 'radio list' la biblioteca", "dim");
  },

  async list() {
    const e = Radio.eng();
    if (!e) { Term.printErr("radio: motor no disponible"); return; }
    let list = [];
    try { list = e.list(); } catch (err) { Term.printErr("radio: " + err.message); return; }
    if (!list.length) { Term.printOut("(biblioteca vacía) — 'radio add <nombre> <url>'", "dim"); return; }
    const cur = Radio.station;
    Term.printOut(`RADIO // ${list.length} emisoras`, "ok");
    list.forEach((st, i) => {
      const mk = st.id === cur ? "♪" : " ";
      const fav = st.fav ? "★" : " ";
      const kind = st.kind === "web" ? "web" : st.kind === "file" ? "arch" : "stream";
      const n = st.tracks.length;
      const played = st.plays ? ` ${st.plays}×` : "";
      Term.printOut(`  ${mk}${fav} ${String(i + 1).padStart(2)} ${st.name.padEnd(18)} ${kind.padEnd(6)} ${n} pista${n === 1 ? "" : "s"}${played}`, st.id === cur ? "ok" : "out");
    });
    Term.printOut("'radio <nombre|#>' sintoniza · 'radio fav <nombre>' la marca", "dim");
  },

  async save(actions) {
    try { await actions(); } catch (err) { Term.printErr("radio: " + err.message); }
  },

  async run(args) {
    const sub = (args[0] || "").toLowerCase();
    const e = Radio.eng();

    if (!sub || sub === "status") return this.status();
    if (sub === "help" || sub === "-h" || sub === "?") {
      Term.printOut("FLOORP RADIO — comandos", "ok");
      for (const line of this.HELP) Term.printOut("  " + line, "out");
      return;
    }
    if (sub === "list" || sub === "ls") return this.list();
    if (sub === "favs") {
      const st = e ? e.favorite() : [];
      if (!st.length) { Term.printOut("(sin favoritas — 'radio fav <nombre>')", "dim"); return; }
      st.forEach((s) => Term.printOut(`  ★ ${s.name}`, "out"));
      return;
    }

    if (!e) { Term.printErr("radio: el motor no está disponible (recargá la extensión)"); return; }

    /* --- transporte --- */
    if (sub === "stop" || sub === "off") { Radio.stop(); Term.printOut("radio apagada", "ok"); return; }
    if (sub === "pause") {
      const sonaba = Radio.snap().playing;
      Radio.pause();
      Term.printOut(sonaba ? "radio en pausa" : "no hay nada sonando", sonaba ? "ok" : "dim");
      return;
    }
    if (sub === "play" && !args[1]) { Term.printErr("uso: radio play <nombre|#>   ('radio list' para ver la biblioteca)"); return; }
    if (sub === "resume") { Radio.resume(); Term.printOut("radio sigue", "ok"); return; }
    if (sub === "toggle") { await Radio.toggle(); this.status(); return; }
    if (sub === "next") { const r = await Radio.next(); if (r && r.error) Term.printErr("radio: " + r.error); else Term.printOut("♪ " + Radio.label, "ok"); return; }
    if (sub === "prev") { const r = await Radio.prev(); if (r && r.error) Term.printErr("radio: " + r.error); else Term.printOut("♪ " + Radio.label, "ok"); return; }

    if (sub === "vol" || sub === "volume") {
      const v = parseInt(args[1], 10);
      if (isNaN(v) || v < 0 || v > 100) { Term.printErr("uso: radio vol <0-100>"); return; }
      Radio.setVol(v);
      Term.printOut(`volumen → ${v}%`, "ok");
      return;
    }
    if (sub === "mute") { const m = Radio.mute(); Term.printOut(m ? "silencio" : "sonido", "ok"); return; }

    if (sub === "seek") {
      const raw = (args[1] || "").trim();
      if (!raw) { Term.printErr("uso: radio seek <mm:ss | 90 | 50%>"); return; }
      if (raw.endsWith("%")) { e.seekPct(parseFloat(raw)); Term.printOut(`→ ${raw}`, "ok"); return; }
      const parts = raw.split(":").map(Number);
      const sec = parts.length === 2 ? parts[0] * 60 + parts[1] : parts[0];
      if (!e.seek(sec)) { Term.printErr("esa emisora no permite saltar (es un stream en vivo)"); return; }
      Term.printOut(`→ ${raw}`, "ok");
      return;
    }

    if (sub === "loop") {
      const m = (args[1] || "").toLowerCase();
      if (!["off", "all", "one"].includes(m)) { Term.printErr("uso: radio loop <off|all|one>"); return; }
      e.setLoop(m);
      Term.printOut(`repetir: ${m}`, "ok");
      return;
    }
    if (sub === "shuffle") {
      const on = (args[1] || "").toLowerCase();
      e.setShuffle(on === "on" ? true : on === "off" ? false : undefined);
      Term.printOut(`aleatorio: ${e.prefs.shuffle ? "on" : "off"}`, "ok");
      return;
    }
    if (sub === "sleep") {
      const v = (args[1] || "").toLowerCase();
      const min = v === "off" ? 0 : parseInt(v, 10);
      if (isNaN(min) || min < 0) { Term.printErr("uso: radio sleep <minutos|off>"); return; }
      e.sleep(min);
      Term.printOut(min ? `la radio se apaga en ${min} min` : "temporizador cancelado", "ok");
      return;
    }

    if (sub === "bars") {
      const a = (args[1] || "").toLowerCase();
      if (a === "off") { RadioVisual.detachAll(); Term.printOut("espectro apagado", "ok"); return; }
      if (a === "mirror") { Radio.bars(2, { mirror: true }); Term.printOut("espectro en espejo: 'radio bars' normal lo desactiva", "dim"); return; }
      const rows = a ? parseInt(a, 10) : 2;
      if (isNaN(rows) || rows < 1 || rows > 8) { Term.printErr("uso: radio bars [1-8|off|mirror]"); return; }
      Radio.bars(rows);
      return;
    }

    /* --- ventana / pin --- */
    if (sub === "win" || sub === "window") {
      if ((args[1] || "").toLowerCase() === "close") {
        await e.closeWindow();
        Term.printOut("ventana de radio cerrada", "ok");
        return;
      }
      return this.openWindow((args[1] || "m").toLowerCase());
    }
    if (sub === "pin") { const on = await RadioDock.pin(true); Term.printOut(on ? "barra de radio fijada en la home" : "no pude fijarla", "ok"); return; }
    if (sub === "unpin") return this.unpin();

    /* --- biblioteca --- */
    if (sub === "add" || sub === "new") {
      const name = args[1];
      let rest = args.slice(2);
      let kindHint = null;
      const h = (rest[0] || "").toLowerCase();
      if (["spotify", "youtube", "yt", "web", "soundcloud"].includes(h)) {
        kindHint = "web";
        rest = rest.slice(1);
      } else if (["stream", "radio"].includes(h)) {
        kindHint = "stream";
        rest = rest.slice(1);
      } else if (h === "file" || h === "files") {
        if (!name) { Term.printErr("uso: radio add <nombre> file"); return; }
        return Radio.addFiles(name);
      }
      const url = rest.join(" ").trim();
      if (!name || !url) { Term.printErr("uso: radio add <nombre> <url>   ·   radio add <nombre> file"); return; }
      await this.save(async () => {
        const st = await e.add(name, url, kindHint);
        const kind = st.kind === "web" ? "emisora web (suena en la ventana flotante)" : "stream";
        Term.printOut(`radio '${st.name}' creada — ${kind}`, "ok");
        Term.printOut(`'radio ${st.name}' la sintoniza`, "dim");
      });
      return;
    }

    if (sub === "files" || sub === "file") {
      const name = args[1];
      if (!name) { Term.printErr("uso: radio files <nombre>"); return; }
      return Radio.addFiles(name);
    }

    if (sub === "rm" || sub === "remove" || sub === "del") {
      const ref = args.slice(1).join(" ");
      if (!ref) { Term.printErr("uso: radio rm <nombre>"); return; }
      await this.save(async () => {
        const st = await e.remove(ref);
        Term.printOut(`radio '${st.name}' eliminada`, "ok");
      });
      return;
    }

    if (sub === "rename" || sub === "mv") {
      const nuevo = args[args.length - 1];
      const viejo = args.slice(1, -1).join(" ");
      if (!viejo || !nuevo) { Term.printErr("uso: radio rename <viejo> <nuevo>"); return; }
      await this.save(async () => {
        const st = await e.rename(viejo, nuevo);
        Term.printOut(`ahora se llama '${st.name}'`, "ok");
      });
      return;
    }

    if (sub === "fav" || sub === "star") {
      const ref = args.slice(1).join(" ");
      if (!ref) { Term.printErr("uso: radio fav <nombre>"); return; }
      await this.save(async () => {
        const st = await e.star(ref);
        Term.printOut(`${st.fav ? "★" : "☆"} ${st.name}`, "ok");
      });
      return;
    }

    /* --- atajo: 'radio <nombre>' / 'radio <#> / radio <url>' --- */
    if (sub === "play") {
      const ref = args.slice(1).join(" ");
      if (!ref) { Term.printErr("uso: radio play <nombre|#>"); return; }
      return this.playRef(ref);
    }

    const ref = args.join(" ");
    if (/^https?:\/\//i.test(ref)) {
      Term.printOut("conectando stream…", "dim");
      return this.playRef(ref);
    }
    const found = e.find(ref);
    if (!found) {
      Term.printErr(`no existe la radio '${ref}' — 'radio list' o 'radio add <nombre> <url>'`);
      if (Radio.PRESETS[ref.toLowerCase()]) {
        Term.printOut(`(preset de fábrica: 'radio add ${ref} ${Radio.PRESETS[ref.toLowerCase()].url}')`, "dim");
      }
      return;
    }
    return this.playRef(found.id);
  },

  register() {
    if (typeof reg !== "function") return;
    reg("radio",
      "Radio: biblioteca de emisoras, stream/web/archivos, ventana flotante",
      "radio [list|play <n>|add <n> <url>|files <n>|win|pin|vol|bars|sleep|loop|shuffle|stop|help]",
      (args) => { RadioCommands.run(args); });
  },
};
