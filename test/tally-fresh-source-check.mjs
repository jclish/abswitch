#!/usr/bin/env node
// tally-fresh-source-check: does a FRESH Camera source on the PHA sender (no filter) report tally
// correctly in slot 1, where the existing "NDI PH-A" source sticks at "program"?
//   node test/tally-fresh-source-check.mjs
// Creates a temporary source, swaps it into slot 1, cuts slot 2 / slot 1, reads tally, then puts
// the original back in slot 1 and DELETES the temporary source. Writes test/tally-fresh-source-check.txt.
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const B = "http://localhost:8989/api/v1";
const req = async (method, u, body) => {
  const r = await fetch(B + u, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text();
  return { status: r.status, json: t ? JSON.parse(t) : null };
};
const j = async (u) => (await req("GET", u)).json;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = [];
const say = (s) => { out.push(s); console.log(s); };

const docs = (await j("/documents")).data;
const id = (n) => docs.find((d) => d.attributes.name.replace(/\.tvshow$/, "") === n).id;
const D = { A: id("PH-A"), B: id("PH-B"), M: id("PH-MASTER") };
const all = (await j(`/documents/${D.M}/sources`)).data;
const old = all.find((s) => s.attributes.name === "NDI PH-A"), srcB = all.find((s) => s.attributes.name === "NDI PH-B");
const dev = old.attributes["video-device-id"];
const sw = (await j(`/documents/${D.M}/layers`)).data.find((l) => l.attributes.name === "AB Switcher");
const iv0 = (await j(`/documents/${D.M}/layers/${sw.id}`)).data.attributes["input-values"];
const rec = (await j(`/documents/${D.M}/output-destinations`)).data.find((o) => o.attributes.title === "Recording");
const sig = (s) => j(`/documents/${D.M}/layers/${sw.id}/signals/tvGroup_Control__${s}_TypeSignal`);
const live = async (r) => (await j(`/documents/${D[r]}`)).data.attributes["live-state"];
const was = { A: await live("A"), B: await live("B"), M: await live("M") };
const tally = async (sid) => (await j(`/documents/${D.M}/sources/${sid}`)).data.attributes;

for (const r of ["A", "B", "M"]) if (was[r] !== "live") await j(`/documents/${D[r]}/setLive`);
await sleep(2500);
await j(`/documents/${D.M}/output-destinations/${rec.id}/setOff`);

const c = await req("POST", `/documents/${D.M}/sources`, { "source-type": "com.boinx.mimoLive.sources.deviceVideoSource", name: "TALLYTEST PH-A" });
const tid = c.json?.data?.id;
say(`created temporary source: HTTP ${c.status} ${tid}`);
try {
  await req("PUT", `/documents/${D.M}/sources/${tid}`, { "video-device-id": dev });
  for (let i = 0; i < 20 && !(await tally(tid))["video-device-connected"]; i++) await sleep(300);
  await req("PUT", `/documents/${D.M}/layers/${sw.id}`, { "input-values": { tvIn_VideoSourceAImage: tid } });
  await sleep(800);
  const filters = (await j(`/documents/${D.M}/sources/${tid}/filters`)).data.length;
  const row = async (l) => { const t = await tally(tid), o = await tally(old.id), b = await tally(srcB.id); say(`${l}  fresh(slot 1, ${t["video-device-id"].replace(/^.*\(/, "(")}, filters ${filters}, connected ${t["video-device-connected"]}) = ${t["tally-state"]}  |  NDI PH-B(slot 2) = ${b["tally-state"]}  |  old NDI PH-A (not in switcher) = ${o["tally-state"]}`); };
  await sig("Cut_1"); await sleep(1500); await row("live slot 1:");
  await sig("Cut_2"); await sleep(1500); await row("live slot 2:");
  await sig("Cut_1"); await sleep(1500); await row("live slot 1:");
} finally {
  await req("PUT", `/documents/${D.M}/layers/${sw.id}`, { "input-values": { tvIn_VideoSourceAImage: iv0.tvIn_VideoSourceAImage } });
  await sleep(500);
  const del = tid ? await req("DELETE", `/documents/${D.M}/sources/${tid}`) : { status: "-" };
  await sig(`Cut_${iv0.tvGroup_Hidden_Inputs__currentLiveSource}`);
  await sleep(500);
  const iv = (await j(`/documents/${D.M}/layers/${sw.id}`)).data.attributes["input-values"];
  const left = (await j(`/documents/${D.M}/sources`)).data.filter((s) => s.attributes.name === "TALLYTEST PH-A").length;
  say(`restored: slot 1 = ${iv.tvIn_VideoSourceAImage === old.id ? "NDI PH-A" : "WRONG " + iv.tvIn_VideoSourceAImage}, temporary source DELETE ${del.status}, ${left} left`);
  for (const r of ["M", "A", "B"]) if (was[r] !== "live") await j(`/documents/${D[r]}/setOff`);
  writeFileSync(join(HERE, "tally-fresh-source-check.txt"), out.join("\n") + "\n");
}
