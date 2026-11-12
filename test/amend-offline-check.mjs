#!/usr/bin/env node
// amend-offline-check: the pen's ruling on round 1 (2026-11-11), against test/mock-mimolive.mjs.
//   node test/amend-offline-check.mjs        (nothing else on :8991 or :18989)
// W. Save and Start Over from another host (this Mac's LAN address) → 403; Start Over refused while
//    MASTER's show runs, then allowed: dated backup, setup mode, a fresh Save runs again.
// N. PANIC while not ready: A's document missing → /state says PANIC is armed and /panic lands A;
//    MASTER missing → /panic answers 503.
// X. mimoLive lost after a ready start → not-ready; back → running, PGM read from the switcher
//    (the mock restarts on slot 1 while takectl last commanded B).
// E. Source-tally fallback with a source stuck at "program": "in flight" expires after 6 s → last
//    commanded PGM, permanent warning, TALLY follows; PANIC answers ok:false, sent:true, "cut to A sent,
//    cannot confirm", quickly. Never ok:true unconfirmed, never a hang.
// P. Password set: the datastore write carries the header (the mock refuses requests without it).
// D. NDI link (proposal 1): B's source disconnected → doctor red for B and a TAKE to B refused with the
//    reason; A's source disconnected while A is on air → a TAKE away from A is allowed.
// TAKECTL_DIR=<dir> runs another takectl.mjs (falsification against the build before the ruling).
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { networkInterfaces, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.TAKECTL_DIR || dirname(HERE);
const OUT = process.env.TAKECTL_DIR ? join(ROOT, "out") : HERE;
mkdirSync(OUT, { recursive: true });
const MP = 18989, MOCK = `http://localhost:${MP}`, MB = `${MOCK}/api/v1`, T = "http://localhost:8991";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const json = async (u, o = {}) => { try { const r = await fetch(u, { ...o, signal: AbortSignal.timeout(o.timeout ?? 8000) }); const t = await r.text(); try { return { status: r.status, ...JSON.parse(t) }; } catch { return { status: r.status, raw: t }; } } catch (e) { return { status: 0, error: String(e) }; } };
const post = (u, body) => json(u, { method: "POST", headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
const out = [];
const say = (s) => { out.push(s); console.log(s); };
let fails = 0;
const check = (ok, what) => { if (!ok) fails++; say(`${ok ? "PASS" : "FAIL"}  ${what}`); };
const until = async (fn, ms) => { const t = Date.now(); while (Date.now() - t < ms) { const v = await fn(); if (v) return v; await sleep(200); } return null; };
const lan = Object.values(networkInterfaces()).flat().find((i) => i && i.family === "IPv4" && !i.internal)?.address;

const dir = mkdtempSync(join(tmpdir(), "abswitch-amend-"));
const procs = [];
const startMock = (...flags) => { const p = spawn("node", [join(HERE, "mock-mimolive.mjs"), String(MP), ...flags], { stdio: "ignore" }); procs.push(p); return p; };
const startTk = (cfgFile) => { const p = spawn("node", [join(ROOT, "takectl.mjs")], { env: { ...process.env, TAKECTL_CONFIG: cfgFile }, stdio: "ignore" }); procs.push(p); return p; };
const stop = async (p) => { if (p && p.exitCode === null && p.signalCode === null) { const g = new Promise((r) => p.once("exit", r)); p.kill(); await g; } };
const cfg = (o = {}) => {
  const c = JSON.parse(readFileSync(join(ROOT, "takectl.config.example.json"), "utf8"));
  for (const k of ["a", "b", "master"]) c[k].host = MOCK;
  c.a.documentName = "PH-A"; c.b.documentName = "PH-B"; c.master.documentName = "PH-MASTER";
  c.companion = { host: null };
  return Object.assign(c, o);
};
const writeCfg = (name, c) => { const f = join(dir, name); writeFileSync(f, JSON.stringify(c, null, 2)); return f; };
const ready = (ms = 9000) => until(async () => { const s = await json(`${T}/state`); return s.ready !== false && s.pgm ? s : null; }, ms);
const mockSlot = async () => (await json(`${MB}/mock/state`)).slot; // the mock's real slot, even with the keys hidden
const mockTally = async (doc) => (await json(`${MB}/documents/${doc}/layers`)).data?.find((l) => l.attributes.name === "TALLY")?.attributes["live-state"];

try {
  // ---- W: loopback-only save and Start Over
  let mock = startMock();
  await sleep(500);
  const wFile = join(dir, "w.config.json");
  let tk = startTk(wFile);
  await until(async () => (await json(`${T}/state`)).status, 6000);
  const body = { a: { host: MOCK, documentName: "PH-A.tvshow" }, b: { host: MOCK, documentName: "PH-B.tvshow" },
    master: { host: MOCK, documentName: "PH-MASTER.tvshow", sourceNameA: "NDI PH-A", sourceNameB: "NDI PH-B" }, switcherLayerName: "AB Switcher" };
  const remote = lan ? await post(`http://${lan}:8991/setup/save`, body) : { status: "no LAN address" };
  const local = await post(`${T}/setup/save`, body);
  await ready();
  const remoteOver = lan ? await post(`http://${lan}:8991/setup/start-over`) : { status: "no LAN address" };
  check(remote.status === 403 && /Mac running takectl/.test(remote.error ?? "") && local.ok && remoteOver.status === 403,
    `W1. from the LAN address: Save → ${remote.status} ${JSON.stringify(remote.error)}; Start Over → ${remoteOver.status}; from loopback Save → ${local.ok ? "ok" : JSON.stringify(local)}`);
  const refused = await post(`${T}/setup/start-over`);
  await json(`${MB}/documents/333/setOff`);
  const over = await post(`${T}/setup/start-over`);
  const st = await json(`${T}/state`);
  const backups = readdirSync(dir).filter((f) => f.startsWith("w.config.backup-"));
  const again = await post(`${T}/setup/save`, body);
  await json(`${MB}/documents/333/setLive`);
  const back = await ready();
  // The backup's name is in this Mac's local time (ruling 2026-11-11, proposal 2): within 2 minutes of now.
  const bm = backups[0]?.match(/backup-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/);
  const stampLocal = bm ? new Date(+bm[1], +bm[2] - 1, +bm[3], +bm[4], +bm[5], +bm[6]) : null;
  const localOk = !!stampLocal && Math.abs(Date.now() - stampLocal) < 120000;
  check(refused.status === 409 && /Stop the show/.test(refused.error ?? "") && over.ok && backups.length === 1 && localOk && !existsSync(wFile.replace(".json", ".json.x")) && st.mode === "setup" && again.ok && back?.pgm,
    `W2. Start Over with MASTER live → ${refused.status} ${JSON.stringify(refused.error)}; stopped → ${JSON.stringify(over)}, backups ${JSON.stringify(backups)} (local time: ${localOk}), mode ${st.mode}; Save again → running pgm ${back?.pgm}`);
  await stop(tk);

  // ---- N: PANIC while not ready
  tk = startTk(writeCfg("n.config.json", cfg({ a: { host: MOCK, documentName: "PH-A-missing" } })));
  const nr = await until(async () => { const s = await json(`${T}/state`); return s.ready === false && s.panicArmed ? s : null; }, 9000);
  await json(`${MB}/documents/333/layers/SWITCH00-0000-4000-8000-000000000000/signals/tvGroup_Control__Cut_2_TypeSignal`);
  const s2 = await mockSlot();
  const take = await json(`${T}/take`);
  const p = await json(`${T}/panic`);
  const s1 = await mockSlot();
  check(nr && take.status === 503 && s2 === 2 && p.ok === true && s1 === 1,
    `N1. A missing: ready=${nr?.ready} panicArmed=${nr?.panicArmed} (${nr?.startError}); /take → ${take.status}; mock slot ${s2} → /panic ${JSON.stringify({ ok: p.ok, rounds: p.rounds })} → slot ${s1}`);
  await stop(tk);
  tk = startTk(writeCfg("n2.config.json", cfg({ master: { ...cfg().master, documentName: "PH-MASTER-missing" } })));
  await until(async () => (await json(`${T}/state`)).status, 6000);
  await sleep(1500);
  const p2 = await json(`${T}/panic`);
  check(p2.status === 503 && /MASTER is not reachable/.test(p2.error ?? ""), `N2. MASTER missing: /panic → ${p2.status} ${JSON.stringify(p2.error)}`);
  await stop(tk);

  // ---- X: lost and back
  tk = startTk(writeCfg("x.config.json", cfg()));
  await ready();
  await json(`${T}/take`);
  await sleep(1500);
  const before = await json(`${T}/state`);
  await stop(mock);
  const lost = await until(async () => { const s = await json(`${T}/state`); return s.ready === false ? s : null; }, 9000);
  mock = startMock();
  const recovered = await ready(12000);
  check(before.pgm === "B" && lost?.mode === "starting" && recovered?.pgm === "A" && (await mockSlot()) === 1,
    `X1. running on B; mock gone → ready=${lost?.ready} mode=${lost?.mode} (${lost?.startError}); mock back on slot 1 → running, pgm ${recovered?.pgm} (from the switcher, not the commanded B)`);
  await stop(tk);
  await stop(mock);

  // ---- E: fallback with a stuck source
  mock = startMock("--no-slot-keys", "--stick-program=A");
  await sleep(500);
  tk = startTk(writeCfg("e.config.json", cfg()));
  const e0 = await ready();
  const t0 = Date.now();
  await json(`${T}/take`);
  const e1 = await until(async () => { const s = await json(`${T}/state`); return /source tally unreliable/.test(s.warning ?? "") ? s : null; }, 9000);
  const e1at = Date.now() - t0;
  const tA = await mockTally("111"), tB = await mockTally("222");
  check(e0?.truth === "source tally" && e1 && e1.pgm === "B" && tB === "live" && tA === "off" && e1at >= 6000,
    `E1. stuck A: TAKE → after ${e1at} ms warning ${JSON.stringify(e1?.warning)}; pgm ${e1?.pgm}; TALLY A=${tA} B=${tB}`);
  const tp = Date.now();
  const ep = await json(`${T}/panic`, { timeout: 6000 });
  const pms = Date.now() - tp;
  const e2 = await json(`${T}/state`);
  check(ep.ok === false && ep.sent === true && /cut to A sent, cannot confirm/.test(ep.error ?? "") && pms < 3000 && e2.pgm === "A" && (await mockSlot()) === 1 && /source tally unreliable/.test(e2.warning ?? ""),
    `E2. /panic → ${JSON.stringify({ ok: ep.ok, sent: ep.sent, error: ep.error })} in ${pms} ms; pgm ${e2.pgm}, mock slot ${await mockSlot()}, warning kept`);
  await stop(tk);
  await stop(mock);

  // ---- P: password
  const PW = "0f".repeat(32);
  mock = startMock(`--require-password=${PW}`);
  await sleep(500);
  tk = startTk(writeCfg("p.config.json", cfg({ apiPasswordSha256: PW })));
  const p0 = await ready();
  await json(`${T}/take`);
  await sleep(1500);
  const store = await json(`${MB}/documents/333/datastores/abswitch-state`, { headers: { "X-MimoLive-Password-SHA256": PW } });
  check(p0 && store.pgm === "B", `P1. password set: running (pgm ${p0?.pgm}); after /take the datastore holds ${JSON.stringify({ pgm: store.pgm, status: store.status })}`);
  await stop(tk);
  await stop(mock);

  // ---- D: NDI link in preflight and doctor
  mock = startMock("--disconnected=B");
  await sleep(500);
  tk = startTk(writeCfg("d.config.json", cfg()));
  await ready();
  const dd = await json(`${T}/doctor.json`);
  const linkB = dd.checks?.find((c) => c.id === "ndilink-B");
  const refusedB = await json(`${T}/take`);
  check(linkB?.ok === false && /not receiving B's NDI/.test(linkB?.fix ?? "") && refusedB.ok === false && /not receiving B's NDI/.test(refusedB.error ?? ""),
    `D1. B disconnected: doctor "${linkB?.label}" red; TAKE to B → ${JSON.stringify(refusedB.error)}`);
  await stop(tk);
  await stop(mock);
  mock = startMock("--disconnected=A");
  await sleep(500);
  tk = startTk(writeCfg("d2.config.json", cfg()));
  const d0 = await ready();
  const away = await json(`${T}/take`);
  await sleep(1300);
  const d1 = await json(`${T}/state`);
  check(d0?.pgm === "A" && away.ok === true && d1.pgm === "B", `D2. A disconnected while A is on air: TAKE away to B → ${JSON.stringify({ ok: away.ok })}, pgm ${d1.pgm}`);
} finally {
  for (const p of procs.reverse()) await stop(p);
  say(fails ? `${fails} FAIL(S)` : "ALL PASS");
  writeFileSync(join(OUT, "amend-offline-check.txt"), out.join("\n") + "\n");
}
process.exit(fails ? 1 : 0);
