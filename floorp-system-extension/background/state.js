/* ============================================================
   FLOORP SYSTEM — background/state.js
   Estado persistente del cerebro (una sola fuente de verdad).
   ============================================================ */
"use strict";

const State = {
  DEFAULTS: {
    workspaces: [
      { id: 1, name: "DEV" },
      { id: 2, name: "SCHOOL" },
      { id: 3, name: "MEDIA" },
      { id: 4, name: "GAMING" },
      { id: 5, name: "RANDOM" },
    ],
    active: 1,
    /* session[wsId] = { tabs: [{url, title}], savedAt } */
    session: {},
  },

  cache: null,

  async load() {
    if (this.cache) return this.cache;
    const data = await browser.storage.local.get("fsys");
    this.cache = Object.assign({}, this.DEFAULTS, data.fsys || {});
    /* Garantiza que los 5 workspaces existan siempre */
    if (!Array.isArray(this.cache.workspaces) || this.cache.workspaces.length === 0) {
      this.cache.workspaces = this.DEFAULTS.workspaces.map((w) => ({ ...w }));
    }
    return this.cache;
  },

  async save() {
    await browser.storage.local.set({ fsys: this.cache });
  },

  invalidate() { this.cache = null; },
};
