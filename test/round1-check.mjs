#!/usr/bin/env node
// round1-check: v0.2 round 1 on the real mimoLive (PH-A, PH-B, PH-MASTER open; takectl NOT running).
//   node test/round1-check.mjs
// R1. setup: a takectl with no config lists the real documents, suggests NDI PH-A / NDI PH-B /
//     AB Switcher (by the NDI sender each document advertises), and Save writes a config equal to
//     the hand-made one; takectl then runs and takes PGM from the switcher.
// R2. doctor: shows stopped → the show/NDI lights are red, each with its fix, /state's summary is
//     failing; shows running → every light green and `takectl doctor` exits 0.
// R3. Layer Sets: a set added to A only appears greyed ("only in A") in /state.layerSetsAll, the
//     /state.warning names it (a warning, not a doctor failure), and recalling it into PVW B is refused;
//     deleting it clears the warning.
// Restores the shows, TALLY and Layer Sets as found. TAKECTL_DIR runs another takectl.mjs.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.TAKECTL_DIR || dirname(HERE);
const OUT = process.env.TAKECTL_DIR ? join(ROOT, "out") : HERE;
mkdirSync(OUT, { recursive: true });
const H = "http://localhost:8989", B = `${H}/api/v1`, T = "http://localhost:8991";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const req = async (method, u, body) => { const r = await fetch(u, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined }).catch(() => null); if (!r) return { status: 0 }; const t = await r.text(); try { return { status: r.status, ...JSON.parse(t) }; } catch { return { status: r.status, raw: t }; } };
const j = (u) => req("GET", u);
const out = [];
const say = (s) => { out.push(s); console.log(s); };
let fails = 0;
const check = (ok, what) => { if (!ok) fails++; say(`${ok ? "PASS" : "FAIL"}  ${what}`); };
const until = async (fn, ms) => { const t = Date.now(); while (Date.now() - t < ms) { const v = await fn(); if (v) return v; await sleep(250); } return null; };

const docs = (await j(`${B}/documents`)).data;
const id = (n) => docs.find((d) => d.attributes.name.replace(/\.tvshow$/, "") === n).id;
const D = { A: id("PH-A"), B: id("PH-B"), M: id("PH-MASTER") };
const live = async (r) => (await j(`${B}/documents/${D[r]}`)).data.attributes["live-state"];
const was = { A: await live("A"), B: await live("B"), M: await live("M") };
const shows = async (on) => {
  for (const r of on ? ["A", "B", "M"] : ["M", "A", "B"]) await j(`${B}/documents/${D[r]}/${on ? "setLive" : "setOff"}`);
  await sleep(on ? 2500 : 1200);
  if (on) { const rec = (await j(`${B}/documents/${D.M}/output-destinations`)).data.find((o) => o.attributes.title === "Recording"); await j(`${B}/documents/${D.M}/output-destinations/${rec.id}/setOff`); }
};
const procs = [];
const startTk = (cfg) => { const p = spawn("node", [join(ROOT, "takectl.mjs")], { env: { ...process.env, ...(cfg ? { TAKECTL_CONFIG: cfg } : {}) }, stdio: "ignore" }); procs.push(p); return p; };
const stop = async (p) => { if (p && p.exitCode === null && p.signalCode === null) { const g = new Promise((r) => p.once("exit", r)); p.kill(); await g; } };
const dir = mkdtempSync(join(tmpdir(), "abswitch-r1real-"));
let tempSet = null;

try {
  // ---- R1 setup on the real documents
  const cfgFile = join(dir, "takectl.config.json");
  let tk = startTk(cfgFile);
  await until(async () => (await j(`${T}/state`)).status, 6000);
  const list = await j(`${T}/setup/documents?host=${encodeURIComponent(H)}`);
  const pick = (n) => list.documents?.find((d) => d.name.replace(/\.tvshow$/, "") === n);
  const [a, b, m] = [pick("PH-A"), pick("PH-B"), pick("PH-MASTER")];
  const q = new URLSearchParams({ host: H, id: m?.id ?? "", aHost: H, aId: a?.id ?? "", aName: a?.name ?? "", bHost: H, bId: b?.id ?? "", bName: b?.name ?? "" });
  const sug = await j(`${T}/setup/master?${q}`);
  check(a && b && m && sug.suggest?.sourceNameA === "NDI PH-A" && sug.suggest?.sourceNameB === "NDI PH-B" && sug.suggest?.switcherLayerName === "AB Switcher",
    `R1a. /setup lists ${JSON.stringify(list.documents?.map((d) => d.name))}; suggests ${JSON.stringify(sug.suggest)}`);
  const save = await req("POST", `${T}/setup/save`, { a: { host: H, documentName: a?.name }, b: { host: H, documentName: b?.name },
    master: { host: H, documentName: m?.name, sourceNameA: sug.suggest?.sourceNameA, sourceNameB: sug.suggest?.sourceNameB }, switcherLayerName: sug.suggest?.switcherLayerName });
  const running = await until(async () => { const s = await j(`${T}/state`); return s.ready !== false && s.pgm ? s : null; }, 10000);
  const made = existsSync(cfgFile) ? JSON.parse(readFileSync(cfgFile, "utf8")) : {};
  const hand = JSON.parse(readFileSync(join(dirname(HERE), "takectl.config.json"), "utf8"));
  const pickCfg = (c) => JSON.stringify([c.a?.documentName, c.b?.documentName, c.master?.documentName, c.master?.sourceNameA, c.master?.sourceNameB, c.switcherLayerName, c.a?.host, c.master?.host]);
  const sw = (await j(`${B}/documents/${D.M}/layers`)).data.find((l) => l.attributes.name === "AB Switcher");
  const slot = (await j(`${B}/documents/${D.M}/layers/${sw.id}`)).data.attributes["input-values"].tvGroup_Hidden_Inputs__currentLiveSource;
  check(save.ok && pickCfg(made) === pickCfg(hand) && running?.pgm === (slot === 1 ? "A" : "B") && running?.truth === "switcher live slot",
    `R1b. Save → config equals the hand-made one (${pickCfg(made)}); running, pgm=${running?.pgm} from switcher slot ${slot}, truth="${running?.truth}"`);
  await stop(tk);

  // ---- R2 doctor, red then green (the real config)
  await shows(false);
  tk = startTk();
  await until(async () => (await j(`${T}/state`)).status, 6000);
  let d = await j(`${T}/doctor.json`);
  const red = d.checks?.filter((c) => !c.ok) ?? [];
  const st = await until(async () => { const s = await j(`${T}/state`); return s.doctor ? s : null; }, 7000);
  const fixesOk = red.length > 0 && red.every((c) => typeof c.fix === "string" && c.fix.length > 10);
  check(red.some((c) => c.id === "live-A") && red.some((c) => c.id === "live-MASTER") && fixesOk && st?.doctor?.ok === false,
    `R2a. shows stopped: ${red.length} red — ${red.map((c) => `${c.label} → "${c.fix}"`).join(" | ")}; /state.doctor.ok=${st?.doctor?.ok}`);
  await shows(true);
  const green = await until(async () => { const x = await j(`${T}/doctor.json`); return x.ok ? x : null; }, 12000);
  const cli = spawnSync("node", [join(ROOT, "takectl.mjs"), "doctor"], { encoding: "utf8" });
  writeFileSync(join(OUT, "doctor-round1.txt"), cli.stdout + cli.stderr);
  check(green?.checks?.length >= 20 && cli.status === 0 && /All checks pass/.test(cli.stdout),
    `R2b. shows running: ${green?.checks?.length ?? 0} checks, all green; \`takectl doctor\` exit ${cli.status} (doctor-round1.txt)`);

  // ---- R3 a Layer Set in A only
  const created = await req("POST", `${B}/documents/${D.A}/layer-sets`, {});
  tempSet = created.data?.id;
  await req("PATCH", `${B}/documents/${D.A}/layer-sets/${tempSet}`, { data: { attributes: { name: "R1 Only In A" } } });
  const listed = await until(async () => { const s = await j(`${T}/state`); return s.layerSetsAll?.find((x) => x.name === "R1 Only In A") ? s : null; }, 8000);
  const entry = listed?.layerSetsAll?.find((x) => x.name === "R1 Only In A");
  d = await j(`${T}/doctor.json`);
  const ls = d.checks?.find((c) => c.id === "layersets");
  const pvw = listed?.pvw;
  const rec = await j(`${T}/pvw/layer-set/${encodeURIComponent("R1 Only In A")}`);
  // Ruling 2026-11-11: a one-document name is a warning, not a doctor failure.
  const w = (await j(`${T}/state`)).warning ?? "";
  check(entry?.inA === true && entry?.inB === false && !listed.layerSets.includes("R1 Only In A") && !ls && d.ok === true && /Layer Sets in only one document \(A: R1 Only In A; B: none\)/.test(w) && (pvw !== "B" || rec.ok === false),
    `R3a. A-only set: layerSetsAll ${JSON.stringify(entry)}; doctor ok=${d.ok} (no Layer Set check); warning ${JSON.stringify(w)}; recall into PVW ${pvw} → ${JSON.stringify(rec.error ?? rec)}`);
  const del = await req("DELETE", `${B}/documents/${D.A}/layer-sets/${tempSet}`);
  const gone = !(await j(`${B}/documents/${D.A}/layer-sets`)).data.some((x) => x.id === tempSet);
  if (gone) tempSet = null;
  const clean = await until(async () => { const x = await j(`${T}/doctor.json`); return x.ok ? x : null; }, 8000);
  check(gone && clean?.ok === true, `R3b. DELETE layer set → HTTP ${del.status}, gone=${gone}; doctor all green again: ${clean?.ok === true}`);
} finally {
  if (tempSet) say(`LEFT BEHIND: Layer Set ${tempSet} ("R1 Only In A") in PH-A could not be deleted; delete it by hand before saving`);
  for (const p of procs.reverse()) await stop(p);
  for (const r of ["A", "B"]) { const t = (await j(`${B}/documents/${D[r]}/layers`)).data.find((l) => l.attributes.name === "TALLY"); await j(`${B}/documents/${D[r]}/layers/${t.id}/setOff`); }
  await sleep(800);
  for (const r of ["M", "A", "B"]) if (was[r] !== "live") await j(`${B}/documents/${D[r]}/setOff`);
  say(`restored: shows ${JSON.stringify({ A: await live("A"), B: await live("B"), M: await live("M") })}, TALLY off`);
  say(fails ? `${fails} FAIL(S)` : "ALL PASS");
  writeFileSync(join(OUT, "round1-check.txt"), out.join("\n") + "\n");
}
process.exit(fails ? 1 : 0);
