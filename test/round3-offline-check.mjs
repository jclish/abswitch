#!/usr/bin/env node
// round3-offline-check: round 3's controller side, against test/mock-mimolive.mjs (nothing else on :8991
// or :18989), plus the panel in headless Chrome (STALE, keys 1–8, view-only).
//   node test/round3-offline-check.mjs
// C  CUT is a bare cut with STINGER selected (no STINGER layer touched), its post-hooks still run; UNDO of
//    a CUT is bare too.
// R  rate: /rate writes the switcher's duration (clamped to 0.1–5 s) and a TAKE times its dissolve from the
//    value read at that TAKE, including one changed straight in "mimoLive" (value + 60 ms).
// M  MIX/STINGER selector; the config's "stinger" sets it at start.
// F  FTB: on and off, works mid-transition and in SAFE, not logged, PANIC leaves it on.
// D  downstream keys: "DSK <label>" layers above the switcher; toggle mid-transition and in SAFE; not
//    logged; unknown label refused; a DSK layer below the switcher is a warning.
// T  thumbnails: ~1 s after a Preview recall, stored under a hashed name with an index; /thumb serves it;
//    look names with "/", "\", ".." write nothing outside thumbs/ and read nothing outside it; Start Over
//    clears the folder.
// S  eight slots: more than 8 Layer Sets is a warning; NEXT goes to every tied look; the LAST line in SAFE;
//    REC / STREAM from MASTER's outputs; time on the current look; documents' live state within ~1 s.
// P  the page in Chrome: a stopped show and a stalled picture each read STALE and clear; keys 1–8 recall
//    that look in Preview; /?view=monitor has no buttons and ignores Space.
// TAKECTL_DIR=<dir> runs another takectl.mjs (falsification).
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
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
const out = [];
const say = (s) => { out.push(s); console.log(s); };
let fails = 0;
const check = (ok, what) => { if (!ok) fails++; say(`${ok ? "PASS" : "FAIL"}  ${what}`); };
const until = async (fn, ms, every = 100) => { const t = Date.now(); while (Date.now() - t < ms) { const v = await fn(); if (v) return v; await sleep(every); } return null; };
const dir = mkdtempSync(join(tmpdir(), "abswitch-r3-"));
const procs = [];
const stop = async (p) => { if (p && p.exitCode === null && p.signalCode === null) { const w = new Promise((r) => p.once("exit", r)); p.kill(); await w; } };
const stopAll = async () => { for (const p of procs.splice(0).reverse()) await stop(p); };
const baseCfg = (o = {}) => {
  const c = JSON.parse(readFileSync(join(ROOT, "takectl.config.example.json"), "utf8"));
  for (const k of ["a", "b", "master"]) c[k].host = MOCK;
  c.a.documentName = "PH-A"; c.b.documentName = "PH-B"; c.master.documentName = "PH-MASTER"; c.master.sourceNameSafe = "SAFE Test Pattern";
  c.companion = { host: null };
  return Object.assign(c, o);
};
let cfgFile = null;
const phase = async (cfg = baseCfg(), ...flags) => {
  await stopAll();
  procs.push(spawn("node", [join(HERE, "mock-mimolive.mjs"), String(MP), ...flags], { stdio: "ignore" }));
  await sleep(500);
  const sub = mkdtempSync(join(dir, "p-")); // its own folder, so thumbs/ is fresh
  cfgFile = join(sub, "takectl.config.json");
  writeFileSync(cfgFile, JSON.stringify(cfg, null, 2));
  procs.push(spawn("node", [join(ROOT, "takectl.mjs")], { env: { ...process.env, TAKECTL_CONFIG: cfgFile }, stdio: "ignore" }));
  return until(async () => { const s = await g("/state"); return s.ready !== false && s.pgm ? s : null; }, 9000);
};
const now = async () => (await json(`${MB}/mock/log`)).now;
const log = async (t0 = 0) => ((await json(`${MB}/mock/log`)).log ?? []).filter((e) => e.t >= t0);
const at = (L, re) => L.find((e) => re.test(e.what))?.t ?? null;
const all = (L, re) => L.filter((e) => re.test(e.what));
const fmt = (L, t0) => L.map((e) => `${e.t - t0}:${e.what}`).join(" | ");
const mlayer = async (doc, name) => (await json(`${MB}/documents/${doc}/layers`)).data?.find((l) => l.attributes.name === name);
const swId = async () => (await json(`${MB}/documents/333/layers`)).data.find((l) => /videoswitcher/.test(l.attributes["composition-id"])).id;
const enc = encodeURIComponent;

try {
  // ================================================================ C: CUT is bare
  let s = await phase(baseCfg({ stinger: true, hooks: { "Slides PiP": { post: [{ layer: "Lower Third", set: "live" }] } } }));
  let t0 = await now();
  let r = await g("/cut");
  await sleep(1200);
  let L = await log(t0);
  check(s.transition?.mode === "stinger" && r.ok && r.transition === "cut" && !at(L, /STINGER/) && at(L, /MASTER cut 2/) && at(L, /PH-B Lower Third setLive/),
    `C1. STINGER selected (from the config), CUT → ${r.transition}; STINGER untouched; post-hook ran: ${fmt(L, t0)}`);
  t0 = await now();
  r = await g("/undo");
  await sleep(1000);
  L = await log(t0);
  check(r.ok && r.transition === "cut" && !at(L, /STINGER/) && at(L, /MASTER cut 1/), `C2. UNDO of that CUT → ${r.transition}, no stinger: ${fmt(L, t0)}`);
  t0 = await now();
  r = await g("/take");
  await sleep(1500);
  L = await log(t0);
  check(r.ok && r.transition === "stinger" && at(L, /STINGER setLive/), `C3. TAKE with STINGER selected still uses it → ${r.transition}`);

  // ================================================================ R: rate
  s = await phase();
  const r1 = await g("/rate?s=1.5");
  const iv1 = (await json(`${MB}/documents/333/layers/${await swId()}`)).data.attributes["input-values"].tvIn_TransitionDuration;
  t0 = await now();
  const tk1 = await g("/take");
  const p1 = (await g("/state")).progress;
  await sleep(2200);
  let st = await g("/state");
  check(r1.ok && r1.seconds === 1.5 && iv1 === 1.5 && tk1.ms === 1560 && p1?.totalMs === 1560 && !/settled on a later read/.test(JSON.stringify(st.events ?? [])),
    `R1. /rate?s=1.5 → switcher reads ${iv1}; TAKE timed ${tk1.ms} ms (1.5 s + 60), progress bar total ${p1?.totalMs} ms`);
  await json(`${MB}/documents/333/layers/${await swId()}`, { method: "PUT", body: JSON.stringify({ "input-values": { tvIn_TransitionDuration: 2 } }) }); // as mimoLive's own UI would
  const tk2 = await g("/take");
  await sleep(2700);
  check(tk2.ok && tk2.ms === 2060, `R2. duration changed in "mimoLive" to 2 s: the next TAKE read it → ${tk2.ms} ms`);
  const r9 = await g("/rate?s=9"), r0 = await g("/rate?s=0");
  check(r9.seconds === 5 && r0.seconds === 0.1, `R3. clamped: 9 → ${r9.seconds} s, 0 → ${r0.seconds} s`);
  await g("/rate?s=0.5");

  // ================================================================ M: selector
  const m1 = await g("/transition?mode=stinger"), stA = (await g("/state")).transition?.mode;
  const m2 = await g("/transition?mode=mix"), stB = (await g("/state")).transition?.mode;
  const bad = await g("/transition?mode=wipe");
  check(m1.ok && stA === "stinger" && m2.ok && stB === "mix" && bad.ok === false, `M. selector: STINGER → ${stA}, MIX → ${stB}, "wipe" → ${JSON.stringify(bad.error)}`);

  // ================================================================ F, D: FTB and downstream keys
  s = await phase(baseCfg(), "--dsk-below");
  const h0 = (await g("/history")).events;
  await g("/take"); // a transition in flight
  const f1 = await g("/ftb?on=1"), d1 = await g(`/dsk/${enc("Bug")}?on=1`);
  const busyThen = (await g("/state")).busy;
  await sleep(1000);
  const ftbL = (await mlayer(333, "FTB")).attributes["live-state"], bugL = (await mlayer(333, "DSK Bug")).attributes["live-state"];
  const pz = await g("/panic"); await sleep(500);
  const ftbAfterPanic = (await mlayer(333, "FTB")).attributes["live-state"];
  const f2 = await g("/ftb?on=0"), d2 = await g(`/dsk/${enc("Clock")}`); // in SAFE
  await sleep(200);
  const clockL = (await mlayer(333, "DSK Clock")).attributes["live-state"];
  const h1 = (await g("/history")).log ?? [];
  st = await g("/state");
  const unk = await g(`/dsk/${enc("Nope")}`);
  check(f1.ok && d1.ok && busyThen && ftbL === "live" && bugL === "live" && pz.pgm === "SAFE" && ftbAfterPanic === "live" && f2.ok && d2.ok && clockL === "live" && st.safe?.onAir,
    `F/D1. mid-transition FTB on, DSK Bug on → FTB ${ftbL}, Bug ${bugL}; PANIC to SAFE leaves FTB ${ftbAfterPanic}; in SAFE: FTB off, Clock on → ${clockL}`);
  check(!h1.some((e) => /ftb|dsk/i.test(JSON.stringify(e))) && h1.filter((e) => e.kind !== "take" && e.kind !== "panic").length === 0 && JSON.stringify(st.dsk) === '[{"label":"Clock","on":true},{"label":"Bug","on":true}]',
    `F/D2. not logged (history: ${JSON.stringify(h1.map((e) => e.kind))}); /state.dsk ${JSON.stringify(st.dsk)}`);
  check(unk.ok === false && /no downstream key "Nope"/.test(unk.error ?? "") && /"DSK Low" is below the switcher/.test(st.warning ?? ""),
    `F/D3. unknown label → ${JSON.stringify(unk.error)}; warning ${JSON.stringify(st.warning)}`);

  // ================================================================ T: thumbnails
  s = await phase();
  const evil = ["../../evil", "a/b", "c\\d", "..", "Slides PiP"];
  for (const n of evil.slice(0, 4)) await json(`${MB}/mock/add-set?doc=111&name=${enc(n)}`), await json(`${MB}/mock/add-set?doc=222&name=${enc(n)}`);
  const thumbsDir = join(dirname(cfgFile), "thumbs");
  const before = readdirSync(dirname(dirname(cfgFile)));
  for (const n of evil) { await g(`/pvw/layer-set?name=${enc(n)}`); await sleep(1400); }
  const idx = existsSync(join(thumbsDir, "index.json")) ? JSON.parse(readFileSync(join(thumbsDir, "index.json"), "utf8")) : {};
  const files = existsSync(thumbsDir) ? readdirSync(thumbsDir) : [];
  const after = readdirSync(dirname(dirname(cfgFile)));
  const served = [];
  for (const n of evil) { const rr = await fetch(`${T}/thumb?name=${enc(n)}`); const b = Buffer.from(await rr.arrayBuffer()); served.push([n, rr.status, (b.toString("latin1").match(/<doc (\d+), look (.*)>$/) || [])[2]]); }
  const trav = [];
  for (const q of ["..%2F..%2Ftakectl.config.json", "..%2Ftakectl.config.json", "%2E%2E%2Findex.json", "index.json", "constructor", "__proto__"]) trav.push([q, (await fetch(`${T}/thumb/${q}`)).status]);
  for (const q of ["../takectl.config.json", "../../takectl.config.json", "index.json", "toString"]) trav.push([`?name=${q}`, (await fetch(`${T}/thumb?name=${enc(q)}`)).status]);
  check(evil.every((n) => /^[0-9a-f]{40}\.jpg$/.test(idx[n]?.file ?? "")) && files.every((f) => /^[0-9a-f]{40}\.jpg$/.test(f) || f === "index.json") && files.length === evil.length + 1 && JSON.stringify(before) === JSON.stringify(after),
    `T1. 5 looks recalled in Preview (names ${JSON.stringify(evil)}): thumbs/ holds ${files.length} files, all hashed (+ index.json); nothing new outside it`);
  check(served.every(([n, code, look]) => code === 200 && look === n), `T2. /thumb/<name> serves each look's own still: ${JSON.stringify(served)}`);
  check(trav.filter(([q]) => !q.startsWith("index") && !["constructor", "__proto__"].includes(q)).every(([, c]) => c === 404) && trav.every(([, c]) => c === 404),
    `T3. paths and odd names never reach a file: ${JSON.stringify(trav)}`);
  await json(`${MB}/documents/333/setOff`);
  const so = await json(`${T}/setup/start-over`, { method: "POST" });
  const left = existsSync(thumbsDir) ? readdirSync(thumbsDir) : [];
  check(so.ok && left.length === 0, `T4. Start Over → ${JSON.stringify(so.ok ? "ok" : so.error)}; thumbs/ left with ${left.length} files`);

  // ================================================================ S: slots, NEXT ties, LAST in SAFE, outputs, time on look, live state
  s = await phase();
  for (let i = 0; i < 8; i++) { await json(`${MB}/mock/add-set?doc=111&name=Extra${i}`); await json(`${MB}/mock/add-set?doc=222&name=Extra${i}`); }
  const w8 = await until(async () => { const x = await g("/state"); return /Layer Sets: the keys show the first 8/.test(x.warning ?? "") ? x : null; }, 7000);
  check(!!w8 && w8.lookSlots === 8, `S1. ${w8?.layerSetsAll?.length} Layer Sets → warning ${JSON.stringify((w8?.warning ?? "").match(/\d+ Layer Sets[^;]*/)?.[0])}`);
  // NEXT ties: from "Speaker Wide", Slides PiP and Two Shot each follow twice
  await json(`${MB}/mock/add-set?doc=111&name=${enc("Two Shot")}`); await json(`${MB}/mock/add-set?doc=222&name=${enc("Two Shot")}`);
  for (const to of ["Slides PiP", "Two Shot", "Slides PiP", "Two Shot"]) {
    await g(`/pvw/layer-set/${enc(to)}`); await g("/take"); await sleep(1000);
    await g(`/pvw/layer-set/${enc("Speaker Wide")}`); await g("/take"); await sleep(1000);
  }
  st = await g("/state");
  check(JSON.stringify([...(st.history?.top ?? [])].sort()) === '["Slides PiP","Two Shot"]' && st.history?.left === 4, `S2. tie → every tied look is NEXT: ${JSON.stringify(st.history)}`);
  check(st.onAir?.since && Date.now() - st.onAir.since < 3000 && st.onAir.look === "Speaker Wide", `S3. on air for: "${st.onAir?.look}" since ${st.onAir?.since ? Date.now() - st.onAir.since : "?"} ms`);
  const recOn = st.outputs?.rec, streamNone = st.outputs?.stream;
  const rec = (await json(`${MB}/documents/333/output-destinations`)).data[0];
  await json(`${MB}/documents/333/output-destinations/${rec.id}/setOff`);
  const recOff = await until(async () => { const x = await g("/state"); return x.outputs?.rec === false ? x : null; }, 2500);
  check(recOn === true && streamNone === null && !!recOff, `S4. REC lamp: live → ${recOn}, off → ${recOff?.outputs?.rec}; no streaming output → ${streamNone}`);
  await json(`${MB}/documents/222/setOff`);
  const t1 = Date.now();
  const off = await until(async () => { const x = await g("/state"); return x.docs?.B?.live === "off" ? x : null; }, 3000, 50);
  const offMs = Date.now() - t1;
  await json(`${MB}/documents/222/setLive`);
  check(!!off && offMs <= 1500, `S5. B's show stopped → /state.docs.B.live "off" after ${offMs} ms`);
  await g("/panic"); await sleep(400);
  st = await g("/state");
  check(st.lastLine === `PANIC: SAFE on air. Next TAKE goes to document ${st.pvw}`, `S6. LAST in SAFE: ${JSON.stringify(st.lastLine)}`);

  // ================================================================ P: the page in Chrome
  s = await phase();
  const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", PORT = 9335;
  const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), "abswitch-r3c-"))}`, "--no-first-run", "--disable-extensions", "about:blank"], { stdio: "ignore" });
  procs.push(chrome);
  let target = null;
  for (let i = 0; i < 50 && !target; i++) { await sleep(200); target = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((x) => x.json()).then((l) => l.find((t) => t.type === "page")).catch(() => null); }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res) => (ws.onopen = res));
  let n = 0; const waiting = new Map();
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && waiting.has(d.id)) { waiting.get(d.id)(d); waiting.delete(d.id); } };
  const cdp = (method, params = {}) => new Promise((res) => { const id = ++n; waiting.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
  const ev = async (x) => (await cdp("Runtime.evaluate", { expression: x, returnByValue: true })).result.result.value;
  const key = async (k) => { await cdp("Input.dispatchKeyEvent", { type: "keyDown", key: k, text: k }); await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: k }); };
  await cdp("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await cdp("Page.enable");
  await cdp("Page.navigate", { url: T + "/" });
  await sleep(3000);
  const stale = () => ev(`[document.getElementById("pgmMon").dataset.stale || "", document.getElementById("pvwMon").dataset.stale || "", document.getElementById("pvwStaleWhy").textContent]`);
  const s0 = await stale();
  await json(`${MB}/documents/222/setOff`); // Preview is B
  await sleep(2000);
  const s1 = await stale();
  await json(`${MB}/documents/222/setLive`);
  await sleep(2000);
  const s2 = await stale();
  await json(`${MB}/mock/stall?doc=333&on=1`); // MASTER's stills stop arriving
  await sleep(2200);
  const s3 = await stale();
  await json(`${MB}/mock/stall?doc=333&on=0`);
  await sleep(2000);
  const s4 = await stale();
  check(!s0[0] && !s0[1] && s1[1] === "1" && /show not running/.test(s1[2]) && !s2[1] && s3[0] === "1" && !s4[0],
    `P1. STALE: at rest ${JSON.stringify(s0)}; B's show stopped → Preview ${JSON.stringify(s1)}; started → ${JSON.stringify(s2)}; MASTER's stills stalled → Program ${JSON.stringify(s3)}; resumed → ${JSON.stringify(s4)}`);
  t0 = await now();
  await key("1");
  await sleep(800);
  L = await log(t0);
  const sel = await ev(`document.querySelector("#pvwBus .pvwkey[data-sel='1']")?.dataset.name`);
  check(at(L, /^PH-B recall Speaker Wide$/) && sel === "Speaker Wide", `P2. key "1" → Preview recall of slot 1: ${fmt(all(L, /recall/), t0)}; selected key ${JSON.stringify(sel)}`);
  await cdp("Page.navigate", { url: T + "/?view=monitor" });
  await sleep(2500);
  const vb = await ev(`[...document.querySelectorAll("button")].filter(b => b.offsetParent).length`);
  t0 = await now();
  await key(" "); await key("2");
  await sleep(1000);
  L = await log(t0);
  check(vb === 0 && !all(L, /MASTER (cut|dissolve)|recall/).length, `P3. /?view=monitor: ${vb} buttons; Space and "2" sent nothing: ${fmt(L, t0) || "(no commands)"}`);
  ws.close();
} finally {
  await stopAll();
  say(fails ? `${fails} FAIL(S)` : "ALL PASS");
  writeFileSync(join(OUT, "round3-offline-check.txt"), out.join("\n") + "\n");
}
process.exit(fails ? 1 : 0);
