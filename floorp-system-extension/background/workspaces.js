/* ============================================================
   FLOORP SYSTEM — background/workspaces.js
   Workspace engine con ESTRATEGIA DUAL:

   1) NATIVO (recomendado): usa el OS Server local de Floorp 12
      (http://127.0.0.1:<port>, pref floorp.os.enabled=true) y su API
      oficial de workspaces. Los workspaces son los REALES de Floorp:
      lo que cambia acá se ve en la barra de workspaces del navegador.
      Auth: bearer token en ~/.floorp/os-server-token (lo escribe Floorp).

   2) SESIONES PROPIAS (fallback): si el OS Server no responde, usa el
      engine propio (guardar/restaurar tabs por workspace). Fallback
      VISÍBILE: los comandos reportan en qué modo operan.
   ============================================================ */
"use strict";

/* ============ CLIENTE DEL OS SERVER DE FLOORP (v0.13) ============
   Los WORKSPACES REALES del navegador. El OS Server de Floorp
   (pref floorp.os.enabled=true) escucha en 127.0.0.1:58261 y exige su
   token Bearer, que Floorp escribe en ~/.floorp/os-server-token.
   La extensión NO puede leer ese archivo: el fsys-bridge lo lee y lo
   inyecta server-side. La extensión habla SOLO con su bridge de
   siempre (loopback + token propio) — la web nunca ve el token. */
const FloorpOS = {
  available: false,
  lastCheck: 0,
  lastList: null,
  CHECK_TTL: 10000,

  async probe(force = false) {
    const now = Date.now();
    if (!force && this.available && now - this.lastCheck < this.CHECK_TTL) return true;
    /* Requiere el fsys-bridge vivo; el bridge reenvía al OS Server. */
    if (!(await BridgeOS.probe(force))) { this.available = false; this.lastCheck = now; return false; }
    const res = await BridgeOS._fetch("/floorp/workspaces", {}, 6000).catch(() => null);
    this.available = !!(res && res.error !== "FLOORP_OS_OFFLINE" && res.error !== "BRIDGE_OFFLINE");
    this.lastCheck = now;
    return this.available;
  },

  async listWorkspaces() {
    if (!(await this.probe())) return null;
    try {
      const res = await BridgeOS._fetch("/floorp/workspaces", {}, 6000);
      if (res && Array.isArray(res.workspaces)) {
        this.lastList = res.workspaces;
        return res.workspaces;
      }
    } catch (e) { /* offline */ }
    this.available = false;
    return null;
  },

  async switchTo(id) {
    try {
      const res = await BridgeOS._fetch(`/floorp/workspaces/${encodeURIComponent(id)}/switch`, { method: "POST" }, 8000);
      return !!(res && res.success);
    } catch (e) { return false; }
  },

  async switchNext() {
    try {
      const res = await BridgeOS._fetch("/floorp/workspaces/next", { method: "POST" }, 8000);
      return !!(res && res.success);
    } catch (e) { return false; }
  },

  async switchPrevious() {
    try {
      const res = await BridgeOS._fetch("/floorp/workspaces/previous", { method: "POST" }, 8000);
      return !!(res && res.success);
    } catch (e) { return false; }
  },
};

const WorkspacesBG = {
  /* Tabs actuales de la ventana → lista serializable.
     Excluye fijadas y la home del sistema (es el keep-alive, no contenido). */
  async captureCurrentTabs() {
    const tabs = await browser.tabs.query({ currentWindow: true });
    const homeUrl = browser.runtime.getURL("newtab/index.html");
    return tabs
      .filter((t) => !t.pinned && !t.url.startsWith(homeUrl))
      .map((t) => ({ url: t.url, title: t.title || t.url }));
  },

  /* Guarda el estado actual como sesión del workspace dado */
  async saveSession(wsId) {
    const state = await State.load();
    const tabs = await this.captureCurrentTabs();
    state.session[wsId] = { tabs, savedAt: Date.now() };
    await State.save();
    return tabs.length;
  },

  /* Restaura las tabs de un workspace (creándolas en background) */
  async restoreSession(wsId) {
    const state = await State.load();
    const sess = state.session[wsId];
    if (!sess || !sess.tabs || sess.tabs.length === 0) return 0;

    /* Crea en background y activa la primera */
    const created = [];
    for (const t of sess.tabs) {
      try {
        created.push(await browser.tabs.create({ url: t.url, active: false }));
      } catch (e) {
        /* URL inválida (p.ej. about: interno): se omite esa tab */
      }
    }
    if (created.length) {
      try { await browser.tabs.update(created[0].id, { active: true }); } catch (e) {}
    }
    return created.length;
  },

  /* Cierra las tabs (no fijadas, ni la home del sistema) de la ventana actual.
     La home del sistema actúa de keep-alive: la ventana nunca muere. */
  async closeCurrentTabs() {
    const tabs = await browser.tabs.query({ currentWindow: true });
    const homeUrl = browser.runtime.getURL("newtab/index.html");
    const ids = tabs
      .filter((t) => !t.pinned && !t.url.startsWith(homeUrl))
      .map((t) => t.id);
    if (ids.length) await browser.tabs.remove(ids);
    return ids.length;
  },

  /* ==== Operación principal: cambiar de workspace ====
     NATIVO primero (workspaces reales de Floorp vía OS Server).
     Sesiones propias SOLO como fallback visible. */
  async switchTo(wsId, opts = {}) {
    const state = await State.load();
    const homeUrl = browser.runtime.getURL("newtab/index.html");

    /* ---------- MODO NATIVO ---------- */
    if (opts.native !== false && (await FloorpOS.probe(true))) {
      const list = await FloorpOS.listWorkspaces();
      if (list && list.length) {
        let target = null;
        if (typeof wsId === "number") {
          /* Mapea posición 1..N de FLOORP SYSTEM al order de Floorp */
          target = list[wsId - 1];
        } else if (typeof wsId === "string") {
          const q = wsId.toLowerCase();
          target = list.find((w) => w.name.toLowerCase().startsWith(q));
        }
        if (!target) throw new Error(`workspace ${wsId} no encontrado en Floorp`);
        const ok = await FloorpOS.switchTo(target.id);
        if (!ok) throw new Error("el OS Server rechazó el cambio de workspace");
        return {
          mode: "NATIVE",
          id: target.id,
          name: target.name,
          index: list.findIndex((w) => w.id === target.id) + 1,
        };
      }
    }

    /* ---------- MODO SESIONES (fallback visible) ---------- */
    if (opts.native === true) {
      throw new Error("OS Server de Floorp offline — enable: ws enable (floorp.os.enabled=true + fsys-bridge)");
    }
    const target = state.workspaces.find((w) => w.id === wsId);
    if (!target) throw new Error(`workspace ${wsId} no existe`);

    const fromId = state.active;

    /* 1. Guarda sesión del workspace saliente (siempre, sin pérdida) */
    const savedCount = await this.saveSession(fromId);

    /* 2. Asegura una home viva (keep-alive) antes de cerrar nada */
    const current = await browser.tabs.query({ currentWindow: true });
    const homeAlive = current.some((t) => t.url.startsWith(homeUrl));
    if (!homeAlive) {
      await browser.tabs.create({ url: homeUrl, active: false });
    }

    /* 3. Cierra las tabs de contenido actuales (ya guardadas) */
    await this.closeCurrentTabs();

    /* 4. Restaura sesión del workspace entrante */
    const restored = await this.restoreSession(wsId);

    /* 5. Si el workspace entrante no tenía nada guardado, activa la home */
    if (restored === 0) {
      const tabsNow = await browser.tabs.query({ currentWindow: true });
      const home = tabsNow.find((t) => t.url.startsWith(homeUrl));
      if (home) await browser.tabs.update(home.id, { active: true });
    }

    state.active = wsId;
    await State.save();

    return {
      mode: "SESSIONS",
      from: fromId,
      to: wsId,
      name: target.name,
      saved: savedCount,
      restored,
    };
  },

  async step(dir) {
    /* next/previous NATIVO con fallback a posición own-sessions */
    if (await FloorpOS.probe()) {
      try {
        if (dir > 0) await FloorpOS.switchNext();
        else await FloorpOS.switchPrevious();
        const list = await FloorpOS.listWorkspaces();
        const cur = list ? list.find((w) => w.isSelected) : null;
        return { mode: "NATIVE", name: cur ? cur.name : "?", index: cur ? list.indexOf(cur) + 1 : 0 };
      } catch (e) { /* cae a fallback */ }
    }
    const state = await State.load();
    const n = state.workspaces.length;
    const nextId = ((state.active - 1 + (dir > 0 ? 1 : -1) + n) % n) + 1;
    return this.switchTo(nextId, { native: false });
  },

  /* ==== CRUD de workspaces ==== */
  async list() {
    /* NATIVO: los workspaces reales de Floorp */
    if (await FloorpOS.probe()) {
      const list = await FloorpOS.listWorkspaces();
      if (list) {
        return {
          mode: "NATIVE",
          workspaces: list.map((w, i) => ({
            id: i + 1,
            nativeId: w.id,
            name: w.name,
            tabs: null,
            isSelected: w.isSelected,
          })),
          active: list.findIndex((w) => w.isSelected) + 1,
        };
      }
    }
    /* SESIONES: los propios */
    const state = await State.load();
    return {
      mode: "SESSIONS",
      workspaces: state.workspaces.map((w) => ({
        id: w.id,
        name: w.name,
        tabs: (state.session[w.id] || { tabs: [] }).tabs.length,
      })),
      active: state.active,
    };
  },

  async rename(wsId, newName) {
    const state = await State.load();
    const ws = state.workspaces.find((w) => w.id === wsId);
    if (!ws) throw new Error(`workspace ${wsId} no existe`);
    ws.name = newName.toUpperCase().slice(0, 16);
    await State.save();
    return ws;
  },

  async addUrlToSession(wsId, url) {
    const state = await State.load();
    if (!state.session[wsId]) state.session[wsId] = { tabs: [], savedAt: 0 };
    state.session[wsId].tabs.push({ url, title: url });
    await State.save();
    return state.session[wsId].tabs.length;
  },

  async summary() {
    const info = await this.list();
    const active = info.workspaces.find((w) => w.id === info.active);
    return {
      mode: info.mode,
      active: info.active,
      name: active ? active.name : "—",
      workspaces: info.workspaces,
    };
  },
};
