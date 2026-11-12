#!/usr/bin/env node
// safe-offline-check: the safe source for PANIC (ruling 2026-11-11), against test/mock-mimolive.mjs
// (slot 3 = "SAFE Test Pattern", slot 4 empty: cutting to it reads live slot 9, as on 7.0b3).
//   node test/safe-offline-check.mjs        (nothing else on :8991 or :18989)
// P  PANIC to SAFE 0, 200 and 600 ms after TAKE is pressed, under the stinger, during an outside dissolve:
//    slot 3 confirmed, pgm "SAFE", both TALLYs off, the TAKE target = the document Preview when pressed.
// T  TAKE and CUT out of SAFE to each document; no UNDO after; history marks them.
// R  in SAFE: PUSH, UNDO, MIRROR, steps push refused; a Layer Set button recalls into the target;
//    /safe/target moves Preview; refused outside SAFE.
// H  slot 3 and slot 4 selected outside takectl (signals sent straight to the switcher): SAFE, then
//    OTHER with a warning naming slot 9; commands as in SAFE; a TAKE out of OTHER.
// A  PANIC while SAFE is already on air: ok, no cut.
// N  no safe source configured: PANIC lands on A, doctor warns; not ready (A missing) with one: slot 3.
// Y  history: panics and takes out of SAFE logged, marked, never counted.
// K  hooks on a TAKE out of SAFE: document pre-hooks skipped, MASTER ones run, post-hooks run.
// S  setup: the safe source pre-selected from slot 3; A's source as safe → 400; doctor's safe checks.
// W  a switcher read sent just before PANIC that comes back after it (mock --slow-read=300) must not put
//    the roles back: /state stays SAFE. (Found on the real app: one TAKE out of SAFE went from A.)
//    W2: the same for an ordinary TAKE (A → B): /state stays B.
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const json = async (u, o = {}) => { try { const r = await fetch(u, { ...o, signal: AbortSignal.timeout(o.timeout ?? 15000) }); const t = await r.text(); try { return { status: r.status, ...JSON.parse(t) }; } catch { return { status: r.status, raw: t }; } } catch (e) { return { status: 0, error: String(e) }; } };
const g = (p) => json(T + p);
const post = (p, b) => json(T + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) });
const out = [];
const say = (s) => { out.push(s); console.log(s); };
let fails = 0;
const check = (ok, what) => { if (!ok) fails++; say(`${ok ? "PASS" : "FAIL"}  ${what}`); };
const until = async (fn, ms) => { const t = Date.now(); while (Date.now() - t < ms) { const v = await fn(); if (v) return v; await sleep(100); } return null; };
const dir = mkdtempSync(join(tmpdir(), "abswitch-safe-"));
const procs = [];
const stop = async (p) => { if (p && p.exitCode === null && p.signalCode === null) { const w = new Promise((r) => p.once("exit", r)); p.kill(); await w; } };
const stopAll = async () => { for (const p of procs.splice(0).reverse()) await stop(p); };
const baseCfg = (safe = "SAFE Test Pattern") => {
  const c = JSON.parse(readFileSync(join(ROOT, "takectl.config.example.json"), "utf8"));
  for (const k of ["a", "b", "master"]) c[k].host = MOCK;
  c.a.documentName = "PH-A"; c.b.documentName = "PH-B"; c.master.documentName = "PH-MASTER";
  c.master.sourceNameSafe = safe;
  c.companion = { host: null };
  return c;
};
let n = 0;
const startTk = async (cfg, file) => {
  const f = file ?? join(dir, `c${n++}.json`);
  if (cfg) writeFileSync(f, JSON.stringify(cfg, null, 2));
  procs.push(spawn("node", [join(ROOT, "takectl.mjs")], { env: { ...process.env, TAKECTL_CONFIG: f }, stdio: "ignore" }));
  return f;
};
const ready = () => until(async () => { const s = await g("/state"); return s.ready !== false && s.pgm ? s : null; }, 9000);
const phase = async (cfg = baseCfg(), ...flags) => {
  await stopAll();
  procs.push(spawn("node", [join(HERE, "mock-mimolive.mjs"), String(MP), ...flags], { stdio: "ignore" }));
  await sleep(500);
  await startTk(cfg);
  return ready();
};
const now = async () => (await json(`${MB}/mock/log`)).now;
const log = async (t0 = 0) => ((await json(`${MB}/mock/log`)).log ?? []).filter((e) => e.t >= t0);
const at = (L, re) => L.find((e) => re.test(e.what))?.t ?? null;
const all = (L, re) => L.filter((e) => re.test(e.what));
const fmt = (L, t0) => L.map((e) => `${e.t - t0}:${e.what}`).join(" | ");
const slot = async () => (await json(`${MB}/mock/state`)).slot;
const tally = async (doc) => (await json(`${MB}/documents/${doc}/layers`)).data?.find((l) => l.attributes.name === "TALLY")?.attributes["live-state"];
const tallies = async () => `${await tally(111)}/${await tally(222)}`;
const sig = async (k) => json(`${MB}/documents/333/layers/${(await json(`${MB}/documents/333/layers`)).data.find((l) => /videoswitcher/.test(l.attributes["composition-id"])).id}/signals/tvGroup_Control__${k}_TypeSignal`);
const st = () => g("/state");
// PANIC n ms after TAKE is pressed (the TAKE request is not awaited: it answers once its signal has gone)
const pressThenPanic = async (ms, route = "/take") => {
  const before = await st();
  const t0 = await now();
  const take = g(route);
  await sleep(ms);
  const pvwAtPress = (await st()).pvw;
  const p = await g("/panic");
  const tr = await take;
  await sleep(700);
  return { p, tr, before, pvwAtPress, s: await st(), slot: await slot(), tl: await tallies(), L: await log(t0), t0 };
};

try {
  // ================================================================ P: PANIC to SAFE
  let s = await phase();
  for (const ms of [0, 200, 600]) {
    if ((await st()).pgm !== "A") { await g("/safe/target?doc=A"); await g("/take"); await sleep(1000); }
    const x = await pressThenPanic(ms);
    check(x.p.ok && x.p.pgm === "SAFE" && x.slot === 3 && x.s.pgm === "SAFE" && x.tl === "off/off" && ["A", "B"].includes(x.s.pvw) && x.s.safe?.onAir,
      `P${ms}. PANIC ${ms} ms after TAKE → ${JSON.stringify({ ok: x.p.ok, pgm: x.p.pgm, rounds: x.p.rounds, ms: x.p.ms })}; slot ${x.slot}; TALLY A/B ${x.tl}; TAKE target ${x.s.pvw} (Preview at the press: ${x.pvwAtPress}); take → ${JSON.stringify(x.tr.error ?? x.tr.transition)}`);
  }
  // under the stinger
  s = await phase({ ...baseCfg(), stinger: true });
  let x = await pressThenPanic(200);
  check(x.p.ok && x.slot === 3 && !at(x.L, /MASTER cut 2/) && at(x.L, /STINGER setOff/) && /under the stinger; signal not sent/.test(x.tr.error ?? "") && x.tl === "off/off",
    `P-stinger. PANIC 200 ms into a stinger TAKE: B never cut (${JSON.stringify(x.tr.error)}); slot ${x.slot}; TALLY ${x.tl}; target ${x.s.pvw}; ${fmt(x.L, x.t0)}`);
  // during an outside dissolve
  s = await phase();
  let t0 = await now();
  await sig("Dis_2");
  await sleep(200);
  let p = await g("/panic");
  await sleep(700);
  let L = await log(t0);
  s = await st();
  check(p.ok && p.rounds >= 2 && (await slot()) === 3 && s.pgm === "SAFE" && s.pvw === "B" && (await tallies()) === "off/off",
    `P-outside. PANIC 200 ms into a dissolve to B started outside takectl → ${JSON.stringify({ ok: p.ok, rounds: p.rounds, ms: p.ms })}; slot ${await slot()}; target ${s.pvw}; ${fmt(L, t0)}`);

  // ================================================================ T: TAKE and CUT out of SAFE
  const outs = [];
  for (const [route, doc] of [["/take", "A"], ["/cut", "B"], ["/cut", "A"], ["/take", "B"]]) {
    if ((await st()).pgm !== "SAFE") { await g("/panic"); await sleep(400); }
    const tg = await g(`/safe/target?doc=${doc}`);
    const pv = (await st()).pvw;
    t0 = await now();
    const r = await g(route);
    await sleep(1100);
    L = await log(t0);
    s = await st();
    const want = doc === "A" ? 1 : 2;
    const tl = await tallies();
    const hist = (await g("/history")).log ?? [];
    outs.push(`${route.slice(1).toUpperCase()}→${doc}: slot ${await slot()}, pgm ${s.pgm}, TALLY ${tl}, ${r.transition}, UNDO "${s.undo?.why}", history ${JSON.stringify(hist.at(-1))}`);
    check(tg.ok && pv === doc && r.ok && (await slot()) === want && s.pgm === doc && tl === (doc === "A" ? "live/off" : "off/live") && r.transition === (route === "/take" ? "dissolve" : "cut") &&
      s.undo?.available === false && /came out of SAFE/.test(s.undo?.why ?? "") && hist.at(-1)?.safe === true && hist.at(-1)?.from === "SAFE",
      `T. ${outs.at(-1)}`);
  }

  // ================================================================ R: refusals and the target in SAFE
  await g("/panic"); await sleep(400);
  s = await st();
  const rs = { push: await g("/push"), undo: await g("/undo"), mirror: await g("/mirror"), steps: (await g("/steps/add"), await g("/steps/push?pace=instant")) };
  check(Object.values(rs).every((r) => r.ok === false && /SAFE is on air/.test(r.error ?? "")) && s.push?.available === false && s.undo?.available === false,
    `R1. in SAFE: ${Object.entries(rs).map(([k, r]) => `${k} → ${JSON.stringify(r.error)}`).join("; ")}`);
  await g("/safe/target?doc=A");
  t0 = await now();
  const rc = await g(`/pvw/layer-set/${encodeURIComponent("Slides PiP")}`);
  await g("/safe/target?doc=B");
  const s2 = await st();
  L = await log(t0);
  check(rc.ok && rc.pvw === "A" && at(L, /^PH-A recall Slides PiP$/) && !at(L, /^PH-B recall/) && s2.pvw === "B",
    `R2. Layer Set button with target A → recalled in ${rc.pvw} (${fmt(all(L, /recall/), t0)}); target → B: /state.pvw ${s2.pvw}`);
  await g("/safe/target?doc=A"); await g("/take"); await sleep(1100);
  const outside = await g("/safe/target?doc=B");
  check(outside.ok === false && /only while SAFE/.test(outside.error ?? ""), `R3. /safe/target with A on air → ${JSON.stringify(outside.error)}`);

  // ================================================================ H: slots selected outside takectl
  s = await phase();
  await sig("Cut_3");
  const h1 = await until(async () => { const x = await st(); return x.pgm === "SAFE" ? x : null; }, 3000);
  const tl1 = await tallies();
  await sig("Cut_4");
  const h2 = await until(async () => { const x = await st(); return x.pgm === "OTHER" ? x : null; }, 3000);
  const pushO = await g("/push");
  const tl2 = await tallies();
  const tk = await g("/take");
  await sleep(1100);
  const h3 = await st();
  check(h1?.pvw === "B" && tl1 === "off/off" && h2?.safe?.otherSlot === 9 && /something else is on air: switcher slot 9/.test(h2?.warning ?? "") && pushO.ok === false && /something else is on air/.test(pushO.error ?? "") && tl2 === "off/off" && tk.ok && h3.pgm === "B" && (await slot()) === 2,
    `H. Cut_3 outside → pgm ${h1?.pgm}, target ${h1?.pvw}, TALLY ${tl1}; Cut_4 (empty) → pgm ${h2?.pgm}, slot ${h2?.safe?.otherSlot}, warning ${JSON.stringify(h2?.warning)}; PUSH → ${JSON.stringify(pushO.error)}; TAKE → ${h3.pgm} (slot ${await slot()})`);

  // ================================================================ A: PANIC while SAFE is on air
  await g("/panic"); await sleep(400);
  t0 = await now();
  p = await g("/panic");
  L = await log(t0);
  check(p.ok && p.already === true && p.rounds === 0 && !all(L, /MASTER (cut|dissolve)/).length, `A. PANIC with SAFE already on air → ${JSON.stringify({ ok: p.ok, already: p.already, rounds: p.rounds, ms: p.ms })}; switcher got ${all(L, /MASTER (cut|dissolve)/).length} cut or dissolve signal(s)`);

  // ================================================================ Y: history
  s = await phase();
  for (let i = 0; i < 3; i++) { await g("/panic"); await sleep(400); await g("/safe/target?doc=A"); await g("/take"); await sleep(1100); }
  const hy = await g("/history");
  const st3 = await st();
  check(hy.log?.filter((e) => e.kind === "panic").length === 3 && hy.log?.filter((e) => e.safe).length === 3 && st3.history?.left === 0 && !Object.keys(st3.history?.follow ?? { x: 1 }).length,
    `Y. 3 × (PANIC, TAKE out to A): log ${JSON.stringify(hy.log?.map((e) => `${e.from}→${e.to} ${e.kind}${e.safe ? " safe" : ""}`))}; "${st3.history?.from}" counted as left ${st3.history?.left} times`);

  // ================================================================ K: hooks out of SAFE
  s = await phase({ ...baseCfg(), hooks: { "Slides PiP": { pre: [{ layer: "Lower Third", set: "off" }, { layer: "STINGER", set: "off", in: "master" }], post: [{ layer: "Lower Third", set: "live" }] } } });
  await g("/panic"); await sleep(400);
  await g("/safe/target?doc=B");
  t0 = await now();
  await g("/take");
  await sleep(1300);
  L = await log(t0);
  check(!at(L, /PH-[AB] Lower Third setOff/) && at(L, /PH-MASTER STINGER setOff/) && at(L, /PH-B Lower Third setLive/),
    `K. TAKE out of SAFE to B ("Slides PiP"): document pre-hook skipped, MASTER pre-hook ran, post-hook ran: ${fmt(L, t0)}`);

  // ================================================================ N: no safe source; not ready
  s = await phase(baseCfg(null));
  const dj = await g("/doctor.json");
  p = await g("/panic");
  check(p.ok && p.pgm === "A" && (await slot()) === 1 && (await st()).safe?.panicTo === "A" && (dj.warnings ?? []).some((w) => /No safe source: PANIC cuts to document A/.test(w)),
    `N1. no safe source: PANIC → ${JSON.stringify({ ok: p.ok, pgm: p.pgm })}, slot ${await slot()}; doctor warning ${JSON.stringify((dj.warnings ?? []).find((w) => /safe/i.test(w)))}`);
  await stopAll();
  procs.push(spawn("node", [join(HERE, "mock-mimolive.mjs"), String(MP)], { stdio: "ignore" }));
  await sleep(500);
  await startTk({ ...baseCfg(), a: { host: MOCK, documentName: "PH-A-missing" } });
  const nr = await until(async () => { const x = await st(); return x.ready === false && x.panicArmed ? x : null; }, 9000);
  p = await g("/panic");
  check(nr && p.ok && p.pgm === "SAFE" && (await slot()) === 3, `N2. not ready (A missing), safe configured: PANIC armed ${!!nr?.panicArmed} → ${JSON.stringify({ ok: p.ok, pgm: p.pgm })}, slot ${await slot()}`);

  // ================================================================ W: a stale read must not undo PANIC
  s = await phase(baseCfg(), "--slow-read=300");
  const rsP = g("/resync"); // its switcher read reflects slot 1 and answers 300 ms later
  await sleep(50);
  p = await g("/panic");
  await rsP;
  await sleep(200);
  const w = await st();
  check(p.ok && p.pgm === "SAFE" && w.pgm === "SAFE" && (await slot()) === 3,
    `W. a read sent 50 ms before PANIC answers 250 ms into it: PANIC → ${JSON.stringify({ ok: p.ok, pgm: p.pgm, ms: p.ms })}; /state.pgm afterwards ${w.pgm}; slot ${await slot()}`);
  // W2, the ordinary-TAKE case: a read sent just before a TAKE answers mid-dissolve; the roles must stay
  // with the TAKE (before the fix they went back to A until the next 5 s poll).
  await g("/safe/target?doc=A"); await g("/cut"); await sleep(1500); // A on air
  const rs2 = g("/resync");
  await sleep(50);
  const tk2 = await g("/take");
  await rs2;
  await sleep(1300);
  const w2 = await st();
  check(tk2.ok && w2.pgm === "B" && (await slot()) === 2,
    `W2. a read sent 50 ms before a TAKE to B answers mid-dissolve: TAKE → ${JSON.stringify({ ok: tk2.ok, pgm: tk2.pgm })}; /state.pgm 1.3 s later ${w2.pgm}; slot ${await slot()}`);

  // ================================================================ S: setup and doctor
  await stopAll();
  procs.push(spawn("node", [join(HERE, "mock-mimolive.mjs"), String(MP)], { stdio: "ignore" }));
  await sleep(500);
  const sf = join(dir, "setup.json");
  await startTk(null, sf);
  await until(async () => (await st()).status, 6000);
  const docs = (await g(`/setup/documents?host=${encodeURIComponent(MOCK)}`)).documents ?? [];
  const id = (nm) => docs.find((d) => d.name.startsWith(nm))?.id;
  const sm = await g(`/setup/master?${new URLSearchParams({ host: MOCK, id: id("PH-MASTER") ?? "", aHost: MOCK, aId: id("PH-A") ?? "", aName: "PH-A.tvshow", bHost: MOCK, bId: id("PH-B") ?? "", bName: "PH-B.tvshow" })}`);
  const body = (safe) => ({ a: { host: MOCK, documentName: "PH-A.tvshow" }, b: { host: MOCK, documentName: "PH-B.tvshow" }, master: { host: MOCK, documentName: "PH-MASTER.tvshow", sourceNameA: "NDI PH-A", sourceNameB: "NDI PH-B", sourceNameSafe: safe }, switcherLayerName: "AB Switcher" });
  const bad1 = await post("/setup/save", body("NDI PH-A"));
  const bad2 = await post("/setup/save", body("No Such Source"));
  const good = await post("/setup/save", body(sm.suggest?.sourceNameSafe));
  await ready();
  let saved = {}; try { saved = JSON.parse(readFileSync(sf, "utf8")); } catch {}
  const dk = await g("/doctor.json");
  const safeChecks = (dk.checks ?? []).filter((c) => /SAFE/.test(c.id));
  check(sm.suggest?.sourceNameSafe === "SAFE Test Pattern" && sm.sources?.find((x) => x.name === "SAFE Test Pattern")?.slot === "3" && bad1.status === 400 && bad2.status === 400 && good.ok && saved.master?.sourceNameSafe === "SAFE Test Pattern" && safeChecks.length === 3 && safeChecks.every((c) => c.ok) && !(dk.warnings ?? []).some((w) => /No safe source/.test(w)),
    `S. setup suggests ${JSON.stringify(sm.suggest?.sourceNameSafe)} (slot ${sm.sources?.find((x) => x.name === "SAFE Test Pattern")?.slot}); A's source as safe → ${bad1.status} ${JSON.stringify(bad1.error)}; unknown → ${bad2.status}; saved ${JSON.stringify(saved.master?.sourceNameSafe)}; doctor ${safeChecks.map((c) => `${c.id} ${c.ok ? "✓" : "✗"}`).join(", ")}`);
} finally {
  await stopAll();
  say(fails ? `${fails} FAIL(S)` : "ALL PASS");
  writeFileSync(join(OUT, "safe-offline-check.txt"), out.join("\n") + "\n");
}
process.exit(fails ? 1 : 0);
