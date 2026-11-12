#!/usr/bin/env node
// round4-offline-check: round 4 (watching A and B over mimoLive's socket) against test/mock-mimolive.mjs
// (nothing else on :8991 or :18989). A "hand" change is made straight through the mock's API, the way
// mimoLive's own window would make it: the socket carries both alike (test/round4-probe-*.txt).
//   node test/round4-offline-check.mjs
// L  live values (a document's running time, audio levels, a variant's output values) never warn; nor does
//    a Layer Set's "active" flag; nor does TALLY, through a TAKE or switched by hand.
// W  a layer switched on by hand in Program warns ("CHANGED IN MIMOLIVE: Slides on", first on the WARNING
//    line); a settings edit and a variant added by hand add to it; two edits of one layer 150 ms apart
//    (typing) are one change.
// O  takectl's own writes do not warn: a PUSH, and a hook's layer, which stays ignored until it reads "off";
//    a hand change to a different layer inside a PUSH's settle window still warns; one to the PUSH's own
//    layers inside it does not (as ruled: the named layers only).
// I  watchIgnoreLayers: a listed layer never warns; a name that matches no layer is a warning.
// D  dismiss clears and re-baselines: nothing comes back by itself; the next hand change warns again.
// C  TAKE, CUT, UNDO and PANIC clear it; PUSH does not; a TAKE with the warning up is not blocked.
// P  a hand change in Preview: no Program warning, UNDO off with that reason, and ~1 s after Preview
//    settles the look's thumbnail is taken again. A rehearsal (takectl's own hooks in Preview) is not "by hand".
// G  WATCH PGM off: nothing warns, nothing is kept for later; on again: the next change warns.
// N  the socket lost: NOT WATCHED within ~1 s; a change made meanwhile is found when it comes back.
// TAKECTL_DIR=<dir> runs another takectl.mjs (falsification).
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.TAKECTL_DIR || dirname(HERE);
const OUT = process.env.TAKECTL_DIR ? join(ROOT, "out") : HERE;
mkdirSync(OUT, { recursive: true });
const MP = 18989, MOCK = `http://localhost:${MP}`, MB = `${MOCK}/api/v1`, T = "http://localhost:8991";
const DOC = { A: "111", B: "222" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const json = async (u, o = {}) => { try { const r = await fetch(u, { ...o, signal: AbortSignal.timeout(o.timeout ?? 15000) }); const t = await r.text(); try { return { status: r.status, ...JSON.parse(t) }; } catch { return { status: r.status, text: t }; } } catch (e) { return { ok: false, error: String(e) }; } };
const g = (p) => json(T + p);
const out = [];
const say = (s) => { out.push(s); console.log(s); };
let fails = 0;
const check = (ok, what) => { if (!ok) fails++; say(`${ok ? "PASS" : "FAIL"}  ${what}`); };
const until = async (fn, ms, every = 100) => { const t = Date.now(); while (Date.now() - t < ms) { const v = await fn(); if (v) return v; await sleep(every); } return null; };
const dir = mkdtempSync(join(tmpdir(), "abswitch-r4-"));
const procs = [];
const stop = async (p) => { if (p && p.exitCode === null && p.signalCode === null) { const w = new Promise((r) => p.once("exit", r)); p.kill(); await w; } };
const stopAll = async () => { for (const p of procs.splice(0).reverse()) await stop(p); };
const baseCfg = (o = {}) => {
  const c = JSON.parse(readFileSync(join(ROOT, "takectl.config.example.json"), "utf8"));
  for (const k of ["a", "b", "master"]) c[k].host = MOCK;
  c.a.documentName = "PH-A"; c.b.documentName = "PH-B"; c.master.documentName = "PH-MASTER"; c.master.sourceNameSafe = "SAFE Test Pattern";
  c.companion = { host: null };
  c.hooks = { "Speaker Wide": { post: [{ layer: "Lower Third", set: "live" }] } };
  return Object.assign(c, o);
};
let cfgFile = null;
const phase = async (cfg = baseCfg()) => {
  await stopAll();
  procs.push(spawn("node", [join(HERE, "mock-mimolive.mjs"), String(MP)], { stdio: "ignore" }));
  await sleep(500);
  const sub = mkdtempSync(join(dir, "p-"));
  cfgFile = join(sub, "takectl.config.json");
  writeFileSync(cfgFile, JSON.stringify(cfg, null, 2));
  procs.push(spawn("node", [join(ROOT, "takectl.mjs")], { env: { ...process.env, TAKECTL_CONFIG: cfgFile }, stdio: "ignore" }));
  const s = await until(async () => { const s = await g("/state"); return s.ready !== false && s.pgm ? s : null; }, 9000);
  await sleep(600); // the socket open and A and B read
  return s;
};
// "By hand": straight to the mock, as mimoLive's window would.
const layerId = async (role, name) => (await json(`${MB}/documents/${DOC[role]}/layers`)).data.find((l) => l.attributes.name === name).id;
const hand = async (role, name, on) => json(`${MB}/documents/${DOC[role]}/layers/${await layerId(role, name)}/${on ? "setLive" : "setOff"}`);
const handPut = async (role, name, iv) => json(`${MB}/documents/${DOC[role]}/layers/${await layerId(role, name)}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ "input-values": iv }) });
// Flip a layer by hand (whatever it reads now); returns "on" or "off". Used where a hook's Lower Third,
// ignored until it reads off by design, would make a hand change invisible.
const flip = async (role, name) => {
  const l = (await json(`${MB}/documents/${DOC[role]}/layers`)).data.find((x) => x.attributes.name === name);
  const on = !["live", "startup"].includes(l.attributes["live-state"]);
  await json(`${MB}/documents/${DOC[role]}/layers/${l.id}/${on ? "setLive" : "setOff"}`);
  return on ? "on" : "off";
};
const st = () => g("/state");
const change = async () => (await st()).watch?.change ?? null;
const quiet = async (ms) => { const t = Date.now(); while (Date.now() - t < ms) { if (await change()) return false; await sleep(100); } return true; }; // no warning for ms
const warned = (re, ms = 1500) => until(async () => { const c = await change(); return c && re.test(c.what) ? c : null; }, ms);
// Gone, read the moment the command returned: not shown (watch.change), and not kept for the document that has
// left the air (watch.offAir). The warning is hidden once its document leaves the air, so "not shown" alone would
// pass without the clear (the weak spot in the round 4 report).
const gone = (w) => !!w && !w.change && !w.offAir;
const said = (w) => `shown ${w?.change ? `"${w.change.what}"` : "nothing"}, kept off air ${w?.offAir ? `"${w.offAir.what}" for ${w.offAir.doc}` : "nothing"}`;
const idle = () => until(async () => { const s = await st(); return !s.busy && !s.switcher?.inFlight && !s.rehearsal ? s : null; }, 8000);

try {
  // ---- L: live values, a Layer Set's "active", TALLY
  let s = await phase();
  check(s && s.pgm === "A", `setup: takectl running on the mock, PGM ${s?.pgm}, PVW ${s?.pvw}`);
  s = await st();
  check(s.watch && s.watch?.on === true && s.watch?.watched === true, `L0. /state.watch: on ${s.watch?.on}, watched ${s.watch?.watched} (the socket open)`);
  check(await quiet(3000), "L1. 3 s of live values (running time, audio levels, a variant's output values): no warning");
  await json(`${MOCK}/mock/set-active?doc=111&name=${encodeURIComponent("Slides PiP")}`); await json(`${MOCK}/mock/set-active?doc=111&name=${encodeURIComponent("Speaker Wide")}`);
  check(await quiet(1000), "L2. a Layer Set's \"active\" flag flipped twice in Program (derived, ignored): no warning");
  await g("/pvw/layer-set?name=Speaker%20Wide"); await sleep(400);
  const tk = await g("/take"); await idle(); await sleep(400);
  s = await st();
  check(tk.ok && s.pgm === "B" && !s.watch?.change, `L3. TAKE to B (TALLY on in B, off in A; the hook's Lower Third in B): ${tk.ok ? "ok" : tk.error}, no warning`);
  await sleep(3200); // past takectl's own write window for TALLY
  await json(`${MOCK}/mock/set-layer?doc=222&name=TALLY&live=off`); await sleep(300); await json(`${MOCK}/mock/set-layer?doc=222&name=TALLY&live=live`);
  check(await quiet(1200), "L4. Program's TALLY switched off and on by hand, outside any write of takectl's: no warning (TALLY is takectl's)");

  // ---- W: hand changes in Program warn
  await hand("B", "Cam Wide", false);
  let c = await warned(/^Cam Wide off$/);
  s = await st();
  check(c && c.doc === "B" && c.n === 1 && /^CHANGED IN MIMOLIVE: Cam Wide off$/.test(s.warning?.split("; ")[0] ?? ""), `W1. Cam Wide switched off by hand in Program B: change "${c?.what}" (n ${c?.n}); WARNING line starts "${s.warning?.split("; ")[0]}"`);
  await sleep(700); // a new burst
  await handPut("B", "Slides", { tvIn_VideoSourceAName: "CAM 2" });
  await sleep(700);
  await json(`${MOCK}/mock/add-variant?doc=222&name=Slides`);
  c = await until(async () => { const x = await change(); return x && x.n >= 3 ? x : null; }, 1500);
  check(c && c.list.some((x) => /^Slides: Video Source A ?Name|^Slides: VideoSourceAName/i.test(x)) && c.list.includes("Slides: variant added") && c.what === "Cam Wide off",
    `W2. a setting edited and a variant added by hand add to it: n ${c?.n}, list ${JSON.stringify(c?.list)}; the header still names the first`);
  const n0 = c?.n ?? 0;
  await handPut("B", "Cam Wide", { tvIn_VideoSourceAName: "CAM 3" }); await sleep(150); await handPut("B", "Cam Wide", { tvIn_VideoSourceAName: "CAM 4" });
  await sleep(900);
  c = await change();
  check(c && c.n === n0 + 1 && c.list[c.list.length - 1] === "Cam Wide: VideoSourceAName", `W3. two edits of Cam Wide 150 ms apart (typing) are one change: n ${n0} → ${c?.n}, last "${c?.list?.[c.list.length - 1]}"`);

  // ---- C: PUSH does not clear; TAKE clears and is not blocked
  await g("/pvw/layer-set?name=Slides%20PiP"); await sleep(300);
  const nP = (await change())?.n;
  const pu = await g("/push"); await sleep(2000);
  c = await change();
  check(pu.ok && c && nP && c.n === nP, `C1. a PUSH with the warning up: ${pu.ok ? "ok" : pu.error}; the warning stays, nothing added (n ${nP} → ${c?.n})`);
  const tk2 = await g("/take"); let w0 = (await st()).watch; await idle();
  s = await st();
  check(tk2.ok && s.pgm === "A" && gone(w0) && gone(s.watch) && !/CHANGED IN MIMOLIVE/.test(s.warning ?? ""), `C2. TAKE with the warning up: ${tk2.ok ? "ok (not blocked)" : tk2.error}; gone as the TAKE returned (${said(w0)}; PGM ${s.pgm})`);

  // ---- O: takectl's own writes
  await g("/pvw/layer-set?name=Speaker%20Wide"); await sleep(400);
  const pu2 = await g("/push");
  check(pu2.ok && await quiet(3500), `O1. a PUSH ("Speaker Wide" onto A: Cam Wide on, Slides off) does not warn (3.5 s): ${pu2.ok ? "ok" : pu2.error}`);
  // a hook: TAKE to B's "Speaker Wide" runs the post-hook Lower Third in B
  await g("/pvw/layer-set?name=Speaker%20Wide"); await hand("B", "Lower Third", false); await sleep(800);
  await g("/take"); await idle();
  await until(async () => (await json(`${MB}/documents/222/layers`)).data.find((l) => l.attributes.name === "Lower Third")?.attributes["live-state"] === "live", 3000);
  check(await quiet(3500), "O2. the post-hook brings the Lower Third in on B: no warning (3.5 s, past the 3 s write window)");
  await json(`${MOCK}/mock/set-layer?doc=222&name=${encodeURIComponent("Lower Third")}&live=off`); // as a lower third with a set duration ends itself
  check(await quiet(1500), "O3. the hook's Lower Third ends by itself: no warning (ignored until it reads off)");
  await hand("B", "Lower Third", true);
  c = await warned(/^Lower Third on$/);
  check(!!c, `O4. having read off, it is watched again: switched on by hand → "${c?.what}"`);
  await g("/watch/dismiss"); await hand("B", "Lower Third", false); await sleep(800); await g("/watch/dismiss");
  // a hand change inside a PUSH's settle window
  await g("/pvw/layer-set?name=Slides%20PiP"); await sleep(400);
  const pp = g("/push"); await sleep(60); await hand("B", "Lower Third", true); await pp;
  c = await warned(/^Lower Third on$/, 2500);
  await sleep(1500);
  const c2 = await change();
  check(c && c2 && c2.n === 1, `O5. a hand change to a different layer (Lower Third) 60 ms into a PUSH's settle window still warns: "${c?.what}"; the PUSH's own layers add nothing (n ${c2?.n})`);
  await g("/watch/dismiss"); await hand("B", "Lower Third", false); await sleep(800); await g("/watch/dismiss");
  await g("/pvw/layer-set?name=Speaker%20Wide"); await sleep(400);
  const pp2 = g("/push"); await sleep(60); await hand("B", "Slides", true); await pp2; // Slides is one of the PUSH's own layers
  check(await quiet(2500), "O6. a hand change to one of the PUSH's own layers inside its window is not flagged (as ruled: the named layers only)");
  await hand("B", "Slides", false); await sleep(800); await g("/watch/dismiss");

  // ---- D: dismiss
  await hand("B", "Cam Wide", false);
  c = await warned(/^Cam Wide off$/);
  const dm = await g("/watch/dismiss");
  s = await st();
  check(c && dm.ok && dm.accepted === 1 && !s.watch?.change, `D1. dismiss: accepted ${dm.accepted}, cleared`);
  check(await quiet(2000), "D2. Program as it is now is the new baseline: nothing comes back by itself (2 s, live values flowing)");
  await hand("B", "Cam Wide", true);
  c = await warned(/^Cam Wide on$/);
  check(!!c, `D3. the next hand change warns again: "${c?.what}"`);

  // ---- C: CUT, UNDO, PANIC clear
  const cu = await g("/cut"); w0 = (await st()).watch; await idle();
  s = await st();
  check(cu.ok && gone(w0) && gone(s.watch), `C3. CUT clears it: gone as the CUT returned (${said(w0)}; PGM ${s.pgm})`);
  await hand(s.pgm, "Slides", true); c = await warned(/^Slides on$/);
  const un = await g("/undo"); w0 = (await st()).watch; await idle();
  s = await st();
  check(c && un.ok && gone(w0) && gone(s.watch), `C4. UNDO clears it: ${un.ok ? "ok" : un.error}; gone as the UNDO returned (${said(w0)}; PGM ${s.pgm})`);
  const f5 = await flip(s.pgm, "Cam Wide"); c = await warned(new RegExp(`^Cam Wide ${f5}$`));
  const pn = await g("/panic"); w0 = (await st()).watch; await idle();
  s = await st();
  check(c && pn.ok && gone(w0) && gone(s.watch) && s.pgm === "SAFE", `C5. PANIC clears it ("${c?.what}"; PANIC ${pn.ok ? "ok" : pn.error}; gone as PANIC returned: ${said(w0)}; PGM ${s.pgm})`);
  await g("/take"); await idle(); // out of SAFE
  await sleep(1500); // its post-hook (Lower Third) has run
  for (const r of ["A", "B"]) for (const n of ["Lower Third"]) await hand(r, n, false);
  for (const r of ["A", "B"]) await json(`${MB}/documents/${DOC[r]}/layer-sets/${(await json(`${MB}/documents/${DOC[r]}/layer-sets`)).data.find((x) => x.attributes.name === "Speaker Wide").id}/recall`);
  await sleep(1000); await g("/watch/dismiss");

  // ---- P: Preview by hand
  s = await st();
  await g(`/pvw/layer-set?name=${encodeURIComponent("Slides PiP")}`); await sleep(400);
  await g("/take"); await idle(); await sleep(300);
  s = await st();
  const pvw = s.pvw, look = s.looks[pvw];
  check(s.undo?.available, `P0. after a TAKE, UNDO is offered (PVW ${pvw}, look "${look}")`);
  const before = s.thumbs?.[look] ?? 0;
  const fp = await flip(pvw, "Slides");
  const u = await until(async () => { const x = await st(); return !x.undo?.available && /by hand in mimoLive/.test(x.undo?.why ?? "") ? x : null; }, 1500);
  check(u && new RegExp(`^Preview changed since the TAKE: Slides ${fp}, by hand in mimoLive$`).test(u?.undo?.why) && u?.undo?.short === "Preview changed" && !u.watch?.change,
    `P1. Slides switched ${fp} by hand in Preview ${pvw}: UNDO off ("${u?.undo.why}", key "${u?.undo.short}"); no Program warning`);
  const ru = await g("/undo");
  check(ru.ok === false && /Preview changed/.test(ru.error ?? ""), `P2. /undo refused: ${ru.error}`);
  const th = await until(async () => { const x = await st(); return (x.thumbs?.[look] ?? 0) > before ? x.thumbs[look] : null; }, 3500);
  check(!!th, `P3. ~1 s after Preview settles, "${look}"'s thumbnail is taken again (${th ? `${th - before} ms newer` : "not refreshed"})`);
  await flip(pvw, "Slides"); await sleep(800);
  // a rehearsal: takectl's own hooks in Preview are not "by hand"
  await g(`/pvw/layer-set?name=${encodeURIComponent("Speaker Wide")}`); await sleep(300);
  await g("/take"); await idle(); await sleep(300);
  await g(`/pvw/layer-set?name=${encodeURIComponent("Speaker Wide")}`); await sleep(1500);
  const rh = await g("/hooks/rehearse");
  await sleep(600);
  s = await st();
  check(rh.ok && s.undo?.why && !/by hand/.test(s.undo?.why) && !s.watch?.change, `P4. REHEARSE HOOKS (takectl's own Lower Third in Preview): ${rh.ok ? "ok" : rh.error}; UNDO says "${s.undo?.why}", not "by hand"; no Program warning`);
  await until(async () => !(await st()).rehearsal, 6000); await sleep(800);

  // ---- G: WATCH PGM
  s = await st();
  const og = await g("/watch?on=0");
  await flip(s.pgm, "Cam Wide");
  check(og.ok && og.on === false && await quiet(1500), "G1. WATCH PGM off: a hand change in Program does not warn");
  const og2 = await g("/watch?on=1");
  check(og2.ok && og2.on === true && await quiet(1200), "G2. WATCH PGM on again: nothing from while it was off is kept");
  const fg = await flip(s.pgm, "Cam Wide");
  c = await warned(new RegExp(`^Cam Wide ${fg}$`));
  check(!!c, `G3. the next hand change warns: "${c?.what}"`);
  await g("/watch/dismiss");

  // ---- N: the socket lost
  await json(`${MOCK}/mock/socket?refuse=1&drop=1`);
  const nw = await until(async () => { const x = await st(); return x.watch?.watched === false ? x : null; }, 2000);
  check(nw && /NOT WATCHED: no events from mimoLive/.test(nw.warning ?? ""), `N1. the socket dropped (and refused): watched ${nw?.watch?.watched}; WARNING "${nw?.warning?.split("; ")[0]}"`);
  await hand((nw ?? (await st())).pgm, "Slides", true);
  check(await quiet(1500), "N2. a hand change while not watched cannot be seen yet");
  await json(`${MOCK}/mock/socket?refuse=0`);
  c = await until(async () => { const x = await st(); return x.watch?.watched && x.watch?.change ? x.watch?.change : null; }, 6000);
  check(c && /^Slides on, while not watched$/.test(c.what), `N3. the socket back: the document is read again and the change found: "${c?.what}"`);
  s = await st();
  check(s.watch?.watched && !/NOT WATCHED/.test(s.warning ?? ""), "N4. NOT WATCHED gone once the socket is back");

  // ---- I: the ignore list
  s = await phase(baseCfg({ watchIgnoreLayers: ["Slides", "Nope"] }));
  await hand(s.pgm, "Slides", false);
  check(await quiet(1500), `I1. watchIgnoreLayers ["Slides", "Nope"]: Slides switched off by hand in Program does not warn`);
  await hand(s.pgm, "Lower Third", true);
  c = await warned(/^Lower Third on$/);
  s = await st();
  check(!!c && /watchIgnoreLayers: "Nope" matches no layer in A or B/.test(s.warning ?? "") && !/"Slides"/.test(s.warning ?? ""), `I2. an unlisted layer still warns ("${c?.what}"); "Nope" is named as matching no layer`);
} catch (e) {
  check(false, `the run stopped: ${e.message}`);
} finally {
  await stopAll();
  say(fails ? `${fails} FAIL(S)` : "ALL PASS");
  writeFileSync(join(OUT, "round4-offline-check.txt"), out.join("\n") + "\n");
}
process.exit(fails ? 1 : 0);
