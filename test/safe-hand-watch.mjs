#!/usr/bin/env node
// safe-hand-watch: for the by-hand part of the safe-source tests. With takectl running (safe source set
// up), log every change of what takectl says is on air while the operator selects switcher slots in
// mimoLive's own UI (PH-MASTER → AB Switcher: slot 3, then the empty slot 4, then slot 1).
//   node test/safe-hand-watch.mjs [seconds=240] [out file name]    → test/safe-hand-watch.txt
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const secs = Number(process.argv[2]) || 240;
const OUTFILE = process.argv[3] || "safe-hand-watch.txt"; // e.g. second-device-watch.txt
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = [];
const say = (s) => { out.push(s); console.log(s); writeFileSync(join(HERE, OUTFILE), out.join("\n") + "\n"); };
const t0 = Date.now();
let last = "";
say(`watching takectl /state for ${secs} s (started ${new Date().toISOString()})`);
while (Date.now() - t0 < secs * 1000) {
  try {
    const s = await (await fetch("http://localhost:8991/state", { signal: AbortSignal.timeout(1500) })).json();
    // TALLY as mimoLive reports it, not as takectl intends it
    const tally = async (d) => (await (await fetch(`${d.host}/api/v1/documents/${d.id}/layers`, { signal: AbortSignal.timeout(1500) })).json()).data.find((l) => l.attributes.name === "TALLY")?.attributes["live-state"];
    const line = `pgm ${s.pgm} · pvw ${s.pvw} · switcher slot ${s.switcher?.slot} · TALLY A/B ${await tally(s.docs.A)}/${await tally(s.docs.B)} · safe.onAir ${s.safe?.onAir} · warning ${JSON.stringify(s.warning)}`;
    if (line !== last) { say(`${String(((Date.now() - t0) / 1000).toFixed(1)).padStart(6)} s  ${line}`); last = line; }
  } catch (e) {
    if (last !== "unreachable") { say(`${((Date.now() - t0) / 1000).toFixed(1)} s  takectl unreachable (${e.message})`); last = "unreachable"; }
  }
  await sleep(100);
}
say("done");
