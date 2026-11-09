#!/usr/bin/env node
// tally-selection-watch: does SELECTING a source in mimoLive's UI make the API report it as "program"?
//   node test/tally-selection-watch.mjs     (with B on air in PH-MASTER)
// Polls NDI PH-A / NDI PH-B tally-state and the switcher's live slot every 150 ms and logs each change.
// The operator clicks NDI PH-A in MASTER's Sources panel, waits, then clicks the AB Switcher layer.
// Exits once it has seen A go to "program" and back to "in-use" while slot 2 stays live, or after
// 10 minutes. Writes test/tally-selection-watch.txt as it goes.
import { appendFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "tally-selection-watch.txt");
const B = "http://localhost:8989/api/v1";
const j = (u) => fetch(B + u).then((r) => r.json());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const say = (s) => { const l = `${((Date.now() - t0) / 1000).toFixed(2).padStart(7)}s  ${s}`; console.log(l); appendFileSync(OUT, l + "\n"); };
writeFileSync(OUT, "");

const docs = (await j("/documents")).data;
const M = docs.find((d) => d.attributes.name.startsWith("PH-MASTER")).id;
const sw = (await j(`/documents/${M}/layers`)).data.find((l) => l.attributes.name === "AB Switcher");
let last = "", stuck = false;
while (Date.now() - t0 < 10 * 60e3) {
  const slot = (await j(`/documents/${M}/layers/${sw.id}`)).data.attributes["input-values"].tvGroup_Hidden_Inputs__currentLiveSource;
  const ss = Object.fromEntries((await j(`/documents/${M}/sources`)).data.filter((s) => s.attributes.name.startsWith("NDI")).map((s) => [s.attributes.name, s.attributes["tally-state"]]));
  const now = `live slot ${slot} | NDI PH-A=${ss["NDI PH-A"]} | NDI PH-B=${ss["NDI PH-B"]}`;
  if (now !== last) { say(now); last = now; }
  if (slot === 2 && ss["NDI PH-A"] === "program") stuck = true;
  if (stuck && slot === 2 && ss["NDI PH-A"] === "in-use") { say("RESULT: A read program while off air, then cleared"); process.exit(0); }
  await sleep(150);
}
say(stuck ? "RESULT: A went to program while off air and did not clear" : "RESULT: A never read program while off air");
