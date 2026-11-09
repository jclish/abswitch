#!/usr/bin/env node
// stall-check: a transition in flight (both slots at 30) for longer than the stall threshold shows as
// /state.warning "transition stalled (… ms)", decides nothing, and clears on the next settled read
// (UI brief 2026-11-09). 7.0b3 caps a real dissolve at 5 s (a 6 s setting ran ~5.0 s), so the bench
// runs takectl with the test hook TAKECTL_STALL_MS=2000 and a 4 s dissolve fired at MASTER directly.
//   node test/stall-check.mjs             (takectl must NOT already be running; MASTER on slot 1)
// Restores the transition duration, live slot and TALLY. TAKECTL_DIR as in panic-check.
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
const iv = async () => (await j(`${B}/documents/${D.M}/layers/${sw.id}`)).data.attributes["input-values"];
const iv0 = await iv();
if (iv0.tvGroup_Hidden_Inputs__currentLiveSource !== 1) { console.error("needs MASTER on slot 1"); process.exit(2); }
const tally0 = { A: (await layer("A", "TALLY")).attributes["live-state"], B: (await layer("B", "TALLY")).attributes["live-state"] };

const logPath = join(OUT, "takectl-stall.log");
const tk = spawn("node", ["takectl.mjs"], { cwd: ROOT, env: { ...process.env, TAKECTL_STALL_MS: "2000" }, stdio: ["ignore", openSync(logPath, "w"), openSync(logPath, "a")] });
let st = null;
for (let i = 0; i < 40 && !st; i++) { await sleep(250); st = await j(`${T}/state`).catch(() => null); }
try {
  await put(`${B}/documents/${D.M}/layers/${sw.id}`, { "input-values": { tvIn_TransitionDuration: 4.0 } });
  say(`transition duration ${(await iv()).tvIn_TransitionDuration} s; takectl stall threshold 2000 ms (TAKECTL_STALL_MS); start pgm=${st.pgm}`);
  await sleep(500);
  const t0 = Date.now();
  await j(`${B}/documents/${D.M}/layers/${sw.id}/signals/tvGroup_Control__Dis_2_TypeSignal`);
  const rows = []; let last = "";
  while (Date.now() - t0 < 6000) {
    const s = await j(`${T}/state`);
    const row = `pgm=${s.pgm} inFlight=${s.switcher?.inFlight} warning=${(s.warning ?? "null").replace(/\(\d+ ms\)/, "(… ms)")}`;
    if (row !== last) { rows.push({ t: Date.now() - t0, row, s }); say(`  +${String(Date.now() - t0).padStart(5)} ms  ${row}`); last = row; }
    await sleep(100);
  }
  const stalledRows = rows.filter((x) => /transition stalled/.test(x.s.warning ?? ""));
  const firstStall = stalledRows[0];
  const settled = rows.find((x) => x.s.pgm === "B" && !x.s.switcher?.inFlight);
  check(firstStall && firstStall.t >= 2000 && firstStall.t < 3500 && /^transition stalled \(\d+ ms\)$/.test(firstStall.s.warning),
    `warning raised at +${firstStall?.t} ms: ${JSON.stringify(firstStall?.s.warning)} (want ≥ 2000 ms, format "transition stalled (N ms)")`);
  check(stalledRows.length > 0 && stalledRows.every((x) => x.s.pgm === "A"), `no decision while stalled: pgm stayed A in every stalled read`);
  const final = await j(`${T}/state`), log = readFileSync(logPath, "utf8");
  check(settled && final.warning == null && final.pgm === "B" && /WARNING transition stalled/.test(log) && /no longer stalled/.test(log),
    `settled at +${settled?.t} ms: pgm=${final.pgm}, warning=${JSON.stringify(final.warning)}; log: ${(log.match(/.*(transition stalled|no longer stalled).*/g) || []).map((l) => l.trim()).join(" | ")}`);
} finally {
  await put(`${B}/documents/${D.M}/layers/${sw.id}`, { "input-values": { tvIn_TransitionDuration: iv0.tvIn_TransitionDuration } });
  await j(`${B}/documents/${D.M}/layers/${sw.id}/signals/tvGroup_Control__Cut_1_TypeSignal`);
  await sleep(800);
  tk.kill();
  for (const r of ["A", "B"]) await j(`${B}/documents/${D[r]}/layers/${(await layer(r, "TALLY")).id}/${tally0[r] === "live" ? "setLive" : "setOff"}`);
  const v = await iv();
  say(`restored: transition ${v.tvIn_TransitionDuration} s, live slot ${v.tvGroup_Hidden_Inputs__currentLiveSource}, TALLY ${JSON.stringify(tally0)}`);
  say(fails ? `${fails} FAIL(S)` : "ALL PASS");
  writeFileSync(join(OUT, "stall-check.txt"), out.join("\n") + "\n");
}
process.exit(fails ? 1 : 0);
