#!/usr/bin/env node
// record-take: record ONE real takectl TAKE (A → B) on MASTER with both COUNTERs live, for the
// dissolve scrub (analyse-take.mjs). BENCH ONLY.
//   node test/record-take.mjs        (takectl must NOT already be running)
// - COUNTER is live, so takectl's COUNTER guard would refuse the TAKE. This run uses a temporary
//   config identical to takectl.config.json except "preflight": false (TAKECTL_CONFIG), as
//   decided 2026-11-09. The guard itself is proven separately (guard-tally-check.mjs).
// - Both stopwatches are Reset together just before, and their residual offset is read back from
//   the layers' tvOut_TimeString, so the midpoint counter delta can be corrected for it.
// Restores shows, COUNTER, TALLY and the switcher slot afterwards. Writes test/take-recording.json
// and test/take-recording-watch.txt (40 ms trace: both TALLY layers lit through the dissolve).
import { spawn } from "node:child_process";
import { openSync, readdirSync, readFileSync, statSync, writeFileSync, mkdtempSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url)), ROOT = dirname(HERE);
const B = "http://localhost:8989/api/v1", T = "http://localhost:8991";
const j = (u) => fetch(u).then((r) => r.json());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const secs = (s) => s.split(":").reduce((a, x) => a * 60 + Number(x), 0); // "875:25.43" -> s

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
const rec = (await j(`${B}/documents/${D.M}/output-destinations`)).data.find((o) => o.attributes.title === "Recording");

const was = { shows: {}, counter: {}, tally: {}, slot: await slot() };
for (const r of ["A", "B", "M"]) was.shows[r] = await live(r);
for (const r of ["A", "B"]) { was.counter[r] = (await layer(r, "COUNTER")).attributes["live-state"]; was.tally[r] = (await layer(r, "TALLY")).attributes["live-state"]; }

for (const r of ["A", "B", "M"]) if (was.shows[r] !== "live") await j(`${B}/documents/${D[r]}/setLive`);
await sleep(2500);
await j(`${B}/documents/${D.M}/output-destinations/${rec.id}/setOff`);
if ((await slot()) !== 1) { await j(`${B}/documents/${D.M}/layers/${sw.id}/signals/tvGroup_Control__Cut_1_TypeSignal`); await sleep(600); }
const C = { A: await layer("A", "COUNTER"), B: await layer("B", "COUNTER") };
for (const r of ["A", "B"]) if (C[r].attributes["live-state"] !== "live") await setLayer(r, C[r], true);
await sleep(500);

// Reset both stopwatches together, then read the residual offset A − B (both orders, 6 rounds).
const sig = (r, s) => j(`${B}/documents/${D[r]}/layers/${C[r].id}/signals/tvGroup_Control__${s}_TypeSignal`);
await Promise.all([sig("A", "Reset"), sig("B", "Reset")]);
await sleep(200);
// Reset also STOPS a stopwatch on 7.0b3 (both read 0:00.00 and froze), so start them together.
await Promise.all([sig("A", "Start"), sig("B", "Start")]);
await sleep(300);
const read = async (r) => (await j(`${B}/documents/${D[r]}/layers/${C[r].id}`)).data.attributes["output-values"].tvOut_TimeString;
const offs = [];
for (let i = 0; i < 6; i++) {
  const [a, b] = i % 2 ? (await Promise.all([read("B"), read("A")])).reverse() : await Promise.all([read("A"), read("B")]);
  offs.push({ a, b, aMinusB: +(secs(a) - secs(b)).toFixed(3) });
  await sleep(170);
}
const offset = +(offs.reduce((s, o) => s + o.aMinusB, 0) / offs.length).toFixed(3);
console.log(`stopwatches reset; A − B = ${offset} s (${offs.map((o) => o.aMinusB).join(", ")})`);
if (offs.every((o) => o.aMinusB === offs[0].aMinusB && secs(o.a) === secs(offs[0].a))) console.log("WARNING: counters did not advance after Reset");

// takectl with preflight off (temporary config; the real one is untouched).
const cfg = JSON.parse(readFileSync(join(ROOT, "takectl.config.json"), "utf8"));
cfg.preflight = false;
const cfgPath = join(mkdtempSync(join(tmpdir(), "takectl-")), "takectl.config.json");
writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
const logFd = openSync(join(HERE, "takectl-take-recording.log"), "w");
const tk = spawn("node", ["takectl.mjs"], { cwd: ROOT, env: { ...process.env, TAKECTL_CONFIG: cfgPath }, stdio: ["ignore", logFd, logFd] });
let st = null;
for (let i = 0; i < 40 && !st; i++) { await sleep(250); st = await j(`${T}/state`).catch(() => null); }
if (!st) throw new Error("takectl did not come up");

const movies = join(homedir(), "Movies");
const newest = () => readdirSync(movies).filter((f) => f.startsWith("PH-MASTER") && f.endsWith(".mov"))
  .map((f) => join(movies, f)).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
const before = newest();
// 40 ms trace of slot / tally / both TALLY layers through the recording (proves both TALLYs lit).
const watch = spawn("node", [join(HERE, "watch-state.mjs"), "6000", join(HERE, "take-recording-watch.txt")], { stdio: "ignore" });
await sleep(500);
const tRec = Date.now();
await j(`${B}/documents/${D.M}/output-destinations/${rec.id}/setLive`);
await sleep(1500);
const tTake = Date.now();
const take = await j(`${T}/take`);
await sleep(2500);
const stAfter = await j(`${T}/state`);
await j(`${B}/documents/${D.M}/output-destinations/${rec.id}/setOff`);
await sleep(1500);
await new Promise((r) => watch.on("exit", r));
tk.kill();
const clip = newest();

// restore
await sleep(300);
if ((await slot()) !== was.slot) await j(`${B}/documents/${D.M}/layers/${sw.id}/signals/tvGroup_Control__Cut_${was.slot}_TypeSignal`);
for (const r of ["A", "B"]) {
  await setLayer(r, await layer(r, "COUNTER"), was.counter[r] === "live");
  await setLayer(r, await layer(r, "TALLY"), was.tally[r] === "live");
}
for (const r of ["A", "B", "M"]) if (was.shows[r] !== "live") await j(`${B}/documents/${D[r]}/setOff`);

const result = { clip: clip === before ? null : clip, take, stateAfter: { pgm: stAfter.pgm, lastError: stAfter.lastError, tally: stAfter.tally },
  takeAfterRecordStartMs: tTake - tRec, counterOffsetAminusB_s: offset, offsetReads: offs, restored: was };
writeFileSync(join(HERE, "take-recording.json"), JSON.stringify(result, null, 1));
console.log(JSON.stringify(result, null, 1));
