/* ============================================================
   FLOORP RADIO — player.js
   Control remoto del motor. Si el background está disponible usa
   SU instancia (así el audio no se corta al cerrar esta ventana);
   si no, cae al motor local de esta página.
   ============================================================ */
"use strict";

const LOCAL = typeof RadioEngine !== "undefined" ? RadioEngine : null;

const E = (() => {
  try {
    const bg = browser.extension.getBackgroundPage();
    if (bg && bg.RadioEngine) return bg.RadioEngine;
  } catch (e) { /* sin background */ }
  return LOCAL;
})();

const $ = (id) => document.getElementById(id);
const el = {
  dot: $("dot"), name: $("st-name"), kind: $("st-kind"),
  bars: $("bars"), mode: $("viz-mode"), time: $("time"),
  viz: $("viz"), frame: $("frame"), embed: $("embed"),
  track: $("track"), pos: $("pos"),
  bPrev: $("b-prev"), bPlay: $("b-play"), bNext: $("b-next"), bStop: $("b-stop"),
  bShuffle: $("b-shuffle"), bLoop: $("b-loop"), bSleep: $("b-sleep"), bFav: $("b-fav"),
  vol: $("vol"), volNum: $("vol-num"), volIco: $("vol-ico"),
  list: $("lib-list"), count: $("lib-count"), msg: $("msg"),
  close: $("win-close"),
};

const COLS = 36;
let bars = [];
const peaks = new Array(COLS).fill(0);
let lastStation = null;
let shownEmbed = null;
const SLEEPS = [0, 15, 30, 45, 60, 90];

function say(text, isErr) {
  el.msg.textContent = text || "";
  document.getElementById("foot").classList.toggle("err", !!isErr);
  if (text) {
    clearTimeout(say._t);
    say._t = setTimeout(() => { el.msg.textContent = ""; document.getElementById("foot").classList.remove("err"); }, 6000);
  }
}

function mmss(sec) {
  const s = Math.max(0, Math.floor(sec));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

/* ---------- barras ---------- */
function buildBars() {
  el.bars.innerHTML = "";
  bars = [];
  const frag = document.createDocumentFragment();
  for (let i = 0; i < COLS; i++) {
    const b = document.createElement("i");
    frag.appendChild(b);
    bars.push(b);
  }
  el.bars.appendChild(frag);
}

function drawBars() {
  if (!E) return;
  let out;
  try { out = E.bands(COLS); } catch (e) { return; }
  const vals = out.vals || [];
  for (let i = 0; i < COLS; i++) {
    const v = Math.max(0, Math.min(1, vals[i] || 0));
    /* Pico que baja solo: la barra queda "viva" sin parpadear */
    peaks[i] = Math.max(v, peaks[i] - 0.012);
    const h = Math.max(2, Math.round(v * 96));
    const bar = bars[i];
    bar.style.height = h + "px";
    bar.classList.toggle("hi", peaks[i] > 0.72);
  }
  el.mode.textContent = out.real ? "ESPECTRO REAL" : "ESPECTRO VISUAL";
  el.mode.classList.toggle("real", !!out.real);
}

function raf() {
  drawBars();
  requestAnimationFrame(raf);
}

/* ---------- biblioteca ---------- */
async function renderLibrary() {
  if (!E) return;
  let list = [];
  try { list = E.list(); } catch (e) { return; }
  const cur = E.current ? (E.current() || {}).id : null;
  el.count.textContent = `${list.length} emisoras`;
  el.list.innerHTML = "";
  const frag = document.createDocumentFragment();
  list
    .slice()
    .sort((a, b) => (b.fav ? 1 : 0) - (a.fav ? 1 : 0) || a.name.localeCompare(b.name))
    .forEach((st) => {
      const row = document.createElement("div");
      row.className = "st" + (st.id === cur ? " cur" : "");
      row.title = st.kind === "web" ? st.tracks[0] && st.tracks[0].url : `${st.tracks.length} pista(s)`;
      const n = document.createElement("span");
      n.className = "st-n";
      n.textContent = st.name;
      const k = document.createElement("span");
      k.className = "st-k";
      k.textContent = st.kind === "web" ? "web" : st.kind === "file" ? "archivos" : "stream";
      const f = document.createElement("span");
      f.className = "st-f" + (st.fav ? " on" : "");
      f.textContent = st.fav ? "★" : "☆";
      f.title = "Marcar favorita";
      f.addEventListener("click", async (ev) => {
        ev.stopPropagation();
        try { await E.star(st.id); renderLibrary(); }
        catch (err) { say(err.message, true); }
      });
      row.appendChild(n); row.appendChild(k); row.appendChild(f);
      row.addEventListener("click", () => playStation(st.id));
      frag.appendChild(row);
    });
  el.list.appendChild(frag);
}

/* ---------- reproducir ---------- */
async function playStation(ref) {
  if (!E) { say("el motor de radio no está disponible", true); return; }
  say("");
  try {
    const res = await E.play(ref);
    if (res && res.web) {
      showWeb(res.embed);
      say("emisora web: suena dentro de esta ventana");
    } else {
      hideWeb();
    }
    await sync(true);
    await renderLibrary();
  } catch (err) {
    say(err.message || String(err), true);
  }
}

function showWeb(url) {
  el.viz.hidden = true;
  el.frame.hidden = false;
  if (shownEmbed !== url) {
    el.embed.src = url;
    shownEmbed = url;
  }
}

function hideWeb() {
  el.viz.hidden = false;
  el.frame.hidden = true;
  if (shownEmbed) { el.embed.removeAttribute("src"); shownEmbed = null; }
}

/* ---------- estado ---------- */
async function sync(force) {
  if (!E) return;
  let s;
  try { s = E.snapshot(); } catch (e) { return; }

  const name = s.station ? s.station.name : "FLOORP RADIO";
  el.name.textContent = name;
  el.kind.textContent = s.station
    ? (s.station.kind === "web" ? "emisora web" : s.station.kind === "file" ? "archivos locales" : "stream en vivo")
    : "sin sintonizar";

  el.dot.className = s.playing ? "on" : s.paused ? "pause" : "off";
  el.bPlay.textContent = s.playing ? "⏸" : "▶";
  el.bPlay.title = s.playing ? "Pausa" : "Play";

  el.track.textContent = s.track || (s.station ? "(sin pista)" : "elegí una emisora abajo");
  el.pos.textContent = s.station
    ? `${s.index + 1}/${s.count} · ${s.count > 1 ? "playlist" : "una pista"}${s.error ? " · " + s.error : ""}`
    : "";
  el.time.textContent = s.duration > 0 ? `${mmss(s.position)} / ${mmss(s.duration)}` : (s.playing ? "EN VIVO" : "—");

  el.bShuffle.classList.toggle("on", s.shuffle);
  el.bLoop.classList.toggle("on", s.loop !== "off");
  el.bLoop.title = s.loop === "one" ? "Repetir una" : s.loop === "all" ? "Repetir todo" : "Repetir";
  el.bLoop.textContent = s.loop === "one" ? "↻1" : s.loop === "all" ? "↻a" : "↻";
  el.bSleep.classList.toggle("on", s.sleep > 0);
  el.bSleep.textContent = s.sleep > 0 ? `☾${Math.ceil(s.sleep / 60)}` : "☾";
  el.bFav.textContent = s.station && s.station.fav ? "★" : "☆";
  el.bFav.classList.toggle("on", !!(s.station && s.station.fav));
  el.bFav.disabled = !s.station;
  el.bPrev.disabled = !s.station;
  el.bNext.disabled = !s.station;
  el.bStop.disabled = !s.station;
  el.bPlay.disabled = !s.station;

  if (document.activeElement !== el.vol) el.vol.value = s.muted ? 0 : s.vol;
  el.volNum.textContent = s.muted ? "0" : s.vol;
  el.volIco.textContent = s.muted || s.vol === 0 ? "🔇" : s.vol < 40 ? "🔉" : "🔊";

  if (s.blocked) say("el navegador bloqueó el audio: apretá ▶", true);

  if (force || lastStation !== (s.station && s.station.id)) {
    lastStation = s.station ? s.station.id : null;
    await renderLibrary();
  }
}

/* ---------- ayuda visual de acción ---------- */
function wrap(fn) {
  return async () => {
    try { await fn(); } catch (err) { say(err.message || String(err), true); }
    await sync(true);
  };
}

/* ---------- eventos ---------- */
function wire() {
  el.close.addEventListener("click", () => window.close());

  el.bPlay.addEventListener("click", wrap(async () => {
    if (!E) return;
    const s = E.snapshot();
    if (s.playing) E.pause();
    else if (s.paused) E.resume();
    else if (s.station) await playStation(s.station.id);
  }));
  el.bPrev.addEventListener("click", wrap(async () => { await E.prev(); hideWeb(); }));
  el.bNext.addEventListener("click", wrap(async () => { await E.next(false); hideWeb(); }));
  el.bStop.addEventListener("click", wrap(async () => { E.stop(); hideWeb(); }));
  el.bShuffle.addEventListener("click", wrap(async () => { E.setShuffle(); }));
  el.bLoop.addEventListener("click", wrap(async () => {
    const cur = E.snapshot().loop;
    E.setLoop(cur === "off" ? "all" : cur === "all" ? "one" : "off");
  }));
  el.bSleep.addEventListener("click", wrap(async () => {
    const cur = Math.ceil(E.snapshot().sleep / 60);
    const i = SLEEPS.indexOf(cur);
    const nextMin = SLEEPS[(i < 0 ? 0 : i + 1) % SLEEPS.length];
    E.sleep(nextMin);
    say(nextMin ? `la radio se apaga en ${nextMin} min` : "temporizador cancelado");
  }));
  el.bFav.addEventListener("click", wrap(async () => {
    const s = E.snapshot();
    if (s.station) await E.star(s.station.id);
  }));

  el.vol.addEventListener("input", () => {
    const v = Number(el.vol.value);
    E.setVol(v);
    el.volNum.textContent = v;
    el.volIco.textContent = v === 0 ? "🔇" : v < 40 ? "🔉" : "🔊";
  });
  el.volIco.addEventListener("click", () => E.mute());

  document.addEventListener("keydown", (ev) => {
    if (ev.target && ev.target.tagName === "INPUT") return;
    const k = ev.key;
    if (k === " ") { ev.preventDefault(); el.bPlay.click(); }
    else if (k === "ArrowRight") { ev.preventDefault(); el.bNext.click(); }
    else if (k === "ArrowLeft") { ev.preventDefault(); el.bPrev.click(); }
    else if (k === "ArrowUp") { ev.preventDefault(); E.setVol(Math.min(100, E.snapshot().vol + 5)); sync(); }
    else if (k === "ArrowDown") { ev.preventDefault(); E.setVol(Math.max(0, E.snapshot().vol - 5)); sync(); }
    else if (k === "Escape") window.close();
  });

  /* Avisos del motor (otra vista cambió algo) */
  try {
    browser.runtime.onMessage.addListener((m) => {
      if (m && m.type === "radio.event") sync();
    });
  } catch (e) { /* sin runtime */ }
}

(async () => {
  if (!E) {
    el.name.textContent = "SIN MOTOR";
    say("no pude alcanzar el motor de radio — reabrí la ventana con 'radio win'", true);
    return;
  }
  await E.ensure();
  el.vol.value = E.prefs ? E.prefs.vol : 80;
  buildBars();
  wire();
  await sync(true);
  /* La emisora web activa se reabre al reabrir la ventana */
  const s = E.snapshot();
  if (s.station && s.station.kind === "web") {
    const st = E.current();
    if (st && st.tracks[0]) showWeb(E.webEmbed(st.tracks[0].url));
  }
  requestAnimationFrame(raf);
  setInterval(() => sync(), 900);
})();
