// crop-check: put one side on MASTER's program with its TALLY lit, apply each zoom to that side's
// Scale & Transform filter, record ~2 s of MASTER, and count TALLY-red rows at the top of a frame.
// Restores shows / TALLY / live slot afterwards (the LAST zoom given stays on the filter).
//   SIDE=A node test/crop-check.mjs test/evidence 100 105     # 100 = control (bar visible)
//   SIDE=B node test/crop-check.mjs test/evidence 100 105
// BENCH ONLY: starts all three shows and leaves a clip per zoom in ~/Movies. Needs ffmpeg.
// ALL_OFF=1 forces the restore to "shows off, TALLY off" (use after an interrupted run).
import { execFileSync } from "node:child_process";
import { readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const B = "http://localhost:8989/api/v1";
const j = (p, o) => fetch(B + p, o).then((r) => (r.status === 204 ? null : r.json()));
const put = (p, body) => j(p, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const OUT = process.argv[2];
const zooms = process.argv.slice(3).map(Number);

const docs = (await j("/documents")).data;
const id = (n) => docs.find((d) => d.attributes.name.replace(/\.tvshow$/, "") === n).id;
const M = id("PH-MASTER"), A = id("PH-A"), Bd = id("PH-B");
const SIDE = process.env.SIDE || "A", TD = SIDE === "A" ? A : Bd, SLOT = SIDE === "A" ? 1 : 2;
const live = async (d) => (await j(`/documents/${d}`)).data.attributes["live-state"];
const was = process.env.ALL_OFF ? { M: "off", A: "off", B: "off" } : { M: await live(M), A: await live(A), B: await live(Bd) };

const srcA = (await j(`/documents/${M}/sources`)).data.find((s) => s.attributes.name === `NDI PH-${SIDE}`).id;
const filt = (await j(`/documents/${M}/sources/${srcA}/filters`)).data[0].id;
const FU = `/documents/${M}/sources/${srcA}/filters/${filt}`;
const sw = (await j(`/documents/${M}/layers`)).data.find((l) => l.attributes.name === "AB Switcher");
const tallyA = (await j(`/documents/${TD}/layers`)).data.find((l) => l.attributes.name === "TALLY");
const rec = (await j(`/documents/${M}/output-destinations`)).data.find((o) => o.attributes.title === "Recording");

for (const d of [A, Bd, M]) if ((await live(d)) !== "live") await j(`/documents/${d}/setLive`);
await sleep(2500);
await j(`/documents/${M}/output-destinations/${rec.id}/setOff`);
const slot = async () => (await j(`/documents/${M}/layers/${sw.id}`)).data.attributes["input-values"]["tvGroup_Hidden_Inputs__currentLiveSource"];
const slotWas = await slot();
if (slotWas !== SLOT) { await j(`/documents/${M}/layers/${sw.id}/signals/tvGroup_Control__Cut_${SLOT}_TypeSignal`); await sleep(500); }
const tallyWas = process.env.ALL_OFF ? "off" : tallyA.attributes["live-state"];
await j(`/documents/${TD}/layers/${tallyA.id}/setLive`);
await sleep(800);

const movies = join(homedir(), "Movies");
const newest = () => readdirSync(movies).filter((f) => f.startsWith("PH-MASTER") && f.endsWith(".mov"))
  .map((f) => join(movies, f)).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];

const results = [];
for (const z of zooms) {
  const iv = z === 0 ? { tvGroup_Geometry__Mode: 0, tvGroup_Geometry__Width: 1920, tvGroup_Geometry__Height: 1080, tvGroup_Geometry__Zoom: 100 }
                     : { tvGroup_Geometry__Mode: 0, tvGroup_Geometry__Width: 1920, tvGroup_Geometry__Height: 1080, tvGroup_Geometry__Zoom: z };
  await put(FU, { "input-values": iv });
  await sleep(600);
  const back = (await j(FU)).data.attributes;
  const before = newest();
  await j(`/documents/${M}/output-destinations/${rec.id}/setLive`);
  await sleep(2200);
  await j(`/documents/${M}/output-destinations/${rec.id}/setOff`);
  await sleep(1500);
  const clip = newest();
  if (clip === before) { results.push({ z, err: "no clip" }); continue; }
  const png = join(OUT, `master-pgm-${SIDE}-zoom${z}.png`);
  execFileSync("ffmpeg", ["-v", "error", "-y", "-ss", "1.0", "-i", clip, "-frames:v", "1", png]);
  const raw = execFileSync("ffmpeg", ["-v", "error", "-ss", "1.0", "-i", clip, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { maxBuffer: 64 << 20 });
  const W = 1920, H = raw.length / 3 / W;
  const redRows = [];
  for (let y = 0; y < 80; y++) {
    let red = 0;
    for (let x = 0; x < W; x++) { const i = (y * W + x) * 3; if (raw[i] > 150 && raw[i + 1] < 90 && raw[i + 2] < 90) red++; }
    if (red / W > 0.5) redRows.push(y);
  }
  results.push({ zoom: z, readback: { mode: back["input-values"].tvGroup_Geometry__Mode, w: back["input-values"].tvGroup_Geometry__Width, h: back["input-values"].tvGroup_Geometry__Height, zoom: back["input-values"].tvGroup_Geometry__Zoom, result: `${back["output-values"].tvOut_FilterResultWidth}x${back["output-values"].tvOut_FilterResultHeight}` }, frameH: H, redRows: redRows.length ? `${redRows.length} rows (${redRows[0]}..${redRows.at(-1)})` : "none", clip, png });
}

// restore
if (tallyWas !== "live") await j(`/documents/${TD}/layers/${tallyA.id}/setOff`);
if (slotWas !== SLOT) await j(`/documents/${M}/layers/${sw.id}/signals/tvGroup_Control__Cut_${slotWas}_TypeSignal`);
for (const [k, d] of [["M", M], ["A", A], ["B", Bd]]) if (was[k] !== "live") await j(`/documents/${d}/setOff`);
writeFileSync(join(OUT, `crop-check-${SIDE}.json`), JSON.stringify(results, null, 1));
console.log(JSON.stringify({ was, slotWas, tallyWas, results }, null, 1));
