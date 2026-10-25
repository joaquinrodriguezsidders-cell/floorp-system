/* ============================================================
   FLOORP SYSTEM — background/vault.js
   Bóveda de sesiones (BOOT 11): snapshots con nombre de la
   ventana completa. Reutiliza captureCurrentTabs/closeCurrentTabs
   de workspaces.js — nunca destruye tabs sin guardarlas antes.
   ============================================================ */
"use strict";

const Vault = {
  KEY: "fsys.vault",

  async _load() {
    const data = await browser.storage.local.get(this.KEY);
    return data[this.KEY] || {};
  },

  async _save(v) {
    await browser.storage.local.set({ [this.KEY]: v });
  },

  /* Guarda el estado actual bajo un nombre (sobrescribe con aviso) */
  async save(name) {
    const clean = String(name || "").toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 24);
    if (!clean) return { ok: false, error: "NOMBRE_INVALIDO" };
    const v = await this._load();
    const tabs = await WorkspacesBG.captureCurrentTabs();
    const existed = !!v[clean];
    v[clean] = { tabs, savedAt: Date.now() };
    await this._save(v);
    return { ok: true, data: { name: clean, tabs: tabs.length, overwrote: existed } };
  },

  /* Restaura: cierra lo actual (ya protegido por el propio snapshot si
     el usuario guardó antes) y crea las tabs del vault en background. */
  async load(name) {
    const v = await this._load();
    const snap = v[String(name || "").toLowerCase()];
    if (!snap) return { ok: false, error: "NO_EXISTE" };
    /* Crea primero (en background), cierra después: si algo falla a
       mitad, el usuario no queda sin tabs. */
    const created = [];
    for (const t of snap.tabs || []) {
      try { created.push(await browser.tabs.create({ url: t.url, active: false })); }
      catch (e) { /* URL inválida: se omite */ }
    }
    if (created.length) {
      try { await browser.tabs.update(created[0].id, { active: true }); } catch (e) {}
    }
    const closed = await WorkspacesBG.closeCurrentTabs();
    return { ok: true, data: { name, restored: created.length, closed } };
  },

  async list() {
    const v = await this._load();
    return {
      ok: true,
      data: Object.entries(v)
        .map(([name, s]) => ({ name, tabs: (s.tabs || []).length, savedAt: s.savedAt }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    };
  },

  async remove(name) {
    const v = await this._load();
    const clean = String(name || "").toLowerCase();
    if (!v[clean]) return { ok: false, error: "NO_EXISTE" };
    delete v[clean];
    await this._save(v);
    return { ok: true, data: { name: clean } };
  },

  /* Guarda un snapshot DESDE UNA LISTA dada (no desde la ventana).
     Lo usa auto flush: archiva las tabs estancadas sin tocar la
     ventana todavía. Sin excepciones internas: si algo raro pasa,
     el snapshot queda vacío y NADA se cierra. */
  async import(name, tabs) {
    const clean = String(name || "").toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 24);
    if (!clean) return { ok: false, error: "NOMBRE_INVALIDO" };
    const list = Array.isArray(tabs) ? tabs : [];
    const v = await this._load();
    const existed = !!v[clean];
    v[clean] = { tabs: list, savedAt: Date.now() };   /* sobrescribe la serie */
    await this._save(v);
    return { ok: true, data: { name: clean, tabs: list.length, overwrote: existed } };
  },

  /* ==== MODO FOCO (usa la bóveda como mecanismo de respaldo) ==== */
  async focusStart(minutes, label) {
    const v = await this._load();
    if (v.__focus) return { ok: false, error: "FOCUS_ACTIVO" };
    const tabs = await WorkspacesBG.captureCurrentTabs();
    v.__focus = { tabs, startedAt: Date.now(), endsAt: Date.now() + minutes * 60000, label: label || "" };
    await this._save(v);
    return { ok: true, data: { tabs: tabs.length, endsAt: v.__focus.endsAt } };
  },

  async focusStop(auto = false) {
    const v = await this._load();
    const f = v.__focus;
    if (!f) return { ok: false, error: "FOCUS_INACTIVO" };
    delete v.__focus;
    await this._save(v);
    const restored = [];
    for (const t of f.tabs || []) {
      try { restored.push(await browser.tabs.create({ url: t.url, active: false })); }
      catch (e) { /* URL inválida: se omite */ }
    }
    if (restored.length) {
      try { await browser.tabs.update(restored[0].id, { active: true }); } catch (e) {}
    }
    return { ok: true, data: { restored: restored.length, auto: !!auto, label: f.label } };
  },

  /* ¿Sigue vivo el foco? Lo consulta la terminal al ejecutar cualquier
     comando (poll barato, sin timers en el background). */
  async focusCheck() {
    const v = await this._load();
    const f = v.__focus;
    if (!f) return { ok: true, data: { active: false } };
    if (Date.now() >= f.endsAt) {
      /* Expiró mientras nadie miraba: restaura y avisa */
      const done = await this.focusStop(true);
      return { ok: true, data: { active: false, expired: true, restored: done.data.restored, label: done.data.label } };
    }
    return { ok: true, data: { active: true, leftMs: f.endsAt - Date.now(), label: f.label } };
  },
};
