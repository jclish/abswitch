#!/usr/bin/env node
// safe-check: the safe source for PANIC on the real mimoLive (ruling 2026-11-11). PH-A, PH-B, PH-MASTER
// open, "SAFE Test Pattern" in AB Switcher slot 3 (documents/build-documents.mjs), takectl NOT running.
//   node test/safe-check.mjs
// P  PANIC 0, 200 and 600 ms after TAKE is pressed, under the stinger, and 200 ms into a dissolve started
//    outside takectl: SAFE confirmed in slot 3, /state pgm "SAFE", both TALLYs off, B never on air when
//    PANIC beat the signal (the switcher's slot polled every 25 ms).
// T  TAKE and CUT out of SAFE to A and to B (target chosen with /safe/target).
// O  slot 3 and the empty slot 4 selected outside takectl (signals sent straight to the switcher, as a
//    click in mimoLive would): SAFE, then OTHER naming slot 9; a TAKE out of OTHER.
// A  PANIC while SAFE is on air: ok without a cut (the slot never leaves 3).
// N  no safe source configured: PANIC from B lands on A.
// Starts the shows (Recording off); restores slot 1, TALLY off, STINGER off, shows as found.
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
const B = "http://localhost:8989/api/v1", T = "http://localhost:8991";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const req = async (u, timeout = 15000) => { try { const r = await fetch(u, { signal: AbortSignal.timeout(timeout) }); const t = await r.text(); try { return { status: r.status, ...JSON.parse(t) }; } catch { return { status: r.status, raw: t }; } } catch (e) { return { status: 0, error: String(e) }; } };
const j = (p) => req(B + p);
const g = (p) => req(T + p);
const out = [];
const say = (s) => { out.push(s); console.log(s); };
let fails = 0;
const check = (ok, what) => { if (!ok) fails++; say(`${ok ? "PASS" : "FAIL"}  ${what}`); };
const until = async (fn, ms, every = 100) => { const t = Date.now(); while (Date.now() - t < ms) { const v = await fn(); if (v) return v; await sleep(every); } return null; };

const docs = (await j("/documents")).data;
const D = Object.fromEntries(["PH-A", "PH-B", "PH-MASTER"].map((n) => [n, docs.find((d) => d.attributes.name.replace(/\.tvshow$/, "") === n)]));
const M = D["PH-MASTER"].id;
const was = Object.fromEntries(Object.entries(D).map(([n, d]) => [n, d.attributes["live-state"]]));
const ml = (await j(`/documents/${M}/layers`)).data;
const sw = ml.find((l) => l.attributes.name === "AB Switcher"), stingerL = ml.find((l) => l.attributes.name === "STINGER");
const swIv = async () => (await j(`/documents/${M}/layers/${sw.id}`)).data.attributes["input-values"];
const slot = async () => (await swIv()).tvGroup_Hidden_Inputs__currentLiveSource;
const sig = (k) => j(`/documents/${M}/layers/${sw.id}/signals/tvGroup_Control__${k}_TypeSignal`);
const tallyOf = async (n) => (await j(`/documents/${D[n].id}/layers`)).data.find((l) => l.attributes.name === "TALLY").attributes["live-state"];
const tallies = async () => `${await tallyOf("PH-A")}/${await tallyOf("PH-B")}`;
const iv0 = await swIv();
const safeSrc = (await j(`/documents/${M}/sources`)).data.find((s) => s.attributes.name === "SAFE Test Pattern");
if (!safeSrc || !String(iv0.tvIn_VideoSourceCImage ?? "").endsWith(safeSrc.id.split("-").slice(1).join("-"))) {
  console.error('PH-MASTER needs "SAFE Test Pattern" in AB Switcher slot 3: run documents/build-documents.mjs'); process.exit(2);
}

const dir = mkdtempSync(join(tmpdir(), "abswitch-safe-real-"));
const real = JSON.parse(readFileSync(join(dirname(HERE), "takectl.config.json"), "utf8"));
let tk = null;
const startTk = async (over = {}) => {
  const f = join(dir, `c${Date.now()}.json`);
  writeFileSync(f, JSON.stringify({ ...real, ...over, master: { ...real.master, sourceNameSafe: "SAFE Test Pattern", ...(over.master ?? {}) } }, null, 2));
  tk = spawn("node", [join(ROOT, "takectl.mjs")], { env: { ...process.env, TAKECTL_CONFIG: f }, stdio: "ignore" });
  return until(async () => { const s = await g("/state"); return s.ready !== false && s.pgm ? s : null; }, 12000, 250);
};
const stopTk = async () => { if (tk && tk.exitCode === null && tk.signalCode === null) { const w = new Promise((r) => tk.once("exit", r)); tk.kill(); await w; } tk = null; };
// The switcher's slot every 25 ms while fn runs: which slots were ever live.
const watchSlots = async (ms, fn) => { const seen = []; let done = false; const w = (async () => { const t0 = Date.now(); while (!done || Date.now() - t0 < ms) { const v = await slot(); if (seen.at(-1)?.v !== v) seen.push({ t: Date.now() - t0, v }); await sleep(25); if (Date.now() - t0 > ms + 4000) break; } })(); const r = await fn(); await sleep(ms); done = true; await w; return { r, seen }; };
const toA = async () => { const s = await g("/state"); if (s.pgm === "A") return; if (s.pgm === "SAFE" || s.pgm === "OTHER") await g("/safe/target?doc=A"); await g("/cut"); await sleep(900); };

try {
  for (const n of ["PH-A", "PH-B", "PH-MASTER"]) if (was[n] !== "live") await j(`/documents/${D[n].id}/setLive`);
  await sleep(2500);
  const rec = (await j(`/documents/${M}/output-destinations`)).data.find((o) => o.attributes.title === "Recording");
  if (rec) await j(`/documents/${M}/output-destinations/${rec.id}/setOff`);
  if ((await slot()) !== 1) { await sig("Cut_1"); await sleep(800); }
  let s = await startTk();
  check(!!s && s.safe?.configured && s.safe?.slot === "3", `setup: takectl running (pgm ${s?.pgm}), safe source ${JSON.stringify(s?.safe?.source)} in slot ${s?.safe?.slot}`);

  // ---- P: PANIC to SAFE
  for (const ms of [0, 200, 600]) {
    await toA();
    const { r, seen } = await watchSlots(1200, async () => { const take = g("/take"); await sleep(ms); const p = await g("/panic"); return { p, take: await take }; });
    await sleep(600);
    const st = await g("/state");
    const tl = await tallies();
    const bLive = seen.some((x) => x.v === 2);
    check(r.p.ok && r.p.pgm === "SAFE" && (await slot()) === 3 && st.pgm === "SAFE" && tl === "off/off" && (ms === 0 ? !bLive : true),
      `P${ms}. PANIC ${ms} ms after TAKE → ${JSON.stringify({ ok: r.p.ok, pgm: r.p.pgm, rounds: r.p.rounds, ms: r.p.ms })}; slots seen ${seen.map((x) => `${x.t}:${x.v}`).join(" ")}; TALLY ${tl}; target ${st.pvw}; take → ${JSON.stringify(r.take.error ?? r.take.transition)}`);
  }
  await stopTk();
  await toA().catch(() => {});
  if ((await slot()) !== 1) { await sig("Cut_1"); await sleep(800); }
  s = await startTk({ stinger: true });
  {
    const { r, seen } = await watchSlots(1200, async () => { const take = g("/take"); await sleep(200); const p = await g("/panic"); return { p, take: await take }; });
    await sleep(900);
    const st = await g("/state");
    const sting = (await j(`/documents/${M}/layers/${stingerL.id}`)).data.attributes["live-state"];
    check(r.p.ok && (await slot()) === 3 && !seen.some((x) => x.v === 2) && /under the stinger; signal not sent/.test(r.take.error ?? "") && sting === "off" && (await tallies()) === "off/off",
      `P-stinger. PANIC 200 ms into a stinger TAKE: take → ${JSON.stringify(r.take.error)}; slots seen ${seen.map((x) => `${x.t}:${x.v}`).join(" ")} (B never live); STINGER ${sting}; target ${st.pvw}`);
  }
  await stopTk();
  s = await startTk();
  await toA();
  {
    const { r, seen } = await watchSlots(1500, async () => { await sig("Dis_2"); await sleep(200); return g("/panic"); });
    await sleep(400);
    check(r.ok && r.rounds >= 2 && (await slot()) === 3 && (await g("/state")).pgm === "SAFE",
      `P-outside. PANIC 200 ms into a dissolve to B started outside takectl → ${JSON.stringify({ ok: r.ok, rounds: r.rounds, ms: r.ms })}; slots seen ${seen.map((x) => `${x.t}:${x.v}`).join(" ")}`);
  }

  // ---- T: TAKE and CUT out of SAFE
  for (const [route, doc] of [["/take", "A"], ["/cut", "B"], ["/cut", "A"], ["/take", "B"]]) {
    if ((await g("/state")).pgm !== "SAFE") { await g("/panic"); await sleep(500); }
    await g(`/safe/target?doc=${doc}`);
    const pv = (await g("/state")).pvw;
    const r = await g(route);
    await sleep(1400);
    const st = await g("/state");
    const tl = await tallies();
    const want = doc === "A" ? 1 : 2;
    check(pv === doc && r.ok && (await slot()) === want && st.pgm === doc && tl === (doc === "A" ? "live/off" : "off/live") && st.undo?.available === false,
      `T. ${route.slice(1).toUpperCase()} out of SAFE → ${doc}: ${r.transition}; slot ${await slot()}; pgm ${st.pgm}; TALLY ${tl}; UNDO ${JSON.stringify(st.undo?.why)}`);
  }

  // ---- O: slots 3 and 4 selected outside takectl
  await toA();
  await sig("Cut_3");
  const o1 = await until(async () => { const x = await g("/state"); return x.pgm === "SAFE" ? x : null; }, 4000);
  await sleep(900);
  const tl1 = await tallies();
  await sig("Cut_4");
  const o2 = await until(async () => { const x = await g("/state"); return x.pgm === "OTHER" ? x : null; }, 4000);
  const pushO = await g("/push");
  const tk2 = await g("/take");
  await sleep(1400);
  const o3 = await g("/state");
  check(o1?.pvw === "B" && tl1 === "off/off" && o2?.safe?.otherSlot === 9 && /something else is on air: switcher slot 9/.test(o2?.warning ?? "") && pushO.ok === false && tk2.ok && o3.pgm === "B" && (await slot()) === 2,
    `O. Cut_3 outside → ${o1?.pgm}, target ${o1?.pvw}, TALLY ${tl1}; Cut_4 (empty) → ${o2?.pgm} slot ${o2?.safe?.otherSlot}, warning ${JSON.stringify(o2?.warning)}; PUSH → ${JSON.stringify(pushO.error)}; TAKE → ${o3.pgm} (slot ${await slot()})`);

  // ---- A: PANIC while SAFE is on air
  await g("/panic"); await sleep(600);
  {
    const { r, seen } = await watchSlots(600, () => g("/panic"));
    check(r.ok && r.already === true && r.rounds === 0 && seen.every((x) => x.v === 3), `A. PANIC with SAFE on air → ${JSON.stringify({ ok: r.ok, already: r.already, rounds: r.rounds, ms: r.ms })}; slots seen ${seen.map((x) => `${x.t}:${x.v}`).join(" ")}`);
  }
  await stopTk();

  // ---- N: no safe source configured
  await sig("Cut_2"); await sleep(800);
  s = await startTk({ master: { sourceNameSafe: null } });
  const p = await g("/panic");
  await sleep(500);
  check(s?.pgm === "B" && p.ok && p.pgm === "A" && (await slot()) === 1, `N. no safe source, B on air: PANIC → ${JSON.stringify({ ok: p.ok, pgm: p.pgm, rounds: p.rounds })}; slot ${await slot()}`);
} finally {
  await stopTk();
  if ((await slot()) !== 1) { await sig("Cut_1"); await sleep(600); }
  if (stingerL) await j(`/documents/${M}/layers/${stingerL.id}/setOff`);
  for (const n of ["PH-A", "PH-B"]) { const t = (await j(`/documents/${D[n].id}/layers`)).data.find((l) => l.attributes.name === "TALLY"); await j(`/documents/${D[n].id}/layers/${t.id}/setOff`); }
  await sleep(800);
  for (const n of ["PH-MASTER", "PH-A", "PH-B"]) if (was[n] !== "live") await j(`/documents/${D[n].id}/setOff`);
  say(`restored: slot ${await slot()}, TALLY ${await tallies()}, shows ${JSON.stringify(was)}`);
  say(fails ? `${fails} FAIL(S)` : "ALL PASS");
  writeFileSync(join(OUT, "safe-check.txt"), out.join("\n") + "\n");
}
process.exit(fails ? 1 : 0);
