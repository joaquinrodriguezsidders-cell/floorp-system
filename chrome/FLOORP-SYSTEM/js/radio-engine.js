/* ============================================================
   FLOORP SYSTEM — background/radio.js   (RADIO 2.0, v0.19)

   El motor vive en la página de background (persistente) para que
   el audio siga sonando al cambiar de pestaña o navegar.

   Este mismo archivo se carga también en la home y en la ventana
   flotante: allí detecta que NO es el background y queda inerte,
   como respaldo si `getBackgroundPage()` no está disponible.

   Tipos de emisora:
     stream  URL de audio directa (mp3/aac/ogg/opus...) → <audio>
     web     Spotify / YouTube / SoundCloud / Bandcamp    → <iframe>
     file    archivos locales elegidos por el usuario     → <audio>
   ============================================================ */
"use strict";

const RADIO_STORE = { stations: "fsys.radio.stations", prefs: "fsys.radio.prefs" };
const RADIO_MIME = /\.(mp3|m4a|aac|ogg|oga|opus|flac|wav|webm)(\?|#|$)/i;

/* Emisoras de fábrica: solo la primera vez (después manda tu biblioteca) */
const RADIO_SEED = [
  { name: "lofi", kind: "stream", tracks: [{ title: "Groove Salad", url: "https://ice1.somafm.com/groovesalad-128-mp3" }] },
  { name: "jazz", kind: "stream", tracks: [{ title: "Sonic Universe", url: "https://ice1.somafm.com/sonicuniverse-128-mp3" }] },
  { name: "techno", kind: "stream", tracks: [{ title: "The Trip", url: "https://ice1.somafm.com/thetrip-128-mp3" }] },
  { name: "synthwave", kind: "stream", tracks: [{ title: "Underground 80s", url: "https://ice1.somafm.com/u80s-128-mp3" }] },
  { name: "classical", kind: "stream", tracks: [{ title: "Cinematic", url: "https://ice1.somafm.com/cinematic-128-mp3" }] },
  { name: "space", kind: "stream", tracks: [{ title: "Space Station", url: "https://ice1.somafm.com/spacestation-128-mp3" }] },
];

const RadioEngine = {
  /* --- audio --- */
  audio: null, ctx: null, analyser: null, srcNode: null, hooked: false,
  /* --- datos --- */
  stations: [], prefs: null, state: null,
  /* --- internos --- */
  _ready: null, _winId: null, _sleepTimer: null, _sleepEnd: 0,
  _prev: null, _phase: 0, _saveT: null, _blocked: false, _err: null,

  /* ============ 0. contexto ============ */
  /* ¿Estamos en la página de background? (solo ahí se inicializa solo) */
  isBackground() {
    try {
      return !!(typeof browser !== "undefined" && browser.extension &&
                browser.extension.getBackgroundPage && browser.extension.getBackgroundPage() === window);
    } catch (e) { return false; }
  },

  /* ============ 1. persistencia ============ */
  async _storeGet(key, fallback) {
    try {
      if (typeof browser !== "undefined" && browser.storage && browser.storage.local) {
        const r = await browser.storage.local.get(key);
        if (r && r[key] != null) return r[key];
        return fallback;
      }
    } catch (e) { /* sigue */ }
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) { return fallback; }
  },

  async _storeSet(key, value) {
    try {
      if (typeof browser !== "undefined" && browser.storage && browser.storage.local) {
        await browser.storage.local.set({ [key]: value });
        return;
      }
    } catch (e) { /* sigue */ }
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* privado */ }
  },

  async ensure() {
    if (!this._ready) this._ready = this._init();
    return this._ready;
  },

  async _init() {
    const rawPrefs = (await this._storeGet(RADIO_STORE.prefs, null)) || {};
    this.prefs = {
      vol: typeof rawPrefs.vol === "number" ? rawPrefs.vol : 80,
      muted: !!rawPrefs.muted,
      loop: rawPrefs.loop === "all" || rawPrefs.loop === "one" ? rawPrefs.loop : "off",
      shuffle: !!rawPrefs.shuffle,
      last: rawPrefs.last || null,
      dock: !!rawPrefs.dock,
      win: rawPrefs.win || null,
      seeded: !!rawPrefs.seeded,
    };

    let list = await this._storeGet(RADIO_STORE.stations, null);
    if (!Array.isArray(list)) list = [];
    /* Primera vez: siembra las de fábrica una sola vez. Si después las
       borrás, no vuelven (queda `seeded`). */
    if (!this.prefs.seeded) {
      for (const s of RADIO_SEED) if (!list.some((x) => x.name === s.name)) list.push(this._mkStation(s.name, s.kind, s.tracks));
      this.prefs.seeded = true;
      await this._storeSet(RADIO_STORE.prefs, this.prefs);
      await this._storeSet(RADIO_STORE.stations, list);
    }
    this.stations = list.map((s) => this._normalize(s));
    this.state = {
      playing: false, paused: false, stationId: this.prefs.last || null,
      index: 0, error: null,
    };
    return this;
  },

  _mkStation(name, kind, tracks, extra) {
    return {
      id: "st" + Math.random().toString(36).slice(2, 8),
      name: String(name || "").trim().slice(0, 32),
      kind,
      tracks: (tracks || []).map((t) => ({ title: String(t.title || "").slice(0, 90), url: t.url || "" })),
      fav: false,
      plays: 0,
      created: Date.now(),
      ...(extra || {}),
    };
  },

  /* Al cargar desde disco, las pistas locales pierden su blob URL:
     se marcan `stale` para pedirlas de nuevo con un mensaje claro. */
  _normalize(s) {
    const kind = ["stream", "web", "file"].includes(s.kind) ? s.kind : "stream";
    const tracks = Array.isArray(s.tracks) ? s.tracks.map((t) => ({
      title: String(t.title || ""),
      url: t.url || "",
      stale: kind === "file" ? !t.url : false,
    })) : [];
    return {
      id: s.id || "st" + Math.random().toString(36).slice(2, 8),
      name: String(s.name || "sin nombre").slice(0, 32),
      kind, tracks,
      fav: !!s.fav,
      plays: Number(s.plays) || 0,
      created: Number(s.created) || Date.now(),
    };
  },

  _serialize() {
    /* Los blobs no se persisten: el nombre del archivo queda para pedirlo */
    return this.stations.map((s) => ({
      id: s.id, name: s.name, kind: s.kind, fav: s.fav, plays: s.plays, created: s.created,
      tracks: s.tracks.map((t) => ({ title: t.title, url: s.kind === "file" ? "" : t.url })),
    }));
  },

  async saveStations() { await this._storeSet(RADIO_STORE.stations, this._serialize()); },

  savePrefsSoon() {
    if (this._saveT) clearTimeout(this._saveT);
    this._saveT = setTimeout(() => { this._saveT = null; this._storeSet(RADIO_STORE.prefs, this.prefs).catch(() => {}); }, 400);
  },

  async savePrefs() { await this._storeSet(RADIO_STORE.prefs, this.prefs); },

  /* ============ 2. biblioteca ============ */
  list() { return this.stations.map((s) => ({ ...s, tracks: s.tracks.slice() })); },

  favorite() { return this.stations.filter((s) => s.fav); },

  /* Busca por id, nombre exacto, prefijo y, por último, posición (#2 / 2) */
  find(ref) {
    const q = String(ref == null ? "" : ref).trim().toLowerCase().replace(/^#/, "");
    if (!q) return null;
    let s = this.stations.find((x) => x.id === q);
    if (s) return s;
    s = this.stations.find((x) => x.name.toLowerCase() === q);
    if (s) return s;
    s = this.stations.find((x) => x.name.toLowerCase().startsWith(q));
    if (s) return s;
    s = this.stations.find((x) => x.name.toLowerCase().includes(q));
    if (s) return s;
    if (/^\d+$/.test(q)) return this.stations[Number(q) - 1] || null;
    return null;
  },

  current() { return this.stations.find((s) => s.id === this.state.stationId) || null; },

  async add(name, url, kindHint) {
    await this.ensure();
    const clean = String(name || "").trim().slice(0, 32);
    if (!clean) throw new Error("falta el nombre: radio add <nombre> <url>");
    const link = String(url || "").trim();
    if (!link) throw new Error("falta la URL");
    if (!/^https?:\/\//i.test(link)) throw new Error("la URL tiene que empezar con http:// o https://");
    if (this.find(clean) && this.find(clean).name.toLowerCase() === clean.toLowerCase()) {
      throw new Error(`ya existe una radio '${clean}' — usá otro nombre o 'radio rm ${clean}'`);
    }
    const kind = kindHint || this.detectKind(link);
    const st = this._mkStation(clean, kind, [{ title: kind === "web" ? this.webTitle(link) : clean, url: link }]);
    this.stations.push(st);
    await this.saveStations();
    return st;
  },

  async addFiles(name, files) {
    await this.ensure();
    const clean = String(name || "").trim().slice(0, 32);
    if (!clean) throw new Error("falta el nombre de la radio");
    const arr = Array.from(files || []).filter((f) => f && f.size);
    if (!arr.length) throw new Error("no elegiste ningún archivo");
    const tracks = arr.map((f) => ({
      title: String(f.name || "pista").replace(/\.[^.]+$/, "").slice(0, 90),
      url: URL.createObjectURL(f),
      size: f.size,
    }));
    let st = this.stations.find((x) => x.name.toLowerCase() === clean.toLowerCase());
    if (st) { st.kind = "file"; st.tracks = tracks; }
    else {
      st = this._mkStation(clean, "file", tracks);
      this.stations.push(st);
    }
    await this.saveStations();
    return st;
  },

  async remove(ref) {
    await this.ensure();
    const st = this.find(ref);
    if (!st) throw new Error(`no existe la radio '${ref}'`);
    if (this.state.stationId === st.id) this.stop();
    this.stations = this.stations.filter((x) => x.id !== st.id);
    await this.saveStations();
    return st;
  },

  async rename(ref, nuevo) {
    await this.ensure();
    const st = this.find(ref);
    if (!st) throw new Error(`no existe la radio '${ref}'`);
    const clean = String(nuevo || "").trim().slice(0, 32);
    if (!clean) throw new Error("falta el nombre nuevo");
    st.name = clean;
    await this.saveStations();
    return st;
  },

  async star(ref, on) {
    await this.ensure();
    const st = this.find(ref);
    if (!st) throw new Error(`no existe la radio '${ref}'`);
    st.fav = on === undefined ? !st.fav : !!on;
    await this.saveStations();
    return st;
  },

  /* ============ 3. clasificación de enlaces ============ */
  detectKind(url) {
    const u = String(url || "");
    if (/spotify\.com|youtube\.com|youtu\.be|soundcloud\.com|bandcamp\.com|mixcloud\.com|deezer\.com|tidal\.com/i.test(u)) return "web";
    if (RADIO_MIME.test(u) || /:8000|:8080|icecast|shoutcast|\/stream|\/radio|somafm|radio Paradise/i.test(u)) return "stream";
    return "stream";
  },

  webTitle(url) {
    const u = String(url || "");
    if (/spotify/i.test(u)) return "Spotify";
    if (/youtu/i.test(u)) return "YouTube";
    if (/soundcloud/i.test(u)) return "SoundCloud";
    if (/bandcamp/i.test(u)) return "Bandcamp";
    if (/mixcloud/i.test(u)) return "Mixcloud";
    return "web";
  },

  /* Convierte el enlace normal en el enlace que se puede incrustar.
     Sin esto Spotify y YouTube no suenan dentro de la ventana. */
  webEmbed(url) {
    const u = String(url || "").trim();
    let m = u.match(/(?:youtube\.com\/(?:watch\?(?:.*&)?v=|embed\/|live\/|shorts\/)|youtu\.be\/)([A-Za-z0-9_-]{6,})/i);
    if (m) {
      const t = u.match(/[?&]t=(\d+)/);
      return `https://www.youtube.com/embed/${m[1]}?autoplay=1&rel=0${t ? "&start=" + t[1] : ""}`;
    }
    m = u.match(/[?&]list=([A-Za-z0-9_-]+)/i);
    if (m && /youtu/i.test(u)) return `https://www.youtube.com/embed/videoseries?list=${m[1]}&autoplay=1`;
    m = u.match(/open\.spotify\.com\/(?:intl-[a-z-]+\/)?(track|album|playlist|artist|episode|show)\/([A-Za-z0-9]+)/i);
    if (m) return `https://open.spotify.com/embed/${m[1].toLowerCase()}/${m[2]}?utm_source=generator&theme=0`;
    if (/soundcloud\.com/i.test(u)) return `https://w.soundcloud.com/player/?url=${encodeURIComponent(u)}&color=%2363ff9b&auto_play=true`;
    return u;
  },

  /* ============ 4. audio ============ */
  _ensureAudio() {
    if (this.audio) return this.audio;
    this.audio = new Audio();
    this.audio.preload = "none";
    this.audio.addEventListener("playing", () => {
      this.state.playing = true; this.state.paused = false; this._blocked = false; this._err = null;
      if (this.current()) this.current().plays = (this.current().plays || 0) + 1;
      this._emit();
    });
    this.audio.addEventListener("pause", () => {
      if (!this.audio.ended) { this.state.paused = true; this.state.playing = false; }
      this._emit();
    });
    this.audio.addEventListener("ended", () => this._onEnded());
    this.audio.addEventListener("error", () => {
      if (!this.state.playing) { this._err = "el stream no responde"; this._emit(); }
    });
    this.audio.volume = (this.prefs.vol ?? 80) / 100;
    this.audio.muted = !!this.prefs.muted;
    return this.audio;
  },

  /* El grafo de espectro solo se conecta si el contexto corre:
     conectado a un contexto suspendido, el audio queda MUDO. */
  _hook() {
    if (this.hooked) return !!(this.ctx && this.ctx.state === "running");
    const AC = (typeof window !== "undefined" && (window.AudioContext || window.webkitAudioContext)) || null;
    if (!AC || !this.audio) return false;
    if (!this.ctx) { try { this.ctx = new AC(); } catch (e) { return false; } }
    if (this.ctx.state !== "running") {
      try { this.ctx.resume(); } catch (e) { /* sigue */ }
      if (this.ctx.state !== "running") return false;
    }
    try {
      this.srcNode = this.ctx.createMediaElementSource(this.audio);
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 1024;
      this.analyser.smoothingTimeConstant = 0.75;
      this.srcNode.connect(this.analyser);
      this.analyser.connect(this.ctx.destination);
      this.hooked = true;
      return true;
    } catch (e) { return false; }
  },

  _attempt(url) {
    return new Promise((resolve, reject) => {
      const a = this._ensureAudio();
      const done = () => {
        a.removeEventListener("error", onErr);
        a.removeEventListener("playing", onOk);
        clearTimeout(t);
      };
      const onErr = () => { done(); reject(new Error("el stream no responde")); };
      const onOk = () => { done(); resolve(); };
      const t = setTimeout(() => { done(); reject(new Error("el stream no responde (timeout 12s)")); }, 12000);
      a.addEventListener("error", onErr);
      a.addEventListener("playing", onOk);
      a.src = url;
      const p = a.play();
      if (p && p.catch) p.catch(() => {
        done();
        this._blocked = true;
        reject(new Error("el navegador bloqueó el audio — abrí la ventana con 'radio win' y dale play ahí"));
      });
    });
  },

  async _loadStation(st, index) {
    await this.ensure();
    const idx = Math.max(0, Math.min(st.tracks.length - 1, Number(index) || 0));
    const track = st.tracks[idx];
    if (!track) throw new Error("esa radio no tiene pistas");

    this.state.stationId = st.id;
    this.state.index = idx;
    this._err = null;

    /* Las emisoras web no son audio: las reproduce su propio reproductor
       dentro de la ventana flotante. */
    if (st.kind === "web") {
      this._ensureAudio().pause();
      this.state.playing = false; this.state.paused = false;
      this.prefs.last = st.id; this.savePrefsSoon();
      this._emit();
      return { web: true, embed: this.webEmbed(track.url), station: st.name, kind: "web" };
    }

    if (st.kind === "file" && (!track.url || track.stale)) {
      throw new Error(`'${st.name}' usa archivos locales que hay que volver a elegir: radio files ${st.name}`);
    }
    if (!track.url) throw new Error("esa radio no tiene ninguna URL válida");

    const a = this._ensureAudio();
    a.pause();
    try { a.removeAttribute("src"); a.load(); } catch (e) { /* sigue */ }

    /* Intento 1 con CORS (habilita espectro real). Si el server no manda
       las cabeceras, el intento 2 va sin crossOrigin y suena igual. */
    a.crossOrigin = "anonymous";
    try {
      await this._attempt(track.url);
    } catch (e1) {
      try { a.removeAttribute("crossorigin"); } catch (e) { /* sigue */ }
      await this._attempt(track.url);
    }

    this._hook();
    this.prefs.last = st.id;
    this.savePrefsSoon();
    this._emit();
    return { station: st.name, track: track.title, kind: st.kind };
  },

  async play(ref, opts) {
    await this.ensure();
    const st = ref && typeof ref === "object" ? ref : this.find(ref);
    if (!st) throw new Error(`no existe la radio '${ref}' — 'radio list' muestra la biblioteca`);
    const index = opts && opts.index !== undefined ? opts.index : 0;
    return this._loadStation(st, index);
  },

  /* Compatibilidad con el comando viejo y los dashboards:
     radio.play("lofi", "https://...", "Etiqueta") */
  async playUrl(url, label) {
    await this.ensure();
    const name = String(label || "ad-hoc").slice(0, 32);
    let st = this.stations.find((x) => x.tracks.some((t) => t.url === url));
    if (!st) {
      st = this._mkStation(name, this.detectKind(url), [{ title: name, url }]);
      this.stations.push(st);
      await this.saveStations();
    }
    return this._loadStation(st, 0);
  },

  pause() {
    if (this.audio && !this.audio.paused) this.audio.pause();
    this.state.paused = true; this.state.playing = false;
    this._emit();
    return this.state;
  },

  resume() {
    if (!this.audio || !this.audio.src) return null;
    const p = this.audio.play();
    if (p && p.catch) p.catch(() => { this._blocked = true; this._emit(); });
    return this.state;
  },

  async toggle() {
    await this.ensure();
    if (!this.state.stationId) return null;
    if (this.state.playing) { this.pause(); return this.state; }
    if (this.state.paused && this.audio && this.audio.src) { this.resume(); return this.state; }
    return this.play(this.state.stationId, { index: this.state.index });
  },

  stop() {
    if (this.audio) {
      try { this.audio.pause(); this.audio.removeAttribute("src"); this.audio.load(); } catch (e) { /* sigue */ }
    }
    this.state.playing = false; this.state.paused = false;
    this.state.stationId = null; this.state.index = 0;
    this._emit();
    return this.state;
  },

  _order() {
    /* Orden de reproducción: aleatorio si shuffle, si no tal cual */
    const n = this.current() ? this.current().tracks.length : 0;
    const idx = this.state.index;
    if (!this.prefs.shuffle || n < 2) return (idx + 1) % n;
    let pick = idx;
    while (pick === idx) pick = Math.floor(Math.random() * n);
    return pick;
  },

  async next(auto) {
    await this.ensure();
    const st = this.current();
    if (!st || !st.tracks.length) return null;
    if (auto && this.prefs.loop === "one") return this._loadStation(st, this.state.index);
    const last = this.state.index >= st.tracks.length - 1;
    if (auto && last && this.prefs.loop === "off") { this.pause(); return this.state; }
    return this._loadStation(st, this._order());
  },

  async prev() {
    await this.ensure();
    const st = this.current();
    if (!st || !st.tracks.length) return null;
    const idx = this.state.index <= 0 ? st.tracks.length - 1 : this.state.index - 1;
    return this._loadStation(st, idx);
  },

  _onEnded() {
    /* Fin de pista: si es un stream sin fin, no llega acá. Para playlists
       locales/shuffle decide el loop. */
    this.state.playing = false;
    this.next(true).catch(() => this._emit());
  },

  seek(sec) {
    if (!this.audio || !isFinite(this.audio.duration)) return false;
    const t = Math.max(0, Math.min(this.audio.duration - 0.5, sec));
    this.audio.currentTime = t;
    this._emit();
    return true;
  },

  seekPct(pct) {
    if (!this.audio || !isFinite(this.audio.duration)) return false;
    return this.seek(this.audio.duration * Math.max(0, Math.min(1, pct / 100)));
  },

  setVol(v) {
    const val = Math.max(0, Math.min(100, Math.round(Number(v) || 0)));
    this.prefs.vol = val;
    this.prefs.muted = false;
    if (this.audio) { this.audio.volume = val / 100; this.audio.muted = false; }
    this.savePrefsSoon();
    this._emit();
    return val;
  },

  mute(on) {
    this.prefs.muted = on === undefined ? !this.prefs.muted : !!on;
    if (this.audio) this.audio.muted = this.prefs.muted;
    this.savePrefsSoon();
    this._emit();
    return this.prefs.muted;
  },

  setLoop(mode) {
    this.prefs.loop = ["off", "all", "one"].includes(mode) ? mode : "off";
    this.savePrefsSoon();
    this._emit();
    return this.prefs.loop;
  },

  setShuffle(on) {
    this.prefs.shuffle = on === undefined ? !this.prefs.shuffle : !!on;
    this.savePrefsSoon();
    this._emit();
    return this.prefs.shuffle;
  },

  /* Temporizador: apaga la radio cuando se cumple el tiempo.
     Es el "dormir con la radio puesta" clásico. */
  sleep(min) {
    if (this._sleepTimer) { clearTimeout(this._sleepTimer); this._sleepTimer = null; }
    const m = Number(min) || 0;
    if (m <= 0) { this._sleepEnd = 0; this._emit(); return 0; }
    const ms = Math.min(m, 720) * 60000;
    this._sleepEnd = Date.now() + ms;
    this._sleepTimer = setTimeout(() => { this._sleepTimer = null; this._sleepEnd = 0; this.stop(); }, ms);
    this._emit();
    return m;
  },

  sleepLeft() {
    return this._sleepEnd ? Math.max(0, Math.round((this._sleepEnd - Date.now()) / 1000)) : 0;
  },

  /* ============ 5. espectro ============ */
  realSpectrum() {
    if (!this.hooked || !this.analyser || !this.state.playing) return false;
    const d = new Uint8Array(this.analyser.frequencyBinCount);
    this.analyser.getByteFrequencyData(d);
    return d.some((v) => v > 0);
  },

  /* Bandas con reparto LOGARÍTMICO: el oído no es lineal, y con reparto
     lineal los graves se comen toda la barra. Devuelve n valores 0..1. */
  bands(n) {
    const N = Math.max(4, Math.min(64, n || 16));
    const out = new Array(N).fill(0);
    const real = this.realSpectrum();
    if (real) {
      const data = new Uint8Array(this.analyser.frequencyBinCount);
      this.analyser.getByteFrequencyData(data);
      const maxBin = Math.min(data.length, 512);
      for (let i = 0; i < N; i++) {
        const a = Math.floor(Math.pow(i / N, 1.9) * maxBin);
        const b = Math.max(a + 1, Math.floor(Math.pow((i + 1) / N, 1.9) * maxBin));
        let s = 0, c = 0;
        for (let k = a; k < b && k < data.length; k++) { s += data[k]; c++; }
        const raw = c ? s / c / 255 : 0;
        out[i] = Math.min(1, Math.pow(raw, 0.72) * 1.45);
      }
    } else {
      /* Sin analizador (stream sin CORS o emisora web): animación
         etiquetada como VISUAL, nunca se presenta como real. */
      this._phase += 0.055;
      for (let i = 0; i < N; i++) {
        const w = this.state.playing ? 1 : 0.05;
        const base = 0.40 + 0.34 * Math.sin(this._phase + i * 0.55) +
                     0.16 * Math.sin(this._phase * 1.73 + i * 1.9);
        out[i] = Math.max(0, Math.min(1, w * (base + (Math.random() - 0.5) * 0.14)));
      }
    }
    /* Suavizado con caída lenta: las barras no parpadean */
    if (!this._prev || this._prev.length !== N) this._prev = out.slice();
    for (let i = 0; i < N; i++) this._prev[i] = Math.max(out[i], this._prev[i] * 0.82);
    return { vals: this._prev.slice(), real };
  },

  /* ============ 6. estado para la UI ============ */
  snapshot() {
    const st = this.current();
    const a = this.audio;
    return {
      ready: true,
      playing: !!this.state.playing,
      paused: !!this.state.paused,
      blocked: !!this._blocked,
      error: this._err || null,
      station: st ? { id: st.id, name: st.name, kind: st.kind, fav: !!st.fav } : null,
      index: this.state.index,
      count: st ? st.tracks.length : 0,
      track: st && st.tracks[this.state.index] ? st.tracks[this.state.index].title : "",
      tracks: st ? st.tracks.map((t) => t.title) : [],
      vol: this.prefs.vol,
      muted: !!this.prefs.muted,
      loop: this.prefs.loop,
      shuffle: !!this.prefs.shuffle,
      sleep: this.sleepLeft(),
      dock: !!this.prefs.dock,
      position: a && isFinite(a.currentTime) ? a.currentTime : 0,
      duration: a && isFinite(a.duration) ? a.duration : 0,
      total: this.stations.length,
    };
  },

  /* Avisa a las otras vistas (home, ventana). Inofensivo si no hay nadie. */
  _emit() {
    try {
      if (typeof browser !== "undefined" && browser.runtime && browser.runtime.sendMessage) {
        const p = browser.runtime.sendMessage({ type: "radio.event", payload: this.snapshot() });
        if (p && p.catch) p.catch(() => {});
      }
    } catch (e) { /* sin receptores */ }
  },

  /* ============ 7. ventana flotante ============ */
  async _findWindow() {
    if (typeof browser === "undefined" || !browser.windows) return null;
    try {
      const wins = await browser.windows.getAll({ populate: true });
      const url = browser.runtime.getURL("player/index.html");
      for (const w of wins) {
        if (w.id === this._winId) return w;
        if ((w.tabs || []).some((t) => (t.url || "").startsWith(url))) { this._winId = w.id; return w; }
      }
    } catch (e) { /* sigue */ }
    return null;
  },

  async openWindow(size) {
    await this.ensure();
    if (typeof browser === "undefined" || !browser.windows) {
      try { await browser.tabs.create({ url: browser.runtime.getURL("player/index.html") }); return { tab: true }; }
      catch (e) { throw new Error("este navegador no permite abrir ventanas desde la extensión"); }
    }
    const exist = await this._findWindow();
    if (exist) {
      await browser.windows.update(exist.id, { focused: true }).catch(() => {});
      return { id: exist.id, focused: true };
    }
    const dims = { s: [360, 300], m: [420, 560], l: [520, 680] }[size] || [420, 560];
    const p = this.prefs.win || {};
    const props = { url: browser.runtime.getURL("player/index.html"), type: "popup", width: p.w || dims[0], height: p.h || dims[1] };
    if (typeof p.x === "number") props.left = p.x;
    if (typeof p.y === "number") props.top = p.y;
    const w = await browser.windows.create(props);
    this._winId = w.id;
    return { id: w.id };
  },

  async closeWindow() {
    const w = await this._findWindow();
    if (!w) return false;
    await browser.windows.remove(w.id).catch(() => {});
    this._winId = null;
    return true;
  },

  async windowOpen() { return !!(await this._findWindow()); },

  /* ============ 8. router para mensajes ============ */
  async handle(cmd, p) {
    p = p || {};
    await this.ensure();
    switch (String(cmd || "")) {
      case "state": return { ok: true, data: this.snapshot() };
      case "list": return { ok: true, data: this.list() };
      case "play": return { ok: true, data: await this.play(p.ref, { index: p.index }) };
      case "toggle": return { ok: true, data: await this.toggle() };
      case "pause": return { ok: true, data: this.pause() };
      case "resume": return { ok: true, data: this.resume() };
      case "stop": return { ok: true, data: this.stop() };
      case "next": return { ok: true, data: await this.next(false) };
      case "prev": return { ok: true, data: await this.prev() };
      case "vol": return { ok: true, data: this.setVol(p.value) };
      case "mute": return { ok: true, data: this.mute(p.value) };
      case "loop": return { ok: true, data: this.setLoop(p.value) };
      case "shuffle": return { ok: true, data: this.setShuffle(p.value) };
      case "sleep": return { ok: true, data: this.sleep(p.value) };
      case "seek": return { ok: true, data: this.seek(Number(p.value) || 0) };
      case "seekPct": return { ok: true, data: this.seekPct(Number(p.value) || 0) };
      case "add": return { ok: true, data: await this.add(p.name, p.url, p.kind) };
      case "rm": return { ok: true, data: await this.remove(p.ref) };
      case "rename": return { ok: true, data: await this.rename(p.ref, p.name) };
      case "star": return { ok: true, data: await this.star(p.ref, p.value) };
      case "win": return { ok: true, data: await this.openWindow(p.size) };
      case "winclose": return { ok: true, data: await this.closeWindow() };
      case "dock": this.prefs.dock = !!p.value; this.savePrefsSoon(); this._emit();
        return { ok: true, data: this.prefs.dock };
      case "bands": return { ok: true, data: this.bands(p.n) };
      default: return { ok: false, error: `radio: acción desconocida '${cmd}'` };
    }
  },
};

/* Solo el background se autoinicializa. Las páginas llaman ensure()
   cuando de verdad lo necesitan (y prefieren la instancia del background). */
if (typeof window !== "undefined" && RadioEngine.isBackground()) {
  RadioEngine.ensure().catch(() => {});
  try {
    browser.windows.onRemoved.addListener((id) => {
      if (id === RadioEngine._winId) RadioEngine._winId = null;
    });
  } catch (e) { /* navegador sin windows */ }
}
