// Self-contained round-trip test of the engine (port of test_gen3.py). Run: node tests/test_engine.js
const assert = require("assert");
const g3 = require("../App/www/gen3lib.js");

let seed = 1;
const rnd = () => (seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff) & 255;
const rom = new Uint8Array(0x200000).map(rnd);
rom.set(Buffer.from("TESTHACK\0\0\0\0"), 0xA0); rom.set(Buffer.from("BPEE"), 0xAC);
const species = ["??????????", "BULBASAUR", "CUSTOMON", "FOOMIX", "ZETAWING"];
for (let n = 5; n < 420; n++) species.push("MON" + n);
species.forEach((n, i) => rom.set(g3.encodeText(n, 11), 0x100000 + i * 11));
const moves = ["-"]; for (let n = 1; n < 400; n++) moves.push("MOVE" + n);
moves.forEach((n, i) => rom.set(g3.encodeText(n, 13), 0x140000 + i * 13));
const items = ["????????", "MASTER BALL", "MEGA STONE X", "CUSTOM CANDY"]; for (let n = 4; n < 450; n++) items.push("ITEM" + n);
items.forEach((n, i) => {
  const o = 0x160000 + i * 44;
  rom.fill(0, o, o + 44); rom.set(g3.encodeText(n, 14), o);
  g3.p16(rom, o + 14, i); g3.p32(rom, o + 20, 0x08123456);
});
const info = new g3.RomInfo(rom);
assert.strictEqual(info.species(2), "CUSTOMON");
assert.strictEqual(info.move(5), "MOVE5");
assert.strictEqual(info.item(2), "MEGA STONE X");

const sav = new Uint8Array(0x1000 * 14 * 2 + 0x2000).fill(0xff);
const key = 0xDEADBEEF;
[[0, 5], [1, 4]].forEach(([slot, cnt]) => {
  const base = slot * 0xE000;
  for (let sid = 0; sid < 14; sid++) {
    const o = base + sid * 0x1000;
    sav.fill(0, o, o + 0xFF4);
    g3.p16(sav, o + 0xFF4, sid); g3.p16(sav, o + 0xFF6, 0); g3.p32(sav, o + 0xFF8, g3.SIGNATURE); g3.p32(sav, o + 0xFFC, cnt);
  }
  sav.set(g3.encodeText("ASH", 8), base);
  g3.p32(sav, base + 0xAC, key);
});
function makeMon(speciesId, pid, otid, nick, party) {
  const raw = new Uint8Array(party ? 100 : 80);
  g3.p32(raw, 0, pid); g3.p32(raw, 4, otid);
  raw.set(g3.encodeText(nick, 10), 8); raw.set(g3.encodeText("ASH", 7), 20);
  const p = new g3.Pokemon(raw);
  p.species = speciesId; p.held_item = 2; p.exp = 1000; p.set_move(0, 5);
  const out = p.to_bytes();
  if (party) out[84] = 42;
  return out;
}
const s1 = 0x1000;
g3.p32(sav, s1 + 0x234, 1);
sav.set(makeMon(2, 0x12345678, 0x0001E240, "BOBO", true), s1 + 0x238);
g3.p32(sav, s1 + 0x490, (5000 ^ key) >>> 0);
g3.p16(sav, s1 + 0x560, 3); g3.p16(sav, s1 + 0x562, 7 ^ (key & 0xFFFF));

const save = new g3.SaveFile(sav);
assert.strictEqual(save.game, g3.EMERALD);
assert.strictEqual(save.slot_offset, 0);
assert.strictEqual(save.trainer_name, "ASH");
assert.strictEqual(save.money, 5000);
const party = save.party();
assert.strictEqual(party.length, 1);
const m = party[0];
assert.strictEqual(info.species(m.species), "CUSTOMON");
assert.strictEqual(m.nickname, "BOBO"); assert.strictEqual(m.level, 42);
assert.deepStrictEqual(save.bag("items"), [[3, 7]]);

m.species = 3; m.set_move(1, 99);
save.set_party_member(0, m);
save.money = 123456;
save.set_bag("items", [[3, 99], [2, 5]]);
save.set_box_pokemon(2, 4, new g3.Pokemon(makeMon(4, 0xABCDEF01, 0x1111, "ZED", false)));
const out = save.to_bytes();

const s2 = new g3.SaveFile(out);
const p2 = s2.party()[0];
assert.strictEqual(info.species(p2.species), "FOOMIX"); assert.strictEqual(p2.moves[1], 99); assert.strictEqual(p2.level, 42);
assert.strictEqual(s2.money, 123456);
assert.deepStrictEqual(s2.bag("items"), [[3, 99], [2, 5]]);
const bx = s2.box_pokemon();
assert.ok(bx.has(2 * 30 + 4) && info.species(bx.get(2 * 30 + 4).species) === "ZETAWING" && bx.get(2 * 30 + 4).nickname === "ZED");
for (const sid of Object.keys(s2.sections)) {
  const o = s2.sections[sid], n = g3.SECTION_DATA_SIZE[sid];
  assert.strictEqual(g3.u16(out, o + 0xF6 + 0xF00), g3.checksum(out, o, n));
}
// identity changes keep consistency
const mm = s2.party()[0];
mm.set_identity(12, 1, true, 127);
assert.strictEqual(mm.nature, 12); assert.strictEqual(mm.is_shiny, true);
assert.strictEqual(g3.sha1hex(Buffer.from("abc")), "a9993e364706816aba3e25717850c26c9cd0d89d");
console.log("ALL OK");
