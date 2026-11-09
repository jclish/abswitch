#!/usr/bin/env node
// tally-swap-check: locate a source whose tally sticks at "program" while the other is on air.
//   node test/tally-swap-check.mjs
// Runs three configurations, cutting MASTER to slot 2 then slot 1 in each and reading both
// NDI sources' tally-state:
//   1. as built;
//   2. senders swapped between the two MASTER sources (source objects + filters stay put);
//   3. switcher slots swapped (each source moves to the other slot).
// Whatever the stuck "program" follows (source object, sender or slot) is where the cause lives.
// Restores senders, slots, live slot and shows. Writes test/tally-swap-check.txt.
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const B = "http://localhost:8989/api/v1";
const j = (u, o) => fetch(B + u, o).then((r) => (r.status === 204 ? null : r.json()));
const put = (u, body) => j(u, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = [];
const say = (s) => { out.push(s); console.log(s); };

const docs = (await j("/documents")).data;
const id = (n) => docs.find((d) => d.attributes.name.replace(/\.tvshow$/, "") === n).id;
const D = { A: id("PH-A"), B: id("PH-B"), M: id("PH-MASTER") };
const srcs = async () => Object.fromEntries((await j(`/documents/${D.M}/sources`)).data.filter((s) => s.attributes.name.startsWith("NDI")).map((s) => [s.attributes.name, s]));
const S0 = await srcs();
const SA = S0["NDI PH-A"].id, SB = S0["NDI PH-B"].id;
const devA = S0["NDI PH-A"].attributes["video-device-id"], devB = S0["NDI PH-B"].attributes["video-device-id"];
const sw = (await j(`/documents/${D.M}/layers`)).data.find((l) => l.attributes.name === "AB Switcher");
const swIv = async () => (await j(`/documents/${D.M}/layers/${sw.id}`)).data.attributes["input-values"];
const iv0 = await swIv();
const rec = (await j(`/documents/${D.M}/output-destinations`)).data.find((o) => o.attributes.title === "Recording");
const sig = (s) => j(`/documents/${D.M}/layers/${sw.id}/signals/tvGroup_Control__${s}_TypeSignal`);
const live = async (r) => (await j(`/documents/${D[r]}`)).data.attributes["live-state"];
const was = { A: await live("A"), B: await live("B"), M: await live("M") };

const snap = async () => {
  const s = await srcs(), iv = await swIv();
  const slotOf = (sid) => (iv.tvIn_VideoSourceAImage === sid ? 1 : iv.tvIn_VideoSourceBImage === sid ? 2 : "-");
  return ["NDI PH-A", "NDI PH-B"].map((n) => `${n} [slot ${slotOf(s[n].id)}, sender ${s[n].attributes["video-device-id"].replace(/^.*\(/, "(")}, connected ${s[n].attributes["video-device-connected"]}] = ${s[n].attributes["tally-state"]}`).join("  |  ");
};
const round = async (label) => {
  say(`-- ${label}`);
  await sig("Cut_2"); await sleep(1500); say(`   live slot 2:  ${await snap()}`);
  await sig("Cut_1"); await sleep(1500); say(`   live slot 1:  ${await snap()}`);
};

for (const r of ["A", "B", "M"]) if (was[r] !== "live") await j(`/documents/${D[r]}/setLive`);
await sleep(2500);
await j(`/documents/${D.M}/output-destinations/${rec.id}/setOff`);
try {
  await round("1. as built");
  await put(`/documents/${D.M}/sources/${SA}`, { "video-device-id": devB });
  await put(`/documents/${D.M}/sources/${SB}`, { "video-device-id": devA });
  await sleep(3000);
  await round("2. senders swapped (source objects and their filters stay in place)");
  await put(`/documents/${D.M}/sources/${SA}`, { "video-device-id": devA });
  await put(`/documents/${D.M}/sources/${SB}`, { "video-device-id": devB });
  await sleep(3000);
  await put(`/documents/${D.M}/layers/${sw.id}`, { "input-values": { tvIn_VideoSourceAImage: SB, tvIn_VideoSourceBImage: SA } });
  await sleep(800);
  await round("3. switcher slots swapped");
} finally {
  await put(`/documents/${D.M}/sources/${SA}`, { "video-device-id": devA });
  await put(`/documents/${D.M}/sources/${SB}`, { "video-device-id": devB });
  await put(`/documents/${D.M}/layers/${sw.id}`, { "input-values": { tvIn_VideoSourceAImage: iv0.tvIn_VideoSourceAImage, tvIn_VideoSourceBImage: iv0.tvIn_VideoSourceBImage } });
  await sleep(2500);
  await sig(`Cut_${iv0.tvGroup_Hidden_Inputs__currentLiveSource}`);
  await sleep(500);
  say(`-- restored: ${await snap()}`);
  for (const r of ["M", "A", "B"]) if (was[r] !== "live") await j(`/documents/${D[r]}/setOff`);
  writeFileSync(join(HERE, "tally-swap-check.txt"), out.join("\n") + "\n");
}
