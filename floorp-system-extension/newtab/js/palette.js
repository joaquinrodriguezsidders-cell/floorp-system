/* ============================================================
   FLOORP SYSTEM — palette.js (BOOT 08)
   Command Palette (Ctrl+K). UNA sola fuente de verdad: los
   comandos salen del mismo CommandEngine que la terminal
   (nativos + aliases + customs, en vivo, sin duplicar).
   ============================================================ */
"use strict";

const Palette = {
  el: null,
  input: null,
  list: null,
  open: false,
  items: [],
  selected: 0,

  /* ---- Datos: todos los comandos existentes, leídos del engine en vivo ---- */
  allCommands() {
    const out = [];
    for (const c of CommandEngine.registry.values()) {
      out.push({ name: c.name, desc: c.description, usage: c.usage || c.name, type: "native" });
    }
    for (const [a, target] of Object.entries(FSYS.aliases)) {
      out.push({ name: a, desc: `→ ${target}`, usage: a, type: "alias" });
    }
    for (const [n, def] of Object.entries(FSYS.customCommands)) {
      const desc = (def.actions || []).map((x) => x.type).join(", ") || "custom";
      out.push({ name: n, desc, usage: n, type: "custom" });
    }
    return out;
  },

  /* ---- Fuzzy subsecuencia: "wor" matchea "workspace".
         score = penalización por huecos entre matches;
         exacto y prefijo ganan por sobre subsecuencias. ---- */
  fuzzy(query, name) {
    if (!query) return { ok: true, score: 0 };
    const q = query.toLowerCase();
    const n = name.toLowerCase();
    if (n === q) return { ok: true, score: -100 };              // exacto gana
    if (n.startsWith(q)) return { ok: true, score: -50 };       // prefijo casi gana
    let i = 0, score = 0, last = -1;
    for (let j = 0; j < n.length && i < q.length; j++) {
      if (n[j] === q[i]) {
        score += j - (last + 1);                                 // hueco desde el match anterior
        last = j;
        i++;
      }
    }
    if (i < q.length) return { ok: false, score: Infinity };     // no es subsecuencia
    return { ok: true, score };
  },

  search(query) {
    const items = this.allCommands()
      .map((c) => {
        const f = this.fuzzy(query, c.name);
        return f.ok ? { ...c, score: f.score } : null;
      })
      .filter(Boolean)
      .sort((a, b) => a.score - b.score || a.name.localeCompare(b.name))
      .slice(0, 12);
    return items;
  },

  /* ---- UI ---- */
  init() {
    this.el = document.getElementById("palette");
    this.input = document.getElementById("palette-input");
    this.list = document.getElementById("palette-list");
    if (!this.el || !this.input || !this.list) return;

    /* Ctrl+K abre/cierra (en la home; no registra browser.commands global) */
    document.addEventListener("keydown", (e) => {
      if (e.ctrlKey && !e.altKey && !e.shiftKey && (e.key === "k" || e.key === "K")) {
        const ae = document.activeElement;
        if (ae && ae.tagName === "INPUT" && ae.id !== "term-input" && ae.id !== "palette-input") return;
        e.preventDefault();
        this.toggle();
      }
    });

    this.input.addEventListener("input", () => this.render());
    this.input.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { e.preventDefault(); this.close(); return; }
      if (e.key === "ArrowDown") { e.preventDefault(); this.move(1); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); this.move(-1); return; }
      if (e.key === "Enter") { e.preventDefault(); this.execute(); return; }
      if (e.key === "Tab") { e.preventDefault(); this.completeToArg(); return; }
    });

    /* mousedown (no click): aplica antes de cualquier blur */
    this.list.addEventListener("mousedown", (e) => {
      const row = e.target.closest(".pal");
      if (!row) return;
      e.preventDefault();
      this.selected = parseInt(row.dataset.i, 10);
      this.execute();
    });
  },

  toggle() { this.open ? this.close() : this.show(); },

  show() {
    this.open = true;
    this.el.hidden = false;
    this.input.value = "";
    this.render();
    this.input.focus({ preventScroll: true });
  },

  close() {
    this.open = false;
    this.el.hidden = true;
    Term.focus({ preventScroll: true });   /* el foco vuelve a la terminal */
  },

  render() {
    const q = this.input.value.trim();
    this.items = this.search(q);
    this.selected = 0;

    const esc = (s) => String(s).replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));
    const head = this.items.length
      ? `<div class="pal-head">${this.items.length} COMMAND${this.items.length === 1 ? "" : "S"}</div>`
      : `<div class="pal-head">SIN RESULTADOS</div>`;

    this.list.innerHTML = head + this.items.map((it, i) =>
      `<div class="pal${i === this.selected ? " sel" : ""}" data-i="${i}">
         <span class="name">${esc(it.name)}</span>
         <span class="type">${esc(it.type)}</span>
         <span class="desc">${esc(it.desc)}</span>
       </div>`).join("");
  },

  move(dir) {
    if (!this.items.length) return;
    this.selected = (this.selected + dir + this.items.length) % this.items.length;
    this.list.querySelectorAll(".pal").forEach((el, i) => {
      el.classList.toggle("sel", i === this.selected);
      if (i === this.selected) el.scrollIntoView({ block: "nearest" });
    });
  },

  /* El comando necesita argumento si su usage declara <algo> */
  needsArg(item) {
    return /<[^\s>]+/.test(item.usage) && item.type === "native";
  },

  /* Enter: ejecuta directo, o deja el comando + espacio en la terminal */
  execute() {
    const item = this.items[this.selected];
    if (!item) return;
    this.close();

    if (this.needsArg(item)) {
      /* Keyboard-first: el comando queda escrito, el usuario completa el argumento */
      Term.setInput(item.name.split(" ")[0] + " ");
      Term.printOut(`palette → ${item.name.split(" ")[0]} (escribí el argumento)`, "dim");
      return;
    }
    Term.printCmd(item.name);
    CommandEngine.execute(item.name);
  },

  /* Tab: igual que Enter con argumento, pero sin ejecutar */
  completeToArg() {
    const item = this.items[this.selected];
    if (!item) return;
    this.close();
    Term.setInput(item.name.split(" ")[0] + " ");
  },
};
