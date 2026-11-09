#!/usr/bin/env node
// error-mirror-check: rulings 6 and 13 (2026-11-09), on the real mimoLive.
//   node test/error-mirror-check.mjs      (takectl must NOT already be running; documents open)
// Ruling 6 — lastError is cleared by the next successful TAKE, CUT or PANIC, never by time:
//   a. with the shows stopped, /take is refused: lastError is set, with lastErrorAt and an age
//      that grows, and it is still there 3 s later;
//   b. shows started: right after /take answers ok (before its verify), lastError is null;
//   c. B's NDI output off: /take refused (error set); output back on: /cut ok clears it;
//   d. same refusal again, then /panic ok clears it.
// Ruling 13 — /mirror is refused with "busy" mid-transition:
//   e. during takectl's own TAKE;
//   f. during a 4 s dissolve fired at MASTER directly (in flight, takectl not busy);
//   g. after it lands, /mirror works.
// Starts the shows and switches MASTER's Recording off; restores shows, NDI output, transition
// duration, live slot and TALLY as found. TAKECTL_DIR runs another takectl.mjs (+ its config).
import { spawn } from "node:child_process";
import { mkdirSync, openSync, writeFileSync } from "node:fs";
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
const short = (x) => (x == null ? "null" : JSON.stringify(String(x).slice(0, 70)));

const docs = (await j(`${B}/documents`)).data;
const id = (n) => docs.find((d) => d.attributes.name.replace(/\.tvshow$/, "") === n).id;
const D = { A: id("PH-A"), B: id("PH-B"), M: id("PH-MASTER") };
const live = async (r) => (await j(`${B}/documents/${D[r]}`)).data.attributes["live-state"];
const sw = (await j(`${B}/documents/${D.M}/layers`)).data.find((l) => l.attributes.name === "AB Switcher");
const iv = async () => (await j(`${B}/documents/${D.M}/layers/${sw.id}`)).data.attributes["input-values"];
const ndiB = (await j(`${B}/documents/${D.B}/output-destinations`)).data.find((o) => o.attributes["output-destination-type"] === "com.boinx.mimoLive.outputDestination.ndi");
const rec = (await j(`${B}/documents/${D.M}/output-destinations`)).data.find((o) => o.attributes.title === "Recording");
const tallyId = async (r) => (await j(`${B}/documents/${D[r]}/layers`)).data.find((l) => l.attributes.name === "TALLY").id;
const was = { shows: { A: await live("A"), B: await live("B"), M: await live("M") }, dur: (await iv()).tvIn_TransitionDuration, slot: (await iv()).tvGroup_Hidden_Inputs__currentLiveSource };
const tk = spawn("node", ["takectl.mjs"], { cwd: ROOT, stdio: ["ignore", openSync(join(OUT, "takectl-error-mirror.log"), "w"), "ignore"] });
let st = null;
for (let i = 0; i < 40 && !st; i++) { await sleep(250); st = await j(`${T}/state`).catch(() => null); }
const state = () => j(`${T}/state`);
const showsLive = async (on) => {
  for (const r of on ? ["A", "B", "M"] : ["M", "A", "B"]) await j(`${B}/documents/${D[r]}/${on ? "setLive" : "setOff"}`);
  await sleep(on ? 2500 : 800);
  if (on) await j(`${B}/documents/${D.M}/output-destinations/${rec.id}/setOff`);
};
try {
  say(`start: shows ${JSON.stringify(was.shows)}, pgm ${st.pgm}`);
  // a
  await showsLive(false);
  let r = await j(`${T}/take`);
  const s1 = await state(); await sleep(1200); const s2 = await state(); await sleep(1800); const s3 = await state();
  check(r.ok === false && s1.lastError && s1.lastErrorAt && s2.lastErrorAgeMs - s1.lastErrorAgeMs >= 1000 && s3.lastError === s1.lastError,
    `6a. refused: ${short(r.error)}; lastError set at ${s1.lastErrorAt}, age ${s1.lastErrorAgeMs} → ${s2.lastErrorAgeMs} ms, still set 3 s later (${s3.lastErrorAgeMs} ms)`);
  // b
  await showsLive(true);
  r = await j(`${T}/take`);
  const s4 = await state();
  check(r.ok === true && s4.lastError == null, `6b. /take ok → lastError ${short(s4.lastError)} right after the answer (before verify)`);
  await sleep(1500);
  // c
  await j(`${B}/documents/${D.B}/output-destinations/${ndiB.id}/setOff`); await sleep(800);
  st = await state();
  r = await j(`${T}/${st.pgm === "A" ? "take" : "panic"}`); // B must be the target: if B is PGM, panic first
  if (st.pgm !== "A") { await sleep(1500); r = await j(`${T}/take`); }
  const s5 = await state();
  await j(`${B}/documents/${D.B}/output-destinations/${ndiB.id}/setLive`); await sleep(2500);
  const c = await j(`${T}/cut`); const s6 = await state();
  check(r.ok === false && /NDI output/.test(s5.lastError ?? "") && c.ok === true && s6.lastError == null,
    `6c. B's NDI output off → /take refused, lastError ${short(s5.lastError)}; output on → /cut ok → lastError ${short(s6.lastError)}`);
  await sleep(1200);
  // d
  st = await state();
  if (st.pgm !== "A") { await j(`${T}/panic`); await sleep(1500); }
  await j(`${B}/documents/${D.B}/output-destinations/${ndiB.id}/setOff`); await sleep(800);
  r = await j(`${T}/take`);
  const s7 = await state();
  await j(`${B}/documents/${D.B}/output-destinations/${ndiB.id}/setLive`); await sleep(2500);
  const p = await j(`${T}/panic`); const s8 = await state();
  check(r.ok === false && s7.lastError && p.ok === true && s8.lastError == null, `6d. refused again (${short(s7.lastError)}), then /panic ok → lastError ${short(s8.lastError)}`);
  // e
  await sleep(1000);
  const tk1 = await j(`${T}/take`); const m1 = await j(`${T}/mirror`);
  check(tk1.ok && m1.ok === false && /^busy/.test(m1.error ?? ""), `13e. /mirror during takectl's TAKE: ${short(m1.error ?? JSON.stringify(m1))}`);
  await sleep(1500);
  // f
  await put(`${B}/documents/${D.M}/layers/${sw.id}`, { "input-values": { tvIn_TransitionDuration: 4.0 } });
  st = await state();
  const target = st.pgm === "A" ? 2 : 1;
  await j(`${B}/documents/${D.M}/layers/${sw.id}/signals/tvGroup_Control__Dis_${target}_TypeSignal`);
  await sleep(800);
  const s9 = await state(); const m2 = await j(`${T}/mirror`);
  check(s9.busy === false && m2.ok === false && /^busy/.test(m2.error ?? ""), `13f. /mirror 0.8 s into a 4 s outside dissolve (takectl busy=${s9.busy}): ${short(m2.error ?? JSON.stringify(m2))}`);
  // g
  await sleep(4000);
  const m3 = await j(`${T}/mirror`);
  check(m3.ok === true, `13g. after it lands: /mirror → ${JSON.stringify(m3)}`);
} finally {
  await put(`${B}/documents/${D.M}/layers/${sw.id}`, { "input-values": { tvIn_TransitionDuration: was.dur } });
  await j(`${B}/documents/${D.B}/output-destinations/${ndiB.id}/setLive`).catch(() => null);
  await j(`${T}/panic`).catch(() => null); await sleep(1500);
  tk.kill();
  if ((await iv()).tvGroup_Hidden_Inputs__currentLiveSource !== was.slot) await j(`${B}/documents/${D.M}/layers/${sw.id}/signals/tvGroup_Control__Cut_${was.slot}_TypeSignal`);
  for (const r of ["A", "B"]) await j(`${B}/documents/${D[r]}/layers/${await tallyId(r)}/setOff`);
  for (const r of ["M", "A", "B"]) if (was.shows[r] !== "live") await j(`${B}/documents/${D[r]}/setOff`);
  await sleep(1000);
  const v = await iv();
  say(`restored: shows ${JSON.stringify({ A: await live("A"), B: await live("B"), M: await live("M") })}, slot ${v.tvGroup_Hidden_Inputs__currentLiveSource}, transition ${v.tvIn_TransitionDuration} s, TALLY off`);
  say(fails ? `${fails} FAIL(S)` : "ALL PASS");
  writeFileSync(join(OUT, "error-mirror-check.txt"), out.join("\n") + "\n");
}
process.exit(fails ? 1 : 0);
