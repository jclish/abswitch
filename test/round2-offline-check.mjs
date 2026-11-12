#!/usr/bin/env node
// round2-offline-check: v0.2 round 2 against test/mock-mimolive.mjs (nothing else on :8991 or :18989).
//   node test/round2-offline-check.mjs
// The mock logs every signal, layer switch and Layer Set recall with its time (/mock/log), so order
// and spacing are read from what reached "mimoLive", not from takectl's own account.
// P  PUSH: refused with no active set in Preview, a name Program lacks, while busy, mid-transition;
//    lands in Program only, logged in history. P5: TAKE and PUSH sent together → one runs, one is refused.
// S  stinger: stinger in → commit ≥ stingerCoverMs later → off ≥ stingerOffMs after → post-hooks after
//    its reveal; TAKE, CUT and PUSH; refused live / stuck in shutdown (PANIC cures); layer missing →
//    commit without it, warning. S6: a second stinger TAKE as soon as the first allows keeps its
//    stinger on until its cut (the first one's read-back must not switch it off).
// H  hooks: pre on the outgoing document ≥ waitMs before the signal; post after verify; a pair key wins
//    over the name; a failing hook warns and the take stands; MASTER actions; never in flight;
//    PANIC 200 ms after a take (and under / just after a stinger) fires none; rehearse runs them in
//    Preview and puts Preview back 2 s later (H3b); POST /hooks is loopback-only, validated, and the
//    datastore wins over the config.
// T  steps: record, push at original pace (gaps kept, capped at 10 s) and instant; TAKE refused while
//    they run; saved/loaded by name in MASTER's datastore; PANIC stops them; a missing name refuses.
//    T8/T9: with the stinger, one cover over an instant run; at original pace the first step only.
// Y  history: nothing until Program's look has been left 3 times; then counts + top; reset needs
//    confirm; survives a restart.
// U  UNDO: back to the previous look with no hooks; disabled with the reason after a Preview recall,
//    a PUSH, pre-hooks on the outgoing document, an UNDO.
// TAKECTL_DIR=<dir> runs another takectl.mjs (falsification).
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { networkInterfaces, tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.TAKECTL_DIR || dirname(HERE);
const OUT = process.env.TAKECTL_DIR ? join(ROOT, "out") : HERE;
mkdirSync(OUT, { recursive: true });
const MP = 18989, MOCK = `http://localhost:${MP}`, MB = `${MOCK}/api/v1`, T = "http://localhost:8991";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const json = async (u, o = {}) => { try { const r = await fetch(u, { ...o, signal: AbortSignal.timeout(o.timeout ?? 15000) }); const t = await r.text(); try { return { status: r.status, ...JSON.parse(t) }; } catch { return { status: r.status, raw: t }; } } catch (e) { return { status: 0, error: String(e) }; } };
const g = (path) => json(T + path);
const out = [];
const say = (s) => { out.push(s); console.log(s); };
let fails = 0;
const check = (ok, what) => { if (!ok) fails++; say(`${ok ? "PASS" : "FAIL"}  ${what}`); };
const until = async (fn, ms) => { const t = Date.now(); while (Date.now() - t < ms) { const v = await fn(); if (v) return v; await sleep(100); } return null; };
const lan = Object.values(networkInterfaces()).flat().find((i) => i && i.family === "IPv4" && !i.internal)?.address;
const dir = mkdtempSync(join(tmpdir(), "abswitch-r2-"));
const procs = [];
const stop = async (p) => { if (p && p.exitCode === null && p.signalCode === null) { const w = new Promise((r) => p.once("exit", r)); p.kill(); await w; } };
const stopAll = async () => { for (const p of procs.splice(0).reverse()) await stop(p); };
let tk = null;
const baseCfg = () => {
  const c = JSON.parse(readFileSync(join(ROOT, "takectl.config.example.json"), "utf8"));
  for (const k of ["a", "b", "master"]) c[k].host = MOCK;
  c.a.documentName = "PH-A"; c.b.documentName = "PH-B"; c.master.documentName = "PH-MASTER";
  c.companion = { host: null };
  return c;
};
const startTk = async (cfg) => {
  const f = join(dir, `c${procs.length}.json`);
  writeFileSync(f, JSON.stringify(cfg, null, 2));
  tk = spawn("node", [join(ROOT, "takectl.mjs")], { env: { ...process.env, TAKECTL_CONFIG: f }, stdio: "ignore" });
  procs.push(tk);
  return until(async () => { const s = await g("/state"); return s.ready !== false && s.pgm ? s : null; }, 9000);
};
// A fresh mock (A on air, A "Speaker Wide", B "Slides PiP", Lower Third off in both) and takectl.
const phase = async (cfgOver = {}, ...mockFlags) => {
  await stopAll();
  procs.push(spawn("node", [join(HERE, "mock-mimolive.mjs"), String(MP), ...mockFlags], { stdio: "ignore" }));
  await sleep(500);
  return startTk(Object.assign(baseCfg(), cfgOver));
};
const now = async () => (await json(`${MB}/mock/log`)).now;
const log = async (t0 = 0) => ((await json(`${MB}/mock/log`)).log ?? []).filter((e) => e.t >= t0);
const at = (entries, re) => entries.find((e) => re.test(e.what))?.t ?? null;
const all = (entries, re) => entries.filter((e) => re.test(e.what));
const fmt = (entries, t0) => entries.map((e) => `${e.t - t0}:${e.what}`).join(" | ");
const warn = async () => (await g("/state")).warning ?? "";
const enc = encodeURIComponent;

try {
  // ================================================================ P: PUSH
  let s = await phase();
  await json(`${MB}/mock/set-active?doc=222&name=`);
  let r = await g("/push");
  check(r.ok === false && /Preview \(B\) has no active Layer Set/.test(r.error ?? ""), `P1. no active set in Preview → ${JSON.stringify(r.error ?? r)}`);
  await json(`${MB}/mock/add-set?doc=222&name=${enc("B Only")}&active=1`);
  r = await g("/push");
  check(r.ok === false && /Program \(A.*no Layer Set named "B Only"/.test(r.error ?? ""), `P2. a name Program lacks → ${JSON.stringify(r.error ?? r)}`);
  await json(`${MB}/mock/set-active?doc=222&name=${enc("Slides PiP")}`);
  await g("/take");
  const busy = await g("/push");
  await sleep(1200); // PGM B "Slides PiP", PVW A "Speaker Wide"
  await json(`${MB}/documents/333/layers/${(await json(`${MB}/documents/333/layers`)).data.find((l) => /videoswitcher/.test(l.attributes["composition-id"])).id}/signals/tvGroup_Control__Dis_1_TypeSignal`); // a dissolve started outside takectl
  await sleep(60);
  const inflight = await g("/push");
  check(busy.ok === false && /busy: transition in progress/.test(busy.error ?? "") && inflight.ok === false && /mid-transition/.test(inflight.error ?? ""),
    `P3. right after a TAKE → ${JSON.stringify(busy.error)}; during an outside dissolve → ${JSON.stringify(inflight.error)}`);
  await until(async () => (await g("/state")).pgm === "A", 4000); // PGM A "Speaker Wide", PVW B "Slides PiP"
  await sleep(400);
  let t0 = await now(), t1 = 0;
  r = await g("/push");
  await sleep(900);
  let L = await log(t0);
  let h = await g("/history");
  const lastH = h.log?.[h.log.length - 1];
  check(r.ok && r.pgm === "A" && all(L, /recall/).length === 1 && at(L, /^PH-A recall Slides PiP$/) && !all(L, /MASTER (cut|dissolve)/).length && lastH?.kind === "push" && lastH.from === "Speaker Wide" && lastH.to === "Slides PiP",
    `P4. PUSH → ${JSON.stringify(r)}; mock: ${fmt(L, t0)}; history ${JSON.stringify(lastH)}`);

  // P5: TAKE and PUSH at the same instant (Companion can do that; the page cannot)
  await sleep(500);
  t0 = await now();
  const [rt, rp] = await Promise.all([g("/take"), g("/push")]);
  await sleep(1300);
  L = await log(t0);
  const commits = all(L, /MASTER (cut|dissolve)|recall/);
  check([rt, rp].filter((x) => x.ok).length === 1 && commits.length === 1 && /busy/.test((rt.ok ? rp : rt).error ?? ""),
    `P5. TAKE and PUSH together → TAKE ${rt.ok ? "ok" : JSON.stringify(rt.error)}, PUSH ${rp.ok ? "ok" : JSON.stringify(rp.error)}; mimoLive got ${commits.length} command(s): ${fmt(commits, t0)}`);

  // ================================================================ S: stinger
  const LT = { "Slides PiP": { post: [{ layer: "Lower Third", set: "live" }] } };
  s = await phase({ stinger: true, hooks: LT });
  t0 = await now();
  r = await g("/take");
  await sleep(1500);
  L = await log(t0);
  let sIn = at(L, /STINGER setLive/), cut = at(L, /MASTER cut 2/), sOff = at(L, /STINGER setOff/), post = at(L, /PH-B Lower Third setLive/);
  check(r.ok && r.transition === "stinger" && !all(L, /dissolve/).length && sIn && cut - sIn >= 490 && sOff - cut >= 110 && post - sOff >= 390,
    `S1. stinger TAKE: in→cut ${cut - sIn} ms (≥ coverMs 500), cut→off ${sOff - cut} ms (≥ offMs 120), off→post-hook ${post - sOff} ms (≥ its 400 ms reveal); ${fmt(L, t0)}`);
  t0 = await now();
  r = await g("/cut");
  await sleep(1200);
  L = await log(t0);
  sIn = at(L, /STINGER setLive/); cut = at(L, /MASTER cut 1/);
  // Round 3 ruling: CUT is always a bare cut, as on an ATEM; it never fires the stinger.
  check(r.ok && r.transition === "cut" && !sIn && cut, `S2. CUT with the stinger on is bare (round 3): ${r.transition}; ${fmt(L, t0)}`);
  t0 = await now();
  r = await g("/push"); // PGM A ← "Slides PiP"
  await sleep(1300);
  L = await log(t0);
  sIn = at(L, /STINGER setLive/); const rec = at(L, /PH-A recall Slides PiP/); sOff = at(L, /STINGER setOff/); post = at(L, /PH-A Lower Third setLive/);
  check(r.ok && r.transition === "stinger" && rec - sIn >= 490 && sOff - rec >= 110 && post - sOff >= 390, `S3. stinger PUSH: in→recall ${rec - sIn} ms, recall→off ${sOff - rec}, off→post ${post - sOff}; ${fmt(L, t0)}`);
  await json(`${MB}/mock/set-layer?doc=333&name=STINGER&live=live`);
  const rLive = await g("/take");
  await json(`${MB}/mock/set-layer?doc=333&name=STINGER&live=shutdown`);
  const rStuck = await g("/take");
  await g("/panic");
  await sleep(900);
  const rAfter = await g("/take");
  await sleep(1200);
  check(rLive.ok === false && /already live/.test(rLive.error ?? "") && rStuck.ok === false && /stuck in shutdown.*PANIC/.test(rStuck.error ?? "") && rAfter.ok && rAfter.transition === "stinger",
    `S4. stinger live → ${JSON.stringify(rLive.error)}; stuck in shutdown → ${JSON.stringify(rStuck.error)}; after PANIC → ${rAfter.ok ? `ok (${rAfter.transition})` : JSON.stringify(rAfter)}`);
  // S6: TAKE, then TAKE again the moment takectl is no longer busy
  t0 = await now();
  await g("/take");
  await until(async () => !(await g("/state")).busy, 3000);
  t1 = await now();
  r = await g("/take");
  await sleep(1500);
  L = await log(t1);
  const in2 = at(L, /STINGER setLive/), cut2 = at(L, /MASTER cut/);
  const offEarly = all(L, /STINGER setOff/).filter((e) => in2 && cut2 && e.t > in2 && e.t < cut2);
  check(r.ok && r.transition === "stinger" && in2 && cut2 && !offEarly.length,
    `S6. second stinger TAKE ${in2 - t1} ms after the first stopped being busy: STINGER off between its in and its cut: ${offEarly.length ? fmt(offEarly, t1) : "never"}; ${fmt(L, t1)}`);
  s = await phase({ stinger: true }, "--no-stinger");
  r = await g("/take");
  await sleep(1200);
  let w = await warn();
  check(r.ok && r.transition === "dissolve" && /no "STINGER" layer: committed without it/.test(w), `S5. layer missing → ${r.ok ? r.transition : JSON.stringify(r)}; warning ${JSON.stringify(w)}`);

  // ================================================================ H: hooks
  const HK = {
    "Slides PiP": { pre: [{ layer: "Lower Third", set: "off" }], waitMs: 300, post: [{ layer: "Lower Third", set: "live", delayMs: 200 }, { layer: "STINGER", set: "live", in: "master" }] },
    "Speaker Wide": { post: [{ layer: "Lower Third", set: "live" }] },
    "Slides PiP -> Speaker Wide": { post: [{ layer: "No Such Layer", set: "live" }] },
  };
  s = await phase({ hooks: HK });
  t0 = await now();
  r = await g("/take"); // A "Speaker Wide" → B "Slides PiP": the name hook
  await sleep(1500);
  L = await log(t0);
  const pre = at(L, /PH-A Lower Third setOff/), dis = at(L, /MASTER dissolve 2/), postB = at(L, /PH-B Lower Third setLive/), mst = at(L, /PH-MASTER STINGER setLive/);
  await json(`${MB}/mock/set-layer?doc=333&name=STINGER&live=off`); // the MASTER action's stand-in, back off
  check(r.ok && pre && dis - pre >= 300 && postB - dis >= 500 + 200 && mst && mst >= dis + 500 && !all(L, /PH-B Lower Third setOff/).length,
    `H1. pre on outgoing A ${dis - pre} ms before the signal (waitMs 300); post on B ${postB - dis} ms after it (dissolve 500 + delayMs 200); MASTER action ran; ${fmt(L, t0)}`);
  t0 = await now();
  r = await g("/take"); // B "Slides PiP" → A "Speaker Wide": the pair wins, and its layer does not exist
  await sleep(1300);
  L = await log(t0);
  s = await g("/state");
  check(r.ok && s.pgm === "A" && /hook failed \(then: No Such Layer in\): no layer named "No Such Layer"/.test(s.warning ?? "") && !at(L, /PH-A Lower Third setLive/),
    `H2. pair "Slides PiP -> Speaker Wide" wins over "Speaker Wide"; its failure warns, the take stands: pgm=${s.pgm}, warning ${JSON.stringify(s.warning)}; ${fmt(L, t0)}`);
  // rehearse: post-hooks of a take to Preview's look ("Slides PiP"), in Preview B, MASTER skipped
  await json(`${MB}/mock/set-layer?doc=222&name=${enc("Lower Third")}&live=off`); // held off in Preview
  t0 = await now();
  r = await g("/hooks/rehearse");
  await sleep(600);
  L = await log(t0);
  check(r.ok && at(L, /PH-B Lower Third setLive/) && !at(L, /PH-MASTER/) && /1 MASTER action/.test(r.skipped ?? "") && !all(L, /PH-A/).length && JSON.stringify(r.restores) === '["Lower Third off"]',
    `H3. rehearse → ${JSON.stringify(r)}; mock: ${fmt(L, t0)}`);
  // H3b (ruling 2026-11-11): Preview is put back 2 s after the last hook; commands wait; then a TAKE
  // brings the hook layer in on Program.
  const duringR = await g("/take");
  await until(async () => !(await g("/state")).rehearsal, 5000);
  L = await log(t0);
  const lon = at(L, /PH-B Lower Third setLive/), loff = at(L, /PH-B Lower Third setOff/);
  t1 = await now();
  const tb = await g("/take");
  await sleep(1300);
  const L2 = await log(t1);
  check(duringR.ok === false && /rehearsing hooks in Preview B/.test(duringR.error ?? "") && loff && loff - lon >= 2000 && tb.ok && at(L2, /PH-B Lower Third setLive/),
    `H3b. TAKE during the rehearsal → ${JSON.stringify(duringR.error)}; Lower Third in Preview: live at ${lon - t0} ms, put back off at ${loff - t0} ms (hold ≥ 2 s after the last hook); then TAKE → its post-hook on Program: ${fmt(L2, t1)}`);
  await json(`${MB}/mock/set-layer?doc=333&name=STINGER&live=off`);
  // POST /hooks: loopback only, validated; the datastore wins over the config, key by key
  const bad = await json(`${T}/hooks`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ "Speaker Wide": { post: [{ layer: 7 }] } }) });
  const remote = lan ? await json(`http://${lan}:8991/hooks`, { method: "POST", body: "{}" }) : { status: "no LAN address" };
  const good = await json(`${T}/hooks`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ "Speaker Wide": { post: [{ layer: "TALLY", set: "off" }] } }) });
  const stored = await json(`${MB}/documents/333/datastores/abswitch-hooks`);
  const view = await g("/hooks");
  const sw = view.inUse?.find((x) => x.key === "Speaker Wide");
  check(bad.status === 400 && remote.status === 403 && good.ok && stored["Speaker Wide"] && sw?.origin === "datastore" && sw.post[0].layer === "TALLY",
    `H5. POST /hooks invalid → ${bad.status} ${JSON.stringify(bad.error)}; from the LAN address → ${remote.status}; valid → ${JSON.stringify(good)}; "Speaker Wide" now from ${sw?.origin}`);
  // PANIC n ms after TAKE is pressed (the request is not awaited: it returns only once the signal has gone)
  const pressThenPanic = async (ms) => { const t = await now(); const take = g("/take"); await sleep(ms); const p = await g("/panic"); const tr = await take; await sleep(1800); return { L: await log(t), t, take: tr, panic: p }; };
  s = await phase({ hooks: LT });
  let x = await pressThenPanic(200);
  check(at(x.L, /MASTER dissolve 2/) && !at(x.L, /Lower Third setLive/) && x.panic.ok, `H4. PANIC 200 ms after a TAKE (dissolve in flight): no post-hook; take → ${JSON.stringify(x.take.error ?? x.take.transition)}; ${fmt(x.L, x.t)}`);
  await g("/stinger?on=1");
  x = await pressThenPanic(200);
  check(!at(x.L, /MASTER cut 2/) && at(x.L, /STINGER setOff/) && !at(x.L, /Lower Third setLive/) && /under the stinger; signal not sent/.test(x.take.error ?? ""),
    `H6. PANIC 200 ms into a stinger TAKE: signal never sent (${JSON.stringify(x.take.error)}), stinger off, no post-hook; ${fmt(x.L, x.t)}`);
  x = await pressThenPanic(700);
  check(at(x.L, /MASTER cut 2/) && !at(x.L, /Lower Third setLive/), `H7. PANIC 700 ms into a stinger TAKE (after the cut, before the reveal): no post-hook; ${fmt(x.L, x.t)}`);
  // never in flight: a 2 s dissolve outlasts verify (settle 100 + 3 × 150 ms)
  s = await phase({ hooks: LT, dissolveMs: 100, settleMs: 100 }, "--dissolve-ms=2000");
  t0 = await now();
  await g("/take");
  await sleep(3000);
  L = await log(t0);
  const d2 = at(L, /MASTER dissolve 2/), p2 = at(L, /PH-B Lower Third setLive/);
  check(d2 && p2 && p2 - d2 >= 2000, `H8. dissolve in flight past verify: post-hook ${p2 ? `${p2 - d2} ms` : "never"} after the signal (dissolve 2000 ms); ${fmt(L, t0)}`);

  // ================================================================ T: steps
  s = await phase();
  await g("/steps/clear");
  await g("/steps/record?on=1");
  await g(`/pvw/layer-set/${enc("Speaker Wide")}`);
  await sleep(1500);
  await g(`/pvw/layer-set/${enc("Slides PiP")}`);
  await g("/steps/record?on=0");
  let st = await g("/steps");
  check(JSON.stringify(st.list) === JSON.stringify(["Speaker Wide", "Slides PiP"]) && st.recording === false, `T1. recorded ${JSON.stringify(st.list)}`);
  t0 = await now();
  r = await g("/steps/push?pace=original");
  await sleep(300);
  const during = await g("/take");
  await until(async () => !(await g("/steps")).running, 6000);
  L = await log(t0);
  let rs = all(L, /^PH-A recall/);
  check(r.ok && rs.length === 2 && /Speaker Wide/.test(rs[0].what) && /Slides PiP/.test(rs[1].what) && Math.abs(rs[1].t - rs[0].t - 1500) < 300 && during.ok === false && /steps are being pushed/.test(during.error ?? "") && !all(L, /PH-B recall/).length,
    `T2. pace original: Program A ${rs.map((e) => e.what.replace("PH-A recall ", "")).join(" → ")}, gap ${rs[1] ? rs[1].t - rs[0].t : "?"} ms (recorded ~1500); TAKE meanwhile → ${JSON.stringify(during.error)}`);
  t0 = await now();
  await g("/steps/push?pace=instant");
  await until(async () => !(await g("/steps")).running, 6000);
  L = await log(t0);
  rs = all(L, /^PH-A recall/);
  check(rs.length === 2 && rs[1].t - rs[0].t < 900, `T3. pace instant: gap ${rs[1] ? rs[1].t - rs[0].t : "?"} ms (each step waits for the last to land)`);
  const sv = await g(`/steps/save?name=${enc("show")}`);
  await g("/steps/clear");
  const ld = await g(`/steps/load?name=${enc("show")}`);
  const ds = await json(`${MB}/documents/333/datastores/abswitch-steps`);
  check(sv.ok && ld.ok && JSON.stringify(ld.steps) === JSON.stringify(["Speaker Wide", "Slides PiP"]) && ds.lists?.show?.length === 2, `T4. saved "show" in MASTER's datastore and loaded it back: ${JSON.stringify(ld.steps)}`);
  // cap: a 30 s recorded gap is pushed 10 s apart (list written to the datastore, takectl restarted to read it)
  await json(`${MB}/documents/333/datastores/abswitch-steps`, { method: "PUT", body: JSON.stringify({ lists: { ...ds.lists, cap: [{ name: "Speaker Wide", at: 0 }, { name: "Slides PiP", at: 30000 }] } }) });
  await stop(tk);
  await startTk(baseCfg());
  await g(`/steps/load?name=cap`);
  t0 = await now();
  await g("/steps/push?pace=original");
  await until(async () => !(await g("/steps")).running, 14000);
  L = await log(t0);
  rs = all(L, /^PH-A recall/);
  check(rs.length === 2 && rs[1].t - rs[0].t >= 9900 && rs[1].t - rs[0].t < 10600, `T5. a 30 s recorded gap pushed ${rs[1] ? rs[1].t - rs[0].t : "?"} ms apart (cap 10 s)`);
  await g(`/steps/load?name=show`);
  t0 = await now();
  await g("/steps/push?pace=original");
  await sleep(500);
  await g("/panic");
  await sleep(2500);
  L = await log(t0);
  st = await g("/steps");
  check(all(L, /^PH-A recall/).length === 1 && st.running === null, `T6. PANIC 500 ms into a 2-step push: ${all(L, /^PH-A recall/).length} step pushed, running=${JSON.stringify(st.running)}`);
  await json(`${MB}/mock/add-set?doc=222&name=${enc("B Only")}&active=1`);
  await g("/steps/add");
  r = await g("/steps/push?pace=instant");
  check(r.ok === false && /no Layer Set named "B Only"/.test(r.error ?? ""), `T7. a step Program lacks → ${JSON.stringify(r.error)}`);

  // T8/T9 (ruling 2026-11-11): steps and the stinger. Instant: ONE stinger over the run, every recall under
  // it, only the last step's post-hooks after the reveal. Original pace: the stinger on the first step only.
  const LT2 = { "Speaker Wide": { post: [{ layer: "Lower Third", set: "live" }] }, "Slides PiP": { post: [{ layer: "Lower Third", set: "live" }] }, "Two Shot": { post: [{ layer: "Lower Third", set: "live" }] } };
  s = await phase({ stinger: true, hooks: LT2 });
  await json(`${MB}/mock/add-set?doc=111&name=${enc("Two Shot")}`); await json(`${MB}/mock/add-set?doc=222&name=${enc("Two Shot")}`);
  await g("/steps/clear");
  for (const nm of ["Slides PiP", "Two Shot", "Speaker Wide"]) { await g(`/pvw/layer-set/${enc(nm)}`); await g("/steps/add"); }
  t0 = await now();
  r = await g("/steps/push?pace=instant");
  await until(async () => !(await g("/steps")).running, 8000);
  await sleep(600);
  L = await log(t0);
  let ins = all(L, /STINGER setLive/), offs = all(L, /STINGER setOff/), recs = all(L, /^PH-A recall/), lts = all(L, /Lower Third setLive/);
  check(r.ok && ins.length === 1 && recs.length === 3 && recs[0].t - ins[0].t >= 490 && offs.length >= 1 && offs[0].t > recs[2].t && lts.length === 1 && lts[0].t - offs[0].t >= 390 && /PH-A/.test(lts[0].what),
    `T8. instant run of 3 under the stinger: ${ins.length} stinger in, ${recs.length} recalls (first ${recs[0] ? recs[0].t - ins[0].t : "?"} ms after it), off after the last, ${lts.length} post-hook (the last step's, ${lts[0] && offs[0] ? lts[0].t - offs[0].t : "?"} ms after off); ${fmt(L, t0)}`);
  await json(`${MB}/mock/set-layer?doc=111&name=${enc("Lower Third")}&live=off`);
  await g("/steps/clear");
  await g("/steps/record?on=1");
  await g(`/pvw/layer-set/${enc("Slides PiP")}`); await sleep(1200); await g(`/pvw/layer-set/${enc("Two Shot")}`);
  await g("/steps/record?on=0");
  t0 = await now();
  r = await g("/steps/push?pace=original");
  await until(async () => !(await g("/steps")).running, 9000);
  await sleep(600);
  L = await log(t0);
  ins = all(L, /STINGER setLive/); recs = all(L, /^PH-A recall/); lts = all(L, /Lower Third setLive/);
  check(r.ok && ins.length === 1 && recs.length === 2 && ins[0].t < recs[0].t && lts.length === 2,
    `T9. original pace, 2 steps: ${ins.length} stinger in (before the first recall only), ${recs.length} recalls, ${lts.length} post-hooks (each step its own); ${fmt(L, t0)}`);

  // ================================================================ Y: history
  s = await phase();
  const looks = [];
  for (let i = 0; i < 5; i++) { await g("/take"); await sleep(1000); looks.push((await g("/state")).history); }
  // takes: SW→SP, SP→SW, SW→SP, SP→SW, SW→SP: on Program "Slides PiP" after take 5 (left twice), "Speaker Wide" after take 4 (left twice)
  await g("/take"); await sleep(1000); // 6th: SP→SW. Now "Speaker Wide" has been left 3 times
  const y = (await g("/state")).history;
  check(looks[3]?.from === "Speaker Wide" && looks[3].left === 2 && !Object.keys(looks[3].follow).length && y?.from === "Speaker Wide" && y.left === 3 && y.follow["Slides PiP"] === 3 && JSON.stringify(y.top) === '["Slides PiP"]',
    `Y1. after 2 leaves of "Speaker Wide": ${JSON.stringify(looks[3])}; after 3: ${JSON.stringify(y)}`);
  await stop(tk);
  await startTk(baseCfg());
  const yr = await g("/history");
  const noConfirm = await g("/history/reset");
  const reset = await g("/history/reset?confirm=1");
  const dsH = await json(`${MB}/documents/333/datastores/abswitch-history`);
  check(yr.events === 6 && noConfirm.ok === false && reset.ok && reset.cleared === 6 && dsH.events?.length === 0, `Y2. after a restart ${yr.events} events kept; reset without confirm → ${JSON.stringify(noConfirm.error)}; with → cleared ${reset.cleared}, datastore ${JSON.stringify(dsH)}`);

  // ================================================================ U: UNDO
  s = await phase({ hooks: { "Speaker Wide": { post: [{ layer: "Lower Third", set: "live" }] } } });
  const u0 = await g("/undo");
  await g("/take"); await sleep(1100);
  const uOk = (await g("/state")).undo;
  t0 = await now();
  r = await g("/undo"); await sleep(1100);
  L = await log(t0);
  s = await g("/state");
  h = await g("/history");
  check(u0.ok === false && /no TAKE or CUT yet/.test(u0.error) && uOk?.available && r.ok && s.pgm === "A" && !at(L, /Lower Third/) && h.log?.at(-1)?.kind === "undo" && h.log.at(-2)?.undone === true && /already undone/.test(s.undo?.why),
    `U1. before a TAKE → ${JSON.stringify(u0.error)}; after → available; UNDO → pgm ${s.pgm}, no hooks (${fmt(L, t0)}), history marks it, then ${JSON.stringify(s.undo?.why)}`);
  await g("/take"); await sleep(1100);
  await g(`/pvw/layer-set/${enc("Slides PiP")}`);
  const uRec = (await g("/state")).undo;
  const uRef = await g("/undo");
  await g("/take"); await sleep(1100);
  await g("/push"); await sleep(900);
  const uPush = (await g("/state")).undo;
  check(uRec && !uRec.available && /Preview changed since the TAKE: Layer Set "Slides PiP" recalled/.test(uRec.why) && uRef.ok === false && uPush && !uPush.available && /PUSH changed Program/.test(uPush.why),
    `U2. after a Preview recall: ${JSON.stringify(uRec?.why)} (/undo → ${JSON.stringify(uRef.error)}); after a PUSH: ${JSON.stringify(uPush?.why)}`);
  s = await phase({ hooks: { "Slides PiP": { pre: [{ layer: "Lower Third", set: "off" }] } } });
  await g("/take"); await sleep(1100);
  const uPre = (await g("/state")).undo;
  check(uPre && !uPre.available && /pre-hooks changed it/.test(uPre.why), `U3. pre-hooks on the outgoing document: ${JSON.stringify(uPre?.why)}`);
} finally {
  await stopAll();
  say(fails ? `${fails} FAIL(S)` : "ALL PASS");
  writeFileSync(join(OUT, "round2-offline-check.txt"), out.join("\n") + "\n");
}
process.exit(fails ? 1 : 0);
