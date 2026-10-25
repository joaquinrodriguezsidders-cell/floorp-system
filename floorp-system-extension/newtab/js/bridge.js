/* ============================================================
   FLOORP SYSTEM — bridge.js
   Puente home ↔ background. Si no hay extensión (modo file://)
   queda en LOCAL y todo sigue funcionando sin errores ruidosos.
   ============================================================ */
"use strict";

const Bridge = {
  available: false,
  status: "--",
  appsOnline: false,
  appsCount: 0,

  _hasAPI() {
    return typeof browser !== "undefined" &&
           browser.runtime &&
           typeof browser.runtime.sendMessage === "function";
  },

  async call(type, payload = {}, timeoutMs = 800) {
    if (!this._hasAPI()) throw new Error("NO_BRIDGE");
    return Promise.race([
      browser.runtime.sendMessage({ type, payload }),
      new Promise((_, rej) => setTimeout(() => rej(new Error("BRIDGE_TIMEOUT")), timeoutMs)),
    ]);
  },

  /* ==== Persistencia de la shell a través del bridge ====
     Los datos viven en storage.local del background (único para
     toda la extensión, independiente del origen de la página). */
  async storeGet(key, fallback) {
    try {
      const res = await this.call("store.get", { key }, 1500);
      if (res && res.ok) return res.data ?? fallback;
    } catch (e) { /* sin bridge */ }
    return fallback;
  },

  async storeSet(key, value) {
    if (!this.available) return;
    try { await this.call("store.set", { key, value }, 1500); } catch (e) { /* sin bridge */ }
  },

  /* Handshake al arrancar la home. Devuelve estado del sistema o null. */
  async hello() {
    try {
      const res = await this.call("system.status", {}, 1500);
      if (res && res.ok) {
        this.available = true;
        this.status = "ONLINE";
        return res.data;
      }
      this.status = (res && res.error) || "LOCAL";
    } catch (e) {
      this.status = "LOCAL";
    }
    return null;
  },
};
