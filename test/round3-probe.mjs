#!/usr/bin/env node
// round3-probe: what round 3 builds on, read from the real mimoLive 7.0b3 before any code (ruling 2026-11-11).
// PH-A, PH-B, PH-MASTER open and live, MASTER's Recording off, takectl NOT running. Needs ffmpeg.
//   node test/round3-probe.mjs        → test/round3-probe.txt
// 1. Stills for the look-key thumbnails: GET /documents/{id}/programOut?format=jpeg|png[&width=]
// 2. The Video Switcher's transition duration: every input whose name mentions a duration or
//    transition, with its description; then dissolves timed at several written values (the slot
//    polled every 20 ms from the signal to the flip), including one above the documented maximum.
// 3. FTB: MASTER's program-out brightness while FTB fades in and out, and a cut underneath it.
// 4. MASTER's layer stack (top first): what "a layer above the switcher" would catch.
// Leaves the duration at 0.5 s, FTB off, slot 1.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const B = "http://localhost:8989/api/v1";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const j = async (u, o) => (await fetch(B + u, o)).json().catch(() => null);
const put = (u, body) => j(u, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const out = [];
const say = (s) => { out.push(s); console.log(s); };

const docs = (await j("/documents")).data;
const D = Object.fromEntries(docs.map((d) => [d.attributes.name.replace(/\.tvshow$/, ""), d.id]));
const M = D["PH-MASTER"];
const layers = (await j(`/documents/${M}/layers`)).data;
const sw = layers.find((l) => l.attributes.name === "AB Switcher"), ftb = layers.find((l) => l.attributes.name === "FTB");
const swAttr = async () => (await j(`/documents/${M}/layers/${sw.id}`)).data.attributes;
const slot = async () => (await swAttr())["input-values"].tvGroup_Hidden_Inputs__currentLiveSource;
const sig = (k) => j(`/documents/${M}/layers/${sw.id}/signals/tvGroup_Control__${k}_TypeSignal`);
if ((await slot()) !== 1) { await sig("Cut_1"); await sleep(800); }

// ---- 1. stills
say("1. STILLS (document A's program out)");
for (const q of ["format=jpeg", "format=jpeg&width=320", "format=png&width=320", "format=image"]) {
  const t0 = Date.now();
  const r = await fetch(`${B}/documents/${D["PH-A"]}/programOut?${q}`);
  const buf = Buffer.from(await r.arrayBuffer());
  say(`   ${q.padEnd(24)} → HTTP ${r.status}, ${r.headers.get("content-type")}, ${buf.length} bytes, ${Date.now() - t0} ms`);
}

// ---- 2. the transition duration
say("\n2. VIDEO SWITCHER: duration / transition inputs");
let a = await swAttr();
for (const [k, d] of Object.entries(a["input-descriptions"] ?? {}))
  if (/duration|transition|rate|speed/i.test(k)) say(`   ${k} = ${JSON.stringify(a["input-values"][k])}  (uiName "${d.uiName}", type ${d.type}, min ${d["value-min"]}, max ${d["value-max"]}${d.hidden ? ", hidden" : ""})`);
const timeDissolve = async (to) => {
  const t0 = Date.now();
  await sig(`Dis_${to}`);
  let first30 = null, flip = null;
  while (Date.now() - t0 < 7000) {
    const x = await swAttr();
    const s = x["input-values"].tvGroup_Hidden_Inputs__currentLiveSource;
    const any30 = [1, 2, 3, 4].some((n) => x["output-values"][`tvOut_tvIn_VideoSource${"ABCD"[n - 1]}ImageTallyState`] === 30);
    if (any30 && first30 == null) first30 = Date.now() - t0;
    if (s === to && !any30) { flip = Date.now() - t0; break; }
    await sleep(20);
  }
  return { first30, flip };
};
const results = [];
for (const d of [0.25, 1, 2, 6, 0.5]) {
  await put(`/documents/${M}/layers/${sw.id}`, { "input-values": { tvIn_TransitionDuration: d } });
  await sleep(200);
  const back = (await swAttr())["input-values"].tvIn_TransitionDuration;
  const go = await timeDissolve(2);
  await sleep(400);
  const ret = await timeDissolve(1);
  await sleep(400);
  results.push({ d, back, go, ret });
  say(`   wrote ${d} s → reads ${back}; dissolve 1→2: in flight from ${go.first30} ms, settled on slot 2 at ${go.flip} ms; 2→1: settled at ${ret.flip} ms`);
}

// ---- 3. FTB
say("\n3. FTB (MASTER's program out, mean brightness 0–255, frames at 30 fps)");
const W = 32, H = 18, FRAME = W * H;
const frames = [];
let buf = Buffer.alloc(0);
const ff = spawn("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "mpjpeg", "-i", `${B}/documents/${M}/programOut?format=mjpeg&fps=30&width=320`, "-vf", `scale=${W}:${H}`, "-f", "rawvideo", "-pix_fmt", "gray", "-"]);
ff.stdout.on("data", (d) => { buf = Buffer.concat([buf, d]); while (buf.length >= FRAME) { let s = 0; for (let i = 0; i < FRAME; i++) s += buf[i]; frames.push({ t: Date.now(), m: Math.round(s / FRAME) }); buf = buf.subarray(FRAME); } });
await sleep(1500);
const lstate = async () => (await j(`/documents/${M}/layers/${ftb.id}`)).data.attributes["live-state"];
const tOn = Date.now();
await j(`/documents/${M}/layers/${ftb.id}/setLive`);
await sleep(1200);
const stOn = await lstate();
const tCut = Date.now();
await sig("Cut_2");
await sleep(800);
const slotUnder = await slot();
const tOff = Date.now();
await j(`/documents/${M}/layers/${ftb.id}/setOff`);
await sleep(1500);
const stOff = await lstate();
ff.kill();
const row = (from, to) => frames.filter((f) => f.t >= from && f.t < to).map((f) => `${f.t - from}:${f.m}`).join(" ");
say(`   FTB setLive → state "${stOn}"; brightness after "on": ${row(tOn - 100, tOn + 900)}`);
say(`   Cut_2 under FTB → slot ${slotUnder}; brightness meanwhile: ${row(tCut, tCut + 600)}`);
say(`   FTB setOff → state "${stOff}"; brightness after "off" (B now): ${row(tOff - 100, tOff + 900)}`);
await sig("Cut_1"); await sleep(600);

// ---- 4. MASTER's stack
say("\n4. MASTER LAYERS, top first (index 0 = top)");
for (const l of (await j(`/documents/${M}/layers`)).data) say(`   ${String(l.attributes.index).padStart(2)}  ${l.attributes.name.padEnd(16)} ${l.attributes["composition-id"] ?? ""}  ${l.attributes["live-state"]}`);

await put(`/documents/${M}/layers/${sw.id}`, { "input-values": { tvIn_TransitionDuration: 0.5 } });
say(`\nleft: duration ${(await swAttr())["input-values"].tvIn_TransitionDuration} s, FTB ${await lstate()}, slot ${await slot()}`);
writeFileSync(join(HERE, "round3-probe.txt"), out.join("\n") + "\n");
process.exit(0);
