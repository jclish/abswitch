#!/usr/bin/env node
// switcher-probe-2: follow-up to switcher-probe.
//   node test/switcher-probe-2.mjs      (MASTER live, on slot 1)
// a. Dis_2 sampled: live slot, the switcher's own per-slot tally outputs, and source tally.
// b. Dis_1 then Cut_1 200 ms later (the /panic case): where does the slot end, and when?
// c. Then a second Cut_1 once that dissolve is over: does it land?
// d. Every WebSocket event for the AB Switcher layer over the whole run (connect burst marked).
// Ends on slot 1. Writes test/switcher-probe-2.txt.
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "switcher-probe-2.txt");
const B = "http://localhost:8989/api/v1";
const j = (u) => fetch(B + u).then((r) => (r.status === 204 ? null : r.json()));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = [];
const say = (s = "") => { out.push(s); console.log(s); };
const t0 = Date.now();

const docs = (await j("/documents")).data;
const M = docs.find((d) => d.attributes.name.startsWith("PH-MASTER")).id;
const sw = (await j(`/documents/${M}/layers`)).data.find((l) => l.attributes.name === "AB Switcher");
const srcs = (await j(`/documents/${M}/sources`)).data;
const SA = srcs.find((s) => s.attributes.name === "NDI PH-A").id, SB = srcs.find((s) => s.attributes.name === "NDI PH-B").id;
const sig = (s) => j(`/documents/${M}/layers/${sw.id}/signals/tvGroup_Control__${s}_TypeSignal`);
const read = async () => {
  const [l, a, b] = await Promise.all([j(`/documents/${M}/layers/${sw.id}`), j(`/documents/${M}/sources/${SA}`), j(`/documents/${M}/sources/${SB}`)]);
  const iv = l.data.attributes["input-values"], ov = l.data.attributes["output-values"];
  return `slot ${iv.tvGroup_Hidden_Inputs__currentLiveSource} (out ${ov.tvSet_tvGroup_Hidden_Inputs__currentLiveSource}) | switcher tally 1=${ov.tvOut_tvIn_VideoSourceAImageTallyState} 2=${ov.tvOut_tvIn_VideoSourceBImageTallyState} | source A=${a.data.attributes["tally-state"]} B=${b.data.attributes["tally-state"]}`;
};
const sample = async (from, ms) => {
  let last = "";
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const r = await read();
    if (r !== last) { say(`  +${String(Date.now() - from).padStart(5)} ms: ${r}`); last = r; }
    await sleep(30);
  }
};

const swEvents = [];
const ws = new WebSocket("ws://localhost:8989/api/v1/socket");
await new Promise((r, x) => { ws.onopen = r; ws.onerror = x; });
ws.onmessage = (m) => { let e; try { e = JSON.parse(m.data); } catch { return; } if (e.id === sw.id) swEvents.push({ t: Date.now() - t0, e }); };
await sleep(1500);
const connectBurstEnd = Date.now() - t0;
say(`start: ${await read()}`);

say("\n== a. Dis_2 ==");
let m = Date.now(); await sig("Dis_2"); await sample(m, 1100);

say("\n== b. Dis_1, then Cut_1 200 ms later ==");
m = Date.now(); await sig("Dis_1"); await sleep(1100);
say(`  (back on 1 first: ${await read()})`);
m = Date.now(); await sig("Dis_2");
await sleep(200 - (Date.now() - m));
say(`  Dis_2 sent at +0, Cut_1 sent at +${Date.now() - m} ms`);
await sig("Cut_1");
await sample(m, 1100);

say("\n== c. second Cut_1, sent after that dissolve is over ==");
const m2 = Date.now(); await sig("Cut_1"); await sample(m2, 600);

await sleep(3000);
ws.close();
say(`\n== d. WebSocket events for AB Switcher (connect burst ends at ${connectBurstEnd} ms; run lasted ${Date.now() - t0} ms) ==`);
for (const { t, e } of swEvents) say(`  ${String(t).padStart(6)} ms ${t <= connectBurstEnd ? "(connect burst)" : ""} ${e.type} ${e.event} ${JSON.stringify(e.data).slice(0, 160)}`);
say(`  after the connect burst: ${swEvents.filter((x) => x.t > connectBurstEnd).length} events`);
say(`end: ${await read()}`);
writeFileSync(OUT, out.join("\n") + "\n");
process.exit(0);
