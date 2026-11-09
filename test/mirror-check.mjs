// mirror-check: start takectl, recall a set on the PGM document, call /mirror, and confirm the
// PVW document now has the same set active. Restores Speaker Wide in both and the TALLY states.
// Use: node test/mirror-check.mjs test/takectl-mirror.log   (takectl must NOT already be running)
import { spawn } from "node:child_process";
import { openSync } from "node:fs";
import { homedir } from "node:os";
const B = "http://localhost:8989/api/v1", T = "http://localhost:8991";
const j = (u) => fetch(u).then((r) => r.json());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const LOG = process.argv[2];

const docs = (await j(`${B}/documents`)).data;
const id = { A: docs.find((d) => d.attributes.name.startsWith("PH-A")).id, B: docs.find((d) => d.attributes.name.startsWith("PH-B")).id };
const tallyOf = async (r) => (await j(`${B}/documents/${id[r]}/layers`)).data.find((l) => l.attributes.name === "TALLY");
const tally0 = { A: (await tallyOf("A")).attributes["live-state"], B: (await tallyOf("B")).attributes["live-state"] };
const sets = async (r) => (await j(`${B}/documents/${id[r]}/layer-sets`)).data;
const recall = async (r, n) => { const s = (await sets(r)).find((x) => x.attributes.name === n); await j(`${B}/documents/${id[r]}/layer-sets/${s.id}/recall`); };
const active = async (r) => (await sets(r)).filter((x) => x.attributes.active).map((x) => x.attributes.name);

const out = openSync(LOG, "w");
const tk = spawn("node", ["takectl.mjs"], { cwd: `${homedir()}/abswitch`, stdio: ["ignore", out, out] });
let st = null;
for (let i = 0; i < 40 && !st; i++) { await sleep(250); st = await j(`${T}/state`).catch(() => null); }
if (!st) { console.log("takectl did not come up"); tk.kill(); process.exit(1); }
const pgm = st.pgm, pvw = pgm === "A" ? "B" : "A";
console.log(`takectl up: pgm=${pgm} pvw=${pvw}`);
let fails = 0;
for (const n of ["Slides PiP", "Two Shot", "Full Slides"]) {
  await recall(pgm, n); await sleep(600);
  const r = await j(`${T}/mirror`); await sleep(600);
  const a = await active(pvw);
  const ok = r.ok && r.layerSet === n && a.length === 1 && a[0] === n;
  if (!ok) fails++;
  console.log(`  ${pgm} recalls "${n}" -> /mirror ${JSON.stringify(r)} -> ${pvw} active=${JSON.stringify(a)} ${ok ? "PASS" : "FAIL"}`);
}
for (const r of ["A", "B"]) await recall(r, "Speaker Wide");
tk.kill(); await sleep(500);
for (const r of ["A", "B"]) { const t = await tallyOf(r); if (t.attributes["live-state"] !== tally0[r]) await j(`${B}/documents/${id[r]}/layers/${t.id}/${tally0[r] === "live" ? "setLive" : "setOff"}`); }
await sleep(300);
console.log(`restored: Speaker Wide in A and B; TALLY A/B ${tally0.A}/${tally0.B} -> now ${(await tallyOf("A")).attributes["live-state"]}/${(await tallyOf("B")).attributes["live-state"]}; active A=${JSON.stringify(await active("A"))} B=${JSON.stringify(await active("B"))}`);
console.log(fails ? `${fails} FAIL(S)` : "ALL PASS");
process.exit(fails ? 1 : 0);
