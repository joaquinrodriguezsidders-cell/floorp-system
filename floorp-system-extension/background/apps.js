/* ============================================================
   FLOORP SYSTEM — background/apps.js
   Cliente del fsys-bridge (proceso local del usuario).
   · descubre el token una vez (endpoint bootstrap CORS-exento)
   · cachea disponibilidad (TTL) y catálogo de apps
   · TODOS los lanzamientos pasan por la allowlist del bridge
   Requiere permiso de host en el manifest para el loopback.
   ============================================================ */
"use strict";

const BridgeOS = {
  PORT: 58230,
  token: null,
  available: false,
  lastCheck: 0,
  lastList: null,        // [{id, name, installed, custom}]
  CHECK_TTL: 15000,
  LIST_TTL: 30000,

  base() { return `http://127.0.0.1:${this.PORT}`; },

  async _fetch(path, opts = {}, timeoutMs = 1500) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const headers = { ...(opts.headers || {}) };
      if (this.token) headers["X-FSYS-TOKEN"] = this.token;
      const res = await fetch(this.base() + path, { ...opts, headers, signal: ctrl.signal });
      const data = await res.json();
      /* El bridge regenera su token en cada arranque: si el background
         quedó con el viejo (server reiniciado), TODA llamada daría 401
         para siempre. Detectar UNAUTHORIZED → redescubrir y reintentar. */
      if (res.status === 401 && data && data.error === "UNAUTHORIZED") {
        this.token = null;
        if (!(await this.ensureToken())) return data;
        const headers2 = { ...(opts.headers || {}) };
        headers2["X-FSYS-TOKEN"] = this.token;
        const ctrl2 = new AbortController();
        const t2 = setTimeout(() => ctrl2.abort(), timeoutMs);
        try {
          const res2 = await fetch(this.base() + path, { ...opts, headers: headers2, signal: ctrl2.signal });
          return await res2.json();
        } finally { clearTimeout(t2); }
      }
      return data;
    } finally {
      clearTimeout(t);
    }
  },

  /* Descubre el token una vez por sesión del background. */
  async ensureToken() {
    if (this.token) return true;
    try {
      const res = await this._fetch("/token", {}, 1200);
      if (res && res.ok && res.token) {
        this.token = res.token;
        return true;
      }
    } catch (e) { /* bridge offline */ }
    return false;
  },

  async probe(force = false) {
    const now = Date.now();
    if (!force && this.available && now - this.lastCheck < this.CHECK_TTL) return true;
    if (!(await this.ensureToken())) { this.available = false; this.lastCheck = now; return false; }
    try {
      const res = await this._fetch("/health");
      this.available = !!(res && res.ok);
    } catch (e) {
      this.available = false;
    }
    this.lastCheck = now;
    return this.available;
  },

  async listApps(force = false) {
    const now = Date.now();
    if (!force && this.lastList && now - this.lastCheck < this.LIST_TTL) return this.lastList;
    if (!(await this.probe(force))) return null;
    try {
      const res = await this._fetch("/apps");
      if (res && res.ok) {
        this.lastList = res.apps;
        return this.lastList;
      }
    } catch (e) { /* offline */ }
    return null;
  },

  async launch(id) {
    if (!(await this.probe(true))) return { ok: false, error: "BRIDGE_OFFLINE" };
    try {
      return await this._fetch(`/apps/${encodeURIComponent(id)}/launch`, { method: "POST" }, 4000);
    } catch (e) {
      return { ok: false, error: "SIN_RESPUESTA" };
    }
  },

  async addApp(name, exe) {
    if (!(await this.probe(true))) return { ok: false, error: "BRIDGE_OFFLINE" };
    try {
      const res = await this._fetch("/apps/add", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, exe }),
      }, 3000);
      if (res && res.ok) this.lastList = null;   // invalida catálogo
      return res;
    } catch (e) {
      return { ok: false, error: "SIN_RESPUESTA" };
    }
  },

  async removeApp(name) {
    if (!(await this.probe(true))) return { ok: false, error: "BRIDGE_OFFLINE" };
    try {
      const res = await this._fetch("/apps/remove", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      }, 3000);
      if (res && res.ok) this.lastList = null;
      return res;
    } catch (e) {
      return { ok: false, error: "SIN_RESPUESTA" };
    }
  },

  async files() {
    if (!(await this.probe(true))) return { ok: false, error: "BRIDGE_OFFLINE" };
    try { return await this._fetch("/files"); } catch (e) { return { ok: false, error: "SIN_RESPUESTA" }; }
  },

  async writeFile(name, text) {
    if (!(await this.probe(true))) return { ok: false, error: "BRIDGE_OFFLINE" };
    try {
      return await this._fetch("/files/write", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, text }),
      }, 3000);
    } catch (e) { return { ok: false, error: "SIN_RESPUESTA" }; }
  },  async openFile(name) {
    if (!(await this.probe(true))) return { ok: false, error: "BRIDGE_OFFLINE" };
    try {
      return await this._fetch("/files/open", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      }, 3000);
    } catch (e) { return { ok: false, error: "SIN_RESPUESTA" }; }
  },

  async readFile(name) {
    if (!(await this.probe(true))) return { ok: false, error: "BRIDGE_OFFLINE" };
    try {
      return await this._fetch(`/files/read?name=${encodeURIComponent(name)}`);
    } catch (e) { return { ok: false, error: "SIN_RESPUESTA" }; }
  },

  /* ==== MÉTRICAS Y CONTROL DEL SO (jerarquía completa) ==== */
  async sys() {
    if (!(await this.probe(true))) return { ok: false, error: "BRIDGE_OFFLINE" };
    try { return await this._fetch("/sys", {}, 2500); } catch (e) { return { ok: false, error: "SIN_RESPUESTA" }; }
  },

  async processes() {
    if (!(await this.probe(true))) return { ok: false, error: "BRIDGE_OFFLINE" };
    try { return await this._fetch("/processes", {}, 6000); } catch (e) { return { ok: false, error: "SIN_RESPUESTA" }; }
  },

  async kill(pid) {
    if (!(await this.probe(true))) return { ok: false, error: "BRIDGE_OFFLINE" };
    try {
      return await this._fetch("/processes/kill", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pid }),
      }, 5000);
    } catch (e) { return { ok: false, error: "SIN_RESPUESTA" }; }
  },

  async notify(title, text) {
    if (!(await this.probe(true))) return { ok: false, error: "BRIDGE_OFFLINE" };
    try {
      return await this._fetch("/notify", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, text }),
      }, 4000);
    } catch (e) { return { ok: false, error: "SIN_RESPUESTA" }; }
  },

  async clipboardWrite(text) {
    if (!(await this.probe(true))) return { ok: false, error: "BRIDGE_OFFLINE" };
    try {
      return await this._fetch("/clipboard/write", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      }, 4000);
    } catch (e) { return { ok: false, error: "SIN_RESPUESTA" }; }
  },

  async folderOpen() {
    if (!(await this.probe(true))) return { ok: false, error: "BRIDGE_OFFLINE" };
    try {
      return await this._fetch("/folder/open", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: "{}",
      }, 4000);
    } catch (e) { return { ok: false, error: "SIN_RESPUESTA" }; }
  },

  /* ==== AI CORE (BOOT 10): Ollama local vía bridge, sin claves ni nube ==== */
  async aiStatus() {
    if (!(await this.probe(true))) return { ok: false, error: "BRIDGE_OFFLINE" };
    try { return await this._fetch("/ai/status", {}, 3500); }
    catch (e) { return { ok: false, error: "SIN_RESPUESTA" }; }
  },

  async aiGenerate(model, prompt, system) {
    if (!(await this.probe(true))) return { ok: false, error: "BRIDGE_OFFLINE" };
    try {
      return await this._fetch("/ai/generate", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model, prompt, system }),
      }, 120000);   /* modelos locales piensan: timeout alto */
    } catch (e) { return { ok: false, error: "SIN_RESPUESTA" }; }
  },
};

BridgeOS.init = async function () { /* token se descubre lazy en probe() */ };
