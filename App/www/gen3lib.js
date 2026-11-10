/* gen3lib.js - JavaScript port of gen3lib.py (core library of the Gen 3 romhack save editor).
 * Same behaviour as the Python original: Gen 3 text, ROM scanner, save layouts (vanilla,
 * Unbound, Radical Red, Emerald Legacy, Imperium, Heart & Soul), Pokemon records, bag, PC.
 * License: GPL-3.0-or-later (derived from the original project). */
(function (root) {
"use strict";

// ---------------------------------------------------------------- byte helpers
const u16 = (b, o) => b[o] | (b[o + 1] << 8);
const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const p16 = (b, o, v) => { b[o] = v & 255; b[o + 1] = (v >>> 8) & 255; };
const p32 = (b, o, v) => { b[o] = v & 255; b[o + 1] = (v >>> 8) & 255; b[o + 2] = (v >>> 16) & 255; b[o + 3] = (v >>> 24) & 255; };
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const fdiv = (a, b) => Math.floor(a / b);
const mod = (a, n) => ((a % n) + n) % n;
function eqRange(a, b, off, len) {
  for (let i = off; i < off + len; i++) if (a[i] !== b[i]) return false;
  return true;
}
function indexOfSeq(d, pat, from, to) {
  from = from || 0; to = to === undefined ? d.length : to;
  const n = pat.length, first = pat[0], last = to - n;
  let i = from;
  for (;;) {
    i = d.indexOf(first, i);
    if (i < 0 || i > last) return -1;
    let k = 1;
    while (k < n && d[i + k] === pat[k]) k++;
    if (k === n) return i;
    i++;
  }
}
function findAllSeq(d, pat) {          // like re.finditer(non-overlapping)
  const out = []; let i = 0;
  for (;;) {
    i = indexOfSeq(d, pat, i);
    if (i < 0) return out;
    out.push(i); i += pat.length;
  }
}
function concatBytes(a, b) { const o = new Uint8Array(a.length + b.length); o.set(a, 0); o.set(b, a.length); return o; }

// SHA-1 (hex) of a Uint8Array - used as ROM cache key and to recognise known ROMs
function sha1hex(data) {
  let h0 = 0x67452301, h1 = 0xEFCDAB89 | 0, h2 = 0x98BADCFE | 0, h3 = 0x10325476, h4 = 0xC3D2E1F0 | 0;
  const w = new Int32Array(80);
  function block(a, o) {
    for (let i = 0; i < 16; i++, o += 4) w[i] = (a[o] << 24) | (a[o + 1] << 16) | (a[o + 2] << 8) | a[o + 3];
    for (let i = 16; i < 80; i++) { const x = w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16]; w[i] = (x << 1) | (x >>> 31); }
    let a_ = h0, b_ = h1, c_ = h2, d_ = h3, e_ = h4;
    for (let i = 0; i < 80; i++) {
      let f, k;
      if (i < 20) { f = (b_ & c_) | (~b_ & d_); k = 0x5A827999; }
      else if (i < 40) { f = b_ ^ c_ ^ d_; k = 0x6ED9EBA1; }
      else if (i < 60) { f = (b_ & c_) | (b_ & d_) | (c_ & d_); k = 0x8F1BBCDC | 0; }
      else { f = b_ ^ c_ ^ d_; k = 0xCA62C1D6 | 0; }
      const t = (((a_ << 5) | (a_ >>> 27)) + f + e_ + k + w[i]) | 0;
      e_ = d_; d_ = c_; c_ = (b_ << 30) | (b_ >>> 2); b_ = a_; a_ = t;
    }
    h0 = (h0 + a_) | 0; h1 = (h1 + b_) | 0; h2 = (h2 + c_) | 0; h3 = (h3 + d_) | 0; h4 = (h4 + e_) | 0;
  }
  const len = data.length, full = len - (len % 64);
  for (let o = 0; o < full; o += 64) block(data, o);
  const rem = len % 64;
  const tail = new Uint8Array(rem < 56 ? 64 : 128);
  tail.set(data.subarray(full)); tail[rem] = 0x80;
  const bits = len * 8, hi = Math.floor(bits / 4294967296), lo = bits >>> 0, e = tail.length;
  tail[e - 8] = hi >>> 24; tail[e - 7] = hi >>> 16; tail[e - 6] = hi >>> 8; tail[e - 5] = hi;
  tail[e - 4] = lo >>> 24; tail[e - 3] = lo >>> 16; tail[e - 2] = lo >>> 8; tail[e - 1] = lo;
  for (let o = 0; o < tail.length; o += 64) block(tail, o);
  return [h0, h1, h2, h3, h4].map(x => (x >>> 0).toString(16).padStart(8, "0")).join("");
}

// ---------------------------------------------------------------- charset
const CHARS = new Array(256).fill(undefined);
CHARS[0x00] = " ";
"0123456789".split("").forEach((c, i) => { CHARS[0xA1 + i] = c; });
"ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("").forEach((c, i) => { CHARS[0xBB + i] = c; });
"abcdefghijklmnopqrstuvwxyz".split("").forEach((c, i) => { CHARS[0xD5 + i] = c; });
const MISC = { 0xAB: "!", 0xAC: "?", 0xAD: ".", 0xAE: "-", 0xB0: "…", 0xB1: "“", 0xB2: "”",
  0xB3: "‘", 0xB4: "'", 0xB5: "♂", 0xB6: "♀", 0xB8: ",", 0xB9: "×", 0xBA: "/",
  0xF0: ":", 0x1B: "é", 0x5A: "Í", 0x79: "↑", 0x7A: "↓", 0x7B: "←", 0x7C: "→", 0xA0: "…", 0xFE: "\n" };
for (const k in MISC) CHARS[+k] = MISC[k];
const ACCENTS = { 0x01: "À", 0x02: "Á", 0x03: "Â", 0x04: "Ç", 0x05: "È", 0x06: "É", 0x07: "Ê", 0x08: "Ë",
  0x09: "Ì", 0x0B: "Î", 0x0C: "Ï", 0x0D: "Ò", 0x0E: "Ó", 0x0F: "Ô", 0x10: "Œ", 0x11: "Ù",
  0x12: "Ú", 0x13: "Û", 0x14: "Ñ", 0x15: "ß", 0x16: "à", 0x17: "á", 0x19: "ç", 0x1A: "è",
  0x1C: "ê", 0x1D: "ë", 0x1E: "ì", 0x20: "î", 0x21: "ï", 0x22: "ò", 0x23: "ó", 0x24: "ô",
  0x25: "œ", 0x26: "ù", 0x27: "ú", 0x28: "û", 0x29: "ñ", 0x2A: "º", 0x2B: "ª" };
for (const k in ACCENTS) if (CHARS[+k] === undefined) CHARS[+k] = ACCENTS[k];
const REV = new Map();
for (let k = 0; k < 256; k++) if (CHARS[k] !== undefined && k !== 0xA0 && k !== 0xFE) REV.set(CHARS[k], k);
REV.set("\n", 0xFE);
const TERM = 0xFF;
const IS_CHAR = new Uint8Array(256);
for (let k = 0; k < 256; k++) if (CHARS[k] !== undefined) IS_CHAR[k] = 1;

function decodeText(raw, off, len) {
  off = off || 0;
  const end = len === undefined ? raw.length : Math.min(raw.length, off + len);
  let out = "";
  for (let i = off; i < end; i++) {
    const b = raw[i];
    if (b === TERM) break;
    const c = CHARS[b];
    out += c === undefined ? "?" : c;
  }
  return out;
}
function encodeText(s, length, pad) {
  if (pad === undefined) pad = true;
  const data = [];
  for (const ch of Array.from(s).slice(0, length)) {
    const c = REV.get(ch);
    data.push(c === undefined ? REV.get("?") : c);
  }
  if (data.length < length) data.push(TERM);
  if (pad) while (data.length < length) data.push(TERM);
  return Uint8Array.from(data.slice(0, length));
}
function lz77Decompress(d, o) {
  if (o < 0 || o + 4 > d.length || d[o] !== 0x10) return null;
  const n = d[o + 1] | (d[o + 2] << 8) | (d[o + 3] << 16);
  const out = new Uint8Array(n);
  let len = 0, p = o + 4;
  const size = d.length;
  while (len < n) {
    if (p >= size) return null;
    const flags = d[p++];
    for (let b = 0; b < 8; b++) {
      if (len >= n) break;
      if (flags & (0x80 >> b)) {
        if (p + 1 >= size) return null;
        const a = d[p], c = d[p + 1]; p += 2;
        const disp = (((a & 15) << 8) | c) + 1;
        if (disp > len) return null;
        for (let k = (a >> 4) + 3; k > 0; k--) { if (len < n) out[len] = out[len - disp]; len++; }
      } else {
        if (p >= size) return null;
        out[len++] = d[p++];
      }
    }
  }
  return out;
}
function isText(d, off, len) {
  const end = Math.min(off + len, d.length);
  let n = 0;
  for (let i = off; i < end; i++) {
    const b = d[i];
    if (b === TERM) return n > 0;
    if (!IS_CHAR[b]) return false;
    n++;
  }
  return false;
}
const fallbackSpecies = i => `Species #${i}`;
const fallbackItem = i => (i === 0 ? "(none)" : `Item #${i}`);
const fallbackMove = i => (i === 0 ? "(none)" : `Move #${i}`);

// ---------------------------------------------------------------- ROM scanner
const KNOWN_ROMS = {
  "0f54a37fdae801a186068bdc0bbad8b77ec0d306": "Pokémon Unbound 2.0.3.2",
  "b4776b82a4c7915d0fadeaa27e013523f99dfd94": "Pokémon Unbound 2.1.1.1",
};
const allQ = s => s.length > 0 && Array.from(s).every(c => c === "?");
const titleCase = s => s.replace(/[A-Za-z]+/g, w => w[0].toUpperCase() + w.slice(1).toLowerCase());

class RomInfo {
  /** data: Uint8Array of the ROM. opts.cached: object from cacheObject() of an earlier scan. */
  constructor(data, opts) {
    opts = opts || {};
    this.data = data;
    this.game_title = decodeAscii(data, 0xA0, 12);
    this.game_code = decodeAscii(data, 0xAC, 4, false);
    this.species_names = []; this.item_names = []; this.move_names = [];
    this.item_table_offset = null; this.species_table_offset = null; this.move_table_offset = null;
    this.move_pps = []; this.move_pp_offset = null; this.base_stats_offset = null;
    this.species_stats = []; this.ability_names = []; this.ability_table_offset = null;
    this.item_pockets = {}; this.item_table_count = 0; this.notes = [];
    this.gfx = null; this._item_count = undefined; this.fromCache = false;
    this.hash = opts.hash || sha1hex(data);
    this.hack = this._detectHack();
    if (opts.cached && this._loadCache(opts.cached)) { this.fromCache = true; return; }
    this._scan();
  }
  _detectHack() {
    if (KNOWN_ROMS[this.hash]) return KNOWN_ROMS[this.hash];
    const d = this.data;
    if (indexOfSeq(d, encodeText("to Pokémon Unbound!", 19, false)) >= 0 ||
        indexOfSeq(d, encodeText("Pokémon Unbound", 15, false)) >= 0) return "Pokémon Unbound (unknown version)";
    return "";
  }
  static get CACHE_VERSION() { return 7; }
  _loadCache(c) {
    try {
      if (c.version !== RomInfo.CACHE_VERSION) return false;
      for (const k of ["species_names", "item_names", "move_names", "item_table_offset", "species_table_offset",
        "move_table_offset", "notes", "move_pps", "move_pp_offset", "base_stats_offset", "species_stats",
        "ability_names", "ability_table_offset", "item_pockets", "item_table_count"]) {
        if (!(k in c)) return false;
      }
      for (const k of ["species_names", "item_names", "move_names", "item_table_offset", "species_table_offset",
        "move_table_offset", "notes", "move_pps", "move_pp_offset", "base_stats_offset", "species_stats",
        "ability_names", "ability_table_offset", "item_pockets", "item_table_count"]) this[k] = c[k];
      this.gfx = c.gfx || null;
      this.notes = this.notes.concat(["(loaded from cache)"]);
      return true;
    } catch (e) { return false; }
  }
  cacheObject() {
    return { version: RomInfo.CACHE_VERSION, species_names: this.species_names, item_names: this.item_names,
      move_names: this.move_names, item_table_offset: this.item_table_offset,
      species_table_offset: this.species_table_offset, move_table_offset: this.move_table_offset,
      notes: this.notes.filter(n => n !== "(loaded from cache)"), move_pps: this.move_pps,
      move_pp_offset: this.move_pp_offset, base_stats_offset: this.base_stats_offset,
      species_stats: this.species_stats, ability_names: this.ability_names,
      ability_table_offset: this.ability_table_offset, item_pockets: this.item_pockets,
      item_table_count: this.item_table_count, gfx: this.gfx };
  }
  _words() {
    if (!this._w32) {
      const d = this.data;
      if (d.byteOffset % 4 === 0) this._w32 = new Uint32Array(d.buffer, d.byteOffset, d.length >> 2);
      else { const c = d.slice(0, d.length - (d.length % 4)); this._w32 = new Uint32Array(c.buffer, 0, c.length >> 2); }
    }
    return this._w32;
  }
  _hasPointerTo(romOffset) {
    const needle = (0x08000000 + romOffset) >>> 0, w = this._words();
    for (let i = 0; i < w.length; i++) if (w[i] === needle) return true;
    return false;
  }
  _trimStart(start, count, stride, nameLen, anchor, window) {
    window = window || 6;
    const d = this.data, cands = [];
    for (let j = 0; j < Math.min(count, 400); j++)
      if (anchor(decodeText(d, start + j * stride, nameLen))) cands.push(j);
    for (const j of cands) if (this._hasPointerTo(start + j * stride)) return [start + j * stride, count - j];
    for (const j of cands) if (j < window) return [start + j * stride, count - j];
    return [start, count];
  }
  _findTable(stride, nameLen, minCount, firstBlank, validator, anchor) {
    const d = this.data, size = d.length;
    let best = null, off = 0;
    while (off < size - stride * minCount) {
      if (!isText(d, off, nameLen)) { off += 4; continue; }
      let count = 0, p = off;
      while (p + stride <= size && isText(d, p, nameLen)) { count++; p += stride; }
      if (count >= minCount) {
        let start = off;
        while (start - stride >= 0 && isText(d, start - stride, nameLen)) { start -= stride; count++; }
        if (anchor) [start, count] = this._trimStart(start, count, stride, nameLen, anchor);
        if (!validator || validator(start, count)) if (best === null || count > best[1]) best = [start, count];
        off = p - (p % 4) + 4;
      } else off += 4;
    }
    return best;
  }
  _findItems(stride, probe) {
    stride = stride || 44; probe = probe || 12;
    const d = this.data, size = d.length;
    let best = null, off = 0;
    const last = size - stride * (probe + 2);
    while (off < last) {
      if (d[off + 14] === 0 && d[off + 15] === 0 && d[off + stride + 14] === 1 && d[off + stride + 15] === 0) {
        let ok = true;
        for (let i = 2; i < probe; i++) {
          const p = off + i * stride;
          if (d[p + 14] !== (i & 0xFF) || d[p + 15] !== (i >> 8) || (d[p + 23] !== 0x08 && d[p + 23] !== 0x09)) { ok = false; break; }
        }
        if (ok) {
          let count = probe;
          while (off + (count + 1) * stride <= size) {
            const p = off + count * stride;
            if (!((d[p + 23] === 0x08 || d[p + 23] === 0x09) && d.subarray(p, p + 14).includes(TERM))) break;
            count++;
          }
          while (count > 1) {
            const p = off + (count - 1) * stride;
            if (Array.from(decodeText(d, p, 14)).every(c => c === "?")) count--; else break;
          }
          if (best === null || count > best[1]) best = [off, count];
          off += count * stride;
          continue;
        }
      }
      off += 4;
    }
    return best;
  }
  _scan() {
    const d = this.data;
    let sp = null;
    for (const stride of [11, 12, 13, 14, 16]) {
      const v = (off, count) => {
        let letters = 0;
        for (let i = 0; i < Math.min(count, 400); i++) {
          const s = decodeText(d, off + i * stride, stride);
          if (s && /\p{L}/u.test(s)) letters++;
        }
        return letters >= Math.min(count, 400) * 0.8;
      };
      const r = this._findTable(stride, stride, 250, false, v, allQ);
      if (r) { sp = [stride, r[0], r[1]]; break; }
    }
    if (sp) {
      const [stride, off, count] = sp;
      this.species_table_offset = off;
      this.species_names = [];
      for (let i = 0; i < count; i++) this.species_names.push(decodeText(d, off + i * stride, stride));
      this.notes.push(`Species table @0x${off.toString(16).toUpperCase()} (${count} entries, stride ${stride})`);
    } else this.notes.push("Species table not found");

    const mv = this._findTable(13, 13, 300, undefined, null, s => s === "-" || allQ(s));
    if (mv) {
      const [off, count] = mv;
      this.move_table_offset = off;
      this.move_names = [];
      for (let i = 0; i < count; i++) this.move_names.push(decodeText(d, off + i * 13, 13));
      this.notes.push(`Move table @0x${off.toString(16).toUpperCase()} (${count} entries)`);
    } else this.notes.push("Move table not found");

    const it = this._findItems();
    if (it) {
      const [off, count] = it;
      this.item_table_offset = off; this._item_count = count;
      const byId = new Map();
      for (let i = 0; i < count; i++) {
        const p = off + i * 44, iid = u16(d, p + 14), nm = decodeText(d, p, 14), key = iid ? iid : i;
        if (iid || !byId.has(key)) byId.set(key, nm);
      }
      let mx = 0; for (const k of byId.keys()) if (k > mx) mx = k;
      this.item_names = [];
      for (let k = 0; k <= mx; k++) this.item_names.push(byId.has(k) ? byId.get(k) : "");
      this.notes.push(`Item table @0x${off.toString(16).toUpperCase()} (${count} entries)`);
    } else this.notes.push("Item table not found");
    this._scanVariableStride();
    this._findItemPockets();
    this._findMovePP();
    this._findBaseStats();
    this._findAbilities();
  }
  _scanVariableStride() {
    const d = this.data;
    const find = (first, second, third, maxStride, minCount) => {
      maxStride = maxStride || 600;
      for (const casefn of [titleCase, s => s.toUpperCase()]) {
        const [a, b, c] = [first, second, third].map(x => encodeText(casefn(x), x.length, false));
        const aff = concatBytes(a, Uint8Array.of(0xFF)), bff = concatBytes(b, Uint8Array.of(0xFF)), cff = concatBytes(c, Uint8Array.of(0xFF));
        for (const p of findAllSeq(d, aff)) {
          const seg = d.subarray(p + 1, p + 1 + maxStride + b.length + 2);
          let q = indexOfSeq(seg, bff, 0);
          while (q >= 0) {
            const stride = q + 1;
            if (stride >= 8 && indexOfSeq(d, cff, p + 2 * stride, p + 2 * stride + cff.length) === p + 2 * stride) {
              const base = p - stride;
              if (base >= 0) {
                const names = []; let k = 0;
                while (base + k * stride + 16 <= d.length && k < 2500 && isText(d, base + k * stride, Math.min(stride, 24))) {
                  names.push(decodeText(d, base + k * stride, Math.min(stride, 24)));
                  k++;
                }
                if (names.length >= minCount) return [base, stride, names];
              }
            }
            q = indexOfSeq(seg, bff, q + 1);
          }
        }
      }
      return null;
    };
    const hx = n => n.toString(16).toUpperCase();
    if (this.species_names.length < 100) {
      const r = find("Bulbasaur", "Ivysaur", "Venusaur", 600, 250);
      if (r) {
        const [base, stride, names] = r;
        names[0] = names[0] ? names[0] : "??????????";
        this.species_names = names; this.species_table_offset = base;
        this.notes.push(`Species table @0x${hx(base)} (${names.length} entries, stride ${stride}, anchored)`);
      }
    }
    if (this.move_names.length < 100) {
      const r = find("Pound", "Karate Chop", "Double Slap", 600, 200);
      if (r) {
        const [base, stride, names] = r;
        this.move_names = names; this.move_table_offset = base;
        this.notes.push(`Move table @0x${hx(base)} (${names.length} entries, stride ${stride}, anchored)`);
      }
    }
    if (!this.item_names.length || this.item_names.length < 100) {
      const r = find("Master Ball", "Ultra Ball", "Great Ball", 600, 200);
      if (r) {
        const [base, stride, names] = r;
        this.item_names = names; this.item_table_offset = base;
        this.notes.push(`Item table @0x${hx(base)} (${names.length} entries, stride ${stride}, anchored; no pocket info)`);
      }
    }
  }
  // --- sprites
  _lzTables(lzSize, tagOff, minTotal) {
    minTotal = minTotal || 300;
    const d = this.data;
    const header = Uint8Array.of(0x10, lzSize & 0xFF, (lzSize >> 8) & 0xFF, (lzSize >> 16) & 0xFF);
    const blobs = new Set();
    let o = 0;
    for (;;) { o = indexOfSeq(d, header, o); if (o < 0) break; blobs.add(o); o++; }
    if (!blobs.size) return [];
    const words = this._words(), refs = [];
    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      if (w >= 0x08000000 && blobs.has(w - 0x08000000)) refs.push(i * 4);
    }
    const runs = []; let cur = [];
    for (const pos of refs) {
      const tag = d[pos + tagOff] | (d[pos + tagOff + 1] << 8);
      if (cur.length && pos - cur[cur.length - 1][0] === 8 && tag === cur[cur.length - 1][1] + 1) cur.push([pos, tag]);
      else { if (cur.length >= 20) runs.push(cur); cur = [[pos, tag]]; }
    }
    if (cur.length >= 20) runs.push(cur);
    const groups = [];
    for (const run of runs) {
      const [a, t] = run[0];
      if (groups.length) {
        const g = groups[groups.length - 1];
        if (a - g.end <= 100 * 8 && (t - g.tag0) * 8 === a - g.start) {
          g.end = run[run.length - 1][0] + 8; g.n += run.length; continue;
        }
      }
      groups.push({ start: a, tag0: t, end: run[run.length - 1][0] + 8, n: run.length });
    }
    const big = groups.filter(g => g.n >= minTotal);
    if (!big.length) return [];
    const top = Math.max(...big.map(g => g.n));
    return big.filter(g => g.n >= 0.8 * top).map(g => [g.start, (g.end - g.start) / 8]).sort((x, y) => x[0] - y[0]);
  }
  ensureGfx() {
    if (this.gfx !== null) return this.gfx;
    const gfx = {};
    const sprites = this._lzTables(0x800, 6), pals = this._lzTables(0x20, 4);
    if (sprites.length) { gfx.front = sprites[0].slice(); if (sprites.length > 1) gfx.back = sprites[1].slice(); }
    if (pals.length) { gfx.pal = pals[0].slice(); if (pals.length > 1) gfx.shiny = pals[1].slice(); }
    this.gfx = gfx;
    if (gfx.back) {
      const opaque = key => {
        let total = 0;
        for (let sp = 1; sp < 60; sp++) {
          const p = this._tableBlob(key, sp);
          const px = p !== null ? lz77Decompress(this.data, p) : null;
          if (px) for (let i = 0; i < px.length; i++) { if (px[i] & 15) total++; if (px[i] >> 4) total++; }
        }
        return total;
      };
      if (opaque("front") > opaque("back")) { const t = gfx.front; gfx.front = gfx.back; gfx.back = t; }
    }
    const keys = Object.keys(gfx);
    if (keys.length) this.notes.push("Sprite tables: " + keys.map(k => `${k} @0x${gfx[k][0].toString(16).toUpperCase()}`).join(", "));
    if (this.onCacheChange) this.onCacheChange();
    return gfx;
  }
  _tableBlob(key, species) {
    const t = (this.gfx || {})[key];
    if (!t || !(species >= 0 && species < t[1])) return null;
    const p = t[0] + species * 8;
    if (p + 4 > this.data.length) return null;
    const ptr = u32(this.data, p) - 0x08000000;
    if (ptr >= 0 && ptr < this.data.length - 4) return ptr;
    return null;
  }
  /** {w:64,h:64,data:Uint8ClampedArray RGBA} or null */
  spriteRgba(species, shiny, back) {
    this.ensureGfx();
    const sp = this._tableBlob(back ? "back" : "front", species);
    const pl = this._tableBlob(shiny && this.gfx.shiny ? "shiny" : "pal", species);
    if (sp === null || pl === null) return null;
    const px = lz77Decompress(this.data, sp), pal = lz77Decompress(this.data, pl);
    if (!px || !pal || px.length < 0x800 || pal.length < 32) return null;
    const cols = [];
    for (let i = 0; i < 16; i++) {
      const v = u16(pal, i * 2);
      cols.push([(v & 31) * 255 / 31 | 0, ((v >> 5) & 31) * 255 / 31 | 0, ((v >> 10) & 31) * 255 / 31 | 0]);
    }
    const out = new Uint8ClampedArray(64 * 64 * 4);
    for (let ty = 0; ty < 8; ty++) for (let tx = 0; tx < 8; tx++) {
      const base = (ty * 8 + tx) * 32;
      for (let y = 0; y < 8; y++) for (let x = 0; x < 4; x++) {
        const b = px[base + y * 4 + x];
        for (let k = 0; k < 2; k++) {
          const n = k === 0 ? b & 15 : b >> 4;
          const o = ((ty * 8 + y) * 64 + tx * 8 + x * 2 + k) * 4;
          if (n) { const c = cols[n]; out[o] = c[0]; out[o + 1] = c[1]; out[o + 2] = c[2]; out[o + 3] = 255; }
        }
      }
    }
    return { w: 64, h: 64, data: out };
  }
  _findItemPockets() {
    const off = this.item_table_offset, d = this.data;
    if (off === null || this._item_count === undefined) return;
    const n = this.item_table_count = this._item_count;
    let mb = null;
    for (let i = 0; i < n; i++) { const p = off + i * 44; if (u16(d, p + 14) === 1) { mb = d[p + 26]; break; } }
    const enums = { 3: { 1: "items", 2: "keyitems", 3: "balls", 4: "tms", 5: "berries" },
      2: { 1: "items", 2: "balls", 3: "tms", 4: "berries", 5: "keyitems" } };
    const names = enums[mb];
    if (!names) { this.notes.push("Item pockets not recognised"); return; }
    for (let i = 0; i < n; i++) {
      const p = off + i * 44, iid = u16(d, p + 14), key = names[d[p + 26]];
      const nm = this.item_names[iid];
      if (key && iid && nm !== undefined && nm !== "" && !allQ(nm)) this.item_pockets[iid] = key;
    }
    this.notes.push(`Item pockets for ${Object.keys(this.item_pockets).length} items`);
  }
  itemsForPocket(pocket) {
    const ids = Object.keys(this.item_pockets).map(Number);
    if (!ids.length) return null;
    if (pocket === "pc_items") return ids.filter(i => this.item_pockets[i] !== "keyitems").sort((a, b) => a - b);
    return ids.filter(i => this.item_pockets[i] === pocket).sort((a, b) => a - b);
  }
  _findBaseStats() {
    const d = this.data, n = this.species_names.length;
    if (n < 100) return;
    const pat = Uint8Array.of(0x2d, 0x31, 0x31, 0x2d, 0x41, 0x41, 0x0c, 0x03, 0x2d);
    for (const pos of findAllSeq(d, pat)) {
      const base = pos - 28;
      if (base < 0 || base % 4 || base + n * 28 > d.length) continue;
      let ok = 0;
      for (let k = 1; k < Math.min(n, 252); k++) {
        const e = base + k * 28;
        if (0 < Math.max(...d.subarray(e, e + 6)) && d[e + 19] <= 5 && d[e + 6] < 0x20 && d[e + 7] < 0x20) ok++;
      }
      if (ok < Math.min(n - 1, 251) * 0.97) continue;
      this.base_stats_offset = base; this.species_stats = [];
      for (let k = 0; k < n; k++) {
        const e = base + k * 28;
        if (e + 28 > d.length) break;
        this.species_stats.push(Array.from(d.subarray(e, e + 6)).concat([d[e + 16], d[e + 19], d[e + 22], d[e + 23], e + 26 < d.length ? d[e + 26] : 0]));
      }
      this.notes.push(`Base-stat table @0x${base.toString(16).toUpperCase()}`);
      return;
    }
    this.notes.push("Base-stat table not found");
  }
  _findAbilities() {
    const d = this.data;
    let best = null;
    for (const [a, b] of [["STENCH", "DRIZZLE"], ["Stench", "Drizzle"]]) {
      const ea = encodeText(a, 6, false), eb = encodeText(b, 7, false);
      for (const ms of findAllSeq(d, concatBytes(ea, Uint8Array.of(0xFF)))) {
        for (let stride = 13; stride < 25; stride++) {
          const base = ms - stride;
          if (base < 0 || base % 4) continue;
          if (indexOfSeq(d, eb, base + 2 * stride, base + 2 * stride + eb.length) !== base + 2 * stride) continue;
          const names = []; let p = base;
          while (p + stride <= d.length && isText(d, p, stride) && names.length < 400) { names.push(decodeText(d, p, stride)); p += stride; }
          if (names.length > 60 && (best === null || names.length > best[1].length)) best = [base, names, stride];
        }
      }
    }
    if (best) {
      this.ability_table_offset = best[0]; this.ability_names = best[1];
      this.notes.push(`Ability table @0x${best[0].toString(16).toUpperCase()} (${best[1].length} entries, stride ${best[2]})`);
      return;
    }
    this.notes.push("Ability table not found");
  }
  speciesInfo(i) {
    if (i >= 0 && i < this.species_stats.length) {
      const s = this.species_stats[i];
      return { base: s.slice(0, 6), gender: s[6], growth: s[7], abilities: s.slice(8, 11) };
    }
    return null;
  }
  ability(i) {
    if (i >= 0 && i < this.ability_names.length && this.ability_names[i]) return this.ability_names[i];
    return `Ability ${i}`;
  }
  _findMovePP() {
    const d = this.data, n = this.move_names.length;
    if (n < 100) return;
    const cnt = Math.min(n, 300);
    const pat = Uint8Array.of(0x28, 0x00, 0x64, 0x23);
    for (const q of findAllSeq(d, pat)) {
      const base = q - 1;       // regex ".\x28\x00\x64\x23": one arbitrary byte in front
      if (base < 0) continue;
      const b0 = base - 12;
      if (b0 < 0 || b0 % 4 || b0 + n * 12 > d.length) continue;
      let ok = 0;
      for (let k = 1; k < cnt; k++) { const v = d[b0 + k * 12 + 4]; if (v > 0 && v <= 64) ok++; }
      if (ok < (cnt - 1) * 0.97) continue;
      if (cnt > 85 && !(d[b0 + 85 * 12 + 2] === 13 && d[b0 + 85 * 12 + 4] === 15)) continue;
      this.move_pp_offset = b0;
      this.move_pps = [];
      for (let k = 0; k < n; k++) this.move_pps.push(d[b0 + k * 12 + 4]);
      this.notes.push(`Move PP table @0x${b0.toString(16).toUpperCase()}`);
      return;
    }
    this.notes.push("Move PP table not found");
  }
  movePP(i) { return i >= 0 && i < this.move_pps.length ? this.move_pps[i] : 0; }
  species(i) { return i >= 0 && i < this.species_names.length && this.species_names[i] ? this.species_names[i] : fallbackSpecies(i); }
  item(i) {
    if (i === 0) return "(none)";
    return i >= 0 && i < this.item_names.length && this.item_names[i] ? this.item_names[i] : fallbackItem(i);
  }
  move(i) { return i >= 0 && i < this.move_names.length && this.move_names[i] ? this.move_names[i] : fallbackMove(i); }
}
function decodeAscii(d, off, len, strip) {
  let s = "";
  let end = off + len;
  if (strip !== false) while (end > off && d[end - 1] === 0) end--;
  for (let i = off; i < end; i++) s += d[i] < 128 ? String.fromCharCode(d[i]) : "\uFFFD";
  return s;
}

// ---------------------------------------------------------------- save constants
const SECTION_SIZE = 0x1000, SECTION_COUNT = 14, SLOT_SIZE = SECTION_SIZE * SECTION_COUNT;
const SIGNATURE = 0x08012025;
const UNBOUND_SIGNATURES = [0x01121998, 0x01121999, 0x01122000];
const RADICAL_RED_SIGNATURE = 0x08012025;
const EMERALD_LEGACY = "EmeraldLegacy", UNBOUND = "Unbound", RADICAL_RED = "RadicalRed";
const CFRU_NAMES = { Unbound: "Pokémon Unbound", RadicalRed: "Pokémon Radical Red" };
const UNBOUND_WINDOWS = { 0: 3876, 4: 3480, 13: 1104 }, UNBOUND_DEFAULT_WINDOW = 4080;
const UNBOUND_OPAQUE = [4];
const UNBOUND_PC_REGIONS = [[5, 4, 4080]].concat([6, 7, 8, 9, 10, 11, 12].map(i => [i, 0, 4080]),
  [[13, 0, 424], [30, 2828, 4080], [31, 0, 3968], [2, 3864, 4080], [3, 0, 3264]]);
const UNBOUND_BOXES = 24, UNBOUND_BOX_SLOTS = 30, UNBOUND_PC_RECORD = 58;
const UNBOUND_BAG = { keyitems: [30, 496, 796], balls: [30, 796, 996], tms: [30, 996, 1508],
  berries: [30, 1508, 2828], items: [13, 2776, 4080] };
const SECTION_DATA_SIZE = [3884, 3968, 3968, 3968, 3848, 3968, 3968, 3968, 3968, 3968, 3968, 3968, 3968, 2000];
const RS = "RS", FRLG = "FRLG", EMERALD = "Emerald";

function checksum(data, off, len) {
  off = off || 0; len = len === undefined ? data.length - off : len;
  let s = 0;
  const end = off + len - (len % 4);
  for (let i = off; i < end; i += 4) s = (s + u32(data, i)) >>> 0;
  return ((s >>> 16) + (s & 0xFFFF)) & 0xFFFF;
}

// ---------------------------------------------------------------- pokemon maths
const NATURES = ["Hardy", "Lonely", "Brave", "Adamant", "Naughty", "Bold", "Docile", "Relaxed", "Impish",
  "Lax", "Timid", "Hasty", "Serious", "Jolly", "Naive", "Modest", "Mild", "Quiet", "Bashful",
  "Rash", "Calm", "Gentle", "Sassy", "Careful", "Quirky"];
const STAT_NAMES = ["HP", "Atk", "Def", "Spe", "SpA", "SpD"];
const GROWTH_NAMES = ["Medium Fast", "Erratic", "Fluctuating", "Medium Slow", "Fast", "Slow"];
function natureEffect(nature) {
  const order = [1, 2, 3, 4, 5];
  return [order[fdiv(nature, 5) % 5], order[nature % 5]];
}
function calcStats(base6, ivs, evs, level, nature) {
  const [up, down] = natureEffect(nature), out = [];
  for (let i = 0; i < 6; i++) {
    const core = fdiv((2 * base6[i] + ivs[i] + fdiv(evs[i], 4)) * level, 100);
    if (i === 0) out.push(base6[0] === 1 ? 1 : core + level + 10);
    else {
      let v = core + 5;
      if (up !== down && i === up) v = fdiv(v * 110, 100);
      else if (up !== down && i === down) v = fdiv(v * 90, 100);
      out.push(v);
    }
  }
  return out;
}
function expForLevel(rate, n) {
  const c = n ** 3;
  if (rate === 0) return c;
  if (rate === 1) {
    if (n <= 50) return fdiv(c * (100 - n), 50);
    if (n <= 68) return fdiv(c * (150 - n), 100);
    if (n <= 98) return fdiv(c * fdiv(1911 - 10 * n, 3), 500);
    return fdiv(c * (160 - n), 100);
  }
  if (rate === 2) {
    if (n <= 15) return fdiv(c * (fdiv(n + 1, 3) + 24), 50);
    if (n <= 35) return fdiv(c * (n + 14), 50);
    return fdiv(c * (fdiv(n, 2) + 32), 50);
  }
  if (rate === 3) return Math.max(0, fdiv(6 * c, 5) - 15 * n * n + 100 * n - 140);
  if (rate === 4) return fdiv(4 * c, 5);
  return fdiv(5 * c, 4);
}
function levelFromExp(rate, exp) {
  let lvl = 1;
  for (let n = 2; n <= 100; n++) { if (exp >= expForLevel(rate, n)) lvl = n; else break; }
  return lvl;
}
function genderOf(pid, ratio) {
  if (ratio === null || ratio === undefined) return null;
  if (ratio === 255) return 2;
  if (ratio === 254) return 1;
  if (ratio === 0) return 0;
  return (pid & 0xFF) < ratio ? 1 : 0;
}
function isShinyPid(pid, otid, threshold) {
  return (((otid & 0xFFFF) ^ (otid >>> 16) ^ (pid >>> 16) ^ (pid & 0xFFFF)) >>> 0) < threshold;
}
function solvePid(pid, otid, nature, parity, shiny, ratio, threshold) {
  const ok = p => p % 25 === nature && (p & 1) === parity && isShinyPid(p, otid, threshold) === shiny;
  if (ok(pid)) return pid;
  let lo8 = pid & 0xFF;
  if ((pid & 1) !== parity) {
    const g = genderOf(pid, ratio), base = pid - (pid & 0xFF), cands = [];
    for (let v = 0; v < 256; v++)
      if ((v & 1) === parity && (ratio === null || ratio === undefined || genderOf(base + v, ratio) === g)) cands.push(v);
    cands.sort((a, b) => Math.abs(a - lo8) - Math.abs(b - lo8));   // stable, like Python's sorted()
    lo8 = cands.length ? cands[0] : lo8 ^ 1;
  }
  const h0 = Math.floor(pid / 256);
  const d = mod((nature - lo8) * 21, 25);
  const start = h0 - (h0 % 25) + d;
  const total = Math.floor(16777216 / 25);
  for (let k = 0; k <= total; k++) {
    for (const sign of (k === 0 ? [1] : [1, -1])) {
      const h = start + sign * 25 * k;
      if (h >= 0 && h < 16777216) { const p = h * 256 + lo8; if (ok(p)) return p; }
    }
  }
  return pid;
}

class MonExtras {
  get ivs() { const w = this._iv_word(); return [0, 1, 2, 3, 4, 5].map(i => (w >>> (5 * i)) & 31); }
  set ivs(vals) {
    let w = (this._iv_word() & 0xC0000000) >>> 0;
    for (let i = 0; i < 6; i++) w = (w | ((clamp(Math.trunc(vals[i]) || 0, 0, 31) & 31) << (5 * i))) >>> 0;
    this._set_iv_word(w);
  }
  get evs() { return Array.from(this._get_evs()); }
  set evs(vals) { this._set_evs(vals.map(v => clamp(Math.trunc(v) || 0, 0, 255))); }
  get nature() { return this.pid % 25; }
  get hidden_ability() { return !!((this._iv_word() >>> 31) & 1); }
  get ability_slot() {
    if (this.ABILITY_BY_PID) return this.hidden_ability ? 2 : (this.pid & 1);
    return this.hidden_ability ? 1 : 0;
  }
  get is_shiny() { return isShinyPid(this.pid, this.otid, this.SHINY_THRESHOLD); }
  gender(ratio) { return genderOf(this.pid, ratio); }
  set_identity(nature, ability_slot, shiny, ratio) {
    const pid = this.pid;
    if (nature === undefined || nature === null) nature = this.nature;
    if (shiny === undefined || shiny === null) shiny = this.is_shiny;
    const slot = ability_slot === undefined || ability_slot === null ? this.ability_slot : ability_slot;
    let w = this._iv_word(), hidden, parity;
    if (this.ABILITY_BY_PID) { hidden = slot === 2; parity = hidden ? (pid & 1) : slot; }
    else { hidden = !!slot; parity = pid & 1; }
    w = hidden ? (w | 0x80000000) >>> 0 : (w & 0x7FFFFFFF) >>> 0;
    this._set_iv_word(w);
    const nw = solvePid(pid, this.otid, nature, parity, shiny, ratio === undefined ? null : ratio, this.SHINY_THRESHOLD);
    if (nw !== pid) this.pid = nw;
  }
  recalc_stats(base6) {
    if (!this.is_party || !base6) return;
    const lvl = this.level;
    const nw = calcStats(base6, this.ivs, this.evs, lvl, this.nature);
    const oldCur = u16(this.raw, 86), oMax = u16(this.raw, 88);
    const cur = oldCur >= oMax || oMax === 0 ? nw[0] : Math.min(nw[0], oldCur);
    p16(this.raw, 86, cur);
    for (let i = 0; i < 6; i++) p16(this.raw, 88 + i * 2, nw[i]);
  }
}

// ---------------------------------------------------------------- Pokemon records
const ORDERS = ["GAEM", "GAME", "GEAM", "GEMA", "GMAE", "GMEA", "AGEM", "AGME", "AEGM",
  "AEMG", "AMGE", "AMEG", "EGAM", "EGMA", "EAGM", "EAMG", "EMGA", "EMAG",
  "MGAE", "MGEA", "MAGE", "MAEG", "MEGA", "MEAG"];
function sum16(dec) { let cs = 0; for (let i = 0; i < 48; i += 2) cs = (cs + u16(dec, i)) & 0xFFFF; return cs; }

/** Decrypted Gen3 Pokemon (80 byte box / 100 byte party). */
class Pokemon extends MonExtras {
  constructor(raw) {
    super();
    this.SHINY_THRESHOLD = 8; this.ABILITY_BY_PID = false; this.ABILITY_SLOTS = 2; this.HAS_BALL = false;
    this.raw = Uint8Array.from(raw);
    this.is_party = raw.length >= 100;
    this._pid = u32(this.raw, 0);
    this.otid = u32(this.raw, 4);
    this.nickname_raw = this.raw.slice(8, 18);
    this.ot_raw = this.raw.slice(20, 27);
    const key = (this._pid ^ this.otid) >>> 0;
    const dec = new Uint8Array(48);
    for (let i = 0; i < 48; i += 4) p32(dec, i, (u32(this.raw, 32 + i) ^ key) >>> 0);
    const order = ORDERS[this._pid % 24];
    this.blocks = {};
    for (let idx = 0; idx < 4; idx++) this.blocks[order[idx]] = dec.slice(idx * 12, idx * 12 + 12);
    this.order = order;
    this.valid = sum16(dec) === u16(this.raw, 28);
  }
  get pid() { return this._pid; }
  set pid(v) { v = v >>> 0; this._pid = v; this.order = ORDERS[v % 24]; p32(this.raw, 0, v); }
  _iv_word() { return u32(this.blocks.M, 4); }
  _set_iv_word(v) { p32(this.blocks.M, 4, v >>> 0); }
  _get_evs() { return this.blocks.E.slice(0, 6); }
  _set_evs(vals) { for (let i = 0; i < 6; i++) this.blocks.E[i] = vals[i]; }
  get happiness() { return this.blocks.G[9]; }
  set happiness(v) { this.blocks.G[9] = clamp(Math.trunc(v) || 0, 0, 255); }
  get empty() { return this.pid === 0 && this.species === 0; }
  get species() { return u16(this.blocks.G, 0); }
  set species(v) { p16(this.blocks.G, 0, v); }
  get held_item() { return u16(this.blocks.G, 2); }
  set held_item(v) { p16(this.blocks.G, 2, v); }
  get exp() { return u32(this.blocks.G, 4); }
  set exp(v) { p32(this.blocks.G, 4, v >>> 0); }
  get moves() { return [0, 1, 2, 3].map(i => u16(this.blocks.A, i * 2)); }
  set_move(i, v) { p16(this.blocks.A, i * 2, v); }
  get pp() { return Array.from(this.blocks.A.slice(8, 12)); }
  get level() { return this.is_party ? this.raw[84] : 0; }
  set level(v) { if (this.is_party) this.raw[84] = v; }
  get nickname() { return decodeText(this.nickname_raw); }
  set nickname(s) { this.nickname_raw = encodeText(s, 10); }
  get ot_name() { return decodeText(this.ot_raw); }
  to_bytes() {
    const out = Uint8Array.from(this.raw), dec = new Uint8Array(48);
    for (let idx = 0; idx < 4; idx++) dec.set(this.blocks[this.order[idx]], idx * 12);
    p16(out, 28, sum16(dec));
    out.set(this.nickname_raw, 8);
    out.set(this.ot_raw, 20);
    const key = (this.pid ^ this.otid) >>> 0;
    for (let i = 0; i < 48; i += 4) p32(out, 32 + i, (u32(dec, i) ^ key) >>> 0);
    return out;
  }
}

class UnboundMon extends MonExtras {
  constructor(raw, size) {
    super();
    this.SHINY_THRESHOLD = 16; this.ABILITY_BY_PID = true; this.ABILITY_SLOTS = 3; this.HAS_BALL = true;
    this.raw = Uint8Array.from(raw.subarray ? raw.subarray(0, size) : raw.slice(0, size));
    this.SIZE = size;
  }
  get pid() { return u32(this.raw, 0); }
  set pid(v) { p32(this.raw, 0, v >>> 0); }
  get otid() { return u32(this.raw, 4); }
  get nickname() { return decodeText(this.raw, 8, 10); }
  set nickname(s) { this.raw.set(encodeText(s, 10), 8); }
  get ot_name() { return decodeText(this.raw, 20, 7); }
  get happiness() { return this.raw[this.O_HAPPY]; }
  set happiness(v) { this.raw[this.O_HAPPY] = clamp(Math.trunc(v) || 0, 0, 255); }
  get ball() { return this.raw[this.O_BALL]; }
  set ball(v) { this.raw[this.O_BALL] = clamp(Math.trunc(v) || 0, 0, 255); }
  get empty() { return this.species === 0; }
  to_bytes() { return Uint8Array.from(this.raw); }
  _iv_word() { return u32(this.raw, this.O_IV); }
  _set_iv_word(v) { p32(this.raw, this.O_IV, v >>> 0); }
  _get_evs() { return this.raw.slice(this.O_EV, this.O_EV + 6); }
  _set_evs(vals) { for (let i = 0; i < 6; i++) this.raw[this.O_EV + i] = vals[i]; }
  get species() { return u16(this.raw, this.O_SPECIES); }
  set species(v) { p16(this.raw, this.O_SPECIES, v); }
  get held_item() { return u16(this.raw, this.O_ITEM); }
  set held_item(v) { p16(this.raw, this.O_ITEM, v); }
  get exp() { return u32(this.raw, this.O_EXP); }
  set exp(v) { p32(this.raw, this.O_EXP, v >>> 0); }
}
UnboundMon.move_pp_lookup = null;

class UnboundPartyMon extends UnboundMon {
  constructor(raw) {
    super(raw, 100);
    this.is_party = true;
    this.O_SPECIES = 32; this.O_ITEM = 34; this.O_EXP = 36; this.O_MOVES = 44; this.O_PP = 52;
    this.O_IV = 72; this.O_EV = 56; this.O_HAPPY = 41; this.O_BALL = 42;
  }
  get moves() { return [0, 1, 2, 3].map(i => u16(this.raw, this.O_MOVES + i * 2)); }
  set_move(i, v) {
    const old = this.moves[i];
    p16(this.raw, this.O_MOVES + i * 2, v);
    if (v !== old) {
      let pp = 0;
      if (v && UnboundMon.move_pp_lookup) pp = UnboundMon.move_pp_lookup(v) || 0;
      this.raw[this.O_PP + i] = v ? pp : 0;
    }
  }
  get pp() { return Array.from(this.raw.slice(this.O_PP, this.O_PP + 4)); }
  get level() { return this.raw[84]; }
  set level(v) { this.raw[84] = clamp(v, 1, 100); }
  get valid() { return this.species > 0 && this.species <= 2500 && this.raw[84] >= 1 && this.raw[84] <= 100; }
  to_bytes() { const out = Uint8Array.from(this.raw); p16(out, 28, 0); return out; }
}

function getPacked40(raw, o) { let p = 0n; for (let k = 0; k < 5; k++) p |= BigInt(raw[o + k]) << BigInt(8 * k); return p; }
function setPacked40(raw, o, p) { for (let k = 0; k < 5; k++) raw[o + k] = Number((p >> BigInt(8 * k)) & 0xFFn); }

class UnboundBoxMon extends UnboundMon {
  constructor(raw) {
    super(raw, 58);
    this.is_party = false;
    this.O_SPECIES = 28; this.O_ITEM = 30; this.O_EXP = 32; this.O_IV = 54; this.O_EV = 44; this.O_HAPPY = 37; this.O_BALL = 38;
  }
  get moves() { const p = getPacked40(this.raw, 0x27); return [0, 1, 2, 3].map(k => Number((p >> BigInt(10 * k)) & 0x3FFn)); }
  set_move(i, v) {
    let p = getPacked40(this.raw, 0x27);
    p &= ~(0x3FFn << BigInt(10 * i));
    p |= BigInt(v & 0x3FF) << BigInt(10 * i);
    setPacked40(this.raw, 0x27, p);
  }
  get pp() { return [0, 0, 0, 0]; }
  get level() { return 0; }
  get valid() { return this.species > 0 && this.species <= 2500 && this.exp > 0 && this.exp <= 2000000; }
}

class PartyOps {
  add_party_member(mon) {
    const n = this.party_count;
    if (n >= 6) throw new Error("The party is full (6 Pokémon)");
    this.set_party_member(n, mon);
    this.party_count = n + 1;
    return n;
  }
  remove_party_member(i) {
    const n = this.party_count;
    if (!(i >= 0 && i < n)) return;
    const base = this._party_off();
    for (let j = i; j < n - 1; j++) this.data.copyWithin(base + j * 100, base + (j + 1) * 100, base + (j + 2) * 100);
    this.data.fill(0, base + (n - 1) * 100, base + n * 100);
    this.party_count = n - 1;
  }
}

// ---------------------------------------------------------------- SaveFile
class SaveFile extends PartyOps {
  constructor(data, game) {
    super();
    if (game === undefined) game = null;
    if (data.length < SLOT_SIZE * 2) throw new Error("Save too small (expected >= 128 KB)");
    this.data = Uint8Array.from(data);
    this._orig = Uint8Array.from(data);
    this.unfixable = []; this.slot_offset = null; this.sections = {}; this.game = RS; this.security_key = 0;
    this.legacy = false; this.detect_scores = {};
    this._force = (game === UNBOUND || game === RADICAL_RED) ? game
      : ([RS, FRLG, EMERALD, EMERALD_LEGACY].includes(game) ? "none" : null);
    this.cfru = null;
    this._findActiveSlot();
    this.hack = CFRU_NAMES[this.cfru] || "";
    this.shiny_threshold = this.cfru === RADICAL_RED ? 8 : 16;
    if (this.is_unbound) { this._setGame(FRLG); this.security_key = 0; this.detect_scores = {}; }
    else if (game === RS || game === FRLG || game === EMERALD) { this._setGame(game); this.detect_scores = {}; }
    else if (game === EMERALD_LEGACY) { this._setGame(EMERALD); this.detect_scores = {}; }
    else this._detectGame();
    this.legacy = game === EMERALD_LEGACY || (game === null && this.game === EMERALD && this._detectLegacy());
    if (this.legacy) this.hack = "Pokémon Emerald Legacy";
  }
  get qty_max() { return 999; }
  get BOX_SLOTS() { return 30; }
  get POCKETS() { return ["pc_items", "items", "keyitems", "balls", "tms", "berries"]; }
  get POCKET_LABELS() { return {}; }
  get is_unbound() { return this.cfru !== null; }
  get is_cfru() { return this.cfru !== null; }
  get BOXES() { return this.is_unbound ? UNBOUND_BOXES : 14; }
  _slotInfo(base) {
    const ids = {}, sigs = new Set(), counters = [];
    for (let i = 0; i < SECTION_COUNT; i++) {
      const off = base + i * SECTION_SIZE, sid = u16(this.data, off + 0xFF4);
      const sig = u32(this.data, off + 0xFF8), cnt = u32(this.data, off + 0xFFC);
      if (sig === 0 || sig === 0xFFFFFFFF || sid >= SECTION_COUNT) return [null, -1, null];
      ids[sid] = off; sigs.add(sig); counters.push(cnt);
    }
    const allUnb = Array.from(sigs).every(s => UNBOUND_SIGNATURES.includes(s));
    if (Object.keys(ids).length !== SECTION_COUNT || !(sigs.size === 1 || allUnb)) return [null, -1, null];
    return [ids, Math.max(...counters), Math.min(...sigs)];
  }
  _findActiveSlot() {
    const [a, ca, sa] = this._slotInfo(0), [b, cb, sb] = this._slotInfo(SLOT_SIZE);
    if (a === null && b === null) throw new Error("No valid Gen3 save slot found (no 14 sections with a common signature)");
    if (b === null || (a !== null && ca >= cb)) { this.sections = a; this.slot_offset = 0; this.counter = ca; this.signature = sa; }
    else { this.sections = b; this.slot_offset = SLOT_SIZE; this.counter = cb; this.signature = sb; }
    this.cfru = this._detectCfru();
    this.sect_size = {}; this.bad_sections = []; this.nonstandard = false;
    for (const sidS of Object.keys(this.sections)) {
      const sid = +sidS, off = this.sections[sid], stored = u16(this.data, off + 0xFF6);
      let chosen = null;
      if (this.is_unbound && UNBOUND_OPAQUE.includes(sid)) {
        this.sect_size[sid] = UNBOUND_WINDOWS[sid] !== undefined ? UNBOUND_WINDOWS[sid] : UNBOUND_DEFAULT_WINDOW;
        this.nonstandard = true;
        continue;
      }
      let known = [SECTION_DATA_SIZE[sid]];
      if (this.is_unbound) known = [UNBOUND_WINDOWS[sid] !== undefined ? UNBOUND_WINDOWS[sid] : UNBOUND_DEFAULT_WINDOW].concat(known);
      for (const n of known) if (checksum(this.data, off, n) === stored) { chosen = n; break; }
      if (chosen === null) {
        let s = 0, firstNz = null; const matches = [];
        for (let w = 0; w < 0xFF4 / 4; w++) {
          const word = u32(this.data, off + w * 4);
          if (word && firstNz === null) firstNz = (w + 1) * 4;
          s = (s + word) >>> 0;
          if (firstNz !== null && ((((s >>> 16) + (s & 0xFFFF)) & 0xFFFF) === stored)) matches.push((w + 1) * 4);
        }
        if (matches.length) chosen = matches[0];
      }
      if (chosen === null) { this.bad_sections.push(sid); chosen = SECTION_DATA_SIZE[sid]; }
      if (chosen !== SECTION_DATA_SIZE[sid]) this.nonstandard = true;
      this.sect_size[sid] = chosen;
    }
  }
  sec(sid) { return this.sections[sid]; }
  _party_off() { return this._inv_base() + this._layout().party; }
  _detectCfru() {
    if (this._force === UNBOUND || this._force === RADICAL_RED) return this._force;
    if (UNBOUND_SIGNATURES.includes(this.signature)) return UNBOUND;
    if (this._force !== "none" && this.signature === RADICAL_RED_SIGNATURE) {
      const o = this.sections[0];
      const gc = u32(this.data, o + 0xAC), key = u32(this.data, o + 0xF20), copy = u32(this.data, o + 0xAF8);
      if (gc === 1 && (key === 0 || key !== copy)) return RADICAL_RED;
    }
    return null;
  }
  _setGame(game) {
    this.game = game;
    const o = this.sec(0);
    if (game === EMERALD) this.security_key = u32(this.data, o + 0xAC);
    else if (game === FRLG) this.security_key = u32(this.data, o + 0xF20);
    else this.security_key = 0;
  }
  _scoreGame() {
    const L = this._layout(), b = this._inv_base();
    let score = 0;
    const n = u32(this.data, b + L.party_cnt);
    if (n >= 0 && n <= 6) {
      score += 1;
      for (let i = 0; i < n; i++) {
        const o = b + L.party + i * 100, m = new Pokemon(this.data.subarray(o, o + 100));
        if (m.valid && m.species > 0 && m.species < 2000 && m.level > 0 && m.level <= 100) score += 3;
      }
    }
    if (this.money <= 999999) score += 2;
    return score;
  }
  _detectGame() {
    const o = this.sec(0), code = u32(this.data, o + 0xAC);
    const hint = code === 0 ? RS : code === 1 ? FRLG : EMERALD;
    this.detect_scores = {};
    let best = null, bestScore = -1;
    for (const g of [hint, RS, FRLG, EMERALD]) {
      if (g in this.detect_scores) continue;
      this._setGame(g);
      this.detect_scores[g] = this._scoreGame();
      if (this.detect_scores[g] > bestScore) { best = g; bestScore = this.detect_scores[g]; }
    }
    this._setGame(best);
  }
  _detectLegacy() {
    try {
      const small = this.data.subarray(this.sec(0), this.sec(0) + 0xF80);
      const large = new Uint8Array(0xF80 * 4);
      for (let i = 1; i <= 4; i++) large.set(this.data.subarray(this.sec(i), this.sec(i) + 0xF80), (i - 1) * 0xF80);
      const same = (a, b) => { for (let k = 0; k < 0x34; k++) if (large[a + k] !== large[b + k]) return false; return true; };
      if (!same(0xAF0, 0x3B34) || same(0x988, 0x3B24)) return false;
      const key = u32(small, 0xAC) & 0xFFFF;
      let usedKeys = 0;
      for (const [off, slots, mx] of [[0x740, 30, 1], [0x8F8, 46, 999], [0x7F8, 64, 99]]) {
        for (let i = 0; i < slots; i++) {
          const iid = u16(large, off + i * 4), qty = u16(large, off + i * 4 + 2);
          if (iid === 0) continue;
          const q = qty ^ key;
          if (q === 0 || q > mx) return false;
          if (off === 0x740) usedKeys++;
        }
      }
      return usedKeys > 0;
    } catch (e) { return false; }
  }
  pocket_qty_max(pocket) {
    if (this.legacy) return { pc_items: 999, items: 99, keyitems: 1, balls: 99, tms: 99, berries: 999 }[pocket] || 99;
    if (this.cfru) return pocket === "tms" ? 1 : 999;
    return { keyitems: 1, tms: 99 }[pocket] || 999;
  }
  _layout() {
    const g = this.game;
    if (this.legacy) return { party_cnt: 0x234, party: 0x238, money: 0x490, coins: 0x494, pc_items: [0x498, 50], items: [0x560, 120],
      keyitems: [0x740, 30], balls: [0x7B8, 16], tms: [0x7F8, 64], berries: [0x8F8, 46] };
    if (g === RS) return { party_cnt: 0x234, party: 0x238, money: 0x490, coins: 0x494, pc_items: [0x498, 50], items: [0x560, 20],
      keyitems: [0x5B0, 20], balls: [0x600, 16], tms: [0x640, 64], berries: [0x740, 46] };
    if (g === FRLG) return { party_cnt: 0x34, party: 0x38, money: 0x290, coins: 0x294, pc_items: [0x298, 30], items: [0x310, 42],
      keyitems: [0x3B8, 30], balls: [0x430, 13], tms: [0x464, 58], berries: [0x54C, 43] };
    return { party_cnt: 0x234, party: 0x238, money: 0x490, coins: 0x494, pc_items: [0x498, 50], items: [0x560, 30],
      keyitems: [0x5D8, 30], balls: [0x650, 16], tms: [0x690, 64], berries: [0x790, 46] };
  }
  get trainer_name() { return decodeText(this.data, this.sec(0), 7); }
  set trainer_name(s) { this.data.set(encodeText(s, 8), this.sec(0)); }
  get trainer_gender() { return this.data[this.sec(0) + 8]; }
  get trainer_id() { const o = this.sec(0); return [u16(this.data, o + 0xA), u16(this.data, o + 0xC)]; }
  get play_time() { const o = this.sec(0); return [u16(this.data, o + 0xE), this.data[o + 0x10], this.data[o + 0x11]]; }
  _inv_base() { return this.sec(1); }
  get money() {
    const o = this._inv_base() + this._layout().money, v = u32(this.data, o);
    return this.game !== RS ? (v ^ this.security_key) >>> 0 : v;
  }
  set money(v) {
    const o = this._inv_base() + this._layout().money;
    v = clamp(Math.trunc(v) || 0, 0, this.money_max);
    p32(this.data, o, this.game !== RS ? (v ^ this.security_key) >>> 0 : v);
    if (this.cfru === UNBOUND && v <= 999999) {
      const digits = String(v).padStart(6, "0");
      for (let k = 0; k < 3; k++) this.data[o - 3 + k] = (+digits[2 * k + 1] << 4) | +digits[2 * k];
    }
  }
  get money_max() { return this.cfru === UNBOUND ? 999999999 : 999999; }
  party() {
    const L = this._layout(), b = this._inv_base();
    const n = Math.min(u32(this.data, b + L.party_cnt), 6), res = [];
    for (let i = 0; i < n; i++) {
      const o = b + L.party + i * 100, sub = this.data.subarray(o, o + 100);
      let m;
      if (this.is_unbound) { m = new UnboundPartyMon(sub); m.SHINY_THRESHOLD = this.shiny_threshold; }
      else { m = new Pokemon(sub); m.SHINY_THRESHOLD = 8; }
      res.push(m);
    }
    return res;
  }
  set_party_member(i, mon) { this.data.set(mon.to_bytes(), this._inv_base() + this._layout().party + i * 100); }
  _pc_buffer() {
    const buf = new Uint8Array(33744); let p = 0;
    for (let sid = 5; sid < 14; sid++) { const o = this.sec(sid), n = SECTION_DATA_SIZE[sid]; buf.set(this.data.subarray(o, o + n), p); p += n; }
    return buf;
  }
  _pc_write_back(buf) {
    let p = 0;
    for (let sid = 5; sid < 14; sid++) { const o = this.sec(sid), n = SECTION_DATA_SIZE[sid]; this.data.set(buf.subarray(p, p + n), o); p += n; }
  }
  _unbound_regions() {
    return UNBOUND_PC_REGIONS.map(([sid, start, end]) => [(sid < SECTION_COUNT ? this.sec(sid) : sid * SECTION_SIZE) + start, end - start]);
  }
  _unbound_gather() {
    const parts = [];
    let total = 0;
    for (const [off, length] of this._unbound_regions()) {
      if (off + length > this.data.length) throw new Error("PC auxiliary storage is truncated");
      parts.push(this.data.subarray(off, off + length)); total += length;
    }
    const buf = new Uint8Array(total); let p = 0;
    for (const x of parts) { buf.set(x, p); p += x.length; }
    return buf;
  }
  _unbound_scatter(buf) {
    let p = 0;
    for (const [off, length] of this._unbound_regions()) { this.data.set(buf.subarray(p, p + length), off); p += length; }
  }
  /** Map: box*30+slot -> Pokemon */
  box_pokemon() {
    const res = new Map();
    if (this.is_unbound) {
      const buf = this._unbound_gather();
      for (let i = 0; i < UNBOUND_BOXES * UNBOUND_BOX_SLOTS; i++) {
        const mon = new UnboundBoxMon(buf.subarray(i * UNBOUND_PC_RECORD, (i + 1) * UNBOUND_PC_RECORD));
        mon.SHINY_THRESHOLD = this.shiny_threshold;
        if (mon.valid) res.set(i, mon);
      }
      return res;
    }
    const buf = this._pc_buffer();
    for (let box = 0; box < 14; box++) for (let slot = 0; slot < 30; slot++) {
      const off = 4 + (box * 30 + slot) * 80, mon = new Pokemon(buf.subarray(off, off + 80));
      if (!mon.empty && mon.valid) res.set(box * 30 + slot, mon);
    }
    return res;
  }
  set_box_pokemon(box, slot, mon) {
    if (this.is_unbound) {
      const buf = this._unbound_gather(), i = box * UNBOUND_BOX_SLOTS + slot;
      buf.set(toBoxBytes(this, mon), i * UNBOUND_PC_RECORD);
      this._unbound_scatter(buf);
      return;
    }
    const buf = this._pc_buffer(), off = 4 + (box * 30 + slot) * 80;
    buf.set(mon.to_bytes().subarray(0, 80), off);
    this._pc_write_back(buf);
  }
  delete_box_pokemon(box, slot) {
    if (this.is_unbound) {
      const buf = this._unbound_gather(), i = box * UNBOUND_BOX_SLOTS + slot;
      buf.fill(0, i * UNBOUND_PC_RECORD, (i + 1) * UNBOUND_PC_RECORD);
      this._unbound_scatter(buf);
      return;
    }
    const buf = this._pc_buffer(), off = 4 + (box * 30 + slot) * 80;
    buf.fill(0, off, off + 80);
    this._pc_write_back(buf);
  }
  get party_count() { return Math.min(u32(this.data, this._inv_base() + this._layout().party_cnt), 6); }
  set party_count(n) { p32(this.data, this._inv_base() + this._layout().party_cnt, clamp(n, 0, 6)); }
  _unbound_pocket(pocket) {
    const [sid, start, hardEnd] = UNBOUND_BAG[pocket];
    const base = sid < SECTION_COUNT ? this.sec(sid) : sid * SECTION_SIZE, a = base + start, slots = fdiv(hardEnd - start, 4);
    let n = 0;
    while (n < slots && u16(this.data, a + n * 4) !== 0) n++;
    let cap = n;
    while (cap < slots && u32(this.data, a + cap * 4) === 0) cap++;
    return [a, cap];
  }
  pocket_capacity(pocket) {
    if (this.is_unbound && pocket in UNBOUND_BAG) return this._unbound_pocket(pocket)[1];
    return this._layout()[pocket][1];
  }
  bag(pocket) {
    if (this.is_unbound && pocket in UNBOUND_BAG) {
      const [a, cap] = this._unbound_pocket(pocket), items = [];
      for (let i = 0; i < cap; i++) {
        const iid = u16(this.data, a + i * 4), qty = u16(this.data, a + i * 4 + 2);
        if (iid === 0) break;
        items.push([iid, qty]);
      }
      return items;
    }
    const [base, count] = this._layout()[pocket], b = this._inv_base() + base;
    const key = this.game !== RS ? this.security_key & 0xFFFF : 0, items = [];
    for (let i = 0; i < count; i++) {
      const iid = u16(this.data, b + i * 4), qty = u16(this.data, b + i * 4 + 2) ^ key;
      if (iid !== 0) items.push([iid, qty & 0xFFFF]);
    }
    return items;
  }
  set_bag(pocket, items) {
    if (this.is_unbound && pocket in UNBOUND_BAG) {
      const [a, cap] = this._unbound_pocket(pocket);
      for (let i = 0; i < cap; i++) {
        const [iid, qty] = i < items.length ? items[i] : [0, 0];
        p16(this.data, a + i * 4, iid); p16(this.data, a + i * 4 + 2, iid ? Math.min(qty, 0xFFFF) : 0);
      }
      return;
    }
    const [base, count] = this._layout()[pocket], b = this._inv_base() + base;
    const key = this.game !== RS ? this.security_key & 0xFFFF : 0;
    for (let i = 0; i < count; i++) {
      const [iid, qty] = i < items.length ? items[i] : [0, 0];
      p16(this.data, b + i * 4, iid); p16(this.data, b + i * 4 + 2, (qty ^ key) & 0xFFFF);
    }
  }
  item_filter(pocket) { return null; }
  fix_checksums() {
    this.unfixable = [];
    for (const sidS of Object.keys(this.sections)) {
      const sid = +sidS, off = this.sections[sid];
      if (this.nonstandard && eqRange(this.data, this._orig, off, 0xFF4)) continue;
      if (this.is_unbound && UNBOUND_OPAQUE.includes(sid)) continue;
      if (this.bad_sections.includes(sid) && this.nonstandard) { this.unfixable.push(sid); continue; }
      const n = this.sect_size[sid] !== undefined ? this.sect_size[sid] : SECTION_DATA_SIZE[sid];
      p16(this.data, off + 0xFF6, checksum(this.data, off, n));
    }
  }
  to_bytes() { this.fix_checksums(); return Uint8Array.from(this.data); }
}

// ---------------------------------------------------------------- pokeemerald-expansion records
class ExpansionMon extends Pokemon {
  constructor(raw) { super(raw); this.SHINY_THRESHOLD = 8; this.HAS_BALL = true; this.ABILITY_BY_PID = false; this.ABILITY_SLOTS = 3; }
  static _w(block, off, mask, v) { const old = u16(block, off); p16(block, off, (old & ~mask & 0xFFFF) | (v & mask)); }
  get species() { return u16(this.blocks.G, 0) & 0x7FF; }
  set species(v) { ExpansionMon._w(this.blocks.G, 0, 0x7FF, v); this.raw[0x13] = v ? (this.raw[0x13] | 2) : (this.raw[0x13] & ~2 & 0xFF); }
  get held_item() { return u16(this.blocks.G, 2) & 0x3FF; }
  set held_item(v) { ExpansionMon._w(this.blocks.G, 2, 0x3FF, v); }
  get exp() { return u32(this.blocks.G, 4) & 0x1FFFFF; }
  set exp(v) { const old = u32(this.blocks.G, 4); p32(this.blocks.G, 4, ((old & ~0x1FFFFF) | (v & 0x1FFFFF)) >>> 0); }
  get moves() { return [0, 1, 2, 3].map(i => u16(this.blocks.A, i * 2) & 0x7FF); }
  set_move(i, v) { ExpansionMon._w(this.blocks.A, i * 2, 0x7FF, v); }
  get pp() { return Array.from(this.blocks.A.slice(8, 12)).map(b => b & 0x7F); }
  get ball() { return u16(this.blocks.G, 10) & 0x3F; }
  set ball(v) { ExpansionMon._w(this.blocks.G, 10, 0x3F, v); }
  get nickname() {
    const c11 = (u32(this.blocks.G, 4) >>> 21) & 0xFF, c12 = (u16(this.blocks.G, 10) >>> 6) & 0xFF;
    const raw = (c11 === 0 && c12 === 0) ? this.nickname_raw : concatBytes(this.nickname_raw, Uint8Array.of(c11, c12));
    return decodeText(raw);
  }
  set nickname(s) {
    const raw = encodeText(s, 12);
    this.nickname_raw = raw.slice(0, 10);
    let c11 = raw[10], c12 = raw[11];
    if (c11 === TERM && c12 === TERM) c11 = c12 = 0;
    const old = u32(this.blocks.G, 4);
    p32(this.blocks.G, 4, ((old & ~(0xFF << 21)) | (c11 << 21)) >>> 0);
    ExpansionMon._w(this.blocks.G, 10, 0xFF << 6, c12 << 6);
  }
  get nature() { return (this.pid % 25) ^ (this.raw[0x12] >> 3); }
  get ability_slot() { return Math.min((u32(this.blocks.M, 8) >>> 29) & 3, 2); }
  get is_shiny() {
    const natural = isShinyPid(this.pid, this.otid, this.SHINY_THRESHOLD), flip = (u16(this.raw, 0x1E) >>> 14) & 1;
    return natural !== !!flip;
  }
  set_identity(nature, ability_slot, shiny, ratio) {
    if (nature !== undefined && nature !== null && nature !== this.nature)
      this.raw[0x12] = (this.raw[0x12] & 7) | (((this.pid % 25) ^ nature) << 3);
    if (ability_slot !== undefined && ability_slot !== null) {
      const w = u32(this.blocks.M, 8);
      p32(this.blocks.M, 8, ((w & ~(3 << 29)) | ((ability_slot & 3) << 29)) >>> 0);
    }
    if (shiny !== undefined && shiny !== null) {
      const natural = isShinyPid(this.pid, this.otid, this.SHINY_THRESHOLD);
      let hw = u16(this.raw, 0x1E);
      hw = natural !== !!shiny ? (hw | 0x4000) : (hw & ~0x4000 & 0xFFFF);
      p16(this.raw, 0x1E, hw);
    }
  }
}

const HS_POCKET_RUNS = [[1, "balls"], [28, "medicine"], [73, "items"], [102, "medicine"], [112, "items"],
  [121, "medicine"], [133, "items"], [165, "keyitems"], [170, "items"], [461, "keyitems"],
  [462, "items"], [514, "berries"], [582, "tms"], [690, "keyitems"], [758, "items"],
  [770, "keyitems"], [773, "items"], [813, "keyitems"], [814, "items"], [816, "medicine"],
  [820, "items"], [828, "balls"], [829, "items"], [874, "keyitems"], [875, "balls"],
  [876, "items"], [878, "keyitems"], [897, "berries"], [898, "items"], [900, "keyitems"]];

class ExpansionSave extends PartyOps {
  constructor(data, cfg) {
    super();
    Object.assign(this, { PARTY_CNT: 0x234, PARTY: 0x238, MONEY: 0x490, KEY_OFF: 0xAC, BOXES: 14, BOX_SLOTS: 30,
      SIGNATURE: 0x08012025, SHINY: 8, POCKET_LABELS: {}, POCKETS: [], is_unbound: false, cfru: null, game: EMERALD,
      nonstandard: true, shiny_threshold: 8, legacy: false, qty_max: 999, money_max: 999999 }, cfg);
    this.data = Uint8Array.from(data);
    this._orig = Uint8Array.from(data);
    const best = ExpansionSave._readSlots(this.data, this);
    if (best === null) throw new Error(`Not a valid ${this.NAME} save`);
    [this.counter, this.sections, this.slot_offset] = best;
    this.signature = this.SIGNATURE; this.hack = this.NAME;
    this.unfixable = []; this.bad_sections = []; this.detect_scores = {};
    this.sect_size = {};
    for (const sid of Object.keys(this.sections)) this.sect_size[sid] = this.CHUNK[sid];
    for (const sidS of Object.keys(this.sections)) {
      const sid = +sidS, off = this.sections[sid], stored = u16(this.data, off + 0xFF6);
      if (checksum(this.data, off, this.CHUNK[sid]) !== stored) this.bad_sections.push(sid);
    }
    const parts = [];
    for (let sid = this.STORAGE_FIRST; sid < this.N; sid++) { const o = this.sections[sid]; parts.push(this.data.slice(o, o + this.CHUNK[sid])); }
    const tot = parts.reduce((a, p) => a + p.length, 0);
    this._storage = new Uint8Array(tot);
    let p = 0; for (const x of parts) { this._storage.set(x, p); p += x.length; }
  }
  static _readSlots(data, cfg) {
    let best = null;
    for (let slot = 0; slot < cfg.SLOTS; slot++) {
      const ids = {}; let ok = true;
      for (let i = 0; i < cfg.N; i++) {
        const o = (slot * cfg.N + i) * SECTION_SIZE;
        if (o + SECTION_SIZE > data.length) return null;
        const sid = u16(data, o + 0xFF4), sig = u32(data, o + 0xFF8);
        if (sid >= cfg.N || sid in ids || sig !== (cfg.SIGNATURE === undefined ? 0x08012025 : cfg.SIGNATURE)) { ok = false; break; }
        ids[sid] = o;
      }
      if (ok) {
        const cnt = u32(data, ids[0] + 0xFFC);
        if (best === null || cnt > best[0]) best = [cnt, ids, slot * cfg.N * SECTION_SIZE];
      }
    }
    return best;
  }
  sec(sid) { return this.sections[sid]; }
  get legacy_() { return false; }
  _party_off() { return this._sb1(this.PARTY); }
  pocket_qty_max(pocket) { return pocket === "keyitems" ? 1 : 999; }
  _sb1(off) { return this.sections[1 + fdiv(off, this.SECTOR_DATA)] + (off % this.SECTOR_DATA); }
  _regions(off, slots) {
    const res = [];
    while (slots > 0) {
      const inside = off % this.SECTOR_DATA, fit = Math.min(slots, fdiv(this.SECTOR_DATA - inside, 4));
      res.push([this._sb1(off), fit]); off += fit * 4; slots -= fit;
    }
    return res;
  }
  get trainer_name() { return decodeText(this.data, this.sec(0), 7); }
  set trainer_name(s) { this.data.set(encodeText(s, 8), this.sec(0)); }
  get trainer_gender() { return this.data[this.sec(0) + 8]; }
  get trainer_id() { const o = this.sec(0); return [u16(this.data, o + 0xA), u16(this.data, o + 0xC)]; }
  get play_time() { const o = this.sec(0); return [u16(this.data, o + 0xE), this.data[o + 0x10], this.data[o + 0x11]]; }
  get security_key() { return u32(this.data, this.sec(0) + this.KEY_OFF); }
  get money() { return (u32(this.data, this._sb1(this.MONEY)) ^ this.security_key) >>> 0; }
  set money(v) { v = clamp(Math.trunc(v) || 0, 0, this.money_max); p32(this.data, this._sb1(this.MONEY), (v ^ this.security_key) >>> 0); }
  _mon(raw) { const m = new ExpansionMon(raw); m.SHINY_THRESHOLD = this.SHINY; return m; }
  get party_count() { return Math.min(this.data[this._sb1(this.PARTY_CNT)], 6); }
  set party_count(n) { this.data[this._sb1(this.PARTY_CNT)] = clamp(n, 0, 6); }
  party() {
    const o = this._sb1(this.PARTY), res = [], n = this.party_count;
    for (let i = 0; i < n; i++) res.push(this._mon(this.data.subarray(o + i * 100, o + i * 100 + 100)));
    return res;
  }
  set_party_member(i, mon) { this.data.set(mon.to_bytes(), this._sb1(this.PARTY) + i * 100); }
  _box_off(box, slot) { return 4 + (box * this.BOX_SLOTS + slot) * 80; }
  get trainer_id_u32() { const [a, b] = this.trainer_id; return a + b * 65536; }
  box_pokemon() {
    const res = new Map();
    for (let b = 0; b < this.BOXES; b++) for (let s = 0; s < this.BOX_SLOTS; s++) {
      const o = this._box_off(b, s), raw = this._storage.subarray(o, o + 80);
      if (raw[0x13] & 2) { const m = this._mon(raw); if (m.valid && m.species) res.set(b * 30 + s, m); }
    }
    return res;
  }
  set_box_pokemon(box, slot, mon) { this._storage.set(mon.to_bytes().subarray(0, 80), this._box_off(box, slot)); }
  delete_box_pokemon(box, slot) { const o = this._box_off(box, slot); this._storage.fill(0, o, o + 80); }
  pocket_capacity(pocket) { return this.POCKET_SPECS[pocket][1]; }
  bag(pocket) {
    const [off, slots] = this.POCKET_SPECS[pocket], key = this.security_key & 0xFFFF, items = [];
    for (const [a, n] of this._regions(off, slots)) for (let i = 0; i < n; i++) {
      const iid = u16(this.data, a + i * 4), qty = u16(this.data, a + i * 4 + 2);
      if (iid) items.push([iid, (qty ^ key) & 0xFFFF]);
    }
    return items;
  }
  set_bag(pocket, items) {
    const [off, slots] = this.POCKET_SPECS[pocket], key = this.security_key & 0xFFFF;
    let k = 0;
    for (const [a, n] of this._regions(off, slots)) for (let i = 0; i < n; i++) {
      const [iid, qty] = k < items.length ? items[k] : [0, 0];
      p16(this.data, a + i * 4, iid); p16(this.data, a + i * 4 + 2, (Math.min(qty, 0xFFFF) ^ key) & 0xFFFF);
      k++;
    }
  }
  item_filter(pocket) { return null; }
  fix_checksums() {
    let p = 0;
    for (let sid = this.STORAGE_FIRST; sid < this.N; sid++) {
      const o = this.sections[sid], n = this.CHUNK[sid];
      this.data.set(this._storage.subarray(p, p + n), o); p += n;
    }
    for (const sidS of Object.keys(this.sections)) {
      const sid = +sidS, off = this.sections[sid];
      p16(this.data, off + 0xFF6, checksum(this.data, off, this.CHUNK[sid]));
    }
  }
  to_bytes() { this.fix_checksums(); return Uint8Array.from(this.data); }
}
const IMPERIUM_CFG = { NAME: "Emerald Imperium", N: 28, SLOTS: 1, SECTOR_DATA: 4084,
  CHUNK: [2572, 4084, 4084, 4084, 2152].concat(new Array(12).fill(0), new Array(8).fill(4084), [1472, 0, 0]),
  STORAGE_FIRST: 17, PARTY_CNT: 0x234, PARTY: 0x238, MONEY: 0x490, KEY_OFF: 0x44, SHINY: 36, shiny_threshold: 36,
  POCKET_SPECS: { items: [0x560, 180], megastones: [0x830, 76], keyitems: [0x960, 60], balls: [0xA50, 50], tms: [0xB18, 252], berries: [0xF08, 70] },
  POCKETS: ["items", "megastones", "keyitems", "balls", "tms", "berries"], POCKET_LABELS: { megastones: "Mega Stones" } };
const HS_CFG = { NAME: "Pokémon Heart & Soul", N: 14, SLOTS: 2, SECTOR_DATA: 3968,
  CHUNK: [3892, 3968, 3968, 3968, 3856].concat(new Array(8).fill(3968), [2400]),
  STORAGE_FIRST: 5, PARTY_CNT: 0x238, PARTY: 0x23C, MONEY: 0x494, KEY_OFF: 0xAC,
  MAGIC_OFF: 0x10E0, MAGIC: 0xE8F828BC, SUPPORTED_VERSION: 5, SHINY: 8,
  POCKET_SPECS: { items: [0x564, 236], medicine: [0xE28, 92], balls: [0xA04, 39], tms: [0xAA0, 160], berries: [0xD20, 66], keyitems: [0x914, 60] },
  POCKETS: ["items", "medicine", "balls", "tms", "berries", "keyitems"], POCKET_LABELS: { medicine: "Medicine / battle items" } };
class ImperiumSave extends ExpansionSave {
  constructor(data) { super(data, IMPERIUM_CFG); }
  static detect(data) {
    if (data.length < IMPERIUM_CFG.N * SECTION_SIZE) return false;
    const best = ExpansionSave._readSlots(data, IMPERIUM_CFG);
    if (best === null) return false;
    return Object.keys(best[1]).every(sid => checksum(data, best[1][sid], IMPERIUM_CFG.CHUNK[sid]) === u16(data, best[1][sid] + 0xFF6));
  }
}
class HeartAndSoulSave extends ExpansionSave {
  constructor(data) { super(data, HS_CFG); }
  static pocket_of_item(idx) { let pk = null; for (const [first, name] of HS_POCKET_RUNS) if (first <= idx) pk = name; return pk; }
  item_filter(pocket) { return iid => iid > 0 && HeartAndSoulSave.pocket_of_item(iid) === pocket; }
  static detect(data) {
    const best = ExpansionSave._readSlots(data, HS_CFG);
    if (best === null) return false;
    const sec1 = best[1][1 + fdiv(HS_CFG.MAGIC_OFF, HS_CFG.SECTOR_DATA)], off = sec1 + (HS_CFG.MAGIC_OFF % HS_CFG.SECTOR_DATA);
    return u32(data, off) === HS_CFG.MAGIC;
  }
  get save_version() { return u16(this.data, this._sb1(0)); }
}

// ---------------------------------------------------------------- creating / converting
function unboundCompact(party) {
  const box = new Uint8Array(58);
  box.set(party.subarray(0, 0x1C), 0);
  box.set(party.subarray(0x20, 0x2B), 0x1C);
  let moves = 0n;
  for (let i = 0; i < 4; i++) moves |= BigInt(u16(party, 0x2C + i * 2) & 0x3FF) << BigInt(10 * i);
  setPacked40(box, 0x27, moves);
  box.set(party.subarray(0x38, 0x3E), 0x2C);
  box.set(party.subarray(0x44, 0x4C), 0x32);
  return box;
}
function unboundExpand(box) {
  const party = new Uint8Array(100);
  party.set(box.subarray(0, 0x1C), 0);
  party.set(box.subarray(0x1C, 0x27), 0x20);
  const moves = getPacked40(box, 0x27);
  for (let i = 0; i < 4; i++) p16(party, 0x2C + i * 2, Number((moves >> BigInt(10 * i)) & 0x3FFn));
  party.set(box.subarray(0x2C, 0x32), 0x38);
  party.set(box.subarray(0x32, 0x3A), 0x44);
  party[0x55] = 0xFF;
  return party;
}
const defaultRng = {
  bits32() { return Math.floor(Math.random() * 4294967296) >>> 0; },
  randrange(n) { return Math.floor(Math.random() * n); },
};
function makeNewMon(save, rom, species, level, nickname, rng) {
  level = level === undefined ? 5 : level; rng = rng || defaultRng;
  const [tid, sid] = save.trainer_id, otid = (tid | (sid << 16)) >>> 0, pid = rng.bits32();
  const info = rom ? rom.speciesInfo(species) : null;
  const base = info ? info.base : [50, 50, 50, 50, 50, 50];
  const growth = info && info.growth < 6 ? info.growth : 0;
  level = clamp(level, 1, 100);
  if (nickname === undefined || nickname === null) nickname = rom ? rom.species(species) : `#${species}`;
  const c = new Uint8Array(100);
  p32(c, 0, pid); p32(c, 4, otid);
  c.set(encodeText(nickname, 10), 8);
  c[18] = 2; c[19] = 2;
  c.set(encodeText(save.trainer_name, 8).subarray(0, 7), 20);
  p16(c, 0x20, species);
  p32(c, 0x24, expForLevel(growth, level));
  c[0x29] = 70;
  [33, 0, 0, 0].forEach((mv, i) => {
    p16(c, 0x2C + i * 2, mv);
    c[0x34 + i] = ((rom && mv ? rom.movePP(mv) : 0) || (mv ? 35 : 0));
  });
  let iv = 0;
  for (let i = 0; i < 6; i++) iv = (iv | (rng.randrange(32) << (5 * i))) >>> 0;
  p32(c, 0x48, iv);
  c[0x45] = 0;
  const gcode = { [RS]: 1, [FRLG]: 4, [EMERALD]: 3 }[save.game !== undefined ? save.game : EMERALD] || 3;
  let origins = level | (gcode << 7) | ((save.trainer_gender & 1) << 15);
  c[0x54] = level; c[0x55] = 0xFF;
  const isUnbound = !!save.cfru, isExp = save instanceof ExpansionSave;
  let mon;
  if (isUnbound) {
    c[0x2A] = 3;
    p16(c, 0x46, origins);
    mon = new UnboundPartyMon(c);
    mon.SHINY_THRESHOLD = save.shiny_threshold;
  } else {
    const Cls = isExp ? ExpansionMon : Pokemon;
    mon = new Cls(new Uint8Array(100));
    mon.pid = pid; mon.otid = otid;
    mon.raw.set(c.subarray(0, 32), 0);
    mon.raw.set(c.subarray(80, 100), 80);
    mon.nickname_raw = c.slice(8, 18);
    mon.ot_raw = c.slice(20, 27);
    if (isExp) { mon.SHINY_THRESHOLD = save.SHINY; p16(c, 0x2A, 1); }
    else origins |= 4 << 11;
    p16(c, 0x46, origins);
    for (const [ch, a] of [["G", 0x20], ["A", 0x2C], ["E", 0x38], ["M", 0x44]]) mon.blocks[ch].set(c.subarray(a, a + 12));
    if (isExp) mon.nickname = nickname;
  }
  mon.recalc_stats(base);
  return mon;
}
function toBoxBytes(save, mon) {
  if (save.cfru) return (mon.SIZE === 100 || mon.is_party) ? unboundCompact(mon.to_bytes()) : mon.to_bytes().subarray(0, 58);
  return mon.to_bytes().subarray(0, 80);
}
function loadSave(data, game) {
  data = Uint8Array.from(data);
  if (game === undefined) game = null;
  if (game === "Imperium") return new ImperiumSave(data);
  if (game === "HeartAndSoul") return new HeartAndSoulSave(data);
  if (game === null) {
    for (const cls of [ImperiumSave, HeartAndSoulSave]) {
      try { if (cls.detect(data)) return new cls(data); } catch (e) { /* try next */ }
    }
  }
  return new SaveFile(data, game);
}

const G3 = { u16, u32, p16, p32, sha1hex, decodeText, encodeText, lz77Decompress, isText, RomInfo, SaveFile,
  ExpansionSave, ImperiumSave, HeartAndSoulSave, Pokemon, ExpansionMon, UnboundMon, UnboundPartyMon, UnboundBoxMon,
  NATURES, STAT_NAMES, GROWTH_NAMES, natureEffect, calcStats, expForLevel, levelFromExp, genderOf, isShinyPid, solvePid,
  checksum, makeNewMon, loadSave, unboundCompact, unboundExpand, fallbackSpecies, fallbackItem, fallbackMove,
  UNBOUND, RADICAL_RED, EMERALD_LEGACY, RS, FRLG, EMERALD, SECTION_DATA_SIZE, SIGNATURE, UNBOUND_SIGNATURES, SECTION_SIZE,
  UNBOUND_BOXES, UNBOUND_BAG };
if (typeof module !== "undefined" && module.exports) module.exports = G3; else root.G3 = G3;
})(typeof self !== "undefined" ? self : this);
