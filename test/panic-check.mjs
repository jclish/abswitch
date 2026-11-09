#!/usr/bin/env node
// panic-check: /panic must leave A on air whenever it is pressed during a TAKE (ruling 2026-11-09).
//   node test/panic-check.mjs            (takectl must NOT already be running)
// From PGM=A, three rounds: /take (dissolve to B), then /panic 0, 200 and 600 ms after the /take
// request was sent. Each must end with MASTER's live slot on A, takectl pgm=A, TALLY A lit and B
// dark, no lastError. A 30 ms sampler logs the switcher slot, its per-slot codes and takectl's pgm.
// Then, ruled 2026-11-09 (CHANGES 11 and 12) and asserted the same way: /take and /panic sent
// together (the TAKE must yield: answer ok:false and send nothing that sticks), and /panic 200 ms
// into a dissolve started OUTSIDE takectl (busyUntil knows nothing of it; panic must loop on the
// switcher's live state).
// COUNTER, if present (bench build only), is switched off for the run (the guard refuses /take) and restored after, with TALLY,
// the live slot and the shows. TAKECTL_DIR=<dir> runs another takectl.mjs (+ its config) and writes
// to <dir>/out: used to run the same rounds against the takectl from before this ruling.
import { spawn } from "node:child_process";
import { mkdirSync, openSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.TAKECTL_DIR || dirname(HERE);
const OUT = process.env.TAKECTL_DIR ? join(ROOT, "out") : HERE;
mkdirSync(OUT, { recursive: true });
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
const sw = await layer("M", "AB Switcher");
const swRead = async () => {
  const a = (await j(`${B}/documents/${D.M}/layers/${sw.id}`)).data.attributes;
  const ov = a["output-values"];
  return { slot: a["input-values"].tvGroup_Hidden_Inputs__currentLiveSource, c1: ov.tvOut_tvIn_VideoSourceAImageTallyState, c2: ov.tvOut_tvIn_VideoSourceBImageTallyState };
};
const setLayer = (r, l, on) => !l ? null : j(`${B}/documents/${D[r]}/layers/${l.id}/${on ? "setLive" : "setOff"}`);
const tallies = async () => ({ A: (await layer("A", "TALLY")).attributes["live-state"], B: (await layer("B", "TALLY")).attributes["live-state"] });

// --- remember; COUNTER off so /take is allowed
const was = { counter: {}, tally: {}, slot: (await swRead()).slot };
for (const r of ["A", "B"]) { was.counter[r] = (await layer(r, "COUNTER"))?.attributes["live-state"] ?? "absent"; was.tally[r] = (await layer(r, "TALLY")).attributes["live-state"]; }
for (const r of ["A", "B"]) await setLayer(r, await layer(r, "COUNTER"), false);
await sleep(500);

const logFd = openSync(join(OUT, "takectl-panic.log"), "w");
const tk = spawn("node", ["takectl.mjs"], { cwd: ROOT, stdio: ["ignore", logFd, logFd] });
let st = null;
for (let i = 0; i < 40 && !st; i++) { await sleep(250); st = await j(`${T}/state`).catch(() => null); }
await j(`${T}/panic`); await sleep(1500); // start every round from A

const sampler = (t0) => {
  const lines = []; let last = "", run = true;
  const done = (async () => {
    while (run) {
      const [s, k] = await Promise.all([swRead(), j(`${T}/state`).catch(() => null)]);
      const row = `slot ${s.slot} codes ${s.c1}/${s.c2} | takectl pgm=${k?.pgm} busy=${k?.busy}`;
      if (row !== last) { lines.push(`    +${String(Date.now() - t0).padStart(5)} ms  ${row}`); last = row; }
      await sleep(30);
    }
  })();
  return { lines, stop: async () => { run = false; await done; } };
};

const round = async (label, panicAt, opts = {}) => {
  const t0 = Date.now();
  const smp = sampler(t0);
  let take;
  if (opts.outside) { await j(`${B}/documents/${D.M}/layers/${sw.id}/signals/tvGroup_Control__Dis_2_TypeSignal`); take = { outside: "Dis_2 fired at MASTER directly" }; }
  else if (opts.concurrent) take = j(`${T}/take`); // not awaited: /panic goes out while /take is in flight
  else take = await j(`${T}/take`);
  const tTake = Date.now() - t0;
  await sleep(Math.max(0, panicAt - (Date.now() - t0)));
  const tPanic = Date.now() - t0;
  const p = await j(`${T}/panic`);
  const tPanicDone = Date.now() - t0;
  take = await take;
  await sleep(Math.max(0, 2500 - (Date.now() - t0)));
  await smp.stop();
  const s = await swRead(), k = await j(`${T}/state`), tl = await tallies();
  say(`-- ${label}`);
  say(`    /take ${opts.outside ? "(outside)" : `returned at +${tTake} ms`}: ${JSON.stringify(take)}`);
  say(`    /panic sent at +${tPanic} ms, returned at +${tPanicDone} ms: ${JSON.stringify(p)}`);
  say(smp.lines.join("\n"));
  const ok = s.slot === 1 && k.pgm === "A" && tl.A === "live" && tl.B === "off" && !k.lastError && p.ok === true && (!opts.concurrent || take.ok === false);
  const summary = `MASTER slot=${s.slot} codes ${s.c1}/${s.c2}, takectl pgm=${k.pgm}, TALLY A=${tl.A} B=${tl.B}, lastError=${JSON.stringify(k.lastError)}`;
  if (opts.finding) say(`FINDING  ${label}: ${summary}  (${ok ? "ended on A" : "did NOT end on A"})`);
  else check(ok, `${label}: ${summary} (want slot 1, pgm A, TALLY A live / B off, no error, /panic ok${opts.concurrent ? ", /take refused" : ""})`);
  if (s.slot !== 1) { await j(`${T}/panic`); await sleep(1200); } // back to A for the next round
  await sleep(1000);
};

for (const at of [0, 200, 600]) await round(`/take, then /panic ${at} ms after the /take request`, at);
await round("11: /take and /panic sent together (/take not yet answered)", 0, { concurrent: true });
await round("12: Dis_2 fired outside takectl, /panic 200 ms later", 200, { outside: true });
tk.kill();

// --- restore
await sleep(300);
const cur = (await swRead()).slot;
if (cur !== was.slot) await j(`${B}/documents/${D.M}/layers/${sw.id}/signals/tvGroup_Control__Cut_${was.slot}_TypeSignal`);
for (const r of ["A", "B"]) {
  await setLayer(r, await layer(r, "COUNTER"), was.counter[r] === "live");
  await setLayer(r, await layer(r, "TALLY"), was.tally[r] === "live");
}
say(`restored: slot ${was.slot}, COUNTER ${JSON.stringify(was.counter)}, TALLY ${JSON.stringify(was.tally)}`);
say(fails ? `${fails} FAIL(S)` : "ALL PASS");
writeFileSync(join(OUT, "panic-check.txt"), out.join("\n") + "\n");
process.exit(fails ? 1 : 0);
