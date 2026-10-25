/* ============================================================
   FLOORP SYSTEM — background/main.js
   Router de mensajes: el único punto donde la home toca
   APIs privilegiadas. Toda acción es explícita y limitada.
   ============================================================ */
"use strict";

const Handlers = {
  async "ws.list"() {
    return { ok: true, data: await WorkspacesBG.summary() };
  },

  async "ws.switch"({ id, name }) {
    /* Acepta número (posición) o nombre (prefix match) — el frontend
       resuelve nombres; el backend también, por robustez. */
    const result = await WorkspacesBG.switchTo(
      (id !== undefined && id !== null && id !== "") ? Number(id) : String(name || "")
    );
    return { ok: true, data: result };
  },

  /* Enable: instrucciones exactas para activar el OS Server real.
     Punto único de verdad del setup — el comando `ws enable` lo muestra. */
  async "ws.enableInfo"() {
    const bridgeOn = await BridgeOS.probe(true);
    const tokenExists = bridgeOn ? !!(await (async () => {
      const r = await BridgeOS._fetch("/floorp/workspaces", {}, 6000).catch(() => null);
      return r && r.error !== "FLOORP_OS_OFFLINE";
    })()) : false;
    const steps = [
      "1) Abrí about:config (pegalo en la barra de direcciones y Enter)",
      "2) Buscá:  floorp.os.enabled   → ponelo en true (click en el botón)",
      "3) Buscá:  floorp.os.server.port  → verificá que sea 58261",
      "4) Reiniciá Floorp completamente (cerrar y abrir)",
      "5) Asegurate de que fsys-bridge esté corriendo (start-bridge.bat)",
      "6) Volvé acá y ejecutá:  ws   → debe decir NATIVO",
    ];
    return { ok: true, data: { bridgeOn, osServer: tokenExists, steps } };
  },

  /* Doctor: diagnóstico completo de la cadena Floorp ↔ bridge ↔ OS Server */
  async "ws.doctor"() {
    const bridgeOn = await BridgeOS.probe(true);
    const out = { bridge: bridgeOn, osServer: false, workspaces: 0, token: false, mode: "LOCAL" };
    if (bridgeOn) {
      const res = await BridgeOS._fetch("/floorp/workspaces", {}, 6000).catch(() => null);
      if (res) {
        if (Array.isArray(res.workspaces)) {
          out.osServer = true;
          out.token = true;
 out.workspaces = res.workspaces.length;
          out.mode = "NATIVE";
          out.names = res.workspaces.map((w) => w.name);
        } else if (res.error === "FLOORP_OS_OFFLINE") {
          out.reason = "OS Server apagado — activá floorp.os.enabled=true en about:config y reiniciá Floorp";
        } else if (res.error) {
          out.reason = res.error;
        }
      }
    } else {
      out.reason = "fsys-bridge offline — ejecutá fsys-bridge/start-bridge.bat";
    }      return { ok: true, data: out };
  },

  /* Workspace actual del navegador (para el sync visual en vivo).
     Una sola llamada GET — liviana, pensada para polling de 10s. */
  async "ws.current"() {
    if (!(await FloorpOS.probe())) return { ok: true, data: { mode: "SESSIONS" } };
    const list = await FloorpOS.listWorkspaces();
    if (!list || !list.length) return { ok: true, data: { mode: "SESSIONS" } };
    const cur = list.find((w) => w.isSelected) || null;
    return {
      ok: true,
      data: {
        mode: "NATIVE",
        id: cur ? list.indexOf(cur) + 1 : 0,
        name: cur ? cur.name : "—",
        nativeId: cur ? cur.id : null,
      },
    };
  },

  /* ==== Crear/cerrar workspaces ====
     Honestidad primero: el OS Server de Floorp (verificado en su código
     fuente, rutas.sys.mts) SOLO expone list/switch/next/previous — no hay
     create/delete nativo vía HTTP. Estos comandos operan sobre los
     workspaces propios (modo SESIONES); en NATIVO se niegan con la razón. */
  async "ws.create"({ name }) {
    if (await FloorpOS.probe()) {
      return { ok: false, error: "en modo NATIVO los workspaces se crean desde la UI de Floorp — el OS Server aún no expone create (modo SESIONES: 'ws enable' muestra cómo desactivar floorp.os.enabled)" };
    }
    const state = await State.load();
    const clean = String(name || "").trim().toUpperCase().slice(0, 16);
    if (!clean) return { ok: false, error: "nombre requerido: ws create <nombre>" };
    if (state.workspaces.some((w) => w.name === clean)) {
      return { ok: false, error: `ya existe un workspace ${clean}` };
    }
    const id = state.workspaces.length ? Math.max(...state.workspaces.map((w) => w.id)) + 1 : 1;
    state.workspaces.push({ id, name: clean });
    await State.save();
    return { ok: true, data: { id, name: clean } };
  },

  async "ws.close"({ id }) {
    if (await FloorpOS.probe()) {
      return { ok: false, error: "en modo NATIVO los workspaces se cierran desde la UI de Floorp — el OS Server aún no expone delete" };
    }
    const state = await State.load();
    const wid = Number(id);
    if (state.workspaces.length <= 1) return { ok: false, error: "no podés cerrar el último workspace" };
    const idx = state.workspaces.findIndex((w) => w.id === wid);
    if (idx < 0) return { ok: false, error: `workspace ${id} no existe` };
    if (state.active === wid) return { ok: false, error: "estás parado ahí — cambiá de workspace primero" };
    const [removed] = state.workspaces.splice(idx, 1);
    delete state.session[wid];
    /* Reindexa a 1..N contiguo (Alt+1..9 y la barra asumen posiciones) */
    state.workspaces.forEach((w, i) => {
      if (w.id !== i + 1) {
        const old = w.id;
        w.id = i + 1;
        const s = state.session[old];
        if (s) { delete state.session[old]; state.session[i + 1] = s; }
      }
    });
    if (state.active > state.workspaces.length) state.active = state.workspaces.length;
    await State.save();
    return { ok: true, data: { removed: removed.name, count: state.workspaces.length } };
  },

  /* next/previous estilo Hyprland (nativo con fallback) */
  async "ws.step"({ dir }) {
    const result = await WorkspacesBG.step(Number(dir));
    return { ok: true, data: result };
  },

  async "ws.rename"({ id, name }) {
    const ws = await WorkspacesBG.rename(Number(id), String(name));
    return { ok: true, data: ws };
  },

  async "ws.save"({ id }) {
    const n = await WorkspacesBG.saveSession(Number(id));
    return { ok: true, data: { saved: n } };
  },

  async "ws.add"({ id, url }) {
    const n = await WorkspacesBG.addUrlToSession(Number(id), String(url));
    return { ok: true, data: { total: n } };
  },

  /* Agrega una tab abierta a la sesión de un workspace (modo SESIONES).
     Si ya existe esa URL en la sesión, no duplica. */
  async "ws.addTab"({ id, url }) {
    const state = await State.load();
    const wid = Number(id);
    const ws = state.workspaces.find((w) => w.id === wid);
    if (!ws) return { ok: false, error: `workspace ${id} no existe` };
    if (!state.session[wid]) state.session[wid] = { tabs: [], savedAt: 0 };
    const sess = state.session[wid];
    if (sess.tabs.some((t) => t.url === url)) {
      return { ok: true, data: { total: sess.tabs.length, dup: true } };
    }
    sess.tabs.push({ url, title: url });
    await State.save();
    return { ok: true, data: { total: sess.tabs.length } };
  },

  /* ==== AUTOMATIZACIONES (v0.15): reglas on/off desde la terminal ==== */
  async "auto.status"() {
    return { ok: true, data: await Auto.status() };
  },

  async "auto.set"({ rule, on, arg }) {
    const res = await Auto.setOn(String(rule), !!on, arg);
    if (!res.ok) return res;
    /* Feedback inmediato en downloads: confirma que el permiso existe */
    if (String(rule) === "downloads" && on) Auto.downloadsInit();
    return res;
  },

  /* Dispara el chequeo manual (para 'auto run' desde la terminal) */
  async "auto.run"() {
    const fired = await Auto.tick();
    return { ok: true, data: { fired } };
  },

  /* ==== Persistencia de la shell (aliases/commands/history) ====
     Vive en storage.local del BACKGROUND (mismo storage para toda la
     extensión), no en localStorage de la página (que cambia de origen
     entre file:// y moz-extension://). Esto evita perder aliases. */
  async "store.get"({ key }) {
    const KEY = `fsys.${key}`;
    const res = await browser.storage.local.get(KEY);
    return { ok: true, data: res[KEY] ?? null };
  },

  async "store.set"({ key, value }) {
    const KEY = `fsys.${key}`;
    await browser.storage.local.set({ [KEY]: value });
    return { ok: true };
  },

  /* Estado rápido para el arranque de la home */
  async "system.status"() {
    const s = await WorkspacesBG.summary();
    return { ok: true, data: { bridge: "ONLINE", osServer: FloorpOS.available, ...s } };
  },

  /* ==== TABS (BOOT 07) ==== */
  /* Lista de tabs de la ventana actual (para el panel de la home) */
  async "tab.list"() {
    const tabs = await browser.tabs.query({ currentWindow: true });
    return {
      ok: true,
      data: tabs.map((t) => ({
        id: t.id,
        title: t.title || t.url || "(sin título)",
        url: t.url,
        active: t.active,
        pinned: t.pinned,
      })),
    };
  },

  /* Nueva tab real en la ventana actual */
  async "tab.new"({ url }) {
    const createProps = { active: true };
    if (url) createProps.url = url;
    const tab = await browser.tabs.create(createProps);
    return { ok: true, data: { id: tab.id } };
  },

  /* Cerrar una tab por id */
  async "tab.close"({ id }) {
    await browser.tabs.remove(Number(id));
    return { ok: true };
  },

  /* Activar una tab por id */
  async "tab.activate"({ id }) {
    await browser.tabs.update(Number(id), { active: true });
    return { ok: true };
  },

  /* Recargar una tab */
  async "tab.reload"({ id }) {
    await browser.tabs.reload(Number(id));
    return { ok: true };
  },

  /* Fijar / desfijar una tab */
  async "tab.pin"({ id, pinned }) {
    await browser.tabs.update(Number(id), { pinned: !!pinned });
    return { ok: true, data: { pinned: !!pinned } };
  },

  /* ==== SISTEMA OPERATIVO (fsys-bridge, BOOT 09.5) ==== */
  async "bridge.status"() {
    const on = await BridgeOS.probe(true);
    const apps = on ? await BridgeOS.listApps(true) : null;
    return {
      ok: true,
      data: {
        online: on,
        port: BridgeOS.PORT,
        apps: apps || [],
        installedCount: apps ? apps.filter((a) => a.installed).length : 0,
      },
    };
  },

  async "apps.list"() {
    const apps = await BridgeOS.listApps(true);
    if (!apps) return { ok: false, error: "BRIDGE_OFFLINE" };
    return { ok: true, data: apps };
  },

  async "app.launch"({ id }) {
    return BridgeOS.launch(String(id));
  },

  async "app.add"({ name, exe }) {
    return BridgeOS.addApp(String(name), String(exe));
  },

  async "app.remove"({ name }) {
    return BridgeOS.removeApp(String(name));
  },

  async "files.list"() {
    return BridgeOS.files();
  },

  async "files.write"({ name, text }) {
    return BridgeOS.writeFile(String(name), String(text ?? ""));
  },

  async "files.open"({ name }) {
    return BridgeOS.openFile(String(name));
  },

  async "files.read"({ name }) {
    return BridgeOS.readFile(String(name));
  },

  /* ==== MÉTRICAS / PROCESOS / NOTIFY / CLIP / FOLDER ==== */
  async "sys.metrics"() {
    return BridgeOS.sys();
  },

  async "sys.processes"() {
    return BridgeOS.processes();
  },

  async "sys.kill"({ pid }) {
    return BridgeOS.kill(Number(pid));
  },

  async "sys.notify"({ title, text }) {
    return BridgeOS.notify(String(title || "FLOORP SYSTEM").slice(0, 64), String(text || "").slice(0, 256));
  },

  async "sys.clip"({ text }) {
    return BridgeOS.clipboardWrite(String(text ?? ""));
  },

  async "sys.folder"() {
    return BridgeOS.folderOpen();
  },

  /* ==== AI CORE (Ollama local vía fsys-bridge) ==== */
  async "ai.status"() {
    return BridgeOS.aiStatus();
  },

  async "ai.generate"({ model, prompt, system }) {
    return BridgeOS.aiGenerate(String(model || ""), String(prompt || "").slice(0, 4000), String(system || "").slice(0, 2000));
  },

  /* ==== BÓVEDA DE SESIONES + MODO FOCO (BOOT 11) ==== */
  async "vault.save"({ name }) {
    return Vault.save(String(name || ""));
  },

  async "vault.load"({ name }) {
    return Vault.load(String(name || ""));
  },

  async "vault.list"() {
    return Vault.list();
  },

  async "vault.rm"({ name }) {
    return Vault.remove(String(name || ""));
  },

  async "focus.start"({ minutes, label }) {
    return Vault.focusStart(Number(minutes), String(label || ""));
  },

  async "focus.stop"() {
    return Vault.focusStop(false);
  },

  async "focus.check"() {
    return Vault.focusCheck();
  },

  /* ==== RADIO 2.0 ====
     La UI normalmente habla directo con RadioEngine (mismo proceso).
     Estos mensajes existen como plan B: si una vista no puede usar
     getBackgroundPage(), todo sigue funcionando por acá. */
  async "radio.state"() {
    await RadioEngine.ensure();
    return { ok: true, data: RadioEngine.snapshot() };
  },

  async "radio.list"() {
    await RadioEngine.ensure();
    return { ok: true, data: RadioEngine.list() };
  },

  async "radio.cmd"(p) {
    const { cmd, ...rest } = p || {};
    return RadioEngine.handle(cmd, rest);
  },

  /* Navegación relativa: next / prev con wrap-around */
  async "tab.step"({ dir }) {
    const tabs = await browser.tabs.query({ currentWindow: true });
    if (tabs.length < 2) return { ok: true, data: { moved: false } };
    const idx = tabs.findIndex((t) => t.active);
    const next = (idx + (dir > 0 ? 1 : -1) + tabs.length) % tabs.length;
    await browser.tabs.update(tabs[next].id, { active: true });
    return { ok: true, data: { moved: true, title: tabs[next].title } };
  },
};

/* Arranque del background: reglas de auto ya activadas + clientes lazy.
   (El OS Server no necesita init: probe() es perezoso y con TTL.) */
(async () => {
  try { await Auto.syncTimer(); } catch (e) { /* sin reglas: nada */ }
  try { Auto.downloadsInit(); } catch (e) { /* sin permiso: no se ofrece */ }
})();

browser.runtime.onMessage.addListener((msg, sender) => {
  /* Solo acepta mensajes de páginas de la propia extensión */
  if (!sender.url || !sender.url.startsWith(browser.runtime.getURL(""))) {
    return Promise.resolve({ ok: false, error: "FORBIDDEN" });
  }
  const handler = Handlers[msg && msg.type];
  if (!handler) return Promise.resolve({ ok: false, error: "UNKNOWN_MESSAGE" });

  return handler(msg.payload || {})
    .then((data) => data)               /* ya viene envuelto {ok, data} */
    .catch((e) => ({ ok: false, error: e.message }));
});
