#!/usr/bin/env node
// stinger-cover: measure the STINGER layer's opaque window on PH-MASTER's program output, and from it
// the config values takectl uses (round 2, item 9).
//   node test/stinger-cover.mjs            measure and print
//   node test/stinger-cover.mjs --write    also set stingerCoverMs / stingerOffMs in takectl.config.json
// Needs ffmpeg, the shows running, MASTER on A (slot 1), takectl NOT running.
// 1. Delay of the picture path (MASTER render → MJPEG → ffmpeg → here): three cuts A↔B, timed from
//    the signal to the first frame that shows the other side. Their median is subtracted below.
// 2. STINGER on, held 1.5 s, off; every frame's coverage = share of pixels within reach of the
//    stinger's colour (taken from the middle of the hold).
// Cover-in = first fully covered frame after "on", less the delay. Cover-hold = how long the frame
// stays fully covered after "off", less the delay. stingerCoverMs = cover-in + 2 frames of margin;
// stingerOffMs = how long after the commit takectl switches the stinger off (2 frames + one more
// for the switcher's cut to render), so the cut is always under full cover.
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const B = "http://localhost:8989/api/v1";
const W = 64, H = 36, FRAME = W * H * 3;
const j = (u) => fetch(B + u).then((r) => (r.status === 204 ? null : r.json()));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = [];
const say = (s) => { out.push(s); console.log(s); };

const docs = (await j("/documents")).data;
const M = docs.find((d) => d.attributes.name.startsWith("PH-MASTER")).id;
const layers = (await j(`/documents/${M}/layers`)).data;
const sw = layers.find((l) => l.attributes.name === "AB Switcher");
const st = layers.find((l) => l.attributes.name === "STINGER");
if (!st) { console.error("MASTER has no STINGER layer: run documents/build-documents.mjs first"); process.exit(2); }
const slot = async () => (await j(`/documents/${M}/layers/${sw.id}`)).data.attributes["input-values"].tvGroup_Hidden_Inputs__currentLiveSource;
const cut = (n) => j(`/documents/${M}/layers/${sw.id}/signals/tvGroup_Control__Cut_${n}_TypeSignal`);
if ((await slot()) !== 1) { await cut(1); await sleep(800); }

// ---- frames, timestamped on arrival
const frames = [];
const ff = spawn("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "mpjpeg", "-i", `${B}/documents/${M}/programOut?format=mjpeg&fps=30&width=320`,
  "-vf", `scale=${W}:${H}`, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]);
let buf = Buffer.alloc(0);
ff.stdout.on("data", (d) => {
  buf = Buffer.concat([buf, d]);
  while (buf.length >= FRAME) { frames.push({ t: Date.now(), px: buf.subarray(0, FRAME) }); buf = buf.subarray(FRAME); }
});
const mean = (px) => { let r = 0, g = 0, b = 0; for (let i = 0; i < px.length; i += 3) { r += px[i]; g += px[i + 1]; b += px[i + 2]; } const n = px.length / 3; return [r / n, g / n, b / n]; };
const side = (px) => { const [r, , b] = mean(px); return r > b + 30 ? "A" : b > r + 30 ? "B" : "?"; }; // A is orange, B is blue
await sleep(1200);

try {
  // ---- 1. delay of the picture path
  const delays = [];
  for (const [to, want] of [[2, "B"], [1, "A"], [2, "B"], [1, "A"]].slice(0, 4)) {
    await sleep(700);
    const t0 = Date.now();
    await cut(to);
    const hit = await (async () => { for (let i = 0; i < 60; i++) { const f = frames.find((x) => x.t >= t0 && side(x.px) === want); if (f) return f; await sleep(25); } return null; })();
    if (hit) delays.push(hit.t - t0);
  }
  delays.sort((a, b) => a - b);
  const L = delays[Math.floor(delays.length / 2)];
  const gaps = frames.slice(-60).map((f, i, a) => (i ? f.t - a[i - 1].t : null)).filter(Boolean).sort((a, b) => a - b);
  const frameMs = gaps[Math.floor(gaps.length / 2)];
  say(`picture-path delay: ${delays.join(", ")} ms → median ${L} ms; frame interval ~${frameMs} ms`);
  if ((await slot()) !== 1) { await cut(1); await sleep(800); }

  // ---- 2. the stinger
  await sleep(800);
  const tOn = Date.now();
  await j(`/documents/${M}/layers/${st.id}/setLive`);
  await sleep(1500);
  const tOff = Date.now();
  await j(`/documents/${M}/layers/${st.id}/setOff`);
  await sleep(1500);
  const win = frames.filter((f) => f.t >= tOn - 200);
  const ref = mean(win.find((f) => f.t >= tOn + 900)?.px ?? win[0].px); // middle of the hold: fully covered
  const cover = (px) => { let n = 0; for (let i = 0; i < px.length; i += 3) if (Math.abs(px[i] - ref[0]) + Math.abs(px[i + 1] - ref[1]) + Math.abs(px[i + 2] - ref[2]) < 45) n++; return n / (px.length / 3); };
  const rows = win.map((f) => ({ t: f.t, c: cover(f.px) }));
  const full = (r) => r.c >= 0.98;
  const firstFull = rows.find((r) => r.t >= tOn && full(r));
  const lastFull = [...rows].reverse().find((r) => r.t <= tOff + 2000 && full(r));
  const coverIn = firstFull.t - tOn - L;
  const coverHold = lastFull.t - tOff - L;
  say(`stinger colour (mid-hold) rgb(${ref.map((v) => Math.round(v)).join(", ")})`);
  say(`coverage by frame (ms after "on", less the delay): ${rows.filter((r) => r.t < tOn + 900).map((r) => `${r.t - tOn - L}:${Math.round(r.c * 100)}%`).join(" ")}`);
  say(`coverage after "off": ${rows.filter((r) => r.t >= tOff).slice(0, 18).map((r) => `${r.t - tOff - L}:${Math.round(r.c * 100)}%`).join(" ")}`);
  const coverMs = Math.ceil((coverIn + 2 * frameMs) / 10) * 10;
  const offMs = Math.ceil((3 * frameMs) / 10) * 10;
  say(`fully covered from ~${coverIn} ms after "on" until ~${coverHold} ms after "off"`);
  say(`→ stingerCoverMs = ${coverMs} (cover-in + 2 frames), stingerOffMs = ${offMs} (3 frames after the commit)`);
  if (process.argv.includes("--write")) {
    const p = join(dirname(HERE), "takectl.config.json");
    const cfg = JSON.parse(readFileSync(p, "utf8"));
    Object.assign(cfg, { stingerCoverMs: coverMs, stingerOffMs: offMs });
    writeFileSync(p, JSON.stringify(cfg, null, 2) + "\n");
    say(`written to takectl.config.json`);
  }
} finally {
  ff.kill();
  await j(`/documents/${M}/layers/${st.id}/setOff`);
  writeFileSync(join(HERE, "stinger-cover.txt"), out.join("\n") + "\n");
}
process.exit(0);
