#!/usr/bin/env node
// amend-check: the pen's ruling on round 1 (2026-11-11), on the real mimoLive.
//   node test/amend-check.mjs          (PH-A, PH-B, PH-MASTER open; takectl NOT running; MASTER on slot 1)
// N. PANIC while not ready: a config whose A document does not exist → /state says not ready with PANIC
//    armed; MASTER cut to slot 2 by hand; /panic lands A.
// X. mimoLive lost after a ready start: takectl reaches mimoLive through a TCP relay this test owns.
//    Relay down → not ready; MASTER cut to B directly; relay up → running again with PGM B read from
//    the switcher.
// L. (opt-in, AMEND_NDI_LINK=1: it crashed mimoLive once) NDI link (proposal 1): B's sender stopped with the 7.0b3 same-title fault → doctor red for B and a
//    TAKE to B refused with the reason; A's sender stopped instead → a TAKE away from A is allowed.
//    Each sender is restored by renaming its output away and back.
// W. Save and Start Over from this Mac's LAN address → 403; Start Over on loopback refused while
//    MASTER's show runs, done once it is stopped (on a copy of the config; the real one is untouched).
// Starts the shows (MASTER's Recording off) and restores shows, slot, TALLY and NDI output titles.
// TAKECTL_DIR=<dir> runs another takectl.mjs.
import { spawn } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { networkInterfaces, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.TAKECTL_DIR || dirname(HERE);
const OUT = process.env.TAKECTL_DIR ? join(ROOT, "out") : HERE;
mkdirSync(OUT, { recursive: true });
const H = "http://localhost:8989", B = `${H}/api/v1`, T = "http://localhost:8991", RELAY = 18990;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const req = async (method, u, body, timeout = 8000) => { try { const r = await fetch(u, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(timeout) }); const t = await r.text(); try { return { status: r.status, ...JSON.parse(t) }; } catch { return { status: r.status, raw: t }; } } catch (e) { return { status: 0, error: String(e) }; } };
const j = (u) => req("GET", u);
const out = [];
const say = (s) => { out.push(s); console.log(s); };
let fails = 0;
const check = (ok, what) => { if (!ok) fails++; say(`${ok ? "PASS" : "FAIL"}  ${what}`); };
const until = async (fn, ms) => { const t = Date.now(); while (Date.now() - t < ms) { const v = await fn(); if (v) return v; await sleep(250); } return null; };
const lan = Object.values(networkInterfaces()).flat().find((i) => i && i.family === "IPv4" && !i.internal)?.address;

const docs = (await j(`${B}/documents`)).data;
const id = (n) => docs.find((d) => d.attributes.name.replace(/\.tvshow$/, "") === n).id;
const D = { A: id("PH-A"), B: id("PH-B"), M: id("PH-MASTER") };
const live = async (r) => (await j(`${B}/documents/${D[r]}`)).data.attributes["live-state"];
const sw = (await j(`${B}/documents/${D.M}/layers`)).data.find((l) => l.attributes.name === "AB Switcher");
const slot = async () => (await j(`${B}/documents/${D.M}/layers/${sw.id}`)).data.attributes["input-values"].tvGroup_Hidden_Inputs__currentLiveSource;
const cut = (n) => j(`${B}/documents/${D.M}/layers/${sw.id}/signals/tvGroup_Control__Cut_${n}_TypeSignal`);
const ndiOut = async (r) => (await j(`${B}/documents/${D[r]}/output-destinations`)).data.find((o) => o.attributes["output-destination-type"].endsWith(".ndi"));
const rename = (r, oid, title) => req("PATCH", `${B}/documents/${D[r]}/output-destinations/${oid}`, { data: { attributes: { title } } });
const connected = async (r) => (await j(`${B}/documents/${D.M}/sources`)).data.find((s) => s.attributes.name === `NDI PH-${r}`).attributes["video-device-connected"];
const was = { A: await live("A"), B: await live("B"), M: await live("M"), slot: await slot(), titles: { A: (await ndiOut("A")).attributes.title, B: (await ndiOut("B")).attributes.title } };
const shows = async (on) => {
  for (const r of on ? ["A", "B", "M"] : ["M", "A", "B"]) await j(`${B}/documents/${D[r]}/${on ? "setLive" : "setOff"}`);
  await sleep(on ? 2500 : 1200);
  if (on) { const rec = (await j(`${B}/documents/${D.M}/output-destinations`)).data.find((o) => o.attributes.title === "Recording"); await j(`${B}/documents/${D.M}/output-destinations/${rec.id}/setOff`); }
};
const dir = mkdtempSync(join(tmpdir(), "abswitch-amend-real-"));
const real = JSON.parse(readFileSync(join(dirname(HERE), "takectl.config.json"), "utf8"));
const writeCfg = (name, c) => { const f = join(dir, name); writeFileSync(f, JSON.stringify(c, null, 2)); return f; };
const procs = [];
const startTk = (cfgFile) => { const p = spawn("node", [join(ROOT, "takectl.mjs")], { env: { ...process.env, TAKECTL_CONFIG: cfgFile }, stdio: "ignore" }); procs.push(p); return p; };
const stop = async (p) => { if (p && p.exitCode === null && p.signalCode === null) { const g = new Promise((r) => p.once("exit", r)); p.kill(); await g; } };
const ready = (ms = 10000) => until(async () => { const s = await j(`${T}/state`); return s.ready !== false && s.pgm ? s : null; }, ms);
// A relay that looks like mimoLive to takectl: TCP straight through to :8989, HTTP and WebSocket alike.
let relay = null, sockets = new Set();
const relayUp = () => new Promise((r) => { relay = createServer((c) => { const m = createConnection(8989, "localhost"); sockets.add(c); sockets.add(m); c.pipe(m); m.pipe(c); const end = () => { c.destroy(); m.destroy(); }; c.on("error", end); m.on("error", end); c.on("close", end); m.on("close", end); }); relay.listen(RELAY, r); });
const relayDown = () => new Promise((r) => { for (const s of sockets) s.destroy(); sockets.clear(); relay.close(r); });

try {
  await shows(true);
  if ((await slot()) !== 1) { await cut(1); await sleep(800); }

  // ---- N: PANIC while not ready
  let tk = startTk(writeCfg("n.json", { ...real, a: { ...real.a, documentName: "PH-A-missing" } }));
  const nr = await until(async () => { const s = await j(`${T}/state`); return s.ready === false && s.panicArmed ? s : null; }, 10000);
  await cut(2); await sleep(800);
  const s2 = await slot();
  const take = await j(`${T}/take`);
  const p = await j(`${T}/panic`);
  const s1 = await slot();
  check(nr && take.status === 503 && s2 === 2 && p.ok === true && s1 === 1,
    `N. A's document missing: ready=${nr?.ready}, panicArmed=${nr?.panicArmed}; /take → ${take.status}; slot ${s2} → /panic ${JSON.stringify({ ok: p.ok, rounds: p.rounds })} → slot ${s1}`);
  await stop(tk);

  // ---- X: lost and back, through the relay
  await relayUp();
  const via = `http://localhost:${RELAY}`;
  tk = startTk(writeCfg("x.json", { ...real, a: { ...real.a, host: via }, b: { ...real.b, host: via }, master: { ...real.master, host: via } }));
  const x0 = await ready();
  await relayDown();
  const t0 = Date.now();
  const lost = await until(async () => { const s = await j(`${T}/state`); return s.ready === false ? s : null; }, 15000);
  const lostMs = Date.now() - t0;
  await cut(2); await sleep(800);
  await relayUp();
  const t1 = Date.now();
  const back = await ready(15000);
  check(x0?.pgm === "A" && lost?.mode === "starting" && back?.pgm === "B" && back?.truth === "switcher live slot",
    `X. running on A; relay down → not ready after ${lostMs} ms (${lost?.startError}); MASTER cut to B directly; relay up → running after ${Date.now() - t1} ms, pgm ${back?.pgm} read from the switcher`);
  await stop(tk);
  await relayDown();
  await cut(1); await sleep(800);

  // ---- L: NDI link. Opt-in only (AMEND_NDI_LINK=1): staging a dead sender re-saves a live NDI output's
  // title, and on 2026-11-11 that crashed mimoLive 7.0b3 (SIGSEGV in its NDI writer; amend-check-run1-crash.txt).
  // The preflight logic itself is tested offline (amend-offline-check, D).
  if (process.env.AMEND_NDI_LINK === "1") {
  tk = startTk(writeCfg("l.json", real));
  await ready();
  const oB = await ndiOut("B");
  await rename("B", oB.id, was.titles.B); // same title: 7.0b3 stops B's sender while the output reports live
  const deadB = await until(async () => ((await connected("B")) === false ? true : null), 12000);
  const dB = await j(`${T}/doctor.json`);
  const linkB = dB.checks?.find((c) => c.id === "ndilink-B");
  const refused = await j(`${T}/take`);
  await rename("B", oB.id, was.titles.B + "x"); await sleep(1500); await rename("B", oB.id, was.titles.B);
  const okB = await until(async () => ((await connected("B")) === true ? true : null), 15000);
  check(deadB && linkB?.ok === false && /not receiving B's NDI/.test(linkB?.fix ?? "") && refused.ok === false && /not receiving B's NDI/.test(refused.error ?? "") && okB,
    `L1. B's sender stopped: doctor "${linkB?.label}" red → "${(linkB?.fix ?? "").slice(0, 60)}…"; TAKE to B → ${JSON.stringify(refused.error)}; restored: connected=${okB}`);
  await sleep(2000);
  const oA = await ndiOut("A");
  await rename("A", oA.id, was.titles.A);
  const deadA = await until(async () => ((await connected("A")) === false ? true : null), 12000);
  const escape = await j(`${T}/take`);
  await sleep(1500);
  const after = await j(`${T}/state`);
  await rename("A", oA.id, was.titles.A + "x"); await sleep(1500); await rename("A", oA.id, was.titles.A);
  const okA = await until(async () => ((await connected("A")) === true ? true : null), 15000);
  check(deadA && escape.ok === true && after.pgm === "B" && okA,
    `L2. A's sender stopped while A is on air: TAKE away to B → ${JSON.stringify({ ok: escape.ok })}, pgm ${after.pgm}; restored: connected=${okA}`);
  await j(`${T}/take`); await sleep(1500);
  await stop(tk);
  } else say("SKIP  L. NDI link staging is opt-in (AMEND_NDI_LINK=1): it crashed mimoLive 7.0b3 once");

  // ---- W: loopback-only Save and Start Over, on a copy of the config
  const copy = join(dir, "w.json"); copyFileSync(join(dirname(HERE), "takectl.config.json"), copy);
  tk = startTk(copy);
  await ready();
  const rSave = lan ? await req("POST", `http://${lan}:8991/setup/save`, {}) : { status: "no LAN" };
  const rOver = lan ? await req("POST", `http://${lan}:8991/setup/start-over`) : { status: "no LAN" };
  const info = lan ? await j(`http://${lan}:8991/setup/info`) : {};
  const refusedOver = await req("POST", `${T}/setup/start-over`);
  await j(`${B}/documents/${D.M}/setOff`); await sleep(1200);
  const over = await req("POST", `${T}/setup/start-over`);
  const st = await j(`${T}/state`);
  const backups = readdirSync(dir).filter((f) => f.startsWith("w.backup-"));
  check(rSave.status === 403 && rOver.status === 403 && info.local === false && refusedOver.status === 409 && over.ok && st.mode === "setup" && backups.length === 1,
    `W. from the LAN address: Save → ${rSave.status}, Start Over → ${rOver.status}, /setup/info local=${info.local}; loopback Start Over with MASTER live → ${refusedOver.status} ${JSON.stringify(refusedOver.error)}; stopped → ${JSON.stringify(over)}, mode ${st.mode}, backup ${backups[0]}`);
} finally {
  if (relay?.listening) await relayDown();
  for (const p of procs.reverse()) await stop(p);
  for (const r of ["A", "B"]) { const o = await ndiOut(r); if (o.attributes.title !== was.titles[r]) await rename(r, o.id, was.titles[r]); }
  if ((await slot()) !== was.slot) { await cut(was.slot); await sleep(800); }
  for (const r of ["A", "B"]) { const t = (await j(`${B}/documents/${D[r]}/layers`)).data.find((l) => l.attributes.name === "TALLY"); await j(`${B}/documents/${D[r]}/layers/${t.id}/setOff`); }
  await sleep(800);
  for (const r of ["M", "A", "B"]) await j(`${B}/documents/${D[r]}/${was[r] === "live" ? "setLive" : "setOff"}`);
  // Restarting MASTER's show (W stopped it) starts its Recording output too: stop it again at once.
  { const rec = (await j(`${B}/documents/${D.M}/output-destinations`)).data.find((o) => o.attributes.title === "Recording"); if (rec) await j(`${B}/documents/${D.M}/output-destinations/${rec.id}/setOff`); }
  await sleep(1000);
  say(`restored: shows ${JSON.stringify({ A: await live("A"), B: await live("B"), M: await live("M") })}, slot ${await slot()}, NDI titles ${JSON.stringify({ A: (await ndiOut("A")).attributes.title, B: (await ndiOut("B")).attributes.title })}, connected A=${await connected("A")} B=${await connected("B")}`);
  say(fails ? `${fails} FAIL(S)` : "ALL PASS");
  writeFileSync(join(OUT, "amend-check.txt"), out.join("\n") + "\n");
}
process.exit(fails ? 1 : 0);
