#!/usr/bin/env node
// Bench test 1 (independence): does the on-program composition keep updating in MASTER?
// Records ~3 s of PH-MASTER's program through its "Recording" output, extracts two frames
// 2 s apart, and compares the COUNTER (stopwatch) region. If the pixels differ, the
// composition document is still rendering and its NDI feed is still moving.
//
// Use: minimise (or hide) the PH-A window, make sure PH-A is on program, then
//   node test/bench1-independence.mjs
// BENCH ONLY: it stops and restarts MASTER's Recording output to get a finished file.
// Needs ffmpeg on PATH.

import { execFileSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const B = (process.env.MIMO || "http://localhost:8989") + "/api/v1";
const j = (p) => fetch(B + p).then((r) => r.json());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const docs = (await j("/documents")).data;
const M = docs.find((d) => d.attributes.name.replace(/\.tvshow$/, "") === "PH-MASTER").id;
// The moving stopwatch is what proves the picture updates; without it the region is static and
// the test would fail for the wrong reason.
for (const n of ["PH-A", "PH-B"]) {
  const d = docs.find((x) => x.attributes.name.replace(/\.tvshow$/, "") === n).id;
  if (!(await j(`/documents/${d}/layers`)).data.some((l) => l.attributes.name === "COUNTER")) {
    console.error(`This test needs the bench stopwatch COUNTER in ${n}, which the release does not ship.\nAdd it back: BENCH_COUNTER=1 node documents/build-documents.mjs (README, Bench protocol). Delete it again before a show.`);
    process.exit(2);
  }
}
const srcs = (await j(`/documents/${M}/sources`)).data;
const onAir = srcs.filter((s) => /^NDI PH-/.test(s.attributes.name) && s.attributes["tally-state"] === "program").map((s) => s.attributes.name);
const rec = (await j(`/documents/${M}/output-destinations`)).data.find((o) => o.attributes.title === "Recording");
const wasLive = rec.attributes["live-state"] === "live";

const movies = join(homedir(), "Movies");
const newest = () => readdirSync(movies).filter((f) => f.startsWith("PH-MASTER") && f.endsWith(".mov"))
  .map((f) => join(movies, f)).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];

if (wasLive) { await j(`/documents/${M}/output-destinations/${rec.id}/setOff`); await sleep(1000); }
const before = newest();
await j(`/documents/${M}/output-destinations/${rec.id}/setLive`);
await sleep(3200);
await j(`/documents/${M}/output-destinations/${rec.id}/setOff`);
await sleep(1500);
const clip = newest();
if (wasLive) await j(`/documents/${M}/output-destinations/${rec.id}/setLive`);
if (!clip || clip === before) { console.log("FAIL: no new recording appeared in ~/Movies"); process.exit(1); }

// COUNTER sits top-left (stopwatch default anchor); crop generously around it.
const grab = (t) => execFileSync("ffmpeg", ["-v", "error", "-ss", String(t), "-i", clip, "-frames:v", "1",
  "-vf", "crop=360:120:20:40", "-f", "rawvideo", "-pix_fmt", "gray", "-"]);
const f1 = grab(0.5), f2 = grab(2.5);
let diff = 0;
for (let i = 0; i < f1.length; i++) diff += Math.abs(f1[i] - f2[i]);
const mean = diff / f1.length;
const pass = mean > 1.0;
console.log(`on program: ${onAir.join(", ") || "(none)"}`);
console.log(`clip: ${clip}`);
console.log(`counter region mean abs diff over 2 s: ${mean.toFixed(2)} (threshold 1.0)`);
console.log(pass ? "PASS: the on-program composition kept updating in MASTER" : "FAIL: counter region did not change — the composition stopped rendering or NDI froze");
process.exit(pass ? 0 : 1);
