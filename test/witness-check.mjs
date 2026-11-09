#!/usr/bin/env node
// witness-check: source tally is a witness, never a fact (ruling 2026-11-09).
//   node test/witness-check.mjs           (takectl must NOT already be running; MASTER on slot 1)
// A real disagreement, made in mimoLive: slot 1 (A's slot) is pointed at NDI PH-B for a while. The
// switcher then says slot 1 = A is on air, while source tally says B=program and A is not.
//   1. agreement: /state.warning is null; roles A.
//   2. disagreement: roles stay A, TALLY stays A lit / B dark, and /state.warning reads
//      'source tally disagrees with switcher (A=…, B=…, slot=1)' within a few seconds; the log
//      carries exactly one WARNING line for the episode, however many wake-ups and polls follow.
//   3. slot 1 back to NDI PH-A: the warning clears and the log says so.
// Restores slot 1's source and both TALLY layers. TAKECTL_DIR=<dir> runs another takectl.mjs (+ its config), output in <dir>/out.
import { spawn } from "node:child_process";
import { mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.TAKECTL_DIR || dirname(HERE);
const OUT = process.env.TAKECTL_DIR ? join(ROOT, "out") : HERE;
mkdirSync(OUT, { recursive: true });
const B = "http://localhost:8989/api/v1", T = "http://localhost:8991";
const j = (u, o) => fetch(u, o).then((r) => (r.status === 204 ? null : r.json()));
const put = (u, body) => j(u, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = [];
const say = (s) => { out.push(s); console.log(s); };
let fails = 0;
const check = (ok, what) => { if (!ok) fails++; say(`${ok ? "PASS" : "FAIL"}  ${what}`); };

const docs = (await j(`${B}/documents`)).data;
const id = (n) => docs.find((d) => d.attributes.name.replace(/\.tvshow$/, "") === n).id;
const D = { A: id("PH-A"), B: id("PH-B"), M: id("PH-MASTER") };
const layer = async (r, n) => (await j(`${B}/documents/${D[r]}/layers`)).data.find((l) => l.attributes.name === n);
const sw = await layer("M", "AB Switcher");
const iv0 = (await j(`${B}/documents/${D.M}/layers/${sw.id}`)).data.attributes["input-values"];
const srcs = (await j(`${B}/documents/${D.M}/sources`)).data;
const SA = srcs.find((s) => s.attributes.name === "NDI PH-A").id, SB = srcs.find((s) => s.attributes.name === "NDI PH-B").id;
const tallies = async () => ({ A: (await layer("A", "TALLY")).attributes["live-state"], B: (await layer("B", "TALLY")).attributes["live-state"] });
const srcTally = async () => ({ A: (await j(`${B}/documents/${D.M}/sources/${SA}`)).data.attributes["tally-state"], B: (await j(`${B}/documents/${D.M}/sources/${SB}`)).data.attributes["tally-state"] });
const tally0 = await tallies();
if (iv0.tvGroup_Hidden_Inputs__currentLiveSource !== 1 || iv0.tvIn_VideoSourceAImage !== SA) { console.error("needs MASTER on slot 1 with NDI PH-A in slot 1"); process.exit(2); }

const logPath = join(OUT, "takectl-witness.log");
const tk = spawn("node", ["takectl.mjs"], { cwd: ROOT, stdio: ["ignore", openSync(logPath, "w"), openSync(logPath, "a")] });
let st = null;
for (let i = 0; i < 40 && !st; i++) { await sleep(250); st = await j(`${T}/state`).catch(() => null); }
const warnLines = () => readFileSync(logPath, "utf8").split("\n").filter((l) => /WARNING source tally disagrees/.test(l));
const until = async (pred, ms) => { const t = Date.now(); let s; while (Date.now() - t < ms) { s = await j(`${T}/state`); if (pred(s)) return { s, ms: Date.now() - t }; await sleep(100); } return { s, ms: null }; };

try {
  await sleep(1500);
  let s = await j(`${T}/state`);
  check(s.pgm === "A" && s.warning == null, `1. agreement: pgm=${s.pgm}, warning=${JSON.stringify(s.warning)}, source tally ${JSON.stringify(await srcTally())}`);

  await put(`${B}/documents/${D.M}/layers/${sw.id}`, { "input-values": { tvIn_VideoSourceAImage: SB } });
  const t0 = Date.now();
  const w = await until((x) => x.warning, 8000);
  say(`   slot 1 now holds NDI PH-B; source tally ${JSON.stringify(await srcTally())}`);
  check(w.ms != null && /^source tally disagrees with switcher \(A=.+, B=.+, slot=1\)$/.test(w.s.warning ?? ""), `2. warning raised after ${w.ms} ms: ${JSON.stringify(w.s?.warning)}`);
  await sleep(Math.max(0, 6500 - (Date.now() - t0))); // past at least one poll (5 s) and more wake-ups
  s = await j(`${T}/state`);
  const tl = await tallies();
  check(s.pgm === "A" && tl.A === "live" && tl.B === "off", `2. roles not moved by the witness: pgm=${s.pgm}, TALLY A=${tl.A} B=${tl.B} (switcher says slot ${s.switcher?.slot})`);
  check(s.warning != null && warnLines().length === 1, `2. one WARNING line for the episode after ${Date.now() - t0} ms: ${warnLines().length} line(s)${warnLines()[0] ? "\n      " + warnLines()[0] : ""}`);

  await put(`${B}/documents/${D.M}/layers/${sw.id}`, { "input-values": { tvIn_VideoSourceAImage: SA } });
  const c = await until((x) => x.warning == null, 8000);
  const cleared = readFileSync(logPath, "utf8").split("\n").filter((l) => /agrees with switcher again/.test(l));
  check(c.ms != null && cleared.length === 1, `3. slot 1 back to NDI PH-A: warning cleared after ${c.ms} ms, log: ${cleared[0] ?? "(none)"}`);
} finally {
  await put(`${B}/documents/${D.M}/layers/${sw.id}`, { "input-values": { tvIn_VideoSourceAImage: iv0.tvIn_VideoSourceAImage } });
  tk.kill();
  await sleep(300);
  for (const r of ["A", "B"]) await j(`${B}/documents/${D[r]}/layers/${(await layer(r, "TALLY")).id}/${tally0[r] === "live" ? "setLive" : "setOff"}`);
  const iv = (await j(`${B}/documents/${D.M}/layers/${sw.id}`)).data.attributes["input-values"];
  say(`restored: slot 1 = ${iv.tvIn_VideoSourceAImage === SA ? "NDI PH-A" : "WRONG " + iv.tvIn_VideoSourceAImage}, live slot ${iv.tvGroup_Hidden_Inputs__currentLiveSource}, TALLY ${JSON.stringify(await tallies())}`);
  say(fails ? `${fails} FAIL(S)` : "ALL PASS");
  writeFileSync(join(OUT, "witness-check.txt"), out.join("\n") + "\n");
}
process.exit(fails ? 1 : 0);
