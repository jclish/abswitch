#!/usr/bin/env node
// safe-source-probe: before any code for the safe source (PANIC to a third switcher slot), read what
// 7.0b3 offers. Real mimoLive, PH-MASTER open, takectl NOT running. Writes test/safe-source-probe.txt
// and test/evidence/master-pgm-safe.png.
// 1. The switcher's slot 3: its input, name, tally code key, and whether Cut_3 / Dis_3 exist.
// 2. The slate: a "Video Output Test" source (Test Image 0 = "Philips PM5544") named "SAFE Test Pattern",
//    created in MASTER if missing, put in slot 3, read back.
// 3. Cut 1→3, 3→1, dissolve 1→3, 3→1, cut 2→3, 3→1: the live slot, all three per-slot codes and the
//    three sources' tally every 50 ms, and the WebSocket events for the three sources.
// Leaves the source in slot 3 (unsaved), MASTER on slot 1, the shows as found.
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const B = "http://localhost:8989/api/v1";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const req = async (method, u, body) => { const r = await fetch(B + u, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined }); const t = await r.text(); try { return { status: r.status, ...JSON.parse(t) }; } catch { return { status: r.status, raw: t }; } };
const j = (u) => req("GET", u);
const out = [];
const say = (s) => { out.push(s); console.log(s); };

const docs = (await j("/documents")).data;
const D = Object.fromEntries(["PH-A", "PH-B", "PH-MASTER"].map((n) => [n, docs.find((d) => d.attributes.name.replace(/\.tvshow$/, "") === n)]));
const M = D["PH-MASTER"].id;
const was = Object.fromEntries(Object.entries(D).map(([n, d]) => [n, d.attributes["live-state"]]));
const sw = (await j(`/documents/${M}/layers`)).data.find((l) => l.attributes.name === "AB Switcher");
const swRead = async () => (await j(`/documents/${M}/layers/${sw.id}`)).data.attributes;

// ---- 1. slot 3 as found
let a = await swRead();
const iv = a["input-values"], ov = a["output-values"], desc = a["input-descriptions"] ?? {};
say(`switcher "${sw.attributes.name}": Source Count = ${iv.tvGroup_Control__Source_Count} (${JSON.stringify(desc.tvGroup_Control__Source_Count?.["value-list"])})`);
say(`slot 3 as found: tvIn_VideoSourceCImage=${JSON.stringify(iv.tvIn_VideoSourceCImage)}, tvIn_VideoSourceCName=${JSON.stringify(iv.tvIn_VideoSourceCName)}, tally key tvOut_tvIn_VideoSourceCImageTallyState=${JSON.stringify(ov.tvOut_tvIn_VideoSourceCImageTallyState)}`);
say(`signals: Cut_3 ${"tvGroup_Control__Cut_3_TypeSignal" in iv ? "exists" : "MISSING"}, Dis_3 ${"tvGroup_Control__Dis_3_TypeSignal" in iv ? "exists" : "MISSING"}`);

// ---- 2. the slate
let srcs = (await j(`/documents/${M}/sources`)).data;
let safe = srcs.find((s) => s.attributes.name === "SAFE Test Pattern");
if (!safe) {
  const r = await req("POST", `/documents/${M}/sources`, { "source-type": "com.boinx.boinxtv.layer.videooutputtest", name: "SAFE Test Pattern" });
  safe = r.data;
  say(`created source: POST → ${r.status}, id ${safe.id}`);
}
let sa = (await j(`/documents/${M}/sources/${safe.id}`)).data.attributes;
say(`source "${sa.name}": type ${sa["source-type"]}, Test Image = ${sa["input-values"].tvGroup_Content__Test_Image} (${JSON.stringify(sa["input-descriptions"].tvGroup_Content__Test_Image?.["value-list"])}), video-device-connected ${JSON.stringify(sa["video-device-connected"])}, tally ${sa["tally-state"]}`);
const put = await req("PUT", `/documents/${M}/layers/${sw.id}`, { "input-values": { tvIn_VideoSourceCImage: safe.id } });
await sleep(500);
a = await swRead();
say(`slot 3 ← source: PUT → ${put.status}; read back tvIn_VideoSourceCImage=${JSON.stringify(a["input-values"].tvIn_VideoSourceCImage)}, name ${JSON.stringify(a["input-values"].tvIn_VideoSourceCName)}`);

// ---- shows on (Recording off)
for (const n of ["PH-A", "PH-B", "PH-MASTER"]) if (was[n] !== "live") await j(`/documents/${D[n].id}/setLive`);
await sleep(2500);
const rec = (await j(`/documents/${M}/output-destinations`)).data.find((o) => o.attributes.title === "Recording");
if (rec) await j(`/documents/${M}/output-destinations/${rec.id}/setOff`);

// ---- 3. cuts and dissolves, watched
const srcIds = { A: srcs.find((s) => s.attributes.name === "NDI PH-A").id, B: srcs.find((s) => s.attributes.name === "NDI PH-B").id, SAFE: safe.id };
const events = [];
const ws = new WebSocket(B.replace(/^http/, "ws") + "/socket");
ws.onmessage = (m) => { try { const e = JSON.parse(m.data); if (e.type === "sources" && e.event === "changed" && e["document-id"] === M) { const who = Object.entries(srcIds).find(([, id]) => id === e.id || id.endsWith(e.id))?.[0]; if (who) events.push({ t: Date.now(), who, tally: e.data?.attributes?.["tally-state"] }); } } catch {} };
await new Promise((r) => { ws.onopen = r; setTimeout(r, 2000); });
const sig = (k) => j(`/documents/${M}/layers/${sw.id}/signals/tvGroup_Control__${k}_TypeSignal`);
const tallyOf = async (id) => (await j(`/documents/${M}/sources/${id}`)).data.attributes["tally-state"];
const watch = async (label, k, ms) => {
  const t0 = Date.now();
  events.length = 0;
  await sig(k);
  const rows = [];
  while (Date.now() - t0 < ms) {
    const x = await swRead();
    const o = x["output-values"];
    rows.push(`${String(Date.now() - t0).padStart(4)} ms  slot ${x["input-values"].tvGroup_Hidden_Inputs__currentLiveSource}  codes A/B/C ${o.tvOut_tvIn_VideoSourceAImageTallyState}/${o.tvOut_tvIn_VideoSourceBImageTallyState}/${o.tvOut_tvIn_VideoSourceCImageTallyState}  tally ${await tallyOf(srcIds.A)}/${await tallyOf(srcIds.B)}/${await tallyOf(srcIds.SAFE)}`);
    await sleep(50);
  }
  const compact = rows.filter((r, i) => i === 0 || r.slice(8) !== rows[i - 1].slice(8));
  say(`\n${label} (${k}):\n  ${compact.join("\n  ")}\n  websocket: ${events.map((e) => `${e.t - t0} ms ${e.who} ${e.tally}`).join(", ") || "none"}`);
};
if ((await swRead())["input-values"].tvGroup_Hidden_Inputs__currentLiveSource !== 1) { await sig("Cut_1"); await sleep(800); }
await watch("cut 1 → 3", "Cut_3", 900);
// a frame of MASTER's program while the test pattern is on air
mkdirSync(join(HERE, "evidence"), { recursive: true });
await new Promise((r) => { const f = spawn("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "mpjpeg", "-i", `${B}/documents/${M}/programOut?format=mjpeg&fps=5&width=640`, "-frames:v", "1", "-y", join(HERE, "evidence", "master-pgm-safe.png")]); f.on("exit", r); });
await watch("cut 3 → 1", "Cut_1", 900);
await watch("dissolve 1 → 3", "Dis_3", 1300);
await watch("dissolve 3 → 1", "Dis_1", 1300);
await sig("Cut_2"); await sleep(800);
await watch("cut 2 → 3", "Cut_3", 900);
await watch("cut 3 → 1", "Cut_1", 900);
ws.close();

// ---- restore
for (const n of ["PH-MASTER", "PH-A", "PH-B"]) if (was[n] !== "live") await j(`/documents/${D[n].id}/setOff`);
a = await swRead();
say(`\nleft: MASTER on slot ${a["input-values"].tvGroup_Hidden_Inputs__currentLiveSource}; slot 3 holds "${a["input-values"].tvIn_VideoSourceCName}" (unsaved); shows as found ${JSON.stringify(was)}`);
writeFileSync(join(HERE, "safe-source-probe.txt"), out.join("\n") + "\n");
process.exit(0);
