#!/usr/bin/env node
// analyse-take: scrub the TAKE recorded by record-take.mjs.
//   node test/analyse-take.mjs [clip]     (default: the clip named in test/take-recording.json)
// Per frame:
//   mix      0 = A's background colour, 1 = B's (bottom-right patch, away from letters/COUNTER)
//   bandDiff colour distance between rows 0–25 and rows 60–110 (x 600–1900: background only)
//   edge     largest row-to-row luminance step in rows 1–110 (same x span) — a TALLY bar edge shows here
// (A plain "rows of TALLY red" count is NOT used: 20–40 % into the fade the orange→blue blend is
//  itself red enough to trip it across the whole frame. bandDiff/edge compare against the rows below.)
// Control: the same metrics on evidence/master-pgm-A-zoom100.png (uncropped, bar visible) must
// fail, or the metrics prove nothing.
// Also: blackdetect over the clip; the dissolve must move monotonically with no repeated frame.
// Writes evidence/take/ (contact sheet of the top band across the dissolve, COUNTER close-ups)
// and test/take-analysis.json.
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const clip = process.argv[2] || JSON.parse(readFileSync(join(HERE, "take-recording.json"), "utf8")).clip;
const OUT = join(HERE, "evidence", "take");
mkdirSync(OUT, { recursive: true });
const W = 1920, H = 1080, FB = W * H * 3;

function metrics(buf) {
  const px = (x, y) => { const i = (y * W + x) * 3; return [buf[i], buf[i + 1], buf[i + 2]]; };
  const mean = (x0, x1, y0, y1, step = 4) => {
    let r = 0, g = 0, b = 0, n = 0;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x += step) { const p = px(x, y); r += p[0]; g += p[1]; b += p[2]; n++; }
    return [r / n, g / n, b / n];
  };
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  const lum = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  const bg = mean(1500, 1900, 800, 1000, 8);
  const bandDiff = dist(mean(600, 1900, 0, 26), mean(600, 1900, 60, 110));
  let edge = 0, prev = lum(mean(600, 1900, 0, 1));
  for (let y = 1; y <= 110; y++) { const l = lum(mean(600, 1900, y, y + 1)); edge = Math.max(edge, Math.abs(l - prev)); prev = l; }
  return { bg, bandDiff, edge };
}
const r2 = (x) => Math.round(x * 100) / 100;

// Control first.
const ctl = metrics(execFileSync("ffmpeg", ["-v", "error", "-i", join(HERE, "evidence", "master-pgm-A-zoom100.png"), "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { maxBuffer: 64 << 20 }));

const fps = eval(execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=r_frame_rate", "-of", "csv=p=0", clip], { encoding: "utf8" }).trim());
const frames = [];
await new Promise((res, rej) => {
  const ff = spawn("ffmpeg", ["-v", "error", "-i", clip, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]);
  let acc = Buffer.alloc(0);
  ff.stdout.on("data", (d) => {
    acc = Buffer.concat([acc, d]);
    while (acc.length >= FB) { frames.push(metrics(acc.subarray(0, FB))); acc = acc.subarray(FB); }
  });
  ff.on("close", (c) => (c === 0 ? res() : rej(new Error("ffmpeg " + c))));
});
const cA = frames[0].bg, cB = frames.at(-1).bg;
const ab = [cB[0] - cA[0], cB[1] - cA[1], cB[2] - cA[2]], ab2 = ab[0] ** 2 + ab[1] ** 2 + ab[2] ** 2;
frames.forEach((f) => { f.mix = ((f.bg[0] - cA[0]) * ab[0] + (f.bg[1] - cA[1]) * ab[1] + (f.bg[2] - cA[2]) * ab[2]) / ab2; });
const dis = frames.map((f, i) => i).filter((i) => frames[i].mix > 0.03 && frames[i].mix < 0.97);
const n0 = dis[0], n1 = dis.at(-1);
const mid = dis.reduce((m, i) => (Math.abs(frames[i].mix - 0.5) < Math.abs(frames[m].mix - 0.5) ? i : m), dis[0]);
const monotonic = dis.every((i, k) => k === 0 || frames[i].mix > frames[dis[k - 1]].mix + 0.005);
const contiguous = dis.every((i, k) => k === 0 || i === dis[k - 1] + 1);
const worst = { bandDiff: Math.max(...frames.map((f) => f.bandDiff)), edge: Math.max(...frames.map((f) => f.edge)) };
const bd =execFileSync("sh", ["-c", `ffmpeg -v info -i "${clip}" -vf blackdetect=d=0.03:pix_th=0.10 -an -f null - 2>&1 | grep -c black_start || true`], { encoding: "utf8" }).trim();

// Evidence images: top band (140 px) of frames n0-2 .. n1+2 as a contact sheet; COUNTER close-ups.
const a = Math.max(0, n0 - 2), b = Math.min(frames.length - 1, n1 + 2), k = b - a + 1;
execFileSync("ffmpeg", ["-v", "error", "-y", "-i", clip, "-vf", `select='between(n\\,${a}\\,${b})',crop=1920:140:0:0,scale=960:70,tile=1x${k}`, "-frames:v", "1", join(OUT, "top-band-contact-sheet.png")]);
const zoomCounter = (n, name) => execFileSync("ffmpeg", ["-v", "error", "-y", "-i", clip, "-vf", `select='eq(n\\,${n})',crop=600:130:0:0,scale=1200:260`, "-frames:v", "1", join(OUT, name)]);
zoomCounter(n0 - 1, "counter-1-last-A.png"); zoomCounter(mid, "counter-2-midpoint.png"); zoomCounter(n1 + 1, "counter-3-first-B.png");
execFileSync("ffmpeg", ["-v", "error", "-y", "-i", clip, "-vf", `select='eq(n\\,${mid})'`, "-frames:v", "1", join(OUT, "midpoint-full.png")]);

const report = {
  clip, fps: r2(fps), frames: frames.length,
  dissolve: { firstFrame: n0, lastFrame: n1, frames: dis.length, ms: Math.round((dis.length / fps) * 1000), midpointFrame: mid, midpointMix: r2(frames[mid].mix), monotonic, contiguous,
    mixPerFrame: dis.map((i) => r2(frames[i].mix)) },
  tallyEdge: { worstOverClip: { bandDiff: r2(worst.bandDiff), edge: r2(worst.edge) },
    duringDissolve: dis.map((i) => ({ n: i, mix: r2(frames[i].mix), bandDiff: r2(frames[i].bandDiff), edge: r2(frames[i].edge) })),
    control_uncropped_png: { bandDiff: r2(ctl.bandDiff), edge: r2(ctl.edge) } },
  blackStarts: Number(bd),
};
writeFileSync(join(HERE, "take-analysis.json"), JSON.stringify(report, null, 1));
console.log(JSON.stringify({ ...report, tallyEdge: { ...report.tallyEdge, duringDissolve: undefined } }, null, 1));
