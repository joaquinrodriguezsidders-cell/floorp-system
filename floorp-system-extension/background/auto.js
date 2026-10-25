/* ============================================================
   FLOORP SYSTEM — background/auto.js
   Automatizaciones (v0.15): reglas pequeñas, declarativas y
   SIEMPRE desactivables desde la terminal ('auto off <regla>').

   Principios (spec §23 performance):
   · UN solo setInterval de 30s para TODO (batería + descanso).
   · Cada regla guarda lastFired y no repite hasta que corresponde.
   · Nada corre si no hay reglas activas (el interval se apaga solo).
   · Sin permisos nuevos: usa tabs/storage + downloads (solo leer).
   ============================================================ */
"use strict";

const Auto = {
  KEY: "fsys.auto",
  TIMER: null,

  /* ---------- estado persistente ---------- */
  async load() {
    const data = await browser.storage.local.get(this.KEY);
    return data[this.KEY] || {};
  },

  async save(s) {
    await browser.storage.local.set({ [this.KEY]: s });
  },

  /* ---------- ciclo de vida del interval ----------
     Se enciende SOLO cuando hay reglas activas que lo necesitan
     (auto-battery / auto-break). El resto son event-driven. */
  async syncTimer() {
    const s = await this.load();
    const need = s.battery?.on || s.break?.on || s.vault?.on;
    if (need && !this.TIMER) {
      this.TIMER = setInterval(() => this.tick().catch(() => {}), 30000);
    } else if (!need && this.TIMER) {
      clearInterval(this.TIMER);
      this.TIMER = null;
    }
  },

  /* ---------- AUTO-VAULT: snapshot periódico con rotación ----------
     Cada N horas guarda un snapshot 'auto-<nombre>' (y borra el
     anterior de esa serie). Recuperable igual que cualquier vault:
     'vault load auto-trabajo'. */
  async vaultSnapshot(label) {
    const s = await this.load();
    const v = s.vault;
    if (!v || !v.on) return { skipped: true };
    const now = Date.now();
    if (v.lastFired && now - v.lastFired < (v.hours || 2) * 3600e3) {
      return { skipped: true };
    }
    const res = await Vault.save(`auto-${v.name || label || "trabajo"}`);
    if (res.ok) {
      v.lastFired = now;
      await this.save(s);
      return { fired: true, ...res.data };
    }
    return { skipped: true, error: res.error };
  },

  /* ---------- AUTO-BREAK: descanso con aviso del SO ----------
     Cada N minutos de sesión avisa (notificación). No corta nada:
     respeta al usuario, solo le habla. Reset al apagar. */
  async breakCheck() {
    const s = await this.load();
    const b = s.break;
    if (!b || !b.on) return { skipped: true };
    const now = Date.now();
    b.started = b.started || now;
    const due = now - b.started >= (b.minutes || 50) * 60e3;
    if (!due) return { skipped: true };
    b.started = now; /* reinicia el ciclo */
    b.count = (b.count || 0) + 1;
    await this.save(s);
    try {
      await browser.notifications.create({
        type: "basic",
        title: "FLOORP SYSTEM · descanso",
        message: `${b.minutes || 50} min de sesión — estirá las piernas.`,
      });
    } catch (e) { /* sin permiso de notificaciones: silencioso */ }
    return { fired: true, count: b.count };
  },

  /* ---------- AUTO-BATTERY: modo foco al desenchufar ----------
     Al cruzar el umbral (por defecto 25%) guarda un snapshot y
     desactiva la regla (se activa de nuevo con 'auto on battery'). */
  async batteryCheck() {
    const s = await this.load();
    const b = s.battery;
    if (!b || !b.on || !b.threshold) return { skipped: true };
    const m = await BridgeOS._fetch("/sys", {}, 4000).catch(() => null);
    if (!m) return { skipped: true };
    /* El bridge reporta batería cuando existe; si no, la regla queda
       dormida sin consumir nada. */
    if (m.battery === undefined || m.battery === null) return { skipped: true };
    if (m.battery > b.threshold || b.firedAt) return { skipped: true };
    const res = await Vault.save("auto-bateria");
    b.firedAt = Date.now();
    b.on = false; /* one-shot: se reactiva manualmente */
    await this.save(s);
    try {
      await browser.notifications.create({
        type: "basic",
        title: "FLOORP SYSTEM · batería baja",
        message: `${Math.round(m.battery * 100)}% — sesión guardada en 'auto-bateria'.`,
      });
    } catch (e) {}
    return { fired: true, saved: res.ok ? res.data.tabs : 0 };
  },

  /* ---------- AUTO-FLUSH: archivador semanal de tabs estancadas ----------
     Cada 7 días: las tabs con más de 7 días sin abrir se copian al
     vault 'flush-<fecha>' y se cierran. Lo pinchado, lo audible (música
     o video reproduciendo), la tab activa y la home NUNCA se tocan.
     Nada se pierde: vault load flush-<fecha> y vuelve todo. */
  async flushCheck() {
    const s = await this.load();
    const f = s.flush;
    if (!f || !f.on) return { skipped: true };
    const now = Date.now();
    if (f.lastFired && now - f.lastFired < 7 * 864e5) return { skipped: true };
    const tabs = await browser.tabs.query({ currentWindow: true });
    const homeUrl = browser.runtime.getURL("newtab/index.html");
    const stale = [];
    for (const t of tabs) {
      if (t.pinned || t.active || t.audible) continue;
      if (t.url.startsWith(homeUrl)) continue;
      const last = (t.lastAccessed || 0);
      if (last && now - last > 7 * 864e5) stale.push({ url: t.url, title: t.title || t.url, id: t.id });
    }
    if (!stale.length) {
      f.lastFired = now;   /* semana revisada: reintenta en 7 días */
      await this.save(s);
      return { fired: true, archived: 0 };
    }
    const label = new Date(now).toISOString().slice(0, 10);
    const res = await Vault.import(`flush-${label}`, stale.map(({ url, title }) => ({ url, title })));
    if (!res.ok) return { skipped: true, error: res.error };
    try {
      await browser.tabs.remove(stale.map((t) => t.id));
    } catch (e) { /* alguna ya se cerró sola: el snapshot está a salvo */ }
    f.lastFired = now;
    await this.save(s);
    try {
      await browser.notifications.create({
        type: "basic",
        title: "FLOORP SYSTEM · archivador",
        message: `${stale.length} tabs con +7 días → 'flush-${label}' (vault load para recuperar).`,
      });
    } catch (e) {}
    return { fired: true, archived: stale.length, name: `flush-${label}` };
  },

  /* Tick único de 30s: solo las reglas con interval lo usan */
  async tick() {
    const out = [];
    const r0 = await this.vaultSnapshot();
    if (r0.fired) out.push("vault");
    const r1 = await this.breakCheck();
    if (r1.fired) out.push("break");
    const r2 = await this.batteryCheck();
    if (r2.fired) out.push("battery");
    const r3 = await this.flushCheck();
    if (r3.fired) out.push("flush");
    return out;
  },

  /* ---------- AUTO-DOWNLOADS: aviso de descarga terminada ----------
     Event-driven (browser.downloads): cero polling. */
  async downloadsInit() {
    try {
      browser.downloads.onChanged.addListener((delta) => {
        if (!delta.state || delta.state.current !== "complete") return;
        this.load().then(async (s) => {
          if (!s.downloads || !s.downloads.on) return;
          try {
            const [item] = await browser.downloads.search({ id: delta.id });
            const name = item && item.filename
              ? item.filename.split(/[\\/]/).pop()
              : "archivo";
            await browser.notifications.create({
              type: "basic",
              title: "FLOORP SYSTEM · descarga lista",
              message: name,
            });
          } catch (e) { /* ignorado */ }
        });
      });
    } catch (e) { /* permiso ausente: la regla no se ofrece */ }
  },

  /* ---------- API para los handlers ---------- */
  async status() {
    const s = await this.load();
    const rules = [
      { id: "vault", desc: "snapshot automático cada 2h", on: !!(s.vault && s.vault.on) },
      { id: "break", desc: "aviso de descanso cada 50 min", on: !!(s.break && s.break.on) },
      { id: "battery", desc: "guarda sesión al 25% de batería", on: !!(s.battery && s.battery.on) },
      { id: "downloads", desc: "aviso de descarga terminada", on: !!(s.downloads && s.downloads.on) },
      { id: "flush", desc: "semanal: archiva tabs con +7 días sin abrir", on: !!(s.flush && s.flush.on) },
    ];
    return rules;
  },

  async setOn(rule, on, arg) {
    const s = await this.load();
    if (rule === "vault") {
      if (on) {
        const name = String(arg || "trabajo").toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 16) || "trabajo";
        s.vault = { on: true, name, hours: 2, lastFired: 0 };
      } else s.vault = { ...(s.vault || {}), on: false };
    } else if (rule === "break") {
      s.break = { on, minutes: 50, started: on ? Date.now() : 0, count: s.break?.count || 0 };
    } else if (rule === "battery") {
      s.battery = { on, threshold: 0.25 };
    } else if (rule === "downloads") {
      s.downloads = { on };
    } else if (rule === "flush") {
      s.flush = { on };
    } else {
      return { ok: false, error: `regla desconocida: ${rule}` };
    }
    await this.save(s);
    await this.syncTimer();
    return { ok: true, data: await this.status() };
  },
};
