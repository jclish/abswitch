#!/usr/bin/env node
// round2-check: v0.2 round 2 on the real mimoLive (PH-A, PH-B, PH-MASTER open and live, MASTER's
// Recording off, takectl NOT running). Needs ffmpeg.
//   node test/round2-check.mjs
// takectl runs on a copy of takectl.config.json with the stinger on and one hook:
//   "Speaker Wide": post Lower Third live   (the real Lower Third layer, in no Layer Set; ruling 2026-11-11)
// Program A starts on "Full Slides" ("Speaker Wide" for R1/R2: a slide mixes orange and blue, so only
// the letter looks can be told apart per pixel), Preview B on "Speaker Wide" (Lower Third off).
// R1. Stinger TAKE, recorded from MASTER's program out (30 fps, 64×36): no frame shows A and B at
//     once, and B never shows before a fully covered frame.
// R2. Hook: B's Lower Third, held off in Preview, goes live on Program after that stinger TAKE, once the
//     stinger has cleared (≥ cover + off + reveal after the press).
// R3. PANIC 200 ms after TAKE is pressed: with the stinger (signal never sent) and without it (the
//     dissolve in flight): no post-hook (B's Lower Third stays off 3 s).
// R4. PUSH: Preview's "Two Shot" recalled on Program live (under the stinger); Program reads it as
//     active (the landing proof), Preview untouched, history logs it.
//     (R1 counts frames up to the hook: the Lower Third's own picture is not part of the transition.)
// R5. Steps: two looks pushed onto Program in order; UNDO back to the previous look after a TAKE.
// Restores: looks as found, Lower Third and Cam PiP off, STINGER off, TALLY off, slot as found, MASTER's
// abswitch-history / abswitch-steps datastores emptied. TAKECTL_DIR=<dir> runs another takectl.mjs.
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.TAKECTL_DIR || dirname(HERE);
const OUT = process.env.TAKECTL_DIR ? join(ROOT, "out") : HERE;
mkdirSync(OUT, { recursive: true });
const H = "http://localhost:8989", B = `${H}/api/v1`, T = "http://localhost:8991";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const req = async (method, u, body, timeout = 10000) => { try { const r = await fetch(u, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body), signal: AbortSignal.timeout(timeout) }); const t = await r.text(); try { return { status: r.status, ...JSON.parse(t) }; } catch { return { status: r.status, raw: t }; } } catch (e) { return { status: 0, error: String(e) }; } };
const j = (u) => req("GET", u);
const g = (p) => j(T + p);
const out = [];
const say = (s) => { out.push(s); console.log(s); };
let fails = 0;
const check = (ok, what) => { if (!ok) fails++; say(`${ok ? "PASS" : "FAIL"}  ${what}`); };
const until = async (fn, ms, every = 100) => { const t = Date.now(); while (Date.now() - t < ms) { const v = await fn(); if (v) return v; await sleep(every); } return null; };

const docs = (await j(`${B}/documents`)).data;
const id = (n) => docs.find((d) => d.attributes.name.replace(/\.tvshow$/, "") === n).id;
const D = { A: id("PH-A"), B: id("PH-B"), M: id("PH-MASTER") };
const layers = async (r) => (await j(`${B}/documents/${D[r]}/layers`)).data;
const layer = async (r, name) => (await layers(r)).find((l) => l.attributes.name === name);
const lstate = async (r, name) => (await layer(r, name))?.attributes["live-state"];
const sets = async (r) => (await j(`${B}/documents/${D[r]}/layer-sets`)).data;
const active = async (r) => (await sets(r)).find((s) => s.attributes.active && s.attributes.layers?.length)?.attributes.name ?? null;
const recall = async (r, name) => { const s = (await sets(r)).find((x) => x.attributes.name === name); await j(`${B}/documents/${D[r]}/layer-sets/${s.id}/recall`); };
const setLayer = async (r, name, on) => { const l = await layer(r, name); await j(`${B}/documents/${D[r]}/layers/${l.id}/${on ? "setLive" : "setOff"}`); };
const swL = await layer("M", "AB Switcher");
const stingerL = await layer("M", "STINGER");
const slot = async () => (await j(`${B}/documents/${D.M}/layers/${swL.id}`)).data.attributes["input-values"].tvGroup_Hidden_Inputs__currentLiveSource;
const cut = (n) => j(`${B}/documents/${D.M}/layers/${swL.id}/signals/tvGroup_Control__Cut_${n}_TypeSignal`);
const was = { slot: await slot(), A: await active("A"), B: await active("B") };
if (!stingerL) { console.error("PH-MASTER has no STINGER layer: run documents/build-documents.mjs"); process.exit(2); }

const dir = mkdtempSync(join(tmpdir(), "abswitch-r2real-"));
const real = JSON.parse(readFileSync(join(dirname(HERE), "takectl.config.json"), "utf8"));
const HOOKS = { "Speaker Wide": { post: [{ layer: "Lower Third", set: "live" }] } };
const cfgFile = (o) => { const f = join(dir, `c${Date.now()}.json`); writeFileSync(f, JSON.stringify({ ...real, ...o }, null, 2)); return f; };
let tk = null;
const startTk = async (o) => {
  tk = spawn("node", [join(ROOT, "takectl.mjs")], { env: { ...process.env, TAKECTL_CONFIG: cfgFile(o) }, stdio: "ignore" });
  return until(async () => { const s = await g("/state"); return s.ready !== false && s.pgm ? s : null; }, 12000, 250);
};
const stopTk = async () => { if (tk && tk.exitCode === null && tk.signalCode === null) { const w = new Promise((r) => tk.once("exit", r)); tk.kill(); await w; } tk = null; };
// Program A on "Full Slides", Preview B on "Speaker Wide" with the Lower Third (and Cam PiP) off, A on air.
const scene = async (aLook = "Full Slides") => {
  if ((await slot()) !== 1) { await cut(1); await sleep(700); }
  await recall("A", aLook);
  await recall("B", "Speaker Wide");
  for (const r of ["A", "B"]) { await setLayer(r, "Cam PiP", false); await setLayer(r, "Lower Third", false); }
  await sleep(900);
};
// PH-B's Lower Third live-state, polled every 25 ms from the press, for `ms`
const watchPiP = async (t0, ms) => { const seen = []; while (Date.now() - t0 < ms) { seen.push({ t: Date.now() - t0, st: await lstate("B", "Lower Third"), sting: (await j(`${B}/documents/${D.M}/layers/${stingerL.id}`)).data.attributes["live-state"] }); await sleep(25); } return seen; };

// ---- program out frames (as test/stinger-cover.mjs)
const W = 64, Hh = 36, FRAME = W * Hh * 3;
let frames = [], ff = null;
const capture = () => {
  frames = [];
  let buf = Buffer.alloc(0);
  ff = spawn("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "mpjpeg", "-i", `${B}/documents/${D.M}/programOut?format=mjpeg&fps=30&width=320`, "-vf", `scale=${W}:${Hh}`, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]);
  ff.stdout.on("data", (d) => { buf = Buffer.concat([buf, d]); while (buf.length >= FRAME) { frames.push({ t: Date.now(), px: buf.subarray(0, FRAME) }); buf = buf.subarray(FRAME); } });
};
const stopCapture = () => { ff?.kill(); ff = null; };
// Per pixel: stinger colour (from a fully covered frame), A (orange: red well above blue) or B (blue).
const classify = (px, ref) => { let a = 0, b = 0, c = 0; const n = px.length / 3; for (let i = 0; i < px.length; i += 3) { const [r, gg, bl] = [px[i], px[i + 1], px[i + 2]]; if (ref && Math.abs(r - ref[0]) + Math.abs(gg - ref[1]) + Math.abs(bl - ref[2]) < 45) c++; else if (r > bl + 30) a++; else if (bl > r + 30) b++; } return { a: a / n, b: b / n, c: c / n }; };

try {
  // The history the checks read is this run's own: older entries (a demo run, say) are cleared first.
  await req("PUT", `${B}/documents/${D.M}/datastores/abswitch-history`, { events: [] });
  await req("PUT", `${B}/documents/${D.M}/datastores/abswitch-steps`, { lists: {} });
  await scene("Speaker Wide");
  let s = await startTk({ stinger: true, hooks: HOOKS });
  check(!!s, `setup: takectl running on the real documents (pgm ${s?.pgm}), stinger on, hook "Speaker Wide" → then: Lower Third in`);

  // ---- R1 + R2: a stinger TAKE, recorded, with the hook
  // Reference colours: the stinger, held on for a moment before the test (then off again).
  capture();
  await sleep(1500);
  const calA = frames.at(-1)?.px;
  await j(`${B}/documents/${D.M}/layers/${stingerL.id}/setLive`);
  await sleep(1100);
  const ref = (() => { const px = frames.at(-1).px; let r = 0, gg = 0, bl = 0; for (let i = 0; i < px.length; i += 3) { r += px[i]; gg += px[i + 1]; bl += px[i + 2]; } const n = px.length / 3; return [r / n, gg / n, bl / n]; })();
  await j(`${B}/documents/${D.M}/layers/${stingerL.id}/setOff`);
  await sleep(1500);
  const cA = classify(calA, ref);
  say(`calibration: A on air → A ${Math.round(cA.a * 100)}%, B ${Math.round(cA.b * 100)}%; stinger rgb(${ref.map(Math.round).join(", ")})`);
  const t0 = Date.now();
  const takeP = g("/take");
  const pip = await watchPiP(t0, 2600);
  const take = await takeP;
  await sleep(600);
  stopCapture();
  const on = pip.find((x) => x.st === "live" || x.st === "startup");
  // Frames up to the hook (a frame arriving 50 ms after it was rendered before it: the path delay is ~87 ms).
  const allF = frames.filter((f) => f.t >= t0 - 300).map((f) => ({ t: f.t - t0, ...classify(f.px, ref) }));
  const win = allF.filter((f) => !on || f.t <= on.t + 50);
  const both = win.filter((f) => f.a > 0.02 && f.b > 0.02);
  const firstB = win.find((f) => f.b > 0.02);
  const fullBeforeB = firstB && win.some((f) => f.t < firstB.t && f.c >= 0.98);
  const endsB = allF.slice(-5).every((f) => f.b > 0.5 && f.a < 0.02); // after the hook: B, with the Lower Third over it
  writeFileSync(join(OUT, "round2-stinger-frames.txt"), `# ms after the press (frame arrival; the picture path adds ~87 ms)\thook (Lower Third live) at ${on?.t} ms by the API\n` + allF.map((f) => `${f.t}\tA ${Math.round(f.a * 100)}%\tB ${Math.round(f.b * 100)}%\tcover ${Math.round(f.c * 100)}%${on && f.t > on.t + 50 ? "\t(after the hook)" : ""}`).join("\n") + "\n");
  check(take.ok && take.transition === "stinger" && cA.a > 0.7 && win.length >= 25 && !both.length && fullBeforeB && endsB,
    `R1. stinger TAKE → ${take.transition ?? JSON.stringify(take)}; ${win.length} frames up to the hook: ${both.length} show A and B at once; first B frame at ${firstB?.t} ms, after a fully covered frame: ${!!fullBeforeB}; ends on B: ${endsB} (round2-stinger-frames.txt)`);
  const stOff = pip.find((x, i) => i > 0 && x.sting !== "live" && pip.slice(0, i).some((y) => y.sting === "live"));
  check(pip[0]?.st === "off" && on && on.t >= 950 && stOff && on.t >= stOff.t + 350,
    `R2. B's Lower Third (held off in Preview) → "${on?.st}" on Program ${on?.t} ms after the press; the stinger started clearing at ${stOff?.t} ms (post-hook waits for its ~400 ms reveal)`);
  await stopTk();

  // ---- R3: PANIC 200 ms after the press, with and without the stinger
  for (const stinger of [true, false]) {
    await scene();
    await startTk({ stinger, hooks: HOOKS });
    const t = Date.now();
    const tp = g("/take");
    await sleep(200);
    const p = await g("/panic");
    const tr = await tp;
    const w = await watchPiP(t, 3000);
    const lit = w.filter((x) => x.st !== "off");
    check(p.ok && !lit.length && (await slot()) === 1 && (stinger ? /under the stinger; signal not sent/.test(tr.error ?? "") : tr.ok),
      `R3${stinger ? "a" : "b"}. PANIC 200 ms after TAKE ${stinger ? "(under the stinger)" : "(dissolve in flight)"}: take → ${JSON.stringify(tr.error ?? tr.transition)}; panic ${p.ok ? `ok in ${p.ms} ms` : JSON.stringify(p)}; Lower Third on B stayed off for 3 s: ${!lit.length}; slot ${await slot()}`);
    await stopTk();
  }

  // ---- R4: PUSH under the stinger
  await scene();
  await recall("B", "Two Shot");
  await sleep(700);
  await startTk({ stinger: true, hooks: {} });
  const tp = Date.now();
  const push = await g("/push");
  const landed = await until(async () => ((await g("/history")).log ?? []).find((x) => x.kind === "push"), 3000, 50);
  const tl = Date.now() - tp;
  s = await g("/state");
  const aLook = await active("A"), bLook = await active("B");
  check(push.ok && push.transition === "stinger" && aLook === "Two Shot" && bLook === "Two Shot" && (await slot()) === 1 && landed?.from === "Full Slides" && landed?.to === "Two Shot" && !/does not read it as active/.test(s.warning ?? ""),
    `R4. PUSH → ${JSON.stringify(push)}; Program A reads "${aLook}" (landed and logged ${tl} ms after the press: ${JSON.stringify(landed)}); Preview B "${bLook}"; still slot ${await slot()}; warning ${JSON.stringify(s.warning)}`);
  await stopTk();

  // ---- R5: steps and UNDO
  await scene();
  await startTk({ stinger: false, hooks: {} });
  await g("/steps/clear");
  await g(`/pvw/layer-set/${encodeURIComponent("Two Shot")}`); await g("/steps/add");
  await g(`/pvw/layer-set/${encodeURIComponent("Slides PiP")}`); await g("/steps/add");
  const seen = [];
  const sp = await g("/steps/push?pace=instant");
  await until(async () => { const a = await active("A"); if (a && seen.at(-1) !== a) seen.push(a); return !(await g("/steps")).running; }, 8000, 40);
  const aEnd = await active("A");
  const hist = (await g("/history")).log ?? [];
  check(sp.ok && aEnd === "Slides PiP" && seen.includes("Two Shot") && seen.indexOf("Two Shot") < seen.indexOf("Slides PiP") && hist.filter((x) => x.kind === "steps").length === 2,
    `R5a. steps "Two Shot" → "Slides PiP" onto Program A: looks seen ${JSON.stringify(seen)}; history ${JSON.stringify(hist.map((x) => `${x.from}→${x.to} (${x.kind})`))}`);
  await g("/take"); await sleep(1300);
  const u1 = (await g("/state")).undo;
  const ud = await g("/undo"); await sleep(1300);
  const sl = await slot();
  const u2 = (await g("/state")).undo;
  check(u1.available && ud.ok && sl === 1 && !u2.available && /already undone/.test(u2.why), `R5b. TAKE then UNDO → ${JSON.stringify(ud.error ?? ud.transition)}; switcher slot ${sl} (A back on air); then UNDO ${JSON.stringify(u2.why)}`);
} finally {
  stopCapture();
  await stopTk();
  // restore
  await j(`${B}/documents/${D.M}/layers/${stingerL.id}/setOff`);
  for (const r of ["A", "B"]) { await setLayer(r, "TALLY", false); }
  if (was.A) await recall("A", was.A);
  if (was.B) await recall("B", was.B);
  for (const r of ["A", "B"]) { await setLayer(r, "Cam PiP", false); await setLayer(r, "Lower Third", false); }
  if ((await slot()) !== was.slot) await cut(was.slot);
  await req("PUT", `${B}/documents/${D.M}/datastores/abswitch-history`, { events: [] });
  await req("PUT", `${B}/documents/${D.M}/datastores/abswitch-steps`, { lists: {} });
  await sleep(800);
  say(`restored: slot ${await slot()}, looks A "${await active("A")}" B "${await active("B")}", Lower Third ${await lstate("A", "Lower Third")}/${await lstate("B", "Lower Third")}, Cam PiP ${await lstate("A", "Cam PiP")}/${await lstate("B", "Cam PiP")}, STINGER ${await lstate("M", "STINGER")}, TALLY ${await lstate("A", "TALLY")}/${await lstate("B", "TALLY")}; history and steps datastores emptied`);
  say(fails ? `${fails} FAIL(S)` : "ALL PASS");
  writeFileSync(join(OUT, "round2-check.txt"), out.join("\n") + "\n");
}
process.exit(fails ? 1 : 0);
