#!/usr/bin/env node
// switcher-probe: where does PH-MASTER's Video Switcher expose its live slot, when does it change
// during a dissolve, and which WebSocket events announce it?
//   node test/switcher-probe.mjs        (MASTER live, on slot 1)
// 1. GET the switcher layer, Cut_2, GET again: diff every attribute, input-values and output-values.
// 2. Dis_1 while sampling the layer, both NDI sources' tally and the clock every ~40 ms.
// 3. Log every WebSocket event seen meanwhile.
// Ends on slot 1. Writes test/switcher-probe.txt.
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "switcher-probe.txt");
const B = "http://localhost:8989/api/v1";
const j = (u) => fetch(B + u).then((r) => (r.status === 204 ? null : r.json()));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = [];
const say = (s = "") => { out.push(s); console.log(s); };
const t0 = Date.now();
const ts = () => `${String(Date.now() - t0).padStart(6)} ms`;

const docs = (await j("/documents")).data;
const M = docs.find((d) => d.attributes.name.startsWith("PH-MASTER")).id;
const sw = (await j(`/documents/${M}/layers`)).data.find((l) => l.attributes.name === "AB Switcher");
const srcs = (await j(`/documents/${M}/sources`)).data;
const SA = srcs.find((s) => s.attributes.name === "NDI PH-A").id, SB = srcs.find((s) => s.attributes.name === "NDI PH-B").id;
const layer = async () => (await j(`/documents/${M}/layers/${sw.id}`)).data.attributes;
const sig = (s) => j(`/documents/${M}/layers/${sw.id}/signals/tvGroup_Control__${s}_TypeSignal`);
const tally = async () => {
  const [a, b] = await Promise.all([j(`/documents/${M}/sources/${SA}`), j(`/documents/${M}/sources/${SB}`)]);
  return `A=${a.data.attributes["tally-state"]} B=${b.data.attributes["tally-state"]}`;
};

// WebSocket log
const events = [];
const ws = new WebSocket("ws://localhost:8989/api/v1/socket");
await new Promise((r, x) => { ws.onopen = r; ws.onerror = x; });
ws.onmessage = (m) => { let e; try { e = JSON.parse(m.data); } catch { return; } if (e.event !== "pong") events.push({ t: Date.now() - t0, e }); };
await sleep(500);

say(`switcher layer ${sw.id}  (NDI PH-A=${SA}, NDI PH-B=${SB})`);
const pre = await layer();
say(`before: live slot ${pre["input-values"].tvGroup_Hidden_Inputs__currentLiveSource}, ${await tally()}`);
const mark1 = Date.now() - t0;
await sig("Cut_2");
await sleep(1000);
const post = await layer();
say(`after Cut_2: live slot ${post["input-values"].tvGroup_Hidden_Inputs__currentLiveSource}, ${await tally()}`);

say("\n== 1. diff of the switcher layer across one cut (every key that changed) ==");
const diff = (label, a = {}, b = {}) => {
  for (const k of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
    if (["input-values", "output-values", "input-descriptions", "output-descriptions"].includes(k)) continue;
    const x = JSON.stringify(a[k]), y = JSON.stringify(b[k]);
    if (x !== y) say(`  ${label}${k}: ${x?.slice(0, 100)}  →  ${y?.slice(0, 100)}`);
  }
};
diff("", pre, post);
diff("input-values.", pre["input-values"], post["input-values"]);
diff("output-values.", pre["output-values"], post["output-values"]);
say(`  (output-values has ${Object.keys(post["output-values"] || {}).length} keys: ${Object.keys(post["output-values"] || {}).join(", ")})`);
const desc = post["input-descriptions"]?.tvGroup_Hidden_Inputs__currentLiveSource;
say(`  description of currentLiveSource: ${JSON.stringify(desc)}`);

say("\n== 2. Dis_1 sampled (slot / tally) ==");
const mark2 = Date.now() - t0;
await sig("Dis_1");
let last = "";
const end = Date.now() + 1400;
while (Date.now() < end) {
  const [l, t] = await Promise.all([layer(), tally()]);
  const row = `slot ${l["input-values"].tvGroup_Hidden_Inputs__currentLiveSource} | ${t}`;
  if (row !== last) { say(`  +${String(Date.now() - t0 - mark2).padStart(5)} ms after Dis_1: ${row}`); last = row; }
  await sleep(40);
}

await sleep(800);
ws.close();
say("\n== 3. WebSocket events (times relative to Cut_2 / Dis_1) ==");
for (const { t, e } of events) {
  const rel = t >= mark2 ? `Dis_1 +${t - mark2}` : t >= mark1 ? `Cut_2 +${t - mark1}` : `before ${t - mark1}`;
  const who = e.id === sw.id || (e.id && sw.id.endsWith(e.id)) ? "AB Switcher" : e.id === SA || (e.id && SA.endsWith(e.id)) ? "NDI PH-A" : e.id === SB || (e.id && SB.endsWith(e.id)) ? "NDI PH-B" : e.id;
  const extra = Object.keys(e).filter((k) => !["type", "event", "id", "document-id"].includes(k));
  say(`  ${rel.padEnd(14)} ${e.type} ${e.event}  ${who}${extra.length ? "  keys: " + extra.join(",") : ""}`);
}
const sample = events.find(({ e }) => e.type === "layers" && (e.id === sw.id || sw.id.endsWith(e.id || "-")));
say(`\nsample switcher event: ${sample ? JSON.stringify(sample.e).slice(0, 600) : "none"}`);
writeFileSync(OUT, out.join("\n") + "\n");
process.exit(0);
