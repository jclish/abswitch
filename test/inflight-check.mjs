#!/usr/bin/env node
// inflight-check: "any read with both per-slot codes at 30 is in flight and never a decision"
// (ruling 2026-11-09, CHANGES 12a), in the two places panic-check does not reach:
//   V. verify(): the switcher's own transition is lengthened to 2.0 s while takectl's config still
//      says 0.5 s, so verify() runs out of retries mid-dissolve. It must not decide (no "verify
//      failed"); the next settled read must decide: pgm B, TALLY A dark / B lit, lastError null.
//   D. doctor: 200 ms into a 4.0 s dissolve fired at MASTER directly, `takectl doctor` must decide
//      no PGM and say the switcher was mid-transition.
//   node test/inflight-check.mjs          (takectl must NOT already be running; MASTER on slot 1)
// Restores the transition duration, live slot, COUNTER and TALLY. TAKECTL_DIR as in panic-check.
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.TAKECTL_DIR || dirname(HERE);
const OUT = process.env.TAKECTL_DIR ? join(ROOT, "out") : HERE;
mkdirSync(OUT, { recursive: true });
const B = "http://localhost:8989/api/v1", T = "http://localhost:8991";
const j = (u, o) => fetch(u, o).then((r) => (r.status === 204 ? null : r.json()));
const put = (u, body) => j(u, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
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
const swIv = async () => (await j(`${B}/documents/${D.M}/layers/${sw.id}`)).data.attributes["input-values"];
const setDur = async (sec) => { await put(`${B}/documents/${D.M}/layers/${sw.id}`, { "input-values": { tvIn_TransitionDuration: sec } }); return (await swIv()).tvIn_TransitionDuration; };
const setLayer = async (r, n, on) => { const l = await layer(r, n); if (l) await j(`${B}/documents/${D[r]}/layers/${l.id}/${on ? "setLive" : "setOff"}`); };
const live = async (r, n) => (await layer(r, n))?.attributes["live-state"] ?? "absent";

const iv0 = await swIv();
if (iv0.tvGroup_Hidden_Inputs__currentLiveSource !== 1) { console.error("needs MASTER on slot 1"); process.exit(2); }
const was = { dur: iv0.tvIn_TransitionDuration, counter: { A: await live("A", "COUNTER"), B: await live("B", "COUNTER") }, tally: { A: await live("A", "TALLY"), B: await live("B", "TALLY") } };
for (const r of ["A", "B"]) await setLayer(r, "COUNTER", false);
const logPath = join(OUT, "takectl-inflight.log");
const tk = spawn("node", ["takectl.mjs"], { cwd: ROOT, stdio: ["ignore", openSync(logPath, "w"), openSync(logPath, "a")] });
let st = null;
for (let i = 0; i < 40 && !st; i++) { await sleep(250); st = await j(`${T}/state`).catch(() => null); }

try {
  // V. verify() mid-transition
  say(`switcher transition duration ${was.dur} s → ${await setDur(2.0)} s (takectl config still dissolveMs 500)`);
  await sleep(500);
  const r = await j(`${T}/take`);
  await sleep(1300);
  const mid = await j(`${T}/state`);
  say(`   +1.3 s, verify() done, dissolve still running: switcher ${JSON.stringify(mid.switcher)}, pgm=${mid.pgm}, lastError=${JSON.stringify(mid.lastError)}, TALLY A=${await live("A", "TALLY")} B=${await live("B", "TALLY")}`);
  check(r.ok && mid.lastError == null, `V. verify() at its last retry still saw 30/30 and decided nothing (lastError ${JSON.stringify(mid.lastError)})`);
  await sleep(2200);
  const end = await j(`${T}/state`), log = readFileSync(logPath, "utf8");
  const tA = await live("A", "TALLY"), tB = await live("B", "TALLY");
  check(end.pgm === "B" && end.switcher?.slot === 2 && tA === "off" && tB === "live" && end.lastError == null
    && /still mid-transition after 3 retries/.test(log) && /transition settled on a later read/.test(log),
    `V. the next settled read decided: pgm=${end.pgm}, slot ${end.switcher?.slot}, TALLY A=${tA} B=${tB}, lastError=${JSON.stringify(end.lastError)}; log: ${(log.match(/.*(mid-transition after 3 retries|settled on a later read|verify failed).*/g) || []).map((l) => l.trim()).join(" | ")}`);

  await j(`${T}/panic`); await sleep(2500); // back to A (a 2 s dissolve is not running now: one cut lands)

  // D. doctor mid-transition
  say(`switcher transition duration → ${await setDur(4.0)} s`);
  await sleep(300);
  await j(`${B}/documents/${D.M}/layers/${sw.id}/signals/tvGroup_Control__Dis_2_TypeSignal`);
  await sleep(200);
  const t0 = Date.now();
  const d = spawnSync("node", ["takectl.mjs", "doctor"], { cwd: ROOT, encoding: "utf8" });
  const text = d.stdout + d.stderr;
  writeFileSync(join(OUT, "doctor-mid-transition.txt"), text);
  const pgm = text.match(/"pgm": (null|"[AB]")/)?.[1];
  check(pgm === "null" && /SWITCHER: mid-transition/.test(text), `D. doctor 200 ms into a 4 s dissolve (ran ${Date.now() - t0} ms): pgm ${pgm}, ${/SWITCHER: mid-transition/.test(text) ? "said mid-transition" : "no mid-transition line"} (doctor-mid-transition.txt)`);
  await sleep(4500);
} finally {
  await setDur(was.dur);
  await j(`${T}/panic`).catch(() => null);
  await sleep(1500);
  tk.kill();
  for (const r of ["A", "B"]) { await setLayer(r, "COUNTER", was.counter[r] === "live"); await setLayer(r, "TALLY", was.tally[r] === "live"); }
  await sleep(500);
  const iv = await swIv();
  say(`restored: transition ${iv.tvIn_TransitionDuration} s, live slot ${iv.tvGroup_Hidden_Inputs__currentLiveSource}, COUNTER ${JSON.stringify(was.counter)}, TALLY ${JSON.stringify(was.tally)}`);
  say(fails ? `${fails} FAIL(S)` : "ALL PASS");
  writeFileSync(join(OUT, "inflight-check.txt"), out.join("\n") + "\n");
}
process.exit(fails ? 1 : 0);
