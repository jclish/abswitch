#!/usr/bin/env node
// round3-check: round 3 on the real mimoLive (PH-A, PH-B, PH-MASTER open and live, MASTER's Recording off,
// takectl NOT running). Needs ffmpeg and Google Chrome.
//   node test/round3-check.mjs
// C  CUT with STINGER selected leaves the STINGER layer off throughout (polled every 20 ms); its post-hook
//    still brings the Lower Third in.
// R  rate: /rate 1.0 s → the switcher reads 1.0 and the dissolve settles ~1.06 s after the signal; the
//    duration changed straight through the API (as mimoLive's UI would) to 2.0 s → the next TAKE reads it
//    (2060 ms) and its verify lands without a later settle.
// F  FTB: MASTER's program out fades to black; a TAKE underneath lands; PANIC leaves FTB on; off → picture.
// D  downstream keys: Bug on mid-transition and Clock on in SAFE both land; neither is logged.
// T  thumbnails: a Preview recall leaves a 320-wide JPEG of that look, served by /thumb?name=.
// O  outputs: REC lamp off (Recording is off), no STREAM output → hidden (null).
// P  the panel in Chrome against the real documents: B's show stopped → the Preview monitor reads STALE
//    within ~2 s and clears when it starts again.
// Restores: slot 1, duration 0.5 s, FTB / STINGER / DSKs / Lower Thirds / TALLY off, looks as found,
// shows live, history and steps datastores emptied. TAKECTL_DIR=<dir> runs another takectl.mjs.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
const setLayer = async (r, name, on) => { const l = await layer(r, name); if (l) await j(`/documents/${D[r]}/layers/${l.id}/${on ? "setLive" : "setOff"}`); };
const sets = async (r) => (await j(`/documents/${D[r]}/layer-sets`)).data;
const active = async (r) => (await sets(r)).find((s) => s.attributes.active && s.attributes.layers?.length)?.attributes.name ?? null;
const recall = async (r, name) => { const s = (await sets(r)).find((x) => x.attributes.name === name); await j(`/documents/${D[r]}/layer-sets/${s.id}/recall`); };
const sw = await layer("M", "AB Switcher");
const swIv = async () => (await j(`/documents/${D.M}/layers/${sw.id}`)).data.attributes["input-values"];
const slot = async () => (await swIv()).tvGroup_Hidden_Inputs__currentLiveSource;
const cut = (n) => j(`/documents/${D.M}/layers/${sw.id}/signals/tvGroup_Control__Cut_${n}_TypeSignal`);
for (const [r, n] of [["M", "FTB"], ["M", "STINGER"], ["M", "DSK Bug"], ["M", "DSK Clock"], ["A", "Lower Third"], ["B", "Lower Third"]])
  if (!(await layer(r, n))) { console.error(`missing layer ${n}: run documents/build-documents.mjs`); process.exit(2); }
const was = { A: await active("A"), B: await active("B") };

const dir = mkdtempSync(join(tmpdir(), "abswitch-r3real-"));
const real = JSON.parse(readFileSync(join(dirname(HERE), "takectl.config.json"), "utf8"));
let tk = null, cfgFile = null;
const startTk = async (over = {}) => {
  const sub = mkdtempSync(join(dir, "p-"));
  cfgFile = join(sub, "takectl.config.json");
  writeFileSync(cfgFile, JSON.stringify({ ...real, ...over, master: { ...real.master, sourceNameSafe: "SAFE Test Pattern", ...(over.master ?? {}) } }, null, 2));
  tk = spawn("node", [join(ROOT, "takectl.mjs")], { env: { ...process.env, TAKECTL_CONFIG: cfgFile }, stdio: "ignore" });
  return until(async () => { const s = await g("/state"); return s.ready !== false && s.pgm ? s : null; }, 12000, 250);
};
const stopTk = async () => { if (tk && tk.exitCode === null && tk.signalCode === null) { const w = new Promise((r) => tk.once("exit", r)); tk.kill(); await w; } tk = null; };
const scene = async () => {
  if ((await slot()) !== 1) { await cut(1); await sleep(700); }
  await recall("A", "Full Slides"); await recall("B", "Speaker Wide");
  for (const r of ["A", "B"]) await setLayer(r, "Lower Third", false);
  await sleep(900);
};
const watch = async (ms, read) => { const t0 = Date.now(), seen = []; while (Date.now() - t0 < ms) { const v = await read(); if (JSON.stringify(seen.at(-1)?.v) !== JSON.stringify(v)) seen.push({ t: Date.now() - t0, v }); await sleep(20); } return seen; };
const fmtSeen = (seen) => seen.map((x) => `${x.t}:${typeof x.v === "object" ? Object.values(x.v).join("/") : x.v}`).join(" ");
// MASTER's program-out mean brightness (32×18 gray frames, 30 fps), for FTB
const meanNow = async () => { const r = await fetch(`${B}/documents/${D.M}/programOut?format=png&width=64`); return r.ok ? (await r.arrayBuffer()).byteLength : 0; };

try {
  // ---- C: CUT with STINGER selected
  await scene();
  let s = await startTk({ stinger: true, hooks: { "Speaker Wide": { post: [{ layer: "Lower Third", set: "live" }] } } });
  check(s?.transition?.mode === "stinger", `setup: takectl running, transition ${s?.transition?.mode} (from the config), rate ${s?.transition?.rateS} s`);
  const cutP = g("/cut");
  const seenC = await watch(1600, async () => ({ sting: await lstate("M", "STINGER"), slot: await slot(), lt: await lstate("B", "Lower Third") }));
  const c1 = await cutP;
  check(c1.ok && c1.transition === "cut" && seenC.every((x) => x.v.sting === "off") && seenC.some((x) => x.v.slot === 2) && seenC.some((x) => x.v.lt === "live" || x.v.lt === "startup"),
    `C. CUT with STINGER selected → ${c1.transition}; STINGER/slot/Lower Third: ${fmtSeen(seenC)}`);
  await stopTk();

  // ---- R: rate
  await scene();
  s = await startTk({ stinger: false, hooks: {} });
  const r1 = await g("/rate?s=1");
  const iv1 = (await swIv()).tvIn_TransitionDuration;
  let t0 = Date.now();
  const tk1P = g("/take");
  const flip1 = await until(async () => ((await slot()) === 2 ? Date.now() - t0 : null), 4000, 20);
  const tk1 = await tk1P;
  await sleep(800);
  await req("PUT", `${B}/documents/${D.M}/layers/${sw.id}`, { "input-values": { tvIn_TransitionDuration: 2 } });
  t0 = Date.now();
  const tk2P = g("/take");
  const flip2 = await until(async () => ((await slot()) === 1 ? Date.now() - t0 : null), 5000, 20);
  const tk2 = await tk2P;
  await sleep(1200);
  const ev = JSON.stringify((await g("/state")).events ?? []);
  check(r1.ok && iv1 === 1 && tk1.ms === 1060 && flip1 >= 950 && flip1 <= 1350 && tk2.ms === 2060 && flip2 >= 1900 && flip2 <= 2350 && !/settled on a later read/.test(ev),
    `R. /rate 1 s → switcher ${iv1}; TAKE timed ${tk1.ms} ms, slot flipped at ${flip1} ms; changed to 2 s outside takectl → next TAKE timed ${tk2.ms} ms, flipped at ${flip2} ms; verify never left in flight`);
  await g("/rate?s=0.5");
  await stopTk();

  // ---- F: FTB, and D: downstream keys
  await scene();
  s = await startTk({ stinger: false, hooks: {} });
  const h0 = ((await g("/history")).log ?? []).length;
  const big = await meanNow();
  const f1 = await g("/ftb?on=1");
  await sleep(1300);
  const black = await meanNow();
  const ftbState = await lstate("M", "FTB");
  const tkF = g("/take"); await sleep(100);
  const d1 = await g("/dsk?label=Bug&on=1"); // mid-transition
  await tkF; await sleep(1000);
  const slotUnder = await slot();
  const pz = await g("/panic"); await sleep(800);
  const ftbAfter = await lstate("M", "FTB");
  const d2 = await g("/dsk?label=Clock&on=1"); // in SAFE
  await sleep(400);
  const bug = await lstate("M", "DSK Bug"), clock = await lstate("M", "DSK Clock");
  const f2 = await g("/ftb?on=0"); await sleep(1300);
  const back = await meanNow();
  const h1 = (await g("/history")).log ?? [];
  // a black frame compresses to far fewer bytes than a picture: the PNG's size is the proxy
  check(f1.ok && ftbState === "live" && black < big * 0.5 && slotUnder === 2 && pz.ok && pz.pgm === "SAFE" && ftbAfter === "live" && f2.ok && back > black * 2,
    `F. FTB on → "${ftbState}", program out ${big} → ${black} bytes (black); TAKE underneath → slot ${slotUnder}; PANIC → ${pz.pgm}, FTB still "${ftbAfter}"; off → ${back} bytes`);
  check(d1.ok && d2.ok && bug === "live" && clock === "live" && h1.length - h0 === 2 && h1.slice(h0).every((e) => ["take", "panic"].includes(e.kind)),
    `D. Bug on mid-transition → "${bug}", Clock on in SAFE → "${clock}"; history gained ${h1.length - h0} entries: ${JSON.stringify(h1.slice(h0).map((e) => e.kind))}`);
  await g("/dsk?label=Bug&on=0"); await g("/dsk?label=Clock&on=0");
  await g("/safe/target?doc=A"); await g("/cut"); await sleep(1200);

  // ---- T: thumbnails; O: outputs
  const rr = await g(`/pvw/layer-set?name=${encodeURIComponent("Two Shot")}`);
  await sleep(1800);
  const thumbsDir = join(dirname(cfgFile), "thumbs");
  const idx = existsSync(join(thumbsDir, "index.json")) ? JSON.parse(readFileSync(join(thumbsDir, "index.json"), "utf8")) : {};
  const tr = await fetch(`${T}/thumb?name=${encodeURIComponent("Two Shot")}`);
  const buf = Buffer.from(await tr.arrayBuffer());
  let wpx = null; for (let i = 2; i < buf.length - 9; ) { if (buf[i] !== 0xff) break; const m = buf[i + 1], L = buf.readUInt16BE(i + 2); if (m === 0xc0 || m === 0xc2) { wpx = [buf.readUInt16BE(i + 7), buf.readUInt16BE(i + 5)]; break; } i += 2 + L; }
  check(rr.ok && /^[0-9a-f]{40}\.jpg$/.test(idx["Two Shot"]?.file ?? "") && tr.status === 200 && wpx?.[0] === 320, `T. "Two Shot" recalled in Preview → thumbs/${idx["Two Shot"]?.file}; /thumb serves a ${wpx?.join("×")} JPEG`);
  s = await g("/state");
  check(s.outputs?.rec === false && s.outputs?.stream === null, `O. REC lamp ${s.outputs?.rec} (Recording off), STREAM ${s.outputs?.stream} (no streaming output: hidden)`);

  // ---- P: STALE on the panel, B's show stopped
  const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", PORT = 9336;
  const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), "abswitch-r3rc-"))}`, "--no-first-run", "--disable-extensions", "about:blank"], { stdio: "ignore" });
  try {
    let target = null;
    for (let i = 0; i < 50 && !target; i++) { await sleep(200); target = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((x) => x.json()).then((l) => l.find((t) => t.type === "page")).catch(() => null); }
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res) => (ws.onopen = res));
    let n = 0; const waiting = new Map();
    ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && waiting.has(d.id)) { waiting.get(d.id)(d); waiting.delete(d.id); } };
    const cdp = (method, params = {}) => new Promise((res) => { const id = ++n; waiting.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
    const evj = async (x) => (await cdp("Runtime.evaluate", { expression: x, returnByValue: true })).result.result.value;
    await cdp("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await cdp("Page.enable");
    await cdp("Page.navigate", { url: T + "/" });
    await sleep(3500);
    const st = () => evj(`[document.getElementById("pvwHdr").textContent, document.getElementById("pvwMon").dataset.stale || "", document.getElementById("pvwStaleWhy").textContent, document.getElementById("pgmMon").dataset.stale || ""]`);
    const s0 = await st();
    const t1 = Date.now();
    await j(`/documents/${D.B}/setOff`);
    const s1 = await until(async () => { const x = await st(); return x[1] === "1" ? x : null; }, 4000, 100);
    const staleMs = Date.now() - t1;
    await j(`/documents/${D.B}/setLive`);
    const s2 = await until(async () => { const x = await st(); return x[1] === "" ? x : null; }, 6000, 100);
    check(s0[0].includes("DOCUMENT B") && !s0[1] && !s0[3] && s1 && staleMs <= 2500 && /show not running/.test(s1[2]) && s2,
      `P. panel at rest ${JSON.stringify(s0)}; B's show stopped → Preview STALE after ${staleMs} ms ${JSON.stringify(s1)}; started again → ${JSON.stringify(s2)}`);
    ws.close();
  } finally { chrome.kill(); }
} finally {
  await stopTk();
  await j(`/documents/${D.B}/setLive`);
  await req("PUT", `${B}/documents/${D.M}/layers/${sw.id}`, { "input-values": { tvIn_TransitionDuration: 0.5 } });
  if ((await slot()) !== 1) { await cut(1); await sleep(700); }
  for (const n of ["FTB", "STINGER", "DSK Bug", "DSK Clock"]) await setLayer("M", n, false);
  for (const r of ["A", "B"]) { await setLayer(r, "TALLY", false); await setLayer(r, "Lower Third", false); }
  if (was.A) await recall("A", was.A);
  if (was.B) await recall("B", was.B);
  await req("PUT", `${B}/documents/${D.M}/datastores/abswitch-history`, { events: [] });
  await req("PUT", `${B}/documents/${D.M}/datastores/abswitch-steps`, { lists: {} });
  await sleep(1200);
  say(`restored: slot ${await slot()}, duration ${(await swIv()).tvIn_TransitionDuration} s, FTB ${await lstate("M", "FTB")}, STINGER ${await lstate("M", "STINGER")}, DSK ${await lstate("M", "DSK Bug")}/${await lstate("M", "DSK Clock")}, Lower Third ${await lstate("A", "Lower Third")}/${await lstate("B", "Lower Third")}, looks A "${await active("A")}" B "${await active("B")}"; datastores emptied`);
  say(fails ? `${fails} FAIL(S)` : "ALL PASS");
  writeFileSync(join(OUT, "round3-check.txt"), out.join("\n") + "\n");
}
process.exit(fails ? 1 : 0);
