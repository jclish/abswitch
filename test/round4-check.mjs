#!/usr/bin/env node
// round4-check: round 4 on the real mimoLive (PH-A, PH-B, PH-MASTER open and live, MASTER's Recording off,
// takectl NOT running). A "hand" change goes straight to mimoLive's API: the socket carries it exactly as it
// carries a change made in mimoLive's window (test/round4-probe-ui-changes.txt, the title written back at
// 20:17:29). takectl runs with the hook "Speaker Wide" → Lower Third in, and watchIgnoreLayers ["Cam PiP"].
//   node test/round4-check.mjs
// R0 live values, idle: no warning; the socket is watched.
// R1 a layer switched on by hand in Program warns (and how fast /state says so).
// R2 a takectl PUSH does not warn; nor does a hook's Lower Third, which stays ignored (even switched off by
//    hand) until it reads "off"; after that a hand change to it warns.
// R3 a hand change to a different layer during a PUSH's settle window still warns.
// R4 a layer on the ignore list (Cam PiP) does not warn.
// R5 dismiss clears and re-baselines; the next hand change warns again.
// R6 TAKE clears (and is not blocked); CUT and UNDO clear too.
// R7 a hand change in Preview: no Program warning, UNDO off with that reason, the look's thumbnail taken again.
// Restores: slot 1, Lower Thirds / TALLY off, the looks as found, Slides / Cam PiP as their looks have them,
// duration 0.5 s, history and steps datastores emptied. TAKECTL_DIR=<dir> runs another takectl.mjs.
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.TAKECTL_DIR || dirname(HERE);
const OUT = process.env.TAKECTL_DIR ? join(ROOT, "out") : HERE;
mkdirSync(OUT, { recursive: true });
const PORT = Number(process.env.R4_PORT) || 8991; // another port lets it run beside the offline suites
const B = "http://localhost:8989/api/v1", T = `http://localhost:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const req = async (method, u, body, timeout = 15000) => { try { const r = await fetch(u, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeout) }); const t = await r.text(); try { return { status: r.status, ...JSON.parse(t) }; } catch { return { status: r.status, raw: t }; } } catch (e) { return { status: 0, error: String(e) }; } };
const j = (p) => req("GET", B + p);
const g = (p) => req("GET", T + p);
const out = [];
const say = (s) => { out.push(s); console.log(s); };
let fails = 0;
const check = (ok, what) => { if (!ok) fails++; say(`${ok ? "PASS" : "FAIL"}  ${what}`); };
const until = async (fn, ms, every = 100) => { const t = Date.now(); while (Date.now() - t < ms) { const v = await fn(); if (v) return v; await sleep(every); } return null; };

const docs = (await j("/documents")).data;
const D = Object.fromEntries(["PH-A", "PH-B", "PH-MASTER"].map((n) => [n.replace("PH-", "").replace("MASTER", "M"), docs.find((d) => d.attributes.name.replace(/\.tvshow$/, "") === n).id]));
const layer = async (r, name) => (await j(`/documents/${D[r]}/layers`)).data.find((l) => l.attributes.name === name);
const lstate = async (r, name) => (await layer(r, name))?.attributes["live-state"];
const setLayer = async (r, name, on) => { const l = await layer(r, name); if (l) await j(`/documents/${D[r]}/layers/${l.id}/${on ? "setLive" : "setOff"}`); };
// by hand: flip a layer whatever it reads now; returns "on" or "off"
const flip = async (r, name) => { const l = await layer(r, name); const on = !["live", "startup"].includes(l.attributes["live-state"]); await j(`/documents/${D[r]}/layers/${l.id}/${on ? "setLive" : "setOff"}`); return on ? "on" : "off"; };
const sets = async (r) => (await j(`/documents/${D[r]}/layer-sets`)).data;
const active = async (r) => (await sets(r)).find((s) => s.attributes.active && s.attributes.layers?.length)?.attributes.name ?? null;
const recall = async (r, name) => { const s = (await sets(r)).find((x) => x.attributes.name === name); await j(`/documents/${D[r]}/layer-sets/${s.id}/recall`); };
const sw = await layer("M", "AB Switcher");
const swIv = async () => (await j(`/documents/${D.M}/layers/${sw.id}`)).data.attributes["input-values"];
const slot = async () => (await swIv()).tvGroup_Hidden_Inputs__currentLiveSource;
const cut = (n) => j(`/documents/${D.M}/layers/${sw.id}/signals/tvGroup_Control__Cut_${n}_TypeSignal`);
for (const r of ["A", "B"]) for (const n of ["Lower Third", "Slides", "Cam PiP", "Cam Wide"]) if (!(await layer(r, n))) { console.error(`missing layer ${n} in ${r}: run documents/build-documents.mjs`); process.exit(2); }
const was = { A: await active("A"), B: await active("B") };

const dir = mkdtempSync(join(tmpdir(), "abswitch-r4real-"));
const real = JSON.parse(readFileSync(join(dirname(HERE), "takectl.config.json"), "utf8"));
let tk = null, cfgFile = null;
const startTk = async (over = {}) => {
  const sub = mkdtempSync(join(dir, "p-"));
  cfgFile = join(sub, "takectl.config.json");
  writeFileSync(cfgFile, JSON.stringify({ ...real, ...over, port: PORT }, null, 2));
  tk = spawn("node", [join(ROOT, "takectl.mjs")], { env: { ...process.env, TAKECTL_CONFIG: cfgFile }, stdio: "ignore" });
  return until(async () => { const s = await g("/state"); return s.ready !== false && s.pgm ? s : null; }, 12000, 250);
};
const stopTk = async () => { if (tk && tk.exitCode === null && tk.signalCode === null) { const w = new Promise((r) => tk.once("exit", r)); tk.kill(); await w; } tk = null; };
const st = () => g("/state");
const change = async () => (await st()).watch?.change ?? null;
const quiet = async (ms) => { const t = Date.now(); while (Date.now() - t < ms) { if (await change()) return false; await sleep(100); } return true; };
const warned = (re, ms = 2000, every = 100) => until(async () => { const c = await change(); return c && re.test(c.what) ? c : null; }, ms, every);
// Gone, read the moment the command returned: not shown, and not kept for the document that left the air
// (hidden once off air, so "not shown" alone would pass without the clear).
const gone = (w) => !!w && !w.change && !w.offAir;
const said = (w) => `shown ${w?.change ? `"${w.change.what}"` : "nothing"}, kept off air ${w?.offAir ? `"${w.offAir.what}" for ${w.offAir.doc}` : "nothing"}`;
const idle = () => until(async () => { const s = await st(); return !s.busy && !s.switcher?.inFlight && !s.rehearsal ? s : null; }, 10000);
const dismiss = async () => { await sleep(1800); await g("/watch/dismiss"); }; // after a fade has finished

try {
  if ((await slot()) !== 1) { await cut(1); await sleep(700); }
  await recall("A", "Speaker Wide"); await recall("B", "Two Shot");
  for (const r of ["A", "B"]) await setLayer(r, "Lower Third", false);
  await sleep(1500);
  let s = await startTk({ hooks: { "Speaker Wide": { post: [{ layer: "Lower Third", set: "live" }] } }, watchIgnoreLayers: ["Cam PiP"] });
  check(s && s.pgm === "A", `setup: takectl running, PGM ${s?.pgm} ("${s?.looks?.A}"), PVW ${s?.pvw} ("${s?.looks?.B}")`);
  await sleep(800);

  // ---- R0
  s = await st();
  check(s.watch?.on === true && s.watch?.watched === true, `R0a. WATCH PGM on, watched (socket open): on ${s.watch?.on}, watched ${s.watch?.watched}`);
  check(await quiet(5000), "R0b. 5 s idle on the real documents (audio levels, running times, the clock's time string): no warning");

  // ---- R1
  const t1 = Date.now();
  await setLayer("A", "Slides", true);
  let c = await warned(/^Slides on$/, 2000, 25);
  const ms1 = Date.now() - t1;
  s = await st();
  check(c && c.doc === "A" && /^CHANGED IN MIMOLIVE: Slides on$/.test(s.warning?.split("; ")[0] ?? ""), `R1. Slides switched on by hand in Program A: "${c?.what}" in /state ${c ? `within ${ms1} ms` : "never"}; WARNING line "${s.warning?.split("; ")[0]}"`);
  await setLayer("A", "Slides", false); await dismiss();

  // ---- R2: PUSH and a hook
  await g("/pvw/layer-set?name=Two%20Shot"); await sleep(400);
  const pu = await g("/push");
  check(pu.ok && await quiet(4000), `R2a. PUSH "Two Shot" onto A (Two Shot in, Cam Wide out): ${pu.ok ? "ok" : pu.error}; no warning (4 s)`);
  await g("/pvw/layer-set?name=Speaker%20Wide"); await sleep(600);
  const tk1 = await g("/take"); await idle();
  const ltIn = await until(async () => ["live", "startup"].includes(await lstate("B", "Lower Third")), 4000);
  check(tk1.ok && ltIn && await quiet(4000), `R2b. TAKE to B "Speaker Wide": the post-hook brings the Lower Third in (${ltIn ? "live" : "not seen"}); no warning (4 s, past the 3 s write window)`);
  await setLayer("B", "Lower Third", false); // as a lower third with a set duration ending itself
  check(await quiet(2500), "R2c. the hook's Lower Third switched off (as if it ended itself): no warning (ignored until it reads off)");
  await setLayer("B", "Lower Third", true);
  c = await warned(/^Lower Third on$/);
  check(!!c, `R2d. having read off, it is watched again: switched on by hand → "${c?.what}"`);
  await setLayer("B", "Lower Third", false); await dismiss();

  // ---- R3: inside a PUSH's settle window
  await g("/pvw/layer-set?name=Slides%20PiP"); await sleep(400);
  // 7.0b3 can leave a layer stuck in "shutdown", deaf to setLive (takectl repairs TALLY for this): start from off
  const lt0 = await until(async () => (await lstate("B", "Lower Third")) === "off" ? "off" : null, 3000) ?? await lstate("B", "Lower Third");
  const pp = g("/push"); await sleep(60); await setLayer("B", "Lower Third", true); const pr = await pp;
  const lt1 = await lstate("B", "Lower Third");
  c = await warned(/^Lower Third on$/, 2500);
  await sleep(2000);
  const c3 = await change();
  check(pr.ok && c && c3?.n === 1, `R3. PUSH "Slides PiP" onto B, and 60 ms later the Lower Third switched on by hand (it read "${lt0}" before, "${lt1}" after): "${c?.what}"; the PUSH's own layers added nothing (n ${c3?.n}: ${JSON.stringify(c3?.list)})`);
  await setLayer("B", "Lower Third", false); await dismiss();

  // ---- R4: the ignore list
  const f4 = await flip("B", "Cam PiP");
  const q4 = await quiet(2500);
  await flip("B", "Cam PiP");
  check(q4 && await quiet(2500), `R4. Cam PiP (watchIgnoreLayers) switched ${f4} and back by hand in Program B: no warning`);

  // ---- R5: dismiss
  const f5 = await flip("B", "Slides");
  c = await warned(new RegExp(`^Slides ${f5}$`));
  await sleep(1800); // the fade over
  const dm = await g("/watch/dismiss");
  s = await st();
  check(c && dm.ok && dm.accepted >= 1 && !s.watch?.change, `R5a. "${c?.what}" → dismiss: accepted ${dm.accepted}, cleared`);
  check(await quiet(3000), "R5b. B as it is now is the new baseline: nothing comes back by itself (3 s)");
  const f5b = await flip("B", "Slides");
  c = await warned(new RegExp(`^Slides ${f5b}$`));
  check(!!c, `R5c. the next hand change warns again: "${c?.what}"`);

  // ---- R6: TAKE, CUT, UNDO clear. (Each flip-back is made where it cannot touch the next check's Preview.)
  const tk2 = await g("/take"); let w0 = (await st()).watch; await idle();
  s = await st();
  check(tk2.ok && s.pgm === "A" && gone(w0) && gone(s.watch), `R6a. TAKE with the warning up: ${tk2.ok ? "ok (not blocked)" : tk2.error}; gone as the TAKE returned (${said(w0)}; PGM ${s.pgm})`);
  const f6 = await flip("A", "Slides"); c = await warned(new RegExp(`^Slides ${f6}$`));
  const cu = await g("/cut"); w0 = (await st()).watch; await idle();
  s = await st();
  check(c && cu.ok && gone(w0) && gone(s.watch) && s.pgm === "B", `R6b. CUT clears it ("${c?.what}" → PGM ${s.pgm}; as the CUT returned: ${said(w0)})`);
  const f6c = await flip("B", "Slides"); c = await warned(new RegExp(`^Slides ${f6c}$`)); // B's Slides back as its look has it
  const un = await g("/undo"); w0 = (await st()).watch; await idle();
  s = await st();
  check(c && un.ok && gone(w0) && gone(s.watch) && s.pgm === "A", `R6c. UNDO clears it ("${c?.what}" → ${un.ok ? `PGM ${s.pgm}` : un.error}; as the UNDO returned: ${said(w0)})`);
  await flip("A", "Slides"); await dismiss(); // A's Slides back as its look has it

  // ---- R7: Preview by hand
  await g("/pvw/layer-set?name=Speaker%20Wide"); await sleep(400);
  await g("/take"); await idle(); await sleep(1500);
  s = await st();
  const pvw = s.pvw, look = s.looks[pvw];
  check(s.undo?.available, `R7a. after a TAKE, UNDO is offered (Preview ${pvw}, look "${look}")`);
  const before = s.thumbs?.[look] ?? 0;
  const t7 = Date.now();
  const f7 = await flip(pvw, "Lower Third");
  const u = await until(async () => { const x = await st(); return !x.undo?.available && /by hand in mimoLive/.test(x.undo?.why ?? "") ? x : null; }, 2000, 50);
  check(u && new RegExp(`^Preview changed since the TAKE: Lower Third ${f7}, by hand in mimoLive$`).test(u.undo.why) && u.undo.short === "Preview changed" && !u.watch?.change,
    `R7b. Lower Third switched ${f7} by hand in Preview ${pvw}: UNDO off within ${u ? Date.now() - t7 : "—"} ms ("${u?.undo?.why}", key "${u?.undo?.short}"); no Program warning`);
  const th = await until(async () => { const x = await st(); return (x.thumbs?.[look] ?? 0) > before ? x.thumbs[look] : null; }, 5000);
  const thumbs = JSON.parse(readFileSync(join(dirname(cfgFile), "thumbs", "index.json"), "utf8"));
  check(th && thumbs[look]?.ts === th, `R7c. "${look}"'s thumbnail taken again ${th ? `${th - t7} ms after the change (the Lower Third's 0.5 s fade, then ~1 s settled)` : "never"}; thumbs/index.json agrees`);
  await flip(pvw, "Lower Third"); await sleep(1500);
} catch (e) {
  check(false, `the run stopped: ${e.message}`);
} finally {
  await stopTk();
  await req("PUT", `${B}/documents/${D.M}/layers/${sw.id}`, { "input-values": { tvIn_TransitionDuration: 0.5 } });
  if ((await slot()) !== 1) { await cut(1); await sleep(700); }
  for (const r of ["A", "B"]) { await setLayer(r, "TALLY", false); await setLayer(r, "Lower Third", false); }
  if (was.A) await recall("A", was.A);
  if (was.B) await recall("B", was.B);
  await req("PUT", `${B}/documents/${D.M}/datastores/abswitch-history`, { events: [] });
  await req("PUT", `${B}/documents/${D.M}/datastores/abswitch-steps`, { lists: {} });
  await sleep(1500);
  // 7.0b3: a layer left in "shutdown" answers only another setOff
  for (const r of ["A", "B"]) if ((await lstate(r, "Lower Third")) === "shutdown") { await setLayer(r, "Lower Third", false); await sleep(1200); }
  say(`restored: slot ${await slot()}, duration ${(await swIv()).tvIn_TransitionDuration} s, Lower Third ${await lstate("A", "Lower Third")}/${await lstate("B", "Lower Third")}, looks A "${await active("A")}" B "${await active("B")}"; datastores emptied`);
  say(fails ? `${fails} FAIL(S)` : "ALL PASS");
  writeFileSync(join(OUT, "round4-check.txt"), out.join("\n") + "\n");
}
process.exit(fails ? 1 : 0);
