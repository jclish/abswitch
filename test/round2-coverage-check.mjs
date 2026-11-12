#!/usr/bin/env node
// round2-coverage-check: the round 2 behaviours that change what goes to air and had run only on the mock
// (ruling 2026-11-11), now on the real mimoLive, plus the rehearsal that puts Preview back.
// PH-A, PH-B, PH-MASTER open and live (MASTER's Recording off), takectl NOT running. Needs ffmpeg.
//   node test/round2-coverage-check.mjs
// C1 a pre-hook on the outgoing document: A's Lower Third, live on air, goes off before the switcher moves,
//    and the signal waits waitMs.
// C2 PANIC in the middle of a steps run (original pace, ~1.5 s gaps): one step reaches Program, then
//    nothing more; the run stops.
// C3 CUT with the stinger on, recorded from MASTER's program out: since round 3 a CUT is always bare, so
//    no frame is covered, no frame shows A and B at once, and B appears straight away.
// C4 the stuck-stinger refusal: STINGER live → TAKE refused; STINGER in shutdown (made by a setOff ~15 ms
//    after a setLive, the 7.0b3 quirk; tried up to 25 times) → refused; PANIC cures it.
// C5 a failing hook (a layer that does not exist): a warning, and the take stands.
// C6 rehearse, then TAKE: B's Lower Third comes in in Preview, is put back off 2 s after, a TAKE meanwhile
//    is refused, and the TAKE afterwards brings it in on Program.
// Restores: looks, Lower Third / Cam PiP off, STINGER off, TALLY off, slot 1; history/steps datastores emptied.
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
const setLayer = async (r, name, on) => { const l = await layer(r, name); await j(`/documents/${D[r]}/layers/${l.id}/${on ? "setLive" : "setOff"}`); };
const sets = async (r) => (await j(`/documents/${D[r]}/layer-sets`)).data;
const active = async (r) => (await sets(r)).find((s) => s.attributes.active && s.attributes.layers?.length)?.attributes.name ?? null;
const recall = async (r, name) => { const s = (await sets(r)).find((x) => x.attributes.name === name); await j(`/documents/${D[r]}/layer-sets/${s.id}/recall`); };
const sw = await layer("M", "AB Switcher"), sting = await layer("M", "STINGER");
const slot = async () => (await j(`/documents/${D.M}/layers/${sw.id}`)).data.attributes["input-values"].tvGroup_Hidden_Inputs__currentLiveSource;
const cut = (n) => j(`/documents/${D.M}/layers/${sw.id}/signals/tvGroup_Control__Cut_${n}_TypeSignal`);
const stState = async () => (await j(`/documents/${D.M}/layers/${sting.id}`)).data.attributes["live-state"];
if (!(await layer("A", "Lower Third")) || !(await layer("B", "Lower Third"))) { console.error("PH-A/PH-B need the Lower Third layer: run documents/build-documents.mjs"); process.exit(2); }
const was = { A: await active("A"), B: await active("B") };

const dir = mkdtempSync(join(tmpdir(), "abswitch-cov-"));
const real = JSON.parse(readFileSync(join(dirname(HERE), "takectl.config.json"), "utf8"));
let tk = null;
const startTk = async (over = {}) => {
  const f = join(dir, `c${Date.now()}.json`);
  writeFileSync(f, JSON.stringify({ ...real, ...over }, null, 2));
  tk = spawn("node", [join(ROOT, "takectl.mjs")], { env: { ...process.env, TAKECTL_CONFIG: f }, stdio: "ignore" });
  return until(async () => { const s = await g("/state"); return s.ready !== false && s.pgm ? s : null; }, 12000, 250);
};
const stopTk = async () => { if (tk && tk.exitCode === null && tk.signalCode === null) { const w = new Promise((r) => tk.once("exit", r)); tk.kill(); await w; } tk = null; };
// A on air on aLook, Preview B on bLook, Lower Third and Cam PiP off in both, STINGER off.
const scene = async (aLook = "Full Slides", bLook = "Speaker Wide") => {
  if ((await slot()) !== 1) { await cut(1); await sleep(700); }
  await recall("A", aLook); await recall("B", bLook);
  for (const r of ["A", "B"]) { await setLayer(r, "Lower Third", false); await setLayer(r, "Cam PiP", false); }
  await j(`/documents/${D.M}/layers/${sting.id}/setOff`);
  await sleep(1000);
};
// Sample something every 25 ms for `ms`, keeping only changes.
const watch = async (ms, read) => { const t0 = Date.now(), seen = []; while (Date.now() - t0 < ms) { const v = await read(); if (JSON.stringify(seen.at(-1)?.v) !== JSON.stringify(v)) seen.push({ t: Date.now() - t0, v }); await sleep(25); } return seen; };
const fmtSeen = (seen) => seen.map((x) => `${x.t}:${typeof x.v === "object" ? Object.values(x.v).join("/") : x.v}`).join(" ");

// program-out frames (as round2-check R1)
const W = 64, Hh = 36, FRAME = W * Hh * 3;
let frames = [], ff = null;
const capture = () => { frames = []; let buf = Buffer.alloc(0); ff = spawn("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "mpjpeg", "-i", `${B}/documents/${D.M}/programOut?format=mjpeg&fps=30&width=320`, "-vf", `scale=${W}:${Hh}`, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]); ff.stdout.on("data", (d) => { buf = Buffer.concat([buf, d]); while (buf.length >= FRAME) { frames.push({ t: Date.now(), px: buf.subarray(0, FRAME) }); buf = buf.subarray(FRAME); } }); };
const stopCapture = () => { ff?.kill(); ff = null; };
const classify = (px, ref) => { let a = 0, b = 0, c = 0; const n = px.length / 3; for (let i = 0; i < px.length; i += 3) { const [r, gg, bl] = [px[i], px[i + 1], px[i + 2]]; if (Math.abs(r - ref[0]) + Math.abs(gg - ref[1]) + Math.abs(bl - ref[2]) < 45) c++; else if (r > bl + 30) a++; else if (bl > r + 30) b++; } return { a: a / n, b: b / n, c: c / n }; };

try {
  // ---- C1 pre-hook on the outgoing document
  await scene("Speaker Wide", "Speaker Wide");
  await setLayer("A", "Lower Third", true);
  await sleep(1800);
  let s = await startTk({ stinger: false, hooks: { "Speaker Wide": { pre: [{ layer: "Lower Third", set: "off" }], waitMs: 600 } } });
  const lt0 = await lstate("A", "Lower Third");
  const takeP = g("/take");
  let seen = await watch(1800, async () => ({ lt: await lstate("A", "Lower Third"), slot: await slot() }));
  const take = await takeP;
  const ltOff = seen.find((x) => x.v.lt !== "live")?.t, moved = seen.find((x) => x.v.slot !== 1)?.t;
  check(lt0 === "live" && take.ok && ltOff != null && moved != null && moved - ltOff >= 550,
    `C1. pre-hook on outgoing A: Lower Third left "live" at ${ltOff} ms, the switcher left slot 1 at ${moved} ms (waitMs 600): ${fmtSeen(seen)}; take → ${JSON.stringify(take.error ?? take.transition)}`);
  await stopTk();

  // ---- C2 PANIC in the middle of a steps run
  await scene("Full Slides", "Speaker Wide");
  s = await startTk({ stinger: false, hooks: {} });
  await g("/steps/clear");
  await g("/steps/record?on=1");
  await g(`/pvw/layer-set/${encodeURIComponent("Two Shot")}`); await sleep(1500);
  await g(`/pvw/layer-set/${encodeURIComponent("Slides PiP")}`); await sleep(1500);
  await g(`/pvw/layer-set/${encodeURIComponent("Speaker Wide")}`);
  await g("/steps/record?on=0");
  const sp = await g("/steps/push?pace=original");
  const pz = (async () => { await sleep(700); return g("/panic"); })();
  seen = await watch(4500, async () => await active("A"));
  const p2 = await pz;
  const st2 = await g("/steps");
  check(sp.ok && p2.ok && seen.map((x) => x.v).includes("Two Shot") && !seen.map((x) => x.v).includes("Slides PiP") && st2.running === null && (await slot()) === 1,
    `C2. steps "Two Shot" → "Slides PiP" → "Speaker Wide" (1.5 s apart), PANIC 700 ms in: Program A looks ${fmtSeen(seen)}; panic ${JSON.stringify({ ok: p2.ok, pgm: p2.pgm })}; running ${JSON.stringify(st2.running)}`);
  await stopTk();

  // ---- C3 CUT under the stinger, recorded
  await scene("Speaker Wide", "Speaker Wide");
  s = await startTk({ stinger: true, hooks: {} });
  capture();
  await sleep(1200);
  await j(`/documents/${D.M}/layers/${sting.id}/setLive`); await sleep(1100);
  const ref = (() => { const px = frames.at(-1).px; let r = 0, gg = 0, bl = 0; for (let i = 0; i < px.length; i += 3) { r += px[i]; gg += px[i + 1]; bl += px[i + 2]; } const n = px.length / 3; return [r / n, gg / n, bl / n]; })();
  await j(`/documents/${D.M}/layers/${sting.id}/setOff`); await sleep(1500);
  const t3 = Date.now();
  const c3 = await g("/cut");
  await sleep(2000);
  stopCapture();
  const win = frames.filter((f) => f.t >= t3 - 300).map((f) => ({ t: f.t - t3, ...classify(f.px, ref) }));
  const both = win.filter((f) => f.a > 0.02 && f.b > 0.02), firstB = win.find((f) => f.b > 0.02);
  const fullBefore = firstB && win.some((f) => f.t < firstB.t && f.c >= 0.98);
  writeFileSync(join(OUT, "round2-coverage-cut-frames.txt"), win.map((f) => `${f.t}\tA ${Math.round(f.a * 100)}%\tB ${Math.round(f.b * 100)}%\tcover ${Math.round(f.c * 100)}%`).join("\n") + "\n");
  const covered = win.filter((f) => f.c >= 0.5).length;
  check(c3.ok && c3.transition === "cut" && win.length >= 40 && !both.length && !covered && firstB && firstB.t < 400 && win.slice(-5).every((f) => f.b > 0.7),
    `C3. CUT with the stinger on (bare since round 3) → ${c3.transition}; ${win.length} frames: ${covered} covered, ${both.length} show A and B at once; B from ${firstB?.t} ms (round2-coverage-cut-frames.txt)`);

  // ---- C4 the stuck-stinger refusal
  await g("/safe/target?doc=A"); await g("/cut"); await sleep(1500); // A on air again (stinger)
  await j(`/documents/${D.M}/layers/${sting.id}/setLive`); await sleep(600);
  const rLive = await g("/take");
  await j(`/documents/${D.M}/layers/${sting.id}/setOff`); await sleep(900);
  let stuck = null, tries = 0;
  for (; tries < 25 && !stuck; tries++) {
    await j(`/documents/${D.M}/layers/${sting.id}/setLive`);
    await sleep(15);
    await j(`/documents/${D.M}/layers/${sting.id}/setOff`);
    await sleep(1500);
    if ((await stState()) === "shutdown") stuck = true;
    else { await j(`/documents/${D.M}/layers/${sting.id}/setOff`); await sleep(700); }
  }
  const rStuck = stuck ? await g("/take") : null;
  const pz4 = stuck ? await g("/panic") : null;
  await sleep(1500);
  const after4 = await stState();
  const rAfter = stuck ? await g("/take") : null;
  await sleep(1500);
  check(rLive.ok === false && /already live/.test(rLive.error ?? "") && (!stuck || (rStuck.ok === false && /stuck in shutdown/.test(rStuck.error ?? "") && pz4.ok && after4 === "off" && rAfter.ok)),
    `C4. STINGER live → TAKE ${JSON.stringify(rLive.error)}; stuck in shutdown ${stuck ? `after ${tries} tries → TAKE ${JSON.stringify(rStuck.error)}; PANIC → STINGER ${after4}; TAKE → ${rAfter.ok ? rAfter.transition : JSON.stringify(rAfter.error)}` : `NOT REPRODUCED in ${tries} tries (setOff 15 ms after setLive): only the "live" refusal was tested on the real app`}`);
  await stopTk();

  // ---- C5 a failing hook
  await scene("Full Slides", "Speaker Wide");
  s = await startTk({ stinger: false, hooks: { "Speaker Wide": { post: [{ layer: "No Such Layer", set: "live" }] } } });
  const c5 = await g("/take");
  await sleep(1600);
  s = await g("/state");
  check(c5.ok && s.pgm === "B" && (await slot()) === 2 && /hook failed \(then: No Such Layer in\)/.test(s.warning ?? ""),
    `C5. a hook for a layer that does not exist: TAKE → ${c5.transition}; pgm ${s.pgm}, slot ${await slot()}; warning ${JSON.stringify(s.warning)}`);
  await stopTk();

  // ---- C6 rehearse, then TAKE
  await scene("Full Slides", "Speaker Wide");
  s = await startTk({ stinger: false, hooks: { "Speaker Wide": { post: [{ layer: "Lower Third", set: "live" }] } } });
  const t6 = Date.now();
  const reh = await g("/hooks/rehearse");
  const watchP = watch(3800, async () => await lstate("B", "Lower Third"));
  await sleep(800);
  const refused = await g("/take");
  seen = await watchP;
  const putBack = await until(async () => !(await g("/state")).rehearsal, 3000);
  const offNow = await lstate("B", "Lower Third");
  const tk6 = await g("/take");
  const seen6 = await watch(2500, async () => await lstate("B", "Lower Third"));
  const cameIn = seen6.find((x) => x.v === "live" || x.v === "startup");
  check(reh.ok && seen.some((x) => x.v === "live") && refused.ok === false && /rehearsing hooks/.test(refused.error ?? "") && putBack && ["off", "shutdown"].includes(offNow) && tk6.ok && seen6[0]?.v !== "live" && cameIn,
    `C6. rehearse → B's Lower Third in Preview ${fmtSeen(seen)} (TAKE meanwhile → ${JSON.stringify(refused.error)}); put back: ${offNow}; TAKE → on Program ${fmtSeen(seen6)} (came in at ${cameIn?.t} ms)`);
} finally {
  stopCapture();
  await stopTk();
  if ((await slot()) !== 1) { await cut(1); await sleep(700); }
  await j(`/documents/${D.M}/layers/${sting.id}/setOff`);
  for (const r of ["A", "B"]) { await setLayer(r, "TALLY", false); await setLayer(r, "Lower Third", false); await setLayer(r, "Cam PiP", false); }
  if (was.A) await recall("A", was.A);
  if (was.B) await recall("B", was.B);
  await req("PUT", `${B}/documents/${D.M}/datastores/abswitch-history`, { events: [] });
  await req("PUT", `${B}/documents/${D.M}/datastores/abswitch-steps`, { lists: {} });
  await sleep(1200);
  say(`restored: slot ${await slot()}, looks A "${await active("A")}" B "${await active("B")}", Lower Third ${await lstate("A", "Lower Third")}/${await lstate("B", "Lower Third")}, STINGER ${await stState()}, TALLY ${await lstate("A", "TALLY")}/${await lstate("B", "TALLY")}; history and steps datastores emptied`);
  say(fails ? `${fails} FAIL(S)` : "ALL PASS");
  writeFileSync(join(OUT, "round2-coverage-check.txt"), out.join("\n") + "\n");
}
process.exit(fails ? 1 : 0);
