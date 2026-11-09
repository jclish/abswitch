#!/usr/bin/env node
// pvw-layerset-check: GET /pvw/layer-set/<name> recalls only in the PVW (green) document (UI brief 2026-11-09).
//   node test/pvw-layerset-check.mjs      (takectl must NOT already be running; MASTER on slot 1)
// 1. PGM A: /pvw/layer-set/Two Shot changes B's layers to Two Shot; A's layers are untouched.
// 2. An unknown name is refused, naming the PVW document; nothing changes anywhere.
// 3. Sent while a TAKE is busy: refused; nothing changes.
// 4. After the TAKE (PGM B): /pvw/layer-set/Two Shot now changes A only; B (on air) is untouched.
// Restores every layer's live state in A and B, COUNTER, TALLY and the live slot.
// Two-sided by construction: an implementation that always hits A, always B, or always PGM fails a phase.
import { spawn } from "node:child_process";
import { openSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url)), ROOT = process.env.TAKECTL_DIR || dirname(HERE);
const B = "http://localhost:8989/api/v1", T = "http://localhost:8991";
const j = (u) => fetch(u).then((r) => (r.status === 204 ? null : r.json()));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = [];
const say = (s) => { out.push(s); console.log(s); };
let fails = 0;
const check = (ok, what) => { if (!ok) fails++; say(`${ok ? "PASS" : "FAIL"}  ${what}`); };

const docs = (await j(`${B}/documents`)).data;
const id = (n) => docs.find((d) => d.attributes.name.replace(/\.tvshow$/, "") === n).id;
const D = { A: id("PH-A"), B: id("PH-B"), M: id("PH-MASTER") };
const sw = (await j(`${B}/documents/${D.M}/layers`)).data.find((l) => l.attributes.name === "AB Switcher");
const slot = async () => (await j(`${B}/documents/${D.M}/layers/${sw.id}`)).data.attributes["input-values"].tvGroup_Hidden_Inputs__currentLiveSource;
const layers = async (r) => Object.fromEntries((await j(`${B}/documents/${D[r]}/layers`)).data.map((l) => [l.attributes.name, { id: l.id, live: l.attributes["live-state"] }]));
const content = (ls) => Object.fromEntries(Object.entries(ls).filter(([n]) => n !== "TALLY" && n !== "COUNTER").map(([n, v]) => [n, v.live === "live" ? "live" : "off"]));
const activeSet = async (r) => (await j(`${B}/documents/${D[r]}/layer-sets`)).data.find((s) => s.attributes.active)?.attributes.name ?? null;
const snap = async () => ({ A: content(await layers("A")), B: content(await layers("B")) });
const same = (x, y) => JSON.stringify(x) === JSON.stringify(y);
const show = (c) => Object.entries(c).filter(([, v]) => v === "live").map(([n]) => n).join("+") || "(none live)";
if ((await slot()) !== 1) { console.error("needs MASTER on slot 1"); process.exit(2); }

const was = { A: await layers("A"), B: await layers("B"), slot: 1 };
const setLayer = (r, lid, on) => j(`${B}/documents/${D[r]}/layers/${lid}/${on ? "setLive" : "setOff"}`);
for (const r of ["A", "B"]) if (was[r].COUNTER) await setLayer(r, was[r].COUNTER.id, false);
const logPath = join(HERE, "takectl-pvw-layerset.log");
const tk = spawn("node", ["takectl.mjs"], { cwd: ROOT, stdio: ["ignore", openSync(logPath, "w"), openSync(logPath, "a")] });
let st = null;
for (let i = 0; i < 40 && !st; i++) { await sleep(250); st = await j(`${T}/state`).catch(() => null); }
const recall = (name) => j(`${T}/pvw/layer-set/${encodeURIComponent(name)}`);

try {
  say(`start: pgm=${st.pgm} pvw=${st.pvw}; layer sets offered: ${JSON.stringify(st.layerSets)}`);
  // 1
  let before = await snap();
  let r = await recall("Two Shot"); await sleep(800);
  let after = await snap();
  check(r.ok && r.pvw === "B" && same(after.A, before.A) && !same(after.B, before.B) && (await activeSet("B")) === "Two Shot",
    `1. PGM A: Two Shot → ${JSON.stringify(r)}; A ${show(before.A)} → ${show(after.A)} (unchanged), B ${show(before.B)} → ${show(after.B)}, B active set "${await activeSet("B")}"`);
  // 2
  before = after;
  r = await recall("Nope"); await sleep(500);
  after = await snap();
  check(r.ok === false && /Nope/.test(r.error) && /B/.test(r.error) && same(after, before), `2. unknown name refused: ${JSON.stringify(r.error)}; nothing changed: ${same(after, before)}`);
  // 3
  const tk1 = await j(`${T}/take`);
  r = await recall("Slides PiP");
  await sleep(1500);
  after = await snap();
  check(tk1.ok && r.ok === false && /transition|mid-transition/.test(r.error) && same(after, before), `3. during a TAKE: ${JSON.stringify(r.error)}; nothing changed: ${same(after, before)}`);
  // 4
  st = await j(`${T}/state`);
  before = await snap();
  r = await recall("Two Shot"); await sleep(800);
  after = await snap();
  check(st.pgm === "B" && r.ok && r.pvw === "A" && same(after.B, before.B) && !same(after.A, before.A) && (await activeSet("A")) === "Two Shot",
    `4. PGM B: Two Shot → ${JSON.stringify(r)}; B ${show(before.B)} → ${show(after.B)} (unchanged, on air), A ${show(before.A)} → ${show(after.A)}`);
} finally {
  await j(`${T}/take`).catch(() => null); await sleep(1500); // back to A on air
  tk.kill();
  for (const r of ["A", "B"]) for (const [n, v] of Object.entries(was[r])) await setLayer(r, v.id, v.live === "live");
  await sleep(800);
  const s = await slot();
  if (s !== 1) await j(`${B}/documents/${D.M}/layers/${sw.id}/signals/tvGroup_Control__Cut_1_TypeSignal`);
  const now = { A: await layers("A"), B: await layers("B") };
  const ok = ["A", "B"].every((r) => Object.entries(was[r]).every(([n, v]) => (now[r][n].live === "live") === (v.live === "live")));
  say(`restored: live slot ${await slot()}, every layer in A and B as before: ${ok}`);
  say(fails ? `${fails} FAIL(S)` : "ALL PASS");
  writeFileSync(join(HERE, "pvw-layerset-check.txt"), out.join("\n") + "\n");
}
process.exit(fails ? 1 : 0);
