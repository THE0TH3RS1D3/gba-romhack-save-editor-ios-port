/* Gen 3 Romhack Save Editor - mobile UI (port of romhack_save_editor.py). Engine: gen3lib.js */
"use strict";
const g3 = window.G3;
const $ = s => document.querySelector(s);
function h(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  for (const k in (attrs || {})) {
    const v = attrs[k];
    if (v === false || v === null || v === undefined) continue;
    if (k === "class") e.className = v;
    else if (k === "text") e.textContent = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else if (k === "value") e.value = v;
    else e.setAttribute(k, v === true ? "" : v);
  }
  for (const c of kids.flat()) if (c !== null && c !== undefined && c !== false) e.append(c.nodeType ? c : document.createTextNode(String(c)));
  return e;
}
const pad4 = n => String(n).padStart(4, "0");
const tick = () => new Promise(r => setTimeout(r, 30));

// ------------------------------------------------------------------ persistence (IndexedDB, memory fallback)
const kv = (() => {
  const mem = new Map(); let dbp = null;
  function db() {
    if (!dbp) dbp = new Promise((res, rej) => {
      try {
        const rq = indexedDB.open("gen3editor", 1);
        rq.onupgradeneeded = () => rq.result.createObjectStore("kv");
        rq.onsuccess = () => res(rq.result); rq.onerror = () => rej(rq.error);
      } catch (e) { rej(e); }
    });
    return dbp;
  }
  const run = (mode, fn) => db().then(d => new Promise((res, rej) => {
    const tx = d.transaction("kv", mode), st = tx.objectStore("kv"), rq = fn(st);
    tx.oncomplete = () => res(rq ? rq.result : undefined); tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error);
  }));
  return {
    async get(k) { try { const v = await run("readonly", s => s.get(k)); return v === undefined ? null : v; } catch (e) { return mem.has(k) ? mem.get(k) : null; } },
    async set(k, v) { try { await run("readwrite", s => s.put(v, k)); } catch (e) { mem.set(k, v); } },
    async del(k) { try { await run("readwrite", s => s.delete(k)); } catch (e) { mem.delete(k); } },
  };
})();

// ------------------------------------------------------------------ native bridge
function toBase64(bytes) {
  let s = ""; const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  return btoa(s);
}
function exportFile(name, bytes) {
  const nat = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.native;
  if (nat) { nat.postMessage({ type: "export", name, data: toBase64(bytes) }); return; }
  const a = h("a", { href: URL.createObjectURL(new Blob([bytes], { type: "application/octet-stream" })), download: name });
  document.body.append(a); a.click(); a.remove();
}
function pickFile() {
  return new Promise(res => {
    const inp = h("input", { type: "file", style: "position:fixed;left:-1000px", onchange: () => { res(inp.files && inp.files[0]); inp.remove(); } });
    document.body.append(inp); inp.click();
  });
}

// ------------------------------------------------------------------ state
const GAME_CHOICES = [["Auto-detect", null], ["Pokémon Unbound", g3.UNBOUND], ["Pokémon Radical Red", g3.RADICAL_RED],
  ["Emerald Legacy", g3.EMERALD_LEGACY], ["Emerald Imperium", "Imperium"], ["Heart & Soul", "HeartAndSoul"],
  ["Ruby / Sapphire", g3.RS], ["FireRed / LeafGreen", g3.FRLG], ["Emerald", g3.EMERALD]];
const POCKET_LABELS = { pc_items: "PC items", items: "Items", keyitems: "Key items", balls: "Poké Balls", tms: "TMs / HMs",
  berries: "Berries", megastones: "Mega Stones", medicine: "Medicine / battle items" };
const HP_TYPES = ["Fighting", "Flying", "Poison", "Ground", "Rock", "Bug", "Ghost", "Steel", "Fire", "Water", "Grass", "Electric", "Psychic", "Ice", "Dragon", "Dark"];
const DISP = [0, 1, 2, 4, 5, 3];      // display order HP/Atk/Def/SpA/SpD/Spe -> index in save order
const S = {
  rom: null, romName: "", save: null, saveRaw: null, saveName: "", gameIdx: 0, saveNotes: [], dirty: false,
  tab: "file", box: 0, boxView: "grid", pocket: null, bagDraft: null, bagDirty: false,
  settings: { sprites: false, large: false, remember: true }, resume: {},
};
const spriteCache = new Map();

// ------------------------------------------------------------------ UI helpers
function setStatus(t) { $("#status").textContent = t; }
function toast(t) {
  const el = $("#toast"); el.textContent = t; el.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => { el.hidden = true; }, 3200);
}
function busy(t) { $("#busyText").textContent = t || ""; $("#busy").hidden = !t; }
function dialog(msg, buttons) {
  return new Promise(res => {
    const box = h("div", {}, h("p", { text: msg }), h("div", { class: "btns" },
      buttons.map(([label, val, cls]) => h("button", { class: cls || "", text: label, onclick: () => { d.remove(); res(val); } }))));
    const d = h("div", { class: "dlg" }, box); document.body.append(d);
  });
}
const alertBox = msg => dialog(msg, [["OK", true, "primary"]]);
const confirmBox = (msg, ok, danger) => dialog(msg, [[ok || "OK", true, danger ? "primary danger" : "primary"], ["Cancel", false]]);
function overlay(title, body, footer, leftBtn, rightBtn) {
  const el = h("div", { class: "sheet" },
    h("div", { class: "sh" }, leftBtn || h("button", { text: "Close", onclick: () => closeOverlay(el) }), h("h3", { text: title }), rightBtn || h("span", { style: "min-width:64px" })),
    h("div", { class: "sb" }, body), footer ? h("div", { class: "sf" }, footer) : null);
  $("#overlays").append(el);
  return el;
}
function closeOverlay(el) { if (el && el.parentNode) el.remove(); }

// ------------------------------------------------------------------ ROM / name helpers
const speciesName = i => S.rom ? S.rom.species(i) : g3.fallbackSpecies(i);
const itemName = i => S.rom ? S.rom.item(i) : (i === 0 ? "(none)" : g3.fallbackItem(i));
const moveName = i => S.rom ? S.rom.move(i) : g3.fallbackMove(i);
const speciesCount = () => S.rom && S.rom.species_names.length ? S.rom.species_names.length : 1500;
const itemCount = () => S.rom && S.rom.item_names.length ? S.rom.item_names.length : 1000;
const moveCount = () => S.rom && S.rom.move_names.length ? S.rom.move_names.length : 1000;
const sInfo = sid => S.rom ? S.rom.speciesInfo(sid) : null;
function growthOf(sid) { const i = sInfo(sid); return i && i.growth < 6 ? i.growth : 0; }
function monLevel(m) { const i = sInfo(m.species); return i && i.growth < 6 ? g3.levelFromExp(i.growth, m.exp) : 0; }
const lvOf = m => m.level || monLevel(m) || 0;

function spriteURL(species, shiny) {
  if (!S.rom || !S.settings.sprites) return null;
  const key = species + (shiny ? "s" : "");
  if (!spriteCache.has(key)) {
    let url = null;
    try {
      const img = S.rom.spriteRgba(species, !!shiny);
      if (img) {
        const c = document.createElement("canvas"); c.width = img.w; c.height = img.h;
        c.getContext("2d").putImageData(new ImageData(img.data, img.w, img.h), 0, 0);
        url = c.toDataURL("image/png");
      }
    } catch (e) { url = null; }
    spriteCache.set(key, url);
  }
  return spriteCache.get(key);
}

// ------------------------------------------------------------------ searchable picker
function pickName({ title, count, ids, nameFn, current, allowNone }) {
  return new Promise(res => {
    const list = ids || Array.from({ length: count }, (_, i) => i);
    const q = h("input", { type: "search", placeholder: "Search name or number…", autocapitalize: "none", autocorrect: "off", spellcheck: "false" });
    const box = h("div", { class: "plist" });
    let el;
    const done = v => { closeOverlay(el); res(v); };
    function render() {
      const s = q.value.trim().toLowerCase(); box.textContent = "";
      const rows = [];
      if (/^\d+$/.test(s) && +s <= 65535) rows.push(h("button", { onclick: () => done(+s) }, "Use ID " + (+s) + " ", h("small", { text: "(" + nameFn(+s) + ")" })));
      let shown = 0;
      for (const id of list) {
        if (shown >= 150) break;
        const label = pad4(id) + "  " + nameFn(id);
        if (!s || label.toLowerCase().includes(s)) { rows.push(h("button", { class: id === current ? "cur" : "", onclick: () => done(id), text: label })); shown++; }
      }
      if (shown >= 150) rows.push(h("div", { class: "hint", style: "padding:10px", text: "Showing the first 150 matches - type to narrow down." }));
      if (!rows.length) rows.push(h("div", { class: "hint", style: "padding:10px", text: "No match." }));
      box.append(...rows);
    }
    q.addEventListener("input", render);
    el = overlay(title, [h("div", { style: "margin-bottom:8px" }, q), box], null,
      h("button", { text: "Cancel", onclick: () => done(null) }), allowNone ? h("button", { text: "None", onclick: () => done(0) }) : null);
    render();
    setTimeout(() => q.focus(), 250);
  });
}
function pickerButton(getLabel, onTap, bad) {
  const b = h("button", { class: "picker" + (bad ? " bad" : ""), onclick: onTap });
  b.update = () => { b.textContent = ""; b.append(h("span", { text: getLabel() }), h("span", { class: "chev", text: "›" })); };
  b.update();
  return b;
}
function numField(min, max, value, onchange) {
  const i = h("input", { type: "number", inputmode: "numeric", pattern: "[0-9]*", min, max, value: String(value) });
  i.get = () => { let v = parseInt(i.value, 10); if (isNaN(v)) v = min; return Math.max(min, Math.min(max, v)); };
  i.set = v => { i.value = String(v); };
  i.addEventListener("change", () => { i.set(i.get()); if (onchange) onchange(); });
  if (onchange) i.addEventListener("input", () => { if (i.value !== "") onchange(true); });
  return i;
}

// ------------------------------------------------------------------ opening files
async function openRom(file) {
  try {
    busy("Reading ROM…"); await tick();
    const buf = new Uint8Array(await file.arrayBuffer());
    busy("Scanning ROM… (a few seconds the first time, then cached)"); await tick();
    const hash = g3.sha1hex(buf);
    const cached = await kv.get("romcache:" + hash);
    const rom = new g3.RomInfo(buf, { hash, cached });
    rom.onCacheChange = () => kv.set("romcache:" + hash, rom.cacheObject());
    if (!rom.fromCache) await kv.set("romcache:" + hash, rom.cacheObject());
    S.rom = rom; S.romName = file.name; spriteCache.clear();
    g3.UnboundMon.move_pp_lookup = rom.move_pps.length ? (i => rom.movePP(i)) : null;
    if (S.settings.remember) { kv.set("last:rom", { name: file.name, data: buf }); S.resume.rom = file.name; }
    if (S.settings.sprites) { busy("Scanning the ROM for sprite tables…"); await tick(); rom.ensureGfx(); }
    const hack = rom.hack ? ` [${rom.hack}]` : "";
    setStatus(`ROM loaded: ${rom.game_title} (${rom.game_code})${hack} - ${rom.species_names.length} species, ${rom.item_names.length} items, ${rom.move_names.length} moves`);
    checkMatch(); renderAll();
  } catch (e) { await alertBox("Could not read ROM:\n" + (e && e.message ? e.message : e)); }
  finally { busy(""); }
}
async function openSaveBytes(raw, name) {
  try {
    const save = g3.loadSave(raw, GAME_CHOICES[S.gameIdx][1]);
    S.save = save; S.saveRaw = Uint8Array.from(raw); S.saveName = name; S.dirty = false;
    onSaveLoaded();
  } catch (e) { await alertBox(e && e.message ? e.message : String(e)); }
}
async function openSave(file) {
  const raw = new Uint8Array(await file.arrayBuffer());
  await openSaveBytes(raw, file.name);
  if (S.save && S.settings.remember) { kv.set("last:save", { name: file.name, data: raw }); S.resume.save = file.name; }
}
function reloadLayout() {
  if (!S.saveRaw) return;
  try { S.save = g3.loadSave(S.saveRaw, GAME_CHOICES[S.gameIdx][1]); S.dirty = false; onSaveLoaded(); }
  catch (e) { alertBox(e && e.message ? e.message : String(e)); }
}
function onSaveLoaded() {
  const s = S.save;
  let st = `Save loaded: ${s.game} layout, slot @0x${s.slot_offset.toString(16).toUpperCase()}, save counter ${s.counter}`;
  if (s.hack) st += `  [${s.hack} save]`;
  setStatus(st);
  const notes = [];
  if (s.cfru === g3.RADICAL_RED) notes.push("ℹ Pokémon Radical Red save (CFRU layout, detected by its security-key pattern): party, PC, bag and money are supported. Use the layout selector if it was detected wrongly.");
  else if (s.is_unbound) notes.push("ℹ Pokémon Unbound save: party, PC (24 boxes), bag pockets, key items and money are supported (layout from the PUSE editor). Level of PC Pokémon is not shown; battle points / section 4 are never touched.");
  else if (s instanceof g3.ExpansionSave) notes.push(`ℹ ${s.hack} save (pokeemerald-expansion based): party, PC, bag and money are supported. Species / move / item names come from the ROM when it can be read; otherwise numbers are shown.`);
  else if (s.legacy) notes.push("ℹ Pokémon Emerald Legacy save: Emerald layout with the 120-slot item pocket.");
  else if (s.nonstandard) notes.push("ℹ Non-standard save format (custom checksum section sizes). Only sections you change are rewritten; party/PC/bag offsets are unverified for this hack.");
  if (s.bad_sections.length) notes.push(`⚠ Checksum scheme unknown for sections [${s.bad_sections.slice().sort((a, b) => a - b)}].`);
  S.saveNotes = notes;
  S.box = 0; S.pocket = null; S.bagDraft = null; S.bagDirty = false;
  checkMatch();
  if (S.tab === "file") S.tab = "pokemon";
  renderAll();
}
function checkMatch() {
  const notes = S.saveNotes.slice();
  if (S.rom && S.save) {
    const romUnb = (S.rom.hack || "").includes("Unbound"), savUnb = S.save.hack === "Pokémon Unbound";
    if (savUnb && !romUnb) notes.push("⚠ This save is from Pokémon Unbound but the opened ROM is not - names will be wrong. Open the Unbound ROM.");
    else if (romUnb && !savUnb) notes.push("⚠ The ROM is Pokémon Unbound but this save does not look like an Unbound save.");
  }
  const w = $("#warn"); w.textContent = notes.join("\n"); w.hidden = !notes.length;
}
function markDirty() { S.dirty = true; renderHeader(); }
function renderHeader() { $("#btnSave").disabled = !S.save; $("#dirty").hidden = !S.dirty; }

async function writeSave() {
  if (!S.save) return;
  const out = S.save.to_bytes();
  if (S.save.unfixable.length) {
    const ok = await confirmBox(`Sections [${S.save.unfixable}] were changed but their checksum scheme is unknown. The game would probably reject this save. Export it anyway?`, "Export anyway", true);
    if (!ok) return;
  }
  exportFile(S.saveName || "save.sav", out);
  S.saveRaw = Uint8Array.from(out); S.dirty = false; renderHeader();
  setStatus("Exported " + (S.saveName || "save.sav") + ". In the share sheet choose “Save to Files” and replace the old file (keep the original as backup first).");
}

// ------------------------------------------------------------------ Pokémon helpers (port of Main methods)
const sameWhere = (a, b) => a && b && a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
function monAt(where) {
  const [kind, a, b] = where;
  if (kind === "party") { const p = S.save.party(); return a < p.length ? p[a] : null; }
  return S.save.box_pokemon().get(a * 30 + b) || null;
}
function whereLabel(w) { return w[0] === "party" ? `Party ${w[1] + 1}` : `Box ${w[1] + 1} / slot ${w[2] + 1}`; }
function createMon(where) {
  const [kind, a, b] = where;
  const mon = g3.makeNewMon(S.save, S.rom, 1, 5);
  if (kind === "party") S.save.add_party_member(mon); else S.save.set_box_pokemon(a, b, mon);
  markDirty();
}
function deleteMon(where) {
  const [kind, a, b] = where;
  if (kind === "party") S.save.remove_party_member(a); else S.save.delete_box_pokemon(a, b);
  markDirty();
}
function moveSlot(src, dst) {
  if (sameWhere(src, dst)) return false;
  const sm = monAt(src), dm = monAt(dst);
  if (!sm) return false;
  if (src[0] === "box" && dst[0] === "box") {
    S.save.set_box_pokemon(dst[1], dst[2], sm);
    if (!dm) S.save.delete_box_pokemon(src[1], src[2]); else S.save.set_box_pokemon(src[1], src[2], dm);
  } else if (src[0] === "party" && dst[0] === "box") {
    if (dm) throw new Error("That box slot is occupied - move the Pokémon to an empty slot.");
    if (S.save.party().length <= 1) throw new Error("Keep at least one Pokémon in the party.");
    S.save.set_box_pokemon(dst[1], dst[2], sm); S.save.remove_party_member(src[1]);
  } else if (dst[0] === "party") throw new Error("To put a Pokémon into the party use “Copy to…” (it appends to the party).");
  else throw new Error("Cannot move there.");
  markDirty();
  return true;
}

// ------------------------------------------------------------------ the Pokémon editor sheet
function openEditor(mon, where, afterClose) {
  const E = { mon, where, species: mon.species, item: mon.held_item, moves: mon.moves.slice(), sync: false };
  const rom = S.rom;
  const infoLine = h("div", { class: "hint", style: "color:var(--warn)" });
  const sprite = h("img", { class: "spr" + (S.settings.large ? " lg" : ""), hidden: true });
  const speciesBtn = pickerButton(() => `${pad4(E.species)}  ${speciesName(E.species)}`, async () => {
    const v = await pickName({ title: "Species", count: speciesCount(), nameFn: speciesName, current: E.species });
    if (v !== null) { E.species = v; speciesBtn.update(); onSpeciesChanged(); }
  });
  const itemBtn = pickerButton(() => `${pad4(E.item)}  ${itemName(E.item)}`, async () => {
    const v = await pickName({ title: "Held item", count: itemCount(), nameFn: itemName, current: E.item, allowNone: true });
    if (v !== null) { E.item = v; itemBtn.update(); }
  });
  const nick = h("input", { type: "text", maxlength: "12", value: mon.nickname, autocapitalize: "none", autocorrect: "off" });
  const level = numField(1, 100, 1, () => onLevel());
  const exp = numField(0, 2000000000, 0, () => onExp());
  const moveBtns = [0, 1, 2, 3].map(i => pickerButton(() => `${pad4(E.moves[i])}  ${moveName(E.moves[i])}`, async () => {
    const v = await pickName({ title: "Move " + (i + 1), count: moveCount(), nameFn: moveName, current: E.moves[i], allowNone: true });
    if (v !== null) { E.moves[i] = v; moveBtns[i].update(); }
  }));
  const ivs = g3.STAT_NAMES.map(() => numField(0, 31, 0, () => updatePreview()));
  const evs = g3.STAT_NAMES.map(() => numField(0, 255, 0, () => updatePreview()));
  const nature = h("select", {}, g3.NATURES.map((n, i) => {
    const [up, down] = g3.natureEffect(i);
    return h("option", { value: i, text: `${n} (${up === down ? "neutral" : `+${g3.STAT_NAMES[up]} / -${g3.STAT_NAMES[down]}`})` });
  }));
  nature.addEventListener("change", updatePreview);
  const ability = h("select");
  const shiny = h("input", { type: "checkbox" });
  shiny.addEventListener("change", refreshSprite);
  const happy = numField(0, 255, mon.happiness);
  const ball = numField(0, 255, 0);
  const recalc = h("input", { type: "checkbox" }); recalc.checked = true;
  const preview = h("pre");
  const statsTbl = h("div");
  const hpLbl = h("div", { class: "hint" });
  const pidLbl = h("div", { class: "hint" });
  const ppLbl = h("div", { class: "hint" });

  const growth = sid => growthOf(sid === undefined ? E.species : sid);
  function onLevel() { if (E.sync) return; E.sync = true; exp.set(g3.expForLevel(growth(), level.get())); E.sync = false; updatePreview(); }
  function onExp() { if (E.sync) return; E.sync = true; level.set(g3.levelFromExp(growth(), exp.get())); E.sync = false; updatePreview(); }
  function onSpeciesChanged() {
    if (E.sync) return;
    E.sync = true; exp.set(g3.expForLevel(growth(), level.get())); E.sync = false;
    fillAbilities(E.species, parseInt(ability.value, 10) || 0);
    updatePreview(); refreshSprite();
  }
  function fillAbilities(sid, slot) {
    const info = sInfo(sid);
    let names = ["Ability 1", "Ability 2", "Hidden ability"];
    if (info) {
      const ids = info.abilities;
      names = [rom.ability(ids[0]), ids[1] ? rom.ability(ids[1]) : rom.ability(ids[0]) + " (no 2nd ability)", ids[2] ? rom.ability(ids[2]) : "(no hidden ability)"];
    }
    ability.textContent = "";
    const n = E.mon.ABILITY_SLOTS;
    for (let i = 0; i < n; i++) ability.append(h("option", { value: i, text: `${i < 2 ? i + 1 : "H"}: ${names[i]}` }));
    ability.value = String(Math.min(slot, n - 1));
  }
  function refreshSprite() {
    const url = spriteURL(E.species, shiny.checked);
    sprite.hidden = !(S.settings.sprites && S.rom);
    if (url) { sprite.src = url; sprite.style.opacity = 1; } else { sprite.removeAttribute("src"); sprite.style.opacity = 0.2; }
  }
  function updatePreview() {
    const evv = evs.map(e => e.get()), ivv = ivs.map(e => e.get()), tot = evv.reduce((a, b) => a + b, 0);
    let txt = `EV total ${tot}/510` + (tot > 510 ? "  ⚠ over the legal limit (works in game, but not legit)" : "");
    const info = sInfo(E.species);
    let st = null;
    if (info) {
      const gender = { 0: "♂", 1: "♀", 2: "genderless" }[g3.genderOf(E.mon.pid, info.gender)] || "?";
      const lvl = level.get();
      st = g3.calcStats(info.base, ivv, evv, lvl, +nature.value);
      txt += `\nGender ${gender} · Level ${lvl} · Growth ${info.growth < 6 ? g3.GROWTH_NAMES[info.growth] : "?"}`;
    }
    preview.textContent = txt;
    // stats table (display order HP/Atk/Def/SpA/SpD/Spe)
    const rows = ["Base", "IV", "EV", "Stat"].map((lab, r) => h("tr", {}, h("td", { text: lab }),
      DISP.map(i => h("td", { text: r === 0 ? (info ? info.base[i] : "-") : r === 1 ? ivv[i] : r === 2 ? evv[i] : (st ? st[i] : "-") }))));
    statsTbl.textContent = "";
    statsTbl.append(h("table", { class: "stats" }, h("tr", {}, h("th"), DISP.map(i => h("th", { text: g3.STAT_NAMES[i] }))), rows));
    const tt = Math.floor(ivv.reduce((a, v, i) => a + ((v & 1) << i), 0) * 15 / 63);
    const pw = Math.floor(ivv.reduce((a, v, i) => a + (((v >> 1) & 1) << i), 0) * 40 / 63) + 30;
    hpLbl.textContent = `IV total ${ivv.reduce((a, b) => a + b, 0)}   ·   Base total ${info ? info.base.reduce((a, b) => a + b, 0) : "-"}   ·   Hidden Power: ${HP_TYPES[tt]} ${pw}`;
  }
  function writeInto(m) {
    m.species = E.species; m.held_item = E.item; m.nickname = nick.value;
    m.exp = exp.get();
    E.moves.forEach((v, i) => m.set_move(i, v));
    if (m.is_party) m.level = level.get();
    const info = sInfo(m.species);
    m.ivs = ivs.map(e => e.get()); m.evs = evs.map(e => e.get());
    m.happiness = happy.get();
    if (m.HAS_BALL) m.ball = ball.get();
    const slot = parseInt(ability.value, 10);
    m.set_identity(+nature.value, isNaN(slot) ? m.ability_slot : slot, shiny.checked, info ? info.gender : null);
    if (m.is_party && recalc.checked && info) m.recalc_stats(info.base);
    return m;
  }
  E.writeInto = writeInto; E.level = () => level.get(); E.speciesId = () => E.species;

  // load values
  E.sync = true;
  infoLine.textContent = mon.valid ? "" : "⚠ Checksum of this Pokémon is invalid (bad egg / other format)";
  exp.set(mon.exp);
  level.set(mon.is_party && mon.level ? mon.level : g3.levelFromExp(growth(mon.species), mon.exp));
  E.sync = false;
  ivs.forEach((e, i) => e.set(mon.ivs[i])); evs.forEach((e, i) => e.set(mon.evs[i]));
  nature.value = String(mon.nature); shiny.checked = mon.is_shiny; happy.set(mon.happiness);
  ball.disabled = !mon.HAS_BALL; ball.set(mon.HAS_BALL ? mon.ball : 0);
  recalc.disabled = !mon.is_party;
  fillAbilities(mon.species, mon.ability_slot);
  pidLbl.textContent = `PID ${mon.pid.toString(16).toUpperCase().padStart(8, "0")}   ·   OT ${mon.ot_name || "-"}   ·   TID ${mon.otid & 0xFFFF} / SID ${mon.otid >>> 16}`;
  let pps; try { pps = mon.pp; } catch (e) { pps = [0, 0, 0, 0]; }
  ppLbl.textContent = "PP: " + pps.map((v, i) => (mon.moves[i] ? v : 0)).join(" / ") + (mon.is_party ? "" : "  (PC records keep no current PP)");
  updatePreview(); refreshSprite();

  const row = (lab, el) => h("div", { class: "row" }, h("label", { text: lab }), h("div", { class: "grow" }, el));
  const statGrid = arr => h("div", { class: "grid6" }, DISP.map(i => h("div", { class: "cell" }, h("label", { text: g3.STAT_NAMES[i] }), arr[i])));
  const body = [
    h("div", { class: "card" }, h("h2", { text: whereLabel(where) }),
      h("div", { class: "row" }, sprite, h("div", { class: "grow" }, infoLine, pidLbl)),
      row("Species", speciesBtn), row("Nickname", nick), row("Held item", itemBtn),
      row("Level", level), row("Exp", exp), row("Nature", nature), row("Ability", ability),
      h("label", { class: "chk" }, shiny, "Shiny"), row("Happiness", happy), row("Ball", ball),
      h("div", { class: "hint", text: "Level and Exp are linked via the species' growth rate (from the ROM). Gen 3 stores only the Exp of PC Pokémon; their level is derived from it. Ball id applies to Unbound / expansion saves." })),
    h("div", { class: "card" }, h("h2", { text: "Moves" }), moveBtns.map((b, i) => row("Move " + (i + 1), b)), ppLbl),
    h("div", { class: "card" }, h("h2", { text: "IVs (0-31)" }), statGrid(ivs),
      h("div", { class: "row", style: "margin-top:10px" }, h("button", { class: "grow", text: "Random IVs", onclick: () => { ivs.forEach(e => e.set(Math.floor(Math.random() * 32))); updatePreview(); } }),
        h("button", { class: "grow", text: "Max IVs", onclick: () => { ivs.forEach(e => e.set(31)); updatePreview(); } }))),
    h("div", { class: "card" }, h("h2", { text: "EVs (0-255)" }), statGrid(evs),
      h("div", { class: "row", style: "margin-top:10px" }, h("button", { class: "grow", text: "Random EVs", onclick: () => {
        let left = 510; const order = [0, 1, 2, 3, 4, 5].sort(() => Math.random() - 0.5), vals = [0, 0, 0, 0, 0, 0];
        for (const i of order) { vals[i] = Math.floor(Math.random() * (Math.min(255, left) + 1)); left -= vals[i]; }
        evs.forEach((e, i) => e.set(vals[i])); updatePreview(); } }),
        h("button", { class: "grow", text: "Clear EVs", onclick: () => { evs.forEach(e => e.set(0)); updatePreview(); } }))),
    h("div", { class: "card" }, h("h2", { text: "Calculated stats" }), statsTbl, hpLbl, preview,
      h("label", { class: "chk" }, recalc, "Recalculate party stats on Apply (needs ROM base stats)")),
    h("div", { class: "card" }, h("h2", { text: "Slot actions" }),
      h("button", { class: "big", text: "Move / swap to another slot…", onclick: async () => {
        const dst = await chooseSlot("Move to…");
        if (!dst) return;
        try { if (moveSlot(E.where, dst)) { toast("Pokémon moved (not yet exported)."); closeOverlay(el); if (afterClose) afterClose(); renderAll(); } }
        catch (e) { toast(e.message); }
      } }),
      h("button", { class: "big", text: "Copy to another slot…", onclick: async () => {
        const dst = await chooseSlot("Copy to…");
        if (!dst) return;
        try {
          const w = storeEditor(E, dst); toast(`Copied to ${whereLabel(w)} (not yet exported).`); renderAll();
        } catch (e) { toast(e.message); }
      } }),
      h("button", { class: "big danger", text: "Delete this Pokémon", onclick: async () => {
        if (!(await confirmBox("Delete this Pokémon from the save?", "Delete", true))) return;
        deleteMon(E.where); closeOverlay(el); toast("Pokémon deleted (not yet exported)."); renderAll();
      } })),
  ];
  const apply = () => {
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    try {
      const m = writeInto(E.mon);
      const [kind, a, b] = E.where;
      if (kind === "party") S.save.set_party_member(a, m); else S.save.set_box_pokemon(a, b, m);
    } catch (e) { alertBox(e.message); return; }
    markDirty(); closeOverlay(el); toast("Pokémon applied (not yet exported)."); renderAll();
  };
  const el = overlay("Edit Pokémon", body, [h("button", { text: "Cancel", onclick: () => closeOverlay(el) }), h("button", { class: "primary", text: "Apply to save", onclick: apply })]);
  return el;
}
/** copy the editor's Pokémon into another slot (port of store_editor): existing mon in that slot is overwritten, otherwise created */
function storeEditor(E, where) {
  let [kind, a, b] = where;
  if (kind === "party") { a = Math.min(a, S.save.party().length); where = ["party", a, 0]; }
  const cur = monAt(where);
  let m;
  if (cur && sameWhere(E.where, where)) m = E.mon; else m = g3.makeNewMon(S.save, S.rom, E.speciesId() || 1, E.level());
  E.writeInto(m);
  if (kind === "party") { if (a < S.save.party().length) S.save.set_party_member(a, m); else S.save.add_party_member(m); }
  else S.save.set_box_pokemon(a, b, m);
  markDirty();
  return where;
}

// ------------------------------------------------------------------ slot UI (party list, box grid/list)
function slotLabel(m) { return speciesName(m.species) + (m.valid ? "" : " ⚠"); }
function monSub(m) {
  const lv = lvOf(m);
  return `${lv ? "Lv " + lv + " · " : ""}${g3.NATURES[m.nature]}${m.is_shiny ? " ★" : ""}${m.nickname && m.nickname.toUpperCase() !== speciesName(m.species).toUpperCase() ? " · “" + m.nickname + "”" : ""}`;
}
function slotCard(label, m, onTap, extra) {
  const url = m ? spriteURL(m.species, m.is_shiny) : null;
  return h("button", { class: "slot" + (m ? "" : " empty"), onclick: onTap },
    url ? h("img", { class: "spr", src: url }) : null,
    h("div", { class: "t" }, h("b", { text: m ? `${slotLabel(m)} (${m.species})` : "(empty)" }), h("small", { text: label + (m ? " · " + monSub(m) : "") })),
    h("span", { class: "chev", style: "color:var(--sub)", text: "›" }), extra);
}
function gridCell(m, onTap, sel) {
  const url = m ? spriteURL(m.species, m.is_shiny) : null;
  return h("button", { class: "gc" + (m ? "" : " empty") + (sel ? " sel" : ""), onclick: onTap },
    m ? (url ? h("img", { src: url }) : h("span", { text: speciesName(m.species).slice(0, 9) })) : null,
    m && url ? null : (m && lvOf(m) ? h("span", { style: "color:var(--sub)", text: "Lv" + lvOf(m) }) : null));
}
function boxNav(box, onChange) {
  const n = S.save.BOXES;
  const sel = h("select", { onchange: () => onChange(+sel.value) }, Array.from({ length: n }, (_, i) => h("option", { value: i, text: "Box " + (i + 1) })));
  sel.value = String(box);
  return h("div", { class: "boxnav" }, h("button", { text: "‹", onclick: () => onChange((box + n - 1) % n) }), sel, h("button", { text: "›", onclick: () => onChange((box + 1) % n) }));
}
function openSlot(where) {
  const m = monAt(where);
  if (m) { openEditor(m, where); return; }
  const el = overlay(whereLabel(where) + " - empty", [
    h("div", { class: "card" }, h("p", { text: "This slot is empty. Create a level 5 placeholder Pokémon (trainer as OT, random PID/IVs, Tackle), then set species, level, moves etc. in the editor." }),
      h("button", { class: "big primary", text: "Create new Pokémon here", onclick: () => {
        try { createMon(where); } catch (e) { toast(e.message); return; }
        closeOverlay(el); renderAll();
        const w = where[0] === "party" ? ["party", Math.min(where[1], S.save.party().length - 1), 0] : where;
        const mm = monAt(w); if (mm) openEditor(mm, w);
        setStatus("New Pokémon created (not yet exported). Choose species, level, moves etc. and press “Apply to save”.");
      } }))]);
}
/** pick a destination slot (party or any box slot) */
function chooseSlot(title) {
  return new Promise(res => {
    let box = S.box, el;
    const body = h("div");
    const done = v => { closeOverlay(el); res(v); };
    function render() {
      body.textContent = "";
      const party = S.save.party();
      body.append(h("div", { class: "card" }, h("h2", { text: "Party" }),
        Array.from({ length: Math.min(6, party.length + 1) }, (_, i) => slotCard(`Party ${i + 1}`, party[i] || null, () => done(["party", i, 0])))));
      const boxes = S.save.box_pokemon();
      body.append(h("div", { class: "card" }, h("h2", { text: "Boxes" }), boxNav(box, b => { box = b; render(); }),
        h("div", { class: "boxgrid" }, Array.from({ length: 30 }, (_, i) => gridCell(boxes.get(box * 30 + i) || null, () => done(["box", box, i]))))));
    }
    el = overlay(title, body, null, h("button", { text: "Cancel", onclick: () => done(null) }));
    render();
  });
}

// ------------------------------------------------------------------ tabs
function needSave(node) { node.append(h("div", { class: "card" }, h("p", { text: "Open a ROM (for names) and a save file first - see the File tab." }), h("button", { class: "big primary", text: "Go to File", onclick: () => setTab("file") }))); }
function renderPokemon(m) {
  if (!S.save) return needSave(m);
  const party = S.save.party(), boxes = S.save.box_pokemon();
  m.append(h("div", { class: "card" }, h("h2", { text: "Party" }),
    Array.from({ length: Math.min(6, party.length + 1) }, (_, i) => slotCard(`Party ${i + 1}`, party[i] || null, () => openSlot(["party", i, 0])))));
  const seg = h("div", { class: "seg" }, ["grid", "list"].map(v => h("button", { class: S.boxView === v ? "on" : "", text: v === "grid" ? "Grid" : "List", onclick: () => { S.boxView = v; renderAll(); } })));
  const card = h("div", { class: "card" }, h("h2", { text: "PC boxes" }), boxNav(S.box, b => { S.box = b; renderAll(); }), seg);
  if (S.boxView === "grid") card.append(h("div", { class: "boxgrid" }, Array.from({ length: 30 }, (_, i) => gridCell(boxes.get(S.box * 30 + i) || null, () => openSlot(["box", S.box, i])))));
  else for (let i = 0; i < 30; i++) card.append(slotCard(`Box ${S.box + 1} / ${i + 1}`, boxes.get(S.box * 30 + i) || null, () => openSlot(["box", S.box, i])));
  m.append(card);
  m.append(h("div", { class: "hint", text: "Tap a slot to edit it. Empty slots can be filled with “Create new Pokémon here”. Inside the editor you can move, swap, copy or delete." }));
}

// bag
const pocketKeys = () => S.save ? S.save.POCKETS.slice() : [];
const pocketLabel = k => (S.save && S.save.POCKET_LABELS && S.save.POCKET_LABELS[k]) || POCKET_LABELS[k] || k;
function allowedItems(pocket) {
  if (S.save && S.save.item_filter) {
    const f = S.save.item_filter(pocket);
    if (f) { const out = []; for (let i = 0; i < itemCount(); i++) if (f(i)) out.push(i); return out; }
  }
  if (S.rom) { const ids = S.rom.itemsForPocket(pocket); if (ids && ids.length) return ids; }
  return null;
}
function loadBagDraft() { S.bagDraft = S.save.bag(S.pocket).map(x => x.slice()); S.bagDirty = false; }
async function switchPocket(k) {
  if (S.bagDirty && !(await confirmBox("Discard the unapplied changes in this pocket?", "Discard", true))) return;
  S.pocket = k; loadBagDraft(); renderAll();
}
function renderBag(m) {
  if (!S.save) return needSave(m);
  const keys = pocketKeys();
  if (!S.pocket || !keys.includes(S.pocket)) { S.pocket = keys[0]; loadBagDraft(); }
  if (!S.bagDraft) loadBagDraft();
  const pocket = S.pocket, cap = S.save.pocket_capacity(pocket), allowed = allowedItems(pocket), allowedSet = allowed ? new Set(allowed) : null;
  m.append(h("div", { class: "chips" }, keys.map(k => h("button", { class: k === pocket ? "on" : "", text: pocketLabel(k), onclick: () => switchPocket(k) }))));
  const n = S.bagDraft.length;
  m.append(h("div", { class: "baghead" }, h("span", { text: `${n} / ${cap} slots` + (n > cap ? "   ⚠ more rows than slots - extra rows will not be saved" : "") })));
  const qmax = S.save.pocket_qty_max(pocket);
  S.bagDraft.forEach((row, idx) => {
    const notIn = allowedSet && row[0] && !allowedSet.has(row[0]);
    const btn = pickerButton(() => `${pad4(row[0])}  ${itemName(row[0])}${notIn ? "  (not in this pocket)" : ""}`, async () => {
      const v = await pickName({ title: pocketLabel(pocket), count: itemCount(), ids: allowed, nameFn: itemName, current: row[0] });
      if (v !== null) { row[0] = v; S.bagDirty = true; renderAll(); }
    }, notIn);
    const q = numField(0, Math.max(qmax, row[1]), row[1]);
    q.addEventListener("change", () => { row[1] = q.get(); S.bagDirty = true; });
    m.append(h("div", { class: "bagrow" }, btn, q, h("button", { class: "danger", text: "✕", onclick: () => { S.bagDraft.splice(idx, 1); S.bagDirty = true; renderAll(); } })));
  });
  m.append(h("div", { class: "row" },
    h("button", { class: "grow", text: "+ Add row", onclick: () => { S.bagDraft.push([1, 1]); S.bagDirty = true; renderAll(); setTimeout(() => $("#main").scrollTo(0, 1e6), 50); } }),
    h("button", { class: "grow primary", text: "Apply pocket", onclick: applyBag })));
  m.append(h("div", { class: "hint", text: "Max quantity per stack: " + qmax + " (larger existing values are kept). The item list only offers items that belong into this pocket; use “Use ID” in the search to type any id." }));
}
function applyBag() {
  if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
  const pocket = S.pocket, cap = S.save.pocket_capacity(pocket), allowed = allowedItems(pocket), aset = allowed ? new Set(allowed) : null;
  const already = new Set(S.save.bag(pocket).map(x => x[0]));
  const items = []; let skipped = 0;
  for (const [iid, qty] of S.bagDraft) {
    if (!iid) continue;
    if (aset && !aset.has(iid) && !already.has(iid)) { skipped++; continue; }
    items.push([iid, qty]);
  }
  S.save.set_bag(pocket, items.slice(0, cap));
  S.bagDraft = S.save.bag(pocket).map(x => x.slice()); S.bagDirty = false;
  markDirty(); renderAll();
  toast("Pocket applied (not yet exported)." + (items.length > cap ? `  ${items.length - cap} row(s) dropped (pocket full).` : "") + (skipped ? `  ${skipped} item(s) skipped: they do not belong into this pocket.` : ""));
}

function renderTrainer(m) {
  if (!S.save) return needSave(m);
  const s = S.save, [tid, sid] = s.trainer_id, [ph, pm, ps] = s.play_time;
  const name = h("input", { type: "text", maxlength: "7", value: s.trainer_name, autocorrect: "off" });
  const money = numField(0, s.money_max, s.money);
  m.append(h("div", { class: "card" }, h("h2", { text: "Trainer" }),
    h("div", { class: "row" }, h("label", { text: "Name" }), h("div", { class: "grow" }, name)),
    h("div", { class: "row" }, h("label", { text: "Money" }), h("div", { class: "grow" }, money)),
    h("div", { class: "hint", text: `TID ${String(tid).padStart(5, "0")} / SID ${String(sid).padStart(5, "0")}    Playtime ${ph}:${String(pm).padStart(2, "0")}:${String(ps).padStart(2, "0")}` }),
    h("button", { class: "big primary", text: "Apply trainer", onclick: () => {
      s.trainer_name = name.value; s.money = money.get(); markDirty(); toast("Trainer applied (not yet exported).");
    } })));
}
function renderInfo(m) {
  const lines = [];
  if (S.rom) lines.push(`ROM: ${S.rom.game_title} (${S.rom.game_code})` + (S.rom.hack ? `   recognised as: ${S.rom.hack}` : ""), ...S.rom.notes, "");
  if (S.save) {
    const s = S.save;
    const ns = {}; for (const k of Object.keys(s.sect_size)) if (+k < 14 && s.sect_size[k] !== g3.SECTION_DATA_SIZE[+k]) ns[k] = s.sect_size[k];
    lines.push(`Save: ${s.game} layout   active slot @0x${s.slot_offset.toString(16).toUpperCase()}   counter ${s.counter}` + (s.hack ? `   recognised as: ${s.hack}` : ""),
      `Section signature: 0x${s.signature.toString(16).toUpperCase().padStart(8, "0")}`, `Layout scores: ${JSON.stringify(s.detect_scores)}`,
      `Non-standard sections (checksum size): ${JSON.stringify(ns)}`);
  }
  m.append(h("div", { class: "card" }, h("h2", { text: "ROM / Save info" }), h("pre", { text: lines.join("\n") || "Nothing loaded yet." })));
  m.append(h("div", { class: "card" }, h("h2", { text: "About" }),
    h("div", { class: "hint", text: "Gen 3 Romhack Save Editor for iPhone - a port of the desktop editor. Names are read from the ROM you open, so custom Pokémon / items / moves show their real names. Layouts for Imperium / Heart & Soul / Legacy / Radical Red come from the open-source PKHeX.Everywhere project (GPL-3.0-or-later); this app is distributed under the same license. Always keep a backup of your save." })));
}
function renderFile(m) {
  const romCard = h("div", { class: "card" }, h("h2", { text: "1 · ROM (for names)" }),
    h("div", { class: "hint", text: S.rom ? `Loaded: ${S.romName} - ${S.rom.species_names.length} species, ${S.rom.item_names.length} items, ${S.rom.move_names.length} moves` : "No ROM loaded - Pokémon, items and moves show as numbers." }),
    h("button", { class: "big primary", text: "Open ROM (.gba)…", onclick: async () => { const f = await pickFile(); if (f) openRom(f); } }),
    S.resume.rom && !S.rom ? h("button", { class: "big", text: "Reload last ROM: " + S.resume.rom, onclick: async () => {
      const r = await kv.get("last:rom"); if (r) openRom(new File([r.data], r.name)); } }) : null);
  const saveCard = h("div", { class: "card" }, h("h2", { text: "2 · Save file" }),
    h("div", { class: "hint", text: S.save ? `Loaded: ${S.saveName} (${S.save.game} layout${S.save.hack ? ", " + S.save.hack : ""})` : "No save loaded." }),
    h("button", { class: "big primary", text: "Open save (.sav / .srm)…", onclick: async () => { const f = await pickFile(); if (f) openSave(f); } }),
    S.resume.save && !S.save ? h("button", { class: "big", text: "Reload last save: " + S.resume.save, onclick: async () => {
      const r = await kv.get("last:save"); if (r) openSaveBytes(r.data, r.name); } }) : null,
    h("div", { class: "row" }, h("label", { text: "Save layout" }), h("div", { class: "grow" },
      h("select", { onchange: e => { S.gameIdx = +e.target.value; reloadLayout(); } }, GAME_CHOICES.map(([l], i) => h("option", { value: i, text: l, selected: i === S.gameIdx }))))),
    h("div", { class: "hint", text: "Auto-detect tries all layouts and keeps the one that makes sense. Override it if a hack is detected wrongly (unsaved edits are discarded)." }));
  const exp = h("div", { class: "card" }, h("h2", { text: "3 · Write back" }),
    h("button", { class: "big primary", text: "Export / save edited file…", disabled: !S.save, onclick: writeSave }),
    h("button", { class: "big", text: "Export original (backup copy)…", disabled: !S.saveRaw, onclick: () => exportFile((S.saveName || "save.sav").replace(/(\.[^.]*)?$/, ".bak"), S.saveRaw) }),
    h("div", { class: "hint", text: "The share sheet opens: choose “Save to Files” and replace your save (or AirDrop it to the device that runs your emulator). Export the backup copy first if you want to keep the original." }));
  const setting = (label, key, note, after) => h("div", {}, h("label", { class: "chk" }, h("input", { type: "checkbox", checked: S.settings[key] ? true : null, onchange: async e => {
    S.settings[key] = e.target.checked; kv.set("settings", S.settings); if (after) await after(); renderAll(); } }), label), h("div", { class: "hint", text: note }));
  const sett = h("div", { class: "card" }, h("h2", { text: "Settings" }),
    setting("Sprite preview", "sprites", "Shows sprites read from the ROM in lists and the editor (the ROM is scanned for sprite tables the first time, a few seconds, then cached).", async () => {
      spriteCache.clear();
      if (S.settings.sprites && S.rom) { busy("Scanning the ROM for sprite tables…"); await tick(); try { S.rom.ensureGfx(); } finally { busy(""); } }
    }),
    setting("Larger sprite in the editor", "large", "Needs the sprite preview."),
    setting("Remember last ROM and save", "remember", "Keeps a copy inside the app so you can reload them with one tap. Turn off to avoid storing the ROM.", async () => {
      if (!S.settings.remember) { await kv.del("last:rom"); await kv.del("last:save"); S.resume = {}; } }));
  m.append(romCard, saveCard, exp, sett);
}

// ------------------------------------------------------------------ shell
function setTab(t) { S.tab = t; renderAll(); }
function renderAll() {
  renderHeader();
  document.querySelectorAll("#tabs button").forEach(b => b.classList.toggle("on", b.dataset.tab === S.tab));
  const main = $("#main"), top = main.scrollTop;
  const oldChips = main.querySelector(".chips"), chipLeft = oldChips ? oldChips.scrollLeft : 0;
  main.textContent = "";
  ({ file: renderFile, pokemon: renderPokemon, bag: renderBag, trainer: renderTrainer, info: renderInfo })[S.tab](main);
  main.scrollTop = top;
  const chips = main.querySelector(".chips");      // keep the pocket bar where it was (no jump back to the start)
  if (chips) {
    chips.scrollLeft = chipLeft;
    if (S.tab === "bag") {                          // only scroll if the selected pocket is out of view
      const on = chips.querySelector(".on");
      if (on && (on.offsetLeft < chips.scrollLeft || on.offsetLeft + on.offsetWidth > chips.scrollLeft + chips.clientWidth))
        chips.scrollLeft = on.offsetLeft - (chips.clientWidth - on.offsetWidth) / 2;
    }
  }
}
document.querySelectorAll("#tabs button").forEach(b => b.addEventListener("click", () => setTab(b.dataset.tab)));
$("#btnSave").addEventListener("click", writeSave);
window.addEventListener("error", e => { try { toast("Error: " + e.message); } catch (_) { /* ignore */ } });
window.addEventListener("unhandledrejection", e => { try { toast("Error: " + (e.reason && e.reason.message || e.reason)); } catch (_) { /* ignore */ } });

(async function init() {
  setStatus("Open a ROM (for names) and a save file.");
  const st = await kv.get("settings"); if (st) Object.assign(S.settings, st);
  const r = await kv.get("last:rom"), v = await kv.get("last:save");
  if (r) S.resume.rom = r.name; if (v) S.resume.save = v.name;
  renderAll();
})();
