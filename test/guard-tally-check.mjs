#!/usr/bin/env node
// guard-tally-check: bench check for the COUNTER guard and the split TALLY (2026-11-09 brief).
//   node test/guard-tally-check.mjs        (takectl must NOT already be running; needs the watcher)
// 1. COUNTER live  -> doctor exits 1 naming COUNTER; /take refused; MASTER does not move.
// 2. COUNTER off   -> doctor exits 0; then /take, /take, /cut, /cut traced by watch-state.mjs at
//    40 ms (incoming TALLY lights at once, outgoing goes off only after verify), then the stale-
//    verify test: /take to B, /panic at PANIC_AT ms (after the dissolve lands, before verify runs).
// 3. FINDING, recorded not asserted: /panic 150 ms INTO a dissolve.
// TAKECTL_DIR=<dir> runs a different takectl.mjs (+ its config) and writes evidence to <dir>/out
// (used to falsify the stale-verify test against a copy with the guard removed).
// Starts all three shows (MASTER's Recording is switched off again). Restores shows, COUNTER,
// TALLY and the switcher slot to how it found them. Writes its evidence into test/.
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, openSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.TAKECTL_DIR || dirname(HERE);
const OUT = process.env.TAKECTL_DIR ? join(ROOT, "out") : HERE;
mkdirSync(OUT, { recursive: true });
const PANIC_AT = Number(process.env.PANIC_AT ?? 620);
const B = "http://localhost:8989/api/v1", T = "http://localhost:8991";
const j = (u) => fetch(u).then((r) => r.json());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = [];
const say = (s) => { out.push(s); console.log(s); };
let fails = 0;
const check = (ok, what) => { if (!ok) fails++; say(`${ok ? "PASS" : "FAIL"}  ${what}`); };

const docs = (await j(`${B}/documents`)).data;
const id = (n) => docs.find((d) => d.attributes.name.replace(/\.tvshow$/, "") === n).id;
const D = { A: id("PH-A"), B: id("PH-B"), M: id("PH-MASTER") };
const layer = async (r, n) => (await j(`${B}/documents/${D[r]}/layers`)).data.find((l) => l.attributes.name === n);
const live = async (r) => (await j(`${B}/documents/${D[r]}`)).data.attributes["live-state"];
const sw = await layer("M", "AB Switcher");
const slot = async () => (await j(`${B}/documents/${D.M}/layers/${sw.id}`)).data.attributes["input-values"].tvGroup_Hidden_Inputs__currentLiveSource;
const setLayer = (r, l, on) => j(`${B}/documents/${D[r]}/layers/${l.id}/${on ? "setLive" : "setOff"}`);
if (!(await layer("A", "COUNTER")) || !(await layer("B", "COUNTER"))) {
  console.error("This test needs the bench stopwatch COUNTER in PH-A and PH-B, which the release does not ship.\nAdd it back: BENCH_COUNTER=1 node documents/build-documents.mjs (README, Bench protocol, test 3). Delete it again before a show.");
  process.exit(2);
}

// --- remember, then bring the shows up
const was = { shows: {}, counter: {}, tally: {}, slot: await slot() };
for (const r of ["A", "B", "M"]) was.shows[r] = await live(r);
for (const r of ["A", "B"]) { was.counter[r] = (await layer(r, "COUNTER")).attributes["live-state"]; was.tally[r] = (await layer(r, "TALLY")).attributes["live-state"]; }
for (const r of ["A", "B", "M"]) if (was.shows[r] !== "live") await j(`${B}/documents/${D[r]}/setLive`);
await sleep(2500);
const rec = (await j(`${B}/documents/${D.M}/output-destinations`)).data.find((o) => o.attributes.title === "Recording");
await j(`${B}/documents/${D.M}/output-destinations/${rec.id}/setOff`);
for (const r of ["A", "B"]) await setLayer(r, await layer(r, "COUNTER"), true);
await sleep(500);

const doctor = (file) => {
  const p = spawnSync("node", ["takectl.mjs", "doctor"], { cwd: ROOT, encoding: "utf8" });
  writeFileSync(join(OUT, file), p.stdout + p.stderr);
  return { code: p.status, text: p.stdout + p.stderr };
};

// --- 1. COUNTER live
let d = doctor("doctor-counter-live.txt");
check(d.code === 1 && /live "COUNTER" layer/.test(d.text), `doctor with COUNTER live exits ${d.code} and names COUNTER (doctor-counter-live.txt)`);
const logFd = openSync(join(OUT, "takectl-guard.log"), "w");
const tk = spawn("node", ["takectl.mjs"], { cwd: ROOT, stdio: ["ignore", logFd, logFd] });
let st = null;
for (let i = 0; i < 40 && !st; i++) { await sleep(250); st = await j(`${T}/state`).catch(() => null); }
const s0 = await slot();
const r1 = await j(`${T}/take`);
await sleep(900);
check(r1.ok === false && /COUNTER/.test(r1.error), `/take with COUNTER live refused: ${JSON.stringify(r1.error)}`);
check((await slot()) === s0, `MASTER live slot unchanged by the refused take (slot ${s0})`);

// --- 2. COUNTER off
for (const r of ["A", "B"]) await setLayer(r, await layer(r, "COUNTER"), false);
await sleep(500);
d = doctor("doctor-real.txt");
check(d.code === 0, `doctor with COUNTER off exits ${d.code} (doctor-real.txt)`);

const watch = spawn("node", [join(HERE, "watch-state.mjs"), "14500", join(OUT, "tally-overlap-watch.txt")], { stdio: "ignore" });
await sleep(700);
const t0 = Date.now();
const mark = [];
const hit = async (route) => { const at = Date.now() - t0; const r = await j(`${T}${route}`); mark.push(`${String(at).padStart(6)}ms  ${route} -> ${JSON.stringify(r)}`); return r; };
// From PGM=A: dissolve to B and back, then cut to B and back (the TALLY overlap trace).
await hit("/take"); await sleep(2500);
await hit("/take"); await sleep(2500);
await hit("/cut"); await sleep(2000);
await hit("/cut"); await sleep(2000);
// Stale verify(): dissolve to B, then /panic (cut to A) once the dissolve has landed (~500 ms) but
// before the take's verify() runs (dissolveMs + settleMs = 750 ms). That verify() is stale; if it
// ran it would find B off program and leave "verify failed" in lastError.
await hit("/take"); await sleep(PANIC_AT); await hit("/panic"); await sleep(2000);
await new Promise((r) => watch.on("exit", r));
say("requests (ms from first request; the watcher's clock starts ~700 ms earlier):\n" + mark.join("\n"));

const st2 = await j(`${T}/state`);
const tA = (await layer("A", "TALLY")).attributes["live-state"], tB = (await layer("B", "TALLY")).attributes["live-state"];
const sl = await slot();
check(sl === 1 && st2.pgm === "A" && tA === "live" && tB === "off", `after /take + /panic at ${PANIC_AT} ms: MASTER slot=${sl}, pgm=${st2.pgm}, TALLY A=${tA} B=${tB} (want 1, A, live, off)`);
check(!st2.lastError, `stale verify() did not act: lastError=${JSON.stringify(st2.lastError)}`);

// --- 3. FINDING (pre-existing panic behaviour, not part of this brief)
await hit("/take"); await sleep(150); await hit("/panic"); await sleep(1500);
const fsl = await slot(), fst = await j(`${T}/state`);
say(`FINDING  /panic 150 ms into a dissolve to B: MASTER slot=${fsl} (1 = A), takectl pgm=${fst.pgm}, tally=${JSON.stringify(fst.tally)}`);
tk.kill();

// --- restore
await sleep(300);
const cur = await slot();
if (cur !== was.slot) await j(`${B}/documents/${D.M}/layers/${sw.id}/signals/tvGroup_Control__Cut_${was.slot}_TypeSignal`);
for (const r of ["A", "B"]) {
  await setLayer(r, await layer(r, "COUNTER"), was.counter[r] === "live");
  await setLayer(r, await layer(r, "TALLY"), was.tally[r] === "live");
}
for (const r of ["A", "B", "M"]) if (was.shows[r] !== "live") await j(`${B}/documents/${D[r]}/setOff`);
say(`restored: slot ${was.slot}, COUNTER ${JSON.stringify(was.counter)}, TALLY ${JSON.stringify(was.tally)}, shows ${JSON.stringify(was.shows)}`);
say(fails ? `${fails} FAIL(S)` : "ALL PASS");
writeFileSync(join(OUT, "guard-tally-check.txt"), out.join("\n") + "\n");
process.exit(fails ? 1 : 0);
