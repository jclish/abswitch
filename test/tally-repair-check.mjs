#!/usr/bin/env node
// tally-repair-check: on 7.0b3 a TALLY layer told setOff ~15 ms after setLive stays in "shutdown"
// and then ignores setLive until it gets another setOff (found 2026-11-09 by panic-check round 0;
// reproduced with no takectl). takectl reads TALLY back 800 ms after each command and repairs it.
//   node test/tally-repair-check.mjs      (takectl must NOT already be running; MASTER on slot 1)
// 1. With PGM A, B's TALLY is forced into the stuck state straight through the API (retried: the
//    fault does not fire every time).
// 2. /take to B: B goes on air, and its TALLY must end up live (it would stay dark without the repair).
// Restores the live slot, COUNTER and TALLY. TAKECTL_DIR as in panic-check.
import { spawn } from "node:child_process";
import { mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.TAKECTL_DIR || dirname(HERE);
const OUT = process.env.TAKECTL_DIR ? join(ROOT, "out") : HERE;
mkdirSync(OUT, { recursive: true });
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
const slot = async () => (await j(`${B}/documents/${D.M}/layers/${sw.id}`)).data.attributes["input-values"].tvGroup_Hidden_Inputs__currentLiveSource;
const TL = { A: (await layer("A", "TALLY")).id, B: (await layer("B", "TALLY")).id };
const tst = async (r) => (await j(`${B}/documents/${D[r]}/layers/${TL[r]}`)).data.attributes["live-state"];
const tcmd = (r, on) => j(`${B}/documents/${D[r]}/layers/${TL[r]}/${on ? "setLive" : "setOff"}`);
if ((await slot()) !== 1) { console.error("needs MASTER on slot 1"); process.exit(2); }
const was = { counter: { A: (await layer("A", "COUNTER"))?.attributes["live-state"] ?? "absent", B: (await layer("B", "COUNTER"))?.attributes["live-state"] ?? "absent" }, tally: { A: await tst("A"), B: await tst("B") } };
for (const r of ["A", "B"]) { const c = await layer(r, "COUNTER"); if (c) await j(`${B}/documents/${D[r]}/layers/${c.id}/setOff`); }

const logPath = join(OUT, "takectl-tally-repair.log");
const tk = spawn("node", ["takectl.mjs"], { cwd: ROOT, stdio: ["ignore", openSync(logPath, "w"), openSync(logPath, "a")] });
let st = null;
for (let i = 0; i < 40 && !st; i++) { await sleep(250); st = await j(`${T}/state`).catch(() => null); }
try {
  await sleep(1200); // let takectl's own startup TALLY writes and their read-back settle
  // The 7.0b3 fault fires at random (1st try in one probe, 6th in the next): try up to 15 times,
  // with a 10–20 ms gap, to get the layer stuck.
  let stuck = "off", tries = 0;
  while (stuck !== "shutdown" && tries < 15) {
    tries++;
    await tcmd("B", true); await sleep(10 + 5 * (tries % 3)); await tcmd("B", false);
    await sleep(1500);
    stuck = await tst("B");
  }
  say(`1. B's TALLY after setLive, setOff 10–20 ms later, then 1.5 s: "${stuck}" (attempt ${tries}; pgm=${st.pgm})`);
  check(stuck === "shutdown", `1. the stuck state was produced ("shutdown")`);
  const r = await j(`${T}/take`);
  const t0 = Date.now(); let seen = [], last = "";
  while (Date.now() - t0 < 3000) { const s = await tst("B"); if (s !== last) { seen.push(`+${Date.now() - t0}:${s}`); last = s; } await sleep(50); }
  const k = await j(`${T}/state`);
  check(r.ok && (await slot()) === 2 && k.pgm === "B" && (await tst("B")) === "live" && (await tst("A")) === "off",
    `2. /take to B: slot ${await slot()}, pgm ${k.pgm}, B's TALLY ${seen.join(" ")} → "${await tst("B")}", A's TALLY "${await tst("A")}" (want slot 2, B live, A off)`);
  const lines = readFileSync(logPath, "utf8").split("\n").filter((l) => /TALLY reads|TALLY after repair/.test(l));
  say(`   takectl log: ${lines.join(" | ") || "(no repair lines)"}`);
} finally {
  await j(`${T}/take`).catch(() => null); await sleep(1500);
  tk.kill();
  if ((await slot()) !== 1) await j(`${B}/documents/${D.M}/layers/${sw.id}/signals/tvGroup_Control__Cut_1_TypeSignal`);
  for (const r of ["A", "B"]) {
    const c = await layer(r, "COUNTER");
    if (c) await j(`${B}/documents/${D[r]}/layers/${c.id}/${was.counter[r] === "live" ? "setLive" : "setOff"}`);
    if ((await tst(r)) === "shutdown") await tcmd(r, false); // never leave a stuck layer behind
    await sleep(100);
    await tcmd(r, was.tally[r] === "live");
  }
  await sleep(800);
  say(`restored: live slot ${await slot()}, COUNTER ${JSON.stringify(was.counter)}, TALLY A=${await tst("A")} B=${await tst("B")}`);
  say(fails ? `${fails} FAIL(S)` : "ALL PASS");
  writeFileSync(join(OUT, "tally-repair-check.txt"), out.join("\n") + "\n");
}
process.exit(fails ? 1 : 0);
