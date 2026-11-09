#!/usr/bin/env node
// bench5-check: bench protocol test 5, desync recovery, scripted (rerun 2026-11-09 on the
// switcher-truth takectl).
//   node test/bench5-check.mjs            (takectl must NOT already be running; MASTER on slot 1)
// Part 1, takectl running and idle: Cut_2, Dis_1, Dis_2, Cut_1 fired straight at MASTER's switcher
// (the same signals its UI buttons drive). After each, /state.pgm and both TALLY layers must follow
// within 500 ms of the switcher's live slot changing.
// Part 2: stop takectl with PGM=A, dissolve to B by hand (the datastore still says A; TALLY is wrong),
// restart takectl. It must come up pgm=B from the switcher, fix TALLY, and rewrite the datastore.
// Restores the live slot and TALLY. Writes test/bench5-check.txt and test/takectl-bench5*.log.
import { spawn } from "node:child_process";
import { openSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url)), ROOT = dirname(HERE);
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
const layer = async (r, n) => (await j(`${B}/documents/${D[r]}/layers`)).data.find((l) => l.attributes.name === n);
const sw = await layer("M", "AB Switcher");
const TL = { A: (await layer("A", "TALLY")).id, B: (await layer("B", "TALLY")).id };
const slot = async () => (await j(`${B}/documents/${D.M}/layers/${sw.id}`)).data.attributes["input-values"].tvGroup_Hidden_Inputs__currentLiveSource;
const tally = async (r) => (await j(`${B}/documents/${D[r]}/layers/${TL[r]}`)).data.attributes["live-state"];
const sig = (s) => j(`${B}/documents/${D.M}/layers/${sw.id}/signals/tvGroup_Control__${s}_TypeSignal`);
const store = () => fetch(`${B}/documents/${D.M}/datastores/abswitch-state`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
const was = { slot: await slot(), A: await tally("A"), B: await tally("B") };
if (was.slot !== 1) { console.error("needs MASTER on slot 1"); process.exit(2); }

const startTk = async (log) => {
  const tk = spawn("node", ["takectl.mjs"], { cwd: ROOT, stdio: ["ignore", openSync(join(HERE, log), "w"), openSync(join(HERE, log), "a")] });
  let st = null;
  for (let i = 0; i < 40 && !st; i++) { await sleep(250); st = await j(`${T}/state`).catch(() => null); }
  return tk;
};

// --- Part 1
let tk = await startTk("takectl-bench5.log");
await sleep(1000);
say(`start: slot ${await slot()}, takectl pgm=${(await j(`${T}/state`)).pgm}`);
for (const [s, want] of [["Cut_2", "B"], ["Dis_1", "A"], ["Dis_2", "B"], ["Cut_1", "A"]]) {
  const t0 = Date.now();
  await sig(s);
  let tSlot = null, tFollow = null;
  while (Date.now() - t0 < 3000 && tFollow == null) {
    const [sl, st, a, b] = await Promise.all([slot(), j(`${T}/state`), tally("A"), tally("B")]);
    const now = Date.now() - t0;
    if (tSlot == null && sl === (want === "A" ? 1 : 2)) tSlot = now;
    if (tSlot != null && st.pgm === want && a === (want === "A" ? "live" : "off") && b === (want === "B" ? "live" : "off")) tFollow = now;
    await sleep(30);
  }
  check(tSlot != null && tFollow != null && tFollow - tSlot <= 500,
    `outside ${s} → ${want}: switcher slot changed at +${tSlot} ms, /state pgm + both TALLYs followed at +${tFollow} ms (${tFollow != null && tSlot != null ? tFollow - tSlot : "-"} ms later; limit 500)`);
  await sleep(1500);
}

// --- Part 2
const st1 = await j(`${T}/state`), ds1 = await store();
say(`stopping takectl with pgm=${st1.pgm}; datastore pgm=${ds1?.pgm}`);
tk.kill();
await sleep(500);
await sig("Dis_2");
await sleep(1500);
say(`while takectl was down: Dis_2 by hand → slot ${await slot()}; datastore still pgm=${(await store())?.pgm}; TALLY A=${await tally("A")} B=${await tally("B")}`);
tk = await startTk("takectl-bench5-restart.log");
await sleep(800);
const st2 = await j(`${T}/state`), ds2 = await store(), a2 = await tally("A"), b2 = await tally("B");
check(st2.pgm === "B" && a2 === "off" && b2 === "live" && ds2?.pgm === "B",
  `restart: /state pgm=${st2.pgm} (switcher slot ${st2.switcher?.slot}), TALLY A=${a2} B=${b2}, datastore rewritten to pgm=${ds2?.pgm} (want B, off, live, B)`);
tk.kill();

// --- restore
await sleep(300);
await sig("Cut_1");
for (const r of ["A", "B"]) await j(`${B}/documents/${D[r]}/layers/${TL[r]}/${was[r] === "live" ? "setLive" : "setOff"}`);
await sleep(300);
say(`restored: slot ${await slot()}, TALLY A=${await tally("A")} B=${await tally("B")} (datastore left at pgm=${(await store())?.pgm}; takectl rewrites it at its next start)`);
say(fails ? `${fails} FAIL(S)` : "ALL PASS");
writeFileSync(join(HERE, "bench5-check.txt"), out.join("\n") + "\n");
process.exit(fails ? 1 : 0);
